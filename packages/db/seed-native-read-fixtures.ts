import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../contracts/generated/api";
import { MOCK_CLOCK, MockMlsAdapter, mockPolicy } from "../providers/mls/mock";
import type { MlsAttributionContact, MlsPolicy } from "../providers/mls/port";
import { fixtures } from "./fixtures";

const rights: MlsPolicy = {
  ...mockPolicy,
  allowedFields: [
    ...mockPolicy.allowedFields,
    "propertyType",
    "sourceListingId",
    "sourceModifiedAt",
    "attribution.brokerage",
    "attribution.agent",
    "attribution.disclaimer",
    "attribution.contact",
  ],
};
const policy: components["schemas"]["DisplayPolicy"] = {
  version: 1,
  approved: true,
  allowedStatuses: ["active", "pending"],
  displayFields: [...rights.allowedFields],
  maxStaleSeconds: 86400,
  refreshSeconds: 60,
  rawRetentionSeconds: 86400,
  mediaCacheSeconds: 0,
  allowAiUse: false,
  allowReplication: true,
  attributionText: "SYNTHETIC DEMO DATA. No real property or offer.",
};
function stableId(value: string) {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export const syntheticFeedId = (tenant: string) => stableId(`native-synthetic-feed-v1:${tenant}`);
const fixtureContacts: Readonly<Record<string, MlsAttributionContact>> = {
  "SYNTHETIC-VEGAS-001": { kind: "email", value: "attribution@fictional-brokerage.example.invalid" },
  "SYNTHETIC-VEGAS-002": { kind: "phone", value: "+1 702 555 0100" },
};

/** Called only inside the explicitly enabled loopback synthetic seed transaction. */
export async function seedNativeReadFixtures(client: PoolClient) {
  const schema = await client.query(
    "SELECT count(*)::int count FROM information_schema.columns WHERE table_schema='app' AND (table_name,column_name) IN (('mls_feed','native_rights'),('listing','ingested_at'),('idempotency_record','response_etag'))",
  );
  // Older candidate-only worktrees keep their baseline. Never invent permissive legacy rights.
  if (schema.rows[0].count !== 3) return;
  const clock = (
    await client.query<{ seed_clock: Date }>(
      "SELECT date_trunc('milliseconds',clock_timestamp()) AS seed_clock",
    )
  ).rows[0]?.seed_clock;
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime()))
    throw new Error("Synthetic listing seed clock is unavailable.");
  // Newly inserted static fixtures keep their relative age and TTL under the actual database clock.
  // ON CONFLICT DO NOTHING below means an existing row's expiry is never renewed.
  const clockOffset = Math.max(0, clock.getTime() - MOCK_CLOCK.getTime());
  const seededTimestamp = (value: string) => {
    const timestamp = Date.parse(value) + clockOffset;
    if (!Number.isFinite(timestamp)) throw new Error("Synthetic listing fixture timestamp is invalid.");
    return new Date(timestamp).toISOString();
  };
  for (const tenant of [fixtures.orgA, fixtures.orgB]) {
    await client.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'websites','enabled')ON CONFLICT DO NOTHING",
      [tenant],
    );
    const connection = await client.query(
      "SELECT id FROM app.integration_connection WHERE tenant_id=$1 AND provider='trestle' AND mode='mock' AND state='mock' AND secret_ref IS NULL AND safe_config->>'synthetic'='true' AND safe_config->>'liveFeedRights'='unapproved' ORDER BY id LIMIT 1",
      [tenant],
    );
    if (!connection.rowCount) continue;
    await client.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'mls','enabled')ON CONFLICT DO NOTHING",
      [tenant],
    );
    const feed = syntheticFeedId(tenant);
    await client.query(
      "INSERT INTO app.mls_feed(tenant_id,id,connection_id,market_code,mode,transport,state,display_policy,native_rights,policy_approved_at)VALUES($1,$2,$3,'SYNTHETIC-VEGAS','mock','mock','ready',$4,$5,$6)ON CONFLICT DO NOTHING",
      [tenant, feed, connection.rows[0].id, policy, rights, MOCK_CLOCK],
    );
    const changes = await new MockMlsAdapter(
      () => MOCK_CLOCK,
      () => rights,
    ).readChanges(
      { organizationId: tenant, feedId: feed, policyVersion: "synthetic-v1" },
      { cursor: null, watermark: null, overlapSeconds: 0, limit: 100 },
    );
    for (const change of changes.changes) {
      const source = change.listing;
      if (!source) continue;
      if (!source.synthetic) throw new Error("Synthetic seed rejects non-synthetic listings.");
      const contact = fixtureContacts[source.sourceListingKey];
      const item = {
        ...source,
        attribution: { ...source.attribution, ...(contact ? { contact: { ...contact } } : {}) },
      };
      await client.query(
        `INSERT INTO app.listing(tenant_id,id,feed_id,source_listing_key,source_listing_id,source_status,status,list_price,currency,address,location,bedrooms,bathrooms,living_area_sqft,property_type,public_remarks,brokerage_attribution,display_allowed,address_display_allowed,synthetic,source_modified_at,content_hash,expires_at,ingested_at)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,'USD',$8,CASE WHEN $9::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9,$10),4326)::geography END,$11,$12,$13,$14,$15,$16,$17,$18,true,$19,$20,$21,$22)ON CONFLICT DO NOTHING`,
        [
          tenant,
          stableId(`${feed}:${item.sourceListingKey}`),
          feed,
          item.sourceListingKey,
          item.sourceStatus,
          item.status,
          item.listPrice,
          { displayAddress: item.address },
          item.coordinates?.[0] ?? null,
          item.coordinates?.[1] ?? null,
          item.bedrooms,
          item.bathrooms,
          item.area?.value ?? null,
          item.propertyType,
          item.publicRemarks,
          item.attribution,
          item.displayAllowed,
          item.addressAllowed,
          item.sourceModifiedAt,
          createHash("sha256").update(JSON.stringify(item)).digest("hex"),
          seededTimestamp(item.expiresAt),
          seededTimestamp(item.ingestedAt),
        ],
      );
    }
  }
}
