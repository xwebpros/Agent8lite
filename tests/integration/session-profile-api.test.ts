import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiSession, assertContract, assertProblem, type Schemas } from "../helpers/api";
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

function profileCmd(body: Schemas["Profile"], revision: string) {
  const key = randomUUID();
  keys.add(key);
  return owner.command("/v1/session/profile", body, { method: "PATCH", key, revision });
}

async function currentVersion(): Promise<string> {
  const rows = await admin.query(
    "SELECT row_version FROM app.user_identity WHERE id=$1",
    [owner.session.userId],
  );
  return `"${rows.rows[0].row_version}"`;
}

describe("session profile PATCH", () => {
  it("updates display name and timezone", async () => {
    const rev = await currentVersion();
    const newName = `Synthetic Owner ${randomUUID().slice(0, 8)}`;
    const response = await profileCmd(
      { displayName: newName, phone: null, timezone: "America/Chicago" },
      rev,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.displayName).toBe(newName);
    expect(body.timezone).toBe("America/Chicago");
    expect(response.headers.get("etag")).toBeDefined();
  });

  it("updates phone number", async () => {
    const rev = await currentVersion();
    const response = await profileCmd(
      { displayName: "Synthetic Owner", phone: "+15555550100", timezone: "UTC" },
      rev,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.phone).toBe("+15555550100");
  });

  it("rejects empty display name", async () => {
    const rev = await currentVersion();
    await assertProblem(
      await profileCmd({ displayName: "   ", phone: null, timezone: "UTC" }, rev),
      422,
    );
  });

  it("rejects invalid timezone", async () => {
    const rev = await currentVersion();
    await assertProblem(
      await profileCmd({ displayName: "Synthetic Owner", phone: null, timezone: "Not/Valid" }, rev),
      422,
    );
  });

  it("rejects stale revision", async () => {
    await assertProblem(
      await profileCmd({ displayName: "Synthetic Owner", phone: null, timezone: "UTC" }, '"0"'),
      412,
    );
  });
});
