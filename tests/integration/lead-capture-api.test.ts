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
    throw new Error("Lead capture acceptance requires an owned file-fresh disposable database.");
}
const runtimeName = "lead_capture_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
let agent: ApiSession, owner: ApiSession, other: ApiSession;
const sessions: ApiSession[] = [];
const path = (resource: "contacts" | "leads", session: ApiSession = agent) =>
  "/v1/orgs/" + session.orgId + "/" + resource;
const route = (resource: "contacts" | "leads", org: string = fixtures.orgA) =>
  "POST /v1/orgs/" + org + "/" + resource;
const contactInput = (name = " Synthetic new contact "): Schemas["ContactWrite"] => ({
  displayName: name,
  emails: ["CAPTURE@example.test", "capture@example.test"],
  phones: ["+1 (555) 777-8888"],
  birthday: "2000-02-29",
});
const leadInput = (contactId: string): Schemas["LeadCreate"] => ({
  contactId,
  sourceId: fixtures.sourceA,
  ownerMemberId: fixtures.agentMemberA,
  intent: "buyer",
  timeline: "Synthetic timeline",
});
async function receipt<T extends "Contact" | "Lead">(response: Response, resource: T): Promise<Schemas[T]> {
  expect(response.status).toBe(201);
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBe('"1"');
  const value = await response.json();
  assertContract(resource, value);
  expect(value.version).toBe(1);
  return value as Schemas[T];
}
async function newContact(session: ApiSession = agent) {
  return receipt(await session.command(path("contacts", session), contactInput()), "Contact");
}
async function effects() {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.contact WHERE tenant_id=$1)contacts,(SELECT count(*)::int FROM app.contact_channel WHERE tenant_id=$1)channels,(SELECT count(*)::int FROM app.lead WHERE tenant_id=$1)leads,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1)audits,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1)receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1)outbox,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1)activities,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent",
      [fixtures.orgA],
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
async function directPost(resource: "contacts" | "leads", body: unknown, key = randomUUID()) {
  return direct((crm) =>
    resource === "contacts"
      ? crm.postContact(body, key, route(resource))
      : crm.postLead(body, key, route(resource)),
  );
}
async function grants<T>(
  operation: () => Promise<T>,
  options: { remove?: string[]; scopes?: Record<string, PermissionGrant["scope"]> } = {},
) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [fixtures.orgA, fixtures.agentMemberA],
    )
  ).rows[0];
  const next = (original.permission_grants as PermissionGrant[])
    .filter((g) => !options.remove?.includes(g.code))
    .map((g) => ({ ...g, scope: options.scopes?.[g.code] ?? g.scope }));
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
  throw new Error("Owned capture did not observe an actual database lock wait.");
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
  other = await new ApiSession().signIn();
  sessions.push(agent, owner, other);
  expect((await other.switchOrganization(fixtures.orgB)).status).toBe(200);
});
afterAll(async () => {
  for (const session of sessions)
    if (session.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end()]);
});

