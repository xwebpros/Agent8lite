// Candidate-only real-login verifier; no API listener, shared database or global-role mutations.
// Run: node --import tsx apps/api/proposals/verify-control-support-policy.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import fixtureModule from "../../../packages/db/fixtures.ts";
import seedModule from "../../../packages/db/seed.ts";
import authModule from "../../../packages/auth/staff-sessions.ts";
import poolModule from "../../../packages/db/staff-pools.ts";
import controlModule from "../src/control/provisioning-service.ts";
const { fixtures: f } = fixtureModule,
  { seed } = seedModule;
const { withStaffTransaction } = authModule,
  { assertStaffRole } = poolModule;
const { ControlProvisioningService, runProvisioning } = controlModule;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const database = `estate_support_policy_${randomBytes(8).toString("hex")}`;
assert(/^estate_support_policy_[0-9a-f]{16}$/.test(database));
const source = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(source.hostname),
  "Verifier requires loopback PostgreSQL.",
);
const clusterUrl = new URL(source);
clusterUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: clusterUrl.href });
const freshUrl = new URL(source);
freshUrl.pathname = `/${database}`;
const fresh = new pg.Pool({ connectionString: freshUrl.href });
const pools = [fresh];
const roles = ["estate_runtime", "estate_worker", "estate_control", "estate_staff_issuer"];
const urls = {};
for (const [role, key, password] of [
  ["estate_runtime", "DATABASE_URL", "local-runtime-only"],
  ["estate_worker", "WORKER_DATABASE_URL", "local-worker-only"],
  ["estate_control", "CONTROL_DATABASE_URL", "local-control-only"],
  ["estate_staff_issuer", "STAFF_ISSUER_DATABASE_URL", "local-staff-issuer-only"],
]) {
  const url = new URL(process.env[key] ?? source);
  url.username = role;
  if (!process.env[key]) url.password = password;
  assert(
    url.username === role && url.hostname === source.hostname && url.port === source.port,
    "Explicit local role connection required.",
  );
  url.pathname = `/${database}`;
  urls[role] = url.href;
}
const control = new pg.Pool({ connectionString: urls.estate_control }),
  issuer = new pg.Pool({ connectionString: urls.estate_staff_issuer });
const runtime = new pg.Pool({ connectionString: urls.estate_runtime }),
  worker = new pg.Pool({ connectionString: urls.estate_worker });
pools.push(control, issuer, runtime, worker);
const passed = [];
let stage = "initialize",
  created = false,
  globalBefore;
