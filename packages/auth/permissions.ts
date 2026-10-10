import catalog from "../contracts/permission-catalog.json";
import { AccessError, type PermissionGrant, type TenantContext } from "../db/tenant-transaction";

export function assertDelegation(caller: TenantContext, grants: PermissionGrant[]) {
  const rank = { own: 1, team: 2, organization: 3 };
  if (new Set(grants.map((grant) => grant.code)).size !== grants.length)
    throw new AccessError(422, "permission_duplicate", "A permission may appear once per role.");
  for (const grant of grants) {
    const definition = catalog.codes.find((code) => code.code === grant.code);
    const held = caller.permissions.find((permission) => permission.code === grant.code);
    if (
      !definition ||
      !definition.delegatable ||
      definition.boundary !== "member" ||
      !(definition.scopes as string[]).includes(grant.scope)
    )
      throw new AccessError(
        422,
        "permission_invalid",
        "Only registered delegatable member permissions are permitted.",
      );
    if (!held || rank[grant.scope] > rank[held.scope])
      throw new AccessError(
        403,
        "delegation_denied",
        "Cannot delegate permissions or scope beyond your own.",
      );
  }
}
