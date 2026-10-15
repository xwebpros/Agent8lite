import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

describe("cross-identity permission boundaries", () => {
  it("agent cannot access admin-only org update", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await agent.command(
      `/v1/orgs/${agent.orgId}`,
      { name: "Agent Hijack", timezone: "UTC" },
      { method: "PATCH", key },
    );
    expect([403, 422]).toContain(response.status);
  });

  it("agent can read own session", async () => {
    const response = await agent.request("/v1/session");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.userId).toBeDefined();
  });

  it("agent can list leads within own organization", async () => {
    const response = await agent.request(`/v1/orgs/${agent.orgId}/leads`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("no session rejects all authenticated endpoints", async () => {
    const noAuth = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/v1/orgs/${owner.orgId}/leads`);
    expect(noAuth.status).toBe(401);
  });

  it("CSRF token is required for mutations", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.request(`/v1/orgs/${owner.orgId}/contacts`, {
      method: "POST",
      headers: {
        "idempotency-key": key,
      },
      body: JSON.stringify({ emails: ["test@synthetic.example"], phones: [], displayName: "CSRF Test" }),
    });
    expect(response.status).toBe(403);
  });
});
