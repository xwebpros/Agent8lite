import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertContract } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
let leadId: string;

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});

afterAll(async () => {
  if (leadId) {
    await admin
      .query("DELETE FROM app.activity_event WHERE tenant_id=$1 AND lead_id=$2", [fixtures.orgA, leadId])
      .catch(() => {});
    await admin
      .query("DELETE FROM app.lead WHERE tenant_id=$1 AND id=$2", [fixtures.orgA, leadId])
      .catch(() => {});
  }
  await admin.end();
});

describe("engagement scoring", () => {
  it("lead creation triggers initial scoring via capture event", async () => {
    const response = await owner.command(`/v1/orgs/${owner.orgId}/leads`, {
      contactId: fixtures.contactA,
      sourceId: fixtures.sourceA,
      intent: "buyer",
    });
    expect(response.status).toBe(201);
    const lead = await response.json();
    assertContract("Lead", lead);
    leadId = lead.id;
    const refreshed = await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${leadId}`)).json();
    expect(refreshed.scoreVersion).toBe("v1");
    expect(refreshed.score).toBeGreaterThanOrEqual(10);
  });

  it("additional activity events increase score", async () => {
    const before = (await (await owner.request(`/v1/orgs/${owner.orgId}/leads/${leadId}`)).json()).score;
    await admin.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
       VALUES($1,$2,'deal.created',now(),$3)`,
      [fixtures.orgA, leadId, `score-deal-${randomUUID()}`],
    );
    const response = await owner.request(`/v1/orgs/${owner.orgId}/leads/${leadId}`);
    expect(response.status).toBe(200);
    const lead = await response.json();
    assertContract("Lead", lead);
    expect(lead.score).toBeGreaterThan(before);
  });

  it("score is capped at 100", async () => {
    for (let i = 0; i < 15; i++) {
      await admin.query(
        `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,occurred_at,source_event_id)
         VALUES($1,$2,'listing.inquiry',now(),$3)`,
        [fixtures.orgA, leadId, `score-cap-${i}-${randomUUID()}`],
      );
    }
    const response = await owner.request(`/v1/orgs/${owner.orgId}/leads/${leadId}`);
    expect(response.status).toBe(200);
    const lead = await response.json();
    assertContract("Lead", lead);
    expect(lead.score).toBe(100);
  });
});
