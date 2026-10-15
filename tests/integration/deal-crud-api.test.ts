import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let leadId: string;
const dealIds: string[] = [];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  const leads = await owner.request(`/v1/orgs/${owner.orgId}/leads`);
  expect(leads.status).toBe(200);
  const body = await leads.json();
  expect(body.items.length).toBeGreaterThan(0);
  leadId = body.items[0].id;
});

afterAll(async () => {
  for (const id of dealIds) await admin.query("DELETE FROM app.deal WHERE id=$1", [id]).catch(() => {});
  await admin.end();
});

const path = (resource: string) => `/v1/orgs/${owner.orgId}/${resource}`;

describe("deal CRUD", () => {
  let dealId: string;
  let dealVersion: number;

  it("creates a deal", async () => {
    const response = await owner.command(path("deals"), {
      leadId,
      name: `Synthetic test deal ${randomUUID().slice(0, 8)}`,
      amount: 250000,
      currency: "USD",
      state: "open",
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    assertContract("Deal", body);
    expect(body.name).toContain("Synthetic test deal");
    expect(body.state).toBe("open");
    dealId = body.id;
    dealVersion = body.version;
    dealIds.push(dealId);
  });

  it("reads the deal by id", async () => {
    const response = await owner.request(path(`deals/${dealId}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    assertContract("Deal", body);
    expect(body.id).toBe(dealId);
  });

  it("lists deals", async () => {
    const response = await owner.request(path("deals"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeInstanceOf(Array);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it("updates a deal", async () => {
    const response = await owner.command(
      path(`deals/${dealId}`),
      {
        leadId,
        name: "Updated deal title",
        amount: 350000,
        currency: "USD",
        state: "open",
      },
      { method: "PATCH", revision: `"${dealVersion}"` },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    assertContract("Deal", body);
    expect(body.name).toBe("Updated deal title");
    expect(body.version).toBe(dealVersion + 1);
    dealVersion = body.version;
  });

  it("rejects update with stale version", async () => {
    const response = await owner.command(
      path(`deals/${dealId}`),
      {
        leadId,
        name: "Stale update",
        amount: 100000,
        currency: "USD",
        state: "open",
      },
      { method: "PATCH", revision: '"0"' },
    );
    expect([409, 412]).toContain(response.status);
  });
});
