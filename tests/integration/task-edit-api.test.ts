import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService, stable } from "../../apps/api/src/crm-service";
import { fixtures, stageId } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type TenantContext,
  type PermissionGrant,
} from "../../packages/db/tenant-transaction";
import { ApiSession, assertContract, assertProblem as contractProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Task edit acceptance requires an owned file-fresh disposable database.");
}
const runtimeName = "task_edit_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
let owner: ApiSession, agent: ApiSession;
const path = (id: string, org: string = fixtures.orgA) => `/v1/orgs/${org}/tasks/${id}`;
const route = (id: string, org: string = fixtures.orgA) => "PATCH " + path(id, org);
async function problem(response: Response, status: number, code?: string) {
  const value = await contractProblem(response, status);
  if (code) expect(value.code).toBe(code);
  return value;
}
async function source(member: string = fixtures.ownerMemberA, org: string = fixtures.orgA) {
  const id = randomUUID(),
    contactId = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'PRIVATE_TASK_CONTACT',$3)",
    [org, contactId, member],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id)VALUES($1,$2,$3,$4,$5,$6)",
    [
      org,
      id,
      contactId,
      org === fixtures.orgA ? fixtures.sourceA : fixtures.sourceB,
      stageId(org === fixtures.orgA ? 1 : 2, 1),
      member,
    ],
  );
  return { id, contactId };
}
async function task(
  options: { assignee?: string; lead?: string | null; org?: string; state?: Schemas["Task"]["state"] } = {},
): Promise<Schemas["Task"]> {
  const id = randomUUID(),
    org = options.org ?? fixtures.orgA,
    assignee = options.assignee ?? fixtures.ownerMemberA;
  const value: Schemas["Task"] = {
    id,
    assigneeMemberId: assignee,
    leadId: options.lead ?? null,
    title: "PRIVATE_TASK_TITLE",
    description: " PRIVATE_DESCRIPTION ",
    dueAt: "2026-11-01T09:30:00.123Z",
    timezone: "US/Pacific",
    priority: "high",
    state: options.state ?? "open",
    version: 1,
  };
  await admin.query(
    "INSERT INTO app.task(tenant_id,id,lead_id,assignee_member_id,title,description,due_at,due_timezone,priority,state)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      org,
      id,
      value.leadId,
      assignee,
      value.title,
      value.description,
      value.dueAt,
      value.timezone,
      value.priority,
      value.state,
    ],
  );
  return value;
}
function write(value: Schemas["Task"], patch: Partial<Schemas["TaskWrite"]> = {}): Schemas["TaskWrite"] {
  return {
    assigneeMemberId: value.assigneeMemberId,
    title: " Edited private title ",
    dueAt: value.dueAt,
    timezone: value.timezone,
    ...patch,
  };
}
const patch = (
  value: Schemas["Task"],
  body: unknown = write(value),
  key = randomUUID(),
  revision = `"${value.version}"`,
  session: ApiSession = owner,
) => session.command(path(value.id, session.orgId), body, { method: "PATCH", key, revision });
async function receipt(response: Response, version = 2): Promise<Schemas["Task"]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe(`"${version}"`);
  const value = await response.json();
  assertContract("Task", value);
  expect(value.version).toBe(version);
  return value;
}
async function effects(id: string) {
  return (
    await admin.query(
      "SELECT(SELECT to_jsonb(t) FROM app.task t WHERE tenant_id=$1 AND id=$2::uuid)task,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text)audits,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1 AND safe_data->>'resourceId'=$2::text)activities,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$3)receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1)outbox,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent",
      [fixtures.orgA, id, route(id)],
    )
  ).rows[0];
}
async function unchanged(id: string, operation: () => Promise<unknown>) {
  const before = await effects(id);
  await operation();
  expect(await effects(id)).toEqual(before);
}
async function direct<T>(
  operation: (crm: CrmService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(
    runtime,
    { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
    (client, context) => operation(new CrmService(client, context, randomUUID()), client, context),
  );
}
const command = (
  value: Schemas["Task"],
  body: unknown = write(value),
  key = randomUUID(),
  revision = `"${value.version}"`,
) => direct((crm) => crm.patchTask(value.id, body, revision, key, route(value.id)));
async function grants<T>(
  operation: () => Promise<T>,
  options: { remove?: string[]; scope?: PermissionGrant["scope"]; leadScope?: PermissionGrant["scope"] } = {},
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.ownerMemberA],
    )
  ).rows[0];
  const next = (original.permission_grants as PermissionGrant[])
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) => ({
      ...g,
      scope:
        g.code === "crm.tasks.write"
          ? (options.scope ?? g.scope)
          : ["crm.leads.read", "crm.leads.write"].includes(g.code)
            ? (options.leadScope ?? g.scope)
            : g.scope,
    }));
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
    "Owned task edit office " + id,
  ]);
  await admin.query(
    "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
    [fixtures.orgA, id, fixtures.ownerMemberA, fixtures.agentMemberA],
  );
  return id;
}
async function removeOffice(id: string) {
  await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [fixtures.orgA, id]);
  await admin.query("DELETE FROM app.office WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]);
}
async function waitForLock() {
  for (let i = 0; i < 150; i++) {
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
  throw new Error("Task PATCH did not observe its real owned lock wait.");
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
  owner = await new ApiSession().signIn();
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  for (const session of [owner, agent])
    if (session)
      await session
        .request("/dev/session", { method: "DELETE", headers: { "X-CSRF-Token": session.csrf } })
        .catch(() => undefined);
  await runtime.end();
  await admin.end();
});

