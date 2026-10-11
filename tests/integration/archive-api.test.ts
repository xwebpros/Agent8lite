import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import eventSchema from "../../packages/contracts/events.schema.json";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import type { PermissionGrant } from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Archive acceptance requires its owned file-fresh disposable database.");
}
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);
let agent: ApiSession, owner: ApiSession, other: ApiSession;
const sessions: ApiSession[] = [];

const contactPath = (id: string, session: ApiSession = agent) => `/v1/orgs/${session.orgId}/contacts/${id}`;
const leadPath = (id: string, session: ApiSession = agent) => `/v1/orgs/${session.orgId}/leads/${id}`;

async function contact(options: { creator?: string } = {}) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Synthetic archive contact',$3)",
    [fixtures.orgA, id, options.creator ?? fixtures.agentMemberA],
  );
  await admin.query(
    "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary)VALUES($1,$2,'email','archive@example.test',true)",
    [fixtures.orgA, id],
  );
  return id;
}
async function lead(contactId: string, owner: string | null = fixtures.agentMemberA, archived = false) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,archived_at)VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() END)",
    [fixtures.orgA, id, contactId, fixtures.sourceA, stageId(1, 1), owner, archived],
  );
  return id;
}
function archive(
  path: string,
  options: { key?: string; body?: unknown; revision?: string; session?: ApiSession; query?: string } = {},
) {
  const session = options.session ?? agent;
  const headers: Record<string, string> = {
    "idempotency-key": options.key ?? randomUUID(),
    "x-csrf-token": session.csrf,
  };
  if (options.revision) headers["if-match"] = options.revision;
  return session.request(`${path}/archive${options.query ?? ""}`, {
    method: "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}
async function accepted(response: Response, kind: string, version: number) {
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe(`"${version}"`);
  const body = await response.json();
  assertContract("Job", body);
  expect(body).toMatchObject({ kind, state: "succeeded", resultUrl: null, error: null });
  return body as Schemas["Job"];
}
async function effects(id: string) {
  return (
    await admin.query(
      `SELECT
        (SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text) audits,
        (SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND response_ref=$2::text) receipts,
        (SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2::text) events,
        (SELECT count(*)::int FROM app.integration_job WHERE tenant_id=$1 AND result_ref=$2::text) jobs,
        (SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2::uuid AND event_type='lead.archived') activities`,
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function stored(table: "contact" | "lead", id: string) {
  return (
    await admin.query(
      `SELECT row_version::int version,archived_at FROM app.${table} WHERE tenant_id=$1 AND id=$2`,
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function grants<T>(
  operation: () => Promise<T>,
  change: (grants: PermissionGrant[]) => PermissionGrant[],
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    )
  ).rows[0];
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      original.id,
      JSON.stringify(change(original.permission_grants)),
    ]);
    return await operation();
  } finally {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      original.id,
      JSON.stringify(original.permission_grants),
    ]);
  }
}
async function capability<T>(operation: () => Promise<T>) {
  try {
    await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='crm'", [
      fixtures.orgA,
    ]);
    return await operation();
  } finally {
    await admin.query("UPDATE app.entitlement SET state='enabled' WHERE tenant_id=$1 AND feature='crm'", [
      fixtures.orgA,
    ]);
  }
}
async function waitForLock(client: PoolClient) {
  const blocker = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  for (let attempt = 0; attempt < 300; attempt++) {
    const waiting = await admin.query(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) waiting",
      [blocker],
    );
    if (waiting.rows[0].waiting) return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("The archive command did not observe its actual lock wait.");
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  agent = await new ApiSession().signIn("agent");
  owner = await new ApiSession().signIn();
  other = await new ApiSession().signIn();
  sessions.push(agent, owner, other);
  expect((await other.switchOrganization(fixtures.orgB)).status).toBe(200);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end(), worker.end()]);
});

