import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  await admin.end();
});

describe("automations listing", () => {
  it("returns paginated automation list", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/automations`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("supports limit parameter", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/automations?limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBeLessThanOrEqual(5);
  });
});

describe("campaigns listing", () => {
  it("returns paginated campaign list", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/campaigns`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("supports limit parameter", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/campaigns?limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBeLessThanOrEqual(5);
  });
});

describe("notifications listing", () => {
  it("returns paginated notification list", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/notifications`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("rejects unknown query parameters", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/notifications?bogus=yes`);
    expect(response.status).toBe(422);
  });
});

describe("audit events listing", () => {
  it("returns paginated audit event list", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/audit-events`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("supports limit parameter", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/audit-events?limit=3`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBeLessThanOrEqual(3);
  });

  it("audit events have required fields", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/audit-events?limit=1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    if (body.items.length > 0) {
      const event = body.items[0];
      expect(event).toHaveProperty("id");
      expect(event).toHaveProperty("action");
      expect(event).toHaveProperty("resourceType");
      expect(event).toHaveProperty("createdAt");
    }
  });
});
