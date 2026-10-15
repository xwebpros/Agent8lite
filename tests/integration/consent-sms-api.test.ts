import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { ApiSession, assertProblem } from "../helpers/api";
import { createMigrationPool } from "../helpers/database";

const admin = createMigrationPool();
let owner: ApiSession;
const keys = new Set<string>();

beforeAll(async () => {
  owner = await new ApiSession().signIn("owner");
});
afterAll(async () => {
  if (keys.size)
    await admin.query("DELETE FROM app.idempotency_record WHERE key=ANY($1::text[])", [[...keys]]);
  await admin.end();
});

describe("consent event validation", () => {
  it("rejects consent event with missing required fields", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/consent-events`,
      {},
      { key },
    );
    expect([400, 422]).toContain(response.status);
  });

  it("rejects consent event for unknown contact", async () => {
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}/consent-events`,
      {
        contactId: randomUUID(),
        channelId: randomUUID(),
        purpose: "email_marketing",
        action: "grant",
        evidenceToken: "invalid-token",
      },
      { key },
    );
    expect([400, 404, 422]).toContain(response.status);
  });

  it("unauthenticated consent event is rejected", async () => {
    const response = await fetch(`http://127.0.0.1:3001/v1/orgs/${owner.orgId}/consent-events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect([401, 403]).toContain(response.status);
  });
});
