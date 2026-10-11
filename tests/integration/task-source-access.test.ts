import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService } from "../../apps/api/src/crm-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Task source acceptance requires its owned disposable isolated batch.");
}
const runtimeName = "task_source_acceptance_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  application_name: runtimeName,
  max: 1,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 3 });
const sessions: ApiSession[] = [];
let owner: ApiSession, agent: ApiSession, otherOrg: ApiSession;
let own: Source, hidden: Source, standalone: Schemas["Task"];
type Source = { contactId: string; leadId: string; task: Schemas["Task"] };
const endpoint = (id?: string, session: ApiSession = agent) =>
  `/v1/orgs/${session.orgId}/tasks${id ? "/" + id : ""}`;

async function source(
  ownerMemberId: string = fixtures.agentMemberA,
  assigneeMemberId: string = fixtures.agentMemberA,
): Promise<Source> {
  const contactId = randomUUID(),
    leadId = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Owned synthetic task source',$3)",
    [fixtures.orgA, contactId, ownerMemberId],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
    [fixtures.orgA, leadId, contactId, fixtures.sourceA, stageId(1, 1), ownerMemberId],
  );
  return { contactId, leadId, task: await insertTask(leadId, assigneeMemberId) };
}
async function insertTask(leadId: string | null, assigneeMemberId: string = fixtures.agentMemberA) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,description,due_at,due_timezone,priority,state)VALUES($1,$2,$3,$4,$5,'Synthetic preserved description','2026-10-10T12:00:00Z','America/Los_Angeles','normal','open')",
    [fixtures.orgA, id, leadId, assigneeMemberId, "Synthetic task source " + id],
  );
  return {
    id,
    leadId,
    assigneeMemberId,
    title: "Synthetic task source " + id,
    description: "Synthetic preserved description",
    dueAt: "2026-10-10T12:00:00.000Z",
    timezone: "America/Los_Angeles",
    priority: "normal",
    state: "open",
    version: 1,
  } satisfies Schemas["Task"];
}
function write(task: Schemas["Task"], patch: Partial<Schemas["TaskWrite"]> = {}): Schemas["TaskWrite"] {
  return {
    assigneeMemberId: task.assigneeMemberId,
    leadId: task.leadId,
    title: task.title,
    dueAt: task.dueAt,
    timezone: task.timezone,
    priority: task.priority,
    state: "done",
    ...patch,
  };
}
async function mark(
  task: Schemas["Task"],
  patch: Partial<Schemas["TaskWrite"]> = {},
  key = randomUUID(),
  session: ApiSession = agent,
) {
  return session.command(endpoint(task.id, session), write(task, patch), {
    method: "PATCH",
    revision: `"${task.version}"`,
    key,
  });
}
async function taskResponse(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  assertContract("Task", body);
  expect(response.headers.get("etag")).toBe(`"${body.version}"`);
  return body;
}
async function list(session: ApiSession = agent) {
  return (await session.read(endpoint(undefined, session) + "?limit=100", "PageTask")).body.items;
}
async function grants<T>(
  remove: string[],
  operation: () => Promise<T>,
  leadScope?: PermissionGrant["scope"],
  taskScope?: PermissionGrant["scope"],
) {
  const row = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    )
  ).rows[0];
  const original = row.permission_grants as PermissionGrant[];
  const next = original
    .filter((g) => !remove.includes(g.code))
    .map((g) =>
      g.code === "crm.leads.read" && leadScope
        ? { ...g, scope: leadScope }
        : ["crm.tasks.read", "crm.tasks.write"].includes(g.code) && taskScope
          ? { ...g, scope: taskScope }
          : g,
    );
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
async function stored(id: string) {
  return (
    await admin.query(
      "SELECT lead_id,title,state,row_version::text FROM app.task WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function effects(id: string) {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text) audits,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1 AND safe_data->>'resourceId'=$2::text AND event_type='task.completed') activities",
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function unchanged(task: Schemas["Task"], operation: () => Promise<unknown>) {
  const before = await stored(task.id),
    beforeEffects = await effects(task.id);
  await operation();
  expect(await stored(task.id)).toEqual(before);
  expect(await effects(task.id)).toEqual(beforeEffects);
}
async function direct<T>(
  operation: (service: CrmService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(
    runtime,
    { userId: fixtures.agentUser, organizationId: fixtures.orgA },
    (client, context) => operation(new CrmService(client, context, randomUUID()), client, context),
  );
}
async function directMark(task: Schemas["Task"], key = randomUUID()) {
  return direct((crm) =>
    crm.patchTask(task.id, write(task), `"${task.version}"`, key, `PATCH ${endpoint(task.id)}`),
  );
}
async function waitForLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (
      await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
        [runtimeName],
      )
    ).rows[0].waiting;
    if (waiting) return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("The owned task command did not observe its real source lock wait.");
}
async function waitForOwnedApiLock(blockerPid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (
      await admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='estate_runtime' AND $1::int=ANY(pg_blocking_pids(pid))) waiting",
        [blockerPid],
      )
    ).rows[0].waiting;
    if (waiting) return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("The isolated HTTP task command did not observe its owned current-assignee lock wait.");
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  owner = await new ApiSession().signIn();
  agent = await new ApiSession().signIn("agent");
  otherOrg = await new ApiSession().signIn();
  sessions.push(owner, agent, otherOrg);
  expect((await otherOrg.switchOrganization(fixtures.orgB)).status).toBe(200);
  own = await source();
  hidden = await source(fixtures.ownerMemberA);
  standalone = await insertTask(null);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("linked task access intersects current task and source authority", () => {
  it("hides an assigned task whose lead is outside current source scope from list/detail/dashboard", async () => {
    const ids = (await list()).map((t) => t.id);
    expect(ids).toContain(own.task.id);
    expect(ids).toContain(standalone.id);
    expect(ids).not.toContain(hidden.task.id);
    await assertProblem(await agent.request(endpoint(hidden.task.id)), 404);
    const dashboard = (await agent.read(`/v1/orgs/${agent.orgId}/dashboard`, "Dashboard")).body;
    expect(dashboard.tasks.map((t) => t.id)).not.toContain(hidden.task.id);
    expect((await list(owner)).map((t) => t.id)).toContain(hidden.task.id);
    await assertProblem(await otherOrg.request(endpoint(own.task.id, otherOrg)), 404);
    await assertProblem(await agent.request(endpoint(fixtures.taskB)), 404);
  });
  it("hides linked rows after lead-read revocation but preserves standalone reads and commands", async () => {
    await grants(["crm.leads.read"], async () => {
      const ids = (await list()).map((t) => t.id);
      expect(ids).toContain(standalone.id);
      expect(ids).not.toContain(own.task.id);
      await assertProblem(await agent.request(endpoint(own.task.id)), 404);
      const row = await insertTask(null);
      expect((await taskResponse(await mark(row))).state).toBe("done");
    });
  });
  it.each(["lead", "contact"])("hides linked task projections when its%s is archived", async (kind) => {
    const s = await source();
    await admin.query(`UPDATE app.${kind} SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [
      fixtures.orgA,
      kind === "lead" ? s.leadId : s.contactId,
    ]);
    expect((await list()).map((t) => t.id)).not.toContain(s.task.id);
    await assertProblem(await agent.request(endpoint(s.task.id)), 404);
    await unchanged(s.task, async () => assertProblem(await mark(s.task), 404));
  });
  it("requires current team-office intersection for linked reads", async () => {
    const officeId = randomUUID();
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,'Owned synthetic task office','America/Los_Angeles')",
      [fixtures.orgA, officeId],
    );
    await admin.query(
      "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
      [fixtures.orgA, officeId, fixtures.agentMemberA, fixtures.ownerMemberA],
    );
    await grants(
      [],
      async () => {
        expect((await list()).map((t) => t.id)).toContain(hidden.task.id);
        await admin.query(
          "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
          [fixtures.orgA, officeId, fixtures.ownerMemberA],
        );
        expect((await list()).map((t) => t.id)).not.toContain(hidden.task.id);
        await assertProblem(await agent.request(endpoint(hidden.task.id)), 404);
      },
      "team",
    );
  });
  it.each(["omit", "clear"])(
    "does not bypass the hidden effective old link through%s PATCH",
    async (kind) => {
      const body = write(hidden.task);
      if (kind === "omit") delete body.leadId;
      else body.leadId = null;
      await unchanged(hidden.task, async () =>
        assertProblem(
          await agent.command(endpoint(hidden.task.id), body, { method: "PATCH", revision: '"1"' }),
          404,
        ),
      );
    },
  );
  it("checks a proposed new source and creation source before writing anything", async () => {
    const row = await insertTask(null);
    await unchanged(row, async () => assertProblem(await mark(row, { leadId: hidden.leadId }), 404));
    const body = write(row, { leadId: hidden.leadId });
    const before = (
      await admin.query("SELECT count(*)::int n FROM app.task WHERE tenant_id=$1", [fixtures.orgA])
    ).rows[0].n;
    await assertProblem(await agent.command(endpoint(), body), 404);
    expect(
      (await admin.query("SELECT count(*)::int n FROM app.task WHERE tenant_id=$1", [fixtures.orgA])).rows[0]
        .n,
    ).toBe(before);
  });
  it("retains lead-write dependency for effective linked commands but not standalone work", async () => {
    const s = await source(),
      row = await insertTask(null);
    await grants(["crm.leads.write"], async () => {
      await taskResponse(await agent.request(endpoint(s.task.id)));
      await unchanged(s.task, async () => assertProblem(await mark(s.task, { leadId: null }), 404));
      expect((await taskResponse(await mark(row))).state).toBe("done");
    });
  });
  it("preserves historical completion replay while recording one activity, one audit and no lead edit", async () => {
    const s = await source(),
      key = randomUUID();
    const leadBefore = (
      await admin.query(
        "SELECT row_version::text,owner_member_id FROM app.lead WHERE tenant_id=$1 AND id=$2",
        [fixtures.orgA, s.leadId],
      )
    ).rows[0];
    const responses = await Promise.all([mark(s.task, {}, key), mark(s.task, {}, key)]);
    const first = await taskResponse(responses[0]),
      duplicate = await taskResponse(responses[1]);
    expect(duplicate).toEqual(first);
    expect(first.version).toBe(2);
    await taskResponse(
      await agent.command(
        endpoint(s.task.id),
        write(first, { title: "Later synthetic edit", state: "done" }),
        { method: "PATCH", revision: '"2"' },
      ),
    );
    const historical = await taskResponse(await mark(s.task, {}, key));
    expect(historical).toEqual(first);
    expect((await effects(s.task.id)).activities).toBe(1);
    expect((await effects(s.task.id)).audits).toBe(2);
    expect(
      (
        await admin.query(
          "SELECT row_version::text,owner_member_id FROM app.lead WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, s.leadId],
        )
      ).rows[0],
    ).toEqual(leadBefore);
  });
  it("refuses a historical source replay even when the current task link is newly accessible", async () => {
    const old = await source(),
      next = await source(),
      key = randomUUID();
    await taskResponse(await mark(old.task, {}, key));
    await admin.query(
      "UPDATE app.task SET lead_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, old.task.id, next.leadId],
    );
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      old.leadId,
      fixtures.ownerMemberA,
    ]);
    expect((await taskResponse(await agent.request(endpoint(old.task.id)))).leadId).toBe(next.leadId);
    await unchanged(old.task, async () => assertProblem(await mark(old.task, {}, key), 404));
  });
  it("reauthorizes task permission and current membership before cached acknowledgement", async () => {
    const s = await source(),
      key = randomUUID();
    await taskResponse(await mark(s.task, {}, key));
    await grants(["crm.tasks.write"], async () =>
      unchanged(s.task, async () => assertProblem(await mark(s.task, {}, key), 403)),
    );
    try {
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
      await unchanged(s.task, async () => assertProblem(await mark(s.task, {}, key), 403));
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("rejects changed key input and racing new-key revisions without duplicate completion activity", async () => {
    const s = await source(),
      key = randomUUID();
    await taskResponse(await mark(s.task, {}, key));
    await unchanged(s.task, async () =>
      assertProblem(await mark(s.task, { title: "Changed same key" }, key), 409),
    );
    const another = await source();
    const responses = await Promise.all([mark(another.task), mark(another.task)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
    for (const response of responses)
      if (response.status === 200) await taskResponse(response);
      else await assertProblem(response, 412);
    expect(await effects(another.task.id)).toEqual({ audits: 1, activities: 1 });
  });
  it.each(["archive", "reassign"])(
    "rechecks source after a real blocked parent%s change and rolls back effects",
    async (kind) => {
      const s = await source(),
        blocker = await admin.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          s.leadId,
        ]);
        pending = directMark(s.task).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await waitForLock();
        if (kind === "archive")
          await blocker.query(
            "UPDATE app.lead SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
            [fixtures.orgA, s.leadId],
          );
        else
          await blocker.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            s.leadId,
            fixtures.ownerMemberA,
          ]);
        await blocker.query("COMMIT");
        expect(await pending).toMatchObject({ error: { status: 404, code: "resource_unavailable" } });
        expect(await stored(s.task.id)).toMatchObject({ state: "open", row_version: "1" });
        expect(await effects(s.task.id)).toEqual({ audits: 0, activities: 0 });
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        if (pending) await pending;
      }
    },
  );
  it("uses the post-wait CRM clock rather than transaction start after capability expiry", async () => {
    const s = await source(),
      blocker = await admin.connect();
    const original = (
      await admin.query("SELECT effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ])
    ).rows[0];
    let pending: Promise<unknown> | undefined;
    try {
      await admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
        fixtures.orgA,
        s.contactId,
      ]);
      pending = directMark(s.task).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await waitForLock();
      await blocker.query("SELECT pg_sleep(1.05)");
      await blocker.query("COMMIT");
      expect(await pending).toMatchObject({ error: { status: 403, code: "entitlement_disabled" } });
      expect(await stored(s.task.id)).toMatchObject({ state: "open", row_version: "1" });
      expect(await effects(s.task.id)).toEqual({ audits: 0, activities: 0 });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) await pending;
      await admin.query(
        "UPDATE app.entitlement SET effective_until=$2 WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA, original.effective_until],
      );
    }
  });
  it.each(["linked", "standalone", "replay"])(
    "rechecks current-assignee team access after a real HTTP task-row wait for%s work",
    async (kind) => {
      const row =
        kind === "standalone"
          ? await insertTask(null, fixtures.ownerMemberA)
          : (await source(fixtures.agentMemberA, fixtures.ownerMemberA)).task;
      const officeId = randomUUID();
      await admin.query(
        "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'America/Los_Angeles')",
        [fixtures.orgA, officeId, "Owned task race office " + officeId],
      );
      await admin.query(
        "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
        [fixtures.orgA, officeId, fixtures.agentMemberA, fixtures.ownerMemberA],
      );
      await grants(
        [],
        async () => {
          const key = randomUUID();
          if (kind === "replay") await taskResponse(await mark(row, {}, key));
          const before = await stored(row.id),
            beforeEffects = await effects(row.id);
          const blocker = await admin.connect();
          let pending: Promise<Response> | undefined;
          try {
            await blocker.query("BEGIN");
            const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() pid")).rows[0].pid);
            await blocker.query("SELECT id FROM app.task WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
              fixtures.orgA,
              row.id,
            ]);
            pending =
              kind === "replay" ? mark(row, {}, key) : mark(row, { assigneeMemberId: fixtures.agentMemberA });
            await waitForOwnedApiLock(blockerPid);
            await blocker.query(
              "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
              [fixtures.orgA, officeId, fixtures.ownerMemberA],
            );
            await blocker.query("COMMIT");
            await assertProblem(await pending, 404);
            expect(await stored(row.id)).toEqual(before);
            expect(await effects(row.id)).toEqual(beforeEffects);
          } finally {
            await blocker.query("ROLLBACK");
            blocker.release();
            if (pending) await pending;
          }
        },
        undefined,
        "team",
      );
    },
  );
  it("rejects forged member/source permission context and resets tenant context after pool reuse", async () => {
    expect((await runtime.query("SELECT id FROM app.task")).rows).toEqual([]);
    await direct(async (_crm, client, context) => {
      const forged = new CrmService(client, { ...context, memberId: fixtures.ownerMemberA }, randomUUID());
      await expect(forged.detail("tasks", own.task.id)).rejects.toMatchObject({ status: 403 });
      const widened = new CrmService(
        client,
        {
          ...context,
          permissions: context.permissions.map((g) =>
            g.code === "crm.leads.read" ? { ...g, scope: "organization" as const } : g,
          ),
        },
        randomUUID(),
      );
      await expect(widened.detail("tasks", hidden.task.id)).rejects.toMatchObject({ status: 404 });
      await expect(_crm.detail("tasks", fixtures.taskB)).rejects.toMatchObject({ status: 404 });
    });
    const cleared = await runtime.query("SELECT app.current_tenant() tenant,app.current_actor() actor");
    expect(cleared.rows[0]).toEqual({ tenant: null, actor: null });
    expect((await runtime.query("SELECT id FROM app.task")).rows).toEqual([]);
  });
  it("only writes named IANA zones/UTC, preserving approved alias spelling", async () => {
    const row = await insertTask(null);
    for (const timezone of ["+01:00", "PST", "GMT", "PRIVATE_INVALID_ZONE"])
      await unchanged(row, async () => assertProblem(await mark(row, { timezone }), 422));
    for (const timezone of ["US/Pacific", "UTC"]) {
      const created = await taskResponse(
        await agent.command(endpoint(), write(row, { timezone, state: "open" })),
        201,
      );
      expect(created.timezone).toBe(timezone);
    }
  });
});
