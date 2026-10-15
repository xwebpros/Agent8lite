import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NotificationService } from "../../apps/api/src/notification-service";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import { withTenantTransaction, type VerifiedIdentityContext } from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Notification acceptance requires the owned disposable isolated batch runner.");
}
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 3 });
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
const agentA = { userId: fixtures.agentUser, organizationId: fixtures.orgA };
const signedIn: ApiSession[] = [];
let owner: ApiSession, agent: ApiSession, secondOrganization: ApiSession;
let ownerNotice: string, agentNotice: string, foreignNotice: string;
const title = "PRIVATE_SYNTHETIC_NOTIFICATION_";
const path = (session: ApiSession, id?: string) =>
  `/v1/orgs/${session.orgId}/notifications${id ? `/${id}/read` : ""}`;

async function notice(
  memberId: string = fixtures.ownerMemberA,
  tenantId: string = fixtures.orgA,
  payload: unknown = { title: title + randomUUID(), href: `/pipeline?leadId=${fixtures.leadA}` },
  kind = "synthetic.lead.assigned",
) {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.notification(tenant_id,id,member_id,kind,safe_payload)VALUES($1,$2,$3,$4,$5)",
    [tenantId, id, memberId, kind, JSON.stringify(payload)],
  );
  return id;
}
async function signIn(identity: "owner" | "agent" = "owner") {
  const session = await new ApiSession().signIn(identity);
  signedIn.push(session);
  return session;
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-trace-id")).toBeTruthy();
}
async function page(response: Response) {
  privateResponse(response);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  assertContract("PageNotification", body);
  return body;
}
async function marked(response: Response) {
  privateResponse(response);
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(201);
  assertContract("Notification", body);
  expect(body.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  return body;
}
async function problem(response: Response, status: number) {
  privateResponse(response);
  return assertProblem(response, status);
}
function mark(session: ApiSession, id: string, key = randomUUID(), body: unknown = {}) {
  return session.command(path(session, id), body, { key });
}
async function persisted(id: string) {
  return (
    await admin.query(
      "SELECT tenant_id,id,member_id,kind,safe_payload,read_at,updated_at,row_version::text FROM app.notification WHERE id=$1",
      [id],
    )
  ).rows[0];
}
async function counts(id: string) {
  return (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM app.audit_event WHERE resource_type='notification'AND resource_id=$1::text)AS audits,(SELECT count(*)::int FROM app.idempotency_record WHERE response_body->>'id'=$1::text)AS receipts,(SELECT count(*)::int FROM app.outbox WHERE aggregate_id=$1::text)AS events",
      [id],
    )
  ).rows[0];
}
async function changedGrants<T>(
  remove: readonly string[],
  operation: () => Promise<T>,
  organizationScopes = false,
) {
  const membership = (
    await admin.query("SELECT role_id FROM app.membership WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.ownerMemberA,
    ])
  ).rows[0];
  const original = (
    await admin.query("SELECT permission_grants FROM app.role_definition WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      membership.role_id,
    ])
  ).rows[0].permission_grants as { code: string; scope: string }[];
  const modified = original
    .filter((grant) => !remove.includes(grant.code))
    .map((grant) =>
      organizationScopes && grant.code.startsWith("self.notifications.")
        ? { ...grant, scope: "organization" }
        : grant,
    );
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      membership.role_id,
      JSON.stringify(modified),
    ]);
    return await operation();
  } finally {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      membership.role_id,
      JSON.stringify(original),
    ]);
  }
}
async function transaction<T>(
  identity: VerifiedIdentityContext,
  operation: (client: PoolClient) => Promise<T>,
) {
  return withTenantTransaction(runtime, identity, (client) => operation(client));
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  expect(
    (
      await admin.query(
        "SELECT has_column_privilege('estate_runtime','app.notification','read_at','UPDATE')AS allowed",
      )
    ).rows[0].allowed,
  ).toBe(true);
  owner = await signIn();
  agent = await signIn("agent");
  secondOrganization = await signIn();
  expect((await secondOrganization.switchOrganization(fixtures.orgB)).status).toBe(200);
  expect(await page(await owner.request(path(owner)))).toEqual({
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  ownerNotice = await notice();
  agentNotice = await notice(fixtures.agentMemberA);
  foreignNotice = await notice(fixtures.ownerMemberB, fixtures.orgB);
});
afterAll(async () => {
  for (const session of signedIn)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("registered member-owned notification API", () => {
  it("keeps notifications private to each membership, including organization-scope owners", async () => {
    const own = await page(await owner.request(path(owner) + "?limit=100"));
    const assigned = await page(await agent.request(path(agent) + "?limit=100"));
    expect(own.items.map((item) => item.id)).toContain(ownerNotice);
    expect(own.items.map((item) => item.id)).not.toContain(agentNotice);
    expect(assigned.items.map((item) => item.id)).toContain(agentNotice);
    expect(assigned.items.map((item) => item.id)).not.toContain(ownerNotice);
    await problem(await mark(owner, agentNotice), 404);
    await problem(await mark(agent, ownerNotice), 404);
    await changedGrants(
      [],
      async () => {
        expect((await page(await owner.request(path(owner)))).items.map((item) => item.id)).not.toContain(
          agentNotice,
        );
        await problem(await mark(owner, agentNotice), 404);
      },
      true,
    );
  });
  it("binds the active organization even when the same identity owns both organizations", async () => {
    await problem(await owner.request(`/v1/orgs/${fixtures.orgB}/notifications`), 403);
    await problem(await mark(owner, foreignNotice), 404);
    const foreign = await page(await secondOrganization.request(path(secondOrganization)));
    expect(foreign.items.map((item) => item.id)).toContain(foreignNotice);
    expect(foreign.items.map((item) => item.id)).not.toContain(ownerNotice);
    await problem(await mark(secondOrganization, ownerNotice), 404);
    await problem(await owner.request(`/v1/orgs/${randomUUID()}/notifications`), 403);
  });
  it("exposes only the frozen bounded payload projection and never private internal fields", async () => {
    const id = await notice(fixtures.ownerMemberA, fixtures.orgA, {
      title: title + "bounded projection",
      href: "/tasks?view=mine#today",
      privateEmail: "synthetic-private-person@example.test",
      providerPayload: { token: "PRIVATE_SYNTHETIC_TOKEN" },
    });
    const result = (await page(await owner.request(path(owner) + "?limit=100"))).items.find(
      (item) => item.id === id,
    )!;
    expect(result).toEqual({
      id,
      kind: "synthetic.lead.assigned",
      title: title + "bounded projection",
      href: "/tasks?view=mine#today",
      readAt: null,
    });
    const read = await marked(await mark(owner, id));
    expect(Object.keys(read).sort()).toEqual(["href", "id", "kind", "readAt", "title"]);
    expect(JSON.stringify(read)).not.toMatch(/privateEmail|providerPayload|TOKEN|example\.test/);
  });
  it("uses exact canonical member-view roots and preserves safe query/hash links", async () => {
    for (const href of [
      "/",
      "/dashboard",
      "/contacts?contactId=" + fixtures.contactA,
      "/tasks#today",
      "/notifications",
      "/settings?panel=profile",
    ]) {
      const id = await notice(fixtures.ownerMemberA, fixtures.orgA, {
        title: "Canonical synthetic notice",
        href,
      });
      expect((await marked(await mark(owner, id))).href).toBe(href);
    }
  });
  it("canonicalizes uppercase notification IDs into the same durable command namespace", async () => {
    const id = await notice(),
      key = randomUUID();
    const first = await marked(await mark(owner, id.toUpperCase(), key));
    expect(first.id).toBe(id);
    expect(await marked(await mark(owner, id, key))).toEqual(first);
    expect(await counts(id)).toEqual({ audits: 1, receipts: 1, events: 0 });
  });
  it("paginates without duplication and rejects changed actor, tenant, role or permission context", async () => {
    await notice();
    await notice();
    const first = await page(await owner.request(path(owner) + "?limit=1"));
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(first.nextCursor!);
    const next = await page(await owner.request(path(owner) + `?limit=1&cursor=${cursor}`));
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).not.toBe(first.items[0].id);
    await problem(await agent.request(path(agent) + `?cursor=${cursor}`), 422);
    await problem(await secondOrganization.request(path(secondOrganization) + `?cursor=${cursor}`), 422);
    await changedGrants(["crm.tasks.read"], async () =>
      problem(await owner.request(path(owner) + `?cursor=${cursor}`), 422),
    );
  });
  it("rejects closed, duplicated and malformed list queries without returning a fabricated empty list", async () => {
    for (const query of [
      "limit=",
      "limit=0",
      "limit=101",
      "limit=-1",
      "limit=1.0",
      "limit=1e1",
      "limit=1&limit=2",
      "limit%5B%5D=1",
      "cursor=",
      "cursor=a&cursor=b",
      "cursor%5B%5D=a",
      "cursor=not-signed",
      "cursor=" + "a".repeat(4097),
      "memberId=" + fixtures.agentMemberA,
      "filter=%7B%7D",
    ])
      await problem(await owner.request(path(owner) + "?" + query), 422);
  });
  it("rejects nonempty mutation bodies, extra query keys and unavailable invented read/detail routes", async () => {
    const id = await notice();
    for (const body of [{ readAt: "2000-01-01T00:00:00Z" }, { memberId: fixtures.agentMemberA }, []])
      await problem(await mark(owner, id, randomUUID(), body), 422);
    for (const body of [null, true, "read"]) await problem(await mark(owner, id, randomUUID(), body), 400);
    await problem(await owner.command(path(owner, id) + "?all=true", {}), 422);
    await problem(await owner.request(path(owner, id)), 404);
    await problem(await owner.request(path(owner) + "/" + id), 404);
    expect((await persisted(id)).read_at).toBeNull();
    expect(await counts(id)).toEqual({ audits: 0, receipts: 0, events: 0 });
  });
  it("requires verified identity, exact origin, CSRF and the original printable idempotency key", async () => {
    const id = await notice();
    await problem(
      await fetch(apiOrigin + path(owner), { headers: { origin: "http://localhost:3000" } }),
      401,
    );
    for (const headers of [
      {
        origin: "https://elsewhere.example.test",
        "x-csrf-token": owner.csrf,
        "idempotency-key": randomUUID(),
      },
      { origin: "http://localhost:3000", "idempotency-key": randomUUID() },
      { origin: "http://localhost:3000", "x-csrf-token": "wrong", "idempotency-key": randomUUID() },
    ] as Record<string, string>[])
      await problem(await owner.request(path(owner, id), { method: "POST", headers }), 403);
    for (const key of [undefined, "", "a".repeat(101), "not printable\tkey"])
      await problem(
        await owner.request(path(owner, id), {
          method: "POST",
          headers: { "x-csrf-token": owner.csrf, ...(key === undefined ? {} : { "idempotency-key": key }) },
        }),
        400,
      );
    expect((await persisted(id)).read_at).toBeNull();
  });
  it("reconciles concurrent same-key commands once with a DB timestamp, safe audit and unchanged lead", async () => {
    const id = await notice(),
      key = randomUUID();
    const before = (
      await admin.query("SELECT to_jsonb(l)AS body FROM app.lead l WHERE id=$1", [fixtures.leadA])
    ).rows[0].body;
    const bodies = await Promise.all(
      [mark(owner, id, key), mark(owner, id, key), mark(owner, id, key)].map(async (request) =>
        marked(await request),
      ),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    const row = await persisted(id);
    expect(row.read_at.toISOString()).toBe(bodies[0].readAt);
    expect(row.updated_at.toISOString()).toBe(bodies[0].readAt);
    expect(row.row_version).toBe("2");
    expect(await counts(id)).toEqual({ audits: 1, receipts: 1, events: 0 });
    const audit = (
      await admin.query(
        "SELECT actor_ref,action,resource_type,safe_diff FROM app.audit_event WHERE resource_id=$1",
        [id],
      )
    ).rows[0];
    expect(audit).toEqual({
      actor_ref: fixtures.ownerUser,
      action: "notification.read",
      resource_type: "notification",
      safe_diff: { resourceVersion: 2 },
    });
    expect(JSON.stringify(audit)).not.toContain(title);
    expect(
      (await admin.query("SELECT to_jsonb(l)AS body FROM app.lead l WHERE id=$1", [fixtures.leadA])).rows[0]
        .body,
    ).toEqual(before);
  });
  it("serializes different keys while preserving the first timestamp and one transition audit", async () => {
    const id = await notice();
    const bodies = await Promise.all(
      [mark(owner, id), mark(owner, id)].map(async (request) => marked(await request)),
    );
    expect(bodies[0]).toEqual(bodies[1]);
    expect((await persisted(id)).row_version).toBe("2");
    expect(await counts(id)).toEqual({ audits: 1, receipts: 2, events: 0 });
  });
  it("replays the original response after later valid metadata while later keys never remark the row", async () => {
    const id = await notice(),
      key = randomUUID();
    const original = await marked(await mark(owner, id, key));
    await admin.query("UPDATE app.notification SET safe_payload=$2 WHERE id=$1", [
      id,
      JSON.stringify({ title: "Later synthetic metadata" }),
    ]);
    expect(await marked(await mark(owner, id, key))).toEqual(original);
    expect(await marked(await mark(owner, id))).toEqual({
      id,
      kind: original.kind,
      title: "Later synthetic metadata",
      readAt: original.readAt,
    });
    expect((await persisted(id)).row_version).toBe("2");
    expect(await counts(id)).toEqual({ audits: 1, receipts: 2, events: 0 });
  });
  it("rechecks both current notification grants before returning a retained successful receipt", async () => {
    const id = await notice(),
      key = randomUUID();
    const original = await marked(await mark(owner, id, key));
    for (const code of ["self.notifications.read", "self.notifications.write"])
      await changedGrants([code], async () => {
        await problem(await mark(owner, id, key), 403);
        await problem(await mark(owner, id), 403);
        if (code.endsWith("read")) await problem(await owner.request(path(owner)), 403);
      });
    expect(await marked(await mark(owner, id, key))).toEqual(original);
    expect(await counts(id)).toEqual({ audits: 1, receipts: 1, events: 0 });
  });
  it("denies inactive membership and ownership changes before historical replay", async () => {
    const id = await notice(),
      key = randomUUID();
    await marked(await mark(owner, id, key));
    try {
      await admin.query("UPDATE app.membership SET status='disabled'WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
      await problem(await mark(owner, id, key), 403);
    } finally {
      await admin.query("UPDATE app.membership SET status='active'WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.ownerMemberA,
      ]);
    }
    try {
      await admin.query("UPDATE app.notification SET member_id=$2 WHERE id=$1", [id, fixtures.agentMemberA]);
      await problem(await mark(owner, id, key), 404);
    } finally {
      await admin.query("UPDATE app.notification SET member_id=$2 WHERE id=$1", [id, fixtures.ownerMemberA]);
    }
    expect(await counts(id)).toEqual({ audits: 1, receipts: 1, events: 0 });
  });
  it("fails closed for unavailable metadata before transition or receipt replay without leaking it", async () => {
    for (const payload of [
      { title: "" },
      { title: "x".repeat(201) },
      { title: 42 },
      { title: "Private", href: "https://outside.example.test/private" },
      { title: "Private", href: "//outside.example.test/private" },
      { title: "Private", href: "/api/v1/session" },
      { title: "Private", href: "/pipeline/%2e%2e/dev/session" },
      { title: "Private", href: "/pipeline\\private" },
      { title: "Private", href: "/contacts/private" },
      { title: "Private", href: "/tasks/" },
      { title: "Private", href: "/settings?" },
      { title: "Private", href: "/tasks#" },
      { title: "Private", href: "/tasks?x=%20bad" },
      { title: "Private", href: "/tasks?x=%zz" },
    ]) {
      const id = await notice(fixtures.ownerMemberA, fixtures.orgA, payload);
      try {
        const denied = await problem(await mark(owner, id), 503);
        expect(denied.code).toBe("notification_metadata_unavailable");
        expect(JSON.stringify(denied)).not.toMatch(/outside\.example|Private|%2e|readAt|payload/);
        expect((await persisted(id)).read_at).toBeNull();
        expect(await counts(id)).toEqual({ audits: 0, receipts: 0, events: 0 });
      } finally {
        await admin.query("UPDATE app.notification SET safe_payload=$2 WHERE id=$1", [
          id,
          JSON.stringify({ title: "Restored synthetic metadata" }),
        ]);
      }
    }
    const id = await notice(),
      key = randomUUID();
    await marked(await mark(owner, id, key));
    try {
      await admin.query("UPDATE app.notification SET kind=''WHERE id=$1", [id]);
      await problem(await mark(owner, id, key), 503);
    } finally {
      await admin.query("UPDATE app.notification SET kind='synthetic.lead.assigned'WHERE id=$1", [id]);
    }
  });
});

describe("actual runtime notification boundary", () => {
  it("uses FORCE-RLS and clears tenant/actor context on the same reused runtime connection", async () => {
    const policy = (
      await admin.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.notification'::regclass",
      )
    ).rows[0];
    expect(policy).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await runtime.query("SELECT id FROM app.notification")).rows).toEqual([]);
    const firstPid = await transaction(ownerA, async (client) => {
      const rows = await client.query("SELECT id FROM app.notification WHERE id=ANY($1::uuid[])", [
        [ownerNotice, agentNotice, foreignNotice],
      ]);
      expect(rows.rows).toEqual([{ id: ownerNotice }]);
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    expect((await runtime.query("SELECT pg_backend_pid()AS pid")).rows[0].pid).toBe(firstPid);
    expect((await runtime.query("SELECT id FROM app.notification")).rows).toEqual([]);
    await transaction(ownerB, async (client) => {
      expect(
        (
          await client.query("SELECT id FROM app.notification WHERE id=ANY($1::uuid[])", [
            [ownerNotice, agentNotice, foreignNotice],
          ])
        ).rows,
      ).toEqual([{ id: foreignNotice }]);
    });
    await transaction(agentA, async (client) => {
      expect(
        (
          await client.query("SELECT id FROM app.notification WHERE id=ANY($1::uuid[])", [
            [ownerNotice, agentNotice, foreignNotice],
          ])
        ).rows,
      ).toEqual([{ id: agentNotice }]);
    });
    expect((await runtime.query("SELECT id FROM app.notification")).rows).toEqual([]);
  });
  it("applies current read/write restrictions to direct SQL, including organization scope", async () => {
    const id = await notice();
    await changedGrants(["self.notifications.read"], () =>
      transaction(ownerA, async (client) => {
        expect((await client.query("SELECT id FROM app.notification WHERE id=$1", [id])).rows).toEqual([]);
        expect(
          (await client.query("UPDATE app.notification SET read_at=clock_timestamp()WHERE id=$1", [id]))
            .rowCount,
        ).toBe(0);
      }),
    );
    await changedGrants(["self.notifications.write"], () =>
      transaction(ownerA, async (client) => {
        expect((await client.query("SELECT id FROM app.notification WHERE id=$1", [id])).rowCount).toBe(1);
        expect(
          (await client.query("UPDATE app.notification SET read_at=clock_timestamp()WHERE id=$1", [id]))
            .rowCount,
        ).toBe(0);
      }),
    );
    await changedGrants(
      [],
      () =>
        transaction(ownerA, async (client) => {
          expect(
            (await client.query("SELECT id FROM app.notification WHERE id=$1", [agentNotice])).rowCount,
          ).toBe(0);
          expect(
            (await client.query("SELECT id FROM app.notification WHERE id=$1 FOR SHARE", [id])).rowCount,
          ).toBe(1);
        }),
      true,
    );
    expect((await persisted(id)).read_at).toBeNull();
  });
  it("has no notification production, delete, payload or member mutation authority", async () => {
    const id = await notice();
    for (const statement of [
      "DELETE FROM app.notification WHERE id=$1",
      "UPDATE app.notification SET member_id='30000000-0000-4000-8000-000000000003'WHERE id=$1",
      "UPDATE app.notification SET safe_payload='{}'WHERE id=$1",
      "UPDATE app.notification SET kind='forged'WHERE id=$1",
      "UPDATE app.notification SET created_at=clock_timestamp()WHERE id=$1",
      "INSERT INTO app.notification(tenant_id,id,member_id,kind,safe_payload)VALUES('10000000-0000-4000-8000-000000000001',$1,'30000000-0000-4000-8000-000000000001','forged','{}')",
    ])
      await expect(transaction(ownerA, (client) => client.query(statement, [id]))).rejects.toMatchObject({
        code: "42501",
      });
    const grants = (
      await admin.query(
        "SELECT has_table_privilege('estate_worker','app.notification','SELECT')AS worker,has_table_privilege('estate_control','app.notification','SELECT')AS control,has_table_privilege('estate_staff_issuer','app.notification','SELECT')AS issuer",
      )
    ).rows[0];
    expect(grants).toEqual({ worker: false, control: false, issuer: false });
  });
  it("stamps the first transition itself and rejects direct repeated, reversed or empty transitions", async () => {
    const id = await notice();
    await expect(
      transaction(ownerA, (client) =>
        client.query("UPDATE app.notification SET row_version=999 WHERE id=$1", [id]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const before = (await admin.query("SELECT clock_timestamp()AS time")).rows[0].time;
    await transaction(ownerA, (client) =>
      client.query(
        "UPDATE app.notification SET read_at='2000-01-01',updated_at='2000-01-01',row_version=999 WHERE id=$1",
        [id],
      ),
    );
    const after = (await admin.query("SELECT clock_timestamp()AS time")).rows[0].time;
    const row = await persisted(id);
    expect(row.row_version).toBe("2");
    expect(row.read_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.read_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(row.updated_at).toEqual(row.read_at);
    for (const assignment of [
      "read_at=NULL",
      "read_at=clock_timestamp()",
      "row_version=3",
      "updated_at=clock_timestamp()",
    ])
      await expect(
        transaction(ownerA, (client) =>
          client.query(`UPDATE app.notification SET ${assignment} WHERE id=$1`, [id]),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    expect(await persisted(id)).toEqual(row);
  });
  it("fails atomically on safe-integer version exhaustion", async () => {
    const id = await notice();
    await admin.query("UPDATE app.notification SET row_version=9007199254740991 WHERE id=$1", [id]);
    await expect(
      transaction(ownerA, (client) =>
        client.query("UPDATE app.notification SET read_at=clock_timestamp()WHERE id=$1", [id]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await persisted(id)).read_at).toBeNull();
    expect((await persisted(id)).row_version).toBe("9007199254740991");
    expect(await counts(id)).toEqual({ audits: 0, receipts: 0, events: 0 });
  });
  it("rolls back the notification, receipt and safe audit with the caller transaction", async () => {
    const id = await notice(),
      key = randomUUID();
    await expect(
      withTenantTransaction(runtime, ownerA, async (client, context) => {
        const response = await new NotificationService(client, context, randomUUID()).markRead(id, key);
        expect(response.status).toBe(201);
        assertContract("Notification", response.body);
        throw new Error("Owned synthetic caller rollback");
      }),
    ).rejects.toThrow("Owned synthetic caller rollback");
    expect((await persisted(id)).read_at).toBeNull();
    expect((await persisted(id)).row_version).toBe("1");
    expect(await counts(id)).toEqual({ audits: 0, receipts: 0, events: 0 });
    await marked(await mark(owner, id, key));
    expect(await counts(id)).toEqual({ audits: 1, receipts: 1, events: 0 });
  });
});
