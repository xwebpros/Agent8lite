import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHttpAdapter } from "../../apps/api/src/control/http-adapter";
import { createStaffPools } from "../../packages/db/staff-pools";
import { fixtures } from "../../packages/db/fixtures";

const enabled = /^estate_control_test_[0-9a-f]{16}$/.test(process.env.CONTROL_OWNED_DATABASE ?? "");
if (!enabled)
  throw new Error("Run control tests with tests/control/run.mjs against its owned disposable database.");

let server: Server, origin: string;
const pools = createStaffPools();
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });

type Login = { cookie: string; token: string; csrf: string; body: any };

async function request(path: string, method = "GET", input?: unknown, login?: Login, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(method === "POST"
        ? { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }
        : {}),
      ...(login ? { Cookie: login.cookie, "X-CSRF-Token": login.csrf } : {}),
      ...headers,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

async function login(identity: "administrator" | "support"): Promise<Login> {
  const result = await request("/dev/staff/session", "POST", { identity });
  expect(result.response.status, JSON.stringify(result.body)).toBe(200);
  const cookie = result.response.headers.get("set-cookie")!.split(";")[0];
  return {
    cookie,
    token: cookie.split("=")[1],
    csrf: result.response.headers.get("x-csrf-token")!,
    body: result.body,
  };
}

let administrator: Login;
let supportUser: Login;

beforeAll(async () => {
  let handler: Awaited<ReturnType<typeof createStaffHttpAdapter>>;
  server = createServer((req, res) => {
    if (!handler) { res.writeHead(503).end(); return; }
    void handler(req, res).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  handler = await createStaffHttpAdapter({
    control: pools.control,
    issuer: pools.issuer,
    allowedOrigins: [origin],
  });
  administrator = await login("administrator");
  supportUser = await login("support");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pools.control.end();
  await pools.issuer.end();
  await admin.end();
});

describe("staff principal CRUD", () => {
  let testUserId: string;
  let createdPrincipalId: string;
  let createdVersion: string;

  beforeAll(async () => {
    testUserId = randomUUID();
    await admin.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified) VALUES($1,'urn:estate:synthetic','test-crud','CRUD Test User',true)",
      [testUserId],
    );
  });

  afterAll(async () => {
    if (createdPrincipalId)
      await admin.query("DELETE FROM app.staff_principal WHERE id=$1", [createdPrincipalId]);
    await admin.query("DELETE FROM app.user_identity WHERE id=$1", [testUserId]);
  });

  it("lists existing principals", async () => {
    const result = await request("/dev/staff/principals", "GET", undefined, administrator);
    expect(result.response.status).toBe(200);
    expect(result.body.items).toBeInstanceOf(Array);
    expect(result.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("rejects list without provisioning permission", async () => {
    const result = await request("/dev/staff/principals", "GET", undefined, supportUser);
    expect(result.response.status).toBe(403);
  });

  it("creates a new staff principal", async () => {
    const result = await request("/dev/staff/principals", "POST", {
      userId: testUserId,
      permissionCodes: ["platform.orgs.read", "platform.health.read"],
    }, administrator);
    expect(result.response.status).toBe(201);
    expect(result.body.userId).toBe(testUserId);
    expect(result.body.permissionCodes).toEqual(["platform.orgs.read", "platform.health.read"]);
    expect(result.body.active).toBe(true);
    createdPrincipalId = result.body.id;
    createdVersion = result.body.rowVersion;
  });

  it("rejects creating a principal for your own user", async () => {
    const result = await request("/dev/staff/principals", "POST", {
      userId: fixtures.staffAdministratorUser,
      permissionCodes: ["platform.orgs.read"],
    }, administrator);
    expect(result.response.status).toBe(422);
    expect(result.body.code).toBe("self_modification_denied");
  });

  it("rejects duplicate principal for same user", async () => {
    const result = await request("/dev/staff/principals", "POST", {
      userId: testUserId,
      permissionCodes: ["platform.orgs.read"],
    }, administrator);
    expect(result.response.status).toBe(409);
  });

  it("rejects invalid permission codes", async () => {
    const otherUser = randomUUID();
    await admin.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified) VALUES($1,'urn:estate:synthetic','test-invalid','Invalid Test',true)",
      [otherUser],
    );
    try {
      const result = await request("/dev/staff/principals", "POST", {
        userId: otherUser,
        permissionCodes: ["fake.permission.code"],
      }, administrator);
      expect(result.response.status).toBe(422);
    } finally {
      await admin.query("DELETE FROM app.user_identity WHERE id=$1", [otherUser]);
    }
  });

  it("reads a specific principal", async () => {
    const result = await request(`/dev/staff/principals/${createdPrincipalId}`, "GET", undefined, administrator);
    expect(result.response.status).toBe(200);
    expect(result.body.id).toBe(createdPrincipalId);
    expect(result.response.headers.get("etag")).toBe(`"${createdVersion}"`);
  });

  it("updates principal permissions", async () => {
    const result = await request(`/dev/staff/principals/${createdPrincipalId}`, "POST", {
      permissionCodes: ["platform.orgs.read", "platform.health.read", "platform.config.read"],
    }, administrator, { "If-Match": `"${createdVersion}"` });
    expect(result.response.status).toBe(200);
    expect(result.body.permissionCodes).toEqual([
      "platform.orgs.read", "platform.health.read", "platform.config.read",
    ]);
    createdVersion = result.body.rowVersion;
  });

  it("rejects update with stale version", async () => {
    const result = await request(`/dev/staff/principals/${createdPrincipalId}`, "POST", {
      permissionCodes: ["platform.orgs.read"],
    }, administrator, { "If-Match": '"0"' });
    expect(result.response.status).toBe(409);
  });

  it("rejects self-modification via update", async () => {
    const adminPrincipal = await admin.query(
      "SELECT id, row_version FROM app.staff_principal WHERE user_id=$1",
      [fixtures.staffAdministratorUser],
    );
    const result = await request(`/dev/staff/principals/${adminPrincipal.rows[0].id}`, "POST", {
      permissionCodes: ["platform.orgs.read"],
    }, administrator, { "If-Match": `"${adminPrincipal.rows[0].row_version}"` });
    expect(result.response.status).toBe(422);
    expect(result.body.code).toBe("self_modification_denied");
  });

  it("deactivates a principal", async () => {
    const result = await request(`/dev/staff/principals/${createdPrincipalId}/deactivate`, "POST", {}, administrator, { "If-Match": `"${createdVersion}"` });
    expect(result.response.status).toBe(200);
    expect(result.body.active).toBe(false);
    createdVersion = result.body.rowVersion;
  });

  it("rejects unrestricted access when only one administrator exists", async () => {
    const allCodes = [
      "platform.audit.read", "platform.config.read", "platform.health.read",
      "platform.orgs.provision", "platform.orgs.read", "platform.plans.manage",
      "platform.plans.read", "platform.support.grant",
    ];
    const otherUser = randomUUID();
    await admin.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email_verified) VALUES($1,'urn:estate:synthetic','test-unrestricted','Unrestricted Test',true)",
      [otherUser],
    );
    try {
      const result = await request("/dev/staff/principals", "POST", {
        userId: otherUser,
        permissionCodes: allCodes,
      }, administrator);
      expect(result.response.status).toBe(422);
      expect(result.body.code).toBe("unrestricted_requires_second_administrator");
    } finally {
      await admin.query("DELETE FROM app.user_identity WHERE id=$1", [otherUser]);
    }
  });

  it("support user cannot manage principals", async () => {
    const result = await request("/dev/staff/principals", "POST", {
      userId: randomUUID(),
      permissionCodes: ["platform.orgs.read"],
    }, supportUser);
    expect(result.response.status).toBe(403);
  });
});
