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
  type TenantContext,
  type PermissionGrant,
} from "../../packages/db/tenant-transaction";
import {
  ApiSession,
  assertContract,
  assertProblem as assertContractProblem,
  type Schemas,
} from "../helpers/api";

async function assertProblem(response: Response, status: number, code?: string) {
  const body = await assertContractProblem(response, status);
  if (code) expect(body.code).toBe(code);
  return body;
}

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Lead assignment acceptance requires an owned file-fresh database.");
}
const runtimeName = "lead_assignment_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateEvent = ajv.compile(eventSchema);
let owner: ApiSession, agent: ApiSession;
const path = (id: string, org: string = fixtures.orgA) => `/v1/orgs/${org}/leads/${id}`;
const route = (id: string, org: string = fixtures.orgA) => "PATCH " + path(id, org);
const input = (): Schemas["LeadPatch"] => ({ ownerMemberId: fixtures.agentMemberA });
async function source(options: { org?: string; member?: string | null } = {}) {
  const org = options.org ?? fixtures.orgA,
    id = randomUUID(),
    contactId = randomUUID();
  const member =
    options.member === undefined
      ? org === fixtures.orgA
        ? fixtures.ownerMemberA
        : fixtures.ownerMemberB
      : options.member;
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,created_by_member_id)VALUES($1,$2,'PRIVATE_ASSIGNMENT_CONTACT',$3)",
    [org, contactId, org === fixtures.orgA ? fixtures.ownerMemberA : fixtures.ownerMemberB],
  );
  await admin.query(
    "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,intent,timeline,score,score_version)VALUES($1,$2,$3,$4,$5,$6,'buyer','PRIVATE_TIMELINE',10,'synthetic-v1')",
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
const patch = (
  id: string,
  body: unknown = input(),
  key = randomUUID(),
  revision = '"1"',
  session: ApiSession = owner,
) => session.command(path(id, session.orgId), body, { method: "PATCH", key, revision });
async function receipt(response: Response, version = 2): Promise<Schemas["Lead"]> {
  expect(response.status).toBe(200);
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
      "SELECT(SELECT to_jsonb(l) FROM app.lead l WHERE tenant_id=$1 AND id=$2::uuid)lead,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text)audits,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2::uuid)activities,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2::text)outbox,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$3)receipts,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent",
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
const command = (id: string, body: unknown = input(), key = randomUUID(), revision = '"1"') =>
  direct((crm) => crm.patchLead(id, body, revision, key, route(id)));
async function grants<T>(
  operation: () => Promise<T>,
  options: { scope?: PermissionGrant["scope"]; remove?: string[] } = {},
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.ownerMemberA],
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
    "Owned assignment office " + id,
  ]);
  await admin.query(
    "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
    [fixtures.orgA, id, fixtures.ownerMemberA, fixtures.agentMemberA],
  );
  return id;
}
async function removeOwnedOffice(id: string) {
  await admin.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2", [fixtures.orgA, id]);
  await admin.query("DELETE FROM app.office WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]);
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
  throw new Error("Lead assignment did not observe a real database lock wait.");
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

describe("ADR-045 durable complete LeadPatch boundary", () => {
  it("closes the old keyless update port before any database query", async () => {
    let queries = 0;
    const crm = new CrmService(
      {
        query: async () => {
          queries++;
          throw new Error("unexpected");
        },
      } as unknown as PoolClient,
      {} as TenantContext,
      randomUUID(),
    );
    await expect(crm.update("leads", randomUUID(), input(), '"1"')).rejects.toMatchObject({
      status: 503,
      code: "lead_command_required",
    });
    expect(queries).toBe(0);
  });
  it("changes only requested fields and atomically appends one database-time safe event/activity/audit/receipt", async () => {
    const { id, contactId } = await source(),
      key = randomUUID(),
      before = (await admin.query("SELECT clock_timestamp()now")).rows[0].now;
    const body = await receipt(await patch(id, input(), key));
    expect(body).toMatchObject({
      id,
      contactId,
      ownerMemberId: fixtures.agentMemberA,
      intent: "buyer",
      timeline: "PRIVATE_TIMELINE",
      score: 10,
      scoreVersion: "synthetic-v1",
      stageId: stageId(1, 1),
    });
    const rows = (
      await admin.query(
        "SELECT id,event_type,payload,initiating_actor_id FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(rows).toHaveLength(1);
    const event = rows[0].payload;
    expect(validateEvent(event)).toBe(true);
    expect(event).toMatchObject({
      type: "lead.assigned",
      version: 1,
      tenantId: fixtures.orgA,
      producer: "crm",
      aggregateType: "lead",
      aggregateId: id,
      payload: { resourceId: id, resourceVersion: 2, relatedResourceIds: [fixtures.agentMemberA] },
    });
    expect(event.eventId).toBe(rows[0].id);
    expect(event.ingestedAt).toBe(event.occurredAt);
    expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(
      (await admin.query("SELECT clock_timestamp()now")).rows[0].now.getTime(),
    );
    expect(rows[0].initiating_actor_id).toBe(fixtures.ownerUser);
    const activities = (
      await admin.query(
        "SELECT event_type,source_event_id,safe_data,occurred_at FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(activities).toEqual([
      {
        event_type: "lead.assigned",
        source_event_id: event.eventId,
        safe_data: event.payload,
        occurred_at: new Date(event.occurredAt),
      },
    ]);
    expect(
      (
        await admin.query(
          "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
          [fixtures.orgA, id],
        )
      ).rows,
    ).toEqual([{ action: "lead.updated", safe_diff: { resourceVersion: 2 } }]);
    const saved = (
      await admin.query(
        "SELECT response_ref,response_body,status_code,response_etag FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(id), key],
      )
    ).rows[0];
    expect(saved).toMatchObject({
      response_ref: id,
      response_body: body,
      status_code: 200,
      response_etag: '"2"',
    });
    expect(JSON.stringify([event, activities])).not.toMatch(
      /PRIVATE_|ownerMemberId|contactId|timeline|score/,
    );
  });
  it.each([
    {},
    { intent: "unknown", timeline: null },
    { ownerMemberId: fixtures.ownerMemberA.toUpperCase() },
  ])("metadata/empty/case-only patch %j emits no false assignment", async (body) => {
    const { id } = await source();
    const saved = await receipt(await patch(id, body));
    expect(saved.ownerMemberId).toBe(fixtures.ownerMemberA);
    expect(await effects(id)).toMatchObject({ audits: 1, activities: 0, outbox: 0, receipts: 1 });
    if (Object.hasOwn(body, "timeline")) expect(saved.timeline).toBeNull();
  });
  it("canonicalizes uppercase route and target UUID while preserving their original body hash", async () => {
    const { id } = await source(),
      body = { ownerMemberId: fixtures.agentMemberA.toUpperCase() },
      key = randomUUID();
    const first = await receipt(await patch(id.toUpperCase(), body, key));
    expect(first.id).toBe(id);
    expect(first.ownerMemberId).toBe(fixtures.agentMemberA);
    expect(await receipt(await patch(id.toUpperCase(), body, key))).toEqual(first);
    expect(await effects(id)).toMatchObject({ activities: 1, outbox: 1 });
  });
  it("same-key concurrent retries return one revision and one effect set", async () => {
    const { id } = await source(),
      key = randomUUID();
    const results = await Promise.all(Array.from({ length: 3 }, () => patch(id, input(), key)));
    const bodies = await Promise.all(results.map((r) => receipt(r)));
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(await effects(id)).toMatchObject({ audits: 1, activities: 1, outbox: 1, receipts: 1 });
  });
  it("distinct keys on one original revision allow exactly one writer", async () => {
    const { id } = await source();
    const results = await Promise.all([patch(id, input()), patch(id, { ownerMemberId: null })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    await assertProblem(results.find((r) => r.status === 412)!, 412);
    expect(await effects(id)).toMatchObject({ audits: 1, activities: 1, outbox: 1, receipts: 1 });
  });
  it("historical replay retains original owner/body/ETag after a later authorized metadata edit", async () => {
    const { id } = await source(),
      key = randomUUID(),
      first = await receipt(await patch(id, input(), key));
    await receipt(await patch(id, { timeline: "Later current value" }, randomUUID(), '"2"'), 3);
    await unchanged(id, async () => expect(await receipt(await patch(id, input(), key))).toEqual(first));
    expect((await owner.read(path(id), "Lead")).body).toMatchObject({
      version: 3,
      timeline: "Later current value",
    });
  });
  it("changed body or exact If-Match spelling conflicts without effects", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key, "001"));
    for (const [body, revision] of [
      [input(), '"1"'],
      [{ ...input(), timeline: null }, "001"],
    ] as const)
      await unchanged(id, async () => {
        await assertProblem(await patch(id, body, key, revision), 409, "idempotency_conflict");
      });
  });
  it("accepts reviewed legacy canonical hash and NULL ETag/reference only after strict validation", async () => {
    const { id } = await source(),
      key = randomUUID(),
      body = input(),
      first = await receipt(await patch(id, body, key, '"001"'));
    const hash = createHash("sha256")
      .update(stable({ body, expectedVersion: '"001"' }))
      .digest("hex");
    await admin.query(
      "UPDATE app.idempotency_record SET request_hash=$4,response_etag=NULL,response_ref=NULL WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(id), key, hash],
    );
    await unchanged(id, async () =>
      expect(await receipt(await patch(id, body, key, '"001"'))).toEqual(first),
    );
  });
  it("matching expired receipt rejects rather than executing/renewing/replacing", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(id), key],
    );
    const original = (
      await admin.query(
        "SELECT * FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(id), key],
      )
    ).rows[0];
    await unchanged(id, async () => {
      await assertProblem(await patch(id, input(), key), 409, "receipt_expired");
    });
    expect(
      (
        await admin.query(
          "SELECT * FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
          [fixtures.orgA, route(id), key],
        )
      ).rows[0],
    ).toEqual(original);
  });
  it.each(["response_ref", "response_etag", "response_body"])(
    "corrupt %s cannot leak a cached result",
    async (column) => {
      const { id } = await source(),
        key = randomUUID(),
        first = await receipt(await patch(id, input(), key));
      const bad =
        column === "response_ref"
          ? randomUUID()
          : column === "response_etag"
            ? '"3"'
            : JSON.stringify({ ...first, ownerMemberId: fixtures.ownerMemberB });
      await admin.query(
        `UPDATE app.idempotency_record SET ${column}=$4 WHERE tenant_id=$1 AND route_key=$2 AND key=$3`,
        [fixtures.orgA, route(id), key, bad],
      );
      await unchanged(id, async () => {
        await assertProblem(await patch(id, input(), key), 503, "receipt_unavailable");
      });
    },
  );
  it("rejects undeclared query, invalid body/revision/key, CSRF and Origin without effects", async () => {
    const { id } = await source();
    const headers: Record<string, string>[] = [
      { "If-Match": "1.5" },
      { "If-Match": 'W/"1"' },
      { "If-Match": String(Number.MAX_SAFE_INTEGER + 1) },
      { "Idempotency-Key": "" },
      { "X-CSRF-Token": "wrong" },
      { Origin: "https://wrong.invalid" },
    ];
    for (const extra of headers)
      await unchanged(id, async () => {
        const response = await owner.request(path(id), {
          method: "PATCH",
          body: JSON.stringify(input()),
          headers: {
            "If-Match": '"1"',
            "Idempotency-Key": randomUUID(),
            "X-CSRF-Token": owner.csrf,
            ...extra,
          },
        });
        expect([400, 403]).toContain(response.status);
        await assertProblem(response, response.status);
      });
    await unchanged(id, async () => {
      await assertProblem(
        await owner.command(path(id) + "?extra=1", input(), { method: "PATCH", revision: '"1"' }),
        422,
        "query_invalid",
      );
      await assertProblem(await patch(id, { ...input(), stageId: stageId(1, 2) }), 422);
    });
  });
  it("maximum safe current revision denies exhaustion before any write", async () => {
    const { id } = await source();
    await admin.query("UPDATE app.lead SET row_version=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
      String(Number.MAX_SAFE_INTEGER),
    ]);
    await unchanged(id, async () => {
      await assertProblem(
        await patch(id, input(), randomUUID(), String(Number.MAX_SAFE_INTEGER)),
        409,
        "revision_exhausted",
      );
    });
  });
  it("caller rollback undoes Lead, event, activity, audit and receipt together", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      await expect(
        direct(async (crm) => {
          await crm.patchLead(id, input(), '"1"', randomUUID(), route(id));
          throw new Error("owned rollback");
        }),
      ).rejects.toThrow("owned rollback");
    });
  });
});

