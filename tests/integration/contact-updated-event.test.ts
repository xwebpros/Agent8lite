import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchOutbox } from "../../apps/worker/src/outbox";
import schema from "../../packages/contracts/internal/native-contact-updated-event-v1.schema.json";
import { fixtures } from "../../packages/db/fixtures";
import { assertRuntimeRole } from "../../packages/db/runtime-role";
import { ApiSession, assertProblem, type Schemas } from "../helpers/api";

for (const name of ["TEST_DATABASE_URL", "TEST_MIGRATION_DATABASE_URL"]) {
  const url = new URL(process.env[name] ?? "http://missing.invalid");
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname)
  )
    throw new Error("Contact event acceptance requires its owned file-fresh disposable database.");
}
const runtime = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL, max: 4 });
const worker = new Pool({ connectionString: process.env.TEST_WORKER_DATABASE_URL, max: 2 });
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validEvent = ajv.compile(schema);
let agent: ApiSession;

async function contact() {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO app.contact(tenant_id,id,display_name,birthday,created_by_member_id)VALUES($1,$2,'Synthetic private name','2000-02-29',$3)",
    [fixtures.orgA, id, fixtures.agentMemberA],
  );
  return id;
}
const body = (displayName = "Synthetic renamed person"): Schemas["ContactWrite"] => ({
  displayName,
  emails: ["private-person@example.test"],
});
const patch = (id: string, input = body(), key = randomUUID(), revision = '"1"') =>
  agent.command(`/v1/orgs/${agent.orgId}/contacts/${id}`, input, { method: "PATCH", key, revision });
async function events(id: string) {
  return (
    await admin.query(
      "SELECT id,payload,published_at,attempt_count,lease_until,initiating_actor_id FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='contact.updated' ORDER BY (payload->'payload'->>'resourceVersion')::int",
      [fixtures.orgA, id],
    )
  ).rows;
}

beforeAll(async () => {
  await assertRuntimeRole(runtime);
  await assertRuntimeRole(worker);
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  if (agent?.cookie) await agent.command("/dev/logout", undefined).catch(() => undefined);
  await Promise.all([runtime.end(), admin.end(), worker.end()]);
});

describe("ADR-048 native contact.updated reference event", () => {
  it("appends one closed, references-only, database-time event per fresh revision", async () => {
    const id = await contact();
    const started = (await admin.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const response = await patch(id);
    expect(response.status).toBe(200);
    const saved = await response.json();
    const [event] = await events(id);
    expect(validEvent(event.payload), JSON.stringify(validEvent.errors)).toBe(true);
    expect(event.payload).toMatchObject({
      type: "contact.updated",
      version: 1,
      producer: "crm",
      aggregateType: "contact",
      aggregateId: id,
      tenantId: fixtures.orgA,
      payload: { resourceId: id, resourceVersion: saved.version },
    });
    expect(event.payload.occurredAt).toBe(event.payload.ingestedAt);
    expect(new Date(event.payload.occurredAt).getTime()).toBeGreaterThanOrEqual(
      Math.floor(started.getTime()),
    );
    expect(event.initiating_actor_id).toBe(fixtures.agentUser);
    const serialized = JSON.stringify(event.payload);
    for (const secret of ["Synthetic", "private-person", "2000-02-29", "renamed"])
      expect(serialized).not.toContain(secret);
    expect(event).toMatchObject({ published_at: null, attempt_count: 0, lease_until: null });
    const second = await patch(id, body("Third revision"), randomUUID(), '"2"');
    expect(second.status).toBe(200);
    expect((await events(id)).map((row) => row.payload.payload.resourceVersion)).toEqual([2, 3]);
  });

  it("concurrent identical keys commit one event; replay, stale and invalid commands emit none", async () => {
    const id = await contact(),
      key = randomUUID();
    const responses = await Promise.all([patch(id, body(), key), patch(id, body(), key)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await events(id)).toHaveLength(1);
    expect((await patch(id, body(), key)).status).toBe(200);
    await assertProblem(await patch(id, body("stale"), randomUUID(), '"1"'), 412);
    await assertProblem(await patch(id, { displayName: "   " }, randomUUID(), '"2"'), 422);
    await assertProblem(await patch(id, body("changed"), key), 409);
    expect(await events(id)).toHaveLength(1);
  });

  it("distinct fresh keys racing on one revision commit one event", async () => {
    const id = await contact();
    const responses = await Promise.all([patch(id, body("A")), patch(id, body("B"))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(await events(id)).toHaveLength(1);
  });

  it("a revoked capability rolls back the Contact and emits nothing", async () => {
    const id = await contact();
    try {
      await admin.query("UPDATE app.entitlement SET state='disabled' WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ]);
      await assertProblem(await patch(id), 403);
    } finally {
      await admin.query("UPDATE app.entitlement SET state='enabled' WHERE tenant_id=$1 AND feature='crm'", [
        fixtures.orgA,
      ]);
    }
    expect(await events(id)).toHaveLength(0);
    expect(
      (
        await admin.query("SELECT row_version::int v FROM app.contact WHERE tenant_id=$1 AND id=$2", [
          fixtures.orgA,
          id,
        ])
      ).rows[0].v,
    ).toBe(1);
  });

  it("the reference consumer leaves contact.updated unleased while an approved Lead event dispatches", async () => {
    const id = await contact();
    expect((await patch(id)).status).toBe(200);
    await admin.query(
      "UPDATE app.outbox SET created_at=clock_timestamp()-interval '1 day' WHERE tenant_id=$1 AND aggregate_id=$2",
      [fixtures.orgA, id],
    );
    const [before] = await events(id);
    const created = await agent.command(`/v1/orgs/${agent.orgId}/leads`, {
      contactId: await contact(),
      sourceId: fixtures.sourceA,
      ownerMemberId: fixtures.agentMemberA,
      intent: "buyer",
    });
    expect(created.status).toBe(201);
    const lead = await created.json();
    for (let batch = 0; batch < 20; batch++)
      if (
        (await dispatchOutbox(worker, { userId: fixtures.agentUser, organizationId: fixtures.orgA }, 1))
          .dispatched === 0
      )
        break;
    expect((await events(id))[0]).toEqual(before);
    const published = (
      await admin.query(
        "SELECT published_at FROM app.outbox WHERE tenant_id=$1 AND aggregate_id=$2 AND event_type='lead.captured'",
        [fixtures.orgA, lead.id],
      )
    ).rows[0];
    expect(published.published_at).not.toBeNull();
  });
});
