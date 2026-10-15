import pg from "pg";

export function requireIdxIsolation(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.TEST_IDX_ISOLATED !== "true") throw new Error("idx_test_isolated_harness_required");
  const migration = new URL(environment.TEST_MIGRATION_DATABASE_URL ?? "");
  const runtime = new URL(environment.TEST_DATABASE_URL ?? "");
  for (const url of [migration, runtime])
    if (
      url.protocol !== "postgresql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "54434" ||
      !/^\/estate_acceptance_[a-f0-9]{16}$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error("idx_test_disposable_database_required");
  if (
    migration.pathname !== runtime.pathname ||
    migration.username !== "postgres" ||
    runtime.username !== "estate_runtime"
  )
    throw new Error("idx_test_distinct_role_urls_required");
  const api = new URL(environment.TEST_API_ORIGIN ?? "");
  if (
    api.protocol !== "http:" ||
    api.hostname !== "127.0.0.1" ||
    !api.port ||
    ["3000", "3001"].includes(api.port)
  )
    throw new Error("idx_test_owned_api_origin_required");
  return { migration: migration.href, runtime: runtime.href, api: api.origin };
}

export function createIdxPools() {
  const target = requireIdxIsolation();
  return {
    admin: new pg.Pool({ connectionString: target.migration, max: 8 }),
    runtime: new pg.Pool({ connectionString: target.runtime, max: 8 }),
  };
}
