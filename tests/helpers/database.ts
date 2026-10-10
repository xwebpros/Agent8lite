import pg from "pg";

export const migrationDatabaseUrl =
  process.env.TEST_MIGRATION_DATABASE_URL ??
  process.env.MIGRATION_DATABASE_URL ??
  "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate";
export const runtimeDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://estate_runtime:local-runtime-only@127.0.0.1:55432/estate";
export const workerDatabaseUrl =
  process.env.TEST_WORKER_DATABASE_URL ??
  process.env.WORKER_DATABASE_URL ??
  "postgresql://estate_worker:local-worker-only@127.0.0.1:55432/estate";
export const createMigrationPool = () => new pg.Pool({ connectionString: migrationDatabaseUrl, max: 1 });
export const createRuntimePool = () => new pg.Pool({ connectionString: runtimeDatabaseUrl, max: 1 });
export const createWorkerPool = () => new pg.Pool({ connectionString: workerDatabaseUrl, max: 1 });
