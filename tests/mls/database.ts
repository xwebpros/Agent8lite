import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { fixtures } from "../../packages/db/fixtures";
import { MOCK_CLOCK, MockMlsAdapter } from "../../packages/providers/mls/mock";
import type { CanonicalListing } from "../../packages/providers/mls/port";
import { displayPolicy, nativeRights, syntheticAttributionContacts } from "./fixtures";

function isolatedUrl(name: "TEST_MIGRATION_DATABASE_URL" | "TEST_DATABASE_URL") {
  const value = process.env[name];
  if (!value) throw new Error("W07 DB tests require an explicit disposable database runner.");
  const url = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_(?:acceptance|w07)_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("W07 DB tests cannot use the shared estate database.");
  return url;
}
const migration = isolatedUrl("TEST_MIGRATION_DATABASE_URL");
const runtimeUrl = isolatedUrl("TEST_DATABASE_URL");
if (migration.pathname !== runtimeUrl.pathname)
  throw new Error("W07 test identities must use the same disposable database.");
export const admin = new pg.Pool({ connectionString: migration.href, max: 4 });
export const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });
export const feedA = randomUUID();
export const feedB = randomUUID();
export const identities = {
  ownerA: { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
  ownerB: { userId: fixtures.ownerUser, organizationId: fixtures.orgB },
  agent: { userId: fixtures.agentUser, organizationId: fixtures.orgA },
};
export const signingKey = "w07-disposable-test-only-native-cursor-key-32-bytes";
const recordIds = new Map<string, string>();
let canonical: CanonicalListing[] = [];
let originalRole: string;
export let connectionA: string;

export const nativeId = (key: string, feed = feedA) => {
  const binding = `${feed}:${key}`;
  if (!recordIds.has(binding)) recordIds.set(binding, randomUUID());
  return recordIds.get(binding)!;
};
export async function prepareDatabase() {
  const columns = await admin.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND (table_name,column_name) IN (('mls_feed','native_rights'),('listing','ingested_at'))",
  );
  if (columns.rowCount === 0)
    await admin.query(await readFile("docs/proposals/W07/proposed-read-migration.sql", "utf8"));
  else if (columns.rowCount !== 2) throw new Error("W07 candidate schema is incomplete.");
  const role = await admin.query("SELECT role_id FROM app.membership WHERE tenant_id=$1 AND user_id=$2", [
    fixtures.orgA,
    fixtures.ownerUser,
  ]);
  originalRole = role.rows[0].role_id;
  const changes = await new MockMlsAdapter(
    () => MOCK_CLOCK,
    () => nativeRights,
  ).readChanges(
    { organizationId: fixtures.orgA, feedId: feedA, policyVersion: "synthetic-v1" },
    { cursor: null, watermark: null, overlapSeconds: 0, limit: 100 },
  );
  canonical = changes.changes.flatMap((change, index) =>
    change.listing
      ? [
          {
            ...change.listing,
            attribution: {
              ...change.listing.attribution,
              ...(syntheticAttributionContacts[index]
                ? { contact: structuredClone(syntheticAttributionContacts[index]) }
                : {}),
            },
          },
        ]
      : [],
  );
  await resetDatabase();
}

