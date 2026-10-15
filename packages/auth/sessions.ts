import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AccessError } from "../db/tenant-transaction";
import type { VerifiedOidcIdentity } from "../providers/identity/port";

export type ServerSession = { userId: string; organizationId: string; csrfToken: string; tokenHash: string };
export const sessionCookie = "estate_session";
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function configuredOidc() {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  let valid =
    typeof issuer === "string" &&
    issuer.length > 0 &&
    issuer.length <= 2048 &&
    issuer.trim() === issuer &&
    !issuer.endsWith("//") &&
    /^https:\/\//i.test(issuer) &&
    !/^https:\/\/[^/]*@/i.test(issuer) &&
    !/[\u0000-\u001f\u007f?#]/.test(issuer) &&
    typeof clientId === "string" &&
    clientId.trim().length > 0 &&
    clientId.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(clientId);
  if (valid) {
    try {
      const url = new URL(issuer!);
      valid =
        url.protocol === "https:" &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash;
    } catch {
      valid = false;
    }
  }
  if (!valid)
    throw new AccessError(
      401,
      "identity_provider_unconfigured",
      "An approved identity provider is required.",
    );
  // Keep the same single trailing-slash normalization as discoverOidcIssuer.
  return { issuer: issuer!.replace(/\/$/, ""), clientId: clientId! };
}

const expired = (): never => {
  throw new AccessError(401, "session_expired", "Session expired. Sign in again.");
};
const sessionValue = (
  row: { user_id: string; active_org_id: string; csrf_token: string },
  tokenHash: string,
): ServerSession => ({
  userId: row.user_id,
  organizationId: row.active_org_id,
  csrfToken: row.csrf_token,
  tokenHash,
});
const actorContext = (client: PoolClient, userId: string, organizationId: string) =>
  client.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true)", [
    userId,
    organizationId,
  ]);
async function activeMembership(client: PoolClient, userId: string, organizationId: string) {
  return client.query(
    `SELECT m.id FROM app.membership m JOIN app.organization o ON o.id=m.tenant_id
     WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.status='active' AND o.status='active' FOR SHARE OF m,o`,
    [userId, organizationId],
  );
}

async function sessionTransaction<T>(
  pool: Pool,
  tokenHash: string,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.session_hash',$1,true)", [tokenHash]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function readSession(pool: Pool, token: string | undefined): Promise<ServerSession> {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "") || process.env.DEV_AUTH_ENABLED !== "true")
    throw new AccessError(
      401,
      "identity_provider_unconfigured",
      "An approved identity provider is required.",
    );
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new AccessError(401, "authentication_required", "Sign in required.");
  const tokenHash = hashToken(token);
  return sessionTransaction(pool, tokenHash, async (client) => {
    const result = await client.query(
      `SELECT user_id,active_org_id,csrf_token FROM app.login_session WHERE token_hash=$1
       AND identity_provenance IN ('synthetic-local','legacy-unknown') AND expires_at>clock_timestamp()`,
      [tokenHash],
    );
    if (result.rowCount !== 1) expired();
    return sessionValue(result.rows[0], tokenHash);
  });
}

export async function readProductionSession(pool: Pool, token: string | undefined): Promise<ServerSession> {
  const provider = configuredOidc();
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new AccessError(401, "authentication_required", "Sign in required.");
  const tokenHash = hashToken(token);
  return sessionTransaction(pool, tokenHash, async (client) => {
    const result = await client.query(
      `SELECT user_id,active_org_id,csrf_token,oidc_subject FROM app.login_session
       WHERE token_hash=$1 AND identity_provenance='oidc' AND oidc_issuer=$2 AND oidc_client_id=$3
       AND expires_at>clock_timestamp() FOR SHARE`,
      [tokenHash, provider.issuer, provider.clientId],
    );
    if (result.rowCount !== 1) expired();
    const row = result.rows[0];
    await actorContext(client, row.user_id, row.active_org_id);
    const identity = await client.query(
      "SELECT id FROM app.user_identity WHERE id=$1 AND issuer=$2 AND subject=$3 AND email_verified FOR SHARE",
      [row.user_id, provider.issuer, row.oidc_subject],
    );
    if (identity.rowCount !== 1) expired();
    if ((await activeMembership(client, row.user_id, row.active_org_id)).rowCount !== 1) expired();
    // Recheck the actual clock after waited identity/membership/session locks;
    // transaction-start now() is not use-time expiry evidence.
    const current = await client.query(
      `SELECT s.user_id,s.active_org_id,s.csrf_token FROM app.login_session s
       JOIN app.user_identity u ON u.id=s.user_id
       JOIN app.membership m ON m.user_id=s.user_id AND m.tenant_id=s.active_org_id
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE s.token_hash=$1 AND s.identity_provenance='oidc' AND s.oidc_issuer=$2 AND s.oidc_client_id=$3
       AND s.oidc_subject=$4 AND s.expires_at>clock_timestamp()
       AND u.issuer=$2 AND u.subject=$4 AND u.email_verified AND m.status='active' AND o.status='active'`,
      [tokenHash, provider.issuer, provider.clientId, row.oidc_subject],
    );
    if (current.rowCount !== 1) expired();
    return sessionValue(current.rows[0], tokenHash);
  });
}

