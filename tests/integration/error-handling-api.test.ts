import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  await admin.end();
});

describe("error handling boundaries", () => {
  it("returns 404 for unknown API route", async () => {
    await assertProblem(
      await owner.request("/v1/orgs/" + owner.orgId + "/nonexistent-resource"),
      404,
    );
  });

  it("returns 404 for unknown resource ID", async () => {
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/contacts/${randomUUID()}`),
      404,
    );
  });

  it("returns problem+json content type on errors", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/contacts/${randomUUID()}`);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("returns no-store cache header on error responses", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/contacts/${randomUUID()}`);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("rejects oversized request body", async () => {
    const hugeBody = "x".repeat(2 * 1024 * 1024);
    const response = await owner.request("/v1/orgs/" + owner.orgId + "/contacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": owner.csrf,
        "idempotency-key": randomUUID(),
      },
      body: hugeBody,
    });
    expect([413, 422]).toContain(response.status);
  });

  it("rejects request with invalid JSON body", async () => {
    const response = await owner.request("/v1/orgs/" + owner.orgId + "/contacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": owner.csrf,
        "idempotency-key": randomUUID(),
      },
      body: "{invalid json",
    });
    expect([400, 422]).toContain(response.status);
  });
});
