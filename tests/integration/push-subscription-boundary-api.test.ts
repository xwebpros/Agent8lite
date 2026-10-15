import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem, type Schemas } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let agent: ApiSession;
const subIds = new Set<string>();
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
  agent = await new ApiSession().signIn("agent");
});
afterAll(async () => {
  if (subIds.size)
    await admin.query("DELETE FROM app.push_subscription WHERE id=ANY($1::uuid[])", [[...subIds]]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

function subscriptionWrite(label: string): Schemas["PushSubscriptionWrite"] {
  return {
    endpoint: `https://push.example.com/boundary/${randomUUID()}`,
    keys: { p256dh: randomUUID(), auth: randomUUID().slice(0, 22) },
    deviceLabel: label,
    topics: ["assigned_lead"],
  };
}

describe("push subscription authorization boundaries", () => {
  it("agent can create their own push subscription", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await agent.command(
      `/v1/orgs/${agent.orgId}/push-subscriptions`,
      subscriptionWrite("Agent device"),
      { key },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    subIds.add(body.id);
    expect(body.deviceLabel).toBe("Agent device");
  });

  it("member cannot revoke another member's subscription", async () => {
    const key = randomUUID();
    keys.add(key);
    const created = await owner.command(
      `/v1/orgs/${owner.orgId}/push-subscriptions`,
      subscriptionWrite("Owner device"),
      { key },
    );
    const sub = await created.json();
    subIds.add(sub.id);

    const deleteResponse = await agent.request(
      `/v1/orgs/${agent.orgId}/push-subscriptions/${sub.id}`,
      { method: "DELETE", headers: { "x-csrf-token": agent.csrf } },
    );
    expect([403, 404]).toContain(deleteResponse.status);
  });

  it("unauthenticated request cannot list subscriptions", async () => {
    const response = await fetch(`http://127.0.0.1:3001/v1/orgs/${owner.orgId}/push-subscriptions`);
    expect([401, 403]).toContain(response.status);
  });

  it("CSRF is required for subscription creation", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/push-subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(subscriptionWrite("No CSRF")),
    });
    expect([400, 403]).toContain(response.status);
  });
});
