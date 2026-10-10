import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tryNativeMockRead } from "../../apps/api/src/mls";
import {
  createSyntheticSession,
  hashToken,
  readSession,
  revokeSession,
  sessionCookie,
  switchOrganization,
} from "../../packages/auth/sessions";
import { fixtures } from "../../packages/db/fixtures";
import { AccessError } from "../../packages/db/tenant-transaction";
import type { PageListing } from "../../packages/mls";
import { assertContract, assertProblem } from "../helpers/api";
import {
  admin,
  closeDatabase,
  feedA,
  feedB,
  identities,
  nativeId,
  prepareDatabase,
  resetDatabase,
  runtime,
  signingKey,
} from "./database";
import { nativeRights, syntheticAttributionContacts } from "./fixtures";

let server: Server;
let origin: string;
let ownerToken: string;
let agentToken: string;
const base = `/dev/orgs/${fixtures.orgA}/mls/listings`;
const query = (value: unknown, limit = 100) =>
  `?${new URLSearchParams({ filter: JSON.stringify(value), limit: String(limit) })}`;
const request = (path: string, token: string | null = ownerToken, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    headers: { ...headers, ...(token ? { cookie: `${sessionCookie}=${token}` } : {}) },
  });

async function waitForRuntimeLock(fragment: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = await admin.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND usename='estate_runtime' AND wait_event_type='Lock' AND query LIKE $1",
      [`%${fragment}%`],
    );
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Expected current-session/source lock wait was not observed.");
}

async function waitForSessionExpiry(token: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const expired = await admin.query<{ expired: boolean }>(
      "SELECT expires_at<=clock_timestamp() AS expired FROM app.login_session WHERE token_hash=$1",
      [hashToken(token)],
    );
    if (expired.rows[0]?.expired) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The disposable session did not reach its database expiry.");
}

