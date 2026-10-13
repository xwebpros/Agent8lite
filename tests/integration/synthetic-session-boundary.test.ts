import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createSession,
  createSyntheticSession,
  hashToken,
  readProductionSession,
  switchOrganization,
} from "../../packages/auth/sessions";
import { fixtures, roleId } from "../../packages/db/fixtures";
import { OidcTokenVerifier } from "../../packages/providers/identity/oidc";
import type { VerifiedOidcIdentity } from "../../packages/providers/identity/port";
import {
  createMigrationPool,
  createRuntimePool,
  migrationDatabaseUrl,
  runtimeDatabaseUrl,
} from "../helpers/database";

const runtime = createRuntimePool();
const admin = createMigrationPool();
const blocker = createMigrationPool();
const issuer = "https://identity.example.test/fixture";
const clientId = "estate-production-boundary-fixture";
const oidcUser = randomUUID();
const oidcMember = randomUUID();
const subject = `fixture-${randomUUID()}`;
const email = `${subject}@example.test`;
const tokens = new Set<string>();
let token: string;
let legacyToken: string;
let oidcToken: string;
let verifiedIdentity: VerifiedOidcIdentity;
let fixtureTargetVerified = false;

type Environment = {
  APP_ENV: string;
  DEV_AUTH_ENABLED: string;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
};
const production: Environment = {
  APP_ENV: "production",
  DEV_AUTH_ENABLED: "false",
  OIDC_ISSUER: issuer,
  OIDC_CLIENT_ID: clientId,
};
type ProbeResult = {
  status: string;
  code?: string;
  identityMatch?: boolean;
  connections?: number;
  results?: { status: number; code?: string; cache?: string; identityMatch?: boolean; synthetic?: string }[];
};

function childProbe(
  environment: Environment,
  mode: "read" | "http" = "read",
  options: {
    reader?: "synthetic" | "production";
    suppliedToken?: string | null;
    userId?: string;
    includeDevelopmentLogin?: boolean;
  } = {},
) {
  return new Promise<ProbeResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/session-mode-probe.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: runtimeDatabaseUrl,
        OIDC_ISSUER: "",
        OIDC_CLIENT_ID: "",
        OIDC_CLIENT_SECRET: "",
        ...environment,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    // Drain diagnostics without echoing a private database/provider error or stdin cookie.
    child.stderr.resume();
    let timedOut = false;
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const line = output.split(/\r?\n/).find((item) => item.startsWith("SESSION_PROBE_RESULT="));
      const diagnostic = `mode=${mode}, reader=${options.reader ?? "synthetic"}, ownedPid=${child.pid}, elapsedMs=${Date.now() - startedAt}`;
      if (timedOut) return reject(new Error(`Session boundary probe timed out at 15000ms (${diagnostic}).`));
      if (code !== 0 || !line)
        return reject(
          new Error(`Session boundary probe exited without a result (${diagnostic}, exitCode=${code}).`),
        );
      resolve(JSON.parse(line.slice("SESSION_PROBE_RESULT=".length)));
    });
    child.stdin.end(
      JSON.stringify({
        mode,
        reader: options.reader ?? "synthetic",
        token: options.suppliedToken === null ? undefined : (options.suppliedToken ?? token),
        userId: options.userId ?? fixtures.ownerUser,
        organizationId: fixtures.orgA,
        includeDevelopmentLogin: options.includeDevelopmentLogin,
      }),
    );
  });
}

