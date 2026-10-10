import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Pool } from "pg";
import envelopeSchema from "../../../packages/contracts/events.schema.json";
import {
  AccessError,
  requirePermission,
  withTenantTransaction,
  type VerifiedIdentityContext,
} from "../../../packages/db/tenant-transaction";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(envelopeSchema);
const CONSUMER = "synthetic-reference-ledger-v1";
const supportedEventTypes = Object.freeze(["lead.captured", "lead.assigned", "lead.stage_changed"]);

export type OutboxRun = { dispatched: number; deferred: number };

/** Durable event-ledger dispatch, not email/SMS or any downstream domain effect. */
export async function dispatchOutbox(
  pool: Pool,
  identity: VerifiedIdentityContext,
  limit = 25,
): Promise<OutboxRun> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid dispatch batch size.");
  return withTenantTransaction(
    pool,
    identity,
    async (client, context) => {
      const selected = await client.query(
        `SELECT id,payload,event_type,aggregate_id FROM app.outbox
      WHERE tenant_id=$1 AND initiating_actor_id=$2 AND published_at IS NULL
      AND event_type=ANY($3::text[]) AND (lease_until IS NULL OR lease_until<now())
      ORDER BY created_at,id LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [identity.organizationId, identity.userId, supportedEventTypes, limit],
      );
      let dispatched = 0;
      let deferred = 0;
      for (const row of selected.rows) {
        const event = row.payload;
        const valid =
          validate(event) &&
          event.tenantId === identity.organizationId &&
          event.eventId === row.id &&
          event.aggregateId === row.aggregate_id &&
          event.type === row.event_type;
        let permitted = false;
        if (valid && event.aggregateType === "lead") {
          try {
            const scope = requirePermission(context, "crm.leads.read");
            const entitlement = await client.query(
              "SELECT 1 FROM app.entitlement WHERE tenant_id=$1 AND feature='crm' AND state='enabled' AND (effective_until IS NULL OR effective_until>now())",
              [identity.organizationId],
            );
            const source = await client.query(
              "SELECT id,owner_member_id,archived_at FROM app.lead WHERE tenant_id=$1 AND id=$2",
              [identity.organizationId, event.aggregateId],
            );
            permitted =
              entitlement.rowCount === 1 &&
              source.rowCount === 1 &&
              !source.rows[0].archived_at &&
              (scope === "organization" ||
                (scope === "own" && source.rows[0].owner_member_id === context.memberId));
            // Team dispatch remains deferred until an approved read port exists.
          } catch (error) {
            if (!(error instanceof AccessError)) throw error;
          }
        }
        if (!permitted) {
          await client.query(
            "UPDATE app.outbox SET lease_until=now()+interval '1 minute',attempt_count=attempt_count+1,updated_at=now() WHERE tenant_id=$1 AND id=$2",
            [identity.organizationId, row.id],
          );
          deferred++;
          continue;
        }
        // Immutable receipt is the consumer dedupe ledger, committed with acknowledgment.
        await client.query(
          `INSERT INTO app.outbox_consumer_receipt(tenant_id,event_id,consumer_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [identity.organizationId, row.id, CONSUMER],
        );
        await client.query(
          `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff) VALUES($1,$2,'outbox.dispatched','outbox',$3,$4,$5)`,
          [
            identity.organizationId,
            identity.userId,
            row.id,
            event.correlationId,
            JSON.stringify({ consumer: CONSUMER, externalDelivery: false }),
          ],
        );
        await client.query(
          "UPDATE app.outbox SET published_at=now(),lease_until=NULL,attempt_count=attempt_count+1,updated_at=now(),row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
          [identity.organizationId, row.id],
        );
        dispatched++;
      }
      return { dispatched, deferred };
    },
    { lockMembership: false },
  );
}
