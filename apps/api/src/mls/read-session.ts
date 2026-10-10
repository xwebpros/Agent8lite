import type { PoolClient } from "pg";
import type { ServerSession } from "../../../../packages/auth/sessions";
import { AccessError } from "../../../../packages/db/tenant-transaction";

const unavailable = () => new AccessError(401, "session_expired", "Session expired. Sign in again.");

/** Consume the router's verified session, holding its current binding through caller commit. */
export async function requireCurrentNativeSession(client: PoolClient, session: ServerSession): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(session.tokenHash)) throw unavailable();
  await client.query("SELECT set_config('app.session_hash',$1,true)", [session.tokenHash]);
  const locked = await client.query(
    "SELECT token_hash FROM app.login_session WHERE token_hash=$1 AND user_id=$2 AND active_org_id=$3 FOR SHARE",
    [session.tokenHash, session.userId, session.organizationId],
  );
  if (!locked.rowCount) throw unavailable();
  // A predicate in the locking SELECT can run before a wait on an unchanged tuple.
  // Evaluate time after the lock, including on the final post-source recheck.
  const current = await client.query<{ valid: boolean }>(
    "SELECT expires_at>clock_timestamp() AS valid FROM app.login_session WHERE token_hash=$1",
    [session.tokenHash],
  );
  if (current.rows[0]?.valid !== true) throw unavailable();
}
