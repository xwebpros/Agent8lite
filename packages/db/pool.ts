import { Pool } from "pg";

export { assertRuntimeRole, RuntimeRoleError } from "./runtime-role";

export function databaseConnectionString(
  kind: "runtime" | "migration",
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const configured = environment[kind === "runtime" ? "DATABASE_URL" : "MIGRATION_DATABASE_URL"];
  if (configured?.trim()) {
    try {
      const url = new URL(configured);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
      return configured.trim();
    } catch {
      throw new Error(
        kind === "runtime"
          ? "DATABASE_URL must be a valid PostgreSQL URL."
          : "MIGRATION_DATABASE_URL must be a valid PostgreSQL URL.",
      );
    }
  }
  const synthetic =
    ["development", "test"].includes(environment.APP_ENV ?? "") && environment.DEV_AUTH_ENABLED === "true";
  if (synthetic)
    return kind === "runtime"
      ? "postgresql://estate_runtime:local-runtime-only@127.0.0.1:55432/estate"
      : "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate";
  throw new Error(
    kind === "runtime" ? "Explicit DATABASE_URL required." : "Explicit MIGRATION_DATABASE_URL required.",
  );
}

let runtime: Pool | undefined;
export function getRuntimePool() {
  runtime ??= new Pool({
    connectionString: databaseConnectionString("runtime"),
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return runtime;
}
export async function closeRuntimePool() {
  const existing = runtime;
  runtime = undefined;
  if (existing) await existing.end();
}
// Migration-only tools can import migrationPool without configuring an unused runtime identity.
// Any runtime pool operation constructs and validates the actual pool before accessing PostgreSQL.
export const runtimePool: Pool = new Proxy({} as Pool, {
  get(_target, property) {
    const pool = getRuntimePool();
    const value = Reflect.get(pool, property, pool);
    return typeof value === "function" ? value.bind(pool) : value;
  },
});

export function migrationPool() {
  return new Pool({
    connectionString: databaseConnectionString("migration"),
    max: 1,
  });
}
