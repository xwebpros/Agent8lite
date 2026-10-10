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
    throw new Error("Contact edit acceptance requires its owned file-fresh disposable database.");
}
const runtimeName = "contact_edit_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
let agent: ApiSession, owner: ApiSession, other: ApiSession;
const sessions: ApiSession[] = [];
const endpoint = (id: string, session: ApiSession = agent) => `/v1/orgs/${session.orgId}/contacts/${id}`;
const input = (displayName = " Synthetic edited name "): Schemas["ContactWrite"] => ({ displayName });
type Source = { id: string; leadId?: string };
async function source(
  options: { creator?: string; leadOwner?: string; archivedLead?: boolean; tenant?: string } = {},
): Promise<Source> {
  const id = randomUUID(),
    tenant = options.tenant ?? fixtures.orgA;
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,birthday,created_by_member_id)VALUES($1,$2,'Synthetic original contact','2000-02-29',$3)",
    [tenant, id, options.creator ?? fixtures.agentMemberA],
  );
  await admin.query(
    "INSERT INTO app.contact_channel(tenant_id,contact_id,kind,normalized_value,is_primary,created_at)VALUES($1,$2,'email','primary@example.test',true,clock_timestamp()-interval '1 day'),($1,$2,'email','secondary@example.test',false,clock_timestamp()-interval '2 days'),($1,$2,'phone','+15550001234',true,clock_timestamp()-interval '1 day')",
    [tenant, id],
  );
  if (options.leadOwner) {
    const leadId = randomUUID();
    await admin.query(
      "INSERT INTO app.lead(tenant_id,id,contact_id,source_id,stage_id,owner_member_id,archived_at)VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN clock_timestamp() END)",
      [
        tenant,
        leadId,
        id,
        tenant === fixtures.orgA ? fixtures.sourceA : fixtures.sourceB,
        stageId(tenant === fixtures.orgA ? 1 : 2, 1),
        options.leadOwner,
        options.archivedLead ?? false,
      ],
    );
    return { id, leadId };
  }
  return { id };
}
async function patch(
  id: string,
  body: Schemas["ContactWrite"] = input(),
  key = randomUUID(),
  revision = '"1"',
  session: ApiSession = agent,
) {
  return session.command(endpoint(id, session), body, { method: "PATCH", key, revision });
}
async function receipt(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  assertContract("Contact", body);
  expect(response.headers.get("etag")).toBe('"' + body.version + '"');
  return body;
}
async function current(id: string, session: ApiSession = agent) {
  return (await session.read(endpoint(id, session), "Contact")).body;
}
async function stored(id: string) {
  return (
    await admin.query(
      "SELECT to_jsonb(c) contact,(SELECT jsonb_agg(to_jsonb(ch)ORDER BY ch.id) FROM app.contact_channel ch WHERE ch.tenant_id=c.tenant_id AND ch.contact_id=c.id) channels FROM app.contact c WHERE c.tenant_id=$1 AND c.id=$2",
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function counts(id: string) {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2::text) audits,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1 AND route_key LIKE '%'||$2::text) receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1) outbox,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1) consent",
      [fixtures.orgA, id],
    )
  ).rows[0];
}
async function unchanged(id: string, operation: () => Promise<unknown>) {
  const before = await stored(id),
    effects = await counts(id);
  await operation();
  expect(await stored(id)).toEqual(before);
  expect(await counts(id)).toEqual(effects);
}
async function grants<T>(
  operation: () => Promise<T>,
  options: { read?: PermissionGrant["scope"]; write?: PermissionGrant["scope"]; remove?: string[] } = {},
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    )
  ).rows[0];
  const next = (original.permission_grants as PermissionGrant[])
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) =>
      g.code === "crm.contacts.read" && options.read
        ? { ...g, scope: options.read }
        : g.code === "crm.contacts.write" && options.write
          ? { ...g, scope: options.write }
          : g,
    );
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
async function capability<T>(operation: () => Promise<T>, state = "enabled", until: string | null = null) {
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
async function direct<T>(
  operation: (crm: CrmService, client: PoolClient, context: TenantContext) => Promise<T>,
) {
  return withTenantTransaction(
    runtime,
    { userId: fixtures.agentUser, organizationId: fixtures.orgA },
    (client, context) => operation(new CrmService(client, context, randomUUID()), client, context),
  );
}
const route = (id: string) => `PATCH /v1/orgs/${fixtures.orgA}/contacts/${id}`;
async function directPatch(id: string, body: unknown = input(), key = randomUUID(), revision = '"1"') {
  return direct((crm) => crm.patchContact(id, body, revision, key, route(id)));
}
async function waitForLock() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (
      (
        await admin.query(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting",
          [runtimeName],
        )
      ).rows[0].waiting
    )
      return;
    await admin.query("SELECT pg_sleep(0.01)");
  }
  throw new Error("Owned contact edit did not observe its actual lock wait.");
}
async function held<T>(
  lock: (client: PoolClient) => Promise<unknown>,
  launch: () => Promise<T>,
  whileWaiting: (client: PoolClient) => Promise<unknown>,
  assertion: (result: Promise<T>) => Promise<unknown>,
) {
  const blocker = await admin.connect();
  let pending: Promise<T> | undefined;
  try {
    await blocker.query("BEGIN");
    await lock(blocker);
    pending = launch();
    void pending.catch(() => undefined);
    await waitForLock();
    await whileWaiting(blocker);
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
  other = await new ApiSession().signIn();
  sessions.push(agent, owner, other);
  expect((await other.switchOrganization(fixtures.orgB)).status).toBe(200);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("ADR039 registered contact PATCH receipts and atomic channels", () => {
  it("concurrent identical keys produce one transition/audit/receipt and the same strong response", async () => {
    const { id } = await source(),
      key = randomUUID(),
      body = {
        displayName: " New contact ",
        emails: ["NEW@example.test"],
        phones: ["+1 (555) 888-9999"],
        birthday: null,
      } satisfies Schemas["ContactWrite"];
    const before = await counts(id),
      responses = await Promise.all([patch(id, body, key), patch(id, body, key)]),
      values = await Promise.all(responses.map(receipt));
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toMatchObject({
      id,
      displayName: "New contact",
      emails: ["new@example.test"],
      phones: ["+15558889999"],
      birthday: null,
      version: 2,
    });
    expect(await counts(id)).toEqual({ ...before, audits: 1, receipts: 1 });
    const audit = (
      await admin.query(
        "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
        [fixtures.orgA, id],
      )
    ).rows;
    expect(audit).toEqual([{ action: "contact.updated", safe_diff: { resourceVersion: 2 } }]);
  });
  it("binds exact body and original revision to a key", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await unchanged(id, async () => {
      await assertProblem(await patch(id, input("changed"), key), 409);
      await assertProblem(await patch(id, input(), key, '"2"'), 409);
    });
  });
  it("concurrent fresh keys and the same revision have one200 and one412 with no half replacement", async () => {
    const { id } = await source(),
      results = await Promise.all([
        patch(id, { displayName: "A", emails: ["a@example.test"] }),
        patch(id, { displayName: "B", emails: ["b@example.test"] }),
      ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    const success = await receipt(results.find((response) => response.status === 200)!);
    await assertProblem(results.find((response) => response.status === 412)!, 412);
    expect(await current(id)).toEqual(success);
    expect(await counts(id)).toMatchObject({ audits: 1, receipts: 1 });
  });
  it("historical replay keeps its body/ETag after a later edit without overwriting current data", async () => {
    const { id } = await source(),
      key = randomUUID(),
      original = input("first"),
      first = await receipt(await patch(id, original, key));
    const latest = await receipt(await patch(id, input("later"), randomUUID(), '"2"'));
    const before = await counts(id),
      replay = await patch(id, original, key);
    expect(replay.headers.get("etag")).toBe('"2"');
    expect(await receipt(replay)).toEqual(first);
    expect(await current(id)).toEqual(latest);
    expect(await counts(id)).toEqual(before);
  });
  it("normalizes unique channel sets and orders a new primary before an older retained secondary", async () => {
    const { id } = await source(),
      body: Schemas["ContactWrite"] = {
        displayName: " Normalized ",
        emails: ["NEW@example.test", "secondary@example.test", "new@example.test"],
        phones: ["+1 (555) 333-4444", "+15553334444"],
      };
    const saved = await receipt(await patch(id, body));
    expect(saved.emails).toEqual(["new@example.test", "secondary@example.test"]);
    expect(saved.phones).toEqual(["+15553334444"]);
    expect(saved.birthday).toBe("2000-02-29");
    expect(await current(id)).toEqual(saved);
    const page = (
      await agent.read(
        `/v1/orgs/${agent.orgId}/contacts?filter=${encodeURIComponent(JSON.stringify({ q: "Normalized" }))}`,
        "PageContact",
      )
    ).body;
    expect(page.items.find((item) => item.id === id)?.emails).toEqual(saved.emails);
  });
  it("omitted channels/birthday preserve source, explicit empty arrays deactivate without deleting provenance", async () => {
    const { id } = await source(),
      preserved = await receipt(await patch(id));
    expect(preserved).toMatchObject({
      emails: ["primary@example.test", "secondary@example.test"],
      phones: ["+15550001234"],
      birthday: "2000-02-29",
    });
    const cleared = await receipt(
      await patch(
        id,
        { displayName: "cleared", emails: [], phones: [], birthday: null },
        randomUUID(),
        '"2"',
      ),
    );
    expect(cleared).toMatchObject({ emails: [], phones: [], birthday: null });
    const channels = (
      await admin.query("SELECT active FROM app.contact_channel WHERE tenant_id=$1 AND contact_id=$2", [
        fixtures.orgA,
        id,
      ])
    ).rows;
    expect(channels).toHaveLength(3);
    expect(channels.every((row) => row.active === false)).toBe(true);
  });
  it("an invalid channel rolls back contact/channel/audit/receipt and does not alter unrelated modules", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      await assertProblem(
        await patch(id, {
          displayName: "must rollback",
          emails: ["valid@example.test"],
          phones: ["BAD_PHONE"],
        }),
        422,
      );
    });
  });
  it("a caller rollback removes all successful provisional contact/channel/audit/receipt effects", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      await expect(
        direct(async (crm) => {
          await crm.patchContact(
            id,
            { displayName: "rollback", emails: ["rollback@example.test"] },
            '"1"',
            randomUUID(),
            route(id),
          );
          throw new Error("Owned rollback sentinel");
        }),
      ).rejects.toThrow("Owned rollback sentinel");
    });
  });
  it("closed bodies, required key/revision, origin and CSRF fail before any effects", async () => {
    const { id } = await source();
    await unchanged(id, async () => {
      expect(
        (
          await assertProblem(
            await agent.command(endpoint(id) + "?filter=unpublished", input(), {
              method: "PATCH",
              revision: '"1"',
            }),
            422,
          )
        ).code,
      ).toBe("query_invalid");
      for (const body of [
        { displayName: "x", tenantId: fixtures.orgB },
        { displayName: "x", emails: ["bad"] },
        { displayName: "x", phones: Array.from({ length: 11 }, () => "+15550009999") },
      ])
        await assertProblem(
          await agent.command(endpoint(id), body, { method: "PATCH", revision: '"1"' }),
          422,
        );
      const missing: Record<string, string>[] = [
        { "x-csrf-token": agent.csrf, "if-match": '"1"' },
        { "x-csrf-token": agent.csrf, "idempotency-key": randomUUID() },
      ];
      for (const headers of missing)
        await assertProblem(
          await agent.request(endpoint(id), { method: "PATCH", headers, body: JSON.stringify(input()) }),
          400,
        );
      await assertProblem(
        await agent.command(endpoint(id), input(), {
          method: "PATCH",
          key: randomUUID(),
          revision: '"1"',
          csrf: "wrong",
        }),
        403,
      );
      await assertProblem(
        await agent.request(endpoint(id), {
          method: "PATCH",
          headers: {
            origin: "https://invalid.example.test",
            "x-csrf-token": agent.csrf,
            "idempotency-key": randomUUID(),
            "if-match": '"1"',
          },
          body: JSON.stringify(input()),
        }),
        403,
      );
    });
  });
  it("expired matching receipts409 without renewal or effects; altered input remains409", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at='2000-01-01Z' WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
      [fixtures.orgA, route(id), key],
    );
    const expires = (
      await admin.query(
        "SELECT expires_at::text FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(id), key],
      )
    ).rows[0].expires_at;
    await unchanged(id, async () => {
      expect((await assertProblem(await patch(id, input(), key), 409)).code).toBe("receipt_expired");
      expect((await assertProblem(await patch(id, input("altered"), key), 409)).code).toBe(
        "idempotency_conflict",
      );
    });
    expect(
      (
        await admin.query(
          "SELECT expires_at::text FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
          [fixtures.orgA, route(id), key],
        )
      ).rows[0].expires_at,
    ).toBe(expires);
  });
});

