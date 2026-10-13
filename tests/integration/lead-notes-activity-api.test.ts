import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const leadIds = new Set<string>();
const noteIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (leadIds.size) {
    await admin.query("DELETE FROM app.activity_event WHERE lead_id=ANY($1::uuid[])", [[...leadIds]]);
    await admin.query("DELETE FROM app.note WHERE lead_id=ANY($1::uuid[])", [[...leadIds]]);
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[]) AND resource_type IN('lead','note')",
      [[...leadIds, ...noteIds]],
    );
    const events = await admin.query("SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])", [
      [...leadIds],
    ]);
    if (events.rowCount) {
      const ids = events.rows.map((r: { id: string }) => r.id);
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [ids]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [ids]);
    }
    await admin.query("DELETE FROM app.lead WHERE id=ANY($1::uuid[])", [[...leadIds]]);
  }
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  leadIds.clear();
  noteIds.clear();
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

async function createLead() {
  const key = randomUUID();
  keys.add(key);
  const input: Schemas["LeadCreate"] = {
    contactId: fixtures.contactA,
    sourceId: fixtures.sourceA,
    intent: "buyer",
  };
  const response = await owner.command(`/v1/orgs/${owner.orgId}/leads`, input, { key });
  expect(response.status).toBe(201);
  const lead = await response.json();
  assertContract("Lead", lead);
  leadIds.add(lead.id);
  return lead;
}

describe("lead notes", () => {
  it("adds a note and lists notes for a lead", async () => {
    const lead = await createLead();
    const revision = `"${lead.version}"`;
    const noteKey = randomUUID();
    keys.add(noteKey);
    const addResponse = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/notes`,
      { body: "Synthetic integration test note" },
      { key: noteKey, revision },
    );
    expect(addResponse.status).toBe(201);
    const note = await addResponse.json();
    assertContract("Note", note);
    noteIds.add(note.id);
    expect(note.body).toBe("Synthetic integration test note");
    expect(note.authorMemberId).toBe(owner.memberId);

    const list = await owner.read(`/v1/orgs/${owner.orgId}/leads/${lead.id}/notes`, "PageNote");
    expect(list.body.items.length).toBeGreaterThan(0);
    const found = list.body.items.find((n: { id: string }) => n.id === note.id);
    expect(found).toBeDefined();
    expect(found!.body).toBe("Synthetic integration test note");
  });

  it("rejects empty note body", async () => {
    const lead = await createLead();
    const key = randomUUID();
    keys.add(key);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/leads/${lead.id}/notes`,
        { body: "   " },
        { key, revision: `"${lead.version}"` },
      ),
      422,
    );
  });

  it("rejects notes for unknown lead", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/leads/${randomUUID()}/notes`), 404);
  });
});

describe("lead activity", () => {
  it("returns activity list for a lead", async () => {
    const lead = await createLead();
    const list = await owner.read(`/v1/orgs/${owner.orgId}/leads/${lead.id}/activity`, "PageActivity");
    expect(list.body.items).toBeDefined();
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(typeof list.body.hasMore).toBe("boolean");
  });

  it("rejects activity for unknown lead", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/leads/${randomUUID()}/activity`), 404);
  });
});
