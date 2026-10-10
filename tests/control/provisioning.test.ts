import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHttpAdapter } from "../../apps/api/src/control/http-adapter";
import { validateSchema } from "../../apps/api/src/contract-validation";
import { CrmBootstrap } from "../../apps/api/src/control/bootstrap-ports";
import {
  ControlProvisioningService,
  ProvisioningExecution,
  runProvisioning,
  type BootstrapPortFactory,
} from "../../apps/api/src/control/provisioning-service";
import { StaffSessionIssuer, withStaffTransaction } from "../../packages/auth/staff-sessions";
import { createStaffPools, assertStaffRole, requireSyntheticStaffMode } from "../../packages/db/staff-pools";
import { fixtures } from "../../packages/db/fixtures";
import type { ProvisioningClaim } from "../../packages/contracts/internal/control-plane-port";
import { BillingBootstrap } from "../../apps/api/src/control/bootstrap-ports";

const enabled = /^estate_control_test_[0-9a-f]{16}$/.test(process.env.CONTROL_OWNED_DATABASE ?? "");
if (!enabled)
  throw new Error("Run control tests with tests/control/run.mjs against its owned disposable database.");
let server: Server, origin: string;
const pools = createStaffPools();
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
let administrator: Login, support: Login;
type Login = { cookie: string; token: string; csrf: string; body: any };
async function request(path: string, method = "GET", input?: unknown, login?: Login, key = randomUUID()) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(method === "POST"
        ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": key }
        : {}),
      ...(login ? { Cookie: login.cookie, "X-CSRF-Token": login.csrf } : {}),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}
async function login(identity: "administrator" | "support"): Promise<Login> {
  const result = await request("/dev/staff/session", "POST", { identity });
  expect(result.response.status).toBe(200);
  const cookie = result.response.headers.get("set-cookie")!.split(";")[0];
  return {
    cookie,
    token: cookie.split("=")[1],
    csrf: result.response.headers.get("x-csrf-token")!,
    body: result.body,
  };
}
async function enqueue(key = randomUUID(), name = `Synthetic Organization ${randomUUID()}`) {
  const result = await request(
    "/v1/platform/organizations",
    "POST",
    { name, timezone: "Asia/Bangkok", locale: "en-US" },
    administrator,
    key,
  );
  expect(result.response.status).toBe(202);
  return result.body;
}
async function jobRow(id: string) {
  return (await admin.query("SELECT * FROM app.control_job WHERE id=$1", [id])).rows[0];
}
const trace = () => randomUUID();
beforeAll(async () => {
  let handler: Awaited<ReturnType<typeof createStaffHttpAdapter>>;
  server = createServer((request, response) => {
    if (!handler) {
      response.writeHead(503).end();
      return;
    }
    void handler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  handler = await createStaffHttpAdapter({ ...pools, allowedOrigins: [origin] });
  administrator = await login("administrator");
  support = await login("support");
}, 20_000);
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([pools.control.end(), pools.issuer.end(), admin.end()]);
});

