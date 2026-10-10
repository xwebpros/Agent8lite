import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import eventSchema from "../../../../packages/contracts/internal/native-message-design-event-v1.schema.json";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import type { MessageDesign } from "./message-design-model";
import { WorkflowAuthority } from "./workflow-authority";
import { workflowJson } from "./workflow-json";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);

/** Closed reference event in the same caller transaction; no delivery or workflow execution. */
export async function appendMessageDesignDraftEvent(
  client: PoolClient,
  context: TenantContext,
  traceId: string,
  design: MessageDesign,
  operation: "create" | "update",
) {
  const authority = new WorkflowAuthority(client, context);
  await authority.require("campaigns.write");
  const current = await client.query<{ occurred_at: Date }>(
    `SELECT clock_timestamp() AS occurred_at FROM app.message_design d
    JOIN app.message_design_revision r ON (r.tenant_id,r.message_design_id,r.version)=(d.tenant_id,d.id,d.version)
    WHERE current_user='estate_runtime' AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
    AND d.tenant_id=$1 AND d.id=$3 AND d.version=$4 AND d.availability_state='draft'
    AND d.history_ready AND d.editor_kind='native' AND r.content_hash=d.content_hash
    AND r.source_row_version=d.row_version`,
    [context.organizationId, context.userId, design.id, design.version],
  );
  if (!current.rowCount)
    throw new AccessError(
      403,
      "design_context_unavailable",
      "Verified current message-design context is required.",
    );
  const eventId = randomUUID(),
    timestamp = current.rows[0].occurred_at.toISOString();
  const event = {
    eventId,
    type: "message_design.draft_changed",
    version: 1,
    tenantId: context.organizationId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "marketing",
    aggregateType: "message_design",
    aggregateId: design.id,
    correlationId: traceId,
    payload: { messageDesignId: design.id, designVersion: design.version, operation },
  };
  if (!validEvent(event) || event.aggregateId !== event.payload.messageDesignId)
    throw new AccessError(500, "event_contract_failure", "Message-design reference validation failed.");
  await authority.require("campaigns.write");
  await client.query(
    `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [context.organizationId, eventId, event.type, design.id, workflowJson(event), context.userId],
  );
  await authority.require("campaigns.write");
}
