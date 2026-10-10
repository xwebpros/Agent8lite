import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import eventSchema from "../../../../packages/contracts/internal/native-campaign-workflow-event-v1.schema.json";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import { workflowJson } from "./workflow-json";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);

/** Reference event only, in the caller transaction; no schedule/delivery consumer exists. */
export async function appendCampaignWorkflowEvent(
  client: PoolClient,
  context: TenantContext,
  traceId: string,
  workflow: components["schemas"]["CampaignVersion"],
) {
  const result = await client.query<{ occurred_at: Date }>(
    `SELECT clock_timestamp() AS occurred_at FROM app.campaign_version v
     JOIN app.campaign c ON (c.tenant_id,c.id)=(v.tenant_id,v.campaign_id)
     WHERE current_user='estate_runtime' AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
     AND v.tenant_id=$1 AND v.id=$3 AND v.campaign_id=$4 AND v.version=$5
     AND v.state='draft' AND v.published_at IS NULL AND c.state='draft'`,
    [context.organizationId, context.userId, workflow.id, workflow.campaignId, workflow.version],
  );
  if (!result.rowCount || workflow.state !== "draft")
    throw new AccessError(403, "campaign_context_unavailable", "Verified workflow context is required.");
  const eventId = randomUUID(),
    timestamp = result.rows[0].occurred_at.toISOString();
  const event = {
    eventId,
    type: "campaign.workflow_draft_created",
    version: 1,
    tenantId: context.organizationId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "marketing",
    aggregateType: "campaign_version",
    aggregateId: workflow.id,
    correlationId: traceId,
    payload: {
      campaignId: workflow.campaignId,
      workflowVersionId: workflow.id,
      workflowVersion: workflow.version,
    },
  };
  if (!validEvent(event) || event.aggregateId !== event.payload.workflowVersionId)
    throw new AccessError(500, "event_contract_failure", "Workflow reference validation failed.");
  await client.query(
    `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [context.organizationId, eventId, event.type, workflow.id, workflowJson(event), context.userId],
  );
}
