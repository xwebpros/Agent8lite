import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
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

describe("routing rules API", () => {
  it("lists routing configuration for owner", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/routing`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("agent role is denied routing configuration", async () => {
    const response = await agent.request(`/v1/orgs/${agent.orgId}/routing`);
    expect(response.status).toBe(403);
  });

  it("unauthenticated request is rejected", async () => {
    const response = await fetch(`http://127.0.0.1:3001/v1/orgs/${owner.orgId}/routing`);
    expect([401, 403]).toContain(response.status);
  });

  it("routing response includes etag or cursor for concurrency control", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/routing`);
    expect(response.status).toBe(200);
    const etag = response.headers.get("etag");
    const body = await response.json();
    const hasRevision = etag || body.revision || body.cursor;
    expect(hasRevision).toBeTruthy();
  });
});