describe("current write-only authority and protected source references", () => {
  it("write-only grant succeeds without Lead/Contact/member/source/pipeline reads", async () => {
    const { id } = await source();
    await grants(
      async () => {
        const key = randomUUID(),
          first = await receipt(await patch(id, input(), key));
        await unchanged(id, async () => expect(await receipt(await patch(id, input(), key))).toEqual(first));
      },
      {
        remove: [
          "crm.leads.read",
          "crm.contacts.read",
          "crm.contacts.write",
          "members.read",
          "crm.sources.read",
          "crm.pipeline.read",
        ],
      },
    );
  });
  it("own scope allows only self and organization alone may unassign", async () => {
    const { id } = await source();
    await grants(
      async () => {
        await unchanged(id, async () => {
          await assertProblem(await patch(id, input()), 422, "assignee_invalid");
          await assertProblem(await patch(id, { ownerMemberId: null }), 422, "owner_required");
        });
        await receipt(await patch(id, {}));
      },
      { scope: "own" },
    );
    const second = await source();
    expect((await receipt(await patch(second.id, { ownerMemberId: null }))).ownerMemberId).toBeNull();
  });
  it("team scope intersects offices for both current and target owners", async () => {
    const officeId = await office(),
      { id } = await source();
    try {
      await grants(
        async () => {
          await receipt(await patch(id));
          await admin.query(
            "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
            [fixtures.orgA, officeId, fixtures.agentMemberA],
          );
          await unchanged(id, async () => {
            await assertProblem(await patch(id, {}, randomUUID(), '"2"'), 404);
          });
        },
        { scope: "team" },
      );
    } finally {
      await removeOwnedOffice(officeId);
    }
  });
  it("foreign/disabled recipients and foreign tenant Lead remain unavailable", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      await assertProblem(await patch(id, { ownerMemberId: fixtures.ownerMemberB }), 422, "assignee_invalid");
    });
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        await assertProblem(await patch(id), 422, "assignee_invalid");
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
    const other = await source({ org: fixtures.orgB });
    await assertProblem(await patch(other.id), 404);
  });
  it("explicit owner change can repair a disabled current owner; omission cannot retain it", async () => {
    const { id } = await source({ member: fixtures.agentMemberA });
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        await assertProblem(await patch(id, { timeline: "still assigned" }), 422);
      });
      expect((await receipt(await patch(id, { ownerMemberId: fixtures.ownerMemberA }))).ownerMemberId).toBe(
        fixtures.ownerMemberA,
      );
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it.each(["lead", "contact"] as const)("archived %s blocks fresh command and replay", async (kind) => {
    const { id, contactId } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await admin.query(`UPDATE app.${kind} SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [
      fixtures.orgA,
      kind === "lead" ? id : contactId,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await patch(id, input(), key), 404);
      await assertProblem(await patch(id, {}, randomUUID(), '"2"'), 404);
    });
  });
  it("both historical and current owner need current eligibility for replay", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await receipt(await patch(id, { ownerMemberId: fixtures.ownerMemberA }, randomUUID(), '"2"'), 3);
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        await assertProblem(await patch(id, input(), key), 404);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("revoked grants/CRM deny replay and missing context or forged claims cannot borrow tenant rows", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await grants(
      async () => {
        await unchanged(id, async () => {
          await assertProblem(await patch(id, input(), key), 403);
        });
      },
      { remove: ["crm.leads.write"] },
    );
    await capability(async () => {
      await unchanged(id, async () => {
        await assertProblem(await patch(id, input(), key), 403);
      });
    }, "disabled");
    expect((await runtime.query("SELECT id FROM app.lead")).rowCount).toBe(0);
    for (const field of ["userId", "memberId", "roleId", "organizationId"] as const)
      await direct(async (crm, client, context) => {
        const forged = { ...context, [field]: randomUUID() };
        const r = route(id, forged.organizationId);
        await expect(
          new CrmService(client, forged, randomUUID()).patchLead(id, {}, '"2"', randomUUID(), r),
        ).rejects.toMatchObject({ status: 403 });
      });
    expect((await runtime.query("SELECT current_setting('app.tenant_id',true)tenant")).rows[0].tenant).toBe(
      "",
    );
  });
});

describe("observed waits use current source and database time", () => {
  it("Lead scope lost while UPDATE lock waits denies without assignment effects", async () => {
    const { id } = await source();
    await grants(
      async () => {
        await held(
          (c) =>
            c.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [fixtures.orgA, id]),
          () => command(id, { ownerMemberId: fixtures.ownerMemberA }),
          (c) =>
            c.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
              fixtures.orgA,
              id,
              fixtures.agentMemberA,
            ]),
          async (pending) => {
            await expect(pending).rejects.toMatchObject({ status: 404 });
            expect(await effects(id)).toMatchObject({ audits: 0, outbox: 0, activities: 0, receipts: 0 });
          },
        );
      },
      { scope: "own" },
    );
  });
  it("Contact archive during SHARE wait denies without partial effects", async () => {
    const { id, contactId } = await source();
    await held(
      (c) =>
        c.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          contactId,
        ]),
      () => command(id),
      (c) =>
        c.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          contactId,
        ]),
      async (pending) => {
        await expect(pending).rejects.toMatchObject({ status: 404 });
        expect(await effects(id)).toMatchObject({ audits: 0, outbox: 0, activities: 0, receipts: 0 });
      },
    );
  });
  it("target member disabled during SHARE wait cannot become owner", async () => {
    const { id } = await source();
    try {
      await held(
        (c) =>
          c.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            fixtures.agentMemberA,
          ]),
        () => command(id),
        (c) =>
          c.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            fixtures.agentMemberA,
          ]),
        async (pending) => {
          await expect(pending).rejects.toMatchObject({ status: 422 });
          expect(await effects(id)).toMatchObject({ audits: 0, outbox: 0, activities: 0, receipts: 0 });
        },
      );
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("target office link removed during SHARE wait cannot authorize team assignment", async () => {
    const officeId = await office(),
      { id } = await source();
    try {
      await grants(
        async () => {
          await held(
            (c) =>
              c.query(
                "SELECT office_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, officeId, fixtures.agentMemberA],
              ),
            () => command(id),
            (c) =>
              c.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                officeId,
                fixtures.agentMemberA,
              ]),
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 422 });
              expect(await effects(id)).toMatchObject({ audits: 0, outbox: 0, activities: 0, receipts: 0 });
            },
          );
        },
        { scope: "team" },
      );
    } finally {
      await removeOwnedOffice(officeId);
    }
  });
  it.each(["advisory", "lead", "contact", "member"] as const)(
    "CRM expiry while blocked on %s rolls back all effects",
    async (kind) => {
      const { id, contactId } = await source(),
        key = randomUUID();
      await capability(async () => {
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '700 milliseconds' WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA],
        );
        await held(
          (c) =>
            kind === "advisory"
              ? c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                  `${fixtures.orgA}:${fixtures.ownerUser}:${route(id)}:${key}`,
                ])
              : c.query(
                  `SELECT id FROM app.${kind === "member" ? "membership" : kind} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
                  [
                    fixtures.orgA,
                    kind === "lead" ? id : kind === "contact" ? contactId : fixtures.agentMemberA,
                  ],
                ),
          () => command(id, input(), key),
          async () => {
            await admin.query("SELECT pg_sleep(0.8)");
          },
          async (pending) => {
            await expect(pending).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
            expect(await effects(id)).toMatchObject({ audits: 0, outbox: 0, activities: 0, receipts: 0 });
          },
        );
      });
    },
  );
  it("mutable caller body cannot alter a retained request after advisory wait", async () => {
    const { id } = await source(),
      body = input(),
      key = randomUUID();
    await held(
      (c) =>
        c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `${fixtures.orgA}:${fixtures.ownerUser}:${route(id)}:${key}`,
        ]),
      () => command(id, body, key),
      async () => {
        body.ownerMemberId = null;
        body.timeline = "Injected later";
      },
      async (pending) => {
        expect((await pending).body).toMatchObject({
          ownerMemberId: fixtures.agentMemberA,
          timeline: "PRIVATE_TIMELINE",
        });
      },
    );
    await unchanged(id, async () => {
      await receipt(await patch(id, input(), key));
    });
  });
});

