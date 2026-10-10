import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService } from "../../apps/api/src/crm-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const target = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(target.pathname)
  )
    throw new Error("Dashboard acceptance requires its owned disposable isolated batch.");
}
const applicationName = "dashboard_report_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: applicationName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 3 });
const ownerIdentity = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const agentIdentity = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
let owner: ApiSession, agent: ApiSession, otherOrg: ApiSession;
const sessions: ApiSession[] = [];
let leadId: string, contactId: string, monthStart: string;
const endpoint = (session: ApiSession = owner) => "/v1/orgs/" + session.orgId + "/dashboard";
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}
async function read(session: ApiSession = owner) {
  const response = await session.request(endpoint(session));
  privateResponse(response);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  assertContract("Dashboard", body);
  return body;
}
async function denied(response: Response, status: number, code?: string) {
  privateResponse(response);
  const body = await assertProblem(response, status);
  if (code) expect(body.code).toBe(code);
}
function measured(report: Schemas["Dashboard"]) {
  const metric = report.metrics.find((item) => item.key === "leads.created")!;
  expect(metric).toMatchObject({
    definitionVersion: 2,
    unit: "leads",
    source: "crm-own-utc-month-query-v2",
    state: "available",
  });
  expect(metric.refreshedAt! >= report.period.to).toBe(true);
  expect(metric.denominator).toBeUndefined();
  expect(Number.isSafeInteger(metric.value)).toBe(true);
  return metric.value as number;
}
async function source(
  options: { member?: string | null; tenant?: string; createdAt?: string; archived?: boolean } = {},
) {
  const tenant = options.tenant ?? fixtures.orgA;
  const index = tenant === fixtures.orgA ? 1 : 2;
  const member = options.member === undefined ? fixtures.ownerMemberA : options.member;
  const contact = randomUUID(),
    lead = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Owned synthetic report source',$3)",
    [tenant, contact, member],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,created_at,archived_at)VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN clock_timestamp() END)",
    [
      tenant,
      lead,
      contact,
      index === 1 ? fixtures.sourceA : fixtures.sourceB,
      stageId(index, 1),
      member,
      options.createdAt ?? monthStart,
      options.archived ?? false,
    ],
  );
  return { lead, contact };
}
async function reference(
  report: Schemas["Dashboard"],
  member: string = fixtures.ownerMemberA,
  scope: PermissionGrant["scope"] = "organization",
  tenant: string = fixtures.orgA,
) {
  // This independent source oracle uses the actual returned period and the frozen existing scope semantics.
  const result = await admin.query(
    "SELECT count(*)::int total FROM app.lead r WHERE r.tenant_id=$1 AND r.archived_at IS NULL AND r.owner_member_id=$2 AND r.created_at BETWEEN $3::timestamptz AND $4::timestamptz AND($5::text<>'team' OR EXISTS(SELECT 1 FROM app.office_member target JOIN app.office_member mine ON mine.tenant_id=target.tenant_id AND mine.office_id=target.office_id WHERE target.tenant_id=$1 AND target.member_id=r.owner_member_id AND mine.member_id=$2))",
    [tenant, member, report.period.from, report.period.to, scope],
  );
  expect(measured(report)).toBe(result.rows[0].total);
}
async function direct<T>(
  operation: (client: PoolClient, context: TenantContext) => Promise<T>,
  identity: VerifiedIdentityContext = ownerIdentity,
  lockMembership = true,
) {
  return withTenantTransaction(runtime, identity, operation, { lockMembership });
}
async function reportDirect(identity: VerifiedIdentityContext = ownerIdentity) {
  return direct((client, context) => new CrmService(client, context, randomUUID()).dashboard({}), identity);
}
async function role<T>(
  operation: () => Promise<T>,
  options: { remove?: string[]; leadScope?: PermissionGrant["scope"]; member?: string } = {},
) {
  const row = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, options.member ?? fixtures.ownerMemberA],
    )
  ).rows[0];
  const original = row.permission_grants as PermissionGrant[];
  const next = original
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) => (g.code === "crm.leads.read" && options.leadScope ? { ...g, scope: options.leadScope } : g));
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      row.id,
      JSON.stringify(next),
    ]);
    return await operation();
  } finally {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      row.id,
      JSON.stringify(original),
    ]);
  }
}
async function capability<T>(state: string, until: string | null, operation: () => Promise<T>) {
  const original = (
    await admin.query(
      "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    )
  ).rows[0];
  try {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=$3 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, state, until],
    );
    return await operation();
  } finally {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=$3 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, original.state, original.effective_until],
    );
  }
}
async function waitForLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
          [applicationName],
        )
      ).rows[0].waiting
    )
      return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("Owned reporting transaction did not observe the expected database lock wait.");
}
function getBody(body: string, contentType: string, chunked = false): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      cookie: owner.cookie,
      origin: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
      "content-type": contentType,
    };
    if (chunked) headers["transfer-encoding"] = "chunked";
    else headers["content-length"] = Buffer.byteLength(body);
    const request = httpRequest(
      new URL(endpoint(), apiOrigin),
      { method: "GET", headers, timeout: 5000 },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65536) request.destroy(new Error("Owned reporting response exceeded bound."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const resultHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value !== undefined) resultHeaders.set(key, Array.isArray(value) ? value.join(",") : value);
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), {
              status: response.statusCode,
              headers: resultHeaders,
            }),
          );
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Owned reporting request timed out.")));
    request.end(body);
  });
}
beforeAll(async () => {
  await assertRuntimeRole(runtime);
  owner = await new ApiSession().signIn();
  agent = await new ApiSession().signIn("agent");
  otherOrg = await new ApiSession().signIn();
  sessions.push(owner, agent, otherOrg);
  expect((await otherOrg.switchOrganization(fixtures.orgB)).status).toBe(200);
  monthStart = (
    await admin.query(
      "SELECT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS instant",
    )
  ).rows[0].instant.toISOString();
  const own = await source();
  leadId = own.lead;
  contactId = own.contact;
  await source({ member: fixtures.agentMemberA });
  await source({ member: null });
  await source({ archived: true });
  await source({ createdAt: "2000-01-01T00:00:00.000Z" });
  await source({ tenant: fixtures.orgB, member: fixtures.ownerMemberB });
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("registered UTC default-member measured report", () => {
  it("reconciles the exact returned period and current-own predicate under organization and own lead grants", async () => {
    for (const scope of ["organization", "own"] as const)
      await role(
        async () => {
          const report = await read();
          await reference(report, fixtures.ownerMemberA, scope);
          expect(report.period).toMatchObject({ from: monthStart, timezone: "UTC" });
          expect(report.period.to).toMatch(/\.\d{3}Z$/);
          expect(measured(report)).toBe(1);
          expect(report.metrics.find((m) => m.key === "revenue")).toEqual({
            key: "revenue",
            definitionVersion: 1,
            unit: "USD",
            source: "billing-unconfigured",
            value: null,
            refreshedAt: null,
            state: "unavailable",
          });
        },
        { leadScope: scope },
      );
  });
  it("isolates the agent and second organization without the owner borrowing their counts", async () => {
    await reference(await read(agent), fixtures.agentMemberA, "own");
    await reference(await read(otherOrg), fixtures.ownerMemberB, "organization", fixtures.orgB);
    await denied(await owner.request("/v1/orgs/" + fixtures.orgB + "/dashboard"), 403);
    await denied(await new ApiSession().request(endpoint()), 401);
  });
  it("measures valid zero for an empty current period and restores it after a source change", async () => {
    await admin.query("UPDATE app.lead SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      leadId,
    ]);
    try {
      const report = await read();
      expect(measured(report)).toBe(0);
      await reference(report);
    } finally {
      await admin.query("UPDATE app.lead SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
      ]);
    }
    expect(measured(await read())).toBe(1);
  });
  it("does not invent a contact-archive exclusion or an immutable historical owner cohort", async () => {
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      contactId,
    ]);
    try {
      expect(measured(await read())).toBe(1);
    } finally {
      await admin.query("UPDATE app.contact SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        contactId,
      ]);
    }
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      leadId,
      fixtures.agentMemberA,
    ]);
    try {
      expect(measured(await read())).toBe(0);
    } finally {
      await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        leadId,
        fixtures.ownerMemberA,
      ]);
    }
  });
  it("intersects team source scope with current own office eligibility and never adds the teammate", async () => {
    await role(
      async () => {
        const empty = await read();
        expect(measured(empty)).toBe(0);
        await reference(empty, fixtures.ownerMemberA, "team");
        const office = randomUUID();
        await admin.query("INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'UTC')", [
          fixtures.orgA,
          office,
          "Owned dashboard office " + office,
        ]);
        await admin.query(
          "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
          [fixtures.orgA, office, fixtures.ownerMemberA, fixtures.agentMemberA],
        );
        try {
          const report = await read();
          expect(measured(report)).toBe(1);
          await reference(report, fixtures.ownerMemberA, "team");
        } finally {
          await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
            fixtures.orgA,
            office,
          ]);
        }
      },
      { leadScope: "team" },
    );
  });
  it("uses actual database millisecond bounds including exact endpoints and excluding a source one microsecond after to", async () => {
    const inserted: string[] = [];
    const report = await direct(async (client, context) => {
      const wrapped = Object.create(client) as PoolClient;
      wrapped.query = (async (...args: unknown[]) => {
        const result = await (client.query as (...values: unknown[]) => Promise<QueryResult>)(...args);
        if (typeof args[0] === "string" && args[0].includes(" AS captured_at")) {
          const actual = result.rows[0].captured_at as Date;
          const to = actual.toISOString(),
            from = new Date(Date.UTC(actual.getUTCFullYear(), actual.getUTCMonth(), 1)).toISOString();
          for (const createdAt of [from, to, to.replace("Z", "001Z")])
            inserted.push((await source({ createdAt })).lead);
        }
        return result;
      }) as PoolClient["query"];
      return new CrmService(wrapped, context, randomUUID()).dashboard({});
    });
    try {
      await reference(report);
      expect(measured(report)).toBe(3);
    } finally {
      await admin.query(
        "UPDATE app.lead SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
        [fixtures.orgA, inserted],
      );
    }
  });
  it("denies absent dashboard/lead grants and expired or disabled CRM capability rather than measuring zero", async () => {
    for (const permission of ["dashboard.read", "crm.leads.read"])
      await role(async () => denied(await owner.request(endpoint()), 403), { remove: [permission] });
    for (const [state, until] of [
      ["disabled", null],
      ["enabled", "2000-01-01T00:00:00.000Z"],
    ] as const)
      await capability(state, until, async () =>
        denied(await owner.request(endpoint()), 403, "entitlement_disabled"),
      );
  });
  it("retains source-aware own tasks and permits a reporting-only role with no task-read grant", async () => {
    const hidden = await source({ member: fixtures.agentMemberA }),
      ownTask = randomUUID(),
      hiddenTask = randomUUID(),
      standalone = randomUUID();
    for (const [id, linked] of [
      [ownTask, leadId],
      [hiddenTask, hidden.lead],
      [standalone, null],
    ])
      await admin.query(
        "INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,due_at,due_timezone,priority,state)VALUES($1,$2,$3,$4,'Synthetic report task',clock_timestamp(),'UTC','normal','open')",
        [fixtures.orgA, id, linked, fixtures.ownerMemberA],
      );
    await role(
      async () => {
        const report = await read();
        expect(report.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([ownTask, standalone]));
        expect(report.tasks.some((t) => t.id === hiddenTask)).toBe(false);
      },
      { leadScope: "own" },
    );
    await role(
      async () => {
        const report = await read();
        expect(report.tasks).toEqual([]);
        await reference(report);
      },
      { remove: ["crm.tasks.read"] },
    );
  });
  it("requires active membership and organization on every fresh read", async () => {
    for (const [table, column, disabled, enabled, id] of [
      ["membership", "status", "disabled", "active", fixtures.ownerMemberA],
      ["organization", "status", "suspended", "active", fixtures.orgA],
    ]) {
      await admin.query("UPDATE app." + table + " SET " + column + "=$2 WHERE id=$1", [id, disabled]);
      try {
        await denied(await owner.request(endpoint()), 403);
      } finally {
        await admin.query("UPDATE app." + table + " SET " + column + "=$2 WHERE id=$1", [id, enabled]);
      }
    }
  });
  it("denies missing/foreign/forged supplied runtime context and cleans transaction context on pool reuse", async () => {
    const captured = await direct(async (_client, context) => context);
    const client = await runtime.connect();
    try {
      await expect(new CrmService(client, captured, randomUUID()).dashboard({})).rejects.toMatchObject({
        status: 403,
      });
    } finally {
      client.release();
    }
    for (const patch of [
      { memberId: fixtures.agentMemberA },
      { userId: fixtures.agentUser },
      { organizationId: fixtures.orgB },
      { roleId: randomUUID() },
      { permissions: [] },
      { timezone: "__forged__" },
    ])
      await direct(async (current, context) => {
        await expect(
          new CrmService(current, { ...context, ...patch }, randomUUID()).dashboard({}),
        ).rejects.toMatchObject({ status: 403 });
      });
    await expect(
      reportDirect({ userId: fixtures.agentUser, organizationId: fixtures.orgB }),
    ).rejects.toMatchObject({ status: 403 });
    await reference(await reportDirect());
    await reference(await reportDirect(agentIdentity), fixtures.agentMemberA, "own");
  });
  it("does not borrow a stale role snapshot after a current grant revocation", async () => {
    const captured = await direct(async (_client, context) => context);
    await role(
      async () =>
        direct(async (client) => {
          await expect(new CrmService(client, captured, randomUUID()).dashboard({})).rejects.toMatchObject({
            status: 403,
          });
        }),
      { remove: ["crm.leads.read"] },
    );
  });
  it("denies CRM expiry after an observed real membership lock wait", async () => {
    await capability("enabled", null, async () => {
      await admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '400 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      );
      const blocker = await admin.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          fixtures.ownerMemberA,
        ]);
        pending = reportDirect();
        await waitForLock();
        await admin.query("SELECT pg_sleep(0.55)");
        await blocker.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await pending?.catch(() => undefined);
      }
    });
  });
  it("rechecks own team-office eligibility after waiting for the actor office lock", async () => {
    const office = randomUUID();
    await admin.query("INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'UTC')", [
      fixtures.orgA,
      office,
      "Owned waited reporting office " + office,
    ]);
    await admin.query("INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)", [
      fixtures.orgA,
      office,
      fixtures.ownerMemberA,
    ]);
    await role(
      async () => {
        const blocker = await admin.connect();
        let pending: Promise<Schemas["Dashboard"]> | undefined;
        try {
          await blocker.query("BEGIN");
          await blocker.query(
            "SELECT member_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 FOR UPDATE",
            [fixtures.orgA, office],
          );
          pending = reportDirect();
          await waitForLock();
          await blocker.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
            fixtures.orgA,
            office,
          ]);
          await blocker.query("COMMIT");
          const report = await pending;
          expect(measured(report)).toBe(0);
          await reference(report, fixtures.ownerMemberA, "team");
        } finally {
          await blocker.query("ROLLBACK").catch(() => undefined);
          blocker.release();
          await pending?.catch(() => undefined);
        }
      },
      { leadScope: "team" },
    );
  });
  it("rejects every undeclared query and all body encodings without silently selecting another scope", async () => {
    for (const query of [
      "?scope=organization",
      "?ownerMemberId=" + fixtures.agentMemberA,
      "?from=" + monthStart,
      "?to=" + monthStart,
      "?limit=1",
      "?x=",
      "?scope=own&scope=organization",
      "?scope[]=own",
    ])
      await denied(await owner.request(endpoint() + query), 422, "query_invalid");
    for (const [body, type, chunked] of [
      ["{}", "application/json", false],
      ["synthetic", "text/plain", false],
      ["", "text/plain", true],
      ["synthetic", "text/plain", true],
    ] as const)
      await denied(await getBody(body, type, chunked), 422, "body_not_allowed");
    const empty = await getBody("", "text/plain");
    expect(empty.status).toBe(200);
    privateResponse(empty);
  });
  it("denies forwarded nonloopback clients and exposes no dashboard mutation authority", async () => {
    await denied(await owner.request(endpoint(), { headers: { "x-forwarded-for": "203.0.113.9" } }), 403);
    await denied(
      await owner.request(endpoint(), {
        method: "POST",
        headers: { "x-csrf-token": owner.csrf, "idempotency-key": randomUUID() },
        body: "{}",
      }),
      404,
    );
  });
  it("leaves source, audit and outbox records unchanged during reads", async () => {
    const state = async () =>
      (
        await admin.query(
          "SELECT(SELECT count(*) FROM app.audit_event WHERE tenant_id=$1) audits,(SELECT count(*) FROM app.outbox WHERE tenant_id=$1) outbox,(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM app.lead l WHERE tenant_id=$1) leads",
          [fixtures.orgA],
        )
      ).rows[0];
    const before = await state();
    await read();
    await read();
    expect(await state()).toEqual(before);
  });
});
