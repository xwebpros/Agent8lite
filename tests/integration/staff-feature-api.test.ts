import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import staffSchema from "../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import type { SyntheticStaffSessionResponse } from "../../packages/contracts/internal/control-plane-port";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"] as const) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Run registered staff acceptance through the disposable isolated batch runner.");
}
const admin = createMigrationPool();
const locks = createMigrationPool();
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema(staffSchema);
const staffResponse = ajv.compile({ $ref: `${staffSchema.$id}#/$defs/SessionResponse` });
const webOrigin = process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000";
let administrator: StaffSession;
let support: StaffSession;
let member: ApiSession;

class StaffSession {
  cookie = "";
  csrf = "";
  body!: SyntheticStaffSessionResponse;

  request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("origin")) headers.set("origin", webOrigin);
    if (this.cookie && !headers.has("cookie")) headers.set("cookie", this.cookie);
    return fetch(`${apiOrigin}${path}`, { ...init, headers });
  }

  command(path: string, body: unknown, options: { key?: string; csrf?: string } = {}) {
    return this.request(path, {
      method: "POST",
      headers: {
        "idempotency-key": options.key ?? randomUUID(),
        "x-csrf-token": options.csrf ?? this.csrf,
      },
      body: JSON.stringify(body),
    });
  }

  async signIn(identity: "administrator" | "support") {
    const response = await this.request("/dev/staff/session", {
      method: "POST",
      body: JSON.stringify({ identity }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    this.cookie = cookie.split(";")[0];
    expect(this.cookie).toMatch(/^estate_staff_session=[a-f0-9]{64}$/);
    this.csrf = response.headers.get("x-csrf-token") ?? "";
    expect(this.csrf).toMatch(/^[a-f0-9]{64}$/);
    const body: unknown = await response.json();
    expect(staffResponse(body), JSON.stringify(staffResponse.errors)).toBe(true);
    this.body = body as SyntheticStaffSessionResponse;
    return this;
  }
}

async function job(response: Response, status = 202) {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  assertContract("Job", body);
  return body;
}
const organizationInput = (): Schemas["OrganizationCreate"] => ({
  name: `Synthetic registered organization ${randomUUID()}`,
  timezone: "America/Los_Angeles",
  locale: "en-US",
});
const enqueue = async () =>
  job(await administrator.command("/v1/platform/organizations", organizationInput()));

beforeAll(async () => {
  administrator = await new StaffSession().signIn("administrator");
  support = await new StaffSession().signIn("support");
  member = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  await locks.end();
  await admin.end();
});

describe("registered synthetic staff identity and provisioning", () => {
  it("returns a separate private staff session without creating tenant Owner authority", async () => {
    expect(administrator.body).toMatchObject({
      staffUserId: fixtures.staffAdministratorUser,
      synthetic: true,
      supportContext: null,
    });
    expect(support.body.staffUserId).toBe(fixtures.staffSupportUser);
    expect(Object.keys(administrator.body).sort()).toEqual([
      "permissions",
      "staffUserId",
      "supportContext",
      "synthetic",
    ]);
    const response = await administrator.request("/dev/staff/session");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-csrf-token")).toBe(administrator.csrf);
    expect(await response.json()).toEqual(administrator.body);
    const memberships = await admin.query(
      "SELECT count(*)::int AS count FROM app.membership WHERE user_id=ANY($1)",
      [[fixtures.staffAdministratorUser, fixtures.staffSupportUser]],
    );
    expect(memberships.rows[0].count).toBe(0);
    await assertProblem(await new StaffSession().command("/dev/staff/session", { identity: "owner" }), 422);
  });

  it("rejects raw mixed cookies reciprocally and prevents either identity from substituting for the other", async () => {
    const mixed = `${member.cookie}; ${administrator.cookie}`;
    for (const path of ["/v1/session", "/dev/staff/session", "/v1/platform/organizations"])
      expect(
        await assertProblem(
          await fetch(`${apiOrigin}${path}`, { headers: { cookie: mixed, origin: webOrigin } }),
          403,
        ),
      ).toMatchObject({ code: "identity_context_ambiguous" });
    await assertProblem(await administrator.request("/v1/session"), 401);
    await assertProblem(await member.request("/dev/staff/session"), 401);
    await assertProblem(await member.request("/v1/platform/organizations"), 401);
    await assertProblem(await administrator.request(`/v1/orgs/${member.orgId}/contacts`), 401);
    await assertProblem(
      await administrator.request("/dev/staff/session", {
        headers: { cookie: `${administrator.cookie}; ${administrator.cookie}` },
      }),
      401,
    );
  });

  it("retains registered CSRF, trusted Origin, direct loopback and private Problem responses", async () => {
    const input = organizationInput();
    expect(
      await assertProblem(
        await administrator.command("/v1/platform/organizations", input, { csrf: "invalid" }),
        403,
      ),
    ).toMatchObject({ code: "csrf_invalid" });
    const invalidHeaders: Record<string, string>[] = [
      { origin: "https://unapproved.example" },
      { "x-forwarded-for": "127.0.0.1" },
      { forwarded: "for=127.0.0.1" },
    ];
    for (const headers of invalidHeaders) {
      const response = await administrator.request("/v1/platform/organizations", {
        method: "POST",
        headers: {
          "idempotency-key": randomUUID(),
          "x-csrf-token": administrator.csrf,
          ...headers,
        },
        body: JSON.stringify(input),
      });
      await assertProblem(response, 403);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    expect((await admin.query("SELECT count(*)::int AS count FROM app.control_job")).rows[0].count).toBe(0);
  });

  it("parses bounded raw staff JSON before the root JSON parser without exposing malformed content", async () => {
    for (const [body, status] of [
      ["{PRIVATE_REGISTERED_TEST_BODY", 400],
      ["null", 400],
      [JSON.stringify({ identity: "administrator", marker: "x".repeat(270_000) }), 413],
    ] as const) {
      const response = await new StaffSession().request("/dev/staff/session", { method: "POST", body });
      const problem = await assertProblem(response, status);
      expect(JSON.stringify(problem)).not.toContain("PRIVATE_REGISTERED_TEST_BODY");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    await assertProblem(
      await administrator.request("/v1/platform/organizations", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "PRIVATE_REGISTERED_TEST_BODY",
      }),
      415,
    );
  });

  it("creates one queued Job then explicitly commits core defaults, a normal Owner and no-charge billing", async () => {
    const key = randomUUID();
    const input = organizationInput();
    const pending = await job(await administrator.command("/v1/platform/organizations", input, { key }));
    expect(pending.state).toBe("queued");
    expect(pending.resultUrl).toBeNull();
    expect(await job(await administrator.command("/v1/platform/organizations", input, { key }))).toEqual(
      pending,
    );
    await assertProblem(
      await administrator.command("/v1/platform/organizations", { ...input, name: "Changed input" }, { key }),
      409,
    );
    const queued = (await admin.query("SELECT * FROM app.control_job WHERE id=$1", [pending.id])).rows[0];
    expect(
      (await admin.query("SELECT status FROM app.organization WHERE id=$1", [queued.organization_id])).rows[0]
        .status,
    ).toBe("provisioning");
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.membership WHERE tenant_id=$1", [
          queued.organization_id,
        ])
      ).rows[0].count,
    ).toBe(0);
    const runKey = randomUUID();
    const completed = await job(
      await administrator.command(`/dev/staff/jobs/${pending.id}/run`, {}, { key: runKey }),
    );
    expect(completed.state).toBe("succeeded");
    expect(
      await job(await administrator.command(`/dev/staff/jobs/${pending.id}/run`, {}, { key: runKey })),
    ).toEqual(completed);
    expect(await job(await administrator.request(`/dev/staff/jobs/${pending.id}`), 200)).toEqual(completed);
    const org = queued.organization_id;
    expect((await admin.query("SELECT status FROM app.organization WHERE id=$1", [org])).rows[0].status).toBe(
      "active",
    );
    expect(
      (await admin.query("SELECT attempt_count FROM app.control_job WHERE id=$1", [pending.id])).rows[0]
        .attempt_count,
    ).toBe(1);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.role_definition WHERE tenant_id=$1 AND builtin",
          [org],
        )
      ).rows[0].count,
    ).toBe(6);
    expect(
      (
        await admin.query("SELECT name FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY position", [org])
      ).rows.map((row) => row.name),
    ).toEqual(["Uncontacted", "Attempted Contact", "Nurturing", "Dead", "Under Contract", "Closed"]);
    expect(
      (
        await admin.query(
          "SELECT m.user_id,r.name FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id) WHERE m.tenant_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([{ user_id: fixtures.ownerUser, name: "Owner" }]);
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
          "SELECT provider,mode,safe_config,secret_ref FROM app.integration_connection WHERE tenant_id=$1",
          [org],
        )
      ).rows,
    ).toEqual([
      {
        provider: "stripe",
        mode: "mock",
        safe_config: { synthetic: true, realCharges: false },
        secret_ref: null,
      },
    ]);
    const outbox = await admin.query("SELECT payload FROM app.outbox WHERE tenant_id=$1", [org]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].payload.payload.safeCode).toBe("bootstrap_core_ready");
    const audit = await admin.query("SELECT action FROM app.audit_event WHERE tenant_id=$1 ORDER BY action", [
      org,
    ]);
    expect(audit.rows.map((row) => row.action)).toEqual([
      "organization.provisioned",
      "organization.provisioning_claimed",
      "organization.provisioning_queued",
    ]);
    expect(JSON.stringify(outbox.rows)).not.toMatch(/owner@example|csrf|token_hash|PRIVATE_REGISTERED/);
    const normalOwner = await new ApiSession().signIn("owner");
    expect(normalOwner.session.organizations.map((organization) => organization.id)).toContain(org);
    expect((await normalOwner.switchOrganization(org)).status).toBe(200);
    expect(
      (await normalOwner.read(`/v1/orgs/${org}/pipeline-stages`, "PagePipelineStage")).body.items,
    ).toHaveLength(6);
  });

  it("allows Support metadata while denying provisioning and requester Job access", async () => {
    const response = await support.request("/v1/platform/organizations");
    expect(response.status).toBe(200);
    const page = await response.json();
    assertContract("PageOrganization", page);
    await assertProblem(await support.command("/v1/platform/organizations", organizationInput()), 403);
    const queued = await enqueue();
    await assertProblem(await support.request(`/dev/staff/jobs/${queued.id}`), 403);
    const original = (
      await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
        fixtures.staffSupportUser,
      ])
    ).rows[0];
    try {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=array_append(permission_codes,'platform.orgs.provision'),row_version=row_version+1 WHERE user_id=$1",
        [fixtures.staffSupportUser],
      );
      await assertProblem(await support.request(`/dev/staff/jobs/${queued.id}`), 404);
      await assertProblem(await support.command(`/dev/staff/jobs/${queued.id}/run`, {}), 404);
    } finally {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=$2,row_version=$3 WHERE user_id=$1",
        [fixtures.staffSupportUser, original.permission_codes, original.row_version],
      );
    }
  });

  it("denies retained-session and command replay after current staff permission or principal revocation", async () => {
    const key = randomUUID();
    const input = organizationInput();
    const queued = await job(await administrator.command("/v1/platform/organizations", input, { key }));
    const original = (
      await admin.query("SELECT permission_codes,row_version FROM app.staff_principal WHERE user_id=$1", [
        fixtures.staffAdministratorUser,
      ])
    ).rows[0];
    try {
      await admin.query(
        "UPDATE app.staff_principal SET permission_codes=array_remove(permission_codes,'platform.orgs.provision'),row_version=row_version+1 WHERE user_id=$1",
        [fixtures.staffAdministratorUser],
      );
      await assertProblem(await administrator.command("/v1/platform/organizations", input, { key }), 403);
      await assertProblem(await administrator.command(`/dev/staff/jobs/${queued.id}/run`, {}), 403);
      await admin.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [
        fixtures.staffAdministratorUser,
      ]);
      await assertProblem(await administrator.request("/dev/staff/session"), 403);
    } finally {
      await admin.query(
        "UPDATE app.staff_principal SET active=true,permission_codes=$2,row_version=$3 WHERE user_id=$1",
        [fixtures.staffAdministratorUser, original.permission_codes, original.row_version],
      );
    }
    expect(
      (await admin.query("SELECT state,attempt_count FROM app.control_job WHERE id=$1", [queued.id])).rows[0],
    ).toEqual({ state: "queued", attempt_count: 0 });
  });

  it("rolls back a blocked provisioning enqueue after its staff session expires", async () => {
    const transient = await new StaffSession().signIn("administrator");
    const tokenHash = createHash("sha256").update(transient.cookie.split("=")[1]).digest("hex");
    const name = `Synthetic expiry ${randomUUID()}`;
    const blocker = await locks.connect();
    let pending: Promise<Response> | undefined;
    let released = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.user_identity WHERE id=$1 FOR UPDATE", [fixtures.ownerUser]);
      await admin.query(
        "UPDATE app.staff_session SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",
        [tokenHash],
      );
      pending = transient.command("/v1/platform/organizations", { name, timezone: "UTC" });
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (!blocked && Date.now() < deadline) {
        const state = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='estate_control' AND wait_event_type='Lock' AND query LIKE '%FROM app.user_identity%'",
        );
        blocked = Boolean(state.rowCount);
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      let expired = false;
      while (!expired && Date.now() < deadline) {
        expired = (
          await admin.query(
            "SELECT expires_at<=clock_timestamp() AS expired FROM app.staff_session WHERE token_hash=$1",
            [tokenHash],
          )
        ).rows[0].expired;
        if (!expired) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(expired).toBe(true);
      await blocker.query("ROLLBACK");
      released = true;
      const response = await pending;
      expect([401, 403, 409, 503]).toContain(response.status);
      await assertProblem(response, response.status);
      expect(
        (await admin.query("SELECT count(*)::int AS count FROM app.organization WHERE name=$1", [name]))
          .rows[0].count,
      ).toBe(0);
      await assertProblem(await transient.request("/dev/staff/session"), 401);
    } finally {
      if (!released) await blocker.query("ROLLBACK");
      await pending?.then((response) => (response.bodyUsed ? undefined : response.body?.cancel()));
      blocker.release();
    }
  });

  it("enforces the unchanged 300-read limit with a stable selected staff cookie", async () => {
    const limited = await new StaffSession().signIn("support");
    const responses: Response[] = [];
    for (let offset = 0; offset < 301; offset += 25)
      responses.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, 301 - offset) }, () => limited.request("/dev/staff/session")),
        )),
      );
    // Earlier permitted Support reads consume the same principal bucket; the maximum stays 300.
    expect(responses.filter((response) => response.status === 200).length).toBeGreaterThan(0);
    expect(responses.filter((response) => response.status === 200).length).toBeLessThanOrEqual(300);
    expect(responses.every((response) => [200, 429].includes(response.status))).toBe(true);
    const denied = responses.filter((response) => response.status === 429);
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0].headers.get("retry-after")).toBe("60");
    expect(await assertProblem(denied[0], 429)).toMatchObject({ code: "rate_limited" });
    await Promise.all(
      responses.filter((response) => !response.bodyUsed).map((response) => response.arrayBuffer()),
    );
  });

  it("keeps the same rate bucket when unrelated cookie content changes", async () => {
    const limited = await new StaffSession().signIn("support");
    const responses: Response[] = [];
    for (let offset = 0; offset < 301; offset += 25)
      responses.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(25, 301 - offset) }, (_, index) =>
            limited.request("/dev/staff/session", {
              headers: { cookie: `unrelated=${offset + index}; ${limited.cookie}` },
            }),
          ),
        )),
      );
    // A new session for the same principal and arbitrary extra cookies must not reset the limit.
    expect(responses.filter((response) => response.status === 200)).toHaveLength(0);
    const denied = responses.filter((response) => response.status === 429);
    expect(denied).toHaveLength(301);
    expect(await assertProblem(denied[0], 429)).toMatchObject({ code: "rate_limited" });
    await Promise.all(
      responses.filter((response) => !response.bodyUsed).map((response) => response.arrayBuffer()),
    );
  });
});