export async function resetDatabase() {
  const clock = await admin.query<{ fixture_clock: Date }>(
    "SELECT date_trunc('milliseconds',clock_timestamp()) AS fixture_clock",
  );
  const fixtureClock = clock.rows[0]?.fixture_clock;
  if (!(fixtureClock instanceof Date) || !Number.isFinite(fixtureClock.getTime()))
    throw new Error("W07 fixture database clock is unavailable.");
  // Keep the static sources' relative age, expiry duration and ordering under actual-clock reads.
  // Source modification timestamps, content and the canonical fixture remain unchanged.
  const clockOffset = fixtureClock.getTime() - MOCK_CLOCK.getTime();
  const fixtureTimestamp = (value: string) => {
    const timestamp = Date.parse(value) + clockOffset;
    if (!Number.isFinite(timestamp)) throw new Error("W07 fixture timestamp is invalid.");
    return new Date(timestamp).toISOString();
  };
  await admin.query(
    "UPDATE app.membership SET role_id=$1,status='active' WHERE tenant_id=$2 AND user_id=$3",
    [originalRole, fixtures.orgA, fixtures.ownerUser],
  );
  await admin.query("UPDATE app.organization SET status='active' WHERE id IN ($1,$2)", [
    fixtures.orgA,
    fixtures.orgB,
  ]);
  for (const [tenant, feed] of [
    [fixtures.orgA, feedA],
    [fixtures.orgB, feedB],
  ]) {
    await admin.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state) VALUES($1,'mls','enabled') ON CONFLICT(tenant_id,feature) DO UPDATE SET state='enabled',effective_until=NULL",
      [tenant],
    );
    const connection = await admin.query(
      "SELECT id FROM app.integration_connection WHERE tenant_id=$1 AND provider='trestle' AND mode='mock' ORDER BY id LIMIT 1",
      [tenant],
    );
    if (!connection.rowCount) throw new Error("The foundation synthetic Trestle connection is missing.");
    const connectionId = connection.rows[0].id;
    if (tenant === fixtures.orgA) connectionA = connectionId;
    await admin.query(
      "UPDATE app.integration_connection SET provider='trestle',mode='mock',state='mock',secret_ref=NULL,safe_config=$2 WHERE tenant_id=$1 AND id=$3",
      [tenant, { synthetic: true, liveFeedRights: "unapproved" }, connectionId],
    );
    await admin.query(
      `INSERT INTO app.mls_feed(tenant_id,id,connection_id,market_code,mode,transport,state,display_policy,native_rights,policy_approved_at)
      VALUES($1,$2,$3,'SYNTHETIC-VEGAS','mock','mock','ready',$4,$5,clock_timestamp()-interval '1 second')
      ON CONFLICT(tenant_id,id) DO UPDATE SET mode='mock',transport='mock',state='ready',display_policy=EXCLUDED.display_policy,native_rights=EXCLUDED.native_rights,policy_approved_at=EXCLUDED.policy_approved_at`,
      [tenant, feed, connectionId, displayPolicy, nativeRights],
    );
    await admin.query("DELETE FROM app.listing WHERE tenant_id=$1 AND feed_id=$2", [tenant, feed]);
    for (const source of canonical) {
      const location = source.coordinates;
      await admin.query(
        `INSERT INTO app.listing(tenant_id,id,feed_id,source_listing_key,source_listing_id,source_status,status,list_price,currency,address,location,bedrooms,bathrooms,living_area_sqft,property_type,public_remarks,brokerage_attribution,display_allowed,address_display_allowed,synthetic,source_modified_at,content_hash,expires_at,ingested_at)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,'USD',$8,CASE WHEN $9::float8 IS NULL THEN NULL ELSE ST_SetSRID(ST_MakePoint($9,$10),4326)::geography END,$11,$12,$13,$14,$15,$16,$17,$18,true,$19,$20,$21,$22)`,
        [
          tenant,
          nativeId(source.sourceListingKey, feed),
          feed,
          source.sourceListingKey,
          source.sourceStatus,
          source.status,
          source.listPrice,
          { displayAddress: source.address },
          location?.[0] ?? null,
          location?.[1] ?? null,
          source.bedrooms,
          source.bathrooms,
          source.area?.value ?? null,
          source.propertyType,
          source.publicRemarks,
          source.attribution,
          source.displayAllowed,
          source.addressAllowed,
          source.sourceModifiedAt,
          createHash("sha256").update(JSON.stringify(source)).digest("hex"),
          fixtureTimestamp(source.expiresAt),
          fixtureTimestamp(source.ingestedAt),
        ],
      );
    }
  }
}

export async function closeDatabase() {
  await runtime.end();
  await admin.end();
}
