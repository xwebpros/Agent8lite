import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { VerifiedStaffContext } from "../../../../packages/contracts/internal/control-plane-port";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import catalog from "../../../../packages/contracts/permission-catalog.json";

const staffCodes = new Set(catalog.codes.filter((c) => c.boundary === "staff").map((c) => c.code));
const allStaffCodes = [...staffCodes];

export interface StaffPrincipalRow {
  readonly id: string;
  readonly userId: string;
  readonly permissionCodes: readonly string[];
  readonly active: boolean;
  readonly rowVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function assertManagePrincipal(staff: VerifiedStaffContext) {
  if (!staff.permissionCodes.includes("platform.orgs.provision"))
    throw new AccessError(
      403,
      "permission_denied",
      "Staff principal management requires platform.orgs.provision.",
    );
}

function validatePermissionCodes(codes: readonly string[]) {
  for (const code of codes) {
    if (!staffCodes.has(code))
      throw new AccessError(422, "permission_invalid", `Unknown staff permission code: ${code}`);
  }
}

export class StaffPrincipalService {
  constructor(
    private readonly client: PoolClient,
    private readonly staff: VerifiedStaffContext,
    private readonly traceId: string,
  ) {}

  async list(query: { limit?: string; cursor?: string }): Promise<{
    items: StaffPrincipalRow[];
    cursor: string | null;
  }> {
    assertManagePrincipal(this.staff);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const params: unknown[] = [limit + 1];
    let where = "";
    if (query.cursor) {
      where = "WHERE sp.created_at < $2";
      params.push(query.cursor);
    }
    const result = await this.client.query(
      `SELECT * FROM app.control_list_principals($1${query.cursor ? ", $2" : ""})`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = (hasMore ? result.rows.slice(0, limit) : result.rows).map(mapRow);
    return {
      items,
      cursor: hasMore ? items[items.length - 1].createdAt : null,
    };
  }

  async read(principalId: string): Promise<StaffPrincipalRow> {
    assertManagePrincipal(this.staff);
    const result = await this.client.query("SELECT * FROM app.control_read_principal($1)", [principalId]);
    if (!result.rowCount) throw new AccessError(404, "principal_not_found", "Staff principal not found.");
    return mapRow(result.rows[0]);
  }

  async create(
    userId: string,
    permissionCodes: readonly string[],
    idempotencyKey: string,
  ): Promise<StaffPrincipalRow> {
    assertManagePrincipal(this.staff);
    if (userId === this.staff.userId)
      throw new AccessError(
        422,
        "self_modification_denied",
        "Cannot create a staff principal for your own user account.",
      );
    validatePermissionCodes(permissionCodes);
    if (!idempotencyKey)
      throw new AccessError(400, "idempotency_required", "An idempotency key is required.");
    await this.assertNotUnrestrictedSelfApproval(permissionCodes);

    try {
      const result = await this.client.query("SELECT * FROM app.control_create_principal($1, $2)", [
        userId,
        permissionCodes,
      ]);
      await this.audit("staff_principal.create", result.rows[0].id, {
        permissionCodes,
        targetUserId: userId,
      });
      return mapRow(result.rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("principal_exists"))
        throw new AccessError(409, "principal_exists", "A staff principal already exists for this user.");
      if (msg.includes("self_modification_denied"))
        throw new AccessError(
          422,
          "self_modification_denied",
          "Cannot create a staff principal for your own user account.",
        );
      throw err;
    }
  }

  async update(
    principalId: string,
    body: { permissionCodes?: readonly string[]; active?: boolean },
    expectedVersion: string,
  ): Promise<StaffPrincipalRow> {
    assertManagePrincipal(this.staff);
    if (body.permissionCodes) validatePermissionCodes(body.permissionCodes);
    if (body.permissionCodes) await this.assertNotUnrestrictedSelfApproval(body.permissionCodes);

    try {
      const result = await this.client.query("SELECT * FROM app.control_update_principal($1, $2, $3, $4)", [
        principalId,
        body.permissionCodes ?? null,
        body.active ?? null,
        BigInt(expectedVersion),
      ]);
      await this.audit("staff_principal.update", principalId, {
        permissionCodes: body.permissionCodes,
        active: body.active,
      });
      return mapRow(result.rows[0]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("self_modification_denied"))
        throw new AccessError(422, "self_modification_denied", "Cannot modify your own staff principal.");
      if (msg.includes("version_conflict"))
        throw new AccessError(409, "version_conflict", "Staff principal was modified by another request.");
      if (msg.includes("principal_not_found"))
        throw new AccessError(404, "principal_not_found", "Staff principal not found.");
      throw err;
    }
  }

  async deactivate(principalId: string, expectedVersion: string): Promise<StaffPrincipalRow> {
    return this.update(principalId, { active: false }, expectedVersion);
  }

  private async assertNotUnrestrictedSelfApproval(codes: readonly string[]) {
    const isUnrestricted = allStaffCodes.every((c) => codes.includes(c));
    if (!isUnrestricted) return;
    const others = await this.client.query(
      `SELECT count(*)::int AS n FROM app.control_list_principals(100)
       WHERE user_id != $1 AND active AND 'platform.orgs.provision' = ANY(permission_codes)`,
      [this.staff.userId],
    );
    if ((others.rows[0]?.n ?? 0) < 1)
      throw new AccessError(
        422,
        "unrestricted_requires_second_administrator",
        "Granting unrestricted staff access requires at least one other active administrator who can review the grant.",
      );
  }

  private async audit(action: string, principalId: string, detail: unknown) {
    const commandDigest = createHash("sha256")
      .update(JSON.stringify({ action, principalId, detail }))
      .digest("hex");
    await this.client.query(
      `INSERT INTO app.control_command_audit(
        staff_user_id, staff_principal_id, principal_version,
        session_binding, action, command_digest, trace_id
      ) VALUES($1, $2, $3, app.control_command_session_binding(), $4, $5, $6)`,
      [
        this.staff.userId,
        this.staff.staffPrincipalId,
        this.staff.principalVersion,
        action,
        commandDigest,
        this.traceId,
      ],
    );
  }
}

function mapRow(row: Record<string, unknown>): StaffPrincipalRow {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    permissionCodes: row.permission_codes as string[],
    active: row.active as boolean,
    rowVersion: String(row.row_version),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