describe("ADR-047 Contact archive", () => {
  it("archives once with a readable succeeded Job, frozen reference event, audit and receipt", async () => {
    const id = await contact();
    const job = await accepted(await archive(contactPath(id)), "crm.contact.archived", 2);
    expect(await stored("contact", id)).toMatchObject({ version: 2 });
    expect((await stored("contact", id)).archived_at).not.toBeNull();
    expect(await effects(id)).toEqual({ audits: 1, receipts: 1, events: 1, jobs: 1, activities: 0 });
    // The frozen getJob operation declares 202 for a readable Job.
    const read = await agent.read(`/v1/orgs/${agent.orgId}/jobs/${job.id}`, "Job", 202);
    expect(read.body).toEqual(job);
    await assertProblem(await agent.request(contactPath(id)), 404);
    const event = (
      await admin.query(
        "SELECT payload,published_at,initiating_actor_id FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2",
        [fixtures.orgA, id],
      )
    ).rows[0];
    expect(validEvent(event.payload), JSON.stringify(validEvent.errors)).toBe(true);
    expect(event.payload).toMatchObject({
      type: "contact.archived",
      version: 1,
      producer: "crm",
      aggregateType: "contact",
      aggregateId: id,
      tenantId: fixtures.orgA,
      payload: { resourceId: id, resourceVersion: 2 },
    });
    expect(Object.keys(event.payload.payload).sort()).toEqual(["resourceId", "resourceVersion"]);
    expect(JSON.stringify(event.payload)).not.toContain("archive@example.test");
    expect(event.payload.occurredAt).toBe(new Date((await stored("contact", id)).archived_at).toISOString());
    expect(event.published_at).toBeNull();
    const audit = (
      await admin.query(
        "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(audit).toEqual([{ action: "contact.archived", safe_diff: { resourceVersion: 2 } }]);
    // Archive is not consent withdrawal and keeps channel provenance.
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM app.contact_channel WHERE tenant_id=$1 AND contact_id=$2",
          [fixtures.orgA, id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("concurrent identical keys commit one effect set and return the same Job", async () => {
    const id = await contact(),
      key = randomUUID();
    const responses = await Promise.all([
      archive(contactPath(id), { key }),
      archive(contactPath(id), { key }),
    ]);
    const jobs = await Promise.all(
      responses.map((response) => accepted(response, "crm.contact.archived", 2)),
    );
    expect(jobs[0]).toEqual(jobs[1]);
    expect(await effects(id)).toEqual({ audits: 1, receipts: 1, events: 1, jobs: 1, activities: 0 });
  });

  it("replays absent and empty bodies as the same command; distinct keys give one archive and one 404", async () => {
    const id = await contact(),
      key = randomUUID();
    const first = await accepted(await archive(contactPath(id), { key }), "crm.contact.archived", 2);
    const before = await effects(id);
    expect(
      await accepted(await archive(contactPath(id), { key, body: {} }), "crm.contact.archived", 2),
    ).toEqual(first);
    expect(
      await accepted(await archive(contactPath(id), { key, revision: '"99"' }), "crm.contact.archived", 2),
    ).toEqual(first);
    expect(await effects(id)).toEqual(before);
    await assertProblem(await archive(contactPath(id)), 404);
    const second = await contact();
    const raced = await Promise.all([archive(contactPath(second)), archive(contactPath(second))]);
    expect(raced.map((response) => response.status).sort()).toEqual([202, 404]);
    expect(await effects(second)).toMatchObject({ events: 1, jobs: 1, receipts: 1 });
  });

  it("validates body, query, key and route before any effect", async () => {
    const id = await contact();
    await assertProblem(await archive(contactPath(id), { body: { reason: "x" } }), 422);
    await assertProblem(await archive(contactPath(id), { body: [] }), 422);
    await assertProblem(await archive(contactPath(id), { query: "?force=true" }), 422);
    const missingKey = await agent.request(`${contactPath(id)}/archive`, {
      method: "POST",
      headers: { "x-csrf-token": agent.csrf },
    });
    expect([400, 422]).toContain(missingKey.status);
    await assertProblem(await archive(contactPath(id), { key: "bad key" }), 400);
    await assertProblem(await archive(contactPath("not-a-uuid")), 422);
    expect(await effects(id)).toEqual({ audits: 0, receipts: 0, events: 0, jobs: 0, activities: 0 });
    expect(await stored("contact", id)).toMatchObject({ version: 1, archived_at: null });
  });

  it("refuses a Contact with an active Lead and archives it after that Lead is archived", async () => {
    const id = await contact(),
      leadId = await lead(id);
    const refused = await assertProblem(await archive(contactPath(id)), 409);
    expect(refused.code).toBe("contact_has_active_leads");
    expect(await effects(id)).toEqual({ audits: 0, receipts: 0, events: 0, jobs: 0, activities: 0 });
    await accepted(await archive(leadPath(leadId)), "crm.lead.archived", 2);
    await accepted(await archive(contactPath(id)), "crm.contact.archived", 2);
  });

  it("a concurrent uncommitted Lead insert holds the archive until it commits, then refuses", async () => {
    const id = await contact();
    const blocker = await admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
        [fixtures.orgA, randomUUID(), id, fixtures.sourceA, stageId(1, 1), fixtures.agentMemberA],
      );
      const pending = archive(contactPath(id));
      await waitForLock(blocker);
      await blocker.query("COMMIT");
      const problem = await assertProblem(await pending, 409);
      expect(problem.code).toBe("contact_has_active_leads");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    expect(await effects(id)).toMatchObject({ events: 0, jobs: 0 });
  });

  it("enforces own scope, tenant and current capability; replay requires current authority", async () => {
    const foreign = await contact({ creator: fixtures.ownerMemberA });
    await assertProblem(await archive(contactPath(foreign)), 404);
    await accepted(await archive(contactPath(foreign, owner), { session: owner }), "crm.contact.archived", 2);
    const crossTenant = await other.request(`${contactPath(await contact(), other)}/archive`, {
      method: "POST",
      headers: { "idempotency-key": randomUUID(), "x-csrf-token": other.csrf },
    });
    expect(crossTenant.status).toBe(404);
    const id = await contact(),
      key = randomUUID();
    await capability(async () => assertProblem(await archive(contactPath(id), { key }), 403));
    expect(await effects(id)).toMatchObject({ jobs: 0, receipts: 0 });
    await accepted(await archive(contactPath(id), { key }), "crm.contact.archived", 2);
    await capability(async () => assertProblem(await archive(contactPath(id), { key }), 403));
    await grants(
      async () => assertProblem(await archive(contactPath(id), { key }), 403),
      (current) => current.filter((grant) => grant.code !== "crm.contacts.write"),
    );
    await accepted(await archive(contactPath(id), { key }), "crm.contact.archived", 2);
  });

  it("rejects an expired matching receipt without execution or renewal", async () => {
    const id = await contact(),
      key = randomUUID();
    await accepted(await archive(contactPath(id), { key }), "crm.contact.archived", 2);
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND key=$2",
      [fixtures.orgA, key],
    );
    const before = await effects(id);
    expect((await assertProblem(await archive(contactPath(id), { key }), 409)).code).toBe("receipt_expired");
    expect(await effects(id)).toEqual(before);
  });

  it("treats a corrupt receipt or missing Job as unavailable rather than re-executing", async () => {
    const id = await contact(),
      key = randomUUID();
    const job = await accepted(await archive(contactPath(id), { key }), "crm.contact.archived", 2);
    await admin.query(
      "UPDATE app.idempotency_record SET response_body=jsonb_set(response_body,'{kind}','\"crm.lead.archived\"') WHERE tenant_id=$1 AND key=$2",
      [fixtures.orgA, key],
    );
    expect((await assertProblem(await archive(contactPath(id), { key }), 503)).code).toBe(
      "receipt_unavailable",
    );
    await admin.query(
      "UPDATE app.idempotency_record SET response_body=jsonb_set(response_body,'{kind}','\"crm.contact.archived\"') WHERE tenant_id=$1 AND key=$2",
      [fixtures.orgA, key],
    );
    await admin.query("UPDATE app.integration_job SET state='failed' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      job.id,
    ]);
    expect((await assertProblem(await archive(contactPath(id), { key }), 503)).code).toBe(
      "receipt_unavailable",
    );
    expect(await effects(id)).toMatchObject({ events: 1, jobs: 1, audits: 1 });
  });
});

describe("ADR-047 Lead archive", () => {
  it("archives once with a Job and references-only activity but no invented outbox event", async () => {
    const contactId = await contact(),
      id = await lead(contactId);
    const job = await accepted(await archive(leadPath(id)), "crm.lead.archived", 2);
    expect(await effects(id)).toEqual({ audits: 1, receipts: 1, events: 0, jobs: 1, activities: 1 });
    expect((await agent.read(`/v1/orgs/${agent.orgId}/jobs/${job.id}`, "Job", 202)).body).toEqual(job);
    await assertProblem(await agent.request(leadPath(id)), 404);
    const activity = (
      await admin.query(
        "SELECT safe_data,occurred_at FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2 AND event_type='lead.archived'",
        [fixtures.orgA, id],
      )
    ).rows[0];
    expect(activity.safe_data).toEqual({ resourceId: id, resourceVersion: 2 });
    expect(new Date(activity.occurred_at).toISOString()).toBe(
      new Date((await stored("lead", id)).archived_at).toISOString(),
    );
    const list = await agent.read(`/v1/orgs/${agent.orgId}/leads?limit=100`, "PageLead");
    expect(list.body.items.some((item) => item.id === id)).toBe(false);
  });

  it("concurrent identical keys commit one archive; replay after Contact archive still returns the Job", async () => {
    const contactId = await contact(),
      id = await lead(contactId),
      key = randomUUID();
    const responses = await Promise.all([archive(leadPath(id), { key }), archive(leadPath(id), { key })]);
    const jobs = await Promise.all(responses.map((response) => accepted(response, "crm.lead.archived", 2)));
    expect(jobs[0]).toEqual(jobs[1]);
    expect(await effects(id)).toEqual({ audits: 1, receipts: 1, events: 0, jobs: 1, activities: 1 });
    await accepted(await archive(contactPath(contactId)), "crm.contact.archived", 2);
    expect(await accepted(await archive(leadPath(id), { key }), "crm.lead.archived", 2)).toEqual(jobs[0]);
    await assertProblem(await archive(leadPath(id)), 404);
  });

  it("enforces own scope over the owner and makes linked Tasks unavailable without mutating them", async () => {
    const contactId = await contact({ creator: fixtures.ownerMemberA }),
      foreign = await lead(contactId, fixtures.ownerMemberA);
    await assertProblem(await archive(leadPath(foreign)), 404);
    const mine = await lead(await contact(), fixtures.agentMemberA);
    const taskId = randomUUID();
    await admin.query(
      "INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,due_at,due_timezone,priority,state)VALUES($1,$2,$3,$4,'Synthetic archived source task',clock_timestamp()+interval '1 day','UTC','normal','open')",
      [fixtures.orgA, taskId, mine, fixtures.agentMemberA],
    );
    await accepted(await archive(leadPath(mine)), "crm.lead.archived", 2);
    await assertProblem(await agent.request(`/v1/orgs/${agent.orgId}/tasks/${taskId}`), 404);
    expect(
      (
        await admin.query("SELECT state,row_version::int v FROM app.task WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          taskId,
        ])
      ).rows[0],
    ).toEqual({ state: "open", v: 1 });
    await accepted(await archive(leadPath(foreign, owner), { session: owner }), "crm.lead.archived", 2);
  });

  it("refuses a Lead whose Contact is archived and rolls back on a revoked grant", async () => {
    const contactId = await contact(),
      id = await lead(contactId);
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      contactId,
    ]);
    await assertProblem(await archive(leadPath(id)), 404);
    const other = await lead(await contact());
    await grants(
      async () => assertProblem(await archive(leadPath(other)), 403),
      (current) => current.filter((grant) => grant.code !== "crm.leads.write"),
    );
    expect(await stored("lead", other)).toMatchObject({ version: 1, archived_at: null });
    expect(await effects(other)).toEqual({ audits: 0, receipts: 0, events: 0, jobs: 0, activities: 0 });
  });

  it("team scope archives only Leads owned by members of a currently shared office", async () => {
    const shared = async () =>
      (
        await admin.query(
          "SELECT count(*)::int n FROM app.office_member mine JOIN app.office_member target ON(target.tenant_id,target.office_id)=(mine.tenant_id,mine.office_id) WHERE mine.tenant_id=$1 AND mine.member_id=$2 AND target.member_id=$3",
          [fixtures.orgA, fixtures.agentMemberA, fixtures.ownerMemberA],
        )
      ).rows[0].n;
    expect(await shared()).toBe(0);
    const id = await lead(await contact({ creator: fixtures.ownerMemberA }), fixtures.ownerMemberA);
    const team = (current: PermissionGrant[]) =>
      current.map((grant) =>
        grant.code === "crm.leads.write" ? { ...grant, scope: "team" as const } : grant,
      );
    await grants(async () => assertProblem(await archive(leadPath(id)), 404), team);
    const office = randomUUID();
    await admin.query("INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'UTC')", [
      fixtures.orgA,
      office,
      "Owned archive office " + office,
    ]);
    await admin.query(
      "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
      [fixtures.orgA, office, fixtures.ownerMemberA, fixtures.agentMemberA],
    );
    try {
      await grants(async () => accepted(await archive(leadPath(id)), "crm.lead.archived", 2), team);
    } finally {
      await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [
        fixtures.orgA,
        office,
      ]);
      await admin.query("DELETE FROM app.office WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, office]);
    }
  });

  it("rechecks scope after an actual Lead lock wait: reassignment during the wait denies without effects", async () => {
    const id = await lead(await contact());
    const blocker = await admin.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        fixtures.orgA,
        id,
      ]);
      const pending = archive(leadPath(id));
      await waitForLock(blocker);
      await blocker.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        id,
        fixtures.ownerMemberA,
      ]);
      await blocker.query("COMMIT");
      await assertProblem(await pending, 404);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    expect(await stored("lead", id)).toMatchObject({ version: 1, archived_at: null });
    expect(await effects(id)).toEqual({ audits: 0, receipts: 0, events: 0, jobs: 0, activities: 0 });
  });
});

