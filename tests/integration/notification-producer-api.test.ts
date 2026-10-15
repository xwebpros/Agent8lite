import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
let sourceId: string;
let stages: Schemas["PipelineStage"][];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
  const sources = await owner.read(`/v1/orgs/${owner.orgId}/lead-sources`, "PageLeadSource");
  sourceId = sources.body.items[0].id;
  const stageList = await owner.read(`/v1/orgs/${owner.orgId}/pipeline-stages`, "PagePipelineStage");
  stages = stageList.body.items;
});
afterAll(async () => {
  await admin.end();
});

async function createContact(session: ApiSession) {
  const response = await session.command(`/v1/orgs/${session.orgId}/contacts`, {
    displayName: `Synthetic notification test ${randomUUID()}`,
    emails: [`${randomUUID()}@example.invalid`],
  } satisfies Schemas["ContactWrite"]);
  expect(response.status).toBe(201);
  return response.json();
}

async function createLead(session: ApiSession, contactId: string, ownerMemberId: string | null) {
  const response = await session.command(`/v1/orgs/${session.orgId}/leads`, {
    contactId,
    sourceId,
    ownerMemberId,
    intent: "buyer",
  } satisfies Schemas["LeadCreate"]);
  expect(response.status).toBe(201);
  return response.json();
}

async function listNotifications(session: ApiSession): Promise<Schemas["Notification"][]> {
  const response = await session.request(`/v1/orgs/${session.orgId}/notifications?limit=100`);
  expect(response.status).toBe(200);
  const body = await response.json();
  assertContract("PageNotification", body);
  return body.items;
}

async function waitForNotification(
  _session: ApiSession,
  memberId: string,
  kind: string,
  retries = 8,
): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < retries; i++) {
    const result = await admin.query(
      `SELECT id, kind, safe_payload->>'title' AS title FROM app.notification
       WHERE tenant_id=$1 AND member_id=$2 AND kind=$3
       ORDER BY created_at DESC LIMIT 1`,
      [fixtures.orgA, memberId, kind],
    );
    if (result.rows.length) return result.rows[0];
    if (i < retries - 1) await new Promise((r) => setTimeout(r, 300));
  }
  return undefined;
}

describe("notification producer", () => {
  it("creates a notification when a lead is assigned to another member", async () => {
    const contact = await createContact(owner);
    const lead = await createLead(owner, contact.id, owner.memberId);

    const patch = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}`,
      { ownerMemberId: agent.memberId } satisfies Schemas["LeadPatch"],
      { method: "PATCH", revision: `"${lead.version}"` },
    );
    expect(patch.status).toBe(200);

    const notification = await waitForNotification(agent, agent.memberId, "lead.assigned");
    expect(notification).toBeDefined();
    expect(notification!.title).toContain("assigned");
  });

  it("does not create a notification when assigning a lead to yourself", async () => {
    const contact = await createContact(owner);
    const lead = await createLead(owner, contact.id, null);

    const before = await listNotifications(owner);
    const beforeIds = new Set(before.map((n: Schemas["Notification"]) => n.id));

    const patch = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}`,
      { ownerMemberId: owner.memberId } satisfies Schemas["LeadPatch"],
      { method: "PATCH", revision: `"${lead.version}"` },
    );
    expect(patch.status).toBe(200);

    const after = await listNotifications(owner);
    const newNotifications = after.filter(
      (n: Schemas["Notification"]) => !beforeIds.has(n.id) && n.kind === "lead.assigned",
    );
    expect(newNotifications.length).toBe(0);
  });

  it("creates a notification when a task is assigned to another member", async () => {
    const contact = await createContact(owner);
    const lead = await createLead(owner, contact.id, owner.memberId);

    const task = await owner.command(`/v1/orgs/${owner.orgId}/tasks`, {
      leadId: lead.id,
      assigneeMemberId: agent.memberId,
      title: "Synthetic notification task",
      dueAt: new Date(Date.now() + 86400000).toISOString(),
      timezone: "America/Los_Angeles",
      priority: "normal",
      state: "open",
    } satisfies Schemas["TaskWrite"]);
    expect(task.status).toBe(201);

    const notification = await waitForNotification(agent, agent.memberId, "task.assigned");
    expect(notification).toBeDefined();
    expect(notification!.title).toContain("Synthetic notification task");
  });

  it("creates a notification when a lead's stage is changed by another member", async () => {
    const contact = await createContact(owner);
    const lead = await createLead(owner, contact.id, agent.memberId);

    expect(stages.length).toBeGreaterThanOrEqual(2);
    const targetStage = stages.find((s) => s.id !== lead.stageId) ?? stages[1];

    const transition = await owner.command(
      `/v1/orgs/${owner.orgId}/leads/${lead.id}/stage-transitions`,
      { toStageId: targetStage.id } satisfies Schemas["StageTransition"],
      { revision: `"${lead.version}"` },
    );
    expect(transition.status).toBe(201);

    const notification = await waitForNotification(agent, agent.memberId, "lead.stage_changed");
    expect(notification).toBeDefined();
    expect(notification!.title).toContain("stage");
  });
});
