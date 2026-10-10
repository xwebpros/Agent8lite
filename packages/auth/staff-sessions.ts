import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  StaffSessionIssuerPort,
  SyntheticStaffSessionResponse,
  VerifiedStaffContext,
} from "../contracts/internal/control-plane-port";
import { requireSyntheticStaffMode } from "../db/staff-pools";
import { AccessError } from "../db/tenant-transaction";
import type { VerifiedOidcIdentity } from "../providers/identity/port";
import catalog from "../contracts/permission-catalog.json";

export const staffSessionCookie = "estate_staff_session";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type StaffSession = VerifiedStaffContext & { readonly csrfToken: string; readonly expiresAt: string };
export class StaffSessionIssuer implements StaffSessionIssuerPort {
  constructor(private readonly pool: Pool) {}
  async issueVerifiedIdentity(identity: VerifiedOidcIdentity) {
    requireSyntheticStaffMode();
    if (
      identity.issuer !== "urn:estate:synthetic" ||
      !["staff-administrator", "staff-support"].includes(identity.subject) ||
      identity.emailVerified !== true ||
      !Number.isFinite(identity.authenticatedAt) ||
      identity.authenticatedAt > Date.now() / 1000 + 30 ||
      identity.authenticatedAt < Date.now() / 1000 - 300
    )
      throw new AccessError(401, "staff_identity_unavailable", "Verified staff identity is unavailable.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.auth_issuer',$1,true),set_config('app.auth_subject',$2,true)",
        [identity.issuer, identity.subject],
      );
      const identityRow = await client.query(
        "SELECT id FROM app.user_identity WHERE issuer=$1 AND subject=$2 AND email_verified",
        [identity.issuer, identity.subject],
      );
      if (identityRow.rowCount !== 1)
        throw new AccessError(401, "staff_identity_unavailable", "Verified staff identity is unavailable.");
      await client.query("SELECT set_config('app.actor_id',$1,true)", [identityRow.rows[0].id]);
      const principal = await client.query(
        "SELECT id FROM app.staff_principal WHERE user_id=$1 AND active FOR SHARE",
        [identityRow.rows[0].id],
      );
      if (principal.rowCount !== 1)
        throw new AccessError(403, "staff_principal_required", "Active staff principal required.");
      const stamp = (
        await client.query("SELECT clock_timestamp() created,(clock_timestamp()+interval '8 hours') expires")
      ).rows[0];
      const opaqueToken = randomBytes(32).toString("hex"),
        csrfToken = randomBytes(32).toString("hex");
      // One timestamp determines both values; INSERT-only issuer never reads or returns session rows.
      await client.query(
        "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,'synthetic-local',$4,$4::timestamptz+interval '8 hours')",
        [hash(opaqueToken), identityRow.rows[0].id, csrfToken, stamp.created],
      );
      requireSyntheticStaffMode();
      await client.query("COMMIT");
      return {
        opaqueToken,
        csrfToken,
        expiresAt: new Date(new Date(stamp.created).getTime() + 8 * 60 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Current source authority is reloaded even when a caller retained an older typed context. */
export async function assertStaffPermission(
  client: PoolClient,
  context: VerifiedStaffContext,
  permission = "",
) {
  requireSyntheticStaffMode();
  const result = await client.query(
    `SELECT app.control_authorized($1)AND app.current_actor()=$2::uuid AND current_setting('app.staff_session_hash',true)=$3
    AND EXISTS(SELECT 1 FROM app.staff_principal WHERE id=$4 AND user_id=$2 AND row_version=$5)AS allowed`,
    [permission, context.userId, context.sessionHash, context.staffPrincipalId, context.principalVersion],
  );
  if (!result.rows[0]?.allowed)
    throw new AccessError(403, "staff_permission_required", "Current staff authority required.");
}

export async function withStaffTransaction<T>(
  pool: Pool,
  token: string | undefined,
  operation: (client: PoolClient, session: StaffSession) => Promise<T>,
  options: { readonly logout?: boolean } = {},
) {
  requireSyntheticStaffMode();
  if (!token || !/^[0-9a-f]{64}$/.test(token))
    throw new AccessError(401, "staff_authentication_required", "Staff sign in required.");
  const tokenHash = hash(token),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.staff_session_hash',$1,true)", [tokenHash]);
    const initial = await client.query(
      "SELECT staff_user_id FROM app.staff_session WHERE token_hash=$1 AND provenance='synthetic-local'AND expires_at>clock_timestamp()",
      [tokenHash],
    );
    if (initial.rowCount !== 1)
      throw new AccessError(401, "staff_session_expired", "Staff session expired. Sign in again.");
    await client.query("SELECT set_config('app.actor_id',$1,true)", [initial.rows[0].staff_user_id]);
    const principal = await client.query(
      "SELECT id,user_id,row_version,permission_codes FROM app.staff_principal WHERE user_id=$1 AND active FOR SHARE",
      [initial.rows[0].staff_user_id],
    );
    if (principal.rowCount !== 1)
      throw new AccessError(403, "staff_principal_required", "Active staff principal required.");
    const current = await client.query(
      "SELECT csrf_token,expires_at,selected_tenant_id FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2 AND expires_at>clock_timestamp()FOR SHARE",
      [tokenHash, initial.rows[0].staff_user_id],
    );
    if (current.rowCount !== 1)
      throw new AccessError(401, "staff_session_expired", "Staff session expired. Sign in again.");
    if (current.rows[0].selected_tenant_id)
      throw new AccessError(
        503,
        "staff_support_unavailable",
        "Support selection is not enabled in this adapter.",
      );
    const codes = principal.rows[0].permission_codes as string[];
    if (
      !Array.isArray(codes) ||
      codes.some((code) => !catalog.codes.some((entry) => entry.code === code && entry.boundary === "staff"))
    )
      throw new AccessError(403, "staff_permission_invalid", "Staff permissions require review.");
    const session: StaffSession = {
      userId: principal.rows[0].user_id,
      staffPrincipalId: principal.rows[0].id,
      principalVersion: String(principal.rows[0].row_version),
      permissionCodes: codes,
      sessionHash: tokenHash,
      provenance: "synthetic-local",
      csrfToken: current.rows[0].csrf_token,
      expiresAt: new Date(current.rows[0].expires_at).toISOString(),
    };
    const result = await operation(client, session);
    await assertStaffPermission(client, session);
    if (options.logout)
      await client.query("DELETE FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2", [
        session.sessionHash,
        session.userId,
      ]);
    requireSyntheticStaffMode();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export const staffSessionResponse = (session: StaffSession): SyntheticStaffSessionResponse => ({
  staffUserId: session.userId,
  permissions: session.permissionCodes,
  synthetic: true,
  supportContext: null,
});
export function verifyStaffCsrf(session: StaffSession, value: string | undefined) {
  const supplied = Buffer.from(value ?? ""),
    expected = Buffer.from(session.csrfToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new AccessError(403, "csrf_invalid", "CSRF token required.");
}
