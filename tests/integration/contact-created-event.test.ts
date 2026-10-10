import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendContactCreatedEvent } from "../../apps/api/src/contact-created-event";
import { CrmService } from "../../apps/api/src/crm-service";
import { ImportExportService } from "../../apps/api/src/import-export-service";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import schema from "../../packages/contracts/internal/native-contact-created-event-v1.schema.json";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import {
  withTenantTransaction,
  type PermissionGrant,
  type TenantContext,
} from "../../packages/db/tenant-transaction";
import { ApiSession, apiOrigin, assertContract, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL", "TEST_WORKER_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Contact event acceptance requires one owned file-fresh disposable database.");
}
const runtimeName = "contact_event_" + randomUUID();
const runtime = new Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  max: 1,
  application_name: runtimeName,
});
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
const ajv = new Ajv2020({ strict: true, ownProperties: true });
addFormats(ajv);
const validEvent = ajv.compile(schema);
let agent: ApiSession, owner: ApiSession;
const org = fixtures.orgA;
const route = "POST /v1/orgs/" + org + "/contacts";
const body = (): Schemas["ContactWrite"] => ({
  displayName: " PRIVATE_REFERENCE_NAME ",
  emails: [randomUUID() + "@example.test"],
  phones: ["+15557778888"],
  birthday: "2000-02-29",
});
const path = (resource: string) => "/v1/orgs/" + org + "/" + resource;
async function contact(input = body(), key = randomUUID(), session = agent) {
  const response = await session.command(path("contacts"), input, { key });
  expect(response.status, await response.clone().text()).toBe(201);
  expect(response.headers.get("etag")).toBe('"1"');
  expect(response.headers.get("cache-control")).toContain("no-store");
  const value = await response.json();
  assertContract("Contact", value);
  return value;
}
async function events(id: string) {
  return (
    await admin.query(
      "SELECT * FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='contact.created' ORDER BY id",
      [org, id],
    )
  ).rows;
}
async function totals() {
  return (
    await admin.query(
      "SELECT(SELECT count(*)::int FROM app.contact WHERE tenant_id=$1)contacts,(SELECT count(*)::int FROM app.contact_channel WHERE tenant_id=$1)channels,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1)audits,(SELECT count(*)::int FROM app.idempotency_record WHERE tenant_id=$1)receipts,(SELECT count(*)::int FROM app.outbox WHERE tenant_id=$1)outbox,(SELECT count(*)::int FROM app.activity_event WHERE tenant_id=$1)activity,(SELECT count(*)::int FROM app.consent_event WHERE tenant_id=$1)consent,(SELECT count(*)::int FROM app.integration_job WHERE tenant_id=$1)jobs",
      [org],
    )
  ).rows[0];
}
async function direct<T>(
  run: (client: PoolClient, context: TenantContext) => Promise<T>,
  identity = { userId: fixtures.agentUser as string, organizationId: org as string },
) {
  return withTenantTransaction(runtime, identity, run);
}
async function grants<T>(run: () => Promise<T>, remove: string[]) {
  const original = (
    await admin.query(
      "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id)WHERE m.tenant_id=$1 AND m.id=$2",
      [org, fixtures.agentMemberA],
    )
  ).rows[0];
  try {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      org,
      original.id,
      JSON.stringify(
        (original.permission_grants as PermissionGrant[]).filter((grant) => !remove.includes(grant.code)),
      ),
    ]);
    return await run();
  } finally {
    await admin.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
      org,
      original.id,
      JSON.stringify(original.permission_grants),
    ]);
  }
}
async function preview(csv: string) {
  const bytes = Buffer.from(csv);
  const response = await owner.command(path("uploads"), {
    filename: "synthetic-events.csv",
    mimeType: "text/csv",
    bytes: bytes.length,
    purpose: "contact_import",
  });
  expect(response.status).toBe(201);
  const upload = await response.json();
  assertContract("UploadGrant", upload);
  const uploaded = await fetch(apiOrigin + "/dev/storage/uploads/" + upload.assetId, {
    method: "PUT",
    headers: {
      cookie: owner.cookie,
      origin: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
      "x-csrf-token": owner.csrf,
      "content-type": "text/csv",
      "x-upload-grant": String(upload.requiredHeaders["X-Upload-Grant"]),
    },
    body: new Uint8Array(bytes),
  });
  expect(uploaded.status).toBe(204);
  const result = await owner.command(path("imports/contact-previews"), {
    assetId: upload.assetId,
    columnMap: { Name: "displayName", Email: "email" },
  });
  expect(result.status).toBe(201);
  const value = await result.json();
  assertContract("ImportPreview", value);
  return { previewId: value.id, duplicatePolicy: "skip" as const, confirmedRowCount: value.validRows };
}
beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  agent = await new ApiSession().signIn("agent");
  owner = await new ApiSession().signIn();
});
afterAll(async () => {
  for (const session of [agent, owner])
    if (session?.cookie) await session.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end(), worker.end()]);
});

