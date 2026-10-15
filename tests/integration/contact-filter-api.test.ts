import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const leadIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (leadIds.size) {
    await admin.query("DELETE FROM app.lead_tag WHERE lead_id=ANY($1::uuid[])", [[...leadIds]]);
    await admin.query("DELETE FROM app.activity_event WHERE lead_id=ANY($1::uuid[])", [[...leadIds]]);
    await admin.query("DELETE FROM app.note WHERE lead_id=ANY($1::uuid[])", [[...leadIds]]);
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[]) AND resource_type='lead'",
      [[...leadIds]],
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
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

async function createLead(intent: "buyer" | "seller" = "buyer") {
  const key = randomUUID();
  keys.add(key);
  const input: Schemas["LeadCreate"] = {
    contactId: fixtures.contactA,
    sourceId: fixtures.sourceA,
    intent,
  };
  const response = await owner.command(`/v1/orgs/${owner.orgId}/leads`, input, { key });
  expect(response.status).toBe(201);
  const lead = await response.json();
  assertContract("Lead", lead);
  leadIds.add(lead.id);
  return lead;
}

function contactsUrl(filter: Record<string, unknown>) {
  return `/v1/orgs/${owner.orgId}/contacts?filter=${encodeURIComponent(JSON.stringify(filter))}&limit=100`;
}

describe("contact list filters", () => {
  it("filters contacts by intent via lead relationship", async () => {
    await createLead("buyer");

    const response = await owner.request(contactsUrl({ intent: "buyer" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters contacts by sourceId via lead relationship", async () => {
    await createLead();

    const response = await owner.request(contactsUrl({ sourceId: fixtures.sourceA }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters contacts by stageId via lead relationship", async () => {
    const lead = await createLead();

    const response = await owner.request(contactsUrl({ stageId: lead.stageId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("returns valid structure for non-matching intent", async () => {
    const response = await owner.request(contactsUrl({ intent: "seller" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
  });

  it("combines intent and sourceId filters", async () => {
    await createLead("buyer");

    const response = await owner.request(contactsUrl({ intent: "buyer", sourceId: fixtures.sourceA }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("rejects unsupported filter key", async () => {
    const filter = encodeURIComponent(JSON.stringify({ unknownField: "test" }));
    const response = await owner.request(`/v1/orgs/${owner.orgId}/contacts?filter=${filter}`);
    expect(response.status).toBe(422);
  });
});
