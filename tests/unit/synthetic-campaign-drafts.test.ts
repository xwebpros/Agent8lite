import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn(),
    release = vi.fn(),
    end = vi.fn(),
    connect = vi.fn();
  const Pool = vi.fn(function () {
    return { connect, end };
  });
  return { query, release, end, connect, Pool };
});
vi.mock("pg", () => ({ Pool: mocks.Pool }));

type Environment = Record<string, string | undefined>;
let target: (environment: Environment) => string;
let enable: (environment: Environment) => Promise<{ created: number; currentlyEnabled: number }>;
const environment = (changes: Environment = {}): Environment => ({
  APP_ENV: "test",
  DEV_AUTH_ENABLED: "true",
  SYNTHETIC_CAMPAIGN_DRAFTS_ENABLED: "true",
  MIGRATION_DATABASE_URL: "postgresql://postgres:synthetic-migration-only@127.0.0.1:55432/estate",
  ...changes,
});

beforeAll(async () => {
  // The script's module guard must permit importing validation without executing its CLI.
  const specifier: string = "../../scripts/enable-synthetic-campaign-drafts.mjs";
  const script = await import(specifier);
  target = script.campaignFixtureTarget;
  enable = script.enableSyntheticCampaignDrafts;
  expect(mocks.Pool).not.toHaveBeenCalled();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.end.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockImplementation(async (sql: string) => {
    if (
      sql.includes("FROM pg_class") ||
      sql.includes("public.estate_migration") ||
      sql.includes("FROM app.organization o")
    )
      return { rows: [], rowCount: 1 };
    if (sql.includes("INSERT INTO app.entitlement")) return { rows: [], rowCount: 2 };
    if (sql.includes("count(*)::int AS enabled")) return { rows: [{ enabled: 2 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe("explicit opt-in synthetic campaign draft setup", () => {
  it("imports with actual Node tsx module linkage and rejects disabled activation before connecting", () => {
    const scriptUrl = pathToFileURL(resolve("scripts/enable-synthetic-campaign-drafts.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type",
        "module",
        "--eval",
        `const script = await import(${JSON.stringify(scriptUrl)});
         if (typeof script.campaignFixtureTarget !== "function" || typeof script.enableSyntheticCampaignDrafts !== "function")
           throw new Error("Setup exports unavailable.");
         try {
           await script.enableSyntheticCampaignDrafts();
           throw new Error("Disabled activation unexpectedly succeeded.");
         } catch (error) {
           if (error.message !== "Campaign draft fixtures require explicitly enabled synthetic local mode and opt-in.") throw error;
           process.stdout.write("MODULE_LINKAGE_AND_DISABLED_GUARD_PASSED");
         }`,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          APP_ENV: "development",
          DEV_AUTH_ENABLED: "true",
          SYNTHETIC_CAMPAIGN_DRAFTS_ENABLED: "false",
          MIGRATION_DATABASE_URL: "not-a-connection-url",
          NODE_OPTIONS: "",
        },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65_536,
        windowsHide: true,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("MODULE_LINKAGE_AND_DISABLED_GUARD_PASSED");
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it.each(["development", "test"])(
    "accepts only explicitly enabled %s mode with opt-in and the selected loopback fixture target",
    (mode) => {
      const value = target(environment({ APP_ENV: mode }));
      expect(new URL(value).hostname).toBe("127.0.0.1");
      expect(new URL(value).pathname).toBe("/estate");
      expect(mocks.Pool).not.toHaveBeenCalled();
    },
  );

  it("permits its documented local migration fallback only after all three explicit gates", () => {
    const value = target(environment({ MIGRATION_DATABASE_URL: undefined }));
    expect(new URL(value).username).toBe("postgres");
    expect(new URL(value).pathname).toBe("/estate");
    expect(new URL(value).hostname).toBe("127.0.0.1");
  });

  it.each([undefined, "", "production", "staging", "TEST", "Development", "true"])(
    "fails closed for unapproved APP_ENV %s even when NODE_ENV suggests development",
    (mode) => {
      expect(() => target(environment({ APP_ENV: mode, NODE_ENV: "development" }))).toThrow(
        "explicitly enabled synthetic local mode",
      );
    },
  );

  it.each(["DEV_AUTH_ENABLED", "SYNTHETIC_CAMPAIGN_DRAFTS_ENABLED"])(
    "requires a literal true for %s rather than a truthy flag",
    (name) => {
      for (const value of [undefined, "", "false", "1", "TRUE", " true "])
        expect(() => target(environment({ [name]: value }))).toThrow(
          "explicitly enabled synthetic local mode",
        );
    },
  );

  it.each([
    "postgresql://postgres:synthetic@localhost:55432/estate",
    "postgres://postgres:synthetic@[::1]:55432/estate",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate_acceptance_0123456789abcdef",
  ])("accepts canonical loopback development or exact disposable targets: %s", (url) => {
    expect(target(environment({ MIGRATION_DATABASE_URL: url }))).toBe(new URL(url).href);
  });

  it.each([
    "not a URL",
    "https://postgres:synthetic@127.0.0.1/estate",
    "postgresql://postgres:synthetic@198.51.100.23:55432/estate",
    "postgresql://postgres:synthetic@127.0.0.2:55432/estate",
    "postgresql://postgres:synthetic@database.invalid:55432/estate",
    "postgresql://postgres:synthetic@127.0.0.1:55432/customer_database",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate_acceptance_0123456789abcde",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate_acceptance_0123456789ABCDEF",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate/extra",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate?host=198.51.100.23",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate?user=estate_runtime",
    "postgresql://postgres:synthetic@127.0.0.1:55432/estate#secret",
    "postgresql://127.0.0.1:55432/estate",
  ])("rejects remote arbitrary or query-overridden database configuration: %s", (url) => {
    expect(() => target(environment({ MIGRATION_DATABASE_URL: url }))).toThrow();
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it.each([
    "estate_runtime",
    "estate_worker",
    "estate_control",
    "estate_staff_issuer",
    "%65state_runtime",
    "estate%5fworker",
    "estate_%63ontrol",
    "estate_staff_%69ssuer",
    "bad%zz",
  ])("rejects forbidden or malformed migration identity before connecting: %s", (username) => {
    expect(() =>
      target(
        environment({ MIGRATION_DATABASE_URL: `postgresql://${username}:synthetic@127.0.0.1:55432/estate` }),
      ),
    ).toThrow();
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it("does not include invalid connection credentials in validation errors or construct a pool on a disabled call", async () => {
    const secret = "PRIVATE_SYNTHETIC_CREDENTIAL_MARKER";
    try {
      target(
        environment({ MIGRATION_DATABASE_URL: `postgresql://postgres:${secret}@remote.invalid/estate` }),
      );
      throw new Error("Unapproved target was accepted.");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("remote.invalid");
    }
    await expect(enable(environment({ SYNTHETIC_CAMPAIGN_DRAFTS_ENABLED: "false" }))).rejects.toThrow(
      "explicitly enabled synthetic local mode",
    );
    expect(mocks.Pool).not.toHaveBeenCalled();
  });

  it("verifies migration identity migration readiness and both source fixtures before committing any capability", async () => {
    expect(await enable(environment())).toEqual({ created: 2, currentlyEnabled: 2 });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql));
    const insert = statements.findIndex((sql) => sql.includes("INSERT INTO app.entitlement"));
    expect(statements.slice(0, insert).filter((sql) => sql.includes("FROM app.organization o"))).toHaveLength(
      2,
    );
    expect(statements.slice(0, insert).some((sql) => sql.includes("public.estate_migration"))).toBe(true);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it.each(["identity", "migration", "second fixture"])(
    "rolls back and never inserts a capability after denied %s evidence",
    async (failure) => {
      let fixtures = 0;
      const original = mocks.query.getMockImplementation()!;
      mocks.query.mockImplementation(async (sql: string, ...values: unknown[]) => {
        if (
          (failure === "identity" && sql.includes("FROM pg_class")) ||
          (failure === "migration" && sql.includes("public.estate_migration")) ||
          (failure === "second fixture" && sql.includes("FROM app.organization o") && ++fixtures === 2)
        )
          return { rows: [], rowCount: 0 };
        return original(sql, ...values);
      });
      await expect(enable(environment())).rejects.toThrow();
      expect(
        mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO app.entitlement")),
      ).toBe(false);
      expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
      expect(mocks.release).toHaveBeenCalledOnce();
      expect(mocks.end).toHaveBeenCalledOnce();
    },
  );

  it("reports retained unavailable capability instead of issuing update renewal or delete commands", async () => {
    const original = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (sql: string, ...values: unknown[]) => {
      if (sql.includes("INSERT INTO app.entitlement")) return { rows: [], rowCount: 0 };
      if (sql.includes("count(*)::int AS enabled")) return { rows: [{ enabled: 0 }], rowCount: 1 };
      return original(sql, ...values);
    });
    expect(await enable(environment())).toEqual({ created: 0, currentlyEnabled: 0 });
    const writes = mocks.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/ON CONFLICT\(tenant_id,feature\) DO NOTHING/);
    expect(writes[0]).not.toMatch(/\b(?:UPDATE|DELETE)\b/i);
  });

  it("bounds connection setup and ends the pool if acquisition fails before a client exists", async () => {
    const denied = new Error("Synthetic authentication failed");
    mocks.connect.mockRejectedValueOnce(denied);
    await expect(enable(environment())).rejects.toBe(denied);
    expect(mocks.Pool).toHaveBeenCalledWith(
      expect.objectContaining({ max: 1, connectionTimeoutMillis: 5000 }),
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("preserves an execution failure while releasing the client and pool even if rollback itself fails", async () => {
    const failure = new Error("Synthetic transaction failure");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") throw failure;
      if (sql === "ROLLBACK") throw new Error("Synthetic rollback failed");
      return { rows: [], rowCount: 0 };
    });
    await expect(enable(environment())).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
