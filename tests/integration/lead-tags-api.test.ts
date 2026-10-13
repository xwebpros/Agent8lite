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

async function createTag(name?: string) {
  const created = await cmd("tags", { name: name ?? `Synthetic tag ${randomUUID()}` });
  expect(created.status).toBe(201);
  const tag = await created.json();
  assertContract("Tag", tag);
  tagIds.add(tag.id);
  return tag;
}

describe("lead tags (PUT /leads/{leadId}/tags)", () => {
  it("sets tags on a lead and retrieves them in lead detail", async () => {
    const lead = await createLead();
    const tag1 = await createTag();
    const tag2 = await createTag();

    const setKey = randomUUID();
    keys.add(setKey);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [tag1.id, tag2.id] },
      { method: "PUT", key: setKey, revision: `"${lead.version}"` },
    );
    expect(response.status).toBe(200);
    const updated = await response.json();
    assertContract("Lead", updated);
    expect(updated.version).toBeGreaterThan(lead.version);

    const tags = await admin.query(
      "SELECT tag_id FROM app.lead_tag WHERE lead_id=$1 ORDER BY tag_id",
      [lead.id],
    );
    const tagSet = new Set(tags.rows.map((r: { tag_id: string }) => r.tag_id));
    expect(tagSet.has(tag1.id)).toBe(true);
    expect(tagSet.has(tag2.id)).toBe(true);
  });

  it("clears tags by sending empty array", async () => {
    const lead = await createLead();
    const tag = await createTag();

    const setKey = randomUUID();
    keys.add(setKey);
    const set = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [tag.id] },
      { method: "PUT", key: setKey, revision: `"${lead.version}"` },
    );
    const withTag = await set.json();

    const clearKey = randomUUID();
    keys.add(clearKey);
    const cleared = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [] },
      { method: "PUT", key: clearKey, revision: `"${withTag.version}"` },
    );
    expect(cleared.status).toBe(200);
    const body = await cleared.json();
    assertContract("Lead", body);
    const tags = await admin.query("SELECT tag_id FROM app.lead_tag WHERE lead_id=$1", [lead.id]);
    expect(tags.rowCount).toBe(0);
  });

  it("rejects duplicate tag ids", async () => {
    const lead = await createLead();
    const tag = await createTag();
    const key = randomUUID();
    keys.add(key);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
        { tagIds: [tag.id, tag.id] },
        { method: "PUT", key, revision: `"${lead.version}"` },
      ),
      422,
    );
  });

  it("rejects unknown tag ids", async () => {
    const lead = await createLead();
    const key = randomUUID();
    keys.add(key);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
        { tagIds: [randomUUID()] },
        { method: "PUT", key, revision: `"${lead.version}"` },
      ),
      422,
    );
  });

  it("rejects stale lead revision", async () => {
    const lead = await createLead();
    const tag = await createTag();

    const setKey = randomUUID();
    keys.add(setKey);
    await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [tag.id] },
      { method: "PUT", key: setKey, revision: `"${lead.version}"` },
    );

    const staleKey = randomUUID();
    keys.add(staleKey);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
        { tagIds: [] },
        { method: "PUT", key: staleKey, revision: `"${lead.version}"` },
      ),
      412,
    );
  });
});
