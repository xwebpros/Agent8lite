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

describe("broadcast dispatch dev route", () => {
  it("processes queued broadcast jobs and returns results", async () => {
    const response = await owner.command("/dev/dispatch-broadcasts", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("processed");
    expect(body).toHaveProperty("results");
    expect(typeof body.processed).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe("action dispatch dev route", () => {
  it("processes due scheduled actions and returns results", async () => {
    const response = await owner.command("/dev/dispatch-actions", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("processed");
    expect(body).toHaveProperty("results");
    expect(typeof body.processed).toBe("number");
    expect(Array.isArray(body.results)).toBe(true);
  });
});

describe("retention dev route", () => {
  it("enforces retention policy and returns counts", async () => {
    const response = await owner.command("/dev/retention", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("expiredIdempotencyRecords");
    expect(body).toHaveProperty("expiredOutboxReceipts");
    expect(body).toHaveProperty("archivedContactsPurged");
    expect(body).toHaveProperty("archivedLeadsPurged");
    expect(typeof body.expiredIdempotencyRecords).toBe("number");
  });
});

describe("dispatch auth boundaries", () => {
  it("rejects unauthenticated broadcast dispatch", async () => {
    const response = await fetch("http://127.0.0.1:3001/dev/dispatch-broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(response.status);
  });

  it("rejects unauthenticated action dispatch", async () => {
    const response = await fetch("http://127.0.0.1:3001/dev/dispatch-actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(response.status);
  });

  it("rejects unauthenticated retention", async () => {
    const response = await fetch("http://127.0.0.1:3001/dev/retention", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(response.status);
  });
});

describe("job listing endpoint", () => {
  it("lists integration jobs for the current member", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/jobs`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("hasMore");
    expect(Array.isArray(body.items)).toBe(true);
  });

  it("supports state filter", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/jobs?state=succeeded`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
    for (const job of body.items) {
      expect(job.state).toBe("succeeded");
    }
  });

  it("supports kind filter", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/jobs?kind=data.export`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.items)).toBe(true);
    for (const job of body.items) {
      expect(job.kind).toBe("data.export");
    }
  });

  it("rejects unauthenticated job listing", async () => {
    const response = await fetch(`http://127.0.0.1:3001/v1/orgs/${owner.orgId}/jobs`);
    expect([401, 403]).toContain(response.status);
  });
});
