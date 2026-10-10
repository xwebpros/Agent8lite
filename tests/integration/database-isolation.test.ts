import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import { withTenantTransaction } from "../../packages/db/tenant-transaction";
import { createMigrationPool, createRuntimePool, createWorkerPool } from "../helpers/database";

const admin = createMigrationPool();
const runtime = createRuntimePool();
const worker = createWorkerPool();
let organizationIds: string[];
let actorId: string;

async function inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
      tenantId,
      actorId,
    ]);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const result = await admin.query("SELECT id FROM app.organization ORDER BY id");
  organizationIds = result.rows.map((row) => row.id);
  expect(
    organizationIds.length,
    "Run pnpm db:migrate and pnpm db:seed against the disposable local database",
  ).toBeGreaterThanOrEqual(2);
  actorId = (
    await admin.query("SELECT user_id FROM app.membership WHERE tenant_id=$1 AND status='active' LIMIT 1", [
      organizationIds[0],
    ])
  ).rows[0].user_id;
});

afterAll(async () => {
  await Promise.all([admin.end(), runtime.end(), worker.end()]);
});

describe("M1 — real PostgreSQL/PostGIS and non-bypass tenant roles", () => {
  it("runs PostgreSQL 17 with an operational PostGIS extension", async () => {
    const result = await runtime.query(
      "SELECT current_setting('server_version_num')::int version,PostGIS_Version() postgis,ST_Distance(ST_Point(0,0)::geography,ST_Point(0,1)::geography) distance",
    );
    expect(result.rows[0].version).toBeGreaterThanOrEqual(170000);
    expect(result.rows[0].version).toBeLessThan(180000);
    expect(result.rows[0].postgis).toMatch(/^3\./);
    expect(result.rows[0].distance).toBeGreaterThan(100000);
  });

  it("runtime and worker roles cannot bypass RLS, own application tables, create tables, or truncate evidence", async () => {
    const roles = await runtime.query(
      "SELECT rolname,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname IN ('estate_runtime','estate_worker',current_user)",
    );
    expect(roles.rows.map((row) => row.rolname)).toEqual(
      expect.arrayContaining(["estate_runtime", "estate_worker"]),
    );
    for (const role of roles.rows) {
      expect(role.rolsuper).toBe(false);
      expect(role.rolbypassrls).toBe(false);
      expect(role.rolcreaterole).toBe(false);
      expect(role.rolcreatedb).toBe(false);
    }
    const privilege = await runtime.query(
      "SELECT has_schema_privilege(current_user,'app','CREATE') can_create,has_table_privilege(current_user,'app.audit_event','TRUNCATE') can_truncate,has_table_privilege(current_user,'app.audit_event','UPDATE') can_update,has_table_privilege(current_user,'app.audit_event','DELETE') can_delete",
    );
    expect(privilege.rows[0]).toEqual({
      can_create: false,
      can_truncate: false,
      can_update: false,
      can_delete: false,
    });
    const owned = await runtime.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='app' AND tableowner IN ('estate_runtime','estate_worker',current_user)",
    );
    expect(owned.rows).toEqual([]);
  });

  it("forces RLS on every application table with a tenant column", async () => {
    const tables = await admin.query(
      "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id')",
    );
    expect(tables.rowCount).toBeGreaterThan(50);
    for (const table of tables.rows) {
      expect(table.relrowsecurity, table.relname).toBe(true);
      expect(table.relforcerowsecurity, table.relname).toBe(true);
    }
  });

  it("returns no CRM or identity data without context and refuses an unscoped insert", async () => {
    expect((await runtime.query("SELECT id FROM app.lead")).rows).toEqual([]);
    expect((await runtime.query("SELECT id FROM app.contact")).rows).toEqual([]);
    expect((await runtime.query("SELECT id FROM app.user_identity")).rows).toEqual([]);
    await expect(
      runtime.query(
        "INSERT INTO app.contact(tenant_id,display_name) VALUES($1,'Synthetic rejected contact')",
        [organizationIds[0]],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("restricts reads and rejects cross-tenant writes even with a legitimate tenant context", async () => {
    const adminIds = (
      await admin.query("SELECT id FROM app.lead WHERE tenant_id=$1 ORDER BY id", [organizationIds[0]])
    ).rows.map((row) => row.id);
    const visibleIds = await inTenant(organizationIds[0], async (client) =>
      (await client.query("SELECT id FROM app.lead ORDER BY id")).rows.map((row) => row.id),
    );
    expect(adminIds.length).toBeGreaterThan(0);
    expect(visibleIds).toEqual(adminIds);
    await expect(
      inTenant(organizationIds[0], async (client) =>
        client.query(
          "INSERT INTO app.contact(tenant_id,display_name) VALUES($1,'Synthetic rejected other tenant')",
          [organizationIds[1]],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("clears tenant and actor on commit and rollback before a pooled connection is reused", async () => {
    const firstPid = await inTenant(organizationIds[0], async (client) => {
      const result = await client.query(
        "SELECT pg_backend_pid() pid,app.current_tenant() tenant,app.current_actor() actor",
      );
      expect(result.rows[0]).toMatchObject({ tenant: organizationIds[0], actor: actorId });
      return result.rows[0].pid;
    });
    const unscoped = await runtime.query(
      "SELECT pg_backend_pid() pid,app.current_tenant() tenant,app.current_actor() actor",
    );
    expect(unscoped.rows[0]).toEqual({ pid: firstPid, tenant: null, actor: null });
    await expect(
      inTenant(organizationIds[1], async () => {
        throw new Error("Synthetic rollback");
      }),
    ).rejects.toThrow("Synthetic rollback");
    const reused = await runtime.query(
      "SELECT pg_backend_pid() pid,app.current_tenant() tenant,app.current_actor() actor",
    );
    expect(reused.rows[0]).toEqual({ pid: firstPid, tenant: null, actor: null });
    expect((await runtime.query("SELECT id FROM app.lead")).rows).toEqual([]);
  });

  it("the tenant transaction refuses fabricated membership before executing application work", async () => {
    let called = false;
    await expect(
      withTenantTransaction(
        runtime,
        { userId: fixtures.agentUser, organizationId: fixtures.orgB },
        async () => {
          called = true;
          return "not authorized";
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: "membership_required" });
    expect(called).toBe(false);
    const result = await runtime.query("SELECT app.current_tenant() tenant,app.current_actor() actor");
    expect(result.rows[0]).toEqual({ tenant: null, actor: null });
  });

  it("derives member and grants from active membership rather than request claims", async () => {
    const result = await withTenantTransaction(
      runtime,
      { userId: fixtures.agentUser, organizationId: fixtures.orgA },
      async (client, context) => {
        const db = await client.query("SELECT app.current_tenant() tenant,app.current_actor() actor");
        return { context, db: db.rows[0] };
      },
    );
    expect(result.context.memberId).toBe(fixtures.agentMemberA);
    expect(result.context.permissions).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "crm.leads.read", scope: "own" })]),
    );
    expect(result.db).toEqual({ tenant: fixtures.orgA, actor: fixtures.agentUser });
  });

  it("the actual worker login has tenant RLS and cannot write CRM or read browser sessions", async () => {
    expect((await worker.query("SELECT current_user username")).rows[0].username).toBe("estate_worker");
    expect((await worker.query("SELECT id FROM app.role_definition")).rows).toEqual([]);
    const scoped = await withTenantTransaction(
      worker,
      { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
      async (client) => (await client.query("SELECT tenant_id,id FROM app.role_definition")).rows,
      { lockMembership: false },
    );
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((row) => row.tenant_id === fixtures.orgA)).toBe(true);
    expect((await worker.query("SELECT id FROM app.role_definition")).rows).toEqual([]);
    await expect(worker.query("SELECT token_hash FROM app.login_session")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      worker.query(
        "INSERT INTO app.contact(tenant_id,display_name) VALUES($1,'Synthetic worker rejection')",
        [fixtures.orgA],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
