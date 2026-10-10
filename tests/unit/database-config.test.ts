import { describe, expect, it } from "vitest";
import { databaseConnectionString } from "../../packages/db/pool";

describe("M1 — explicit database identity configuration", () => {
  it.each(["runtime", "migration"] as const)(
    "requires an explicit %s URL without enabled synthetic mode",
    (kind) => {
      for (const environment of [
        {},
        { APP_ENV: "production", DEV_AUTH_ENABLED: "true" },
        { APP_ENV: "test" },
        { APP_ENV: "development", DEV_AUTH_ENABLED: "false" },
        { APP_ENV: "staging", DEV_AUTH_ENABLED: "true" },
        { APP_ENV: "test", DEV_AUTH_ENABLED: "TRUE" },
      ]) {
        expect(() => databaseConnectionString(kind, environment)).toThrow("Explicit");
      }
    },
  );

  it.each(["development", "test"])(
    "permits loopback fixture fallback only in explicitly enabled %s mode",
    (mode) => {
      const environment = { APP_ENV: mode, DEV_AUTH_ENABLED: "true" };
      const runtime = new URL(databaseConnectionString("runtime", environment));
      const migration = new URL(databaseConnectionString("migration", environment));
      expect(runtime.hostname).toBe("127.0.0.1");
      expect(migration.hostname).toBe("127.0.0.1");
      expect(runtime.port).toBe("55432");
      expect(runtime.username).toBe("estate_runtime");
      expect(migration.username).toBe("postgres");
      expect(runtime.href).not.toBe(migration.href);
    },
  );

  it("uses separately configured identities in production without enabling synthetic fallback", () => {
    const environment = {
      APP_ENV: "production",
      DATABASE_URL: "postgresql://runtime:synthetic-runtime-password@db.example.test/application",
      MIGRATION_DATABASE_URL: "postgres://migration:synthetic-migration-password@db.example.test/application",
    };
    expect(databaseConnectionString("runtime", environment)).toBe(environment.DATABASE_URL);
    expect(databaseConnectionString("migration", environment)).toBe(environment.MIGRATION_DATABASE_URL);
    expect(() =>
      databaseConnectionString("runtime", { MIGRATION_DATABASE_URL: environment.MIGRATION_DATABASE_URL }),
    ).toThrow("Explicit DATABASE_URL required.");
    expect(() => databaseConnectionString("migration", { DATABASE_URL: environment.DATABASE_URL })).toThrow(
      "Explicit MIGRATION_DATABASE_URL required.",
    );
  });

  it("fails closed for malformed configured URLs instead of silently selecting fixture credentials", () => {
    for (const value of [
      "not-a-url",
      "https://runtime:private-password@example.test/database",
      "file:///database",
    ]) {
      for (const kind of ["runtime", "migration"] as const) {
        const key = kind === "runtime" ? "DATABASE_URL" : "MIGRATION_DATABASE_URL";
        const configure = () =>
          databaseConnectionString(kind, { APP_ENV: "test", DEV_AUTH_ENABLED: "true", [key]: value });
        expect(configure).toThrow(`${key} must be a valid PostgreSQL URL.`);
        try {
          configure();
        } catch (error) {
          expect(String(error)).not.toContain("private-password");
        }
      }
    }
  });

  it("allows migration-only configuration without constructing or configuring a runtime pool", () => {
    const url = "postgresql://migration:synthetic-only@127.0.0.1:55432/application";
    expect(databaseConnectionString("migration", { MIGRATION_DATABASE_URL: ` ${url} ` })).toBe(url);
    expect(() => databaseConnectionString("runtime", { MIGRATION_DATABASE_URL: url })).toThrow(
      "Explicit DATABASE_URL required.",
    );
  });
});
