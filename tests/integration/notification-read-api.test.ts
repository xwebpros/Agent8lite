import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";
import { fixtures } from "../../packages/db/fixtures";

const admin = createMigrationPool();
let owner: ApiSession;
const keys = new Set<string>();
const notificationIds: string[] = [];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  const result = await admin.query(
    `INSERT INTO app.notification (tenant_id,member_id,kind,safe_payload)
     VALUES ($1,$2,'info',$3::jsonb)
     RETURNING id`,
    [fixtures.orgA, owner.memberId, JSON.stringify({ title: "Test notification", body: "Synthetic test body" })],
  );
  notificationIds.push(result.rows[0].id);
});
afterAll(async () => {
  if (notificationIds.length)
    await admin.query("DELETE FROM app.notification WHERE id=ANY($1::uuid[])", [notificationIds]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

describe("notification mark-read", () => {
  it("marks a notification as read", async () => {
    const id = notificationIds[0];
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/notifications/${id}/read`,
      {},
      { key },
    );
    expect([200, 201]).toContain(response.status);
  });

  it("rejects mark-read on nonexistent notification", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/notifications/${randomUUID()}/read`,
      {},
      { key },
    );
    expect([404, 409]).toContain(response.status);
  });

  it("notification listing includes the created notification", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/notifications`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const found = body.items.find((n: { id: string }) => n.id === notificationIds[0]);
    expect(found).toBeDefined();
    expect(found.kind).toBe("info");
    expect(found.title).toBe("Test notification");
  });
});
