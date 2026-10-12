import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AccessError } from "../db/tenant-transaction";
import type { VerifiedOidcIdentity } from "../providers/identity/port";

export type ServerSession = { userId: string; organizationId: string; csrfToken: string; tokenHash: string };
export const sessionCookie = "estate_session";
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new AccessError(401, "authentication_required", "Sign in required.");
  const tokenHash = hashToken(token);
  return sessionTransaction(pool, tokenHash, async (client) => {
    const result = await client.query(
      "SELECT user_id,active_org_id,csrf_token FROM app.login_session WHERE token_hash=$1 AND expires_at>now()",
      [tokenHash],
    );
    if (!result.rowCount) throw new AccessError(401, "session_expired", "Session expired. Sign in again.");
    return {
      userId: result.rows[0].user_id,
      organizationId: result.rows[0].active_org_id,
      csrfToken: result.rows[0].csrf_token,
      tokenHash,
    };
  });
}

export async function createSession(pool: Pool, userId: string, organizationId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const csrfToken = randomBytes(32).toString("hex");
  await sessionTransaction(pool, tokenHash, async (client) => {
    await client.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true)", [
      userId,
      organizationId,
    ]);
    const member = await client.query(
      "SELECT id FROM app.membership WHERE user_id=$1 AND tenant_id=$2 AND status='active'",
      [userId, organizationId],
    );
    if (!member.rowCount) throw new AccessError(403, "membership_required", "Active membership required.");
    await client.query(
      "INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",
      [tokenHash, userId, organizationId, csrfToken],
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
    await client.query("SELECT set_config('app.actor_id',$1,true),set_config('app.tenant_id',$2,true)", [
      userId,
      organizationId,
    ]);
    const member = await client.query(
      "SELECT id FROM app.membership WHERE user_id=$1 AND tenant_id=$2 AND status='active'",
      [userId, organizationId],
    );
    if (!member.rowCount) throw new AccessError(403, "membership_required", "Active membership required.");
    await client.query(
      "INSERT INTO app.login_session(token_hash,user_id,active_org_id,csrf_token,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')",
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