describe("ADR-046 dedicated complete Task PATCH", () => {
  it("closes keyless generic updates before any query", async () => {
    let calls = 0;
    const crm = new CrmService(
      {
        query: async () => {
          calls++;
          throw new Error();
        },
      } as unknown as PoolClient,
      {} as TenantContext,
      randomUUID(),
    );
    await expect(crm.update("tasks", randomUUID(), {}, '"1"')).rejects.toMatchObject({
      status: 503,
      code: "task_command_required",
    });
    expect(calls).toBe(0);
  });
  it("preserves omitted optional values and canonicalizes title/instant while retaining exact alias", async () => {
    const s = await source(),
      t = await task({ lead: s.id }),
      key = randomUUID();
    const value = await receipt(await patch(t, write(t), key));
    expect(value).toEqual({ ...t, title: "Edited private title", version: 2 });
    const saved = (
      await admin.query(
        "SELECT request_hash,response_ref,response_etag,status_code,response_body FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(t.id), key],
      )
    ).rows[0];
    expect(saved).toMatchObject({
      response_ref: t.id,
      response_etag: '"2"',
      status_code: 200,
      response_body: value,
      request_hash: createHash("sha256")
        .update(stable({ body: write(t), expectedVersion: '"1"' }))
        .digest("hex"),
    });
    expect(await effects(t.id)).toMatchObject({ audits: 1, activities: 0, receipts: 1 });
  });
  it("explicit empty description and authorized null link clear exactly", async () => {
    const s = await source(),
      t = await task({ lead: s.id });
    expect(
      await receipt(
        await patch(t, write(t, { description: "", leadId: null, priority: "low", state: "cancelled" })),
      ),
    ).toMatchObject({ description: "", leadId: null, priority: "low", state: "cancelled" });
  });
  it("appends one references-only DB-time completion activity including standalone, no outbox or lead change", async () => {
    const t = await task(),
      before = await effects(t.id),
      clock = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    await receipt(await patch(t, write(t, { state: "done" })));
    const rows = (
      await admin.query(
        "SELECT lead_id,event_type,source_event_id,safe_data,occurred_at FROM app.activity_event WHERE tenant_id=$1 AND safe_data->>'resourceId'=$2",
        [fixtures.orgA, t.id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lead_id: null,
      event_type: "task.completed",
      safe_data: { resourceId: t.id, resourceVersion: 2 },
    });
    expect(rows[0].source_event_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(rows[0].occurred_at.getTime()).toBeGreaterThanOrEqual(clock.getTime());
    expect(JSON.stringify(rows)).not.toContain("PRIVATE");
    const after = await effects(t.id);
    expect(after).toMatchObject({ audits: 1, activities: 1, outbox: before.outbox, consent: before.consent });
  });
  it("done-to-done and replay add no completion; reopen then complete is a new transition", async () => {
    const t = await task(),
      key = randomUUID(),
      body = write(t, { state: "done" });
    const first = await receipt(await patch(t, body, key));
    expect(await receipt(await patch(t, body, key))).toEqual(first);
    const edited = await receipt(await patch(first, write(first, { state: "done" })), 3);
    expect(await effects(t.id)).toMatchObject({ activities: 1, audits: 2 });
    const open = await receipt(await patch(edited, write(edited, { state: "open" })), 4);
    await receipt(await patch(open, write(open, { state: "done" })), 5);
    expect(await effects(t.id)).toMatchObject({ activities: 2, audits: 4 });
  });
  it("historical receipt retains exact old body/ETag after a later edit without overwriting current", async () => {
    const t = await task(),
      key = randomUUID(),
      body = write(t, { state: "done" }),
      old = await receipt(await patch(t, body, key));
    await receipt(await patch(old, write(old, { title: "Newer", state: "open" })), 3);
    await unchanged(t.id, async () => expect(await receipt(await patch(t, body, key))).toEqual(old));
  });
  it("deduplicates same-key concurrent calls", async () => {
    const t = await task(),
      key = randomUUID(),
      body = write(t, { state: "done" });
    const results = await Promise.all([patch(t, body, key), patch(t, body, key)]);
    expect(await receipt(results[0]!)).toEqual(await receipt(results[1]!));
    expect(await effects(t.id)).toMatchObject({ audits: 1, activities: 1, receipts: 1 });
  });
  it("distinct keys on one version permit one CAS and one 412", async () => {
    const t = await task(),
      responses = await Promise.all([patch(t), patch(t)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 412]);
    expect(await effects(t.id)).toMatchObject({ audits: 1, activities: 0, receipts: 1 });
  });
  it("preserves legacy bare/leading-zero hash spelling and null stored ref/ETag", async () => {
    const t = await task(),
      key = randomUUID(),
      body = write(t),
      old = await receipt(await patch(t, body, key, "001"));
    await admin.query(
      "UPDATE app.idempotency_record SET response_ref=NULL,response_etag=NULL WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(t.id), key],
    );
    await unchanged(t.id, async () => {
      expect(await receipt(await patch(t, body, key, "001"))).toEqual(old);
      await problem(await patch(t, body, key, '"1"'), 409, "idempotency_conflict");
    });
  });
  it("changed same-key body conflicts with zero effects", async () => {
    const t = await task(),
      key = randomUUID();
    await receipt(await patch(t, write(t), key));
    await unchanged(
      t.id,
      async () => await problem(await patch(t, write(t, { title: "changed" }), key), 409),
    );
  });
  it("expired matching receipt never executes or renews", async () => {
    const t = await task(),
      key = randomUUID();
    await receipt(await patch(t, write(t), key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(t.id), key],
    );
    await unchanged(t.id, async () => await problem(await patch(t, write(t), key), 409, "receipt_expired"));
  });
  it.each(["response_ref", "response_etag", "response_body"])(
    "rejects corrupt %s before disclosing a cached Task",
    async (field) => {
      const t = await task(),
        key = randomUUID();
      await receipt(await patch(t, write(t), key));
      if (field === "response_body")
        await admin.query(
          "UPDATE app.idempotency_record SET response_body=jsonb_set(response_body,'{title}','\"WRONG_TITLE\"'::jsonb) WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
          [fixtures.orgA, route(t.id), key],
        );
      else
        await admin.query(
          `UPDATE app.idempotency_record SET ${field}=$4 WHERE tenant_id=$1 AND route_key=$2 AND key=$3`,
          [fixtures.orgA, route(t.id), key, field === "response_ref" ? randomUUID() : '"99"'],
        );
      await unchanged(t.id, async () => await problem(await patch(t, write(t), key), 503));
    },
  );
  it("rolls task/activity/audit/receipt back with the caller transaction", async () => {
    const t = await task();
    await unchanged(
      t.id,
      async () =>
        await expect(
          direct(async (crm) => {
            await crm.patchTask(t.id, write(t, { state: "done" }), '"1"', randomUUID(), route(t.id));
            throw new Error("owned rollback");
          }),
        ).rejects.toThrow("owned rollback"),
    );
  });
  it("strictly rejects query/body/revision/key/CSRF/origin errors without effects", async () => {
    const t = await task();
    await unchanged(t.id, async () => {
      await problem(
        await owner.command(path(t.id) + "?extra=1", write(t), { method: "PATCH", revision: '"1"' }),
        422,
        "query_invalid",
      );
      await problem(await patch(t, { ...write(t), unknown: "PRIVATE" }), 422);
      await problem(await patch(t, write(t), randomUUID(), 'W/"1"'), 400);
      await problem(
        await owner.request(path(t.id), {
          method: "PATCH",
          headers: { "X-CSRF-Token": owner.csrf, "If-Match": '"1"' },
          body: JSON.stringify(write(t)),
        }),
        400,
      );
      await problem(
        await owner.command(path(t.id), write(t), { method: "PATCH", revision: '"1"', csrf: "wrong" }),
        403,
      );
      await problem(
        await owner.request(path(t.id), {
          method: "PATCH",
          headers: {
            Origin: "https://foreign.invalid",
            "X-CSRF-Token": owner.csrf,
            "Idempotency-Key": randomUUID(),
            "If-Match": '"1"',
          },
          body: JSON.stringify(write(t)),
        }),
        403,
      );
    });
  });
  it("safe maximum exhausts with zero writes; unsafe current revision is unavailable", async () => {
    const t = await task();
    await admin.query("UPDATE app.task SET row_version=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      t.id,
      Number.MAX_SAFE_INTEGER.toString(),
    ]);
    await unchanged(
      t.id,
      async () =>
        await problem(
          await patch(t, write(t), randomUUID(), `"${Number.MAX_SAFE_INTEGER}"`),
          409,
          "revision_exhausted",
        ),
    );
    await admin.query("UPDATE app.task SET row_version=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      t.id,
      (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString(),
    ]);
    await unchanged(t.id, async () => await problem(await patch(t), 503));
  });
});

describe("ADR-036 current and historical task/source authorization", () => {
  it("standalone write-only command needs no Task or Lead read", async () => {
    const t = await task();
    await grants(
      async () => {
        await receipt(await patch(t));
      },
      { remove: ["crm.tasks.read", "crm.leads.read", "crm.leads.write", "crm.contacts.read"] },
    );
  });
  it.each(["crm.leads.read", "crm.leads.write"])(
    "linked command still requires %s even explicit unlink/omission",
    async (code) => {
      const s = await source(),
        t = await task({ lead: s.id });
      await grants(
        () =>
          unchanged(t.id, async () => {
            await problem(await patch(t), 404);
            await problem(await patch(t, write(t, { leadId: null })), 404);
          }),
        { remove: [code] },
      );
    },
  );
  it("own scope intersects current task and proposed assignee", async () => {
    const t = await task(),
      foreign = await task({ assignee: fixtures.agentMemberA });
    await grants(
      async () => {
        await receipt(await patch(t));
        await unchanged(foreign.id, async () => await problem(await patch(foreign), 404));
        const own = await task();
        await unchanged(
          own.id,
          async () =>
            await problem(await patch(own, write(own, { assigneeMemberId: fixtures.agentMemberA })), 422),
        );
      },
      { scope: "own" },
    );
  });
  it("team eligibility requires current shared office and rejects office loss on replay", async () => {
    const officeId = await office(),
      t = await task({ assignee: fixtures.agentMemberA }),
      key = randomUUID();
    try {
      await grants(
        async () => {
          await receipt(await patch(t, write(t), key));
          await admin.query(
            "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
            [fixtures.orgA, officeId, fixtures.agentMemberA],
          );
          await unchanged(t.id, async () => await problem(await patch(t, write(t), key), 404));
        },
        { scope: "team" },
      );
    } finally {
      await removeOffice(officeId);
    }
  });
  it("foreign task/source and foreign/disabled proposed assignee are denied", async () => {
    const foreign = await task({ org: fixtures.orgB, assignee: fixtures.ownerMemberB }),
      s = await source(fixtures.ownerMemberB, fixtures.orgB),
      t = await task();
    await problem(await patch(foreign), 404);
    await unchanged(t.id, async () => {
      await problem(await patch(t, write(t, { leadId: s.id })), 404);
      await problem(await patch(t, write(t, { assigneeMemberId: fixtures.ownerMemberB })), 422);
      await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
      try {
        await problem(await patch(t, write(t, { assigneeMemberId: fixtures.agentMemberA })), 422);
      } finally {
        await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          fixtures.agentMemberA,
        ]);
      }
    });
  });
  it("org manager can explicitly repair disabled old assignee but cannot retain it", async () => {
    const t = await task({ assignee: fixtures.agentMemberA });
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(t.id, async () => await problem(await patch(t), 422));
      expect(
        await receipt(await patch(t, write(t, { assigneeMemberId: fixtures.ownerMemberA }))),
      ).toMatchObject({ assigneeMemberId: fixtures.ownerMemberA });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("historical assignee cannot borrow newly accessible current assignment", async () => {
    const t = await task({ assignee: fixtures.agentMemberA }),
      key = randomUUID(),
      body = write(t, { assigneeMemberId: fixtures.agentMemberA });
    await receipt(await patch(t, body, key));
    await admin.query(
      "UPDATE app.task SET assignee_member_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, t.id, fixtures.ownerMemberA],
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(t.id, async () => await problem(await patch(t, body, key), 404));
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("historical archived source denies replay after current relink", async () => {
    const old = await source(),
      current = await source(),
      t = await task({ lead: old.id }),
      key = randomUUID();
    await receipt(await patch(t, write(t), key));
    await admin.query(
      "UPDATE app.task SET lead_id=$3,row_version=row_version+1 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, t.id, current.id],
    );
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      old.contactId,
    ]);
    await unchanged(t.id, async () => await problem(await patch(t, write(t), key), 404));
  });
  it("grant, membership and capability revocation deny before cached replay", async () => {
    const t = await task(),
      key = randomUUID();
    await receipt(await patch(t, write(t), key));
    await grants(() => unchanged(t.id, async () => await problem(await patch(t, write(t), key), 403)), {
      remove: ["crm.tasks.write"],
    });
    await capability(
      () => unchanged(t.id, async () => await problem(await patch(t, write(t), key), 403)),
      "disabled",
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.ownerMemberA,
    ]);
    try {
      await unchanged(t.id, async () => await problem(await patch(t, write(t), key), 403));
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
    }
  });
  it("missing context and pooled forged authority cannot widen scope", async () => {
    const t = await task();
    const client = await runtime.connect();
    try {
      expect((await client.query("SELECT id FROM app.task WHERE id=$1", [t.id])).rows).toEqual([]);
    } finally {
      client.release();
    }
    await unchanged(
      t.id,
      async () =>
        await expect(
          direct((_crm, client, context) =>
            new CrmService(client, { ...context, organizationId: fixtures.orgB }, randomUUID()).patchTask(
              t.id,
              write(t),
              '"1"',
              randomUUID(),
              route(t.id, fixtures.orgB),
            ),
          ),
        ).rejects.toMatchObject({ status: 403 }),
    );
    const reused = await runtime.connect();
    try {
      expect((await reused.query("SELECT id FROM app.task")).rows).toEqual([]);
    } finally {
      reused.release();
    }
  });
});

describe("actual lock waits use current source and database clocks", () => {
  it("task wait cannot authorize old scope through an eligible proposed assignee", async () => {
    const officeId = await office(),
      t = await task({ assignee: fixtures.agentMemberA });
    try {
      await grants(
        () =>
          held(
            (c) => c.query("SELECT id FROM app.task WHERE id=$1 FOR UPDATE", [t.id]),
            () => command(t, write(t, { assigneeMemberId: fixtures.ownerMemberA })),
            (c) =>
              c.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                officeId,
                fixtures.agentMemberA,
              ]),
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 404 });
              expect(await effects(t.id)).toMatchObject({ audits: 0, activities: 0, receipts: 0 });
            },
          ),
        { scope: "team" },
      );
    } finally {
      await removeOffice(officeId);
    }
  });
  it.each(["contact", "lead"])("%s wait rechecks archive before writing", async (table) => {
    const s = await source(),
      t = await task({ lead: s.id }),
      id = table === "contact" ? s.contactId : s.id;
    await held(
      (c) => c.query(`SELECT id FROM app.${table} WHERE id=$1 FOR UPDATE`, [id]),
      () => command(t, write(t, { state: "done" })),
      (c) => c.query(`UPDATE app.${table} SET archived_at=clock_timestamp() WHERE id=$1`, [id]),
      async (pending) => {
        await expect(pending).rejects.toMatchObject({ status: 404 });
        expect(await effects(t.id)).toMatchObject({ audits: 0, activities: 0, receipts: 0 });
      },
    );
  });
  it("waits on a linked Lead without holding the assignee membership, matching Lead PATCH order", async () => {
    const s = await source(),
      t = await task({ assignee: fixtures.agentMemberA, lead: s.id });
    const probe = await admin.connect();
    let result: unknown;
    try {
      await held(
        (c) =>
          c.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [fixtures.orgA, s.id]),
        () => command(t, write(t, { state: "done" })),
        async () => {
          // A member update must not queue behind the Task command while it waits for the Lead.
          await probe.query("BEGIN");
          await probe.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE NOWAIT", [
            fixtures.orgA,
            fixtures.agentMemberA,
          ]);
          await probe.query("ROLLBACK");
        },
        async (pending) => {
          result = await pending;
        },
      );
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      probe.release();
    }
    expect(result).toMatchObject({ body: { id: t.id, state: "done", version: 2 } });
  });
  it("target membership wait rechecks current eligibility", async () => {
    const t = await task();
    try {
      await held(
        (c) =>
          c.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            fixtures.agentMemberA,
          ]),
        () => command(t, write(t, { assigneeMemberId: fixtures.agentMemberA })),
        (c) =>
          c.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            fixtures.agentMemberA,
          ]),
        async (pending) => {
          await expect(pending).rejects.toMatchObject({ status: 422 });
          expect(await effects(t.id)).toMatchObject({ audits: 0, receipts: 0 });
        },
      );
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("office wait rechecks team eligibility", async () => {
    const officeId = await office(),
      t = await task();
    try {
      await grants(
        () =>
          held(
            (c) =>
              c.query(
                "SELECT office_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, officeId, fixtures.agentMemberA],
              ),
            () => command(t, write(t, { assigneeMemberId: fixtures.agentMemberA })),
            (c) =>
              c.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                officeId,
                fixtures.agentMemberA,
              ]),
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 422 });
              expect(await effects(t.id)).toMatchObject({ audits: 0, receipts: 0 });
            },
          ),
        { scope: "team" },
      );
    } finally {
      await removeOffice(officeId);
    }
  });
  it("post-advisory CRM expiry denies and mutable caller data remains snapshotted", async () => {
    const t = await task(),
      key = randomUUID(),
      body = write(t);
    await capability(async () => {
      await admin.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND feature='crm'",
        [fixtures.orgA],
      );
      await held(
        (c) =>
          c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `${fixtures.orgA}:${fixtures.ownerUser}:${route(t.id)}:${key}`,
          ]),
        () => command(t, body, key),
        async (c) => {
          body.title = "Changed while waiting";
          await c.query("SELECT pg_sleep(1.1)");
        },
        async (pending) => {
          await expect(pending).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
          expect(await effects(t.id)).toMatchObject({ audits: 0, receipts: 0 });
        },
      );
    });
  });
  it("historical receipt expiry while Task waits cannot be renewed", async () => {
    const t = await task(),
      key = randomUUID();
    await receipt(await patch(t, write(t), key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()+interval '1 second' WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(t.id), key],
    );
    await held(
      (c) => c.query("SELECT id FROM app.task WHERE id=$1 FOR UPDATE", [t.id]),
      () => command(t, write(t), key),
      (c) => c.query("SELECT pg_sleep(1.1)"),
      async (pending) => {
        await expect(pending).rejects.toMatchObject({ status: 409, code: "receipt_expired" });
        expect(await effects(t.id)).toMatchObject({ audits: 1, receipts: 1 });
      },
    );
  });
  it("detaches original mutable TaskWrite before a Task wait", async () => {
    const t = await task(),
      body = write(t);
    await held(
      (c) => c.query("SELECT id FROM app.task WHERE id=$1 FOR UPDATE", [t.id]),
      () => command(t, body),
      async () => {
        body.title = "Mutated after wait";
        body.state = "done";
      },
      async (pending) => {
        expect((await pending).body).toMatchObject({ title: "Edited private title", state: "open" });
        expect(await effects(t.id)).toMatchObject({ activities: 0, audits: 1 });
      },
    );
  });
});

