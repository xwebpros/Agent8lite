import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { NativeMockFeed, NativeMockListing, NativeMockSnapshot } from "../../../../packages/mls";
import { MAX_NATIVE_MOCK_RECORDS } from "../../../../packages/mls/search";
import { MlsReadError } from "../../../../packages/mls";
import type { CanonicalListing } from "../../../../packages/providers/mls/port";

type Row = Record<string, unknown>;
const object = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(typeof value === "string" ? value : Number.NaN);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "invalid";
}
const numberOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
function closedAddress(value: unknown): value is { displayAddress: string | null } {
  return (
    object(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, "displayAddress") &&
    (value.displayAddress === null || typeof value.displayAddress === "string")
  );
}
function closedAttribution(
  value: unknown,
): value is { brokerage: string | null; agent: string | null; disclaimer: string } {
  return (
    object(value) &&
    Object.keys(value).sort().join(",") === "agent,brokerage,disclaimer" &&
    (value.brokerage === null || typeof value.brokerage === "string") &&
    (value.agent === null || typeof value.agent === "string") &&
    typeof value.disclaimer === "string"
  );
}

export class NativeMockListingRepository {
  constructor(private readonly client: PoolClient) {}

  async current(): Promise<{ snapshot: NativeMockSnapshot; now: Date }> {
    // Deliberately no hidden-field/status/expiry predicates: every source affects the cursor generation.
    const feeds = await this.client.query<Row>(
      `SELECT f.*, c.provider AS connection_provider, c.mode AS connection_mode,
        c.state AS connection_state, c.safe_config AS connection_config,
        c.secret_ref AS connection_secret_ref, c.row_version AS connection_revision
       FROM app.mls_feed f JOIN app.integration_connection c
         ON (c.tenant_id,c.id)=(f.tenant_id,f.connection_id)
       WHERE f.tenant_id=app.current_tenant() ORDER BY f.id LIMIT 21 FOR SHARE OF f,c`,
    );
    const listings = await this.client.query<Row>(
      `SELECT l.*, ST_X(l.location::geometry) AS longitude, ST_Y(l.location::geometry) AS latitude
       FROM app.listing l WHERE l.tenant_id=app.current_tenant()
       ORDER BY l.id LIMIT $1 FOR SHARE OF l`,
      [MAX_NATIVE_MOCK_RECORDS + 1],
    );
    if (feeds.rows.length > 20 || listings.rows.length > MAX_NATIVE_MOCK_RECORDS)
      throw new MlsReadError(503, "mock_limit_exceeded", "The bounded mock dataset is unavailable.");
    // Transaction-start now() would permit records that expired while source locks were blocked.
    const clock = await this.client.query<{ current_time: Date }>("SELECT clock_timestamp() AS current_time");
    const now = clock.rows[0]?.current_time;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new MlsReadError(503, "clock_invalid", "The listing clock is unavailable.");
    const generation = createHash("sha256")
      .update(JSON.stringify({ feeds: feeds.rows, listings: listings.rows }))
      .digest("hex");
    return {
      now,
      snapshot: {
        generation,
        feeds: feeds.rows.map((row) => this.feed(row, now)),
        listings: listings.rows.map((row) => this.listing(row)),
      },
    };
  }

  private feed(row: Row, now: Date): NativeMockFeed {
    const approvedAt = Date.parse(timestamp(row.policy_approved_at));
    const sourceAllowed =
      row.connection_provider === "trestle" &&
      row.connection_mode === "mock" &&
      row.connection_state === "mock" &&
      row.connection_secret_ref === null &&
      object(row.connection_config) &&
      row.connection_config.synthetic === true &&
      row.connection_config.liveFeedRights === "unapproved" &&
      Number.isFinite(approvedAt) &&
      approvedAt <= now.getTime();
    return {
      tenantId: String(row.tenant_id),
      id: String(row.id),
      revision: Number(row.row_version),
      mode: String(row.mode),
      transport: String(row.transport),
      providerCode: sourceAllowed ? "mock-synthetic" : "unapproved-source",
      state: sourceAllowed ? String(row.state) : "disabled",
      displayPolicy: row.display_policy,
      nativeRights: row.native_rights,
    };
  }

  private listing(row: Row): NativeMockListing {
    const address = closedAddress(row.address) ? row.address : null;
    const attribution = closedAttribution(row.brokerage_attribution) ? row.brokerage_attribution : null;
    const canonical: CanonicalListing = {
      sourceListingKey: String(row.source_listing_key),
      sourceStatus: String(row.source_status),
      status: row.status as CanonicalListing["status"],
      sourceModifiedAt: row.source_modified_at === null ? null : timestamp(row.source_modified_at),
      ingestedAt: timestamp(row.ingested_at),
      expiresAt: timestamp(row.expires_at),
      listPrice: numberOrNull(row.list_price),
      bedrooms: numberOrNull(row.bedrooms),
      bathrooms: numberOrNull(row.bathrooms),
      area: row.living_area_sqft === null ? null : { value: Number(row.living_area_sqft), unit: "sqft" },
      address: address?.displayAddress ?? null,
      coordinates:
        row.longitude == null || row.latitude == null ? null : [Number(row.longitude), Number(row.latitude)],
      publicRemarks: textOrNull(row.public_remarks),
      propertyType: textOrNull(row.property_type),
      displayAllowed: row.display_allowed === true && address !== null && attribution !== null,
      addressAllowed: row.address_display_allowed === true,
      attribution: attribution ?? { brokerage: null, agent: null, disclaimer: "" },
      synthetic: row.synthetic === true,
    };
    return {
      tenantId: String(row.tenant_id),
      id: String(row.id),
      feedId: String(row.feed_id),
      sourceListingId: textOrNull(row.source_listing_id),
      currency: String(row.currency),
      revision: Number(row.row_version),
      withdrawnAt: row.withdrawn_at === null ? null : timestamp(row.withdrawn_at),
      canonical,
    };
  }
}
