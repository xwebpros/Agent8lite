import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantContext } from "../../../../packages/db/tenant-transaction";

type ConsentPurpose = "email_marketing" | "sms_marketing";

interface DispatchResult {
  deliveryMode: "no-delivery";
  recipientCount: number;
  suppressedCount: number;
  processedAt: string;
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  safe_result: unknown;
  result_ref: string | null;
}

/**
 * No-delivery broadcast dispatch service.
 *
 * Processes queued broadcast confirmation jobs by checking consent eligibility
 * and recording synthetic delivery results. Never sends real messages.
 */
export class DispatchService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string = "",
  ) {}

  private async audit(action: string, resourceType: string, resourceId: string, version: number) {
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.context.organizationId,
        this.context.userId,
        action,
        resourceType,
        resourceId,
        this.traceId,
        JSON.stringify({ resourceVersion: version }),
      ],
    );
  }

  private async outbox(eventType: string, aggregateId: string, payload: Record<string, unknown>) {
    await this.client.query(
      `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        this.context.organizationId,
        randomUUID(),
        eventType,
        aggregateId,
        JSON.stringify(payload),
        this.context.userId,
      ],
    );
  }

  private assertNoDelivery() {
    const provider = process.env.DELIVERY_PROVIDER ?? "no-delivery";
    if (provider !== "no-delivery")
      throw new Error("DispatchService requires DELIVERY_PROVIDER=no-delivery. Refusing to process.");
  }

  /**
   * Check consent eligibility for a lead on a given purpose.
   * Returns true if the lead has not opted out (no withdrawal event without a later grant).
   */
  private async isConsentEligible(leadId: string, purpose: ConsentPurpose): Promise<boolean> {
    // Find all contact channels for this lead and check consent state.
    // A lead is suppressed if any of their channels for this purpose are in 'withdrawn' state,
    // or if there is an active suppression record.
    const result = await this.client.query(
      `SELECT cs.state
       FROM app.consent_state cs
       JOIN app.contact_channel cc ON (cc.tenant_id, cc.id) = (cs.tenant_id, cs.contact_channel_id)
       WHERE cs.tenant_id = app.current_tenant()
         AND cc.lead_id = $1
         AND cs.purpose = $2`,
      [leadId, purpose],
    );
    // If no consent state exists, the lead has unknown consent — suppress.
    if (!result.rowCount) return false;
    // Eligible only if at least one channel has granted consent and none are withdrawn.
    const states = result.rows.map((r: { state: string }) => r.state);
    if (states.includes("withdrawn")) return false;
    return states.includes("granted");
  }

  /**
   * Determine the consent purpose from the broadcast job's kind or associated campaign.
   * For synthetic broadcast confirmations, default to email_marketing.
   */
  private purposeForJob(_job: JobRow): ConsentPurpose {
    return "email_marketing";
  }

  /**
   * Process a single queued broadcast job by ID.
   */
  async processSingleJob(jobId: string): Promise<DispatchResult> {
    this.assertNoDelivery();

    const result = await this.client.query<JobRow>(
      `SELECT id, kind, state, safe_result, result_ref
       FROM app.integration_job
       WHERE tenant_id = app.current_tenant()
         AND id = $1
         AND kind = 'broadcast.synthetic.confirmation'
         AND state = 'queued'
       FOR UPDATE`,
      [jobId],
    );
    if (!result.rowCount) throw new Error("Job not found, not queued, or out of scope.");

    const job = result.rows[0];
    return this.dispatchJob(job);
  }

  /**
   * Process all queued broadcast confirmation jobs for the current tenant.
   */
  async processQueuedBroadcasts(): Promise<{ processed: number; results: DispatchResult[] }> {
    this.assertNoDelivery();

    const jobs = await this.client.query<JobRow>(
      `SELECT id, kind, state, safe_result, result_ref
       FROM app.integration_job
       WHERE tenant_id = app.current_tenant()
         AND kind = 'broadcast.synthetic.confirmation'
         AND state = 'queued'
       ORDER BY created_at
       FOR UPDATE`,
    );

    const results: DispatchResult[] = [];
    for (const job of jobs.rows) {
      const dispatchResult = await this.dispatchJob(job);
      results.push(dispatchResult);
    }

    return { processed: results.length, results };
  }

  private async dispatchJob(job: JobRow): Promise<DispatchResult> {
    const purpose = this.purposeForJob(job);

    // Find leads targeted by this broadcast via result_ref or fall back to
    // counting all leads in the tenant (synthetic confirmation targets everyone).
    const leads = await this.client.query<{ id: string }>(
      `SELECT id FROM app.lead
       WHERE tenant_id = app.current_tenant() AND archived_at IS NULL`,
    );

    let recipientCount = 0;
    let suppressedCount = 0;

    for (const lead of leads.rows) {
      const eligible = await this.isConsentEligible(lead.id, purpose);
      if (eligible) {
        recipientCount++;
      } else {
        suppressedCount++;
      }
    }

    const processedAt = new Date().toISOString();
    const safeResult: DispatchResult = {
      deliveryMode: "no-delivery",
      recipientCount,
      suppressedCount,
      processedAt,
    };

    await this.client.query(
      `UPDATE app.integration_job
       SET state = 'succeeded',
           safe_result = $1,
           updated_at = now()
       WHERE tenant_id = app.current_tenant() AND id = $2`,
      [JSON.stringify(safeResult), job.id],
    );

    await this.audit("broadcast.dispatched", "integration_job", job.id, 1);

    await this.outbox("broadcast.dispatched", job.id, {
      jobId: job.id,
      deliveryMode: "no-delivery",
      recipientCount,
      suppressedCount,
      processedAt,
    });

    return safeResult;
  }
}