describe("ADR-041 actual runtime atomic Contact reference production", () => {
  it("seed fixtures do not create or backfill Contact events", async () => {
    expect(
      (await admin.query("SELECT count(*)::int count FROM app.outbox WHERE event_type='contact.created'"))
        .rows[0].count,
    ).toBe(0);
  });
  it("fresh manual creation records one closed equal-reference DB-clock envelope without personal data", async () => {
    const before = await totals(),
      input = body();
    const started = (await admin.query("SELECT clock_timestamp() AS time")).rows[0].time;
    const created = await contact(input);
    const finished = (await admin.query("SELECT clock_timestamp() AS time")).rows[0].time;
    const rows = await events(created.id);
    expect(rows).toHaveLength(1);
    const row = rows[0],
      event = row.payload;
    expect(validEvent(event)).toBe(true);
    expect(event).toMatchObject({
      eventId: row.id,
      tenantId: org,
      aggregateId: created.id,
      producer: "crm",
      aggregateType: "contact",
      payload: { resourceId: created.id, resourceVersion: 1 },
    });
    expect(event.occurredAt).toBe(event.ingestedAt);
    expect(new Date(event.occurredAt).getTime()).toBeGreaterThanOrEqual(started.getTime() - 1);
    expect(new Date(event.occurredAt).getTime()).toBeLessThanOrEqual(finished.getTime());
    expect(row.initiating_actor_id).toBe(fixtures.agentUser);
    expect(row).toMatchObject({ published_at: null, lease_until: null, attempt_count: 0 });
    for (const privateValue of [input.displayName.trim(), input.emails![0], input.phones![0], input.birthday])
      expect(JSON.stringify(event)).not.toContain(privateValue);
    const after = await totals();
    expect(after).toEqual({
      ...before,
      contacts: before.contacts + 1,
      channels: before.channels + 2,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
      outbox: before.outbox + 1,
    });
  });
  it("concurrent same-key POST creates one Contact, audit, receipt and event", async () => {
    const input = body(),
      key = randomUUID(),
      before = await totals();
    const values = await Promise.all([contact(input, key), contact(input, key), contact(input, key)]);
    expect(values[1]).toEqual(values[0]);
    expect(values[2]).toEqual(values[0]);
    expect(await events(values[0].id)).toHaveLength(1);
    expect(await totals()).toEqual({
      ...before,
      contacts: before.contacts + 1,
      channels: before.channels + 2,
      audits: before.audits + 1,
      receipts: before.receipts + 1,
      outbox: before.outbox + 1,
    });
  });
  it("distinct fresh keys allocate distinct Contacts and one event each", async () => {
    const values = await Promise.all([contact(), contact()]);
    expect(values[0].id).not.toBe(values[1].id);
    for (const value of values) expect(await events(value.id)).toHaveLength(1);
  });
  it("historical POST replay after a later edit emits nothing and preserves its original receipt", async () => {
    const input = body(),
      key = randomUUID(),
      original = await contact(input, key);
    const edited = await agent.command(
      path("contacts/") + original.id,
      { displayName: "Later synthetic edit" },
      { method: "PATCH", revision: '"1"' },
    );
    expect(edited.status).toBe(200);
    const before = await totals();
    expect(await contact(input, key)).toEqual(original);
    expect(await totals()).toEqual(before);
    expect(await events(original.id)).toHaveLength(1);
  });
  it("changed and expired receipt requests reject without new Contact/event effects", async () => {
    const input = body(),
      key = randomUUID();
    await contact(input, key);
    const before = await totals();
    await assertProblem(
      await agent.command(path("contacts"), { ...input, displayName: "changed" }, { key }),
      409,
    );
    await admin.query(
      "UPDATE app.idempotency_record SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND actor_ref=$2 AND route_key=$3 AND key=$4",
      [org, fixtures.agentUser, route, key],
    );
    const result = await assertProblem(await agent.command(path("contacts"), input, { key }), 409);
    expect(result.code).toBe("receipt_expired");
    expect(await totals()).toEqual(before);
  });
  it("bad input and CSRF reject before any creation event", async () => {
    const before = await totals();
    await assertProblem(
      await agent.command(path("contacts"), { displayName: "bad", emails: ["not-email"] }),
      422,
    );
    await assertProblem(await agent.command(path("contacts"), body(), { csrf: "invalid" }), 403);
    expect(await totals()).toEqual(before);
  });
  it("original write-only permission gates remain sufficient for producing the event", async () => {
    await grants(async () => {
      const value = await contact();
      expect(await events(value.id)).toHaveLength(1);
    }, ["crm.contacts.read", "crm.leads.read", "crm.sources.read"]);
  });
  it("current revoked write permission blocks replay and emits no event", async () => {
    const input = body(),
      key = randomUUID();
    await contact(input, key);
    const before = await totals();
    await grants(async () => {
      await assertProblem(await agent.command(path("contacts"), input, { key }), 403);
    }, ["crm.contacts.write"]);
    expect(await totals()).toEqual(before);
  });
  it("current disabled capability blocks fresh and replay commands with no effects", async () => {
    const input = body(),
      key = randomUUID();
    await contact(input, key);
    const before = await totals();
    const saved = (
      await admin.query("SELECT state FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'", [org])
    ).rows[0].state;
    try {
      await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='crm'", [
        org,
      ]);
      await assertProblem(await agent.command(path("contacts"), input, { key }), 403);
      await assertProblem(await agent.command(path("contacts"), body()), 403);
    } finally {
      await admin.query("UPDATE app.entitlement SET state=$2 WHERE tenant_id=$1 AND feature='crm'", [
        org,
        saved,
      ]);
    }
    expect(await totals()).toEqual(before);
  });
  it("caller rollback removes manual Contact/channels/audit/receipt/event together", async () => {
    const before = await totals();
    await expect(
      direct(async (client, context) => {
        await new CrmService(client, context, randomUUID()).postContact(body(), randomUUID(), route);
        throw new Error("Owned caller rollback");
      }),
    ).rejects.toThrow("Owned caller rollback");
    expect(await totals()).toEqual(before);
  });
  it("failed event insertion rolls back the internal creation port and all enclosing work", async () => {
    const before = await totals();
    await expect(
      direct(async (client, context) => {
        const guarded = new Proxy(client, {
          get(target, key) {
            if (key === "query")
              return async (sql: string, values: unknown[]) => {
                if (sql.startsWith("INSERT INTO app.outbox"))
                  throw new Error("Owned event insertion failure");
                return target.query(sql, values);
              };
            return Reflect.get(target, key);
          },
        });
        await new CrmService(guarded, context, randomUUID()).create("contacts", body());
      }),
    ).rejects.toThrow("Owned event insertion failure");
    expect(await totals()).toEqual(before);
  });
  it("missing context, forged member and foreign Contact sources cannot append events or leak pool context", async () => {
    const created = await contact(),
      before = await totals();
    let captured!: TenantContext;
    await direct(async (_client, context) => {
      captured = context;
    });
    const client = await runtime.connect();
    try {
      expect((await client.query("SELECT count(*)::int count FROM app.contact")).rows[0].count).toBe(0);
      await expect(
        appendContactCreatedEvent(client, captured, randomUUID(), created.id),
      ).rejects.toMatchObject({ code: "contact_event_context_unavailable" });
    } finally {
      client.release();
    }
    await expect(
      direct((current, context) =>
        appendContactCreatedEvent(
          current,
          { ...context, memberId: fixtures.ownerMemberA },
          randomUUID(),
          created.id,
        ),
      ),
    ).rejects.toMatchObject({ code: "contact_event_context_unavailable" });
    await expect(
      direct((current, context) =>
        appendContactCreatedEvent(current, context, randomUUID(), fixtures.contactB),
      ),
    ).rejects.toMatchObject({ code: "contact_event_context_unavailable" });
    expect(await totals()).toEqual(before);
  });
  it("accepted CSV rows each emit once; duplicate skips, invalid rows and exact commit replay emit nothing", async () => {
    const existing = await contact(body(), randomUUID(), owner),
      a = randomUUID() + "@example.test",
      b = randomUUID() + "@example.test";
    const input = await preview(
      `Name,Email\nDuplicate,${existing.emails[0]}\nImport A,${a}\nImport B,${b}\nRepeated,${a}\nInvalid,bad-email\n`,
    );
    const before = await totals(),
      key = randomUUID();
    const responses = await Promise.all([
      owner.command(path("imports/contact-commits"), input, { key }),
      owner.command(path("imports/contact-commits"), input, { key }),
    ]);
    for (const response of responses) expect(response.status, await response.clone().text()).toBe(202);
    const first = await responses[0].json();
    expect(await responses[1].json()).toEqual(first);
    const imported = (
      await admin.query(
        "SELECT c.id FROM app.contact c JOIN app.contact_channel ch ON(ch.tenant_id,ch.contact_id)=(c.tenant_id,c.id) WHERE c.tenant_id=$1 AND ch.normalized_value=ANY($2::text[])",
        [org, [a, b]],
      )
    ).rows;
    expect(imported).toHaveLength(2);
    for (const row of imported) expect(await events(row.id)).toHaveLength(1);
    expect((await totals()).outbox - before.outbox).toBe(2);
    const after = await totals();
    expect((await owner.command(path("imports/contact-commits"), input, { key })).status).toBe(202);
    expect(await totals()).toEqual(after);
  });
  it("caller rollback of accepted CSV commit removes both Contact events and preserves the preview", async () => {
    const input = await preview(
        `Name,Email\nRollback A,${randomUUID()}@example.test\nRollback B,${randomUUID()}@example.test\n`,
      ),
      before = await totals();
    await expect(
      direct(
        async (client, context) => {
          await new ImportExportService(client, context, randomUUID()).commit(input);
          throw new Error("Owned import rollback");
        },
        { userId: fixtures.ownerUser, organizationId: org },
      ),
    ).rejects.toThrow("Owned import rollback");
    expect(await totals()).toEqual(before);
    expect(
      (
        await admin.query("SELECT state FROM app.import_job WHERE tenant_id=$1 AND id=$2", [
          org,
          input.previewId,
        ])
      ).rows[0].state,
    ).toBe("previewed");
  });
  it("older unsupported Contact events never consume a one-event Lead reference batch", async () => {
    const created = await contact();
    const sourceEvent = (await events(created.id))[0];
    await admin.query(
      "UPDATE app.outbox SET created_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1 AND id=$2",
      [org, sourceEvent.id],
    );
    const before = (await events(created.id))[0];
    const response = await agent.command(path("leads"), {
      contactId: created.id,
      sourceId: fixtures.sourceA,
      ownerMemberId: fixtures.agentMemberA,
      intent: "buyer",
    });
    expect(response.status).toBe(201);
    const lead = await response.json();
    assertContract("Lead", lead);
    expect(await dispatchOutbox(worker, { userId: fixtures.agentUser, organizationId: org }, 1)).toEqual({
      dispatched: 1,
      deferred: 0,
    });
    expect(await dispatchOutbox(worker, { userId: fixtures.agentUser, organizationId: org }, 1)).toEqual({
      dispatched: 0,
      deferred: 0,
    });
    expect((await events(created.id))[0]).toEqual(before);
    expect(
      (
        await admin.query(
          "SELECT(SELECT count(*)::int FROM app.outbox_consumer_receipt WHERE tenant_id=$1 AND event_id=$2)receipts,(SELECT count(*)::int FROM app.audit_event WHERE tenant_id=$1 AND resource_type='outbox' AND resource_id=$2::text)audits",
          [org, sourceEvent.id],
        )
      ).rows[0],
    ).toEqual({ receipts: 0, audits: 0 });
    const published = (
      await admin.query(
        "SELECT o.published_at,o.attempt_count,(SELECT count(*)::int FROM app.outbox_consumer_receipt r WHERE r.tenant_id=o.tenant_id AND r.event_id=o.id)receipts,(SELECT count(*)::int FROM app.audit_event a WHERE a.tenant_id=o.tenant_id AND a.resource_type='outbox' AND a.resource_id=o.id::text)audits FROM app.outbox o WHERE o.tenant_id=$1 AND o.aggregate_id=$2 AND o.event_type='lead.captured'",
        [org, lead.id],
      )
    ).rows[0];
    expect(published).toMatchObject({ attempt_count: 1, receipts: 1, audits: 1 });
    expect(published.published_at).not.toBeNull();
  });
});
