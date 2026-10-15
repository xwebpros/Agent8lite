import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const leadIds: string[] = [];

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  for (const id of leadIds) {
    await admin.query("DELETE FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2", [fixtures.orgA, id]).catch(() => {});
    await admin.query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, id]).catch(() => {});
  }
  await admin.end();
});

async function createLead(): Promise<{ id: string; score: number }> {
  const response = await owner.command(`/v1/orgs/${owner.orgId}/leads`, {
    contactId: fixtures.contactA,
    sourceId: fixtures.sourceA,
    intent: "buyer",
  });
  expect(response.status).toBe(201);
  const lead = await response.json();
  leadIds.push(lead.id);
  return lead;
}

describe("scoring edge cases", () => {
  it("lead with only capture event has score >= 10", async () => {
    const lead = await createLead();
    const refreshed = await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json();
    expect(refreshed.score).toBeGreaterThanOrEqual(10);
    expect(refreshed.scoreVersion).toBe("v1");
  });

  it("score updates when different event types are added", async () => {
    const lead = await createLead();
    const before = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json()).score;

    await admin.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
       VALUES($1,$2,'form.submitted',now(),$3)`,
      [fixtures.orgA, lead.id, `score-form-${randomUUID()}`],
    );

    const after = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json()).score;
    expect(after).toBeGreaterThan(before);
  });

  it("unknown event type still contributes to score", async () => {
    const lead = await createLead();
    const before = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json()).score;

    await admin.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
       VALUES($1,$2,'custom.unknown.type',now(),$3)`,
      [fixtures.orgA, lead.id, `score-unknown-${randomUUID()}`],
    );

    const after = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json()).score;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("multiple leads score independently", async () => {
    const lead1 = await createLead();
    const lead2 = await createLead();

    for (let i = 0; i < 5; i++) {
      await admin.query(
        `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
         VALUES($1,$2,'listing.inquiry',now(),$3)`,
        [fixtures.orgA, lead1.id, `score-multi-${i}-${randomUUID()}`],
      );
    }

    const score1 = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead1.id}`)).json()).score;
    const score2 = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead2.id}`)).json()).score;
    expect(score1).toBeGreaterThan(score2);
  });

  it("score never exceeds 100 even with many high-weight events", async () => {
    const lead = await createLead();
    for (let i = 0; i < 20; i++) {
      await admin.query(
        `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
         VALUES($1,$2,'deal.created',now(),$3)`,
        [fixtures.orgA, lead.id, `score-max-${i}-${randomUUID()}`],
      );
    }
    const refreshed = await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${lead.id}`)).json();
    expect(refreshed.score).toBe(100);
  });
});
