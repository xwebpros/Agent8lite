import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import type { CmsProfileReferencePort } from "../../../packages/contracts/internal/profile-reference-port";
import { AccessError, type TenantContext } from "../../../packages/db/tenant-transaction";

/** The caller owns BEGIN/COMMIT and current membership locks. No profile fields cross this port. */
export function createCmsProfileReferencePort(
  client: PoolClient,
  context: TenantContext,
): CmsProfileReferencePort {
  return {
    async requireActiveReference(profileId) {
      const permission = context.permissions.find(
        (grant) =>
          grant.scope === "organization" &&
          ["sites.read", "sites.write", "content.read", "content.write"].includes(grant.code),
      );
      if (!permission)
        throw new AccessError(403, "permission_denied", "Organization CMS permission is required.");
      await requireEntitlement(client, permission.code);
      // The present administration schema has no archive state. Eligibility means a current,
      // existing tenant row; adding archive semantics requires an explicit administration change.
      const result = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id,tenant_id FROM app.business_profile WHERE id=$1 AND tenant_id=$2
          AND tenant_id=app.current_tenant() AND app.current_actor()=$3 FOR SHARE`,
        [profileId, context.organizationId, context.userId],
      );
      if (!result.rowCount)
        throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
      // Time can expire while the source lock blocks even though capability state is locked.
      await requireEntitlement(client, permission.code);
      return { id: result.rows[0].id, organizationId: result.rows[0].tenant_id };
    },
  };
}