it("integrates manager capture, assignment, Agent create, drawer edit, completion and stage while replay never overwrites", async () => {
  const contact = await owner.command(`/v1/orgs/${fixtures.orgA}/contacts`, {
    displayName: "Synthetic integrated handoff",
  });
  expect(contact.status).toBe(201);
  const contactBody = await contact.json();
  assertContract("Contact", contactBody);
  const captured = await owner.command(`/v1/orgs/${fixtures.orgA}/leads`, {
    contactId: contactBody.id,
    sourceId: fixtures.sourceA,
    ownerMemberId: fixtures.ownerMemberA,
    intent: "buyer",
  });
  expect(captured.status).toBe(201);
  const lead = await captured.json();
  assertContract("Lead", lead);
  const handoff = await owner.command(
    `/v1/orgs/${fixtures.orgA}/leads/${lead.id}`,
    { ownerMemberId: fixtures.agentMemberA },
    { method: "PATCH", revision: '"1"' },
  );
  expect(handoff.status).toBe(200);
  const assigned = await handoff.json();
  assertContract("Lead", assigned);
  const createBody: Schemas["TaskWrite"] = {
      assigneeMemberId: fixtures.agentMemberA,
      leadId: lead.id,
      title: "First follow-up",
      description: "Preserve original description",
      dueAt: "2026-11-01T09:30:00.123Z",
      timezone: "US/Pacific",
    },
    created = await agent.command(`/v1/orgs/${fixtures.orgA}/tasks`, createBody);
  expect(created.status).toBe(201);
  const original = await created.json();
  assertContract("Task", original);
  const key = randomUUID(),
    editBody = write(original, { title: "Drawer edited follow-up" }),
    edited = await receipt(await patch(original, editBody, key, '"1"', agent)),
    done = await receipt(
      await patch(edited, write(edited, { title: edited.title, state: "done" }), randomUUID(), '"2"', agent),
      3,
    );
  const stage = await agent.command(
    `/v1/orgs/${fixtures.orgA}/leads/${lead.id}/stage-transitions`,
    { toStageId: stageId(1, 2), reason: "Synthetic integrated follow-up" },
    { revision: '"2"' },
  );
  expect(stage.status).toBe(201);
  await unchanged(original.id, async () =>
    expect(await receipt(await patch(original, editBody, key, '"1"', agent))).toEqual(edited),
  );
  expect((await effects(original.id)).task.row_version).toBe(3);
  expect(done).toMatchObject({ state: "done", description: "Preserve original description" });
  expect(await effects(original.id)).toMatchObject({ audits: 3, activities: 2 });
  expect(
    (
      await admin.query("SELECT event_type FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2", [
        fixtures.orgA,
        lead.id,
      ])
    ).rows.map((r) => r.event_type),
  ).toEqual(expect.arrayContaining(["lead.captured", "lead.assigned", "lead.stage_changed"]));
  expect(
    (
      await admin.query(
        "SELECT count(*)::int n FROM app.outbox WHERE tenant_id=$1 AND event_type='task.due'",
        [fixtures.orgA],
      )
    ).rows[0].n,
  ).toBe(0);
});
