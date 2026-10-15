import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract } from "../helpers/api";
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

describe("GET /v1/session", () => {
  it("returns authenticated session with profile and organizations", async () => {
    const response = await owner.request("/v1/session");
    expect(response.status).toBe(200);
    const body = await response.json();
    assertContract("Session", body);
    expect(body.userId).toBeDefined();
    expect(body.profile.displayName).toBeDefined();
    expect(body.profile.timezone).toBeDefined();
    expect(Array.isArray(body.organizations)).toBe(true);
    expect(body.organizations.length).toBeGreaterThan(0);
    expect(body.activeOrgId).toBe(owner.orgId);
    expect(Array.isArray(body.permissions)).toBe(true);
    expect(body.permissions.length).toBeGreaterThan(0);
  });

  it("returns CSRF token and member ID in headers", async () => {
    const response = await owner.request("/v1/session");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-csrf-token")).toBeDefined();
    expect(response.headers.get("x-member-id")).toBeDefined();
    expect(response.headers.get("etag")).toBeDefined();
  });

  it("returns different member IDs for different identities", async () => {
    const ownerRes = await owner.request("/v1/session");
    const agentRes = await agent.request("/v1/session");
    const ownerBody = await ownerRes.json();
    const agentBody = await agentRes.json();
    expect(ownerBody.userId).not.toBe(agentBody.userId);
    expect(ownerRes.headers.get("x-member-id")).not.toBe(agentRes.headers.get("x-member-id"));
  });

  it("rejects unauthenticated request", async () => {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/v1/session`);
    expect(response.status).toBe(401);
  });
});
