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

describe("GET /v1/orgs/{orgId}/appointments", () => {
  it("returns paginated appointment list", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/appointments`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("supports cursor pagination", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/appointments?limit=5`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeLessThanOrEqual(5);
  });
});
