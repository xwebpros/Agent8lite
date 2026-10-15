import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const subIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterEach(async () => {
  if (subIds.size)
    await admin.query("DELETE FROM app.push_subscription WHERE id=ANY($1::uuid[])", [[...subIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  subIds.clear();
  keys.clear();
});
afterAll(async () => {
  await admin.end();
});

function subscriptionWrite(label?: string): Schemas["PushSubscriptionWrite"] {
  return {
    endpoint: `https://push.example.com/synthetic/${randomUUID()}`,
    keys: { p256dh: randomUUID(), auth: randomUUID().slice(0, 22) },
    deviceLabel: label ?? "Synthetic test device",
    topics: ["assigned_lead", "task_due"],
  };
}

describe("VAPID public key endpoint", () => {
  it("returns the VAPID applicationServerKey without authentication", async () => {
    const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3001}/v1/push/vapid-key`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applicationServerKey).toBeDefined();
    expect(typeof body.applicationServerKey).toBe("string");
    expect(body.applicationServerKey.length).toBeGreaterThan(20);
  });
});

describe("push-subscriptions CRUD", () => {
  it("creates a push subscription", async () => {
    const input = subscriptionWrite();
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, input, { key });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.deviceLabel).toBe("Synthetic test device");
    expect(body.state).toBe("active");
    expect(body.version).toBe(1);
    subIds.add(body.id);
  });

  it("lists push subscriptions", async () => {
    const input = subscriptionWrite("List device");
    const key = randomUUID();
    keys.add(key);
    const created = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, input, { key });
    const sub = await created.json();
    subIds.add(sub.id);

    const response = await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    const found = body.items.find((s: { id: string }) => s.id === sub.id);
    expect(found).toBeDefined();
    expect(found!.deviceLabel).toBe("List device");
  });

  it("upserts on duplicate endpoint", async () => {
    const input = subscriptionWrite("First");
    const key1 = randomUUID();
    keys.add(key1);
    const first = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, input, { key: key1 });
    const firstBody = await first.json();
    subIds.add(firstBody.id);

    const key2 = randomUUID();
    keys.add(key2);
    const updated = { ...input, deviceLabel: "Updated" };
    const second = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, updated, { key: key2 });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.deviceLabel).toBe("Updated");
    expect(secondBody.version).toBeGreaterThan(firstBody.version);
  });

  it("revokes a push subscription", async () => {
    const input = subscriptionWrite("Revoke device");
    const key = randomUUID();
    keys.add(key);
    const created = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, input, { key });
    const sub = await created.json();
    subIds.add(sub.id);

    const deleteResponse = await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions/${sub.id}`, {
      method: "DELETE",
      headers: { "x-csrf-token": owner.csrf },
    });
    expect(deleteResponse.status).toBe(204);
  });

  it("rejects revocation of unknown device", async () => {
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions/${randomUUID()}`, {
        method: "DELETE",
        headers: { "x-csrf-token": owner.csrf },
      }),
      404,
    );
  });

  it("rejects double revocation", async () => {
    const input = subscriptionWrite("Double revoke");
    const key = randomUUID();
    keys.add(key);
    const created = await owner.command(`/v1/orgs/${owner.orgId}/push-subscriptions`, input, { key });
    const sub = await created.json();
    subIds.add(sub.id);

    await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions/${sub.id}`, {
      method: "DELETE",
      headers: { "x-csrf-token": owner.csrf },
    });
    await assertProblem(
      await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions/${sub.id}`, {
        method: "DELETE",
        headers: { "x-csrf-token": owner.csrf },
      }),
      404,
    );
  });
});