async function probe(label, operation) {
  stage = label;
  await operation();
  passed.push(label);
  console.log(JSON.stringify({ probe: label, state: "passed" }));
}
async function globals() {
  const rows = (
    await admin.query(
      "SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)ORDER BY rolname",
      [roles],
    )
  ).rows;
  const memberships = (
    await admin.query(
      "SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member",
    )
  ).rows;
  return sha(JSON.stringify({ rows, memberships }));
}
async function tx(pool, values, operation, commit = true) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of Object.entries(values))
      await client.query("SELECT set_config($1,$2,true)", [key, value]);
    const result = await operation(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const ctx = (session, extra = {}) => ({
  "app.actor_id": session.user,
  "app.staff_session_hash": session.hash,
  ...extra,
});
async function denied(client, query, values = [], codes = ["42501"]) {
  await client.query("SAVEPOINT deny");
  try {
    const result = await client.query(query, values);
    const error = new Error("Expected role-boundary denial.");
    error.code = `unexpected_write_rowcount_${result.rowCount}`;
    throw error;
  } catch (error) {
    if (!codes.includes(error.code)) throw error;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT deny");
    await client.query("RELEASE SAVEPOINT deny");
  }
}
async function session(subject, user) {
  const token = randomBytes(32).toString("hex"),
    hash = sha(token);
  await tx(
    issuer,
    { "app.auth_issuer": "urn:estate:synthetic", "app.auth_subject": subject, "app.actor_id": user },
    async (client) => {
      await client.query("SELECT id FROM app.staff_principal WHERE user_id=$1 AND active FOR SHARE", [user]);
      const stamp = (await client.query("SELECT clock_timestamp()AS created")).rows[0].created;
      await client.query(
        "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,'synthetic-local',$4,$4::timestamptz+interval '8 hours')",
        [hash, user, randomBytes(32).toString("hex"), stamp],
      );
    },
  );
  return { token, hash, user };
}
async function select(client, session, tenant, grant) {
  await client.query("SELECT token_hash FROM app.staff_session WHERE token_hash=$1 FOR UPDATE", [
    session.hash,
  ]);
  await client.query(
    "UPDATE app.staff_session SET selected_tenant_id=$2,selected_grant_id=$3 WHERE token_hash=$1",
    [session.hash, tenant, grant],
  );
  await client.query(
    "SELECT set_config('app.tenant_id',$1,true),set_config('app.support_grant_id',$2,true)",
    [tenant, grant],
  );
}
async function grant(session, target, tenant = f.orgA, seconds = 600) {
  const id = randomUUID();
  await tx(control, ctx(session), async (client) => {
    const stamp = (await client.query("SELECT clock_timestamp()AS created")).rows[0].created;
    await client.query(
      "INSERT INTO app.support_access_grant(tenant_id,id,staff_user_id,permission_codes,reason,created_at,expires_at,issuing_staff_user_id,provenance)VALUES($1,$2,$3,ARRAY['crm.contacts.read'],'Synthetic policy probe',$4,$4::timestamptz+($5::int*interval '1 second'),$6,'synthetic-local')",
      [tenant, id, target, stamp, seconds, session.user],
    );
  });
  return { id, tenant };
}
async function clear(client, key = randomUUID(), overrides = {}) {
  const principal = (
    await client.query(
      "SELECT id,row_version FROM app.staff_principal WHERE user_id=app.current_actor()AND active FOR SHARE",
    )
  ).rows[0];
  const current = (
    await client.query(
      "SELECT app.control_command_session_binding()AS binding,app.control_command_context_fingerprint(selected_tenant_id,selected_grant_id)AS previous FROM app.staff_session WHERE token_hash=current_setting('app.staff_session_hash',true)FOR UPDATE",
    )
  ).rows[0];
  const values = {
    principal: principal?.id,
    version: principal?.row_version,
    binding: current?.binding,
    previous: current?.previous,
    ...overrides,
  };
  return client.query(
    "INSERT INTO app.control_command_audit(staff_user_id,staff_principal_id,principal_version,session_binding,action,command_digest,trace_id,previous_context_fingerprint)VALUES(app.current_actor(),$1,$2,$3,'staff.support.selection.clear',$4,$5,$6)RETURNING id",
    [values.principal, values.version, values.binding, sha(key), randomUUID(), values.previous],
  );
}
try {
  globalBefore = await globals();
  const existing = (await admin.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1)", [roles])).rows;
  assert.equal(
    existing.length,
    4,
    "Existing configured roles required; verifier never creates/alters cluster roles.",
  );
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  stage = "database_baseline";
  for (const name of (await readdir("packages/db/migrations"))
    .filter((name) => /^\d{4}-.+\.sql$/.test(name) && name.slice(0, 4) <= "0014")
    .sort()) {
    let sql = await readFile(`packages/db/migrations/${name}`, "utf8");
    if (name.startsWith("0002-") || name.startsWith("0012-")) {
      // These exact baseline blocks only initialize existing cluster roles. Retain database DDL/policies.
      sql = sql.replace(
        /DO \$\$ BEGIN\s*IF NOT EXISTS[\s\S]*?END \$\$;/,
        "-- Existing cluster-role initialization deliberately omitted by owned verifier.",
      );
      sql = sql.replace(/^ALTER ROLE estate_(runtime|worker|control|staff_issuer)[^;]*;\r?\n/gm, "");
    }
    assert(
      !/\b(?:CREATE|ALTER)\s+ROLE\b/i.test(sql),
      "Verifier baseline must contain no cluster-role mutation.",
    );
    await fresh.query(sql);
  }
  // Seed's native fixture guard consults the migration tracker; reflect immutable actual baseline names.
  await fresh.query(
    "CREATE TABLE public.estate_migration(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("packages/db/migrations")).filter(
    (name) => /^\d{4}-.+\.sql$/.test(name) && name.slice(0, 4) <= "0014",
  ))
    await fresh.query("INSERT INTO public.estate_migration(name,sha256)VALUES($1,$2)", [
      name,
      sha(await readFile(`packages/db/migrations/${name}`, "utf8")),
    ]);
  process.env.APP_ENV = "test";
  process.env.DEV_AUTH_ENABLED = "true";
  process.env.MIGRATION_DATABASE_URL = freshUrl.href;
  for (const [key, role] of [
    ["DATABASE_URL", "estate_runtime"],
    ["WORKER_DATABASE_URL", "estate_worker"],
    ["CONTROL_DATABASE_URL", "estate_control"],
    ["STAFF_ISSUER_DATABASE_URL", "estate_staff_issuer"],
  ])
    process.env[key] = urls[role];
  await seed();
  const candidate = await readFile("apps/api/proposals/control-support-policy.proposed.sql", "utf8");
  stage = "candidate_migration";
  await fresh.query(candidate);
  await assertStaffRole(control, "estate_control");
  await assertStaffRole(issuer, "estate_staff_issuer");
  const operator = await session("staff-administrator", f.staffAdministratorUser),
    recipient = await session("staff-support", f.staffSupportUser);
  const valid = await grant(operator, recipient.user);
  await fresh.query("UPDATE app.staff_principal SET permission_codes='{}'WHERE user_id=$1", [recipient.user]);
  await probe("01_selected_recipient_org_read_and_share_without_metadata", async () => {
    await tx(control, ctx(recipient), async (client) => {
      await select(client, recipient, valid.tenant, valid.id);
      const plain = await client.query("SELECT id,status FROM app.organization ORDER BY id");
      assert.deepEqual(plain.rows, [{ id: f.orgA, status: "active" }]);
      assert.equal(
        (await client.query("SELECT id FROM app.organization WHERE id=$1 FOR SHARE", [f.orgA])).rowCount,
        1,
      );
      await denied(client, "UPDATE app.organization SET row_version=row_version+1 WHERE id=$1", [f.orgA]);
    });
  });
  await probe("02_entitlement_share_but_no_actual_version_write", async () => {
    await tx(
      control,
      ctx(recipient, { "app.tenant_id": valid.tenant, "app.support_grant_id": valid.id }),
      async (client) => {
        const before = (
          await client.query(
            "SELECT id,row_version,state,effective_until FROM app.entitlement WHERE feature='crm'FOR SHARE",
          )
        ).rows;
        assert.equal(before.length, 1);
        await denied(client, "UPDATE app.entitlement SET row_version=row_version+1 WHERE feature='crm'");
        assert.deepEqual(
          (
            await client.query(
              "SELECT id,row_version,state,effective_until FROM app.entitlement WHERE feature='crm'",
            )
          ).rows,
          before,
        );
      },
    );
  });
  await probe("03_retained_provision_claim_cannot_lend_support_lock_writes", async () => {
    const org = randomUUID(),
      job = randomUUID(),
      claim = randomUUID();
    await tx(
      control,
      ctx(operator, { "app.tenant_id": org, "app.provision_claim": claim }),
      async (client) => {
        stage = "03a_insert_provisioning_target_and_claim";
        await client.query(
          "INSERT INTO app.organization(id,name,status)VALUES($1,'Synthetic composition target','provisioning')",
          [org],
        );
        await client.query(
          "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id)VALUES($1,$2,$3,'organization.provision','queued',$4)",
          [job, org, operator.user, f.ownerUser],
        );
        await client.query(
          "UPDATE app.control_job SET state='running',claim_id=$2,lease_until=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=$1",
          [job, claim],
        );
        stage = "03b_activate_with_unselected_session";
        assert.equal(
          (await client.query("UPDATE app.organization SET status='active'WHERE id=$1 RETURNING id", [org]))
            .rowCount,
          1,
        );
      },
    );
    await tx(
      control,
      ctx(operator, { "app.tenant_id": org, "app.provision_claim": claim }),
      async (client) => {
        stage = "03b_unselected_manager_does_not_gain_active_org_lock";
        assert.equal((await client.query("SELECT id FROM app.organization WHERE id=$1", [org])).rowCount, 1);
        assert.equal(
          (await client.query("SELECT app.control_provision_claim_current($1)AS allowed", [org])).rows[0]
            .allowed,
          true,
        );
        assert.equal(
          (await client.query("SELECT id FROM app.organization WHERE id=$1 FOR SHARE", [org])).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query(
              "UPDATE app.organization SET row_version=row_version+1 WHERE id=$1 RETURNING id",
              [org],
            )
          ).rowCount,
          0,
        );
      },
    );
    const own = await grant(operator, operator.user, org);
    await tx(
      control,
      ctx(operator, { "app.tenant_id": org, "app.provision_claim": claim }),
      async (client) => {
        await select(client, operator, org, own.id);
        stage = "03c_selected_claim_and_org_share";
        assert.equal(
          (await client.query("SELECT app.control_provision_claim_current($1)AS allowed", [org])).rows[0]
            .allowed,
          true,
        );
        assert.equal(
          (await client.query("SELECT id FROM app.organization WHERE id=$1 FOR SHARE", [org])).rowCount,
          1,
        );
        for (const change of [
          "status='provisioning'",
          "row_version=row_version+1",
          "updated_at=clock_timestamp()",
        ]) {
          stage = `03d_deny_retained_claim_${change.split("=")[0]}`;
          await denied(client, `UPDATE app.organization SET ${change} WHERE id=$1`, [org]);
        }
        stage = "03e_clear_and_complete_original_claim";
        await clear(client);
        await client.query("SELECT set_config('app.support_grant_id','',true)");
        assert.equal(
          (
            await client.query(
              "UPDATE app.control_job SET state='succeeded',result_ref=organization_id WHERE id=$1 RETURNING id",
              [job],
            )
          ).rowCount,
          1,
        );
      },
    );
  });
  await probe("04_forged_gucs_and_other_recipient_do_not_authorize_sources", async () => {
    await tx(
      control,
      ctx(operator, { "app.tenant_id": valid.tenant, "app.support_grant_id": valid.id }),
      async (client) => {
        assert.equal(
          (await client.query("SELECT app.control_grant_allows('')AS allowed")).rows[0].allowed,
          false,
        );
        assert.equal((await client.query("SELECT id FROM app.entitlement")).rowCount, 0);
      },
    );
    await tx(
      control,
      { "app.actor_id": recipient.user, "app.tenant_id": valid.tenant, "app.support_grant_id": valid.id },
      async (client) => {
        assert.equal((await client.query("SELECT id FROM app.organization")).rowCount, 0);
        await denied(
          client,
          "INSERT INTO app.control_command_audit(staff_user_id,staff_principal_id,principal_version,session_binding,action,command_digest,trace_id)VALUES($1,$2,1,$3,'staff.support.selection.clear',$4,$2)",
          [recipient.user, randomUUID(), "a".repeat(64), "b".repeat(64)],
        );
      },
    );
  });
  await probe("05_closed_append_only_clear_evidence_is_the_atomic_own_command", async () => {
    await tx(control, ctx(recipient), async (client) => {
      const result = await clear(client);
      assert.equal(result.rowCount, 1);
      assert.equal(
        (await client.query("SELECT selected_tenant_id FROM app.staff_session")).rows[0].selected_tenant_id,
        null,
      );
      const evidence = (await client.query("SELECT * FROM app.control_command_audit")).rows;
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].action, "staff.support.selection.clear");
      assert.notEqual(evidence[0].session_binding, recipient.hash);
      await denied(client, "UPDATE app.control_command_audit SET principal_version=principal_version+1");
      await denied(client, "DELETE FROM app.control_command_audit");
    });
    for (const pool of [issuer, runtime, worker])
      await assert.rejects(
        pool.query("SELECT id FROM app.control_command_audit"),
        (error) => error.code === "42501",
      );
  });
  await probe("06_expired_revoked_and_noop_clear_without_eligible_grant_or_job", async () => {
    const expired = await grant(operator, recipient.user),
      revoked = await grant(operator, recipient.user);
    await fresh.query(
      "UPDATE app.support_access_grant SET expires_at=created_at+interval '1 millisecond'WHERE id=$1",
      [expired.id],
    );
    await fresh.query("UPDATE app.support_access_grant SET revoked_at=clock_timestamp()WHERE id=$1", [
      revoked.id,
    ]);
    for (const item of [expired, revoked])
      await tx(control, ctx(recipient), async (client) => {
        await select(client, recipient, item.tenant, item.id);
        assert.equal(
          (await client.query("SELECT app.control_grant_allows('')AS allowed")).rows[0].allowed,
          false,
        );
        await clear(client);
        assert.equal(
          (await client.query("SELECT selected_grant_id FROM app.staff_session")).rows[0].selected_grant_id,
          null,
        );
      });
    await tx(control, ctx(recipient), async (client) => {
      await clear(client);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM app.control_job WHERE requesting_staff_user_id=$1",
            [recipient.user],
          )
        ).rows[0].count,
        0,
      );
    });
  });
  await probe("07_corrupt_foreign_recipient_selection_clears_without_tenant_authority", async () => {
    const foreign = await grant(operator, operator.user, f.orgB);
    await tx(control, ctx(recipient), async (client) => {
      await select(client, recipient, foreign.tenant, foreign.id);
      assert.equal(
        (await client.query("SELECT app.control_grant_allows('')AS allowed")).rows[0].allowed,
        false,
      );
      assert.equal((await client.query("SELECT id FROM app.organization")).rowCount, 0);
      await clear(client);
      assert.equal(
        (await client.query("SELECT selected_grant_id FROM app.staff_session")).rows[0].selected_grant_id,
        null,
      );
      await denied(
        client,
        "INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id)VALUES($1,$2,'staff.support.selection.clear','support_access_grant',$3,$4)",
        [f.orgB, recipient.user, foreign.id, randomUUID()],
      );
    });
  });
  await probe("08_clear_bindings_reject_forgery_and_roll_back_with_caller", async () => {
    const count = (await fresh.query("SELECT count(*)::int AS count FROM app.control_command_audit")).rows[0]
      .count;
    await tx(control, ctx(recipient), async (client) => {
      await select(client, recipient, valid.tenant, valid.id);
    });
    await tx(
      control,
      ctx(recipient),
      async (client) => {
        for (const override of [
          { binding: "0".repeat(64) },
          { previous: "0".repeat(64) },
          { version: 999 },
          { principal: randomUUID() },
        ]) {
          await client.query("SAVEPOINT bad_clear");
          await assert.rejects(clear(client, randomUUID(), override), (error) => error.code === "42501");
          await client.query("ROLLBACK TO SAVEPOINT bad_clear");
        }
        await clear(client);
      },
      false,
    );
    assert.equal(
      (await fresh.query("SELECT count(*)::int AS count FROM app.control_command_audit")).rows[0].count,
      count,
    );
    await tx(control, ctx(recipient), async (client) => {
      assert.equal(
        (await client.query("SELECT selected_grant_id FROM app.staff_session")).rows[0].selected_grant_id,
        valid.id,
      );
      await clear(client);
    });
  });
  await probe("09_own_session_is_locked_through_clear_commit", async () => {
    const locked = await control.connect(),
      other = await control.connect();
    try {
      await locked.query("BEGIN");
      for (const [key, value] of Object.entries(ctx(recipient)))
        await locked.query("SELECT set_config($1,$2,true)", [key, value]);
      await clear(locked);
      const pid = (await other.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
      await other.query("BEGIN");
      for (const [key, value] of Object.entries(ctx(recipient)))
        await other.query("SELECT set_config($1,$2,true)", [key, value]);
      let completed = false;
      const update = other
        .query(
          "UPDATE app.staff_session SET selected_tenant_id=NULL,selected_grant_id=NULL WHERE token_hash=$1",
          [recipient.hash],
        )
        .then(() => {
          completed = true;
        });
      let waiting = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        waiting = (
          await fresh.query("SELECT wait_event_type='Lock'AS waiting FROM pg_stat_activity WHERE pid=$1", [
            pid,
          ])
        ).rows[0]?.waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(waiting, true);
      assert.equal(completed, false);
      await locked.query("COMMIT");
      await update;
      await other.query("COMMIT");
    } finally {
      await locked.query("ROLLBACK").catch(() => {});
      await other.query("ROLLBACK").catch(() => {});
      locked.release();
      other.release();
    }
  });
  await probe("10_session_expiry_is_rechecked_after_lock_wait", async () => {
    const short = await session("staff-support", recipient.user);
    await fresh.query(
      "UPDATE app.staff_session SET expires_at=clock_timestamp()+interval '800 milliseconds'WHERE token_hash=$1",
      [short.hash],
    );
    const lock = await fresh.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT token_hash FROM app.staff_session WHERE token_hash=$1 FOR UPDATE", [short.hash]);
    let pending, pid, started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    try {
      pending = tx(control, ctx(short), async (client) => {
        pid = (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
        const principal = (
          await fresh.query("SELECT id,row_version FROM app.staff_principal WHERE user_id=$1", [short.user])
        ).rows[0];
        started();
        return client.query(
          "INSERT INTO app.control_command_audit(staff_user_id,staff_principal_id,principal_version,session_binding,action,command_digest,trace_id)VALUES($1,$2,$3,$4,'staff.support.selection.clear',$5,$6)",
          [
            short.user,
            principal.id,
            principal.row_version,
            sha(`control-command-session-v1:${short.hash}`),
            sha(randomUUID()),
            randomUUID(),
          ],
        );
      });
      const deniedPromise = assert.rejects(pending, (error) => error.code === "42501");
      await ready;
      let waiting = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        waiting = (
          await fresh.query("SELECT wait_event_type='Lock'AS waiting FROM pg_stat_activity WHERE pid=$1", [
            pid,
          ])
        ).rows[0]?.waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(waiting, true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await lock.query("COMMIT");
      await deniedPromise;
    } finally {
      await lock.query("ROLLBACK").catch(() => {});
      lock.release();
    }
  });
  await probe("11_unselected_provisioning_bootstrap_and_completion_regression", async () => {
    const job = await withStaffTransaction(control, operator.token, (client, staff) =>
      new ControlProvisioningService(client, staff, randomUUID()).enqueue(
        { name: "Synthetic support policy regression", timezone: "UTC" },
        randomUUID(),
      ),
    );
    assert.equal(
      (await runProvisioning(control, operator.token, job.id, randomUUID(), randomUUID())).state,
      "succeeded",
    );
    const org = (await fresh.query("SELECT organization_id FROM app.control_job WHERE id=$1", [job.id]))
      .rows[0].organization_id;
    assert.equal(
      (await fresh.query("SELECT count(*)::int AS count FROM app.pipeline_stage WHERE tenant_id=$1", [org]))
        .rows[0].count,
      6,
    );
    assert.equal(
      (await fresh.query("SELECT count(*)::int AS count FROM app.entitlement WHERE tenant_id=$1", [org]))
        .rows[0].count,
      2,
    );
    assert.equal(
      (await fresh.query("SELECT status FROM app.organization WHERE id=$1", [org])).rows[0].status,
      "active",
    );
  });
  await probe("12_pooled_context_and_cross_session_evidence_are_private", async () => {
    assert.equal(
      (await control.query("SELECT count(*)::int AS count FROM app.control_command_audit")).rows[0].count,
      0,
    );
    const other = await session("staff-support", recipient.user);
    await tx(control, ctx(other), async (client) => {
      assert.equal(
        (await client.query("SELECT count(*)::int AS count FROM app.control_command_audit")).rows[0].count,
        0,
      );
    });
    assert.equal(
      (
        await control.query(
          "SELECT app.current_actor()AS actor,current_setting('app.staff_session_hash',true)AS hash",
        )
      ).rows[0].actor,
      null,
    );
    const immutable = (
      await fresh.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='app.control_command_audit'::regclass",
      )
    ).rows[0];
    assert.equal(immutable.relrowsecurity, true);
    assert.equal(immutable.relforcerowsecurity, true);
  });
  assert.equal(
    await globals(),
    globalBefore,
    "Existing global role attributes/memberships must remain unchanged.",
  );
  console.log(
    JSON.stringify({
      candidate: "passed",
      probes: passed.length,
      candidateSha256: sha(candidate),
      baseline: "0001-0014",
      globalRoles: "unchanged",
      newForcedRlsTables: 1,
      consumers: "not_started",
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ stage, state: "failed", safeCode: error.code ?? "verification_assertion" }));
  process.exitCode = 1;
} finally {
  await Promise.all(pools.map((pool) => pool.end()));
  try {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