beforeAll(async () => {
  await prepareDatabase();
  ownerToken = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
  agentToken = (await createSyntheticSession(runtime, fixtures.agentUser, fixtures.orgA)).token;
  // Owned ephemeral HTTP acceptance harness. The product router remains unregistered in this branch.
  server = createServer(async (req, res) => {
    const traceId = randomUUID();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Trace-Id", traceId);
    try {
      const token = req.headers.cookie
        ?.split(";")
        .map((value) => value.trim())
        .find((value) => value.startsWith(`${sessionCookie}=`))
        ?.slice(sessionCookie.length + 1);
      const session = await readSession(runtime, token);
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const parsed: Record<string, unknown> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const values = url.searchParams.getAll(key);
        parsed[key] = values.length > 1 ? values : values[0];
      }
      const response = await tryNativeMockRead(
        {
          path: url.pathname,
          method: req.method ?? "GET",
          query: parsed,
          remoteAddress: req.socket.remoteAddress,
          forwardedFor: req.headers["x-forwarded-for"],
        },
        session,
        runtime,
        { signingKey },
      );
      if (!response) throw new AccessError(404, "route_unavailable", "Route unavailable.");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response.body));
    } catch (error) {
      const safe =
        error instanceof AccessError
          ? error
          : new AccessError(503, "service_unavailable", "The operation could not be completed.");
      res.statusCode = safe.status;
      res.setHeader("Content-Type", "application/problem+json");
      res.end(
        JSON.stringify({
          type: `https://estate.example/problems/${safe.code}`,
          title: safe.message,
          detail: safe.message,
          status: safe.status,
          code: safe.code,
          traceId,
          instance: req.url?.split("?")[0],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Owned API port unavailable.");
  expect([3000, 3001]).not.toContain(address.port);
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(resetDatabase);
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await closeDatabase();
});

describe("W07 unregistered dev handler — real sessions, HTTP and PostgreSQL roles", () => {
  it("serves authenticated generated search/detail with private/no-store and fresh synthetic data", async () => {
    const response = await request(base + query({ feedIds: [feedA], priceMin: 390000, bedroomsMin: 3 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const page = await response.json();
    assertContract("PageListing", page);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      const details = await request(`${base}/${item.id}`);
      expect(details.status).toBe(200);
      const body = await details.json();
      assertContract("Listing", body);
      expect(body).toEqual(item);
      expect(body.attribution.disclaimer).toMatch(/^SYNTHETIC DEMO DATA/);
      expect(body.media).toEqual([]);
    }
  });

  it("serves supplied email/phone and omits contact after current field-right revocation", async () => {
    const response = await request(base + query({ feedIds: [feedA] }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const page: PageListing = await response.json();
    assertContract("PageListing", page);
    for (const [index, contact] of syntheticAttributionContacts.entries()) {
      const id = nativeId(`SYNTHETIC-VEGAS-${String(index + 1).padStart(3, "0")}`);
      expect(page.items.find((item) => item.id === id)?.attribution.contact).toEqual(contact);
      const details = await request(`${base}/${id}`);
      expect(details.status).toBe(200);
      expect((await details.json()).attribution.contact).toEqual(contact);
    }
    await admin.query("UPDATE app.mls_feed SET native_rights=$2 WHERE id=$1", [
      feedA,
      {
        ...nativeRights,
        allowedFields: nativeRights.allowedFields.filter((field) => field !== "attribution.contact"),
      },
    ]);
    const revoked = await request(base + query({ feedIds: [feedA] }));
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toContain("no-store");
    const body: PageListing = await revoked.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => !Object.hasOwn(item.attribution, "contact"))).toBe(true);
    for (const contact of syntheticAttributionContacts)
      expect(JSON.stringify(body)).not.toContain(contact.value);
  });

  it("denies missing/expired/revoked sessions and inactive membership", async () => {
    await assertProblem(await request(base, null), 401);
    await assertProblem(await request(base, "invalid"), 401);
    const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
    await revokeSession(runtime, await readSession(runtime, token));
    await assertProblem(await request(base, token), 401);
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND user_id=$2", [
      fixtures.orgA,
      fixtures.ownerUser,
    ]);
    await assertProblem(await request(base), 403);
  });

  it("rejects retained verified session values after revocation or active-organization switching", async () => {
    for (const change of ["revoke", "switch", "actor", "hash"]) {
      const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
      const session = await readSession(runtime, token);
      if (change === "revoke") await revokeSession(runtime, session);
      if (change === "switch") await switchOrganization(runtime, session, fixtures.orgB);
      const retained =
        change === "actor"
          ? { ...session, userId: fixtures.agentUser }
          : change === "hash"
            ? { ...session, tokenHash: "malformed" }
            : session;
      await expect(
        tryNativeMockRead(
          { path: base, method: "GET", query: {}, remoteAddress: "127.0.0.1" },
          retained,
          runtime,
          { signingKey },
        ),
      ).rejects.toMatchObject({ status: 401, code: "session_expired" });
    }
    const reused = await runtime.query("SELECT current_setting('app.session_hash',true) AS session");
    expect(reused.rows[0].session ?? "").toBe("");
    expect((await runtime.query("SELECT token_hash FROM app.login_session")).rowCount).toBe(0);
  });

  it.each(["list", "detail"])(
    "denies %s when its session expires while blocked on a source lock",
    async (kind) => {
      const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
      await admin.query(
        "UPDATE app.login_session SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",
        [hashToken(token)],
      );
      const writer = await admin.connect();
      let pending: Promise<Response> | undefined;
      try {
        await writer.query("BEGIN");
        await writer.query("SELECT id FROM app.listing WHERE id=$1 FOR UPDATE", [
          nativeId("SYNTHETIC-VEGAS-001"),
        ]);
        pending = request(kind === "list" ? base : `${base}/${nativeId("SYNTHETIC-VEGAS-001")}`, token);
        await waitForRuntimeLock("FROM app.listing l");
        await waitForSessionExpiry(token);
        await writer.query("COMMIT");
        const response = await pending;
        const problem = await assertProblem(response, 401);
        expect(problem.code).toBe("session_expired");
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(JSON.stringify(problem)).not.toMatch(/Juniper|sourceListingKey|listPrice|Example Only/);
      } finally {
        await writer.query("ROLLBACK");
        writer.release();
        await pending;
      }
    },
  );

  it("evaluates session time after a blocked SHARE lock even when the writer never updates the tuple", async () => {
    const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
    await admin.query(
      "UPDATE app.login_session SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",
      [hashToken(token)],
    );
    const writer = await admin.connect();
    let pending: Promise<Response> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT token_hash FROM app.login_session WHERE token_hash=$1 FOR UPDATE", [
        hashToken(token),
      ]);
      pending = request(base, token);
      await waitForRuntimeLock("FROM app.login_session");
      await waitForSessionExpiry(token);
      await writer.query("COMMIT");
      const problem = await assertProblem(await pending, 401);
      expect(problem.code).toBe("session_expired");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await pending;
    }
  });

  it.each(["revoke", "switch"])("holds session %s until a valid in-flight read commits", async (change) => {
    const token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
    const session = await readSession(runtime, token);
    const writer = await admin.connect();
    const additionalFeed = change === "switch" ? randomUUID() : null;
    let pending: Promise<Response> | undefined;
    let revoked: Promise<void> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM app.listing WHERE id=$1 FOR UPDATE", [
        nativeId("SYNTHETIC-VEGAS-001"),
      ]);
      pending = request(base, token);
      await waitForRuntimeLock("FROM app.listing l");
      revoked =
        change === "revoke"
          ? revokeSession(runtime, session)
          : switchOrganization(runtime, session, fixtures.orgB);
      await waitForRuntimeLock(`${change === "revoke" ? "DELETE FROM" : "UPDATE"} app.login_session`);
      await writer.query("COMMIT");
      const response = await pending;
      expect(response.status).toBe(200);
      assertContract("PageListing", await response.json());
      await revoked;
      const problem = await assertProblem(await request(base, token), change === "revoke" ? 401 : 403);
      expect(problem.code).toBe(change === "revoke" ? "session_expired" : "active_organization_mismatch");
      if (change === "switch") {
        // Registered seeds can have other legitimate B feeds. Reproduce that without changing shared seeds.
        await admin.query(
          `INSERT INTO app.mls_feed SELECT (jsonb_populate_record(NULL::app.mls_feed,
          to_jsonb(f) || jsonb_build_object('id',$1::uuid))).* FROM app.mls_feed f WHERE tenant_id=$2 AND id=$3`,
          [additionalFeed, fixtures.orgB, feedB],
        );
        await admin.query(
          `INSERT INTO app.listing SELECT (jsonb_populate_record(NULL::app.listing,
          to_jsonb(l) || jsonb_build_object('id',$1::uuid,'feed_id',$2::uuid))).* FROM app.listing l WHERE tenant_id=$3 AND id=$4`,
          [randomUUID(), additionalFeed, fixtures.orgB, nativeId("SYNTHETIC-VEGAS-001", feedB)],
        );
        const current = await request(`/dev/orgs/${fixtures.orgB}/mls/listings`, token);
        expect(current.status).toBe(200);
        const page: PageListing = await current.json();
        assertContract("PageListing", page);
        expect(page.items.some((item) => item.feedId === feedB)).toBe(true);
        expect(page.items.some((item) => item.feedId === additionalFeed)).toBe(true);
        const stored = await admin.query<{ id: string; feed_id: string; tenant_id: string }>(
          "SELECT id,feed_id,tenant_id FROM app.listing WHERE id=ANY($1::uuid[])",
          [page.items.map((item) => item.id)],
        );
        expect(stored.rows).toHaveLength(page.items.length);
        expect(new Set(stored.rows.map((row) => row.tenant_id))).toEqual(new Set([fixtures.orgB]));
        for (const item of page.items)
          expect(stored.rows.find((row) => row.id === item.id)?.feed_id).toBe(item.feedId);
      }
      expect((await runtime.query("SELECT token_hash FROM app.login_session")).rowCount).toBe(0);
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await pending;
      await revoked;
      if (additionalFeed) {
        await admin.query("DELETE FROM app.listing WHERE tenant_id=$1 AND feed_id=$2", [
          fixtures.orgB,
          additionalFeed,
        ]);
        await admin.query("DELETE FROM app.mls_feed WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgB,
          additionalFeed,
        ]);
      }
    }
  });

  it("denies tenant substitution, non-MLS members, forwarded remote clients and disabled capability", async () => {
    await assertProblem(await request(`/dev/orgs/${fixtures.orgB}/mls/listings`), 403);
    await assertProblem(await request(base, agentToken), 403);
    await assertProblem(await request(base, ownerToken, { "x-forwarded-for": "198.51.100.2" }), 403);
    await assertProblem(
      await request(base, ownerToken, { "x-forwarded-for": "127.0.0.1, 198.51.100.2" }),
      403,
    );
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='mls'", [
      fixtures.orgA,
    ]);
    await assertProblem(await request(base), 403);
  });

  it("uses one generic unavailable detail response for hidden/expired/withdrawn/other-tenant/missing IDs", async () => {
    const path = `${base}/${nativeId("SYNTHETIC-VEGAS-001")}`;
    const missing = await assertProblem(await request(`${base}/${randomUUID()}`), 404);
    const other = await assertProblem(
      await request(`${base}/${nativeId("SYNTHETIC-VEGAS-001", feedB)}`),
      404,
    );
    expect(other.code).toBe(missing.code);
    for (const assignment of [
      "display_allowed=false",
      "expires_at=clock_timestamp()-interval '1 second'",
      "withdrawn_at=clock_timestamp()",
    ]) {
      await resetDatabase();
      await admin.query(`UPDATE app.listing SET ${assignment} WHERE id=$1`, [
        nativeId("SYNTHETIC-VEGAS-001"),
      ]);
      const denied = await assertProblem(await request(path), 404);
      expect(denied.code).toBe(missing.code);
      expect(denied.title).toBe(missing.title);
      expect(JSON.stringify(denied)).not.toMatch(/Juniper|sourceListingKey|listPrice|Example Only/);
    }
  });

  it("rejects repeated/unknown/invalid filters, cursor tampering and stale pagination", async () => {
    for (const suffix of [
      "?limit=1&limit=2",
      "?tenantId=forged",
      "?filter=%7B",
      "?filter=null",
      "?sort=private",
      "?limit=101",
      "?filter=%7B%22q%22%3A%22" + "x".repeat(121) + "%22%7D",
    ])
      await assertProblem(await request(base + suffix), 422);
    const page = await (await request(base + query({ feedIds: [feedA] }, 1))).json();
    assertContract("PageListing", page);
    expect(page.nextCursor).not.toBeNull();
    const next = `${base}${query({ feedIds: [feedA] }, 1)}&cursor=${encodeURIComponent(page.nextCursor!)}`;
    expect((await request(next)).status).toBe(200);
    await assertProblem(await request(`${next}x`), 422);
    await admin.query("UPDATE app.mls_feed SET native_rights=NULL WHERE id=$1", [feedA]);
    await assertProblem(await request(next), 422);
  });

  it("keeps public, visitor, inquiry and mutation routes unregistered", async () => {
    for (const path of [
      `/v1/public/sites/${randomUUID()}/listings`,
      `${base}/${nativeId("SYNTHETIC-VEGAS-001")}/inquiries`,
      `/dev/orgs/${fixtures.orgA}/mls/favorites`,
    ])
      await assertProblem(await request(path), 404);
    const post = await fetch(origin + base, {
      method: "POST",
      headers: { cookie: `${sessionCookie}=${ownerToken}` },
    });
    await assertProblem(post, 404);
  });

  it("denies production/disabled/nonmock configuration before opening a tenant transaction", async () => {
    const session = await readSession(runtime, ownerToken);
    const connect = vi.spyOn(runtime, "connect");
    try {
      for (const environment of [
        { APP_ENV: "production", DEV_AUTH_ENABLED: "true", MLS_PROVIDER: "mock" },
        { APP_ENV: "test", DEV_AUTH_ENABLED: "false", MLS_PROVIDER: "mock" },
        { APP_ENV: "test", DEV_AUTH_ENABLED: "true", MLS_PROVIDER: "live" },
      ])
        await expect(
          tryNativeMockRead(
            { path: base, method: "GET", query: {}, remoteAddress: "127.0.0.1" },
            session,
            runtime,
            { signingKey, environment },
          ),
        ).rejects.toMatchObject({ status: 404, code: "synthetic_mls_disabled" });
      expect(connect).not.toHaveBeenCalled();
      await expect(
        tryNativeMockRead(
          { path: base, method: "GET", query: {}, body: {}, remoteAddress: "127.0.0.1" },
          session,
          runtime,
          { signingKey },
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