describe("ADR040 independent durable Contact POST and Lead POST", () => {
  it("concurrent identical Contact commands create one normalized contact/channel set/audit/receipt", async () => {
    const before = await effects(),
      key = randomUUID(),
      body = contactInput();
    const values = await Promise.all(
      (
        await Promise.all([
          agent.command(path("contacts"), body, { key }),
          agent.command(path("contacts"), body, { key }),
        ])
      ).map((r) => receipt(r, "Contact")),
    );
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toMatchObject({
      displayName: "Synthetic new contact",
      emails: ["capture@example.test"],
      phones: ["+15557778888"],
      birthday: "2000-02-29",
    });
    expect(await effects()).toEqual({
      ...before,
      contacts: before.contacts + 1,
      channels: before.channels + 2,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
    });
    expect(
      (
        await admin.query(
          "SELECT action,safe_diff FROM app.audit_event WHERE tenant_id=$1 AND resource_id=$2",
          [fixtures.orgA, values[0].id],
        )
      ).rows,
    ).toEqual([{ action: "contact.created", safe_diff: { resourceVersion: 1 } }]);
  });
  it("concurrent identical Lead commands create one lead/activity/safe outbox/audit/receipt", async () => {
    const contact = await newContact(),
      key = randomUUID(),
      body = leadInput(contact.id),
      before = await effects();
    const values = await Promise.all(
      (
        await Promise.all([
          agent.command(path("leads"), body, { key }),
          agent.command(path("leads"), body, { key }),
        ])
      ).map((r) => receipt(r, "Lead")),
    );
    expect(values[0]).toEqual(values[1]);
    expect(values[0]).toMatchObject({ ...body, stageId: stageId(1, 1), score: null, scoreVersion: null });
    expect(await effects()).toEqual({
      ...before,
      leads: before.leads + 1,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
      outbox: before.outbox + 1,
      activities: before.activities + 1,
    });
    const event = (
      await admin.query("SELECT event_type,payload FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2", [
        fixtures.orgA,
        values[0].id,
      ])
    ).rows[0];
    expect(event.event_type).toBe("lead.captured");
    expect(JSON.stringify(event.payload)).not.toContain("Synthetic timeline");
    expect(JSON.stringify(event.payload)).not.toContain("capture@example.test");
    expect(
      (
        await admin.query("SELECT attribution FROM app.lead WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          values[0].id,
        ])
      ).rows[0].attribution,
    ).toEqual({ source: "manual-synthetic-workspace", sourceId: fixtures.sourceA });
  });
  it("different fresh keys deliberately create distinct contacts and opportunities without a global channel merge", async () => {
    const a = await newContact(),
      b = await newContact();
    expect(a.id).not.toBe(b.id);
    const l1 = await receipt(await agent.command(path("leads"), leadInput(a.id)), "Lead"),
      l2 = await receipt(await agent.command(path("leads"), leadInput(a.id)), "Lead");
    expect(l1.id).not.toBe(l2.id);
  });
  it("changed input under either retained key fails409 before further effects", async () => {
    const contactKey = randomUUID(),
      contact = await receipt(
        await agent.command(path("contacts"), contactInput(), { key: contactKey }),
        "Contact",
      ),
      leadKey = randomUUID(),
      body = leadInput(contact.id);
    await receipt(await agent.command(path("leads"), body, { key: leadKey }), "Lead");
    await unchanged(async () => {
      expect(
        (
          await assertProblem(
            await agent.command(path("contacts"), contactInput("Changed"), { key: contactKey }),
            409,
          )
        ).code,
      ).toBe("idempotency_conflict");
      expect(
        (
          await assertProblem(
            await agent.command(path("leads"), { ...body, intent: "seller" }, { key: leadKey }),
            409,
          )
        ).code,
      ).toBe("idempotency_conflict");
    });
  });
  it("a failed lead step leaves the already acknowledged contact intact and can be explicitly corrected with a new key", async () => {
    const contact = await newContact(),
      body = leadInput(contact.id);
    await unchanged(async () => {
      await assertProblem(await agent.command(path("leads"), { ...body, sourceId: fixtures.sourceB }), 422);
    });
    expect((await agent.read(path("contacts") + "/" + contact.id, "Contact")).body).toEqual(contact);
    expect((await receipt(await agent.command(path("leads"), body), "Lead")).contactId).toBe(contact.id);
  });
  it("historical Contact and Lead receipts preserve original version1 after later edits", async () => {
    const ck = randomUUID(),
      cb = contactInput(),
      c = await receipt(await agent.command(path("contacts"), cb, { key: ck }), "Contact"),
      lk = randomUUID(),
      lb = leadInput(c.id),
      l = await receipt(await agent.command(path("leads"), lb, { key: lk }), "Lead");
    const editedC = await agent.command(
      path("contacts") + "/" + c.id,
      { displayName: "Later current contact" },
      { method: "PATCH", revision: '"1"' },
    );
    expect(editedC.status).toBe(200);
    const editedL = await agent.command(
      path("leads") + "/" + l.id,
      { ownerMemberId: fixtures.agentMemberA, intent: "seller", timeline: "Later" },
      { method: "PATCH", revision: '"1"' },
    );
    expect(editedL.status).toBe(200);
    await unchanged(async () => {
      expect(await receipt(await agent.command(path("contacts"), cb, { key: ck }), "Contact")).toEqual(c);
      expect(await receipt(await agent.command(path("leads"), lb, { key: lk }), "Lead")).toEqual(l);
    });
    expect((await agent.read(path("contacts") + "/" + c.id, "Contact")).body.version).toBe(2);
    expect((await agent.read(path("leads") + "/" + l.id, "Lead")).body.version).toBe(2);
  });
  it.each(["contacts", "leads"] as const)(
    "retains legacy hash and null stored ETag for %s",
    async (resource) => {
      const body = resource === "contacts" ? contactInput() : leadInput((await newContact()).id),
        key = randomUUID(),
        first = await receipt(
          await agent.command(path(resource), body, { key }),
          resource === "contacts" ? "Contact" : "Lead",
        );
      const hash = createHash("sha256")
        .update(stable({ body, expectedVersion: null }))
        .digest("hex");
      await admin.query(
        "UPDATE app.idempotency_record SET request_hash=$4,response_etag=NULL WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(resource), key, hash],
      );
      await unchanged(async () => {
        expect(
          await receipt(
            await agent.command(path(resource), body, { key }),
            resource === "contacts" ? "Contact" : "Lead",
          ),
        ).toEqual(first);
      });
    },
  );
  it("supplied legacy POST If-Match spelling binds the original hash but does not become CAS", async () => {
    const key = randomUUID(),
      body = contactInput(),
      revision = 'W/"1"';
    const first = await receipt(await agent.command(path("contacts"), body, { key, revision }), "Contact");
    await unchanged(async () => {
      expect(
        await receipt(await agent.command(path("contacts"), body, { key, revision }), "Contact"),
      ).toEqual(first);
      expect((await assertProblem(await agent.command(path("contacts"), body, { key }), 409)).code).toBe(
        "idempotency_conflict",
      );
      expect(
        (await assertProblem(await agent.command(path("contacts"), body, { key, revision: '"1"' }), 409))
          .code,
      ).toBe("idempotency_conflict");
    });
  });
  it.each(["contacts", "leads"] as const)(
    "expired matching %s receipt does not renew or insert",
    async (resource) => {
      const body = resource === "contacts" ? contactInput() : leadInput((await newContact()).id),
        key = randomUUID();
      await receipt(
        await agent.command(path(resource), body, { key }),
        resource === "contacts" ? "Contact" : "Lead",
      );
      await admin.query(
        "UPDATE app.idempotency_record SET expires_at='2000-01-01Z' WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
        [fixtures.orgA, route(resource), key],
      );
      await unchanged(async () => {
        expect((await assertProblem(await agent.command(path(resource), body, { key }), 409)).code).toBe(
          "receipt_expired",
        );
        expect(
          (
            await assertProblem(
              await agent.command(
                path(resource),
                resource === "contacts" ? { ...body, displayName: "changed" } : { ...body, intent: "seller" },
                { key },
              ),
              409,
            )
          ).code,
        ).toBe("idempotency_conflict");
      });
      expect(
        (
          await admin.query(
            "SELECT expires_at<'2001-01-01Z' expired FROM app.idempotency_record WHERE tenant_id=$1 AND route_key=$2 AND key=$3",
            [fixtures.orgA, route(resource), key],
          )
        ).rows[0].expired,
      ).toBe(true);
    },
  );
  it("caller rollback removes all provisional contact/channel and lead/event/activity/audit/receipt writes", async () => {
    await unchanged(async () => {
      await expect(
        direct(async (crm) => {
          await crm.postContact(contactInput(), randomUUID(), route("contacts"));
          throw new Error("Owned rollback");
        }),
      ).rejects.toThrow("Owned rollback");
    });
    const c = await newContact();
    await unchanged(async () => {
      await expect(
        direct(async (crm) => {
          await crm.postLead(leadInput(c.id), randomUUID(), route("leads"));
          throw new Error("Owned rollback");
        }),
      ).rejects.toThrow("Owned rollback");
    });
  });
  it("invalid channels and closed bodies/queries fail with no partial command effects", async () => {
    const c = await newContact();
    await unchanged(async () => {
      for (const body of [
        { displayName: "x", tenantId: fixtures.orgB },
        { displayName: "x", phones: ["BAD_PHONE"] },
      ])
        await assertProblem(await agent.command(path("contacts"), body), 422);
      for (const body of [
        { ...leadInput(c.id), stageId: stageId(1, 1) },
        { ...leadInput(c.id), sourceSubmissionId: randomUUID() },
      ])
        await assertProblem(await agent.command(path("leads"), body), 422);
      for (const resource of ["contacts", "leads"] as const)
        expect(
          (
            await assertProblem(
              await agent.command(
                path(resource) + "?unpublished=true",
                resource === "contacts" ? contactInput() : leadInput(c.id),
              ),
              422,
            )
          ).code,
        ).toBe("query_invalid");
    });
  });
  it("requires key/CSRF/origin and direct loopback without adding a POST If-Match requirement", async () => {
    await unchanged(async () => {
      await assertProblem(
        await agent.request(path("contacts"), {
          method: "POST",
          headers: { "x-csrf-token": agent.csrf },
          body: JSON.stringify(contactInput()),
        }),
        400,
      );
      await assertProblem(await agent.command(path("contacts"), contactInput(), { csrf: "wrong" }), 403);
      const deniedHeaders: Record<string, string>[] = [
        { origin: "https://invalid.example.test" },
        { "x-forwarded-for": "203.0.113.1" },
      ];
      for (const headers of deniedHeaders)
        await assertProblem(
          await agent.request(path("contacts"), {
            method: "POST",
            headers: { ...headers, "x-csrf-token": agent.csrf, "idempotency-key": randomUUID() },
            body: JSON.stringify(contactInput()),
          }),
          403,
        );
    });
    expect((await agent.command(path("contacts"), contactInput())).status).toBe(201);
  });
});