describe("original receipt compatibility and safe numeric revisions", () => {
  it("contact ownership does not require a newly invented lead-read or lead-write grant", async () => {
    const { id } = await source({ leadOwner: fixtures.agentMemberA });
    await grants(
      async () => {
        expect(await receipt(await patch(id))).toMatchObject({ id, version: 2 });
      },
      { remove: ["crm.leads.read", "crm.leads.write"] },
    );
  });
  it.each(['"0001"', "0001"])(
    "preserves accepted original revision spelling%s in hash/replay",
    async (revision) => {
      const { id } = await source(),
        key = randomUUID(),
        body = input();
      const first = await receipt(await patch(id, body, key, revision));
      expect(await receipt(await patch(id, body, key, revision))).toEqual(first);
      await unchanged(id, async () => {
        expect((await assertProblem(await patch(id, body, key, '"1"'), 409)).code).toBe(
          "idempotency_conflict",
        );
      });
    },
  );
  it("replays a retained receipt created with the original generic hash protocol", async () => {
    const { id } = await source(),
      key = randomUUID(),
      body = input(" Legacy name "),
      revision = "0001";
    await admin.query(
      "UPDATE app.contact SET display_name='Legacy name',row_version=2 WHERE tenant_id=$1 AND id=$2",
      [fixtures.orgA, id],
    );
    const historical = await current(id);
    const hash = createHash("sha256")
      .update(stable({ body, expectedVersion: revision }))
      .digest("hex");
    await admin.query(
      "INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,expires_at)VALUES($1,$2,$3,$4,$5,$6,200,clock_timestamp()+interval '1 day')",
      [fixtures.orgA, fixtures.agentUser, route(id), key, hash, JSON.stringify(historical)],
    );
    await unchanged(id, async () => {
      expect(await receipt(await patch(id, body, key, revision))).toEqual(historical);
    });
  });
  it("denies unsafe current and exhausted next revisions without effects", async () => {
    const { id } = await source();
    await admin.query("UPDATE app.contact SET row_version=9007199254740992 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    await unchanged(id, async () => {
      await expect(directPatch(id)).rejects.toMatchObject({ status: 503, code: "resource_unavailable" });
    });
    await admin.query("UPDATE app.contact SET row_version=9007199254740991 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    await unchanged(id, async () => {
      await expect(directPatch(id, input(), randomUUID(), '"9007199254740991"')).rejects.toMatchObject({
        status: 409,
        code: "revision_exhausted",
      });
    });
  });
});

