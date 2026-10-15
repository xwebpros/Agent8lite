import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const taskIds = new Set<string>();
const leadIds = new Set<string>();
const tagIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (taskIds.size) {
    await admin.query(
      "DELETE FROM app.audit_event WHERE resource_id=ANY($1::text[]) AND resource_type='task'",
      [[...taskIds]],
    );
    const taskOutbox = await admin.query("SELECT id FROM app.outbox WHERE aggregate_id=ANY($1::text[])", [
      [...taskIds],
    ]);
    if (taskOutbox.rowCount) {
      const ids = taskOutbox.rows.map((r: { id: string }) => r.id);
      await admin.query("DELETE FROM app.outbox_consumer_receipt WHERE event_id=ANY($1::uuid[])", [ids]);
      await admin.query("DELETE FROM app.outbox WHERE id=ANY($1::uuid[])", [ids]);
    }
    await admin.query("DELETE FROM app.task WHERE id=ANY($1::uuid[])", [[...taskIds]]);
  }
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
  if (tagIds.size) await admin.query("DELETE FROM app.tag WHERE id=ANY($1::uuid[])", [[...tagIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  taskIds.clear();
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

async function createTask(leadId: string | null = null) {
  const key = randomUUID();
  keys.add(key);
  const body: Schemas["TaskWrite"] = {
    leadId,
    assigneeMemberId: owner.memberId,
    title: `Task filter test ${randomUUID().slice(0, 8)}`,
    dueAt: new Date(Date.now() + 86400000).toISOString(),
    timezone: "America/Los_Angeles",
    priority: "normal",
    state: "open",
  };
  const response = await owner.command(`/v1/orgs/${owner.orgId}/tasks`, body, { key });
  expect(response.status).toBe(201);
  const task = await response.json();
  taskIds.add(task.id);
  return task;
}

function tasksUrl(filter: Record<string, unknown>) {
  return `/v1/orgs/${owner.orgId}/tasks?filter=${encodeURIComponent(JSON.stringify(filter))}`;
}

describe("task list filters via linked lead", () => {
  it("filters tasks by linked lead intent", async () => {
    const lead = await createLead("buyer");
    await createTask(lead.id);

    const response = await owner.request(tasksUrl({ intent: "buyer" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters tasks by linked lead sourceId", async () => {
    const lead = await createLead();
    await createTask(lead.id);

    const response = await owner.request(tasksUrl({ sourceId: fixtures.sourceA }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters tasks by linked lead stageId", async () => {
    const lead = await createLead();
    await createTask(lead.id);

    const response = await owner.request(tasksUrl({ stageId: lead.stageId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters tasks by ownerMemberId (assignee)", async () => {
    const lead = await createLead();
    await createTask(lead.id);

    const response = await owner.request(tasksUrl({ ownerMemberId: owner.memberId }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("filters tasks by tag on linked lead", async () => {
    const lead = await createLead();
    const task = await createTask(lead.id);

    const tag = await cmd("tags", { name: `Task filter tag ${randomUUID()}` });
    const tagBody = await tag.json();
    tagIds.add(tagBody.id);

    const setKey = randomUUID();
    keys.add(setKey);
    await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/tags`,
      { tagIds: [tagBody.id] },
      { method: "PUT", key: setKey, revision: `"${lead.version}"` },
    );

    const response = await owner.request(tasksUrl({ tagIds: [tagBody.id] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("excludes tasks without a linked lead when filtering by lead fields", async () => {
    await createTask(null);

    const response = await owner.request(tasksUrl({ intent: "buyer" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    for (const item of body.items) {
      expect(item.leadId).not.toBeNull();
    }
  });

  it("rejects unsupported filter key for tasks", async () => {
    const response = await owner.request(tasksUrl({ unknownField: "test" }));
    expect(response.status).toBe(422);
  });
});
