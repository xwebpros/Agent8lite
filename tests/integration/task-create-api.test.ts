import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService, stable } from "../../apps/api/src/crm-service";
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
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Task creation acceptance requires an owned file-fresh disposable database.");
}
const runtimeName = "task_create_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const path = "/v1/orgs/" + fixtures.orgA + "/tasks",
  route = "POST " + path;
let agent: ApiSession;
function input(leadId?: string | null): Schemas["TaskWrite"] {
  return {
    assigneeMemberId: fixtures.agentMemberA,
    title: " Synthetic private task ",
    description: " PRIVATE_DESCRIPTION ",
    dueAt: "2026-11-01T01:30:00.123-08:00",
    timezone: "US/Pacific",
    ...(leadId === undefined ? {} : { leadId }),
  };
}
async function source(options: { org?: string; owner?: string } = {}) {
  const org = options.org ?? fixtures.orgA,
    leadId = randomUUID(),
    contactId = randomUUID(),
    member = options.owner ?? (org === fixtures.orgA ? fixtures.agentMemberA : fixtures.ownerMemberB);
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Private synthetic follow-up source',$3)",
    [org, contactId, member],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent)VALUES($1,$2,$3,$4,$5,$6,'buyer')",
    [
      org,
      leadId,
      contactId,
      org === fixtures.orgA ? fixtures.sourceA : fixtures.sourceB,
      org === fixtures.orgA ? stageId(1, 1) : stageId(2, 1),
      member,
    ],
  );
  return { leadId, contactId };
}
const post = (body: unknown = input(), key = randomUUID()) => agent.command(path, body, { key });
async function receipt(response: Response): Promise<Schemas["Task"]> {
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe('"1"');
  const value = await response.json();
  assertContract("Task", value);
  expect(value.version).toBe(1);
  return value;
}
async function effects() {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.task WHERE tenant_id=$1)tasks,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1)activities,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1)audits,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2)receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1)outbox,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent",
      [fixtures.orgA, route],
    )
  ).rows[0];
}
async function unchanged(operation: () => Promise<unknown>) {
  const before = await effects();
  await operation();
  expect(await effects()).toEqual(before);
}
async function direct<T>(
  operation: (crm: CrmService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(
    runtime,
    { userId: fixtures.agentUser, organizationId: fixtures.orgA },
    (client, context) => operation(new CrmService(client, context, randomUUID()), client, context),
  );
}
const command = (body: unknown = input(), key = randomUUID()) =>
  direct((crm) => crm.postTask(body, key, route));
async function grants<T>(
  operation: () => Promise<T>,
  options: { remove?: string[]; scope?: PermissionGrant["scope"] } = {},
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    )
  ).rows[0];
  const next = (original.permission_grants as PermissionGrant[])
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) => ({ ...g, scope: g.code === "crm.tasks.write" ? (options.scope ?? g.scope) : g.scope }));
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      original.id,
      JSON.stringify(next),
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
async function capability<T>(operation: () => Promise<T>, state = "enabled") {
  const original = (
    await admin.query(
      "SELECT state,effective_until FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA],
    )
  ).rows[0];
  try {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=NULL WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, state],
    );
    return await operation();
  } finally {
    await admin.query(
      "UPDATE app.entitlement SET state=$2,effective_until=$3 WHERE tenant_id=$1 AND feature='crm'",
      [fixtures.orgA, original.state, original.effective_until],
    );
  }
}
async function office() {
  const id = randomUUID();
  await admin.query("INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,$3,'UTC')", [
    fixtures.orgA,
    id,
    "Owned follow-up office " + id,
  ]);
  await admin.query(
    "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
    [fixtures.orgA, id, fixtures.agentMemberA, fixtures.ownerMemberA],
  );
  return id;
}
async function waitForLock() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (
      (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock')waiting",
          [runtimeName],
        )
      ).rows[0].waiting
    )
      return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("Owned Task creation did not observe a real database lock wait.");
}
async function held<T>(
  lock: (client: PoolClient) => Promise<unknown>,
  launch: () => Promise<T>,
  change: (client: PoolClient) => Promise<unknown>,
  assertion: (pending: Promise<T>) => Promise<unknown>,
) {
  const blocker = await admin.connect();
  let pending: Promise<T> | undefined;
  try {
    await blocker.query("BEGIN");
    await lock(blocker);
    pending = launch();
    void pending.catch(() => undefined);
    await waitForLock();
    await change(blocker);
    await blocker.query("COMMIT");
    await assertion(pending);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await pending?.catch(() => undefined);
  }
}
beforeAll(async () => {
  await assertRuntimeRole(runtime);
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  if (agent?.cookie) await agent.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("ADR044 exact Task creation receipt and transaction effects", () => {
  it("keyless internal Task creation refuses before any database query", async () => {
    const context = await direct(async (_crm, _client, context) => context);
    let queries = 0;
    const client = {
      query: () => {
        queries++;
        throw new Error("Unexpected query.");
      },
    } as unknown as PoolClient;
    await expect(
      new CrmService(client, context, randomUUID()).create("tasks", input()),
    ).rejects.toMatchObject({ status: 503, code: "task_command_required" });
    expect(queries).toBe(0);
  });
  it("linked creation normalizes title/instant and keeps description/zone alias with one safe activity/audit/receipt", async () => {
    const { leadId } = await source(),
      before = await effects(),
      dbBefore = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    const task = await receipt(await post(input(leadId)));
    expect(task).toMatchObject({
      leadId,
      assigneeMemberId: fixtures.agentMemberA,
      title: "Synthetic private task",
      description: input().description,
      dueAt: "2026-11-01T09:30:00.123Z",
      timezone: "US/Pacific",
      priority: "normal",
      state: "open",
    });
    expect(await effects()).toEqual({
      ...before,
      tasks: before.tasks + 1,
      activities: before.activities + 1,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
    });
    const audit = (
      await admin.query(
        "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
        [fixtures.orgA, task.id],
      )
    ).rows;
    expect(audit).toEqual([{ action: "task.created", safe_diff: { resourceVersion: 1 } }]);
    const activity = (
      await admin.query(
        "SELECT lead_id,event_type,occurred_at,safe_data FROM app.activity_event WHERE tenant_id=$1 AND safe_data->>'resourceId'=$2",
        [fixtures.orgA, task.id],
      )
    ).rows;
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ lead_id: leadId, event_type: "task.created" });
    expect(activity[0].safe_data).toEqual({
      resourceId: task.id,
      resourceVersion: 1,
      relatedResourceIds: [leadId],
    });
    const now = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    expect(activity[0].occurred_at.getTime()).toBeGreaterThanOrEqual(dbBefore.getTime());
    expect(activity[0].occurred_at.getTime()).toBeLessThanOrEqual(now.getTime());
    for (const value of [JSON.stringify(audit), JSON.stringify(activity)]) {
      expect(value).not.toContain("PRIVATE_DESCRIPTION");
      expect(value).not.toContain("Synthetic private task");
    }
    expect(
      (
        await admin.query("SELECT event_type FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2", [
          fixtures.orgA,
          task.id,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await admin.query(
          "SELECT response_ref FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND response_ref=$3",
          [fixtures.orgA, route, task.id],
        )
      ).rows,
    ).toEqual([{ response_ref: task.id }]);
  });
  it("standalone creation has no Lead timeline row and never emits task.due", async () => {
    const before = await effects(),
      task = await receipt(await post(input(null)));
    expect(task.leadId ?? null).toBeNull();
    expect(await effects()).toEqual({
      ...before,
      tasks: before.tasks + 1,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
    });
  });
  it("concurrent same-key submissions create one Task and one linked activity/audit/receipt", async () => {
    const { leadId } = await source(),
      body = input(leadId),
      key = randomUUID(),
      before = await effects();
    const tasks = await Promise.all((await Promise.all([post(body, key), post(body, key)])).map(receipt));
    expect(tasks[0]).toEqual(tasks[1]);
    expect(await effects()).toEqual({
      ...before,
      tasks: before.tasks + 1,
      activities: before.activities + 1,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
    });
  });
  it("different explicit keys create deliberate independent Tasks rather than deduping by title/time", async () => {
    const { leadId } = await source(),
      body = input(leadId),
      keys = [randomUUID(), randomUUID()],
      before = await effects();
    expect(keys[0]).not.toBe(keys[1]);
    const tasks = await Promise.all((await Promise.all(keys.map((key) => post(body, key)))).map(receipt));
    expect(tasks[0].id).not.toBe(tasks[1].id);
    expect(await effects()).toEqual({
      ...before,
      tasks: before.tasks + 2,
      activities: before.activities + 2,
      audits: before.audits + 2,
      receipts: before.receipts + 2,
    });
    await unchanged(async () => {
      const replayed = await Promise.all(
        (await Promise.all(keys.map((key) => post(body, key)))).map(receipt),
      );
      expect(replayed).toEqual(tasks);
    });
  });
  it("historical receipt after later Task update returns version1 without replacing current version/title/state", async () => {
    const key = randomUUID(),
      body = input(),
      first = await receipt(await post(body, key));
    await admin.query(
      "UPDATE app.task SET title='LATER_PRIVATE_TITLE',state='done',row_version=3 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, first.id],
    );
    await unchanged(async () => {
      expect(await receipt(await post(body, key))).toEqual(first);
    });
    expect(
      (
        await admin.query("SELECT title,state,row_version::text FROM app.task WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          first.id,
        ])
      ).rows[0],
    ).toEqual({ title: "LATER_PRIVATE_TITLE", state: "done", row_version: "3" });
  });
  it("every exact original body field binds key despite normalization equivalence", async () => {
    const body = input(),
      key = randomUUID();
    await receipt(await post(body, key));
    await unchanged(async () => {
      for (const patch of [
        { title: body.title.trim() },
        { dueAt: "2026-11-01T09:30:00.123Z" },
        { description: body.description?.trim() },
        { timezone: "America/Los_Angeles" },
        { priority: "normal" },
        { state: "open" },
      ])
        await assertProblem(await post({ ...body, ...patch }, key), 409);
    });
  });
  it("legacy canonical hash and null stored reference/ETag preserve exact unexpired historical replay", async () => {
    const body = input(),
      key = randomUUID(),
      first = await receipt(await post(body, key));
    const hash = createHash("sha256")
      .update(stable({ body, expectedVersion: null }))
      .digest("hex");
    await admin.query(
      "UPDATE app.idempotency_record SET request_hash=$3,response_etag=NULL,response_ref=NULL WHERE tenant_id=$1 AND key=$2 AND route_key=$4",
      [fixtures.orgA, key, hash, route],
    );
    await unchanged(async () => {
      expect(await receipt(await post(body, key))).toEqual(first);
    });
  });
  it("stored source reference cannot be substituted even with a matching historical body", async () => {
    const body = input(),
      key = randomUUID();
    await receipt(await post(body, key));
    await admin.query("UPDATE app.idempotency_record SET response_ref=$3 WHERE tenant_id=$1 AND key=$2", [
      fixtures.orgA,
      key,
      randomUUID(),
    ]);
    await unchanged(async () => {
      await assertProblem(await post(body, key), 503);
    });
  });
  it("expired matching receipt denies without renewal/replacement/Task or timeline effects", async () => {
    const body = input(),
      key = randomUUID();
    await receipt(await post(body, key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND key=$2 AND route_key=$3",
      [fixtures.orgA, key, route],
    );
    const original = (
      await admin.query(
        "SELECT expires_at,response_body,request_hash FROM app.idempotency_record WHERE tenant_id=$1 AND key=$2",
        [fixtures.orgA, key],
      )
    ).rows[0];
    await unchanged(async () => {
      expect((await assertProblem(await post(body, key), 409)).code).toBe("receipt_expired");
    });
    expect(
      (
        await admin.query(
          "SELECT expires_at,response_body,request_hash FROM app.idempotency_record WHERE tenant_id=$1 AND key=$2",
          [fixtures.orgA, key],
        )
      ).rows[0],
    ).toEqual(original);
  });
  it("corrupt or nonmatching stored receipt cannot return an unvalidated Task", async () => {
    const body = input(),
      key = randomUUID(),
      first = await receipt(await post(body, key));
    await admin.query("UPDATE app.idempotency_record SET response_body=$3 WHERE tenant_id=$1 AND key=$2", [
      fixtures.orgA,
      key,
      JSON.stringify({ ...first, dueAt: "2026-11-01T08:30:00.123Z" }),
    ]);
    await unchanged(async () => {
      await assertProblem(await post(body, key), 503);
    });
  });
  it("optional omission/default/empty description and closed valid done/cancelled states keep exact meaning", async () => {
    const minimal = input();
    delete minimal.description;
    const task = await receipt(await post(minimal));
    expect(task).toMatchObject({ priority: "normal", state: "open" });
    expect(task.description ?? null).toBeNull();
    for (const state of ["done", "cancelled"] as const) {
      const task = await receipt(await post({ ...input(), state, description: "" }));
      expect(task).toMatchObject({ state, description: "" });
    }
  });
  it("schema/query/key/CSRF/origin and invalid unnamed zones reject without effects", async () => {
    await unchanged(async () => {
      for (const body of [
        {},
        { ...input(), ownerMemberId: fixtures.ownerMemberA },
        { ...input(), title: " " },
        { ...input(), description: null },
        { ...input(), dueAt: "not-a-time" },
        { ...input(), timezone: "+01:00" },
        { ...input(), timezone: "PST" },
        { ...input(), timezone: "GMT" },
      ])
        await assertProblem(await post(body), 422);
      await assertProblem(await agent.command(path + "?filter=undeclared", input()), 422);
      await assertProblem(await agent.command(path, input(), { csrf: "invalid" }), 403);
      await assertProblem(
        await agent.request(path, {
          method: "POST",
          headers: {
            "idempotency-key": randomUUID(),
            "x-csrf-token": agent.csrf,
            origin: "https://foreign.invalid",
          },
          body: JSON.stringify(input()),
        }),
        403,
      );
      await assertProblem(
        await agent.request(path, {
          method: "POST",
          headers: { "x-csrf-token": agent.csrf },
          body: JSON.stringify(input()),
        }),
        400,
      );
    });
  });
  it("caller rollback removes Task, linked activity, audit and receipt with no outbox change", async () => {
    const { leadId } = await source();
    await unchanged(async () => {
      await expect(
        direct(async (crm) => {
          await crm.postTask(input(leadId), randomUUID(), route);
          throw new Error("OWNED_ROLLBACK");
        }),
      ).rejects.toThrow("OWNED_ROLLBACK");
    });
  });
});

describe("Task-write-only current source/assignee authority", () => {
  it("sole tasks.write gate supports linked and standalone creation/replay without read or Lead-write prerequisites", async () => {
    const { leadId } = await source();
    await grants(
      async () => {
        for (const body of [input(), input(leadId)]) {
          const key = randomUUID(),
            first = await receipt(await post(body, key));
          await unchanged(async () => {
            expect(await receipt(await post(body, key))).toEqual(first);
          });
        }
      },
      {
        remove: [
          "crm.tasks.read",
          "crm.leads.read",
          "crm.leads.write",
          "crm.contacts.read",
          "crm.contacts.write",
        ],
      },
    );
  });
  it("own scope independently limits assignee and linked Lead owner", async () => {
    const outside = await source({ owner: fixtures.ownerMemberA });
    await unchanged(async () => {
      await assertProblem(await post({ ...input(), assigneeMemberId: fixtures.ownerMemberA }), 422);
      await assertProblem(await post(input(outside.leadId)), 404);
    });
  });
  it("team scope requires shared office for both assignee and linked owner; organization scope permits outside-self", async () => {
    const outside = await source({ owner: fixtures.ownerMemberA }),
      officeId = await office(),
      body = { ...input(outside.leadId), assigneeMemberId: fixtures.ownerMemberA };
    await grants(
      async () => {
        await receipt(await post(body));
      },
      { scope: "team" },
    );
    await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
      fixtures.orgA,
      officeId,
      fixtures.ownerMemberA,
    ]);
    await grants(
      () =>
        unchanged(async () => {
          await assertProblem(await post(body), 422);
        }),
      { scope: "team" },
    );
    await grants(
      async () => {
        await receipt(await post(body));
      },
      { scope: "organization" },
    );
  });
  it("foreign/archived Lead and Contact sources never create a linked Task", async () => {
    const foreign = await source({ org: fixtures.orgB });
    await unchanged(async () => {
      await assertProblem(await post(input(foreign.leadId)), 404);
      await assertProblem(await post({ ...input(), assigneeMemberId: fixtures.ownerMemberB }), 422);
    });
    for (const kind of ["lead", "contact"] as const) {
      const own = await source();
      await admin.query(`UPDATE app.${kind} SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [
        fixtures.orgA,
        kind === "lead" ? own.leadId : own.contactId,
      ]);
      await unchanged(async () => {
        await assertProblem(await post(input(own.leadId)), 404);
      });
    }
  });
  it("current source reassignment and current Task assignee change deny cached historical receipt", async () => {
    const own = await source(),
      body = input(own.leadId),
      key = randomUUID(),
      task = await receipt(await post(body, key));
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      own.leadId,
      fixtures.ownerMemberA,
    ]);
    await unchanged(async () => {
      await assertProblem(await post(body, key), 404);
    });
    const standalone = input(),
      standaloneKey = randomUUID(),
      other = await receipt(await post(standalone, standaloneKey));
    await admin.query("UPDATE app.task SET assignee_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      other.id,
      fixtures.ownerMemberA,
    ]);
    await unchanged(async () => {
      await assertProblem(await post(standalone, standaloneKey), 404);
    });
    expect(task.leadId).toBe(own.leadId);
  });
  it("accessible current relink cannot authorize historical receipt for an archived original Lead", async () => {
    const original = await source(),
      current = await source(),
      body = input(original.leadId),
      key = randomUUID(),
      task = await receipt(await post(body, key));
    await admin.query("UPDATE app.task SET lead_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      task.id,
      current.leadId,
    ]);
    await admin.query("UPDATE app.lead SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      original.leadId,
    ]);
    await unchanged(async () => {
      await assertProblem(await post(body, key), 404);
    });
  });
  it("current eligible reassignment cannot authorize a cached Task from an original disabled assignee", async () => {
    await grants(
      async () => {
        const body = { ...input(), assigneeMemberId: fixtures.ownerMemberA },
          key = randomUUID(),
          task = await receipt(await post(body, key));
        await admin.query("UPDATE app.task SET assignee_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          task.id,
          fixtures.agentMemberA,
        ]);
        await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixtures.ownerMemberA,
        ]);
        try {
          await unchanged(async () => {
            await assertProblem(await post(body, key), 404);
          });
        } finally {
          await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            fixtures.ownerMemberA,
          ]);
        }
      },
      { scope: "organization" },
    );
  });
  it("current permission/membership/capability revocation applies before replay", async () => {
    const key = randomUUID(),
      body = input();
    await receipt(await post(body, key));
    await grants(
      () =>
        unchanged(async () => {
          await assertProblem(await post(body, key), 403);
        }),
      { remove: ["crm.tasks.write"] },
    );
    await capability(
      () =>
        unchanged(async () => {
          await assertProblem(await post(body, key), 403);
        }),
      "disabled",
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(async () => {
        await assertProblem(await post(body, key), 403);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("forged/missing context and pooled role reuse cannot create or disclose Tasks", async () => {
    const context = await direct(async (_crm, _client, context) => context),
      client = await runtime.connect();
    try {
      await expect(
        new CrmService(client, context, randomUUID()).postTask(input(), randomUUID(), route),
      ).rejects.toMatchObject({ status: 403 });
      expect((await client.query("SELECT id FROM app.task")).rowCount).toBe(0);
    } finally {
      client.release();
    }
    for (const patch of [
      { userId: fixtures.ownerUser },
      { memberId: fixtures.ownerMemberA },
      { organizationId: fixtures.orgB },
      { roleId: randomUUID() },
      { permissions: [] },
    ])
      await unchanged(() =>
        direct(async (_crm, client, current) => {
          await expect(
            new CrmService(client, { ...current, ...patch }, randomUUID()).postTask(
              input(),
              randomUUID(),
              "POST /v1/orgs/" + (patch.organizationId ?? fixtures.orgA) + "/tasks",
            ),
          ).rejects.toMatchObject({ status: 403 });
        }),
      );
    await command();
    expect((await runtime.query("SELECT id FROM app.task")).rowCount).toBe(0);
  });
});

describe("actual waited Task creation boundaries", () => {
  it("Lead reassignment committed during observed row wait removes linked own scope", async () => {
    const own = await source();
    await unchanged(() =>
      held(
        (b) =>
          b.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            own.leadId,
          ]),
        () => command(input(own.leadId)),
        (b) =>
          b.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            own.leadId,
            fixtures.ownerMemberA,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("Contact archive committed during observed source wait prevents every Task effect", async () => {
    const own = await source();
    await unchanged(() =>
      held(
        (b) =>
          b.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            own.contactId,
          ]),
        () => command(input(own.leadId)),
        (b) =>
          b.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            own.contactId,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("assignee disabled during observed membership lock wait cannot receive a Task", async () => {
    try {
      await grants(
        () =>
          unchanged(() =>
            held(
              (b) =>
                b.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                  fixtures.orgA,
                  fixtures.ownerMemberA,
                ]),
              () => command({ ...input(), assigneeMemberId: fixtures.ownerMemberA }),
              (b) =>
                b.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
                  fixtures.orgA,
                  fixtures.ownerMemberA,
                ]),
              async (p) => {
                await expect(p).rejects.toMatchObject({ status: 422 });
              },
            ),
          ),
        { scope: "organization" },
      );
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
    }
  });
  it("team assignee office removal during actual relationship wait denies fresh assignment", async () => {
    const officeId = await office();
    await grants(
      () =>
        unchanged(() =>
          held(
            (b) =>
              b.query(
                "SELECT member_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, officeId, fixtures.ownerMemberA],
              ),
            () => command({ ...input(), assigneeMemberId: fixtures.ownerMemberA }),
            (b) =>
              b.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                officeId,
                fixtures.ownerMemberA,
              ]),
            async (p) => {
              await expect(p).rejects.toMatchObject({ status: 422 });
            },
          ),
        ),
      { scope: "team" },
    );
  });
  it.each(["advisory", "lead", "contact", "assignee"] as const)(
    "CRM expiry after an observed %s wait denies before transaction effects",
    async (kind) => {
      const own = await source(),
        key = randomUUID(),
        body = {
          ...input(own.leadId),
          assigneeMemberId: kind === "assignee" ? fixtures.ownerMemberA : fixtures.agentMemberA,
        };
      await grants(
        () =>
          capability(async () => {
            await admin.query(
              "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '700 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
              [fixtures.orgA],
            );
            await unchanged(() =>
              held(
                (b) =>
                  kind === "advisory"
                    ? b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                        fixtures.orgA + ":" + fixtures.agentUser + ":" + route + ":" + key,
                      ])
                    : b.query(
                        `SELECT id FROM app.${kind === "assignee" ? "membership" : kind} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
                        [
                          fixtures.orgA,
                          kind === "lead"
                            ? own.leadId
                            : kind === "contact"
                              ? own.contactId
                              : fixtures.ownerMemberA,
                        ],
                      ),
                () => command(body, key),
                async () => {
                  await admin.query("SELECT pg_sleep(0.8)");
                },
                async (p) => {
                  await expect(p).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
                },
              ),
            );
          }),
        { scope: "organization" },
      );
    },
  );
  it("waits on a linked Lead without holding the assignee membership, matching Lead PATCH order", async () => {
    const own = await source();
    const probe = await admin.connect();
    let result: unknown;
    try {
      await grants(
        () =>
          held(
            (b) =>
              b.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                fixtures.orgA,
                own.leadId,
              ]),
            () => command({ ...input(own.leadId), assigneeMemberId: fixtures.ownerMemberA }),
            async () => {
              // A member update must not queue behind the Task command while it waits for the Lead.
              await probe.query("BEGIN");
              await probe.query(
                "SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT",
                [fixtures.orgA, fixtures.ownerMemberA],
              );
              await probe.query("ROLLBACK");
            },
            async (p) => {
              result = await p;
            },
          ),
        { scope: "organization" },
      );
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      probe.release();
    }
    expect(result).toMatchObject({ body: { assigneeMemberId: fixtures.ownerMemberA, leadId: own.leadId } });
  });
  it("original due/body remain detached after advisory wait and replay cannot convert time twice", async () => {
    const body = input(),
      original = { ...body },
      key = randomUUID();
    let result: unknown;
    await held(
      (b) =>
        b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          fixtures.orgA + ":" + fixtures.agentUser + ":" + route + ":" + key,
        ]),
      () => command(body, key),
      async () => {
        body.title = "MUTATED";
        body.dueAt = "2026-11-01T08:30:00Z";
        body.timezone = "UTC";
      },
      async (p) => {
        result = await p;
      },
    );
    expect(result).toMatchObject({
      body: { title: "Synthetic private task", dueAt: "2026-11-01T09:30:00.123Z", timezone: "US/Pacific" },
    });
    await unchanged(async () => {
      expect(await command(original, key)).toEqual(result);
    });
  });
});
