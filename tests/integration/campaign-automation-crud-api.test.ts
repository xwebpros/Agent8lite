import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const keys = new Set<string>();
const campaignIds: string[] = [];
const automationIds: string[] = [];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  for (const id of automationIds)
    await admin.query("DELETE FROM app.automation WHERE id=$1", [id]).catch(() => {});
  for (const id of campaignIds)
    await admin.query("DELETE FROM app.campaign WHERE id=$1", [id]).catch(() => {});
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

function key() {
  const k = randomUUID();
  keys.add(k);
  return k;
}

describe("campaign CRUD", () => {
  let campaignId: string;

  it("creates a campaign draft", async () => {
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/campaigns`,
      { name: "CRUD Test Campaign", category: "newsletter" },
      { key: key() },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe("CRUD Test Campaign");
    expect(body.category).toBe("newsletter");
    campaignId = body.id;
    campaignIds.push(campaignId);
  });

  it("retrieves a campaign by ID", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/campaigns/${campaignId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(campaignId);
    expect(body.name).toBe("CRUD Test Campaign");
  });

  it("campaign appears in listing", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/campaigns`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const found = body.items.find((c: { id: string }) => c.id === campaignId);
    expect(found).toBeDefined();
  });

  it("creates a campaign version with workflow nodes", async () => {
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/campaigns/${campaignId}/versions`,
      {
        nodes: [
          { key: "wait_a", kind: "wait", delaySeconds: 86400 },
          { key: "wait_b", kind: "wait", delaySeconds: 172800 },
        ],
        edges: [{ from: "wait_a", to: "wait_b", branch: "always" }],
        timezone: "America/New_York",
      },
      { key: key() },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe("draft");
    expect(body.definition.nodes).toHaveLength(2);
  });
});

describe("automation CRUD", () => {
  let publishedVersionId: string;

  beforeAll(async () => {
    const cRes = await owner.command(
      `/v1/orgs/${owner.orgId}/campaigns`,
      { name: "Auto Test Campaign", category: "drip" },
      { key: key() },
    );
    const campaign = await cRes.json();
    campaignIds.push(campaign.id);

    const vRes = await owner.command(
      `/v1/orgs/${owner.orgId}/campaigns/${campaign.id}/versions`,
      { nodes: [{ key: "wait_x", kind: "wait", delaySeconds: 3600 }], edges: [], timezone: "UTC" },
      { key: key() },
    );
    const version = await vRes.json();

    await owner.command(
      `/v1/orgs/${owner.orgId}/campaign-versions/${version.id}/publish`,
      {},
      { key: key() },
    );
    publishedVersionId = version.id;
  });

  it("creates an automation rule", async () => {
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/automations`,
      {
        name: "CRUD Test Automation",
        trigger: "lead.captured",
        conditions: {},
        campaignVersionId: publishedVersionId,
        restartPolicy: "once",
        active: false,
      },
      { key: key() },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.definition.name).toBe("CRUD Test Automation");
    expect(body.definition.trigger).toBe("lead.captured");
    automationIds.push(body.id);
  });

  it("automation appears in listing", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/automations`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.some((a: { definition: { name: string } }) => a.definition.name === "CRUD Test Automation")).toBe(true);
  });

  it("retrieves an automation by ID", async () => {
    const id = automationIds[0];
    const response = await owner.request(`/v1/orgs/${owner.orgId}/automations/${id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(id);
    expect(body.definition.name).toBe("CRUD Test Automation");
  });

  it("updates an automation", async () => {
    const id = automationIds[0];
    const getRes = await owner.request(`/v1/orgs/${owner.orgId}/automations/${id}`);
    const current = await getRes.json();
    const etag = getRes.headers.get("etag") ?? `"${current.version}"`;
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/automations/${id}`,
      {
        name: "Updated Automation",
        trigger: "lead.captured",
        conditions: {},
        campaignVersionId: publishedVersionId,
        restartPolicy: "once",
        active: true,
      },
      { method: "PATCH", key: key(), revision: etag },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.definition.name).toBe("Updated Automation");
  });
});
