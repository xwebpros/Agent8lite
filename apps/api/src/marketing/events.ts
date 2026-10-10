import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import eventSchema from "../../../../packages/contracts/internal/native-campaign-draft-event-v1.schema.json";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import type { Campaign } from "./input";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema);

/** Closed native reference event, committed atomically; there is no delivery consumer. */
export async function appendCampaignDraftEvent(
  client: PoolClient,
  context: TenantContext,
  traceId: string,
  campaign: Campaign,
  operation: "create" | "update",
) {
  const clock = await client.query<{ occurred_at: Date }>(
    `SELECT clock_timestamp() AS occurred_at FROM app.campaign c
     WHERE current_user='estate_runtime' AND app.current_tenant()=$1::uuid
     AND app.current_actor()=$2::uuid AND c.tenant_id=$1 AND c.id=$3
     AND c.state='draft' AND c.row_version=$4`,
    [context.organizationId, context.userId, campaign.id, campaign.version],
  );
  if (!clock.rowCount || campaign.state !== "draft")
    throw new AccessError(403, "campaign_context_unavailable", "Verified campaign context is required.");
  const eventId = randomUUID();
  const timestamp = clock.rows[0].occurred_at.toISOString();
  const event = {
    eventId,
    type: "campaign.draft_metadata_changed",
    version: 1,
    tenantId: context.organizationId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "marketing",
    aggregateType: "campaign",
    aggregateId: campaign.id,
    correlationId: traceId,
    payload: { campaignId: campaign.id, metadataRevision: campaign.version, operation },
  };
  if (!validateEvent(event) || event.aggregateId !== event.payload.campaignId)
    throw new AccessError(500, "event_contract_failure", "Campaign reference validation failed.");
  await client.query(
    `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [context.organizationId, eventId, event.type, campaign.id, JSON.stringify(event), context.userId],
  );
}
