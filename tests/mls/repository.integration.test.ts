import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NativeMockReadService, tryNativeMockRead } from "../../apps/api/src/mls";
import { createSyntheticSession, readSession } from "../../packages/auth/sessions";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { assertContract } from "../helpers/api";
import {
  admin,
  closeDatabase,
  connectionA,
  feedA,
  feedB,
  identities,
  nativeId,
  prepareDatabase,
  resetDatabase,
  runtime,
  signingKey,
} from "./database";
import { displayPolicy, nativeRights, syntheticAttributionContacts } from "./fixtures";

beforeAll(async () => {
  await prepareDatabase();
  await assertRuntimeRole(runtime);
});
beforeEach(resetDatabase);
afterAll(closeDatabase);
const list = (query: unknown = {}) =>
  withTenantTransaction(runtime, identities.ownerA, (client, context) =>
    new NativeMockReadService(client, context, { signingKey }).list(query),
  );
const detail = (id = nativeId("SYNTHETIC-VEGAS-001")) =>
  withTenantTransaction(runtime, identities.ownerA, (client, context) =>
    new NativeMockReadService(client, context, { signingKey }).detail(id),
  );
const filter = (criteria: unknown) => ({ filter: JSON.stringify(criteria), limit: "100" });
async function waitForLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const status = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
    if (status.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The expected source lock wait was not observed.");
}

