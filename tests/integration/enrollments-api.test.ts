import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";
import { fixtures } from "../../packages/db/fixtures";

const admin = createMigrationPool();
let owner: ApiSession;
const keys = new Set<string>();
const cleanupIds: string[] = [];
let publishedVersionId: string;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");

  const campaignKey = randomUUID();
  keys.add(campaignKey);
  const campaignRes = await owner.command(
    `/v1/orgs/${owner.orgId}/campaigns`,
    { name: "Enrollment Test Campaign", category: "drip" },
    { key: campaignKey },
  );
  expect(campaignRes.status).toBe(201);
  const campaign = await campaignRes.json();

  const versionKey = randomUUID();
  keys.add(versionKey);
  const versionRes = await owner.command(
    `/v1/orgs/${owner.orgId}/campaigns/${campaign.id}/versions`,
    {
      nodes: [{ key: "wait_a", kind: "wait", delaySeconds: 3600 }],
      edges: [],
      timezone: "UTC",
    },
    { key: versionKey },
  );
  expect(versionRes.status).toBe(201);
  const version = await versionRes.json();

  const publishKey = randomUUID();
  keys.add(publishKey);
  const publishRes = await owner.command(
    `/v1/orgs/${owner.orgId}/campaign-versions/${version.id}/publish`,
    {},
    { key: publishKey },
  );
  expect([200, 201]).toContain(publishRes.status);
  publishedVersionId = version.id;
});

afterAll(async () => {
  if (cleanupIds.length)
    await admin.query("DELETE FROM app.enrollment WHERE id=ANY($1::uuid[])", [cleanupIds]);
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

describe("enrollment CRUD", () => {
  it("enrolls a lead in a published campaign version", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(`/v1/orgs/${owner.orgId}/enrollments`, {
      leadId: fixtures.leadA,
      campaignVersionId: publishedVersionId,
    }, { key });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.leadId).toBe(fixtures.leadA);
    expect(body.campaignVersionId).toBe(publishedVersionId);
    expect(body.state).toBe("active");
    expect(body.version).toBe(1);
    cleanupIds.push(body.id);
  });

  it("lists enrollments", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}/enrollments`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toBeDefined();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("hasMore");
  });

  it("cancels an active enrollment", async () => {
    const enrollKey = randomUUID();
    keys.add(enrollKey);
    const enrollRes = await owner.command(`/v1/orgs/${owner.orgId}/enrollments`, {
      leadId: fixtures.leadA,
      campaignVersionId: publishedVersionId,
    }, { key: enrollKey });
    expect(enrollRes.status).toBe(201);
    const enrollment = await enrollRes.json();
    cleanupIds.push(enrollment.id);

    const cancelKey = randomUUID();
    keys.add(cancelKey);
    const cancelRes = await owner.command(
      `/v1/orgs/${owner.orgId}/enrollments/${enrollment.id}/cancel`,
      {},
      { key: cancelKey },
    );
    expect(cancelRes.status).toBe(201);
    const cancelled = await cancelRes.json();
    expect(cancelled.state).toBe("cancelled");
  });

  it("rejects cancellation of already-cancelled enrollment", async () => {
    const enrollKey = randomUUID();
    keys.add(enrollKey);
    const enrollRes = await owner.command(`/v1/orgs/${owner.orgId}/enrollments`, {
      leadId: fixtures.leadA,
      campaignVersionId: publishedVersionId,
    }, { key: enrollKey });
    const enrollment = await enrollRes.json();
    cleanupIds.push(enrollment.id);

    const cancelKey1 = randomUUID();
    keys.add(cancelKey1);
    await owner.command(
      `/v1/orgs/${owner.orgId}/enrollments/${enrollment.id}/cancel`,
      {},
      { key: cancelKey1 },
    );

    const cancelKey2 = randomUUID();
    keys.add(cancelKey2);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}/enrollments/${enrollment.id}/cancel`,
        {},
        { key: cancelKey2 },
      ),
      409,
    );
  });

  it("rejects enrollment with fabricated lead", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(`/v1/orgs/${owner.orgId}/enrollments`, {
      leadId: randomUUID(),
      campaignVersionId: publishedVersionId,
    }, { key });
    expect([404, 422, 503]).toContain(response.status);
  });
});
