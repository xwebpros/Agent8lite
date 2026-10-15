import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("GET /v1/orgs/{orgId}", () => {
  it("returns the current organization with ETag", async () => {
    const response = await owner.request(`/v1/orgs/${owner.orgId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.id).toBe(owner.orgId);
    expect(body.name).toBeDefined();
    expect(typeof body.name).toBe("string");
    expect(response.headers.get("etag")).toBeDefined();
  });

  it("rejects access to a fabricated organization", async () => {
    await assertProblem(await owner.request(`/v1/orgs/${randomUUID()}`), 403);
  });
});

describe("PATCH /v1/orgs/{orgId}", () => {
  let originalName: string;

  beforeAll(async () => {
    const body = await (await owner.request(`/v1/orgs/${owner.orgId}`)).json();
    originalName = body.name;
  });

  afterAll(async () => {
    const rev = await orgVersion();
    const key = randomUUID();
    keys.add(key);
    await owner.command(`/v1/orgs/${owner.orgId}`, { name: originalName, timezone: "UTC" }, { method: "PATCH", key, revision: rev });
  });

  async function orgVersion(): Promise<string> {
    const rows = await admin.query(
      "SELECT row_version FROM app.organization WHERE id=$1",
      [owner.orgId],
    );
    return `"${rows.rows[0].row_version}"`;
  }

  it("updates organization name", async () => {
    const rev = await orgVersion();
    const newName = `Synthetic Brokerage ${randomUUID().slice(0, 8)}`;
    const key = randomUUID();
    keys.add(key);
    const response = await owner.command(
      `/v1/orgs/${owner.orgId}`,
      { name: newName, timezone: "America/Los_Angeles" },
      { method: "PATCH", key, revision: rev },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe(newName);
    expect(response.headers.get("etag")).toBeDefined();
  });

  it("rejects stale revision", async () => {
    const key = randomUUID();
    keys.add(key);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${owner.orgId}`,
        { name: "Stale", timezone: "UTC" },
        { method: "PATCH", key, revision: '"0"' },
      ),
      412,
    );
  });

  it("rejects update to fabricated organization", async () => {
    const key = randomUUID();
    keys.add(key);
    await assertProblem(
      await owner.command(
        `/v1/orgs/${randomUUID()}`,
        { name: "Nope", timezone: "UTC" },
        { method: "PATCH", key, revision: '"1"' },
      ),
      403,
    );
  });
});
