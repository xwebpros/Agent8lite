import type { PoolClient } from "pg";
import { AccessError } from "../db/tenant-transaction";

// Foundation access remains available to manage a suspended commercial capability.
export async function requireEntitlement(
  client: PoolClient,
  permission: string,
  options: { lock?: boolean } = {},
) {
  const feature =
    permission.startsWith("crm.") || permission === "dashboard.read"
      ? "crm"
      : permission.startsWith("mls.")
        ? "mls"
        : permission.startsWith("billing.")
          ? "billing"
          : permission.startsWith("content.") || permission.startsWith("sites.")
            ? "websites"
            : permission.startsWith("campaigns.") || permission.startsWith("automations.")
              ? "marketing"
              : permission.startsWith("ai.")
                ? "ai"
                : null;
  if (!feature) return;
  const result = await client.query(
    `SELECT id FROM app.entitlement WHERE tenant_id=app.current_tenant() AND feature=$1 AND state='enabled' AND (effective_until IS NULL OR effective_until>now()) ${options.lock === false ? "" : "FOR SHARE"}`,
    [feature],
  );
  if (!result.rowCount)
    throw new AccessError(
      403,
      "entitlement_disabled",
      "This organization does not have an active capability for this operation.",
    );
}