async function configured<T>(operation: () => Promise<T>) {
  const prior = { OIDC_ISSUER: process.env.OIDC_ISSUER, OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID };
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = clientId;
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createOidcSession() {
  const result = await configured(() =>
    createSession(runtime, oidcUser, fixtures.orgA, { identity: verifiedIdentity, clientId }),
  );
  tokens.add(result.token);
  return result.token;
}

async function insertLegacySession() {
  const value = randomBytes(32).toString("hex");
  await admin.query(
    "INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at)VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
    [hashToken(value), fixtures.ownerUser, fixtures.orgA, randomBytes(32).toString("hex")],
  );
  tokens.add(value);
  return value;
}

async function insertExpiringOidcSession() {
  const value = randomBytes(32).toString("hex");
  await admin.query(
    "INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at,identity_provenance,oidc_issuer,oidc_client_id,oidc_subject)VALUES($1,$2,$3,$4,clock_timestamp()+interval '3 seconds','oidc',$5,$6,$7)",
    [hashToken(value), oidcUser, fixtures.orgA, randomBytes(32).toString("hex"), issuer, clientId, subject],
  );
  tokens.add(value);
  return value;
}

async function waitForLock(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
    if (state.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The owned session reader did not reach the required database lock.");
}

beforeAll(async () => {
  // Both approved harnesses allocate a new database and supply explicit identities.
  // Refuse the ordinary estate fallback before opening a connection or writing fixtures.
  let safe = false;
  try {
    const runtimeTarget = new URL(runtimeDatabaseUrl);
    const migrationTarget = new URL(migrationDatabaseUrl);
    safe =
      !!process.env.TEST_DATABASE_URL &&
      !!process.env.TEST_MIGRATION_DATABASE_URL &&
      ["127.0.0.1", "localhost", "[::1]"].includes(runtimeTarget.hostname) &&
      ["54434", "55432"].includes(runtimeTarget.port) &&
      /^\/estate_acceptance_[0-9a-f]{16}$/.test(runtimeTarget.pathname) &&
      runtimeTarget.protocol === "postgresql:" &&
      migrationTarget.protocol === runtimeTarget.protocol &&
      migrationTarget.hostname === runtimeTarget.hostname &&
      migrationTarget.port === runtimeTarget.port &&
      migrationTarget.pathname === runtimeTarget.pathname &&
      !runtimeTarget.search &&
      !runtimeTarget.hash &&
      !migrationTarget.search &&
      !migrationTarget.hash &&
      runtimeTarget.username === "estate_runtime" &&
      !!migrationTarget.username &&
      !["estate_runtime", "estate_worker", "estate_control", "estate_staff_issuer"].includes(
        migrationTarget.username,
      );
  } catch {
    // Do not expose malformed connection strings or credentials in a verification error.
  }
  if (!safe) throw new Error("Session boundary fixtures require a matching owned disposable database.");
  fixtureTargetVerified = true;
  token = (await createSyntheticSession(runtime, fixtures.ownerUser, fixtures.orgA)).token;
  tokens.add(token);
  legacyToken = await insertLegacySession();
  await admin.query(
    "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified)VALUES($1,$2,$3,'Synthetic OIDC boundary fixture',$4,true)",
    [oidcUser, issuer, subject, email],
  );
  await admin.query(
    "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic OIDC boundary fixture')",
    [fixtures.orgA, oidcMember, oidcUser, roleId(1, 1)],
  );
  // Actual RS256 verification with an in-memory invented issuer/JWKS, never a provider call.
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT", kid: "boundary-fixture" });
  const body = encode({
    iss: issuer,
    sub: subject,
    aud: clientId,
    nonce: "boundary-nonce",
    email,
    email_verified: true,
    iat: now,
    exp: now + 300,
    auth_time: now,
  });
  const signed = `${header}.${body}`;
  const idToken = `${signed}.${sign("RSA-SHA256", Buffer.from(signed), keys.privateKey).toString("base64url")}`;
  const jwksUri = `${issuer}/keys`;
  const fetchFixture = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (url !== jwksUri) throw new Error("Unexpected fixture identity network request.");
    return Response.json({
      keys: [
        { ...keys.publicKey.export({ format: "jwk" }), kid: "boundary-fixture", use: "sig", alg: "RS256" },
      ],
    });
  });
  try {
    verifiedIdentity = await new OidcTokenVerifier({ issuer, jwksUri }).verifyIdentityToken(idToken, {
      clientId,
      nonce: "boundary-nonce",
    });
  } finally {
    fetchFixture.mockRestore();
  }
  oidcToken = await createOidcSession();
});

afterAll(async () => {
  try {
    if (!fixtureTargetVerified) return;
    await blocker.query("ROLLBACK");
    for (const value of tokens)
      await admin.query("DELETE FROM app.login_session WHERE token_hash=$1", [hashToken(value)]);
    await admin.query("DELETE FROM app.membership WHERE id=$1", [oidcMember]);
    await admin.query("DELETE FROM app.user_identity WHERE id=$1", [oidcUser]);
  } finally {
    await Promise.all([runtime.end(), admin.end(), blocker.end()]);
  }
});