describe("current write authority, tenant and source reauthorization", () => {
  it("honors frozen write-only grants on fresh commands and replay without inventing read/source-read prerequisites", async () => {
    await grants(
      async () => {
        const ck = randomUUID(),
          c = await receipt(await agent.command(path("contacts"), contactInput(), { key: ck }), "Contact"),
          lk = randomUUID(),
          body = leadInput(c.id),
          l = await receipt(await agent.command(path("leads"), body, { key: lk }), "Lead");
        expect(
          await receipt(await agent.command(path("contacts"), contactInput(), { key: ck }), "Contact"),
        ).toEqual(c);
        expect(await receipt(await agent.command(path("leads"), body, { key: lk }), "Lead")).toEqual(l);
      },
      { remove: ["crm.contacts.read", "crm.leads.read", "crm.sources.read", "crm.pipeline.read"] },
    );
  });
  it("missing current contact/lead write denies fresh and historical commands", async () => {
    const ck = randomUUID(),
      c = await receipt(await agent.command(path("contacts"), contactInput(), { key: ck }), "Contact"),
      lk = randomUUID(),
      body = leadInput(c.id);
    await receipt(await agent.command(path("leads"), body, { key: lk }), "Lead");
    for (const code of ["crm.contacts.write", "crm.leads.write"])
      await grants(
        () =>
          unchanged(async () => {
            if (code === "crm.contacts.write")
              await assertProblem(await agent.command(path("contacts"), contactInput(), { key: ck }), 403);
            await assertProblem(await agent.command(path("leads"), body, { key: lk }), 403);
            await assertProblem(await agent.command(path("leads"), body), 403);
          }),
        { remove: [code] },
      );
  });
  it("foreign/archived contacts and foreign/disabled owners or source IDs cannot be substituted", async () => {
    const c = await newContact(),
      foreign = await newContact(other);
    await unchanged(async () => {
      await assertProblem(await agent.command(path("leads"), leadInput(foreign.id)), 404);
      await assertProblem(
        await agent.command(path("leads"), { ...leadInput(c.id), ownerMemberId: fixtures.ownerMemberB }),
        422,
      );
      await assertProblem(
        await agent.command(path("leads"), { ...leadInput(c.id), sourceId: fixtures.sourceB }),
        422,
      );
    });
    await admin.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      c.id,
    ]);
    await unchanged(async () => {
      await assertProblem(await agent.command(path("leads"), leadInput(c.id)), 404);
    });
  });
  it("contact and lead replay cannot return a source reassigned outside current own-write scope", async () => {
    const ck = randomUUID(),
      c = await receipt(await agent.command(path("contacts"), contactInput(), { key: ck }), "Contact"),
      lk = randomUUID(),
      body = leadInput(c.id),
      l = await receipt(await agent.command(path("leads"), body, { key: lk }), "Lead");
    await admin.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      l.id,
      fixtures.ownerMemberA,
    ]);
    await unchanged(async () => {
      await assertProblem(await agent.command(path("contacts"), contactInput(), { key: ck }), 404);
      await assertProblem(await agent.command(path("leads"), body, { key: lk }), 404);
    });
  });
  it("current membership and CRM revocation apply before receipt return", async () => {
    const c = await newContact(),
      key = randomUUID(),
      body = leadInput(c.id);
    await receipt(await agent.command(path("leads"), body, { key }), "Lead");
    await capability(
      () =>
        unchanged(async () => {
          await assertProblem(await agent.command(path("leads"), body, { key }), 403);
        }),
      "disabled",
    );
    await admin.query("UPDATE app.membership SET status='disabled' WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.agentMemberA,
    ]);
    try {
      await unchanged(async () => {
        await assertProblem(await agent.command(path("leads"), body, { key }), 403);
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE tenant_id=$1 AND id=$2", [
        fixtures.orgA,
        fixtures.agentMemberA,
      ]);
    }
  });
  it("forged complete authority and missing transaction context cannot write; pool reuse retains no tenant", async () => {
    const context = await direct(async (_crm, _client, context) => context),
      connection = await runtime.connect();
    try {
      await expect(
        new CrmService(connection, context, "owned").postContact(
          contactInput(),
          randomUUID(),
          route("contacts"),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect((await connection.query("SELECT id FROM app.contact")).rowCount).toBe(0);
    } finally {
      connection.release();
    }
    for (const forged of [
      { userId: fixtures.ownerUser },
      { memberId: fixtures.ownerMemberA },
      { organizationId: fixtures.orgB },
      { roleId: randomUUID() },
      { permissions: [] },
    ])
      await direct(async (_crm, client, context) => {
        await expect(
          new CrmService(client, { ...context, ...forged }, "owned").postContact(
            contactInput(),
            randomUUID(),
            route("contacts", forged.organizationId ?? fixtures.orgA),
          ),
        ).rejects.toMatchObject({ status: 403 });
      });
    await directPost("contacts", contactInput());
    expect((await runtime.query("SELECT id FROM app.contact")).rowCount).toBe(0);
  });
});

