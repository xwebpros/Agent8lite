import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppointmentService } from "../../apps/api/src/appointment-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type TenantContext,
  type VerifiedIdentityContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Appointment acceptance requires an owned disposable isolated batch.");
}
const runtimeApplication = "appointment_acceptance_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeApplication,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 3 });
const ownerIdentity = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const agentIdentity = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
const sessions: ApiSession[] = [];
let owner: ApiSession, agent: ApiSession, otherOrg: ApiSession;
let ownerLead: string,
  ownerContact: string,
  ownAppointment: string,
  agentAppointment: string,
  foreignAppointment: string;
const endpoint = (session: ApiSession) => `/v1/orgs/${session.orgId}/appointments`;

async function login(identity: "owner" | "agent" = "owner") {
  const result = await new ApiSession().signIn(identity);
  sessions.push(result);
  return result;
}
async function createOwnedLead() {
  const lead = randomUUID(),
    contact = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Owned synthetic agenda contact',$3)",
    [fixtures.orgA, contact, fixtures.ownerMemberA],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
    [fixtures.orgA, lead, contact, fixtures.sourceA, stageId(1, 1), fixtures.ownerMemberA],
  );
  return { lead, contact };
}
async function appointment(
  leadId: string = ownerLead,
  tenant: string = fixtures.orgA,
  state = "scheduled",
  zone = "America/Los_Angeles",
) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.appointment(tenant_id,id,lead_id,provider_event_id,starts_at,ends_at,timezone,state)VALUES($1,$2,$3,$4,'2026-11-01T08:30:00.000Z','2026-11-01T09:30:00.000Z',$5,$6)",
    [tenant, id, leadId, "synthetic-stored-" + randomUUID(), zone, state],
  );
  return id;
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}
async function page(response: Response) {
  privateResponse(response);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  assertContract("PageAppointment", body);
  return body;
}
async function problem(response: Response, status: number) {
  privateResponse(response);
  return assertProblem(response, status);
}
async function read(session: ApiSession = owner, query = "?limit=100") {
  return page(await session.request(endpoint(session) + query));
}
function getWithBody(body: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(endpoint(owner), apiOrigin),
      {
        method: "GET",
        headers: {
          cookie: owner.cookie,
          origin: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 65536) {
            request.destroy(new Error("Owned appointment response exceeded bound."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
          resolve(
            new Response(Buffer.concat(chunks).toString("utf8"), { status: response.statusCode, headers }),
          );
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Owned appointment body probe timed out.")));
    request.end(body);
  });
}
async function roleChange<T>(
  remove: string[],
  operation: () => Promise<T>,
  leadScope?: string,
  appointmentScope?: string,
) {
  const row = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(m.tenant_id,m.role_id)=(r.tenant_id,r.id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.ownerMemberA],
    )
  ).rows[0];
  const original = row.permission_grants as { code: string; scope: string }[];
  const grants = original
    .filter((g) => !remove.includes(g.code))
    .map((g) =>
      g.code === "crm.leads.read" && leadScope
        ? { ...g, scope: leadScope }
        : g.code === "appointments.read" && appointmentScope
          ? { ...g, scope: appointmentScope }
          : g,
    );
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      row.id,
      JSON.stringify(grants),
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
async function direct<T>(
  operation: (client: PoolClient, context: TenantContext) => Promise<T>,
  identity: VerifiedIdentityContext = ownerIdentity,
) {
  return withTenantTransaction(runtime, identity, operation);
}
async function visibleRows(client: PoolClient) {
  return (await client.query("SELECT id FROM app.appointment ORDER BY id")).rows.map((r) => r.id as string);
}
async function waitForRuntimeLock() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const waiting = (
      await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')AS waiting",
        [runtimeApplication],
      )
    ).rows[0].waiting;
    if (waiting) return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("Owned appointment reader did not observe the expected real lock wait.");
}
async function capabilityChange<T>(state: string, until: string | null, operation: () => Promise<T>) {
  const row = (
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
      [fixtures.orgA, row.state, row.effective_until],
    );
  }
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  owner = await login();
  agent = await login("agent");
  otherOrg = await login();
  expect((await otherOrg.switchOrganization(fixtures.orgB)).status).toBe(200);
  expect(await read()).toEqual({ items: [], nextCursor: null, hasMore: false });
  const own = await createOwnedLead();
  ownerLead = own.lead;
  ownerContact = own.contact;
  ownAppointment = await appointment();
  agentAppointment = await appointment(fixtures.leadA);
  foreignAppointment = await appointment(fixtures.leadB, fixtures.orgB);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("registered read-only current-member stored appointments", () => {
  it("always narrows organization grants to the current member, including the owner", async () => {
    expect((await read()).items.map((i) => i.id)).toEqual([ownAppointment]);
    expect((await read(agent)).items.map((i) => i.id)).toEqual([agentAppointment]);
    expect((await read(otherOrg)).items).toEqual([]);
    expect((await read()).items.some((i) => i.id === foreignAppointment)).toBe(false);
  });
  it("returns all three stored states, exact UTC instants and no private provider fields", async () => {
    const cancelled = await appointment(ownerLead, fixtures.orgA, "cancelled");
    const completed = await appointment(ownerLead, fixtures.orgA, "completed");
    const body = await read();
    for (const id of [ownAppointment, cancelled, completed]) {
      const item = body.items.find((i) => i.id === id)!;
      expect(Object.keys(item).sort()).toEqual(["endsAt", "id", "leadId", "startsAt", "state", "timezone"]);
      expect(item.startsAt).toBe("2026-11-01T08:30:00.000Z");
      expect(item.endsAt).toBe("2026-11-01T09:30:00.000Z");
      expect(item.timezone).toBe("America/Los_Angeles");
    }
    expect(new Set(body.items.map((i) => i.state))).toEqual(new Set(["scheduled", "cancelled", "completed"]));
  });
  it("requires current identity and active organization without accepting a foreign path", async () => {
    await problem(await new ApiSession().request(endpoint(owner)), 401);
    await problem(await owner.request(`/v1/orgs/${fixtures.orgB}/appointments`), 403);
    await problem(await agent.request(`/v1/orgs/${randomUUID()}/appointments`), 403);
    await admin.query("UPDATE app.membership SET status='disabled'WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.ownerMemberA,
    ]);
    try {
      await problem(await owner.request(endpoint(owner)), 403);
    } finally {
      await admin.query("UPDATE app.membership SET status='active'WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
    }
  });
  it("requires both catalog permissions, including organization scope for appointments", async () => {
    for (const removed of ["appointments.read", "crm.leads.read"]) {
      await roleChange([removed], async () => {
        await problem(await owner.request(endpoint(owner)), 403);
        expect(await direct(visibleRows)).toEqual([]);
      });
    }
    await roleChange(
      [],
      async () => {
        await problem(await owner.request(endpoint(owner)), 403);
        expect(await direct(visibleRows)).toEqual([]);
      },
      undefined,
      "own",
    );
  });
  it("preserves the team-office intersection even for a self-owned lead", async () => {
    const office = randomUUID(),
      link = randomUUID();
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,'Synthetic agenda team','America/Los_Angeles')",
      [fixtures.orgA, office],
    );
    await roleChange(
      [],
      async () => {
        expect((await read()).items).toEqual([]);
        expect(await direct(visibleRows)).toEqual([]);
        await admin.query(
          "INSERT INTO app.office_member(tenant_id,id,office_id,member_id)VALUES($1,$2,$3,$4)",
          [fixtures.orgA, link, office, fixtures.ownerMemberA],
        );
        try {
          expect((await read()).items.some((i) => i.id === ownAppointment)).toBe(true);
          expect((await read()).items.some((i) => i.id === agentAppointment)).toBe(false);
          expect(await direct(visibleRows)).toContain(ownAppointment);
        } finally {
          await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            link,
          ]);
        }
        expect((await read()).items).toEqual([]);
      },
      "team",
    );
  });
  it("rechecks current assignment and both linked archive states", async () => {
    const cases = [
      {
        change: "UPDATE app.lead SET owner_member_id=$2 WHERE id=$1",
        id: ownerLead,
        value: fixtures.agentMemberA,
        restore: fixtures.ownerMemberA,
      },
      {
        change: "UPDATE app.lead SET archived_at=$2 WHERE id=$1",
        id: ownerLead,
        value: new Date(),
        restore: null,
      },
      {
        change: "UPDATE app.contact SET archived_at=$2 WHERE id=$1",
        id: ownerContact,
        value: new Date(),
        restore: null,
      },
    ];
    for (const testCase of cases) {
      try {
        await admin.query(testCase.change, [testCase.id, testCase.value]);
        expect((await read()).items.some((i) => i.id === ownAppointment)).toBe(false);
        expect(await direct(visibleRows)).not.toContain(ownAppointment);
      } finally {
        await admin.query(testCase.change, [testCase.id, testCase.restore]);
      }
    }
  });
  it("denies disabled and expired CRM capability rather than returning a fabricated empty page", async () => {
    for (const [state, until] of [
      ["disabled", null],
      ["enabled", "2000-01-01T00:00:00.000Z"],
    ] as const)
      await capabilityChange(state, until, async () => {
        await problem(await owner.request(endpoint(owner)), 403);
        expect(await direct(visibleRows)).toEqual([]);
      });
  });
  it("does not return a lead reassigned or archived while its source read waits for the row lock", async () => {
    for (const change of ["reassigned", "archived"]) {
      const blocker = await admin.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          ownerLead,
        ]);
        pending = direct((client, context) => new AppointmentService(client, context).list({}));
        await waitForRuntimeLock();
        if (change === "reassigned")
          await blocker.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            ownerLead,
            fixtures.agentMemberA,
          ]);
        else
          await blocker.query(
            "UPDATE app.lead SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2",
            [fixtures.orgA, ownerLead],
          );
        await blocker.query("COMMIT");
        await expect(pending).resolves.toEqual({ items: [], nextCursor: null, hasMore: false });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await pending?.catch(() => undefined);
        await admin.query(
          "UPDATE app.lead SET owner_member_id=$3,archived_at=NULL WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, ownerLead, fixtures.ownerMemberA],
        );
      }
    }
  });
  it("uses the post-lock database clock when capability expires during membership verification", async () => {
    await capabilityChange("enabled", null, async () => {
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
        pending = direct(async (client, context) => new AppointmentService(client, context).list({}));
        let waiting = false;
        for (let attempt = 0; attempt < 80 && !waiting; attempt++) {
          waiting = (
            await admin.query(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')AS waiting",
              [runtimeApplication],
            )
          ).rows[0].waiting;
          if (!waiting) await admin.query("SELECT pg_sleep(0.01)");
        }
        expect(waiting).toBe(true);
        const observed = await admin.query("SELECT pg_sleep(0.55)");
        expect(observed.rowCount).toBe(1);
        await blocker.query("COMMIT");
        await expect(pending).rejects.toMatchObject({ status: 403 });
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
        await pending?.catch(() => undefined);
      }
    });
  });
  it("does not project a privileged relink to an unlocked parent during a waited source read", async () => {
    const replacement = await createOwnedLead();
    const blocker = await admin.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        fixtures.orgA,
        ownerLead,
      ]);
      pending = direct((client, context) => new AppointmentService(client, context).list({}));
      await waitForRuntimeLock();
      await admin.query("UPDATE app.appointment SET lead_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        ownAppointment,
        replacement.lead,
      ]);
      await blocker.query("COMMIT");
      const body = await pending;
      assertContract("PageAppointment", body);
      expect(body.items.some((item) => item.id === ownAppointment)).toBe(false);
      const refreshed = await read();
      expect(refreshed.items.find((item) => item.id === ownAppointment)?.leadId).toBe(replacement.lead);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await pending?.catch(() => undefined);
      await admin.query("UPDATE app.appointment SET lead_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        ownAppointment,
        ownerLead,
      ]);
    }
  });
  it("binds opaque pagination to current actor, organization, grants and exact query scope", async () => {
    await appointment();
    await appointment();
    const first = await read(owner, "?limit=1");
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const next = await read(owner, "?limit=1&cursor=" + encodeURIComponent(first.nextCursor!));
    expect(next.items[0].id > first.items[0].id).toBe(true);
    await problem(
      await agent.request(endpoint(agent) + "?cursor=" + encodeURIComponent(first.nextCursor!)),
      422,
    );
    await problem(
      await otherOrg.request(endpoint(otherOrg) + "?cursor=" + encodeURIComponent(first.nextCursor!)),
      422,
    );
    await problem(
      await owner.request(endpoint(owner) + "?cursor=" + encodeURIComponent(first.nextCursor! + "tampered")),
      422,
    );
    await roleChange(["ai.accept"], async () => {
      await problem(
        await owner.request(endpoint(owner) + "?cursor=" + encodeURIComponent(first.nextCursor!)),
        422,
      );
    });
  });
  it("rejects extra, repeated, array, blank and noninteger public query values", async () => {
    for (const query of [
      "?scope=organization",
      "?ownerId=" + fixtures.agentMemberA,
      "?from=2026-10-10",
      "?limit=",
      "?limit=0",
      "?limit=101",
      "?limit=1.5",
      "?limit=1junk",
      "?limit=1&limit=2",
      "?limit[]=1",
      "?cursor=",
      "?cursor=x&cursor=y",
      "?cursor[]=x",
    ])
      await problem(await owner.request(endpoint(owner) + query), 422);
  });
  it("rejects even an empty JSON object as a GET request body", async () => {
    const denied = await problem(await getWithBody("{}"), 422);
    expect(denied.code).toBe("body_not_allowed");
  });
  it("denies malformed stored metadata without disclosing it", async () => {
    const bad = await appointment();
    const cases = [
      ["UPDATE app.appointment SET timezone=$2 WHERE id=$1", "PRIVATE_INVALID_ZONE"],
      ["UPDATE app.appointment SET state=$2 WHERE id=$1", "PRIVATE_UNSUPPORTED_STATE"],
      ["UPDATE app.appointment SET starts_at=$2 WHERE id=$1", "-infinity"],
    ];
    for (const [statement, value] of cases) {
      try {
        await admin.query(statement, [bad, value]);
        const response = await owner.request(endpoint(owner));
        const body = await problem(response, 503);
        expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|infinity/);
      } finally {
        await admin.query(
          "UPDATE app.appointment SET timezone='America/Los_Angeles',state='scheduled',starts_at='2026-11-01T08:30:00.000Z'WHERE id=$1",
          [bad],
        );
      }
    }
  });
  it("is read-only and exposes no invented booking, cancellation or detail command", async () => {
    const before = (
      await admin.query("SELECT row_version::text,updated_at,state FROM app.appointment WHERE id=$1", [
        ownAppointment,
      ])
    ).rows[0];
    for (const [method, suffix] of [
      ["POST", ""],
      ["PATCH", "/" + ownAppointment],
      ["POST", "/" + ownAppointment + "/cancel"],
      ["GET", "/" + ownAppointment],
    ] as const) {
      const response = await owner.command(endpoint(owner) + suffix, undefined, { method });
      expect([404, 405]).toContain(response.status);
      privateResponse(response);
    }
    await read();
    await read();
    expect(
      (
        await admin.query("SELECT row_version::text,updated_at,state FROM app.appointment WHERE id=$1", [
          ownAppointment,
        ])
      ).rows[0],
    ).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM app.audit_event WHERE resource_type='appointment'AND resource_id=$1",
          [ownAppointment],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      (
        await admin.query("SELECT count(*)::int AS count FROM app.outbox WHERE aggregate_id=$1", [
          ownAppointment,
        ])
      ).rows[0].count,
    ).toBe(0);
  });
});

