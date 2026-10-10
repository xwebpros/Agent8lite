import { createHash, randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CrmService, stable } from "../../apps/api/src/crm-service";
import eventSchema from "../../packages/contracts/events.schema.json";
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
    throw new Error("Stage transition acceptance requires an owned file-fresh disposable database.");
}
const runtimeName = "stage_transition_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema);
let agent: ApiSession, owner: ApiSession;
const sessions: ApiSession[] = [];
const target = stageId(1, 2),
  third = stageId(1, 3),
  originalStage = stageId(1, 1);
const input = (toStageId = target): Schemas["StageTransition"] => ({
  toStageId,
  reason: " PRIVATE_TRANSITION_REASON ",
});
const path = (id: string, org: string = fixtures.orgA) => `/v1/orgs/${org}/leads/${id}/stage-transitions`;
const route = (id: string, org: string = fixtures.orgA) => "POST " + path(id, org);
async function source(options: { org?: string; member?: string; stage?: string } = {}) {
  const org = options.org ?? fixtures.orgA,
    id = randomUUID(),
    contactId = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'Synthetic private stage contact',$3)",
    [org, contactId, org === fixtures.orgA ? fixtures.agentMemberA : fixtures.ownerMemberB],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,timeline)VALUES($1,$2,$3,$4,$5,$6,'buyer','PRIVATE_SOURCE_TIMELINE')",
    [
      org,
      id,
      contactId,
      org === fixtures.orgA ? fixtures.sourceA : fixtures.sourceB,
      options.stage ?? (org === fixtures.orgA ? originalStage : stageId(2, 1)),
      options.member ?? (org === fixtures.orgA ? fixtures.agentMemberA : fixtures.ownerMemberB),
    ],
  );
  return { id, contactId };
}
const post = (
  id: string,
  body: unknown = input(),
  key = randomUUID(),
  revision = '"1"',
  session: ApiSession = agent,
) => session.command(path(id, session.orgId), body, { key, revision });
async function receipt(response: Response, version = 2): Promise<Schemas["Lead"]> {
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe(`"${version}"`);
  const body = await response.json();
  assertContract("Lead", body);
  expect(body.version).toBe(version);
  return body;
}
async function effects(id: string) {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.stage_transition WHERE tenant_id=$1 AND lead_id=$2::uuid)history,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text)audits,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2::uuid)activities,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2::text)outbox,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$3)receipts,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent,(SELECT jsonb_build_object('stage',stage_id,'version',row_version)FROM app.lead WHERE tenant_id=$1 AND id=$2::uuid)lead",
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
    { userId: fixtures.agentUser, organizationId: fixtures.orgA },
    (client, context) => operation(new CrmService(client, context, randomUUID()), client, context),
  );
}
async function command(id: string, body: unknown = input(), key = randomUUID(), revision = '"1"') {
  return direct((crm) => crm.postStageTransition(id, body, revision, key, route(id)));
}
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
    .map((g) => ({ ...g, scope: g.code === "crm.leads.write" ? (options.scope ?? g.scope) : g.scope }));
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
    `Owned stage office ${id}`,
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
  throw new Error("Owned stage transition did not observe a real database lock wait.");
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
  owner = await new ApiSession().signIn();
  sessions.push(agent, owner);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("registered stage command immutable receipts and atomic references", () => {
  it("one transition produces one schema-valid DB-clock event, safe audit/activity/history and strong receipt", async () => {
    const { id, contactId } = await source(),
      before = await effects(id),
      dbBefore = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    const body = await receipt(await post(id));
    expect(body).toMatchObject({ id, contactId, sourceId: fixtures.sourceA, stageId: target, version: 2 });
    expect(await effects(id)).toEqual({
      ...before,
      history: 1,
      audits: 1,
      activities: 1,
      outbox: 1,
      receipts: 1,
      lead: { stage: target, version: 2 },
    });
    const event = (
      await admin.query(
        "SELECT payload,event_type,published_at,attempt_count FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2",
        [fixtures.orgA, id],
      )
    ).rows[0];
    expect(validateEvent(event.payload), JSON.stringify(validateEvent.errors)).toBe(true);
    expect(event).toMatchObject({ event_type: "lead.stage_changed", published_at: null, attempt_count: 0 });
    expect(event.payload).toMatchObject({
      type: "lead.stage_changed",
      tenantId: fixtures.orgA,
      aggregateType: "lead",
      aggregateId: id,
      version: 1,
      payload: { resourceId: id, resourceVersion: 2, relatedResourceIds: [target] },
    });
    const dbAfter = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    expect(Date.parse(event.payload.occurredAt)).toBeGreaterThanOrEqual(dbBefore.getTime());
    expect(Date.parse(event.payload.occurredAt)).toBeLessThanOrEqual(dbAfter.getTime());
    const audit = (
      await admin.query(
        "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(audit).toEqual([{ action: "lead.stage_changed", safe_diff: { resourceVersion: 2 } }]);
    const activity = (
      await admin.query(
        "SELECT event_type,safe_data FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(activity).toEqual([
      { event_type: "lead.stage_changed", safe_data: { resourceId: id, resourceVersion: 2 } },
    ]);
    expect(
      (
        await admin.query(
          "SELECT from_stage_id,to_stage_id,actor_member_id,reason FROM app.stage_transition WHERE tenant_id=$1 AND lead_id=$2",
          [fixtures.orgA, id],
        )
      ).rows,
    ).toEqual([
      {
        from_stage_id: originalStage,
        to_stage_id: target,
        actor_member_id: fixtures.agentMemberA,
        reason: input().reason,
      },
    ]);
    for (const value of [JSON.stringify(event.payload), JSON.stringify(audit), JSON.stringify(activity)]) {
      expect(value).not.toContain("PRIVATE_TRANSITION_REASON");
      expect(value).not.toContain("PRIVATE_SOURCE_TIMELINE");
      expect(value).not.toContain("Synthetic private stage contact");
    }
  });
  it("concurrent same-key commands return one exact historical receipt with all effects once", async () => {
    const { id } = await source(),
      key = randomUUID();
    const values = await Promise.all(
      (await Promise.all([post(id, input(), key), post(id, input(), key)])).map((r) => receipt(r)),
    );
    expect(values[0]).toEqual(values[1]);
    expect(await effects(id)).toMatchObject({ history: 1, audits: 1, activities: 1, outbox: 1, receipts: 1 });
  });
  it("different keys racing one revision have one success and one stale failure", async () => {
    const { id } = await source();
    const results = await Promise.all([post(id, input()), post(id, input(third))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 412]);
    await assertProblem(results.find((r) => r.status === 412)!, 412);
    expect(await effects(id)).toMatchObject({ history: 1, audits: 1, activities: 1, outbox: 1, receipts: 1 });
  });
  it("historical replay after a later move retains original body/ETag without restoring current stage/version", async () => {
    const { id } = await source(),
      key = randomUUID();
    const first = await receipt(await post(id, input(), key));
    await receipt(await post(id, input(third), randomUUID(), '"2"'), 3);
    await unchanged(id, async () => {
      expect(await receipt(await post(id, input(), key))).toEqual(first);
    });
    expect((await effects(id)).lead).toEqual({ stage: third, version: 3 });
  });
  it("key binds original body and exact revision spelling", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await post(id, input(), key, '"01"'));
    await unchanged(id, async () => {
      await assertProblem(await post(id, input(third), key, '"01"'), 409);
      await assertProblem(await post(id, input(), key, '"1"'), 409);
      await assertProblem(await post(id, input(), key, "1"), 409);
    });
  });
  it("legacy receipt hash and NULL stored ETag replay only after strict historical validation", async () => {
    const { id } = await source(),
      key = randomUUID(),
      body = input();
    const first = await receipt(await post(id, body, key));
    const hash = createHash("sha256")
      .update(stable({ body, expectedVersion: '"1"' }))
      .digest("hex");
    await admin.query(
      "UPDATE app.idempotency_record SET response_etag=NULL,request_hash=$5 WHERE tenant_id=$1 AND actor_ref=$2 AND route_key=$3 AND key=$4",
      [fixtures.orgA, fixtures.agentUser, route(id), key, hash],
    );
    await unchanged(id, async () => {
      expect(await receipt(await post(id, body, key))).toEqual(first);
    });
  });
  it("expired matching receipt fails closed without renewal, replacement or another transition", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await post(id, input(), key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND actor_ref=$2 AND route_key=$3 AND key=$4",
      [fixtures.orgA, fixtures.agentUser, route(id), key],
    );
    const stored = (
      await admin.query(
        "SELECT expires_at,request_hash,response_body FROM app.idempotency_record WHERE tenant_id=$1 AND key=$2",
        [fixtures.orgA, key],
      )
    ).rows[0];
    await unchanged(id, async () => {
      expect((await assertProblem(await post(id, input(), key), 409)).code).toBe("receipt_expired");
    });
    expect(
      (
        await admin.query(
          "SELECT expires_at,request_hash,response_body FROM app.idempotency_record WHERE tenant_id=$1 AND key=$2",
          [fixtures.orgA, key],
        )
      ).rows[0],
    ).toEqual(stored);
  });
  it("corrupt stored historical Lead cannot authorize a receipt or mutate current source", async () => {
    const { id } = await source(),
      key = randomUUID();
    const first = await receipt(await post(id, input(), key));
    await admin.query("UPDATE app.idempotency_record SET response_body=$3 WHERE tenant_id=$1 AND key=$2", [
      fixtures.orgA,
      key,
      JSON.stringify({ ...first, contactId: randomUUID() }),
    ]);
    await unchanged(id, async () => {
      await assertProblem(await post(id, input(), key), 503);
    });
  });
  it("request body/query/CSRF/origin/idempotency/revision boundaries reject before effects", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      for (const body of [
        {},
        { ...input(), ownerMemberId: fixtures.ownerMemberA },
        { ...input(), reason: "x".repeat(1001) },
      ])
        await assertProblem(await post(id, body), 422);
      await assertProblem(
        await agent.command(path(id) + "?filter=ignored", input(), { revision: '"1"' }),
        422,
      );
      await assertProblem(await agent.command(path(id), input(), { revision: '"1"', csrf: "invalid" }), 403);
      const headers: Record<string, string> = {
        "idempotency-key": randomUUID(),
        "if-match": '"1"',
        "x-csrf-token": agent.csrf,
        origin: "https://foreign.invalid",
      };
      await assertProblem(
        await agent.request(path(id), { method: "POST", headers, body: JSON.stringify(input()) }),
        403,
      );
      await assertProblem(
        await agent.request(path(id), {
          method: "POST",
          headers: { "if-match": '"1"', "x-csrf-token": agent.csrf },
          body: JSON.stringify(input()),
        }),
        400,
      );
      await assertProblem(await agent.command(path(id), input()), 400);
      await assertProblem(await post(id, input(), randomUUID(), 'W/"1"'), 400);
    });
  });
  it("unchanged stage and unsafe/exhausted revisions produce no history or receipt", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      expect((await assertProblem(await post(id, input(originalStage)), 409)).code).toBe("stage_unchanged");
    });
    await admin.query("UPDATE app.lead SET row_version=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
      String(Number.MAX_SAFE_INTEGER),
    ]);
    await unchanged(id, async () => {
      expect(
        (await assertProblem(await post(id, input(), randomUUID(), `"${Number.MAX_SAFE_INTEGER}"`), 409))
          .code,
      ).toBe("revision_exhausted");
    });
    await admin.query("UPDATE app.lead SET row_version=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
      "9007199254740992",
    ]);
    await unchanged(id, async () => {
      await assertProblem(await post(id), 503);
    });
  });
  it("caller rollback undoes Lead, history, event, activity, audit and receipt atomically", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      await expect(
        direct(async (crm) => {
          await crm.postStageTransition(id, input(), '"1"', randomUUID(), route(id));
          throw new Error("OWNED_ROLLBACK");
        }),
      ).rejects.toThrow("OWNED_ROLLBACK");
    });
  });
});

