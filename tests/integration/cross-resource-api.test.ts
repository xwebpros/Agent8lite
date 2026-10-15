import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  await admin.end();
});

describe("cross-resource listing consistency", () => {
  it("contacts listing returns consistent pagination structure", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/contacts?limit=2`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeLessThanOrEqual(2);
  });

  it("leads listing returns consistent pagination structure", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/leads?limit=2`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("tasks listing returns consistent pagination structure", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/tasks?limit=2`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
  });

  it("deals listing returns consistent pagination structure", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/deals?limit=2`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
  });

  it("tickets listing returns consistent pagination structure", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/tickets`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
  });

  it("roles listing returns items", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/roles`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("members listing returns items", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/members`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("offices listing returns items", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/offices`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
  });

  it("agent sees same organization data as owner", async () => {
    const ownerContacts = await (await owner.request(`/v1/orgs/${owner.orgId}/contacts`)).json();
    const agentContacts = await (await agent.request(`/v1/orgs/${agent.orgId}/contacts`)).json();
    expect(ownerContacts.items.length).toBe(agentContacts.items.length);
  });
});
