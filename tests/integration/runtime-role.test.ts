import { randomBytes } from "node:crypto";
import pg, { type Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { assertRuntimeRole, RuntimeRoleError } from "../../packages/db/runtime-role";
import {
  createMigrationPool,
  createRuntimePool,
  createWorkerPool,
  migrationDatabaseUrl,
} from "../helpers/database";

const admin = createMigrationPool();
const runtime = createRuntimePool();
const worker = createWorkerPool();
const roles: string[] = [];
const relations: string[] = [];
const pools: Pool[] = [admin, runtime, worker];
const prefix = `startup_probe_${randomBytes(8).toString("hex")}`;

function identifier(name: string) {
  if (!new RegExp(`^${prefix}_[a-z0-9_]+$`).test(name)) throw new Error("Unowned startup fixture.");
  return `"${name}"`;
}

async function role(attributes: "safe" | "bypass" | "super" = "safe") {
  const name = `${prefix}_role_${roles.length}`;
  const password = randomBytes(24).toString("hex");
  await admin.query(
    `CREATE ROLE ${identifier(name)} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE ${attributes === "super" ? "SUPERUSER" : "NOSUPERUSER"} ${attributes === "bypass" ? "BYPASSRLS" : "NOBYPASSRLS"} PASSWORD '${password}'`,
  );
  roles.push(name);
  const url = new URL(migrationDatabaseUrl);
  url.username = name;
  url.password = password;
  const pool = new pg.Pool({ connectionString: url.href, max: 1 });
  pools.push(pool);
  return { name, pool };
}

async function ownedTable(owner: string) {
  const name = `${prefix}_relation_${relations.length}`;
  await admin.query(`CREATE TABLE app.${identifier(name)} (id integer)`);
  relations.push(name);
  await admin.query(`ALTER TABLE app.${identifier(name)} OWNER TO ${identifier(owner)}`);
  return name;
}

async function ancestry(privileged: string) {
  const middle = await role();
  const login = await role();
  await admin.query(`GRANT ${identifier(privileged)} TO ${identifier(middle.name)} WITH INHERIT FALSE`);
  await admin.query(`GRANT ${identifier(middle.name)} TO ${identifier(login.name)} WITH INHERIT FALSE`);
  const access = await login.pool.query(
    "SELECT current_user username,pg_has_role(current_user,$1,'MEMBER') reachable,pg_has_role(current_user,$1,'USAGE') inherited",
    [privileged],
  );
  expect(access.rows[0]).toEqual({ username: login.name, reachable: true, inherited: false });
  return login.pool;
}

async function rejectsUnsafe(pool: Pool) {
  await expect(assertRuntimeRole(pool)).rejects.toBeInstanceOf(RuntimeRoleError);
  await expect(assertRuntimeRole(pool)).rejects.toMatchObject({ code: "database_runtime_role_unsafe" });
}

afterAll(async () => {
  // Only exact generated fixtures are removed. Never change estate_runtime/worker memberships.
  await Promise.all(pools.filter((pool) => pool !== admin).map((pool) => pool.end()));
  try {
    for (const name of [...relations].reverse()) await admin.query(`DROP TABLE app.${identifier(name)}`);
    for (const name of [...roles].reverse()) await admin.query(`DROP ROLE ${identifier(name)}`);
  } finally {
    await admin.end();
  }
});

describe("M1 — fail-closed startup verification of actual PostgreSQL identities", () => {
  it("accepts the genuine non-owner runtime and worker logins", async () => {
    expect((await runtime.query("SELECT current_user username")).rows[0].username).toBe("estate_runtime");
    expect((await worker.query("SELECT current_user username")).rows[0].username).toBe("estate_worker");
    await expect(assertRuntimeRole(runtime)).resolves.toBeUndefined();
    await expect(assertRuntimeRole(worker)).resolves.toBeUndefined();
  });

  it("accepts a non-owner identity with only safe NOINHERIT ancestors", async () => {
    const parent = await role();
    const login = await ancestry(parent.name);
    await expect(assertRuntimeRole(login)).resolves.toBeUndefined();
  });

  it("rejects the migration administrator instead of accepting its configured URL as runtime proof", async () => {
    expect((await admin.query("SELECT current_user username")).rows[0].username).toBe("postgres");
    await rejectsUnsafe(admin);
  });

  it("rejects an administrator session masked by SET ROLE estate_runtime", async () => {
    const masked = new pg.Pool({ connectionString: migrationDatabaseUrl, max: 1 });
    pools.push(masked);
    await masked.query("SET ROLE estate_runtime");
    const identity = await masked.query("SELECT current_user current_identity,session_user login_identity");
    expect(identity.rows[0]).toEqual({ current_identity: "estate_runtime", login_identity: "postgres" });
    await rejectsUnsafe(masked);
  });

  it("rejects direct application-table ownership despite NOSUPERUSER and NOBYPASSRLS", async () => {
    const owner = await role();
    const table = await ownedTable(owner.name);
    const identity = await owner.pool.query(
      "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
    );
    expect(identity.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(
      (await admin.query("SELECT tableowner FROM pg_tables WHERE schemaname='app' AND tablename=$1", [table]))
        .rows[0].tableowner,
    ).toBe(owner.name);
    await rejectsUnsafe(owner.pool);
  });

  it("rejects application-table ownership reachable through two NOINHERIT grants", async () => {
    const owner = await role();
    await ownedTable(owner.name);
    await rejectsUnsafe(await ancestry(owner.name));
  });

  it("rejects direct BYPASSRLS and a BYPASSRLS ancestor even when privileges are not inherited", async () => {
    const privileged = await role("bypass");
    await rejectsUnsafe(privileged.pool);
    await rejectsUnsafe(await ancestry(privileged.name));
  });

  it("rejects direct superuser and a superuser ancestor even when privileges are not inherited", async () => {
    const privileged = await role("super");
    await rejectsUnsafe(privileged.pool);
    await rejectsUnsafe(await ancestry(privileged.name));
  });
});