export async function createSession(
  pool: Pool,
  userId: string,
  organizationId: string,
  verified: { identity: VerifiedOidcIdentity; clientId: string },
) {
  const provider = configuredOidc();
  const supplied = verified?.identity;
  const identity = supplied
    ? {
        issuer: supplied.issuer,
        subject: supplied.subject,
        email: supplied.email,
        emailVerified: supplied.emailVerified,
        authenticatedAt: supplied.authenticatedAt,
      }
    : undefined;
  const clientId = verified?.clientId;
  if (
    !identity ||
    identity.issuer !== provider.issuer ||
    clientId !== provider.clientId ||
    identity.emailVerified !== true ||
    typeof identity.subject !== "string" ||
    !identity.subject ||
    identity.subject.length > 512 ||
    typeof identity.email !== "string" ||
    !identity.email ||
    !Number.isFinite(identity.authenticatedAt) ||
    identity.authenticatedAt > Date.now() / 1000 + 30
  )
    throw new AccessError(401, "identity_link_unavailable", "Verified identity is unavailable.");
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const csrfToken = randomBytes(32).toString("hex");
  await sessionTransaction(pool, tokenHash, async (client) => {
    await actorContext(client, userId, organizationId);
    const linked = await client.query(
      "SELECT id FROM app.user_identity WHERE id=$1 AND issuer=$2 AND subject=$3 AND email=$4 AND email_verified FOR SHARE",
      [userId, provider.issuer, identity.subject, identity.email],
    );
    if (linked.rowCount !== 1)
      throw new AccessError(401, "identity_link_unavailable", "Verified identity is unavailable.");
    const member = await activeMembership(client, userId, organizationId);
    if (member.rowCount !== 1)
      throw new AccessError(403, "membership_required", "Active membership required.");
    await client.query(
      `INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at,
       identity_provenance,oidc_issuer,oidc_client_id,oidc_subject)
       VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours','oidc',$5,$6,$7)`,
      [tokenHash, userId, organizationId, csrfToken, provider.issuer, provider.clientId, identity.subject],
    );
  });
  return { token, csrfToken };
}

export async function createSyntheticSession(pool: Pool, userId: string, organizationId: string) {
  if (!["development", "test"].includes(process.env.APP_ENV ?? "") || process.env.DEV_AUTH_ENABLED !== "true")
    throw new AccessError(401, "synthetic_identity_disabled", "Synthetic identity is disabled.");
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const csrfToken = randomBytes(32).toString("hex");
  await sessionTransaction(pool, tokenHash, async (client) => {
    await actorContext(client, userId, organizationId);
    const member = await activeMembership(client, userId, organizationId);
    if (member.rowCount !== 1)
      throw new AccessError(403, "membership_required", "Active membership required.");
    await client.query(
      `INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at,identity_provenance)
       VALUES($1,$2,$3,$4,clock_timestamp()+interval '8 hours','synthetic-local')`,
      [tokenHash, userId, organizationId, csrfToken],
    );
  });
  return { token, csrfToken };
}

export async function resolveVerifiedIdentity(pool: Pool, identity: VerifiedOidcIdentity) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.auth_issuer',$1,true),set_config('app.auth_subject',$2,true)",
      [identity.issuer, identity.subject],
    );
    const result = await client.query(
      "SELECT id,email,email_verified FROM app.user_identity WHERE issuer=$1 AND subject=$2",
      [identity.issuer, identity.subject],
    );
    if (!result.rowCount || !result.rows[0].email_verified || result.rows[0].email !== identity.email)
      throw new AccessError(
        401,
        "identity_link_unavailable",
        "Verified identity is not linked to a permitted synthetic account.",
      );
    await client.query("COMMIT");
    return result.rows[0].id as string;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function switchOrganization(pool: Pool, session: ServerSession, organizationId: string) {
  await sessionTransaction(pool, session.tokenHash, async (client) => {
    await client.query("SELECT set_config('app.actor_id',$1,true)", [session.userId]);
    const member = await client.query(
      "SELECT id FROM app.membership WHERE user_id=$1 AND tenant_id=$2 AND status='active'",
      [session.userId, organizationId],
    );
    if (!member.rowCount) throw new AccessError(403, "membership_required", "Active membership required.");
    await client.query("UPDATE app.login_session SET active_org_id=$1 WHERE token_hash=$2", [
      organizationId,
      session.tokenHash,
    ]);
  });
}

export async function revokeSession(pool: Pool, session: ServerSession) {
  await sessionTransaction(pool, session.tokenHash, (client) =>
    client.query("DELETE FROM app.login_session WHERE token_hash=$1", [session.tokenHash]),
  );
}

export function verifyCsrf(session: ServerSession, supplied: string | undefined) {
  const actual = Buffer.from(supplied ?? "");
  const expected = Buffer.from(session.csrfToken);
  if (!supplied || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new AccessError(403, "csrf_invalid", "CSRF token required.");
}