describe("current contact read AND write authority at original and replay boundaries", () => {
  it("wider read cannot authorize narrower write and wider write cannot bypass missing read", async () => {
    const { id } = await source({ creator: fixtures.ownerMemberA, leadOwner: fixtures.ownerMemberA });
    for (const scopes of [
      { read: "organization" as const, write: "own" as const },
      { read: "own" as const, write: "organization" as const },
    ])
      await grants(
        () =>
          unchanged(id, async () => {
            await assertProblem(await patch(id), 404);
          }),
        scopes,
      );
  });
  it("foreign tenant, unknown UUID and archived contact are unavailable without changing channels", async () => {
    const foreign = await source({ tenant: fixtures.orgB, creator: fixtures.ownerMemberB });
    await assertProblem(await patch(foreign.id), 404);
    await assertProblem(await patch(randomUUID()), 404);
    expect((await receipt(await patch(foreign.id, input(), randomUUID(), '"1"', other))).id).toBe(foreign.id);
    const { id } = await source();
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await patch(id), 404);
    });
  });
  it("replay rechecks ownership/archive/current grants and cannot disclose a now hidden historical receipt", async () => {
    const { id, leadId } = await source({ creator: fixtures.ownerMemberA, leadOwner: fixtures.agentMemberA }),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      leadId,
      fixtures.ownerMemberA,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await patch(id, input(), key), 404);
    });
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      leadId,
      fixtures.agentMemberA,
    ]);
    for (const permission of ["crm.contacts.read", "crm.contacts.write"])
      await grants(
        () =>
          unchanged(id, async () => {
            await assertProblem(await patch(id, input(), key), 403);
          }),
        { remove: [permission] },
      );
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      id,
    ]);
    await unchanged(id, async () => {
      await assertProblem(await patch(id, input(), key), 404);
    });
  });
  it("membership and CRM revocation apply before both fresh edits and exact receipt replay", async () => {
    const { id } = await source(),
      key = randomUUID();
    await receipt(await patch(id, input(), key));
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(id, async () => {
        await assertProblem(await patch(id, input(), key), 403);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active'WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
    await capability(
      () =>
        unchanged(id, async () => {
          await assertProblem(await patch(id, input(), key), 403);
          await assertProblem(await patch(id, input("new"), randomUUID(), '"2"'), 403);
        }),
      "disabled",
    );
  });
  it("denies forged authority and missing transaction context, and pooled reuse leaves no tenant", async () => {
    const { id } = await source();
    const context = await direct(async (_crm, _client, context) => context);
    const connection = await runtime.connect();
    try {
      await expect(
        new CrmService(connection, context, "owned").patchContact(
          id,
          input(),
          '"1"',
          randomUUID(),
          route(id),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect((await connection.query("SELECT id FROM app.contact")).rowCount).toBe(0);
    } finally {
      connection.release();
    }
    for (const forgery of [
      { userId: fixtures.ownerUser },
      { memberId: fixtures.ownerMemberA },
      { organizationId: fixtures.orgB },
      { roleId: randomUUID() },
      { permissions: [] },
    ])
      await direct(async (_crm, client, current) => {
        await expect(
          new CrmService(client, { ...current, ...forgery }, "owned").patchContact(
            id,
            input(),
            '"1"',
            randomUUID(),
            `PATCH /v1/orgs/${forgery.organizationId ?? current.organizationId}/contacts/${id}`,
          ),
        ).rejects.toMatchObject({ status: 403 });
      });
    await directPatch(id);
    expect((await runtime.query("SELECT id FROM app.contact")).rowCount).toBe(0);
  });
  it("caller mutation while waiting cannot change the captured body/hash", async () => {
    const { id } = await source(),
      key = randomUUID(),
      body = { displayName: " Original frozen name ", emails: ["original@example.test"] };
    let value: unknown;
    await held(
      (blocker) =>
        blocker.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
          fixtures.orgA,
          id,
        ]),
      () => directPatch(id, body, key),
      async () => {
        body.displayName = "mutated";
        body.emails[0] = "mutated@example.test";
      },
      async (pending) => {
        value = await pending;
      },
    );
    expect(value).toMatchObject({
      body: { displayName: "Original frozen name", emails: ["original@example.test"] },
    });
    expect(
      (
        await directPatch(
          id,
          { displayName: " Original frozen name ", emails: ["original@example.test"] },
          key,
        )
      ).body,
    ).toEqual((value as { body: unknown }).body);
  });
});

