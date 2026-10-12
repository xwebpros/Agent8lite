import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSyntheticSession, hashToken } from "../../packages/auth/sessions";
import { fixtures } from "../../packages/db/fixtures";
import { createMigrationPool, createRuntimePool, runtimeDatabaseUrl } from "../helpers/database";

const runtime = createRuntimePool();
const admin = createMigrationPool();
let token: string;

type ProbeResult = {
  status: string;
  code?: string;
  identityMatch?: boolean;
  connections?: number;
  results?: { status: number; code?: string; cache?: string; identityMatch?: boolean }[];
};

function childProbe(
  environment: { APP_ENV: string; DEV_AUTH_ENABLED: string },
  mode: "read" | "http" = "read",
) {
  return new Promise<ProbeResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/session-mode-probe.ts"], {
      env: { ...process.env, DATABASE_URL: runtimeDatabaseUrl, ...environment },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    // Drain diagnostics without echoing an unexpected private database/provider error.
    child.stderr.resume();
    const timeout = setTimeout(() => child.kill(), 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const line = output.split(/\r?\n/).find((item) => item.startsWith("SESSION_PROBE_RESULT="));
      if (code !== 0 || !line) return reject(new Error("Isolated synthetic-session probe failed."));
      resolve(JSON.parse(line.slice("SESSION_PROBE_RESULT=".length)));
    });
    child.stdin.end(
      JSON.stringify({ mode, token, userId: fixtures.ownerUser, organizationId: fixtures.orgA }),
    );
  });
}

beforeAll(async () => {
  token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
});
afterAll(async () => {
  try {
    if (token) await admin.query("DELETE FROM app.login_session WHERE token_hash=$1", [hashToken(token)]);
  } finally {
    await Promise.all([runtime.end(), admin.end()]);
  }
});

describe("M1 — retained synthetic identities remain confined to approved local mode", () => {
  it.each(["test", "development"])(
    "accepts a genuine retained token in explicitly enabled %s mode",
    async (APP_ENV) => {
      expect(await childProbe({ APP_ENV, DEV_AUTH_ENABLED: "true" })).toEqual({
        status: "accepted",
        identityMatch: true,
        connections: 1,
      });
    },
  );

  it.each([
    { APP_ENV: "production", DEV_AUTH_ENABLED: "true" },
    { APP_ENV: "test", DEV_AUTH_ENABLED: "false" },
    { APP_ENV: "", DEV_AUTH_ENABLED: "true" },
    { APP_ENV: "development", DEV_AUTH_ENABLED: "" },
  ])(
    "rejects a retained token before any database connection in $APP_ENV/$DEV_AUTH_ENABLED",
    async (environment) => {
      expect(await childProbe(environment)).toEqual({
        status: "rejected",
        code: "identity_provider_unconfigured",
        connections: 0,
      });
    },
  );

  it("applies loopback and forwarded-client checks to ordinary authenticated GET paths", async () => {
    const result = await childProbe({ APP_ENV: "test", DEV_AUTH_ENABLED: "true" }, "http");
    expect(result.status).toBe("http");
    const responses = result.results!;
    expect(responses.map((response) => response.status)).toEqual([200, 200, 403, 403, 403, 403]);
    expect(responses[0].identityMatch).toBe(true);
    for (const response of responses) expect(response.cache).toContain("no-store");
    for (const response of responses.slice(2)) expect(response.code).toBe("loopback_required");
  });

  it("production mode without OIDC env accepts valid sessions without loopback restriction", async () => {
    const result = await childProbe({ APP_ENV: "production", DEV_AUTH_ENABLED: "false" }, "http");
    expect(result.status).toBe("http");
    const responses = result.results!;
    expect(responses[0].status).toBe(200);
    expect(responses[0].identityMatch).toBe(true);
    for (const response of responses) expect(response.cache).toContain("no-store");
  });
});