describe("M1 — member identity provenance and retained session boundaries", () => {
  it.each(["test", "development"])(
    "accepts retained synthetic and legacy tokens only in enabled %s mode",
    async (APP_ENV) => {
      for (const suppliedToken of [token, legacyToken])
        expect(await childProbe({ APP_ENV, DEV_AUTH_ENABLED: "true" }, "read", { suppliedToken })).toEqual({
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
  ])("rejects the synthetic reader before connection in $APP_ENV/$DEV_AUTH_ENABLED", async (environment) => {
    expect(await childProbe(environment)).toEqual({
      status: "rejected",
      code: "identity_provider_unconfigured",
      connections: 0,
    });
  });

  it("applies loopback and forwarded-client checks to ordinary authenticated GET paths", async () => {
    const result = await childProbe({ APP_ENV: "test", DEV_AUTH_ENABLED: "true" }, "http");
    expect(result.status).toBe("http");
    const responses = result.results!;
    expect(responses.map((response) => response.status)).toEqual([200, 200, 403, 403, 403, 403]);
    expect(responses[0].identityMatch).toBe(true);
    expect(responses[0].synthetic).toBe("true");
    for (const response of responses) expect(response.cache).toContain("no-store");
    for (const response of responses.slice(2)) expect(response.code).toBe("loopback_required");
  });

  it("rejects retained synthetic cookies on every production GET without configured OIDC", async () => {
    const result = await childProbe({ APP_ENV: "production", DEV_AUTH_ENABLED: "false" }, "http");
    expect(result.status).toBe("http");
    for (const response of result.results!) {
      expect(response.status).toBe(401);
      expect(response.code).toBe("identity_provider_unconfigured");
      expect(response.identityMatch).toBe(false);
      expect(response.cache).toContain("no-store");
    }
  });

  it.each([
    {},
    { DEV_AUTH_ENABLED: "true" },
    { OIDC_ISSUER: issuer },
    { OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: "urn:estate:synthetic", OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: "http://identity.example.test", OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: "https://user:password@identity.example.test", OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: `${issuer}?tenant=other`, OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: `${issuer}#other`, OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: `${issuer}//`, OIDC_CLIENT_ID: clientId },
    { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: "" },
  ])("denies incomplete or unsafe production configuration before connection %#", async (configuration) => {
    expect(
      await childProbe({ APP_ENV: "production", DEV_AUTH_ENABLED: "false", ...configuration }, "read", {
        reader: "production",
      }),
    ).toEqual({ status: "rejected", code: "identity_provider_unconfigured", connections: 0 });
  });

  it.each([null, "not-a-session", "A".repeat(64)])(
    "checks absent provider configuration before token shape %#",
    async (suppliedToken) => {
      expect(
        await childProbe({ APP_ENV: "production", DEV_AUTH_ENABLED: "false" }, "read", {
          reader: "production",
          suppliedToken,
        }),
      ).toEqual({ status: "rejected", code: "identity_provider_unconfigured", connections: 0 });
    },
  );

  it.each(["synthetic-local", "legacy-unknown"])(
    "denies retained %s sessions with configured production OIDC",
    async (provenance) => {
      expect(
        await childProbe(production, "read", {
          reader: "production",
          suppliedToken: provenance === "synthetic-local" ? token : legacyToken,
        }),
      ).toEqual({ status: "rejected", code: "session_expired", connections: 1 });
    },
  );

  it("persists explicit synthetic, unknown legacy and verified OIDC provenance", async () => {
    for (const [value, provenance] of [
      [token, "synthetic-local"],
      [legacyToken, "legacy-unknown"],
      [oidcToken, "oidc"],
    ]) {
      const row = (
        await admin.query(
          "SELECT identity_provenance,oidc_issuer,oidc_client_id,oidc_subject FROM app.login_session WHERE token_hash=$1",
          [hashToken(value)],
        )
      ).rows[0];
      expect(row).toEqual(
        provenance === "oidc"
          ? {
              identity_provenance: provenance,
              oidc_issuer: issuer,
              oidc_client_id: clientId,
              oidc_subject: subject,
            }
          : { identity_provenance: provenance, oidc_issuer: null, oidc_client_id: null, oidc_subject: null },
      );
    }
  });

  it("accepts only the exact current verified OIDC issuer/client session", async () => {
    expect(
      await childProbe(production, "read", {
        reader: "production",
        suppliedToken: oidcToken,
        userId: oidcUser,
      }),
    ).toEqual({ status: "accepted", identityMatch: true, connections: 1 });
  });

  it.each([
    { issuer: "https://other-issuer.example.test" },
    { subject: "not-the-linked-subject" },
    { email: "not-the-verified-email@example.test" },
  ])("cannot issue an OIDC session from mismatched verified identity facts %#", async (change) => {
    const before = (
      await admin.query("SELECT count(*)::int AS count FROM app.login_session WHERE user_id=$1", [oidcUser])
    ).rows[0].count;
    await expect(
      configured(() =>
        createSession(runtime, oidcUser, fixtures.orgA, {
          identity: { ...verifiedIdentity, ...change },
          clientId,
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_link_unavailable" });
    expect(
      (await admin.query("SELECT count(*)::int AS count FROM app.login_session WHERE user_id=$1", [oidcUser]))
        .rows[0].count,
    ).toBe(before);
  });

  it("cannot issue an OIDC session for a different verified audience or linked user", async () => {
    await expect(
      configured(() =>
        createSession(runtime, oidcUser, fixtures.orgA, {
          identity: verifiedIdentity,
          clientId: "different-audience",
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_link_unavailable" });
    await expect(
      configured(() =>
        createSession(runtime, fixtures.ownerUser, fixtures.orgA, {
          identity: verifiedIdentity,
          clientId,
        }),
      ),
    ).rejects.toMatchObject({ code: "identity_link_unavailable" });
  });

  it("cannot issue an OIDC session outside the current linked user's active membership", async () => {
    await expect(
      configured(() =>
        createSession(runtime, oidcUser, fixtures.orgB, {
          identity: verifiedIdentity,
          clientId,
        }),
      ),
    ).rejects.toMatchObject({ code: "membership_required" });
  });

  it.each([{ OIDC_ISSUER: `${issuer}/other` }, { OIDC_CLIENT_ID: "another-client" }])(
    "denies retained OIDC sessions after provider configuration changes %#",
    async (change) => {
      expect(
        await childProbe({ ...production, ...change }, "read", {
          reader: "production",
          suppliedToken: oidcToken,
          userId: oidcUser,
        }),
      ).toEqual({ status: "rejected", code: "session_expired", connections: 1 });
    },
  );

  it("cannot consume an OIDC session through the synthetic reader", async () => {
    expect(
      await childProbe({ APP_ENV: "test", DEV_AUTH_ENABLED: "true" }, "read", {
        suppliedToken: oidcToken,
        userId: oidcUser,
      }),
    ).toEqual({ status: "rejected", code: "session_expired", connections: 1 });
  });

  it("keeps configured production GET private, independent of synthetic loopback rules, and dev login disabled", async () => {
    const result = await childProbe(production, "http", {
      suppliedToken: oidcToken,
      userId: oidcUser,
      includeDevelopmentLogin: true,
    });
    expect(result.status).toBe("http");
    expect(result.results!.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200, 404]);
    expect(result.results![0].identityMatch).toBe(true);
    expect(result.results![6].code).toBe("synthetic_identity_disabled");
    for (const response of result.results!) {
      expect(response.cache).toContain("no-store");
      expect(response.synthetic).toBeUndefined();
    }
  });

  it.each([
    ["token_hash", "'untrusted-replacement'"],
    ["user_id", `'${fixtures.ownerUser}'::uuid`],
    ["identity_provenance", "'legacy-unknown'"],
    ["oidc_issuer", "'https://other.example.test'"],
    ["oidc_client_id", "'other-client'"],
    ["oidc_subject", "'other-subject'"],
    ["created_at", "created_at+interval '1 hour'"],
    ["expires_at", "expires_at+interval '1 hour'"],
  ])("prevents runtime and privileged rewrites of session %s", async (column, expression) => {
    // Column/expression pairs are closed test constants, never request input.
    for (const pool of [runtime, admin]) {
      await pool.query("BEGIN");
      try {
        await pool.query("SELECT set_config('app.session_hash',$1,true)", [hashToken(oidcToken)]);
        await expect(
          pool.query(`UPDATE app.login_session SET ${column}=${expression} WHERE token_hash=$1`, [
            hashToken(oidcToken),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pool.query("ROLLBACK");
      }
    }
  });

  it.each([
    ["issuer", "https://other-identity.example.test", issuer],
    ["subject", "relinked-subject", subject],
    ["email_verified", false, true],
  ])("rejects changed current linked identity %s", async (column, changed, original) => {
    await admin.query(`UPDATE app.user_identity SET ${column}=$1 WHERE id=$2`, [changed, oidcUser]);
    try {
      expect(
        await childProbe(production, "read", {
          reader: "production",
          suppliedToken: oidcToken,
          userId: oidcUser,
        }),
      ).toEqual({ status: "rejected", code: "session_expired", connections: 1 });
    } finally {
      await admin.query(`UPDATE app.user_identity SET ${column}=$1 WHERE id=$2`, [original, oidcUser]);
    }
  });

  it("rejects revoked membership and requires current membership on each read", async () => {
    await admin.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [oidcMember]);
    try {
      expect(
        await childProbe(production, "read", {
          reader: "production",
          suppliedToken: oidcToken,
          userId: oidcUser,
        }),
      ).toEqual({ status: "rejected", code: "session_expired", connections: 1 });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE id=$1", [oidcMember]);
    }
    expect(
      (
        await childProbe(production, "read", {
          reader: "production",
          suppliedToken: oidcToken,
          userId: oidcUser,
        })
      ).status,
    ).toBe("accepted");
  });

  it("preserves synthetic organization selection under column-scoped UPDATE", async () => {
    await switchOrganization(
      runtime,
      {
        userId: fixtures.ownerUser,
        organizationId: fixtures.orgA,
        tokenHash: hashToken(token),
        csrfToken: "fixture-unused",
      },
      fixtures.orgB,
    );
    expect(
      (
        await admin.query("SELECT active_org_id FROM app.login_session WHERE token_hash=$1", [
          hashToken(token),
        ])
      ).rows[0].active_org_id,
    ).toBe(fixtures.orgB);
    await switchOrganization(
      runtime,
      {
        userId: fixtures.ownerUser,
        organizationId: fixtures.orgB,
        tokenHash: hashToken(token),
        csrfToken: "fixture-unused",
      },
      fixtures.orgA,
    );
  });

  it("denies membership revocation completed during an actual reader lock wait", async () => {
    const pid = (await runtime.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM app.membership WHERE id=$1 FOR UPDATE", [oidcMember]);
    try {
      await configured(async () => {
        const outcome = readProductionSession(runtime, oidcToken).then(
          () => "accepted",
          (error: { code?: string }) => error.code ?? "unknown",
        );
        try {
          await waitForLock(pid);
          await blocker.query("UPDATE app.membership SET status='disabled' WHERE id=$1", [oidcMember]);
          await blocker.query("COMMIT");
        } finally {
          await blocker.query("ROLLBACK");
        }
        expect(await outcome).toBe("session_expired");
      });
    } finally {
      await admin.query("UPDATE app.membership SET status='active' WHERE id=$1", [oidcMember]);
    }
  });

  it.each(["revocation", "expiry"])(
    "rechecks session %s after an actual database lock wait",
    async (scenario) => {
      const waitingToken =
        scenario === "expiry" ? await insertExpiringOidcSession() : await createOidcSession();
      const pid = (await runtime.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await blocker.query("BEGIN");
      await blocker.query("SELECT token_hash FROM app.login_session WHERE token_hash=$1 FOR UPDATE", [
        hashToken(waitingToken),
      ]);
      await configured(async () => {
        const outcome = readProductionSession(runtime, waitingToken).then(
          () => "accepted",
          (error: { code?: string }) => error.code ?? "unknown",
        );
        try {
          await waitForLock(pid);
          if (scenario === "revocation")
            await blocker.query("DELETE FROM app.login_session WHERE token_hash=$1", [
              hashToken(waitingToken),
            ]);
          else
            await blocker.query(
              "SELECT pg_sleep(GREATEST(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.1)FROM app.login_session WHERE token_hash=$1",
              [hashToken(waitingToken)],
            );
          await blocker.query("COMMIT");
        } finally {
          await blocker.query("ROLLBACK");
        }
        expect(await outcome).toBe("session_expired");
      });
    },
  );

  it("leaves no identity bootstrap context on pooled reuse", async () => {
    const context = (
      await runtime.query(
        "SELECT nullif(current_setting('app.session_hash',true),'')AS token,nullif(current_setting('app.actor_id',true),'')AS actor,nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.auth_issuer',true),'')AS issuer,nullif(current_setting('app.auth_subject',true),'')AS subject",
      )
    ).rows[0];
    expect(context).toEqual({ token: null, actor: null, tenant: null, issuer: null, subject: null });
    expect((await runtime.query("SELECT token_hash FROM app.login_session")).rowCount).toBe(0);
  });
});