describe("W07 approved candidate — real runtime role and current locked projection", () => {
  it("reads supplied fictional email/phone and preserves absent/null historical attribution", async () => {
    const response = await list(filter({ feedIds: [feedA] }));
    for (const [index, contact] of syntheticAttributionContacts.entries()) {
      const id = nativeId(`SYNTHETIC-VEGAS-${String(index + 1).padStart(3, "0")}`);
      expect(response.items.find((item) => item.id === id)?.attribution.contact).toEqual(contact);
      expect((await detail(id)).attribution.contact).toEqual(contact);
    }
    const id = nativeId("SYNTHETIC-VEGAS-001");
    await admin.query(
      "UPDATE app.listing SET brokerage_attribution=brokerage_attribution-'contact' WHERE id=$1",
      [id],
    );
    const absent = await detail(id);
    expect(absent.attribution.brokerageName).toBeTruthy();
    expect(absent.attribution.agentName).toBeTruthy();
    expect(absent.attribution).not.toHaveProperty("contact");
    await admin.query(
      "UPDATE app.listing SET brokerage_attribution=jsonb_set(brokerage_attribution,'{contact}','null'::jsonb) WHERE id=$1",
      [id],
    );
    expect((await detail(id)).attribution.contact).toBeNull();
  });

  it("omits contact independently when either current field policy denies or does not know it", async () => {
    for (const [column, policy] of [
      [
        "native_rights",
        {
          ...nativeRights,
          allowedFields: nativeRights.allowedFields.filter((field) => field !== "attribution.contact"),
        },
      ],
      [
        "display_policy",
        {
          ...displayPolicy,
          displayFields: displayPolicy.displayFields.filter((field) => field !== "attribution.contact"),
        },
      ],
    ] as const) {
      await resetDatabase();
      await admin.query(`UPDATE app.mls_feed SET ${column}=$2 WHERE id=$1`, [feedA, policy]);
      const response = await list(filter({ feedIds: [feedA] }));
      expect(response.items.length).toBeGreaterThan(0);
      expect(response.items.every((item) => !Object.hasOwn(item.attribution, "contact"))).toBe(true);
      expect((await detail()).attribution).not.toHaveProperty("contact");
      for (const contact of syntheticAttributionContacts)
        expect(JSON.stringify(response)).not.toContain(contact.value);
    }
  });

  it("suppresses malformed/extra contact JSON without unrelated agent or office fallback", async () => {
    const id = nativeId("SYNTHETIC-VEGAS-001");
    for (const contact of [
      { kind: "email", value: "not-an-email" },
      { kind: "phone", value: "123" },
      { kind: "phone", value: "123 ext4567" },
      { kind: "owner", value: "owner@example.invalid" },
      { kind: "email", value: "agent@example.invalid", private: "unreviewed" },
    ]) {
      await admin.query(
        "UPDATE app.listing SET brokerage_attribution=jsonb_set(brokerage_attribution,'{contact}',$2::jsonb) WHERE id=$1",
        [id, JSON.stringify(contact)],
      );
      expect((await list(filter({ feedIds: [feedA] }))).items.some((item) => item.id === id)).toBe(false);
      await expect(detail(id)).rejects.toMatchObject({ status: 404, code: "listing_unavailable" });
    }
  });

  it("invalidates a signed cursor after a contact-only source change", async () => {
    const first = await list({ ...filter({ feedIds: [feedA] }), limit: "1" });
    expect(first.nextCursor).not.toBeNull();
    await admin.query(
      "UPDATE app.listing SET brokerage_attribution=jsonb_set(brokerage_attribution,'{contact}',$2::jsonb) WHERE id=$1",
      [nativeId("SYNTHETIC-VEGAS-001"), JSON.stringify(syntheticAttributionContacts[1])],
    );
    await expect(
      list({ ...filter({ feedIds: [feedA] }), limit: "1", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    expect((await detail()).attribution.contact).toEqual(syntheticAttributionContacts[1]);
  });

  it("reads frozen native DTOs through PostgreSQL/PostGIS and keeps feed/tenant identities separate", async () => {
    const response = await list(filter({ feedIds: [feedA], bbox: [-115.16, 36.11, -115.1, 36.13] }));
    assertContract("PageListing", response);
    expect(response.items.length).toBeGreaterThan(0);
    expect(
      response.items.every((item) => item.feedId === feedA && item.synthetic && item.media.length === 0),
    ).toBe(true);
    for (const item of response.items) {
      expect(await detail(item.id)).toEqual(item);
      expect(item.attribution.disclaimer).toMatch(/^SYNTHETIC DEMO DATA/);
    }
    await expect(detail(nativeId("SYNTHETIC-VEGAS-001", feedB))).rejects.toMatchObject({
      status: 404,
      code: "listing_unavailable",
    });
    expect((await list(filter({ feedIds: [feedB] }))).items).toEqual([]);
    const other = await withTenantTransaction(runtime, identities.ownerB, (client, context) =>
      new NativeMockReadService(client, context, { signingKey }).detail(
        nativeId("SYNTHETIC-VEGAS-001", feedB),
      ),
    );
    expect(other.id).not.toBe(nativeId("SYNTHETIC-VEGAS-001"));
  });

  it("uses FORCE RLS without context and across a reused pooled client", async () => {
    expect((await runtime.query("SELECT id FROM app.listing")).rowCount).toBe(0);
    for (const identity of [identities.ownerA, identities.ownerB, identities.ownerA]) {
      await withTenantTransaction(runtime, identity, async (client) => {
        const rows = await client.query("SELECT DISTINCT tenant_id FROM app.listing");
        expect(rows.rows.map((row) => row.tenant_id)).toEqual([identity.organizationId]);
      });
    }
    expect((await runtime.query("SELECT id FROM app.mls_feed")).rowCount).toBe(0);
    expect(
      (await runtime.query("SELECT current_setting('app.tenant_id',true) AS tenant")).rows[0].tenant,
    ).toBe("");
  });

  it("grants SHARE-lock metadata privilege while denying runtime business writes/inserts", async () => {
    await detail(); // Executes all three source SHARE locks with the reviewed minimal grants.
    for (const sql of [
      "UPDATE app.listing SET display_allowed=false WHERE feed_id=$1",
      "UPDATE app.listing SET withdrawn_at=clock_timestamp() WHERE feed_id=$1",
      "UPDATE app.mls_feed SET native_rights='{}'::jsonb WHERE id=$1",
      "UPDATE app.integration_connection SET safe_config='{}'::jsonb WHERE id=$1",
      "DELETE FROM app.listing WHERE feed_id=$1",
    ]) {
      await expect(
        withTenantTransaction(runtime, identities.ownerA, (client) =>
          client.query(sql, [sql.includes("integration_connection") ? connectionA : feedA]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }
    await expect(
      withTenantTransaction(runtime, identities.ownerA, (client) =>
        client.query(
          "INSERT INTO app.mls_feed(tenant_id,connection_id,market_code,mode,transport,state,display_policy)VALUES(app.current_tenant(),$1,'REAL','live','reso','ready','{}')",
          [connectionA],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rechecks membership, role scope and current MLS capability on every read", async () => {
    await detail();
    await expect(
      withTenantTransaction(runtime, identities.agent, (client, context) =>
        new NativeMockReadService(client, context, { signingKey }).list({}),
      ),
    ).rejects.toMatchObject({ status: 403 });
    for (const scope of ["own", "team"]) {
      const roleId = randomUUID();
      await admin.query(
        "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,$4,$3)",
        [
          fixtures.orgA,
          roleId,
          JSON.stringify([{ code: "mls.read", scope }]),
          `Synthetic invalid MLS scope ${scope}`,
        ],
      );
      await admin.query("UPDATE app.membership SET role_id=$1 WHERE tenant_id=$2 AND user_id=$3", [
        roleId,
        fixtures.orgA,
        fixtures.ownerUser,
      ]);
      await expect(detail()).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    }
    await resetDatabase();
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='mls'", [
      fixtures.orgA,
    ]);
    await expect(detail()).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
    await admin.query(
      "UPDATE app.entitlement SET state='enabled',effective_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND feature='mls'",
      [fixtures.orgA],
    );
    await expect(detail()).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
    await resetDatabase();
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND user_id=$2", [
      fixtures.orgA,
      fixtures.ownerUser,
    ]);
    await expect(detail()).rejects.toMatchObject({ status: 403, code: "membership_required" });
  });

  it("suppresses unknown/null/malformed rights/time and source provenance without permissive fallback", async () => {
    for (const mutation of [
      "UPDATE app.mls_feed SET native_rights=NULL WHERE id=$1",
      "UPDATE app.mls_feed SET native_rights='{}' WHERE id=$1",
      "UPDATE app.mls_feed SET policy_approved_at=NULL WHERE id=$1",
      "UPDATE app.mls_feed SET policy_approved_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      "UPDATE app.mls_feed SET mode='live',transport='reso' WHERE id=$1",
      "UPDATE app.listing SET ingested_at=NULL WHERE feed_id=$1",
      "UPDATE app.listing SET ingested_at=clock_timestamp()+interval '1 day' WHERE feed_id=$1",
      "UPDATE app.listing SET expires_at=clock_timestamp()-interval '1 second' WHERE feed_id=$1",
      "UPDATE app.listing SET address='{}' WHERE feed_id=$1",
      "UPDATE app.listing SET brokerage_attribution='{}' WHERE feed_id=$1",
    ]) {
      await resetDatabase();
      await admin.query(mutation, [feedA]);
      expect((await list(filter({ feedIds: [feedA] }))).items).toEqual([]);
      await expect(detail()).rejects.toMatchObject({ status: 404, code: "listing_unavailable" });
    }
    for (const mutation of [
      "UPDATE app.integration_connection SET state='revoked' WHERE id=$1",
      "UPDATE app.integration_connection SET safe_config='{}' WHERE id=$1",
      "UPDATE app.integration_connection SET provider='unreviewed' WHERE id=$1",
      "UPDATE app.integration_connection SET mode='live' WHERE id=$1",
      "UPDATE app.integration_connection SET secret_ref='synthetic-placeholder-not-a-secret' WHERE id=$1",
    ]) {
      await resetDatabase();
      await admin.query(mutation, [connectionA]);
      expect((await list(filter({ feedIds: [feedA] }))).items).toEqual([]);
      await expect(detail()).rejects.toMatchObject({ status: 404 });
      // Restore provider/mode for reset's foundation connection lookup.
      await admin.query("UPDATE app.integration_connection SET provider='trestle',mode='mock' WHERE id=$1", [
        connectionA,
      ]);
    }
  });

  it("filters/sorts only permitted fields and withdrawal invalidates signed pages and details", async () => {
    const first = await list({ ...filter({ feedIds: [feedA] }), limit: "1" });
    expect(first.hasMore).toBe(true);
    await admin.query("UPDATE app.listing SET withdrawn_at=clock_timestamp() WHERE id=$1", [
      first.items[0].id,
    ]);
    await expect(
      list({ ...filter({ feedIds: [feedA] }), limit: "1", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "cursor_invalid" });
    await expect(detail(first.items[0].id)).rejects.toMatchObject({ status: 404 });
    await resetDatabase();
    await admin.query("UPDATE app.mls_feed SET native_rights=$2 WHERE id=$1", [
      feedA,
      { ...nativeRights, allowedFields: ["status"] },
    ]);
    const projected = (await list(filter({ feedIds: [feedA] }))).items;
    expect(projected.length).toBeGreaterThan(0);
    expect(
      projected.every(
        (item) =>
          item.displayAddress === null &&
          item.longitude === null &&
          item.listPrice === null &&
          item.propertyType === null,
      ),
    ).toBe(true);
    for (const criteria of [
      { priceMin: 1 },
      { q: "Juniper" },
      { propertyTypes: ["sample residential"] },
      { bbox: [-116, 36, -115, 37] },
    ])
      expect((await list(filter({ ...criteria, feedIds: [feedA] }))).items).toEqual([]);
    expect(
      (await list({ ...filter({ feedIds: [feedA] }), sort: "price_desc" })).items.map((item) => item.id),
    ).toEqual(projected.map((item) => item.id));
  });

  it("holds source locks through caller commit so concurrent withdrawal/rights revocation waits", async () => {
    for (const [table, id, assignment] of [
      ["listing", nativeId("SYNTHETIC-VEGAS-001"), "withdrawn_at=clock_timestamp()"],
      ["mls_feed", feedA, "native_rights=NULL"],
      ["integration_connection", connectionA, "state='revoked'"],
    ]) {
      await resetDatabase();
      let release!: () => void;
      let loaded!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        loaded = resolve;
      });
      const reader = withTenantTransaction(runtime, identities.ownerA, async (client, context) => {
        const result = await new NativeMockReadService(client, context, { signingKey }).detail(
          nativeId("SYNTHETIC-VEGAS-001"),
        );
        loaded();
        await held;
        return result;
      });
      await ready;
      const writer = await admin.connect();
      try {
        const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const pending = writer.query(`UPDATE app.${table} SET ${assignment} WHERE id=$1`, [id]);
        await waitForLock(pid);
        release();
        await reader;
        await pending;
      } finally {
        release();
        writer.release();
      }
      await expect(detail()).rejects.toMatchObject({ status: 404 });
    }
  });

  it("obtains database clock after waiting for source locks, denying data that expired while blocked", async () => {
    const writer = await admin.connect();
    const reader = await runtime.connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        "UPDATE app.listing SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",
        [nativeId("SYNTHETIC-VEGAS-001")],
      );
      await reader.query("BEGIN");
      await reader.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
        fixtures.orgA,
        fixtures.ownerUser,
      ]);
      const pid = (await reader.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = import("../../apps/api/src/mls/repository").then(({ NativeMockListingRepository }) =>
        new NativeMockListingRepository(reader).current(),
      );
      await waitForLock(pid);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await writer.query("COMMIT");
      const { snapshot, now } = await pending;
      const expiry = snapshot.listings.find((row) => row.id === nativeId("SYNTHETIC-VEGAS-001"))!.canonical
        .expiresAt;
      expect(now.getTime()).toBeGreaterThanOrEqual(Date.parse(expiry));
      await reader.query("COMMIT");
      await expect(detail()).rejects.toMatchObject({ status: 404 });
    } finally {
      await writer.query("ROLLBACK");
      await reader.query("ROLLBACK");
      writer.release();
      reader.release();
    }
  });

  it("rechecks current MLS capability after list/detail source locks when entitlement expires while blocked", async () => {
    const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
    const session = await readSession(runtime, token);
    for (const suffix of ["", `/${nativeId("SYNTHETIC-VEGAS-001")}`]) {
      await resetDatabase();
      const writer = await admin.connect();
      let pending: ReturnType<typeof tryNativeMockRead> | undefined;
      try {
        await writer.query("BEGIN");
        await writer.query("UPDATE app.listing SET row_version=row_version WHERE id=$1", [
          nativeId("SYNTHETIC-VEGAS-001"),
        ]);
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '500 milliseconds' WHERE tenant_id=$1 AND feature='mls'",
          [fixtures.orgA],
        );
        pending = tryNativeMockRead(
          {
            path: `/dev/orgs/${fixtures.orgA}/mls/listings${suffix}`,
            method: "GET",
            query: {},
            remoteAddress: "127.0.0.1",
          },
          session,
          runtime,
          { signingKey },
        );
        // Attach rejection handling before releasing the writer to avoid an unhandled rejection.
        const outcome = pending.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        );
        const deadline = Date.now() + 5000;
        let waiting = false;
        while (Date.now() < deadline) {
          const blocked = await admin.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='estate_runtime' AND wait_event_type='Lock' AND query LIKE '%FROM app.listing l%'",
          );
          if (blocked.rowCount) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        const untilExpired = Date.now() + 5000;
        while (Date.now() < untilExpired) {
          const status = await admin.query(
            "SELECT effective_until<=clock_timestamp() AS expired FROM app.entitlement WHERE tenant_id=$1 AND feature='mls'",
            [fixtures.orgA],
          );
          if (status.rows[0].expired) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await writer.query("COMMIT");
        const result = await outcome;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatchObject({ status: 403, code: "entitlement_disabled" });
      } finally {
        await writer.query("ROLLBACK");
        await pending?.catch(() => {});
        writer.release();
      }
    }
  });

  it("rejects an oversized source cohort rather than returning truncated data", async () => {
    await admin.query(
      `INSERT INTO app.listing(tenant_id,feed_id,source_listing_key,source_status,status,brokerage_attribution,display_allowed,synthetic,content_hash,expires_at,ingested_at)
      SELECT $1,$2,'SYNTHETIC-OVERFLOW-'||n,'Mock active','active','{}',false,true,'synthetic',clock_timestamp()+interval '1 hour',clock_timestamp() FROM generate_series(1,501) n`,
      [fixtures.orgA, feedA],
    );
    await expect(list()).rejects.toMatchObject({ status: 503, code: "mock_limit_exceeded" });
  });
});
