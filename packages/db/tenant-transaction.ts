import type { Pool, PoolClient } from "pg";

export type PermissionGrant = { code: string; scope: "own" | "team" | "organization" };
export type VerifiedIdentityContext = { userId: string; organizationId: string };
export type TenantContext = VerifiedIdentityContext & {
  memberId: string;
  roleId: string;
  roleName: string;
  permissions: PermissionGrant[];
  timezone: string;
};

export class AccessError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function withTenantTransaction<T>(
  pool: Pool,
  identity: VerifiedIdentityContext,
  operation: (client: PoolClient, context: TenantContext) => Promise<T>,
  options: { lockOrganization?: boolean; lockMembership?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true)", [
      identity.userId,
      identity.organizationId,
    ]);
    if (options.lockOrganization)
      await client.query("SELECT id FROM app.organization WHERE id=$1 FOR UPDATE", [identity.organizationId]);
    const membership = await client.query(
      `SELECT m.id,m.role_id,r.name,r.permission_grants,o.timezone FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id) JOIN app.organization o ON o.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active' AND o.status='active' ${options.lockMembership === false ? "" : "FOR SHARE OF m,r,o"}`,
      [identity.organizationId, identity.userId],
    );
    if (!membership.rowCount)
      throw new AccessError(403, "membership_required", "Active organization membership required.");
    const row = membership.rows[0];
    const context: TenantContext = {
      ...identity,
      memberId: row.id,
      roleId: row.role_id,
      roleName: row.name,
      permissions: row.permission_grants,
      timezone: row.timezone,
    };
    const result = await operation(client, context);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function requirePermission(context: TenantContext, code: string) {
  const grant = context.permissions.find((permission) => permission.code === code);
  if (!grant) throw new AccessError(403, "permission_denied", "Permission denied.");
  return grant.scope;
}
