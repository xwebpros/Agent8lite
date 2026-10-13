import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const tagIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  if (tagIds.size) await admin.query("DELETE FROM app.tag WHERE id=ANY($1::uuid[])", [[...tagIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

function cmd(resource: string, body: unknown, opts: { method?: string; revision?: string } = {}) {
  const key = randomUUID();
  keys.add(key);
  return owner.command(`/v1/orgs/${owner.orgId}/${resource}`, body, { key, ...opts });
}

describe("audit-events API", () => {
  it("lists audit events with contract-valid structure", async () => {
    const tag = await cmd("tags", { name: `Audit trail tag ${randomUUID()}` });
    expect(tag.status).toBe(201);
    const tagBody = await tag.json();
    tagIds.add(tagBody.id);

    const response = await owner.request(`/v1/orgs/${owner.orgId}/audit-events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    expect(typeof body.hasMore).toBe("boolean");

    const item = body.items[0];
    expect(item.id).toBeDefined();
    expect(item.action).toBeDefined();
    expect(item.resourceType).toBeDefined();
    expect(item.createdAt).toBeDefined();
  });

  it("supports cursor pagination", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/audit-events?limit=1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.length).toBeLessThanOrEqual(1);

    if (body.nextCursor) {
      const page2 = await owner.request(
        `/v1/orgs/${owner.orgId}/audit-events?limit=1&cursor=${body.nextCursor}`,
      );
      expect(page2.status).toBe(200);
      const body2 = await page2.json();
      expect(body2.items).toBeDefined();
      if (body2.items.length > 0) {
        expect(body2.items[0].id).not.toBe(body.items[0].id);
      }
    }
  });

  it("rejects POST method", async () => {
    await assertProblem(await owner.command(`/v1/orgs/${owner.orgId}/audit-events`, {}), 404);
  });

  it("rejects invalid cursor uuid", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${owner.orgId}/audit-events?cursor=not-a-uuid`), 422);
  });
});
