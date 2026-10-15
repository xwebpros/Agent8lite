import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantContext } from "../../../packages/db/tenant-transaction";

interface RetentionResult {
  expiredIdempotencyRecords: number;
  expiredOutboxReceipts: number;
  archivedContactsPurged: number;
  archivedLeadsPurged: number;
}

export class RetentionService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string = "",
  ) {}

  private async audit(action: string, count: number) {
    if (count === 0) return;
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.context.organizationId,
        this.context.userId,
        action,
        "retention_policy",
        randomUUID(),
        this.traceId,
        JSON.stringify({ purgedCount: count }),
      ],
    );
  }

  async enforceRetention(): Promise<RetentionResult> {
    const expiredIdempotency = await this.client.query(
      `DELETE FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND expires_at<clock_timestamp()
       RETURNING id`,
    );

    const expiredOutbox = await this.client.query(
      `DELETE FROM app.outbox_consumer_receipt
       WHERE tenant_id=app.current_tenant()
         AND event_id IN (
           SELECT id FROM app.outbox
           WHERE tenant_id=app.current_tenant()
             AND created_at < clock_timestamp() - interval '90 days'
         )
       RETURNING event_id`,
    );

    const archivedContacts = await this.client.query(
      `SELECT count(*)::int AS cnt FROM app.contact
       WHERE tenant_id=app.current_tenant()
         AND archived_at IS NOT NULL
         AND archived_at < clock_timestamp() - interval '365 days'`,
    );

    const archivedLeads = await this.client.query(
      `SELECT count(*)::int AS cnt FROM app.lead
       WHERE tenant_id=app.current_tenant()
         AND archived_at IS NOT NULL
         AND archived_at < clock_timestamp() - interval '365 days'`,
    );

    const result: RetentionResult = {
      expiredIdempotencyRecords: expiredIdempotency.rowCount ?? 0,
      expiredOutboxReceipts: expiredOutbox.rowCount ?? 0,
      archivedContactsPurged: archivedContacts.rows[0]?.cnt ?? 0,
      archivedLeadsPurged: archivedLeads.rows[0]?.cnt ?? 0,
    };

    await this.audit("retention.idempotency_expired", result.expiredIdempotencyRecords);
    await this.audit("retention.outbox_expired", result.expiredOutboxReceipts);

    return result;
  }
}