describe("file-fresh manager capture → real handoff → Agent follow-up → pipeline", () => {
  it("uses distinct durable commands and scoped reads while preserving each historical receipt and timeline", async () => {
    const contactResponse = await owner.command(`/v1/orgs/${fixtures.orgA}/contacts`, {
      displayName: "Integrated synthetic handoff " + randomUUID(),
    });
    expect(contactResponse.status).toBe(201);
    const contact = await contactResponse.json();
    assertContract("Contact", contact);
    const captureResponse = await owner.command(`/v1/orgs/${fixtures.orgA}/leads`, {
      contactId: contact.id,
      sourceId: fixtures.sourceA,
      ownerMemberId: fixtures.ownerMemberA,
      intent: "buyer",
    });
    expect(captureResponse.status).toBe(201);
    const captured = await captureResponse.json();
    assertContract("Lead", captured);
    await assertProblem(await agent.request(path(captured.id)), 404);
    const assignmentKey = randomUUID(),
      assigned = await receipt(await patch(captured.id, input(), assignmentKey));
    expect(assigned.ownerMemberId).toBe(fixtures.agentMemberA);
    expect((await agent.read(path(captured.id), "Lead")).body).toEqual(assigned);
    const taskInput: Schemas["TaskWrite"] = {
      leadId: captured.id,
      assigneeMemberId: fixtures.agentMemberA,
      title: "Synthetic assigned follow-up",
      dueAt: "2026-11-01T09:30:00.123Z",
      timezone: "US/Pacific",
      state: "open",
    };
    const taskKey = randomUUID();
    const createdResponse = await agent.command(`/v1/orgs/${fixtures.orgA}/tasks`, taskInput, {
      key: taskKey,
    });
    expect(createdResponse.status).toBe(201);
    const task = await createdResponse.json();
    assertContract("Task", task);
    const completionKey = randomUUID(),
      completedResponse = await agent.command(
        `/v1/orgs/${fixtures.orgA}/tasks/${task.id}`,
        { ...taskInput, state: "done" },
        { method: "PATCH", key: completionKey, revision: '"1"' },
      );
    expect(completedResponse.status).toBe(200);
    const completed = await completedResponse.json();
    assertContract("Task", completed);
    expect(completed).toMatchObject({ state: "done", version: 2 });
    const movedResponse = await agent.command(
      path(captured.id) + "/stage-transitions",
      { toStageId: stageId(1, 2), reason: "PRIVATE_INTEGRATED_REASON" },
      { revision: '"2"' },
    );
    expect(movedResponse.status).toBe(201);
    const moved = await movedResponse.json();
    assertContract("Lead", moved);
    expect(moved).toMatchObject({ version: 3, stageId: stageId(1, 2), ownerMemberId: fixtures.agentMemberA });
    await unchanged(captured.id, async () => {
      expect(await receipt(await patch(captured.id, input(), assignmentKey))).toEqual(assigned);
      expect(
        (await agent.command(`/v1/orgs/${fixtures.orgA}/tasks`, taskInput, { key: taskKey })).status,
      ).toBe(201);
      expect(
        (
          await agent.command(
            `/v1/orgs/${fixtures.orgA}/tasks/${task.id}`,
            { ...taskInput, state: "done" },
            { method: "PATCH", key: completionKey, revision: '"1"' },
          )
        ).status,
      ).toBe(200);
    });
    expect((await agent.read(path(captured.id), "Lead")).body).toEqual(moved);
    const activity = (await agent.read(path(captured.id) + "/activity", "PageActivity")).body.items;
    expect(activity.map((item) => item.type).sort()).toEqual(
      ["lead.assigned", "lead.captured", "lead.stage_changed", "task.completed", "task.created"].sort(),
    );
    const events = (
      await admin.query(
        "SELECT event_type,payload FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 ORDER BY event_type",
        [fixtures.orgA, captured.id],
      )
    ).rows;
    expect(events.map((row) => row.event_type)).toEqual([
      "lead.assigned",
      "lead.captured",
      "lead.stage_changed",
    ]);
    expect(events.every((row) => validateEvent(row.payload))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|Synthetic assigned|Integrated synthetic/);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int n FROM app.outbox WHERE tenant_id=$1 AND event_type='task.due'",
          [fixtures.orgA],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
