import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import {
  AccessError,
  requirePermission,
  type TenantContext,
} from "../../../../packages/db/tenant-transaction";
import { workflowJson } from "./workflow-json";

/** Current member/role/org and capability checks, using the caller's verified transaction. */
export class WorkflowAuthority {
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
  ) {}

  async require(permission: string) {
    if (requirePermission(this.context, permission) !== "organization")
      throw new AccessError(403, "permission_denied", "Organization workflow source scope is required.");
    const result = await this.client.query(
      `SELECT 1 FROM app.membership m
       JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE current_user='estate_runtime' AND app.current_tenant()=$1::uuid
       AND app.current_actor()=$2::uuid AND m.tenant_id=$1 AND m.user_id=$2
       AND m.id=$3 AND m.role_id=$4 AND m.status='active' AND o.status='active'
       AND r.permission_grants @> $5::jsonb`,
      [
        this.context.organizationId,
        this.context.userId,
        this.context.memberId,
        this.context.roleId,
        workflowJson([{ code: permission, scope: "organization" }]),
      ],
    );
    if (!result.rowCount)
      throw new AccessError(403, "permission_denied", "Current workflow source authority is unavailable.");
    await requireEntitlement(this.client, permission);
    await requireEntitlement(this.client, permission, { lock: false });
  }
}
