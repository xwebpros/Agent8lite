import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaffHttpAdapter } from "../../apps/api/src/control/http-adapter";
import { createStaffPools } from "../../packages/db/staff-pools";

const enabled = /^estate_control_test_[0-9a-f]{16}$/.test(process.env.CONTROL_OWNED_DATABASE ?? "");
if (!enabled)
  throw new Error("Run control tests with tests/control/run.mjs against its owned disposable database.");

let server: Server, origin: string;
const pools = createStaffPools();
const admin = new Pool({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });

type Login = { cookie: string; csrf: string; body: any };

async function request(
  path: string,
  method = "GET",
  input?: unknown,
  login?: Login,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(method !== "GET"
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
    csrf: result.response.headers.get("x-csrf-token")!,
    body: result.body,
  };
}

let administrator: Login;
let supportUser: Login;

beforeAll(async () => {
  let handler: Awaited<ReturnType<typeof createStaffHttpAdapter>>;
  server = createServer((req, res) => {
    if (!handler) {
      res.writeHead(503).end();
      return;
    }
    void handler(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
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

describe("platform health-summary", () => {
  it("returns health summary for administrator", async () => {
    const { response, body } = await request("/v1/platform/health-summary", "GET", undefined, administrator);
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("organizations");
    expect(body).toHaveProperty("pendingJobs");
    expect(body).toHaveProperty("failedJobs");
    expect(body).toHaveProperty("providerStates");
    expect(body).toHaveProperty("asOf");
    expect(typeof body.organizations).toBe("number");
    expect(Array.isArray(body.providerStates)).toBe(true);
  });

  it("allows support user with platform.health.read", async () => {
    const { response, body } = await request("/v1/platform/health-summary", "GET", undefined, supportUser);
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("organizations");
  });

  it("denies unauthenticated access", async () => {
    const { response } = await request("/v1/platform/health-summary", "GET");
    expect(response.status).toBe(401);
  });
});

describe("platform configuration", () => {
  it("returns configuration for administrator", async () => {
    const { response, body } = await request("/v1/platform/configuration", "GET", undefined, administrator);
    expect(response.status).toBe(200);
    expect(body).toHaveProperty("releaseVersion");
    expect(body).toHaveProperty("featureFlags");
    expect(body).toHaveProperty("region");
    expect(body.editableVia).toBe("reviewed_deployment_config");
  });
});

describe("platform plans CRUD", () => {
  let planId: string;
  let planVersion: number;

  it("lists plans", async () => {
    const { response, body } = await request("/v1/platform/plans", "GET", undefined, administrator);
    expect(response.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("hasMore");
    expect(body).toHaveProperty("nextCursor");
  });

  it("creates a plan", async () => {
    const { response, body } = await request(
      "/v1/platform/plans",
      "POST",
      {
        code: `test-plan-${randomUUID().slice(0, 8)}`,
        name: "Test Plan",
        priceMinor: 4999,
        currency: "USD",
        billingInterval: "month",
        providerPriceId: null,
        features: { listings: true },
        limits: { maxListings: 50 },
      },
      administrator,
    );
    expect(response.status).toBe(201);
    expect(body).toHaveProperty("id");
    expect(body.name).toBe("Test Plan");
    expect(body.priceMinor).toBe(4999);
    expect(body.version).toBe(1);
    planId = body.id;
    planVersion = body.version;
  });

  it("updates a plan with optimistic concurrency", async () => {
    const { response, body } = await request(
      `/v1/platform/plans/${planId}`,
      "PATCH",
      { name: "Updated Plan", priceMinor: 5999 },
      administrator,
      { "If-Match": `"${planVersion}"` },
    );
    expect(response.status).toBe(200);
    expect(body.name).toBe("Updated Plan");
    expect(body.priceMinor).toBe(5999);
    expect(body.version).toBe(planVersion + 1);
    planVersion = body.version;
  });

  it("rejects update with stale version", async () => {
    const { response } = await request(
      `/v1/platform/plans/${planId}`,
      "PATCH",
      { name: "Stale" },
      administrator,
      { "If-Match": '"0"' },
    );
    expect(response.status).toBe(412);
  });

  afterAll(async () => {
    if (planId) await admin.query("DELETE FROM app.plan WHERE id=$1", [planId]);
  });
});

describe("platform audit-events", () => {
  it("lists audit events for administrator", async () => {
    const { response, body } = await request("/v1/platform/audit-events", "GET", undefined, administrator);
    expect(response.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body).toHaveProperty("hasMore");
    expect(body).toHaveProperty("nextCursor");
  });
});