describe("current write-only source scope and replay authority", () => {
  it("write-only grants preserve stage command while no lead/pipeline/contact/source read is invented", async () => {
    const { id } = await source();
    await grants(
      async () => {
        const key = randomUUID(),
          first = await receipt(await post(id, input(), key));
        await unchanged(id, async () => {
          expect(await receipt(await post(id, input(), key))).toEqual(first);
        });
      },
      {
        remove: [
          "crm.leads.read",
          "crm.pipeline.read",
          "crm.contacts.read",
          "crm.contacts.write",
          "crm.sources.read",
        ],
      },
    );
  });
  it("own/team/organization scope uses current owner and eligible team office intersection", async () => {
    const outside = await source({ member: fixtures.ownerMemberA });
    await unchanged(outside.id, async () => {
      await assertProblem(await post(outside.id), 404);
    });
    const officeId = await office();
    await grants(
      async () => {
        await receipt(await post(outside.id));
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
        unchanged(outside.id, async () => {
          await assertProblem(await post(outside.id, input(third), randomUUID(), '"2"'), 404);
        }),
      { scope: "team" },
    );
    await grants(
      async () => {
        await receipt(await post(outside.id, input(third), randomUUID(), '"2"'), 3);
      },
      { scope: "organization" },
    );
  });
  it("foreign Lead and stage identities cannot enter an owned stage command", async () => {
    const local = await source(),
      foreign = await source({ org: fixtures.orgB });
    await unchanged(local.id, async () => {
      await assertProblem(await post(foreign.id), 404);
      await assertProblem(await post(local.id, input(stageId(2, 2))), 422);
    });
  });
  it.each(["lead", "contact"] as const)("archived %s source blocks historical replay", async (kind) => {
    const { id, contactId } = await source(),
      key = randomUUID();
    await receipt(await post(id, input(), key));
    await admin.query(`UPDATE app.${kind} SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [
      fixtures.orgA,
      kind === "lead" ? id : contactId,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await post(id, input(), key), 404);
    });
  });
  it("current owner reassignment outside own scope hides historical receipt", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await post(id, input(), key));
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
      fixtures.ownerMemberA,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await post(id, input(), key), 404);
    });
  });
  it("a legitimate reassignment permits own-scope historical replay even after the original owner is disabled", async () => {
    const { id } = await source({ member: fixtures.ownerMemberA }),
      key = randomUUID();
    const first = await grants(async () => receipt(await post(id, input(), key)), { scope: "organization" });
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
      fixtures.agentMemberA,
    ]);
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.ownerMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        expect(await receipt(await post(id, input(), key))).toEqual(first);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
    }
  });
  it("current grant, membership and CRM revocation deny before historical replay", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await post(id, input(), key));
    await grants(
      () =>
        unchanged(id, async () => {
          await assertProblem(await post(id, input(), key), 403);
        }),
      { remove: ["crm.leads.write"] },
    );
    await capability(
      () =>
        unchanged(id, async () => {
          await assertProblem(await post(id, input(), key), 403);
        }),
      "disabled",
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        await assertProblem(await post(id, input(), key), 403);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("forged/missing context and reused runtime pool cannot widen sources or execute", async () => {
    const { id } = await source(),
      saved = await direct(async (_crm, _client, context) => context);
    const client = await runtime.connect();
    try {
      await expect(
        new CrmService(client, saved, randomUUID()).postStageTransition(
          id,
          input(),
          '"1"',
          randomUUID(),
          route(id),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect((await client.query("SELECT id FROM app.lead")).rowCount).toBe(0);
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
      await unchanged(id, () =>
        direct(async (_crm, current, context) => {
          const forged = { ...context, ...patch };
          await expect(
            new CrmService(current, forged, randomUUID()).postStageTransition(
              id,
              input(),
              '"1"',
              randomUUID(),
              route(id, forged.organizationId),
            ),
          ).rejects.toMatchObject({ status: 403 });
        }),
      );
    await command(id);
    expect((await runtime.query("SELECT id FROM app.lead")).rowCount).toBe(0);
  });
});

describe("observed source, office and clock waits", () => {
  it("contact archive committed during actual SHARE wait blocks transition and every effect", async () => {
    const { id, contactId } = await source();
    await unchanged(id, () =>
      held(
        (b) =>
          b.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            contactId,
          ]),
        () => command(id),
        (b) =>
          b.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            contactId,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("Lead reassignment after an actual row wait removes current own scope", async () => {
    const { id } = await source();
    await unchanged(id, () =>
      held(
        (b) =>
          b.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [fixtures.orgA, id]),
        () => command(id),
        (b) =>
          b.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            id,
            fixtures.ownerMemberA,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("target stage deletion after observed stage lock wait is denied without substitution", async () => {
    const { id } = await source(),
      stage = randomUUID();
    await admin.query(
      "INSERT INTO app.pipeline_stage(tenant_id,id,name,position)VALUES($1,$2,'Owned wait stage',90)",
      [fixtures.orgA, stage],
    );
    await unchanged(id, () =>
      held(
        (b) =>
          b.query("SELECT id FROM app.pipeline_stage WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            stage,
          ]),
        () => command(id, input(stage)),
        (b) => b.query("DELETE FROM app.pipeline_stage WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, stage]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 422 });
        },
      ),
    );
  });
  it("team office removal after an observed link wait denies before history or receipt", async () => {
    const { id } = await source({ member: fixtures.ownerMemberA }),
      officeId = await office();
    await grants(
      () =>
        unchanged(id, () =>
          held(
            (b) =>
              b.query(
                "SELECT member_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, officeId, fixtures.ownerMemberA],
              ),
            () => command(id),
            (b) =>
              b.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                officeId,
                fixtures.ownerMemberA,
              ]),
            async (p) => {
              await expect(p).rejects.toMatchObject({ status: 404 });
            },
          ),
        ),
      { scope: "team" },
    );
  });
  it.each(["advisory", "lead", "contact", "stage"] as const)(
    "CRM expiry after actual %s wait rejects before durable effects",
    async (kind) => {
      const { id, contactId } = await source(),
        key = randomUUID();
      await capability(async () => {
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '700 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA],
        );
        await unchanged(id, () =>
          held(
            (b) =>
              kind === "advisory"
                ? b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                    fixtures.orgA + ":" + fixtures.agentUser + ":" + route(id) + ":" + key,
                  ])
                : b.query(
                    `SELECT id FROM app.${kind === "stage" ? "pipeline_stage" : kind} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
                    [fixtures.orgA, kind === "lead" ? id : kind === "contact" ? contactId : target],
                  ),
            () => command(id, input(), key),
            async () => {
              await admin.query("SELECT pg_sleep(0.8)");
            },
            async (p) => {
              await expect(p).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
            },
          ),
        );
      });
    },
  );
  it("mutable caller body cannot replace captured command after advisory wait", async () => {
    const { id } = await source(),
      body = input(),
      original = { ...body },
      key = randomUUID();
    let result: unknown;
    await held(
      (b) =>
        b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          fixtures.orgA + ":" + fixtures.agentUser + ":" + route(id) + ":" + key,
        ]),
      () => command(id, body, key),
      async () => {
        body.toStageId = third;
        body.reason = "REPLACED_AFTER_WAIT";
      },
      async (p) => {
        result = await p;
      },
    );
    expect(result).toMatchObject({ body: { stageId: target, version: 2 } });
    await unchanged(id, async () => {
      expect(await command(id, original, key)).toEqual(result);
    });
    expect(
      (
        await admin.query("SELECT reason FROM app.stage_transition WHERE tenant_id=$1 AND lead_id=$2", [
          fixtures.orgA,
          id,
        ])
      ).rows[0].reason,
    ).toBe(original.reason);
  });
});