describe("ADR-047 reference consumer fairness", () => {
  it("leaves an older contact.archived event unleased while an approved Lead event dispatches", async () => {
    const archivedId = await contact();
    await accepted(await archive(contactPath(archivedId)), "crm.contact.archived", 2);
    await admin.query(
      "UPDATE app.outbox SET created_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1 AND aggregate_id=$2",
      [fixtures.orgA, archivedId],
    );
    const before = (
      await admin.query("SELECT * FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2", [
        fixtures.orgA,
        archivedId,
      ])
    ).rows[0];
    const created = await agent.command(`/v1/orgs/${agent.orgId}/leads`, {
      contactId: await contact(),
      sourceId: fixtures.sourceA,
      ownerMemberId: fixtures.agentMemberA,
      intent: "buyer",
    });
    expect(created.status).toBe(201);
    const captured = await created.json();
    for (let batch = 0; batch < 20; batch++) {
      const result = await dispatchOutbox(
        worker,
        { userId: fixtures.agentUser, organizationId: fixtures.orgA },
        1,
      );
      if (result.dispatched === 0) break;
    }
    const after = (
      await admin.query("SELECT * FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2", [
        fixtures.orgA,
        archivedId,
      ])
    ).rows[0];
    expect(after).toEqual(before);
    expect(after).toMatchObject({ published_at: null, attempt_count: 0, lease_until: null });
    const lead = (
      await admin.query(
        "SELECT published_at FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='lead.captured'",
        [fixtures.orgA, captured.id],
      )
    ).rows[0];
    expect(lead.published_at).not.toBeNull();
  });
});
