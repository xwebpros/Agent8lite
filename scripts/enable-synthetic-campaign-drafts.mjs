import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import * as fixtureModule from "../packages/db/fixtures.ts";

// tsx loads this repository's TypeScript CommonJS pin differently from Vitest's module transform.
const fixtures = fixtureModule.fixtures ?? fixtureModule.default?.fixtures;

/** Explicit local fixture setup, separate from default seed and all provider readiness. */
export function campaignFixtureTarget(environment = process.env) {
  if (
    !["development", "test"].includes(environment.APP_ENV) ||
    environment.DEV_AUTH_ENABLED !== "true" ||
    environment.SYNTHETIC_CAMPAIGN_DRAFTS_ENABLED !== "true"
  )
    throw new Error("Campaign draft fixtures require explicitly enabled synthetic local mode and opt-in.");
  let target;
  let identity;
  try {
    target = new URL(
      environment.MIGRATION_DATABASE_URL ||
        "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
    );
    identity = decodeURIComponent(target.username);
  } catch {
    throw new Error("A valid local migration database is required.");
  }
  if (
    !["postgres:", "postgresql:"].includes(target.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    target.search ||
    target.hash ||
    !/^\/(?:estate|estate_acceptance_[0-9a-f]{16})$/.test(target.pathname) ||
    !identity ||
    ["estate_runtime", "estate_worker", "estate_control", "estate_staff_issuer"].includes(identity)
  )
    throw new Error("Campaign draft fixtures require the local fixture database and a migration identity.");
  return target.href;
}

export async function enableSyntheticCampaignDrafts(environment = process.env) {
  const pool = new Pool({
    connectionString: campaignFixtureTarget(environment),
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(874522)");
    const identity = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='app' AND c.relname='entitlement'
       AND session_user=current_user
       AND current_user NOT IN ('estate_runtime','estate_worker','estate_control','estate_staff_issuer')
       AND pg_has_role(current_user,c.relowner,'USAGE')`,
    );
    if (identity.rowCount !== 1) throw new Error("The actual migration identity is required.");
    const ready = await client.query(
      "SELECT 1 FROM public.estate_migration WHERE name='0018-native-campaign-workflow-sequence.sql'",
    );
    if (ready.rowCount !== 1)
      throw new Error("Verified workflow migrations must precede fixture activation.");
    for (const [organization, member] of [
      [fixtures.orgA, fixtures.ownerMemberA],
      [fixtures.orgB, fixtures.ownerMemberB],
    ]) {
      const synthetic = await client.query(
        `SELECT 1 FROM app.organization o
         JOIN app.membership m ON m.tenant_id=o.id
         JOIN app.user_identity u ON u.id=m.user_id
         JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
         WHERE o.id=$1 AND o.status='active' AND m.id=$2 AND m.status='active'
         AND u.id=$3 AND u.issuer='urn:estate:synthetic' AND u.subject='owner'
         AND r.builtin AND r.permission_grants @> '[{"code":"campaigns.write","scope":"organization"}]'::jsonb
         FOR SHARE OF o,m,u,r`,
        [organization, member, fixtures.ownerUser],
      );
      if (synthetic.rowCount !== 1)
        throw new Error("Both original active synthetic fixture organizations are required.");
    }
    const inserted = await client.query(
      `INSERT INTO app.entitlement(tenant_id,feature,state)
       SELECT id,'marketing','enabled' FROM app.organization WHERE id=ANY($1::uuid[])
       ON CONFLICT(tenant_id,feature) DO NOTHING RETURNING id`,
      [[fixtures.orgA, fixtures.orgB]],
    );
    const current = await client.query(
      `SELECT count(*)::int AS enabled FROM app.entitlement
       WHERE tenant_id=ANY($1::uuid[]) AND feature='marketing' AND state='enabled'
       AND (effective_until IS NULL OR effective_until>clock_timestamp())`,
      [[fixtures.orgA, fixtures.orgB]],
    );
    await client.query("COMMIT");
    return { created: inserted.rowCount, currentlyEnabled: current.rows[0].enabled };
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  enableSyntheticCampaignDrafts()
    .then((result) => {
      console.log(
        `Synthetic campaign draft capability: ${result.created} created; ${result.currentlyEnabled}/2 currently enabled.`,
      );
      console.log(
        "Local draft authoring only. Publication, enrollment, scheduling and sending remain unavailable.",
      );
    })
    .catch(() => {
      console.error(
        "Synthetic campaign draft setup failed; check explicit local mode, fixture identity and workflow migrations.",
      );
      process.exitCode = 1;
    });