describe("separate staff sessions and transactional provisioning", () => {
  it("fails before database use outside enabled synthetic mode and requires separate configured URLs", async () => {
    expect(() => requireSyntheticStaffMode({ APP_ENV: "production", DEV_AUTH_ENABLED: "true" })).toThrow();
    expect(() => createStaffPools({ APP_ENV: "test", DEV_AUTH_ENABLED: "true" })).toThrow();
    expect(() =>
      createStaffPools({
        APP_ENV: "test",
        DEV_AUTH_ENABLED: "true",
        CONTROL_DATABASE_URL: process.env.DATABASE_URL,
        STAFF_ISSUER_DATABASE_URL: process.env.STAFF_ISSUER_DATABASE_URL,
      }),
    ).toThrow();
    const previous = process.env.APP_ENV;
    let connected = false;
    try {
      process.env.APP_ENV = "production";
      const unavailable = {
        connect: async () => {
          connected = true;
          throw new Error("database must not be reached");
        },
      } as unknown as Pool;
      await expect(
        withStaffTransaction(unavailable, administrator.token, async () => undefined),
      ).rejects.toMatchObject({ code: "identity_provider_unconfigured" });
      expect(connected).toBe(false);
    } finally {
      process.env.APP_ENV = previous;
    }
    await expect(assertStaffRole(pools.control, "estate_staff_issuer")).rejects.toMatchObject({
      code: "staff_database_role_unsafe",
    });
    await expect(assertStaffRole(pools.issuer, "estate_control")).rejects.toMatchObject({
      code: "staff_database_role_unsafe",
    });
  });
  it("returns redacted safe Problems for malformed and oversized JSON", async () => {
    for (const [payload, status] of [
      ["{PRIVATE_SYNTHETIC_BODY", 400],
      ["null", 400],
      [JSON.stringify({ identity: "administrator", marker: "x".repeat(270_000) }), 413],
    ] as const) {
      const response = await fetch(`${origin}/dev/staff/session`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: payload,
      });
      expect(response.status).toBe(status);
      const result = await response.text();
      expect(result).not.toContain("PRIVATE_SYNTHETIC_BODY");
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(JSON.parse(result)).toMatchObject({ status, traceId: expect.any(String) });
      expect(response.headers.get("content-type")).toBe("application/problem+json; charset=utf-8");
      validateSchema("Problem", JSON.parse(result), true);
    }
    const response = await fetch(`${origin}/dev/staff/session`, {
      method: "POST",
      headers: { Origin: "http://untrusted.example", "Content-Type": "application/json" },
      body: JSON.stringify({ identity: "administrator" }),
    });
    expect(response.status).toBe(403);
  });
  it("binds metadata cursors to current staff context and validates organizations before writes", async () => {
    const page = await request("/v1/platform/organizations?limit=1", "GET", undefined, administrator);
    expect(page.response.status).toBe(200);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.hasMore).toBe(true);
    expect(
      (
        await request(
          `/v1/platform/organizations?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`,
          "GET",
          undefined,
          support,
        )
      ).response.status,
    ).toBe(422);
    const next = await request(
      `/v1/platform/organizations?limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`,
      "GET",
      undefined,
      administrator,
    );
    expect(next.response.status).toBe(200);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    expect(
      (await request("/v1/platform/organizations?limit=101", "GET", undefined, administrator)).response
        .status,
    ).toBe(422);
    expect(
      (await request("/v1/platform/organizations?limit=1&limit=2", "GET", undefined, administrator)).response
        .status,
    ).toBe(422);
    for (const input of [
      { name: " ", timezone: "UTC" },
      { name: "Synthetic", timezone: "Invalid/Time" },
      { name: "Synthetic", timezone: "UTC", unexpected: true },
    ])
      expect(
        (await request("/v1/platform/organizations", "POST", input, administrator)).response.status,
      ).toBe(422);
  });
  it("uses expected real roles, staff-only identities and no Owner memberships", async () => {
    await assertStaffRole(pools.control, "estate_control");
    await assertStaffRole(pools.issuer, "estate_staff_issuer");
    expect(administrator.body).toMatchObject({
      staffUserId: fixtures.staffAdministratorUser,
      synthetic: true,
      supportContext: null,
    });
    expect(support.body.staffUserId).toBe(fixtures.staffSupportUser);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.membership WHERE user_id=ANY($1)", [
          [fixtures.staffAdministratorUser, fixtures.staffSupportUser],
        ])
      ).rows[0].count,
    ).toBe(0);
    expect((await request("/dev/staff/session", "POST", { identity: "owner" })).response.status).toBe(422);
    await expect(
      new StaffSessionIssuer(pools.issuer).issueVerifiedIdentity({
        issuer: "urn:estate:synthetic",
        subject: "owner",
        email: "owner@example.test",
        emailVerified: true,
        authenticatedAt: Date.now() / 1000,
      }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rejects member cookies, mixed identity, missing context, CSRF and forged forwarded access", async () => {
    expect((await request("/v1/platform/organizations")).response.status).toBe(401);
    const mixed = { ...administrator, cookie: `${administrator.cookie}; estate_session=${"0".repeat(64)}` };
    expect((await request("/v1/platform/organizations", "GET", undefined, mixed)).response.status).toBe(403);
    expect(
      (
        await request(
          "/v1/platform/organizations",
          "POST",
          { name: "Synthetic", timezone: "UTC" },
          { ...administrator, csrf: "invalid" },
        )
      ).response.status,
    ).toBe(403);
    const forwarded = await fetch(`${origin}/dev/staff/session`, {
      headers: { Cookie: administrator.cookie, "X-Forwarded-For": "127.0.0.1" },
    });
    expect(forwarded.status).toBe(403);
    expect(forwarded.headers.get("cache-control")).toContain("no-store");
    const absent = await pools.control.query("SELECT count(*)::int AS count FROM app.control_job");
    expect(absent.rows[0].count).toBe(0);
    const reused = await pools.control.query(
      "SELECT app.current_actor()AS actor,current_setting('app.staff_session_hash',true)AS token",
    );
    expect(reused.rows[0].actor).toBeNull();
    expect(reused.rows[0].token ?? "").toBe("");
  });
  it("allows support metadata but denies provisioning and jobs", async () => {
    expect((await request("/v1/platform/organizations", "GET", undefined, support)).response.status).toBe(
      200,
    );
    expect(
      (
        await request(
          "/v1/platform/organizations",
          "POST",
          { name: "No authority", timezone: "UTC" },
          support,
        )
      ).response.status,
    ).toBe(403);
    expect(
      (await request(`/dev/staff/jobs/${randomUUID()}`, "GET", undefined, support)).response.status,
    ).toBe(403);
  });
  it("concurrent exact command creates one pending organization, job and audit", async () => {
    const key = randomUUID(),
      input = { name: "Concurrent synthetic organization", timezone: "UTC" };
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request("/v1/platform/organizations", "POST", input, administrator, key),
      ),
    );
    expect(results.map((result) => result.response.status)).toEqual([202, 202, 202]);
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    const row = await jobRow(results[0].body.id);
    expect(row.state).toBe("queued");
    expect(row.claim_id).toBeNull();
    expect(
      (await admin.query("SELECT status FROM app.organization WHERE id=$1", [row.organization_id])).rows[0]
        .status,
    ).toBe("provisioning");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.audit_event WHERE resource_id=$1 AND action='organization.provisioning_queued'",
          [row.id],
        )
      ).rows[0].count,
    ).toBe(1);
    expect(
      (
        await request(
          "/v1/platform/organizations",
          "POST",
          { ...input, name: "Different" },
          administrator,
          key,
        )
      ).response.status,
    ).toBe(409);
  });
  it("activation commits exact defaults, non-staff Owner and one safe no-charge event", async () => {
    const job = await enqueue(),
      runKey = randomUUID();
    const run = await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, administrator, runKey);
    expect(run.response.status).toBe(202);
    expect(run.body.state).toBe("succeeded");
    const row = await jobRow(job.id),
      org = row.organization_id;
    expect((await admin.query("SELECT status FROM app.organization WHERE id=$1", [org])).rows[0].status).toBe(
      "active",
    );
    expect(
      (
        await admin.query("SELECT name FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY position", [org])
      ).rows.map((row) => row.name),
    ).toEqual(["Uncontacted", "Attempted Contact", "Nurturing", "Dead", "Under Contract", "Closed"]);
    expect(
      (
        await admin.query(
          "SELECT m.user_id,r.name FROM app.membership m JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ user_id: fixtures.ownerUser, name: "Owner" }]);
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM app.role_definition WHERE tenant_id=$1", [org]))
        .rows[0].count,
    ).toBe(6);
    expect(
      (
        await admin.query("SELECT feature,state FROM app.entitlement WHERE tenant_id=$1 ORDER BY feature", [
          org,
        ])
      ).rows,
    ).toEqual([
      { feature: "billing", state: "enabled" },
      { feature: "crm", state: "enabled" },
    ]);
    expect(
      (
        await admin.query(
          "SELECT provider,mode,state,safe_config FROM app.integration_connection WHERE tenant_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([
      {
        provider: "stripe",
        mode: "mock",
        state: "ready",
        safe_config: { synthetic: true, realCharges: false },
      },
    ]);
    const events = (await admin.query("SELECT payload FROM app.outbox WHERE tenant_id=$1", [org])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].payload.payload.safeCode).toBe("bootstrap_core_ready");
    expect(JSON.stringify(events)).not.toContain("owner@example.test");
    expect(
      (await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, administrator, runKey)).body.state,
    ).toBe("succeeded");
    expect((await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, administrator)).body.state).toBe(
      "succeeded",
    );
    expect((await jobRow(job.id)).attempt_count).toBe(1);
  });
  it("serializes concurrent claims and executes defaults only once", async () => {
    const job = await enqueue();
    const claims = await Promise.all(
      Array.from({ length: 3 }, () =>
        withStaffTransaction(pools.control, administrator.token, (client, staff) =>
          new ControlProvisioningService(client, staff, trace()).claim(job.id),
        ),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ProvisioningExecution(client, staff, { ...claim, traceId: trace() }).execute(),
    );
    expect((await jobRow(job.id)).attempt_count).toBe(1);
    await expect(
      withStaffTransaction(pools.control, administrator.token, (client, staff) =>
        new ProvisioningExecution(client, staff, { ...claim, traceId: trace() }).execute(),
      ),
    ).rejects.toMatchObject({ code: "provisioning_lease_lost" });
  });
  it("module failure rolls back every default; deliberate new-key retry succeeds", async () => {
    const job = await enqueue();
    const faulty: BootstrapPortFactory = {
      crm: (client, context) => ({
        seedDefaults: async (owner) => {
          await new CrmBootstrap(client, context).seedDefaults(owner);
          throw new Error("PRIVATE_SYNTHETIC_FAILURE_BODY");
        },
        verifyDefaults: async () => {},
      }),
      billing: (client, context) => new BillingBootstrap(client, context),
    };
    const failed = await runProvisioning(
      pools.control,
      administrator.token,
      job.id,
      "failure-attempt",
      trace(),
      faulty,
    );
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("provisioning_unavailable");
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_SYNTHETIC_FAILURE_BODY");
    const row = await jobRow(job.id);
    for (const table of [
      "membership",
      "role_definition",
      "business_profile",
      "pipeline_stage",
      "lead_source",
      "subscription",
      "entitlement",
      "outbox",
    ])
      expect(
        (
          await admin.query(`SELECT count(*)::int AS count FROM app.${table} WHERE tenant_id=$1`, [
            row.organization_id,
          ])
        ).rows[0].count,
      ).toBe(0);
    expect(
      (await admin.query("SELECT status FROM app.organization WHERE id=$1", [row.organization_id])).rows[0]
        .status,
    ).toBe("provisioning");
    expect(
      (await runProvisioning(pools.control, administrator.token, job.id, "failure-attempt", trace())).state,
    ).toBe("failed");
    expect(
      (await runProvisioning(pools.control, administrator.token, job.id, "retry-after-review", trace()))
        .state,
    ).toBe("succeeded");
    expect((await jobRow(job.id)).attempt_count).toBe(2);
  });
  it("durably binds the run key before execution and survives a crash after the failure commit", async () => {
    const job = await enqueue(),
      key = randomUUID(),
      route = `POST /dev/staff/jobs/${job.id}/run`;
    const prepared = await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).prepareRun(job.id, key),
    );
    const claim = prepared.claim!;
    const saved = (
      await admin.query(
        "SELECT response_body FROM app.control_idempotency WHERE staff_user_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.staffAdministratorUser, route, key],
      )
    ).rows[0].response_body;
    expect(saved.internalRunAttempt).toEqual({ claimId: claim.claimId, number: 1 });
    const faulty: BootstrapPortFactory = {
      crm: (client, context) => ({
        seedDefaults: async (owner) => {
          await new CrmBootstrap(client, context).seedDefaults(owner);
          throw new Error("intentional durable cut point");
        },
        verifyDefaults: async () => {},
      }),
      billing: (client, context) => new BillingBootstrap(client, context),
    };
    await expect(
      withStaffTransaction(pools.control, administrator.token, (client, staff) =>
        new ProvisioningExecution(client, staff, { ...claim, traceId: trace() }, faulty).execute(),
      ),
    ).rejects.toThrow("intentional durable cut point");
    await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).fail(
        job.id,
        claim.claimId,
        "provisioning_unavailable",
      ),
    );
    // Simulated crash here: no former terminal-response recording transaction executes.
    expect((await runProvisioning(pools.control, administrator.token, job.id, key, trace())).state).toBe(
      "failed",
    );
    const failed = await jobRow(job.id);
    expect(failed.attempt_count).toBe(1);
    for (const table of ["membership", "pipeline_stage", "outbox"])
      expect(
        (
          await admin.query(`SELECT count(*)::int AS count FROM app.${table} WHERE tenant_id=$1`, [
            claim.organizationId,
          ])
        ).rows[0].count,
      ).toBe(0);
    expect(
      (await runProvisioning(pools.control, administrator.token, job.id, randomUUID(), trace())).state,
    ).toBe("succeeded");
    expect((await jobRow(job.id)).attempt_count).toBe(2);
    // The original key remains a current read; it cannot create a third attempt after recovery either.
    expect((await runProvisioning(pools.control, administrator.token, job.id, key, trace())).state).toBe(
      "succeeded",
    );
    expect((await jobRow(job.id)).attempt_count).toBe(2);
  });
  it("a crash after a committed claim requires a new key for lease recovery", async () => {
    const job = await enqueue(),
      key = randomUUID();
    const prepared = await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).prepareRun(job.id, key),
    );
    expect(prepared.claim).not.toBeNull();
    await admin.query(
      "UPDATE app.control_job SET lease_until=clock_timestamp()-interval '1 second'WHERE id=$1",
      [job.id],
    );
    expect((await runProvisioning(pools.control, administrator.token, job.id, key, trace())).state).toBe(
      "running",
    );
    expect((await jobRow(job.id)).attempt_count).toBe(1);
    expect(
      (await runProvisioning(pools.control, administrator.token, job.id, randomUUID(), trace())).state,
    ).toBe("succeeded");
    expect((await jobRow(job.id)).attempt_count).toBe(2);
  });
  it("expired claim loses authority and safe takeover cannot be overwritten by old failure", async () => {
    const job = await enqueue();
    const old = (await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).claim(job.id),
    ))!;
    await admin.query(
      "UPDATE app.control_job SET lease_until=clock_timestamp()-interval '1 second'WHERE id=$1",
      [job.id],
    );
    await expect(
      withStaffTransaction(pools.control, administrator.token, (client, staff) =>
        new ProvisioningExecution(client, staff, { ...old, traceId: trace() }).execute(),
      ),
    ).rejects.toMatchObject({ code: "provisioning_lease_lost" });
    const next = (await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).claim(job.id),
    ))!;
    expect(next.claimId).not.toBe(old.claimId);
    const staleFail = await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).fail(
        job.id,
        old.claimId,
        "provisioning_unavailable",
      ),
    );
    expect(staleFail.state).toBe("running");
    await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ProvisioningExecution(client, staff, { ...next, traceId: trace() }).execute(),
    );
  });
  it("changed bootstrap owner version or verified flag denies execution", async () => {
    const job = await enqueue();
    const version = (
      await admin.query("SELECT row_version FROM app.user_identity WHERE id=$1", [fixtures.ownerUser])
    ).rows[0].row_version;
    try {
      await admin.query("UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1", [
        fixtures.ownerUser,
      ]);
      const result = await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, administrator);
      expect(result.body.state).toBe("failed");
      expect(result.body.error.code).toBe("bootstrap_policy_changed");
      await admin.query("UPDATE app.user_identity SET email_verified=false WHERE id=$1", [
        fixtures.ownerUser,
      ]);
      const create = await request(
        "/v1/platform/organizations",
        "POST",
        { name: "Unverified owner", timezone: "UTC" },
        administrator,
      );
      expect(create.response.status).toBe(409);
      expect(create.body.code).toBe("bootstrap_owner_unavailable");
    } finally {
      await admin.query("UPDATE app.user_identity SET email_verified=true,row_version=$2 WHERE id=$1", [
        fixtures.ownerUser,
        version,
      ]);
    }
  });
  it("replay and retained sessions recheck active principal and current provision permission", async () => {
    const key = randomUUID(),
      name = "Replay authority",
      job = await enqueue(key, name);
    const principal = (
      await admin.query("SELECT * FROM app.staff_principal WHERE user_id=$1", [
        fixtures.staffAdministratorUser,
      ])
    ).rows[0];
    try {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=array_remove(permission_codes,'platform.orgs.provision'),row_version=row_version+1 WHERE user_id=$1",
        [fixtures.staffAdministratorUser],
      );
      expect(
        (
          await request(
            "/v1/platform/organizations",
            "POST",
            { name, timezone: "Asia/Bangkok", locale: "en-US" },
            administrator,
            key,
          )
        ).response.status,
      ).toBe(403);
      expect(
        (await request(`/dev/staff/jobs/${job.id}`, "GET", undefined, administrator)).response.status,
      ).toBe(403);
      await admin.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [
        fixtures.staffAdministratorUser,
      ]);
      expect((await request("/dev/staff/session", "GET", undefined, administrator)).response.status).toBe(
        403,
      );
    } finally {
      await admin.query(
        "UPDATE app.staff_principal SET active=true,permission_codes=$2,row_version=$3 WHERE user_id=$1",
        [fixtures.staffAdministratorUser, principal.permission_codes, principal.row_version],
      );
    }
  });
  it("opaque session expiry and logout deny later reads", async () => {
    const transient = await login("administrator");
    expect((await request("/dev/staff/logout", "POST", {}, transient)).response.status).toBe(204);
    expect((await request("/dev/staff/session", "GET", undefined, transient)).response.status).toBe(401);
    const expired = await login("administrator");
    await admin.query(
      "UPDATE app.staff_session SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=encode(sha256($1::bytea),'hex')",
      [Buffer.from(expired.token)],
    );
    expect((await request("/dev/staff/session", "GET", undefined, expired)).response.status).toBe(401);
  });
  it("holds the approved owner SHARE lock through activation", async () => {
    const job = await enqueue();
    const claim = (await withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, trace()).claim(job.id),
    ))!;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      released = new Promise<void>((resolve) => {
        release = resolve;
      });
    const ports: BootstrapPortFactory = {
      crm: (client, context) => ({
        seedDefaults: async (owner) => {
          enter();
          await released;
          await new CrmBootstrap(client, context).seedDefaults(owner);
        },
        verifyDefaults: (owner) => new CrmBootstrap(client, context).verifyDefaults(owner),
      }),
      billing: (client, context) => new BillingBootstrap(client, context),
    };
    const execution = withStaffTransaction(pools.control, administrator.token, (client, staff) =>
      new ProvisioningExecution(client, staff, { ...claim, traceId: trace() }, ports).execute(),
    );
    await entered;
    const writer = await admin.connect();
    const pid = (await writer.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    let finished = false;
    const update = writer
      .query("UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1", [fixtures.ownerUser])
      .then(() => {
        finished = true;
      });
    try {
      let locked = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        locked = (
          await admin.query("SELECT wait_event_type='Lock'AS locked FROM pg_stat_activity WHERE pid=$1", [
            pid,
          ])
        ).rows[0]?.locked;
        if (locked) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(locked).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release();
    }
    try {
      expect((await execution).state).toBe("succeeded");
      await update;
      expect(finished).toBe(true);
    } finally {
      writer.release();
    }
  });
  it("full caller rollback removes queued Job, defaults, activation and event together", async () => {
    let org: string | undefined, jobId: string | undefined;
    await expect(
      withStaffTransaction(pools.control, administrator.token, async (client, staff) => {
        const service = new ControlProvisioningService(client, staff, trace());
        const job = await service.enqueue({ name: "Atomic caller rollback", timezone: "UTC" }, randomUUID());
        jobId = job.id;
        const claim = (await service.claim(job.id))!;
        org = claim.organizationId;
        await new ProvisioningExecution(client, staff, { ...claim, traceId: trace() }).execute();
        throw new Error("intentional caller rollback");
      }),
    ).rejects.toThrow("intentional caller rollback");
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM app.organization WHERE id=$1", [org])).rows[0]
        .count,
    ).toBe(0);
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM app.control_job WHERE id=$1", [jobId])).rows[0]
        .count,
    ).toBe(0);
    for (const table of ["membership", "pipeline_stage", "outbox", "audit_event"])
      expect(
        (await admin.query(`SELECT count(*)::int AS count FROM app.${table} WHERE tenant_id=$1`, [org]))
          .rows[0].count,
      ).toBe(0);
  });
  it("health metadata permission never broadens requester Job access or replay", async () => {
    const job = await enqueue();
    const principal = (
      await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
        fixtures.staffSupportUser,
      ])
    ).rows[0];
    try {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=array_append(permission_codes,'platform.orgs.provision'),row_version=row_version+1 WHERE user_id=$1",
        [fixtures.staffSupportUser],
      );
      expect((await request(`/dev/staff/jobs/${job.id}`, "GET", undefined, support)).response.status).toBe(
        404,
      );
      expect((await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, support)).response.status).toBe(404);
      await withStaffTransaction(pools.control, support.token, async (client) => {
        expect((await client.query("SELECT id FROM app.control_job WHERE id=$1", [job.id])).rowCount).toBe(1);
      });
    } finally {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=$2,row_version=$3 WHERE user_id=$1",
        [fixtures.staffSupportUser, principal.permission_codes, principal.row_version],
      );
    }
  });
  it("control cannot mint sessions, modify identity, or use seed authority after activation", async () => {
    await expect(
      pools.control.query(
        "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,expires_at)VALUES($1,$2,$1,'synthetic-local',clock_timestamp()+interval '1 hour')",
        ["a".repeat(64), fixtures.staffAdministratorUser],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(pools.issuer.query("SELECT id FROM app.organization")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pools.control.query("SELECT email FROM app.user_identity")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      withStaffTransaction(pools.control, administrator.token, async (client) => {
        await client.query(
          "SELECT set_config('app.auth_issuer','urn:estate:synthetic',true),set_config('app.auth_subject','owner',true)",
        );
        const rows = await client.query("SELECT id FROM app.user_identity");
        expect(rows.rows.map((row) => row.id)).toEqual([fixtures.ownerUser]);
        await client.query("UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1", [
          fixtures.ownerUser,
        ]);
      }),
    ).rejects.toMatchObject({ code: "42501" });
    const job = await enqueue();
    await request(`/dev/staff/jobs/${job.id}/run`, "POST", {}, administrator);
    const row = await jobRow(job.id);
    await withStaffTransaction(pools.control, administrator.token, async (client) => {
      await client.query(
        "SELECT set_config('app.tenant_id',$1,true),set_config('app.provision_claim',$2,true)",
        [row.organization_id, row.claim_id],
      );
      expect(
        (await client.query("SELECT app.control_can_seed($1)AS allowed", [row.organization_id])).rows[0]
          .allowed,
      ).toBe(false);
      expect(
        (await client.query("SELECT id FROM app.membership WHERE tenant_id=$1", [row.organization_id]))
          .rowCount,
      ).toBe(0);
    });
  });
});