describe("actual SELECT-only appointment runtime boundary", () => {
  it("keeps missing, mismatched and forged member contexts closed across pool reuse", async () => {
    expect((await runtime.query("SELECT id FROM app.appointment")).rows).toEqual([]);
    await direct(async (client) => {
      await client.query("SELECT set_config('app.member_id',$1,true)", [fixtures.ownerMemberA]);
      const ids = await visibleRows(client);
      expect(ids).toContain(agentAppointment);
      expect(ids).not.toContain(ownAppointment);
    }, agentIdentity);
    const client = await runtime.connect();
    try {
      for (const actor of [randomUUID(), fixtures.agentUser]) {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
          fixtures.orgB,
          actor,
        ]);
        expect(await visibleRows(client)).toEqual([]);
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect((await runtime.query("SELECT id FROM app.appointment")).rows).toEqual([]);
    expect(await direct(visibleRows)).toContain(ownAppointment);
    expect((await runtime.query("SELECT id FROM app.appointment")).rows).toEqual([]);
  });
  it("does not widen rows when a service caller supplies a mismatched member snapshot", async () => {
    await direct(async (client, context) => {
      try {
        const result = await new AppointmentService(client, {
          ...context,
          memberId: fixtures.ownerMemberA,
        }).list({});
        expect(result.items.some((item) => item.id === ownAppointment)).toBe(false);
      } catch (error) {
        expect(error).toMatchObject({ status: 403 });
      }
    }, agentIdentity);
  });
  it("grants only frozen projection columns without provider access or row locking", async () => {
    await direct(async (client) => {
      expect(
        (
          await client.query(
            "SELECT tenant_id,id,lead_id,starts_at,ends_at,timezone,state FROM app.appointment WHERE id=$1",
            [ownAppointment],
          )
        ).rowCount,
      ).toBe(1);
    });
    for (const statement of [
      "SELECT * FROM app.appointment",
      "SELECT provider_event_id FROM app.appointment",
      "SELECT connection_id FROM app.appointment",
      "SELECT row_version FROM app.appointment",
      "SELECT id FROM app.appointment FOR SHARE",
      "SELECT id FROM app.appointment FOR UPDATE",
    ])
      await expect(direct((client) => client.query(statement))).rejects.toMatchObject({ code: "42501" });
  });
  it("denies appointment INSERT, UPDATE, DELETE and TRUNCATE on the real runtime login", async () => {
    for (const statement of [
      "INSERT INTO app.appointment(tenant_id,id,lead_id,provider_event_id,starts_at,ends_at,timezone,state)VALUES($1,$2,$3,'forged',now(),now()+interval '1 hour','UTC','scheduled')",
      "UPDATE app.appointment SET state='cancelled'WHERE tenant_id=$1 AND id=$2",
      "DELETE FROM app.appointment WHERE tenant_id=$1 AND id=$2",
      "TRUNCATE app.appointment",
    ]) {
      const parameters = statement.startsWith("TRUNCATE")
        ? []
        : statement.startsWith("INSERT")
          ? [fixtures.orgA, randomUUID(), ownerLead]
          : [fixtures.orgA, ownAppointment];
      await expect(direct((client) => client.query(statement, parameters))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });
  it("retains FORCE RLS and grants no other platform role appointment read or helper authority", async () => {
    expect(
      (
        await admin.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.appointment'::regclass",
        )
      ).rows[0],
    ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["estate_worker", "estate_control", "estate_staff_issuer"]) {
      expect(
        (
          await admin.query(
            "SELECT has_any_column_privilege($1,'app.appointment','SELECT')AS can_read,has_function_privilege($1,'app.appointment_member_read_allowed(uuid)','EXECUTE')AS can_call",
            [role],
          )
        ).rows[0],
      ).toEqual({ can_read: false, can_call: false });
    }
  });
  it("rejects hooked direct query objects without invoking them", async () => {
    let hooks = 0;
    const accessor = Object.defineProperty({}, "limit", {
      enumerable: true,
      get() {
        hooks++;
        return "25";
      },
    });
    const inherited = Object.create({ limit: "25" }) as Record<string, unknown>;
    for (const query of [
      accessor,
      inherited,
      { limit: ["25"] },
      {
        cursor: {
          toString() {
            hooks++;
            return "x";
          },
        },
      },
    ])
      await expect(
        direct((client, context) => new AppointmentService(client, context).list(query)),
      ).rejects.toMatchObject({ status: 422 });
    expect(hooks).toBe(0);
  });
});