describe("actual waited source/owner/office/advisory boundaries", () => {
  it("contact archive committed during a genuine contact lock wait prevents lead and all related effects", async () => {
    const c = await newContact();
    await unchanged(() =>
      held(
        (b) =>
          b.query("SELECT id FROM app.contact WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            c.id,
          ]),
        () => directPost("leads", leadInput(c.id)),
        (b) =>
          b.query("UPDATE app.contact SET archived_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            c.id,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("current related-lead reassignment after a real source wait removes contact-write eligibility", async () => {
    const c = await newContact(),
      l = await receipt(await agent.command(path("leads"), leadInput(c.id)), "Lead");
    await unchanged(() =>
      held(
        (b) =>
          b.query("SELECT id FROM app.lead WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [fixtures.orgA, l.id]),
        () => directPost("leads", leadInput(c.id)),
        (b) =>
          b.query("UPDATE app.lead SET owner_member_id=$3 WHERE tenant_id=$1 AND id=$2", [
            fixtures.orgA,
            l.id,
            fixtures.ownerMemberA,
          ]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 404 });
        },
      ),
    );
  });
  it("effective owner disabled while the membership SHARE waits cannot receive a new lead", async () => {
    const c = await newContact();
    await grants(
      () =>
        unchanged(() =>
          held(
            (b) =>
              b.query("SELECT id FROM app.membership WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
                fixtures.orgA,
                fixtures.ownerMemberA,
              ]),
            () => directPost("leads", { ...leadInput(c.id), ownerMemberId: fixtures.ownerMemberA }),
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
      { scopes: { "crm.leads.write": "organization" } },
    );
    await admin.query("UPDATE app.membership SET status='active'WHERE tenant_id=$1 AND id=$2", [
      fixtures.orgA,
      fixtures.ownerMemberA,
    ]);
  });
  it("team office removal after observed link wait denies assignment without borrowing organization contact scope", async () => {
    const c = await newContact(),
      office = randomUUID();
    await admin.query(
      "INSERT INTO app.office(tenant_id,id,name,timezone)VALUES($1,$2,'Owned capture office','UTC')",
      [fixtures.orgA, office],
    );
    await admin.query(
      "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3),($1,$2,$4)",
      [fixtures.orgA, office, fixtures.agentMemberA, fixtures.ownerMemberA],
    );
    await grants(
      () =>
        unchanged(() =>
          held(
            (b) =>
              b.query(
                "SELECT member_id FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3 FOR UPDATE",
                [fixtures.orgA, office, fixtures.ownerMemberA],
              ),
            () => directPost("leads", { ...leadInput(c.id), ownerMemberId: fixtures.ownerMemberA }),
            (b) =>
              b.query("DELETE FROM app.office_member WHERE tenant_id=$1 AND office_id=$2 AND member_id=$3", [
                fixtures.orgA,
                office,
                fixtures.ownerMemberA,
              ]),
            async (p) => {
              await expect(p).rejects.toMatchObject({ status: 422 });
            },
          ),
        ),
      { scopes: { "crm.contacts.write": "organization", "crm.leads.write": "team" } },
    );
  });
  it("a removed lead source during its SHARE wait cannot create a lead or choose a replacement source", async () => {
    const c = await newContact(),
      source = randomUUID();
    await admin.query(
      "INSERT INTO app.lead_source(tenant_id,id,label,code)VALUES($1,$2,'Owned capture source',$3)",
      [fixtures.orgA, source, "owned-" + source],
    );
    await unchanged(() =>
      held(
        (b) =>
          b.query("SELECT id FROM app.lead_source WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
            fixtures.orgA,
            source,
          ]),
        () => directPost("leads", { ...leadInput(c.id), sourceId: source }),
        (b) => b.query("DELETE FROM app.lead_source WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, source]),
        async (p) => {
          await expect(p).rejects.toMatchObject({ status: 422 });
        },
      ),
    );
  });
  it.each(["advisory", "contact", "stage"] as const)(
    "CRM expiry after a genuine %s wait denies before durable effects",
    async (kind) => {
      const c = await newContact(),
        key = randomUUID();
      await capability(async () => {
        await admin.query(
          "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '700 milliseconds'WHERE tenant_id=$1 AND feature='crm'",
          [fixtures.orgA],
        );
        await unchanged(() =>
          held(
            (b) =>
              kind === "advisory"
                ? b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                    fixtures.orgA + ":" + fixtures.agentUser + ":" + route("leads") + ":" + key,
                  ])
                : b.query(
                    "SELECT id FROM app." +
                      (kind === "contact" ? "contact" : "pipeline_stage") +
                      " WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
                    [fixtures.orgA, kind === "contact" ? c.id : stageId(1, 1)],
                  ),
            () => directPost("leads", leadInput(c.id), key),
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
  it("mutable caller input cannot replace a lead body after advisory wait", async () => {
    const c = await newContact(),
      body = leadInput(c.id),
      original = { ...body },
      key = randomUUID();
    let first: unknown;
    await held(
      (b) =>
        b.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          fixtures.orgA + ":" + fixtures.agentUser + ":" + route("leads") + ":" + key,
        ]),
      () => directPost("leads", body, key),
      async () => {
        body.intent = "seller";
        body.timeline = "mutated";
      },
      async (p) => {
        first = await p;
      },
    );
    expect(first).toMatchObject({ body: original });
    expect((await directPost("leads", original, key)).body).toEqual((first as { body: unknown }).body);
  });
});
