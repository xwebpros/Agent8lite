import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tryNativeMockRead } from "../../apps/api/src/mls";
import {
  createSyntheticSession,
  readSession,
  revokeSession,
  sessionCookie,
} from "../../packages/auth/sessions";
import { fixtures } from "../../packages/db/fixtures";
import { AccessError } from "../../packages/db/tenant-transaction";
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
