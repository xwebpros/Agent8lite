import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantContext } from "../../../../packages/db/tenant-transaction";

interface ActionRow {
  id: string;
  lead_id: string;
  kind: "email" | "sms" | "task";
  message_design_id: string | null;
  enrollment_id: string | null;
  campaign_step_id: string | null;
  idempotency_key: string;
  generation: number;
  attempt_count: number;
}

interface ProcessResult {
  actionId: string;
  state: "done" | "failed" | "cancelled";
  reason: string;
}

export class ActionWorker {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string = "",
  ) {}

  private async audit(action: string, resourceType: string, resourceId: string) {
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        this.context.organizationId,
        this.context.userId,
        action,
        resourceType,
        resourceId,
        this.traceId,
        JSON.stringify({ deliveryMode: "no-delivery" }),
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

  async processDueActions(batchSize = 20): Promise<{ processed: number; results: ProcessResult[] }> {
    if ((process.env.DELIVERY_PROVIDER ?? "no-delivery") !== "no-delivery")
      throw new Error("ActionWorker requires DELIVERY_PROVIDER=no-delivery.");

    const due = await this.client.query<ActionRow>(
      `UPDATE app.scheduled_action
       SET state='claimed', lease_until=clock_timestamp()+interval '5 minutes',
           attempt_count=attempt_count+1, updated_at=now()
       WHERE (tenant_id,id) IN (
         SELECT tenant_id,id FROM app.scheduled_action
         WHERE tenant_id=app.current_tenant() AND state='pending'
           AND due_at<=clock_timestamp()
         ORDER BY due_at LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id,lead_id,kind,message_design_id,enrollment_id,campaign_step_id,idempotency_key,generation,attempt_count`,
      [batchSize],
    );

    const results: ProcessResult[] = [];
    for (const action of due.rows) {
      const result = await this.processAction(action);
      results.push(result);
    }
    return { processed: results.length, results };
  }

  private async processAction(action: ActionRow): Promise<ProcessResult> {
    if (action.kind === "task") {
      await this.client.query(
        `UPDATE app.scheduled_action SET state='done', updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$1`,
        [action.id],
      );
      await this.audit("scheduled_action.completed", "scheduled_action", action.id);
      await this.outbox("scheduled_action.completed", action.id, {
        actionId: action.id, kind: action.kind, leadId: action.lead_id,
      });
      return { actionId: action.id, state: "done", reason: "task_recorded" };
    }

    const purpose = action.kind === "email" ? "email_marketing" : "sms_marketing";
    const consent = await this.client.query(
      `SELECT cs.state FROM app.consent_state cs
       JOIN app.contact_channel cc ON (cc.tenant_id,cc.id)=(cs.tenant_id,cs.contact_channel_id)
       WHERE cs.tenant_id=app.current_tenant() AND cc.lead_id=$1 AND cs.purpose=$2`,
      [action.lead_id, purpose],
    );

    const states = consent.rows.map((r: { state: string }) => r.state);
    if (states.includes("withdrawn") || !states.includes("granted")) {
      await this.client.query(
        `UPDATE app.scheduled_action SET state='cancelled', updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$1`,
        [action.id],
      );
      await this.audit("scheduled_action.suppressed", "scheduled_action", action.id);
      return { actionId: action.id, state: "cancelled", reason: "consent_suppressed" };
    }

    const connectionId = randomUUID();
    await this.client.query(
      `INSERT INTO app.delivery_attempt(tenant_id,scheduled_action_id,connection_id,request_key,state,safe_error)
       VALUES(app.current_tenant(),$1,$2,$3,'done',NULL)`,
      [action.id, connectionId, `no-delivery:${action.idempotency_key}:${action.attempt_count}`],
    );

    await this.client.query(
      `UPDATE app.scheduled_action SET state='done', updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$1`,
      [action.id],
    );

    await this.audit("scheduled_action.dispatched", "scheduled_action", action.id);
    await this.outbox("scheduled_action.dispatched", action.id, {
      actionId: action.id, kind: action.kind, leadId: action.lead_id,
      deliveryMode: "no-delivery",
    });

    return { actionId: action.id, state: "done", reason: "no_delivery_synthetic" };
  }
}