describe("observed contact/source/office/advisory waits recheck scope and database clocks", () => {
  it("contact wait cannot borrow organization read after current own-write source reassignment", async () => {
    const { id, leadId } = await source({ creator: fixtures.ownerMemberA, leadOwner: fixtures.agentMemberA });
    await grants(
      () =>
        unchanged(id, () =>
          held(
            (blocker) =>
              blocker.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                fixtures.orgA,
                id,
              ]),
            () => directPatch(id),
            (blocker) =>
              blocker.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
                fixtures.orgA,
                leadId,
                fixtures.ownerMemberA,
              ]),
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 404 });
            },
          ),
        ),
      { read: "organization", write: "own" },
    );
  });
  it("locked active source reassignment denies without a transient contact/channel write", async () => {
    const { id, leadId } = await source({ creator: fixtures.ownerMemberA, leadOwner: fixtures.agentMemberA });
    await unchanged(id, () =>
      held(
        (blocker) =>
          blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            leadId,
          ]),
        () => directPatch(id),
        (blocker) =>
          blocker.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            leadId,
            fixtures.ownerMemberA,
          ]),
        async (pending) => {
          await expect(pending).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("an archived source that reactivates while its SHARE lock waits cannot widen creator scope", async () => {
    const { id, leadId } = await source({
      creator: fixtures.agentMemberA,
      leadOwner: fixtures.ownerMemberA,
      archivedLead: true,
    });
    await unchanged(id, () =>
      held(
        (blocker) =>
          blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            leadId,
          ]),
        () => directPatch(id),
        (blocker) =>
          blocker.query("UPDATE app.lead SET archived_at=NULL WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            leadId,
          ]),
        async (pending) => {
          await expect(pending).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("team owner-office removal while the ordered office SHARE waits denies even with organization read", async () => {
    const { id } = await source({ creator: fixtures.ownerMemberA, leadOwner: fixtures.ownerMemberA }),
      office = randomUUID();
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,'Owned edit office','UTC')",
      [fixtures.orgA, office],
    );
    await admin.query(
      "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
      [fixtures.orgA, office, fixtures.agentMemberA, fixtures.ownerMemberA],
    );
    await grants(
      () =>
        unchanged(id, () =>
          held(
            (blocker) =>
              blocker.query(
                "SELECT member_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, office, fixtures.ownerMemberA],
              ),
            () => directPatch(id),
            (blocker) =>
              blocker.query(
                "DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3",
                [fixtures.orgA, office, fixtures.ownerMemberA],
              ),
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 404 });
            },
          ),
        ),
      { read: "organization", write: "team" },
    );
  });
  it.each(["contact", "source", "advisory"] as const)(
    "CRM expiry after a genuine %s wait rolls back original and replay effects",
    async (kind) => {
      const { id, leadId } = await source({ leadOwner: fixtures.agentMemberA }),
        key = randomUUID();
      await capability(async () => {
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '700 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA],
        );
        await unchanged(id, () =>
          held(
            (blocker) =>
              kind === "contact"
                ? blocker.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                    fixtures.orgA,
                    id,
                  ])
                : kind === "source"
                  ? blocker.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                      fixtures.orgA,
                      leadId,
                    ])
                  : blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                      `${fixtures.orgA}:${fixtures.agentUser}:${route(id)}:${key}`,
                    ]),
            () => directPatch(id, input(), key),
            async () => {
              await admin.query("SELECT pg_sleep(0.8)");
            },
            async (pending) => {
              await expect(pending).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
            },
          ),
        );
      });
    },
  );
});
