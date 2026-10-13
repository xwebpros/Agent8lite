import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const leadIds = new Set<string>();
const tagIds = new Set<string>();
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
    const events = await admin.query(
      "SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])",
      [[...leadIds]],
    );
    if (events.rowCount) {
      const ids = events.rows.map((r: { id: string }) => r.id);
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [ids]);
    }
    const events2 = await admin.query(
      "SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])",
      [[...leadIds]],
    );
    if (events2.rowCount) {
      const ids = events2.rows.map((r: { id: string }) => r.id);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [ids]);
    }
    await admin.query("DELETE FROM app.lead WHERE id=ANY($1::uuid[])", [[...leadIds]]);
  }
  if (tagIds.size)
    await admin.query("DELETE FROM app.tag WHERE id=ANY($1::uuid[])", [[...tagIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  leadIds.clear();
  tagIds.clear();
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

function cmd(resource: string, body: unknown, opts: { method?: string; revision?: string } = {}) {
  const key = randomUUID();
  keys.add(key);
  return owner.command(`/v1/orgs/${owner.orgId}/${resource}`, body, { key, ...opts });
}

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

function leadsUrl(filter: Record<string, unknown>) {
  return `/v1/orgs/${owner.orgId}/leads?filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

describe("lead list filters", () => {
  it("filters leads by intent", async () => {
    await createLead("buyer");

    const response = await owner.request(leadsUrl({ intent: "buyer" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.hasMore).toBe("boolean");
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.intent).toBe("buyer");
  });

  it("filters leads by sourceId", async () => {
    await createLead();

    const response = await owner.request(leadsUrl({ sourceId: fixtures.sourceA }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.sourceId).toBe(fixtures.sourceA);
  });

  it("filters leads by stageId", async () => {
    const lead = await createLead();

    const response = await owner.request(leadsUrl({ stageId: lead.stageId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) expect(item.stageId).toBe(lead.stageId);
  });

  it("filters leads by ownerMemberId", async () => {
    await createLead();

    const response = await owner.request(leadsUrl({ ownerMemberId: owner.memberId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters leads by text search", async () => {
    await createLead();

    const response = await owner.request(leadsUrl({ q: "Synthetic" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("filters leads by tag", async () => {
    const lead = await createLead();
    const tag = await cmd("tags", { name: `Lead filter tag ${randomUUID()}` });
    const tagBody = await tag.json();
    tagIds.add(tagBody.id);

    const setKey = randomUUID();
    keys.add(setKey);
    await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [tagBody.id] },
      { method: "PUT", key: setKey, revision: `"${lead.version}"` },
    );

    const response = await owner.request(leadsUrl({ tagIds: [tagBody.id] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("combines multiple filters", async () => {
    const lead = await createLead("buyer");

    const response = await owner.request(
      leadsUrl({ intent: "buyer", sourceId: fixtures.sourceA, stageId: lead.stageId }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("rejects unsupported filter key for leads", async () => {
    const response = await owner.request(leadsUrl({ unknownField: "test" }));
    expect(response.status).toBe(422);
  });
});
