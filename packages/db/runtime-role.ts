import type { Pool } from "pg";

export class RuntimeRoleError extends Error {
  readonly code = "database_runtime_role_unsafe";
  constructor() {
    super("The runtime database identity must not own application tables or reach privileged roles.");
  }
}

/** Verify PostgreSQL role invariants before a runtime service accepts requests. */
export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const result = await pool.query<{ unsafe: boolean }>(`
    WITH RECURSIVE reachable AS (
      SELECT oid,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN(current_user,session_user)
      UNION
      SELECT granted.oid,granted.rolsuper,granted.rolbypassrls
      FROM pg_roles granted JOIN pg_auth_members membership ON membership.roleid=granted.oid
      JOIN reachable member_role ON membership.member=member_role.oid
    )
    SELECT (
      NOT EXISTS(SELECT 1 FROM reachable)
      OR EXISTS(SELECT 1 FROM reachable WHERE rolsuper OR rolbypassrls)
      OR EXISTS(
        SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='app' AND relation.relkind IN ('r','p','f','m','v')
          AND relation.relowner IN(SELECT oid FROM reachable)
      )
    ) AS unsafe
  `);
  if (result.rows.length !== 1 || result.rows[0].unsafe !== false) throw new RuntimeRoleError();
}
