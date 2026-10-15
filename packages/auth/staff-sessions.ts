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

const SESSION_DURATION_HOURS = 8;
const ROTATION_THRESHOLD_HOURS = 4;

export type StaffSession = VerifiedStaffContext & {
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly selectedTenantId: string | null;
  readonly selectedGrantId: string | null;
  readonly intent: StaffTransactionIntent;
};
export type StaffTransactionIntent = "provisioning" | "identity" | "context-mutation" | "support-read";

type StaffProvenance = "synthetic-local" | "oidc-verified";
const VALID_PROVENANCES: readonly StaffProvenance[] = ["synthetic-local", "oidc-verified"];

export interface StaffIssuerConfig {
  readonly trustedIssuers: readonly string[];
  readonly trustedSubjects?: readonly string[];
}

function resolveProvenance(issuer: string): StaffProvenance {
  return issuer === "urn:estate:synthetic" ? "synthetic-local" : "oidc-verified";
}

export class StaffSessionIssuer implements StaffSessionIssuerPort {
  constructor(
    private readonly pool: Pool,
    private readonly config: StaffIssuerConfig = {
      trustedIssuers: ["urn:estate:synthetic"],
      trustedSubjects: ["staff-administrator", "staff-support"],
    },
  ) {}

  async issueVerifiedIdentity(identity: VerifiedOidcIdentity) {
    const provenance = resolveProvenance(identity.issuer);
    if (provenance === "synthetic-local") requireSyntheticStaffMode();
    if (
      !this.config.trustedIssuers.includes(identity.issuer) ||
      (this.config.trustedSubjects?.length && !this.config.trustedSubjects.includes(identity.subject)) ||
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
      await client.query(
        "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$5::timestamptz+interval '8 hours')",
        [hash(opaqueToken), identityRow.rows[0].id, csrfToken, provenance, stamp.created],
      );
      if (provenance === "synthetic-local") requireSyntheticStaffMode();
      await client.query("COMMIT");
      return {
        opaqueToken,
        csrfToken,
        expiresAt: new Date(new Date(stamp.created).getTime() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function assertStaffPermission(
  client: PoolClient,
  context: VerifiedStaffContext,
  permission = "",
) {
  if (context.provenance === "synthetic-local") requireSyntheticStaffMode();
  const result = await client.query(
    `SELECT app.control_authorized($1)AND app.current_actor()=$2::uuid AND current_setting('app.staff_session_hash',true)=$3
    AND EXISTS(SELECT 1 FROM app.staff_principal WHERE id=$4 AND user_id=$2 AND row_version=$5)AS allowed`,
    [permission, context.userId, context.sessionHash, context.staffPrincipalId, context.principalVersion],
  );
  if (!result.rows[0]?.allowed)
    throw new AccessError(403, "staff_permission_required", "Current staff authority required.");
}

export interface StaffTransactionResult<T> {
  result: T;
  rotatedToken?: { opaqueToken: string; csrfToken: string; expiresAt: string };
}

export async function withStaffTransaction<T>(
  pool: Pool,
  token: string | undefined,
  operation: (client: PoolClient, session: StaffSession) => Promise<T>,
  options: { readonly logout?: boolean; readonly intent?: StaffTransactionIntent } = {},
): Promise<T> {
  const { result } = await withStaffTransactionEx(pool, token, operation, options);
  return result;
}

export async function withStaffTransactionEx<T>(
  pool: Pool,
  token: string | undefined,
  operation: (client: PoolClient, session: StaffSession) => Promise<T>,
  options: { readonly logout?: boolean; readonly intent?: StaffTransactionIntent } = {},
): Promise<StaffTransactionResult<T>> {
  if (!token || !/^[0-9a-f]{64}$/.test(token))
    throw new AccessError(401, "staff_authentication_required", "Staff sign in required.");
  const env = process.env;
  const syntheticAvailable =
    ["development", "test"].includes(env.APP_ENV ?? "") && env.DEV_AUTH_ENABLED === "true";
  const oidcAvailable = !!(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);
  if (!syntheticAvailable && !oidcAvailable)
    throw new AccessError(401, "identity_provider_unconfigured", "An approved staff identity provider is required.");
  const tokenHash = hash(token),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.staff_session_hash',$1,true)", [tokenHash]);
    const initial = await client.query(
      `SELECT staff_user_id,provenance,created_at FROM app.staff_session WHERE token_hash=$1 AND provenance=ANY($2) AND expires_at>clock_timestamp()`,
      [tokenHash, VALID_PROVENANCES],
    );
    if (initial.rowCount !== 1)
      throw new AccessError(401, "staff_session_expired", "Staff session expired. Sign in again.");
    const provenance = initial.rows[0].provenance as StaffProvenance;
    if (provenance === "synthetic-local") requireSyntheticStaffMode();
    await client.query("SELECT set_config('app.actor_id',$1,true)", [initial.rows[0].staff_user_id]);
    const principal = await client.query(
      "SELECT id,user_id,row_version,permission_codes FROM app.staff_principal WHERE user_id=$1 AND active FOR SHARE",
      [initial.rows[0].staff_user_id],
    );
    if (principal.rowCount !== 1)
      throw new AccessError(403, "staff_principal_required", "Active staff principal required.");
    const current = await client.query(
      `SELECT csrf_token,expires_at,selected_tenant_id,selected_grant_id FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2 AND expires_at>clock_timestamp()FOR ${options.logout || options.intent === "context-mutation" ? "UPDATE" : "SHARE"}`,
      [tokenHash, initial.rows[0].staff_user_id],
    );
    if (current.rowCount !== 1)
      throw new AccessError(401, "staff_session_expired", "Staff session expired. Sign in again.");
    if (
      current.rows[0].selected_tenant_id &&
      !options.logout &&
      (options.intent ?? "provisioning") === "provisioning"
    )
      throw new AccessError(
        403,
        "staff_context_selected",
        "Clear the selected support context before provisioning.",
      );
    const codes = principal.rows[0].permission_codes as string[];
    if (
      !Array.isArray(codes) ||
      codes.length > 20 ||
      new Set(codes).size !== codes.length ||
      codes.some((code) => !catalog.codes.some((entry) => entry.code === code && entry.boundary === "staff"))
    )
      throw new AccessError(403, "staff_permission_invalid", "Staff permissions require review.");
    const session: StaffSession = {
      userId: principal.rows[0].user_id,
      staffPrincipalId: principal.rows[0].id,
      principalVersion: String(principal.rows[0].row_version),
      permissionCodes: codes,
      sessionHash: tokenHash,
      provenance,
      csrfToken: current.rows[0].csrf_token,
      expiresAt: new Date(current.rows[0].expires_at).toISOString(),
      selectedTenantId: current.rows[0].selected_tenant_id,
      selectedGrantId: current.rows[0].selected_grant_id,
      intent: options.logout ? "context-mutation" : (options.intent ?? "provisioning"),
    };
    await assertStaffPermission(client, session);
    const result = await operation(client, session);
    await assertStaffPermission(client, session);

    let rotatedToken: StaffTransactionResult<T>["rotatedToken"];
    if (options.logout) {
      await client.query("DELETE FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2", [
        session.sessionHash,
        session.userId,
      ]);
    } else {
      const createdAt = new Date(initial.rows[0].created_at).getTime();
      const elapsed = (Date.now() - createdAt) / (1000 * 60 * 60);
      if (elapsed >= ROTATION_THRESHOLD_HOURS) {
        const newToken = randomBytes(32).toString("hex");
        const newCsrf = randomBytes(32).toString("hex");
        const newHash = hash(newToken);
        const stamp = (
          await client.query("SELECT clock_timestamp() now")
        ).rows[0];
        await client.query(
          `INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$5::timestamptz+interval '8 hours')`,
          [newHash, session.userId, newCsrf, provenance, stamp.now],
        );
        await client.query("DELETE FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2", [
          tokenHash, session.userId,
        ]);
        rotatedToken = {
          opaqueToken: newToken,
          csrfToken: newCsrf,
          expiresAt: new Date(new Date(stamp.now).getTime() + SESSION_DURATION_HOURS * 60 * 60 * 1000).toISOString(),
        };
      }
    }

    if (provenance === "synthetic-local") requireSyntheticStaffMode();
    await client.query("COMMIT");
    return { result, rotatedToken };
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
  synthetic: session.provenance === "synthetic-local",
  supportContext: null,
});
export function verifyStaffCsrf(session: StaffSession, value: string | undefined) {
  const supplied = Buffer.from(value ?? ""),
    expected = Buffer.from(session.csrfToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    throw new AccessError(403, "csrf_invalid", "CSRF token required.");
}
