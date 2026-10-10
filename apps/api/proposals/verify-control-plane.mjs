// Proposal-only verifier. Run: node --import tsx apps/api/proposals/verify-control-plane.mjs
// Applies candidate SQL only to this invocation's checked disposable loopback database.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import pg from "pg";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import fixtureModule from "../../../packages/db/fixtures.ts";
import runtimeRoleModule from "../../../packages/db/runtime-role.ts";
import seedModule from "../../../packages/db/seed.ts";

const { fixtures: f } = fixtureModule;
const { assertRuntimeRole } = runtimeRoleModule;
const { seed } = seedModule;

const sourceUrl = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(sourceUrl.hostname),
  "Verifier requires loopback PostgreSQL.",
);
const suffix = randomBytes(8).toString("hex");
const database = `estate_control_probe_${suffix}`;
assert(/^estate_control_probe_[0-9a-f]{16}$/.test(database));
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.href });
const freshUrl = new URL(sourceUrl);
freshUrl.pathname = `/${database}`;
const fresh = new pg.Pool({ connectionString: freshUrl.href });
const ownedRoles = [];
const pools = [];
const passed = [];
const migrationHashes = [];
const separationChecks = [];
let created = false;
let stage = "initialize";
const id = {
  admin: randomUUID(),
  support: randomUUID(),
  inactive: randomUUID(),
  unverified: randomUUID(),
  nonstaff: randomUUID(),
};
const allPlatform = [
  "platform.orgs.provision",
  "platform.orgs.read",
  "platform.support.grant",
  "platform.health.read",
  "platform.config.read",
  "platform.audit.read",
  "platform.plans.read",
];
const reads = [
  "crm.contacts.read",
  "crm.leads.read",
  "crm.tasks.read",
  "crm.deals.read",
  "crm.pipeline.read",
  "crm.sources.read",
  "crm.tags.read",
];
const gucs = {
  actor: "app.actor_id",
  hash: "app.staff_session_hash",
  tenant: "app.tenant_id",
  grant: "app.support_grant_id",
  claim: "app.provision_claim",
  issuer: "app.auth_issuer",
  subject: "app.auth_subject",
};
const ownedTempRole = `estate_control_ancestor_${suffix}`;
let tempRoleCreated = false;

async function probe(label, fn) {
  stage = label;
  await fn();
  passed.push(label);
  console.log(JSON.stringify({ probe: label, state: "passed" }));
}
async function context(client, values) {
  for (const [key, value] of Object.entries(values)) {
    assert(Object.hasOwn(gucs, key));
    await client.query("SELECT set_config($1,$2,true)", [gucs[key], value]);
  }
}
async function tx(pool, values, fn, commit = true) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await context(client, values);
    const result = await fn(client);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function denied(client, sql, params = [], codes = ["42501"]) {
  await client.query("SAVEPOINT expected_denial");
  try {
    await client.query(sql, params);
    assert.fail("Expected database denial.");
  } catch (error) {
    if (!codes.includes(error.code)) {
      const failure = new Error("Unexpected safe SQLSTATE in denial probe.");
      failure.code = error.code;
      failure.denialKind = error.code === "ERR_ASSERTION" ? "unexpected_success" : "unexpected_sqlstate";
      throw failure;
    }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_denial");
    await client.query("RELEASE SAVEPOINT expected_denial");
  }
}
async function count(client, table) {
  assert(/^[a-z_]+$/.test(table));
  return (await client.query(`SELECT count(*)::int count FROM app.${table}`)).rows[0].count;
}
async function trackedMigration(name, sql) {
  const sha256 = createHash("sha256").update(sql).digest("hex");
  const prior = await fresh.query("SELECT sha256 FROM public.estate_migration WHERE name=$1", [name]);
  if (prior.rowCount) {
    assert.equal(prior.rows[0].sha256, sha256);
    return false;
  }
  assert(/^\d{4}-[a-z0-9-]+\.sql$/.test(name));
  await fresh.query(
    sql.replace(
      /COMMIT;/i,
      `INSERT INTO public.estate_migration(name,sha256)VALUES('${name}','${sha256}'); COMMIT;`,
    ),
  );
  migrationHashes.push({ name, sha256 });
  return true;
}
async function bool(client, expression, params = []) {
  return (await client.query(`SELECT ${expression} ok`, params)).rows[0].ok;
}
async function separated(pool, expected) {
  await assertRuntimeRole(pool);
  const result = await pool.query(`WITH RECURSIVE reachable AS (
    SELECT oid,rolname FROM pg_roles WHERE rolname=session_user UNION
    SELECT parent.oid,parent.rolname FROM pg_roles parent JOIN pg_auth_members membership ON membership.roleid=parent.oid JOIN reachable member_role ON membership.member=member_role.oid
  )SELECT session_user login,current_user current,array_agg(rolname::text) roles FROM reachable`);
  assert.equal(result.rows[0].login, expected);
  assert.equal(result.rows[0].current, expected);
  const crossing =
    expected === "estate_staff_issuer"
      ? ["estate_control", "estate_runtime", "estate_worker"]
      : expected === "estate_control"
        ? ["estate_staff_issuer", "estate_runtime", "estate_worker"]
        : ["estate_staff_issuer", "estate_control"];
  assert(!result.rows[0].roles.some((role) => crossing.includes(role)), "Expected isolated pool ancestry.");
}
async function rolePool(role, envKey, defaultPassword) {
  const existed = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount > 0;
  const configured = process.env[envKey];
  if (!existed) ownedRoles.push(role);
  return { role, existed, configured, defaultPassword };
}
async function connectRole(info) {
  let url;
  if (info.configured) {
    url = new URL(info.configured);
    assert.equal(url.hostname, sourceUrl.hostname);
    assert.equal(url.port, sourceUrl.port);
    assert.equal(url.username, info.role);
  } else {
    assert(
      !info.existed || info.defaultPassword,
      "An existing control/issuer login requires its explicitly configured URL.",
    );
    url = new URL(freshUrl);
    url.username = info.role;
    url.password = info.defaultPassword ?? randomBytes(32).toString("hex");
    if (!info.existed) {
      assert(/^[a-z_]+$/.test(info.role));
      assert(/^[0-9a-f]{64}$/.test(url.password));
      await admin.query(`ALTER ROLE ${info.role} PASSWORD '${url.password}'`);
    }
  }
  url.pathname = `/${database}`;
  const pool = new pg.Pool({ connectionString: url.href, max: 4 });
  pools.push(pool);
  return pool;
}

let control, issuer, runtime, worker, adminSession, supportSession, grantA, provision;
const adminCtx = () => ({ actor: id.admin, hash: adminSession.hash });
const supportCtx = () => ({ actor: id.support, hash: supportSession.hash });
const supported = (grant = grantA, tenant = f.orgA) => ({ ...supportCtx(), tenant, grant });
async function issue(user, subject, { active = true } = {}) {
  return tx(issuer, { issuer: "urn:estate:synthetic", subject }, async (client) => {
    const found = await client.query("SELECT id FROM app.user_identity WHERE issuer=$1 AND subject=$2", [
      "urn:estate:synthetic",
      subject,
    ]);
    assert.equal(found.rows[0]?.id, user);
    await context(client, { actor: user });
    const principal = await client.query(
      "SELECT id,user_id,active,row_version FROM app.staff_principal WHERE user_id=$1 FOR SHARE",
      [user],
    );
    assert.equal(principal.rowCount, active ? 1 : 0);
    const opaque = randomBytes(32).toString("hex"),
      hash = createHash("sha256").update(opaque).digest("hex"),
      csrf = randomBytes(32).toString("hex");
    const stamp = (await client.query("SELECT clock_timestamp() stamp")).rows[0].stamp;
    await client.query(
      "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,'synthetic-local',$4,$4::timestamptz+interval '8 hours')",
      [hash, user, csrf, stamp],
    );
    return { hash, csrf };
  });
}
async function grant(params = {}) {
  const value = {
    tenant: f.orgA,
    recipient: id.support,
    permissions: reads,
    reason: "Synthetic support verification",
    ...params,
  };
  const gid = randomUUID();
  await tx(control, adminCtx(), (client) =>
    client.query(
      "INSERT INTO app.support_access_grant(tenant_id,id,staff_user_id,permission_codes,reason,expires_at,issuing_staff_user_id,provenance,created_at)VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '30 minutes',$6,'synthetic-local',clock_timestamp())",
      [value.tenant, gid, value.recipient, value.permissions, value.reason, id.admin],
    ),
  );
  return gid;
}
async function selectGrant(gid, tenant = f.orgA) {
  await tx(control, supportCtx(), (client) =>
    client.query(
      "UPDATE app.staff_session SET selected_tenant_id=$1,selected_grant_id=$2 WHERE token_hash=$3",
      [tenant, gid, supportSession.hash],
    ),
  );
}
async function makeProvision() {
  const organizationId = randomUUID(),
    jobId = randomUUID(),
    claimId = randomUUID();
  await tx(control, adminCtx(), async (client) => {
    await client.query(
      "INSERT INTO app.organization(id,name,status)VALUES($1,'Synthetic proposal organization','provisioning')",
      [organizationId],
    );
    await client.query(
      "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id,bootstrap_policy)VALUES($1,$2,$3,'organization.provision','queued',$4,$5)",
      [jobId, organizationId, id.admin, f.ownerUser, { version: "synthetic-provisioning-v1" }],
    );
    await client.query(
      "UPDATE app.control_job SET state='running',claim_id=$1,lease_until=clock_timestamp()+interval '30 seconds',attempt_count=1,row_version=row_version+1 WHERE id=$2 AND state='queued'",
      [claimId, jobId],
    );
  });
  return { organizationId, jobId, claimId };
}
const provisionCtx = (p = provision) => ({ ...adminCtx(), tenant: p.organizationId, claim: p.claimId });

try {
  const controlInfo = await rolePool("estate_control", "CONTROL_DATABASE_URL");
  const issuerInfo = await rolePool("estate_staff_issuer", "STAFF_ISSUER_DATABASE_URL");
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  process.env.APP_ENV = "test";
  process.env.DEV_AUTH_ENABLED = "true";
  process.env.MIGRATION_DATABASE_URL = freshUrl.href;
  const runtimeUrl = new URL(freshUrl);
  runtimeUrl.username = "estate_runtime";
  runtimeUrl.password = "local-runtime-only";
  process.env.DATABASE_URL = runtimeUrl.href;
  stage = "baseline_migrations";
  await fresh.query(
    "CREATE TABLE public.estate_migration(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir("packages/db/migrations"))
    .filter((n) => /^\d{4}-.+\.sql$/.test(n) && Number(n.slice(0, 4)) <= 11)
    .sort())
    await trackedMigration(name, await readFile(`packages/db/migrations/${name}`, "utf8"));
  stage = "baseline_seed";
  await seed();
  stage = "candidate_migration";
  const candidate = await readFile("apps/api/proposals/0012-control-plane-provisioning.sql", "utf8");
  const normalizedCandidate = candidate.replaceAll("\r\n", "\n");
  await trackedMigration("0012-control-plane-provisioning.sql", candidate);
  assert.equal(await trackedMigration("0012-control-plane-provisioning.sql", candidate), false);
  control = await connectRole(controlInfo);
  issuer = await connectRole(issuerInfo);
  runtime = await connectRole({
    role: "estate_runtime",
    existed: true,
    defaultPassword: "local-runtime-only",
  });
  worker = await connectRole({ role: "estate_worker", existed: true, defaultPassword: "local-worker-only" });
  for (const [user, subject, verified] of [
    [id.admin, "probe-administrator", true],
    [id.support, "probe-support", true],
    [id.inactive, "probe-inactive", true],
    [id.unverified, "probe-unverified", false],
    [id.nonstaff, "probe-nonstaff", true],
  ])
    await fresh.query(
      "INSERT INTO app.user_identity(id,issuer,subject,display_name,email,email_verified)VALUES($1,'urn:estate:synthetic',$2,'Synthetic probe identity',$3,$4)",
      [user, subject, `${subject}@example.test`, verified],
    );
  for (const [user, codes, active] of [
    [id.admin, allPlatform, true],
    [id.support, ["platform.orgs.read", "platform.health.read", "platform.config.read"], true],
    [id.inactive, [], false],
    [id.unverified, [], true],
  ])
    await fresh.query("INSERT INTO app.staff_principal(user_id,permission_codes,active)VALUES($1,$2,$3)", [
      user,
      codes,
      active,
    ]);

  await probe("01_role_and_recursive_separation", async () => {
    await separated(control, "estate_control");
    await separated(issuer, "estate_staff_issuer");
    await separated(runtime, "estate_runtime");
    await separated(worker, "estate_worker");
    await assert.rejects(() => separated(issuer, "estate_control"));
    assert(/^[a-z_0-9]+$/.test(ownedTempRole));
    await admin.query(`CREATE ROLE ${ownedTempRole} NOLOGIN NOINHERIT`);
    tempRoleCreated = true;
    const block = normalizedCandidate.slice(
      normalizedCandidate.indexOf("DO $$ BEGIN\n  IF EXISTS("),
      normalizedCandidate.indexOf("-- Existing identity policies"),
    );
    assert(block.startsWith("DO $$"));
    try {
      // Only newly configured control/issuer roles gain parents during these probes.
      // Existing runtime/worker roles never acquire any new authority.
      for (const [login, pool, parents] of [
        ["estate_control", control, ["estate_runtime", "estate_worker", "estate_staff_issuer"]],
        ["estate_staff_issuer", issuer, ["estate_runtime", "estate_worker", "estate_control"]],
      ]) {
        for (const parent of parents) {
          await admin.query(`GRANT ${parent} TO ${login}`);
          try {
            await assert.rejects(() => separated(pool, login));
            await assert.rejects(
              () => fresh.query(block),
              (error) => error.code === "P0001",
            );
            separationChecks.push(`direct:${login}->${parent}`);
          } finally {
            await admin.query(`REVOKE ${parent} FROM ${login}`);
          }
          await admin.query(`GRANT ${parent} TO ${ownedTempRole}`);
          await admin.query(`GRANT ${ownedTempRole} TO ${login}`);
          try {
            await assert.rejects(() => separated(pool, login));
            await assert.rejects(
              () => fresh.query(block),
              (error) => error.code === "P0001",
            );
            separationChecks.push(`multi_hop_noinherit:${login}->${parent}`);
          } finally {
            await admin.query(`REVOKE ${ownedTempRole} FROM ${login}`);
            await admin.query(`REVOKE ${parent} FROM ${ownedTempRole}`);
          }
        }
      }
    } finally {
      await admin.query(`REVOKE ${ownedTempRole} FROM estate_control`);
      await admin.query(`REVOKE estate_staff_issuer FROM ${ownedTempRole}`);
      await admin.query(`DROP ROLE ${ownedTempRole}`);
      tempRoleCreated = false;
    }
  });
  await probe("02_direct_control_session_forgery_denied", async () => {
    for (const pool of [control, runtime, worker])
      await tx(
        pool,
        {
          actor: id.admin,
          issuer: "urn:estate:synthetic",
          subject: "probe-administrator",
          hash: randomBytes(32).toString("hex"),
        },
        async (client) => {
          await denied(
            client,
            "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,expires_at)VALUES($1,$2,$3,'synthetic-local',clock_timestamp()+interval '1 hour')",
            [randomBytes(32).toString("hex"), id.admin, randomBytes(32).toString("hex")],
          );
        },
      );
  });
  await probe("03_issuer_minimal_privileges_and_binding", async () => {
    adminSession = await issue(id.admin, "probe-administrator");
    supportSession = await issue(id.support, "probe-support");
    await tx(
      issuer,
      { issuer: "urn:estate:synthetic", subject: "probe-administrator", actor: id.admin },
      async (client) => {
        for (const sql of [
          "SELECT * FROM app.staff_session",
          "SELECT permission_codes FROM app.staff_principal",
          "SELECT * FROM app.organization",
          "SELECT * FROM app.control_job",
          "SELECT * FROM app.support_access_grant",
          "SELECT app.control_authorized('')",
          "DELETE FROM app.staff_session",
          "UPDATE app.staff_session SET expires_at=clock_timestamp()+interval '1 day'",
          "SELECT email FROM app.user_identity",
        ])
          await denied(client, sql);
        await denied(client, "UPDATE app.staff_principal SET row_version=row_version+1 WHERE user_id=$1", [
          id.admin,
        ]);
        const base =
          "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)VALUES($1,$2,$3,'synthetic-local',";
        for (const [actor, createdSql, expirySql] of [
          [id.support, "clock_timestamp()", "clock_timestamp()+interval '1 hour'"],
          [id.admin, "clock_timestamp()+interval '10 seconds'", "clock_timestamp()+interval '1 hour'"],
          [id.admin, "clock_timestamp()-interval '60 seconds'", "clock_timestamp()+interval '1 hour'"],
          [id.admin, "clock_timestamp()", "clock_timestamp()+interval '9 hours'"],
        ])
          await denied(client, `${base}${createdSql},${expirySql})`, [
            randomBytes(32).toString("hex"),
            actor,
            randomBytes(32).toString("hex"),
          ]);
        await denied(
          client,
          "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,expires_at,selected_tenant_id,selected_grant_id)VALUES($1,$2,$3,'synthetic-local',clock_timestamp()+interval '1 hour',$4,$5)",
          [randomBytes(32).toString("hex"), id.admin, randomBytes(32).toString("hex"), f.orgA, randomUUID()],
        );
      },
    );
    for (const [actor, subject] of [
      [id.inactive, "probe-inactive"],
      [id.unverified, "probe-unverified"],
      [id.nonstaff, "probe-nonstaff"],
    ])
      await tx(issuer, { issuer: "urn:estate:synthetic", subject, actor }, async (client) => {
        assert.equal(await count(client, "staff_principal"), 0);
        await denied(
          client,
          "INSERT INTO app.staff_session(token_hash,staff_user_id,csrf_token,provenance,expires_at)VALUES($1,$2,$3,'synthetic-local',clock_timestamp()+interval '1 hour')",
          [randomBytes(32).toString("hex"), actor, randomBytes(32).toString("hex")],
        );
      });
    await tx(issuer, {}, async (client) => {
      assert.equal(await count(client, "user_identity"), 0);
      assert.equal(await count(client, "staff_principal"), 0);
    });
  });
  await probe("04_issuer_principal_revocation_lock", async () => {
    const held = await issuer.connect(),
      revoker = await fresh.connect();
    try {
      await held.query("BEGIN");
      await context(held, { issuer: "urn:estate:synthetic", subject: "probe-support", actor: id.support });
      await held.query("SELECT id FROM app.staff_principal WHERE user_id=$1 FOR SHARE", [id.support]);
      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout='150ms'");
      await assert.rejects(
        () => revoker.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [id.support]),
        (error) => error.code === "55P03",
      );
      await revoker.query("ROLLBACK");
      await held.query("COMMIT");
      await fresh.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [id.support]);
      await tx(control, supportCtx(), async (client) =>
        assert.equal(await bool(client, "app.control_authorized('')"), false),
      );
    } finally {
      await held.query("ROLLBACK").catch(() => {});
      await revoker.query("ROLLBACK").catch(() => {});
      held.release();
      revoker.release();
      await fresh.query("UPDATE app.staff_principal SET active=true WHERE user_id=$1", [id.support]);
    }
  });
  await probe("05_missing_context_and_forged_authority", async () => {
    for (const values of [
      {},
      {
        actor: id.admin,
        hash: randomBytes(32).toString("hex"),
        tenant: f.orgA,
        grant: randomUUID(),
        claim: randomUUID(),
      },
      { actor: id.admin, hash: supportSession.hash },
      { actor: id.support, hash: adminSession.hash },
      { actor: f.ownerUser, issuer: "urn:estate:synthetic", subject: "owner" },
      { actor: id.admin, issuer: "urn:estate:synthetic", subject: "probe-administrator" },
    ])
      await tx(control, values, async (client) => {
        assert.equal(await bool(client, "app.control_authorized('')"), false);
        for (const table of [
          "organization",
          "control_job",
          "control_idempotency",
          "contact",
          "user_identity",
          "staff_principal",
        ])
          assert.equal(await count(client, table), 0);
        await denied(client, "SELECT email,phone FROM app.user_identity");
        await denied(
          client,
          "INSERT INTO app.organization(name,status)VALUES('Synthetic unauthorized organization','provisioning')",
        );
      });
    await tx(control, { actor: "malformed-uuid", hash: adminSession.hash }, (client) =>
      denied(client, "SELECT app.control_authorized('')", [], ["22P02"]),
    );
  });
  await probe("06_current_permission_principal_and_session_revocation", async () => {
    await tx(control, adminCtx(), async (client) => {
      assert.equal(await bool(client, "app.control_authorized('platform.orgs.provision')"), true);
      await client.query(
        "INSERT INTO app.control_idempotency(staff_user_id,route_key,key,request_hash,response_body,status_code)VALUES($1,'probe.provision','exact',$2,'{}',202)",
        [id.admin, randomBytes(32).toString("hex")],
      );
    });
    await fresh.query(
      "UPDATE app.staff_principal SET permission_codes=array_remove(permission_codes,'platform.orgs.provision')WHERE user_id=$1",
      [id.admin],
    );
    await tx(control, adminCtx(), async (client) => {
      assert.equal(await bool(client, "app.control_authorized('platform.orgs.provision')"), false);
      await denied(
        client,
        "INSERT INTO app.organization(name,status)VALUES('Synthetic denied replay','provisioning')",
      );
    });
    await fresh.query("UPDATE app.staff_principal SET permission_codes=$2 WHERE user_id=$1", [
      id.admin,
      allPlatform,
    ]);
    for (const change of ["principal", "session"]) {
      if (change === "principal")
        await fresh.query("UPDATE app.staff_principal SET active=false WHERE user_id=$1", [id.admin]);
      else
        await fresh.query(
          "UPDATE app.staff_session SET expires_at=created_at+interval '1 microsecond'WHERE token_hash=$1",
          [adminSession.hash],
        );
      await tx(control, adminCtx(), async (client) => {
        assert.equal(await bool(client, "app.control_authorized('')"), false);
        assert.equal(await count(client, "control_idempotency"), 0);
      });
      if (change === "principal")
        await fresh.query("UPDATE app.staff_principal SET active=true WHERE user_id=$1", [id.admin]);
      else adminSession = await issue(id.admin, "probe-administrator");
    }
    const old = adminSession;
    await tx(control, adminCtx(), (client) =>
      client.query("DELETE FROM app.staff_session WHERE token_hash=$1", [old.hash]),
    );
    await tx(control, { actor: id.admin, hash: old.hash }, async (client) =>
      assert.equal(await bool(client, "app.control_authorized('')"), false),
    );
    adminSession = await issue(id.admin, "probe-administrator");
    await tx(control, adminCtx(), async (client) => {
      for (const col of [
        "token_hash",
        "csrf_token",
        "staff_user_id",
        "expires_at",
        "provenance",
        "created_at",
      ])
        await denied(client, `UPDATE app.staff_session SET ${col}=${col} WHERE token_hash=$1`, [
          adminSession.hash,
        ]);
    });
  });
  await probe("07_transaction_local_context_pool_reuse", async () => {
    const client = await control.connect();
    try {
      for (const ending of ["COMMIT", "ROLLBACK"]) {
        await client.query("BEGIN");
        await context(client, adminCtx());
        assert.equal(await bool(client, "app.control_authorized('')"), true);
        await client.query(ending);
        await client.query("BEGIN");
        assert.equal(await bool(client, "app.control_authorized('')"), false);
        await client.query("COMMIT");
      }
    } finally {
      client.release();
    }
  });
  await probe("08_grant_binding_allowlist_and_source_privileges", async () => {
    grantA = await grant();
    await selectGrant(grantA);
    await tx(control, supported(), async (client) => {
      assert.equal(await bool(client, "app.control_grant_allows('crm.contacts.read')"), true);
      assert.equal(await count(client, "contact"), 1);
      assert.equal(await count(client, "lead"), 1);
      for (const sql of [
        "INSERT INTO app.contact(tenant_id,display_name)VALUES('10000000-0000-4000-8000-000000000001','Synthetic')",
        "UPDATE app.contact SET display_name=display_name",
        "SELECT * FROM app.note",
        "SELECT * FROM app.export_job",
        "UPDATE app.entitlement SET state=state",
        "SELECT secret_ref FROM app.integration_connection",
        "SELECT safe_config FROM app.integration_connection",
        "SELECT safe_diff FROM app.audit_event",
      ])
        await denied(client, sql, [], ["42501", "42P01"]);
    });
    for (const values of [
      supportCtx(),
      supported(grantA, f.orgB),
      supported(randomUUID()),
      { ...adminCtx(), tenant: f.orgA, grant: grantA },
    ])
      await tx(control, values, async (client) => {
        assert.equal(await bool(client, "app.control_grant_allows('crm.contacts.read')"), false);
        assert.equal(await count(client, "contact"), 0);
      });
    const contactsOnly = await grant({ permissions: ["crm.contacts.read"] });
    await selectGrant(contactsOnly);
    await tx(control, supported(contactsOnly), async (client) => {
      assert.equal(await count(client, "contact"), 1);
      assert.equal(await count(client, "lead"), 0);
      assert.equal(await count(client, "task"), 0);
    });
    await selectGrant(grantA);
    await tx(control, adminCtx(), async (client) => {
      for (const [recipient, permissions, reason, expiry] of [
        [id.inactive, reads, "Synthetic", "30 minutes"],
        [id.support, [], "Synthetic", "30 minutes"],
        [id.support, ["crm.contacts.write"], "Synthetic", "30 minutes"],
        [id.support, ["crm.contacts.read", "crm.contacts.read"], "Synthetic", "30 minutes"],
        [id.support, reads, "   ", "30 minutes"],
        [id.support, reads, "Synthetic", "2 hours"],
      ])
        await denied(
          client,
          `INSERT INTO app.support_access_grant(tenant_id,id,staff_user_id,permission_codes,reason,expires_at,issuing_staff_user_id,provenance,created_at)VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '${expiry}',$6,'synthetic-local',clock_timestamp())`,
          [f.orgA, randomUUID(), recipient, permissions, reason, id.admin],
          ["42501", "23514"],
        );
      for (const col of [
        "expires_at",
        "permission_codes",
        "reason",
        "staff_user_id",
        "issuing_staff_user_id",
        "provenance",
      ])
        await denied(client, `UPDATE app.support_access_grant SET ${col}=${col} WHERE id=$1`, [grantA]);
    });
  });
  await probe("09_revoked_expired_legacy_grants_and_no_resurrection", async () => {
    const stale = await grant();
    await selectGrant(stale);
    await tx(control, adminCtx(), async (client) =>
      assert.equal(
        (
          await client.query(
            "UPDATE app.support_access_grant SET revoked_at=clock_timestamp(),row_version=row_version+1 WHERE id=$1",
            [stale],
          )
        ).rowCount,
        1,
      ),
    );
    await tx(control, supported(stale), async (client) => {
      assert.equal(await bool(client, "app.control_grant_allows('')"), false);
      assert.equal(await count(client, "contact"), 0);
    });
    await tx(control, adminCtx(), async (client) => {
      assert.equal(
        (await client.query("UPDATE app.support_access_grant SET revoked_at=NULL WHERE id=$1", [stale]))
          .rowCount,
        0,
      );
      await denied(client, "UPDATE app.support_access_grant SET revoked_at=NULL WHERE id=$1", [grantA]);
    });
    const expired = await grant();
    await fresh.query(
      "UPDATE app.support_access_grant SET expires_at=created_at+interval '1 microsecond'WHERE id=$1",
      [expired],
    );
    await selectGrant(expired);
    await tx(control, supported(expired), async (client) => assert.equal(await count(client, "contact"), 0));
    const legacy = randomUUID();
    await fresh.query(
      "INSERT INTO app.support_access_grant(tenant_id,id,staff_user_id,permission_codes,reason,expires_at)VALUES($1,$2,$3,$4,'Synthetic legacy fixture',clock_timestamp()+interval '30 minutes')",
      [f.orgA, legacy, id.support, reads],
    );
    await selectGrant(legacy);
    await tx(control, supported(legacy), async (client) => assert.equal(await count(client, "contact"), 0));
    await selectGrant(grantA);
    const withinRead = await grant();
    await fresh.query(
      "UPDATE app.support_access_grant SET expires_at=clock_timestamp()+interval '250 milliseconds'WHERE id=$1",
      [withinRead],
    );
    await selectGrant(withinRead);
    await tx(control, supported(withinRead), async (client) => {
      assert.equal(await bool(client, "app.control_grant_allows('crm.contacts.read')"), true);
      await client.query("SELECT pg_sleep(0.3)");
      assert.equal(await bool(client, "app.control_grant_allows('crm.contacts.read')"), false);
      assert.equal(await count(client, "contact"), 0);
    });
    await selectGrant(grantA);
  });
  await probe("10_support_lock_races_and_recipient_helper", async () => {
    const held = await control.connect(),
      revoker = await fresh.connect();
    try {
      await held.query("BEGIN");
      await context(held, supported());
      await held.query("SELECT id FROM app.staff_principal WHERE user_id=$1 FOR SHARE", [id.support]);
      await held.query("SELECT token_hash FROM app.staff_session WHERE token_hash=$1 FOR SHARE", [
        supportSession.hash,
      ]);
      await held.query("SELECT id FROM app.support_access_grant WHERE id=$1 FOR SHARE", [grantA]);
      for (const [sql, args] of [
        ["UPDATE app.staff_principal SET active=false WHERE user_id=$1", [id.support]],
        ["DELETE FROM app.staff_session WHERE token_hash=$1", [supportSession.hash]],
        ["UPDATE app.support_access_grant SET revoked_at=clock_timestamp()WHERE id=$1", [grantA]],
      ]) {
        await revoker.query("BEGIN");
        await revoker.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(
          () => revoker.query(sql, args),
          (error) => error.code === "55P03",
        );
        await revoker.query("ROLLBACK");
      }
      await held.query("COMMIT");
    } finally {
      await held.query("ROLLBACK").catch(() => {});
      await revoker.query("ROLLBACK").catch(() => {});
      held.release();
      revoker.release();
    }
    await tx(control, adminCtx(), async (client) => {
      assert.equal(await bool(client, "app.control_staff_recipient_active($1)", [id.support]), true);
      assert.equal(await bool(client, "app.control_staff_recipient_active($1)", [id.inactive]), false);
    });
    for (const pool of [issuer, runtime, worker])
      await tx(pool, {}, (client) =>
        denied(client, "SELECT app.control_staff_recipient_active($1)", [id.support]),
      );
    assert.equal(await bool(fresh, "app.control_staff_recipient_active($1)", [id.support]), false);
  });
  await probe("11_owned_claim_and_safe_initial_job", async () => {
    for (const status of ["active", "suspended", "archived"]) {
      const organizationId = status === "active" ? f.orgA : randomUUID(),
        jobId = randomUUID(),
        claimId = randomUUID();
      if (status !== "active")
        await fresh.query(
          "INSERT INTO app.organization(id,name,status)VALUES($1,'Synthetic non-provisioning probe',$2)",
          [organizationId, status],
        );
      await tx(control, adminCtx(), (client) =>
        denied(
          client,
          "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id)VALUES($1,$2,$3,'organization.provision','queued',$4)",
          [jobId, organizationId, id.admin, f.ownerUser],
        ),
      );
      // An administrator-injected legacy running row also must not grant active-tenant seeding.
      await fresh.query(
        "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id,claim_id,lease_until)VALUES($1,$2,$3,'organization.provision','running',$4,$5,clock_timestamp()+interval '30 seconds')",
        [jobId, organizationId, id.admin, f.ownerUser, claimId],
      );
      await tx(control, { ...adminCtx(), tenant: organizationId, claim: claimId }, async (client) => {
        assert.equal(await bool(client, "app.control_provision_claim_current($1)", [organizationId]), true);
        assert.equal(await bool(client, "app.control_can_seed($1)", [organizationId]), false);
        await denied(
          client,
          "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants,builtin)VALUES($1,$2,'Synthetic illicit Owner','[]',true)",
          [organizationId, randomUUID()],
        );
        await denied(
          client,
          "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'synthetic-illicit-feature','enabled')",
          [organizationId],
        );
        if (status === "active")
          await denied(
            client,
            "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic illicit staff Owner')",
            [organizationId, randomUUID(), id.admin, fixtureModule.roleId(1, 1)],
          );
        assert.equal(
          (await client.query("UPDATE app.organization SET status='active'WHERE id=$1", [organizationId]))
            .rowCount,
          0,
        );
      });
    }
    provision = await makeProvision();
    await tx(control, provisionCtx(), async (client) => {
      assert.equal(await bool(client, "app.control_can_seed($1)", [provision.organizationId]), true);
      await client.query(
        "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants,builtin)VALUES($1,$2,'Synthetic probe role','[]',true)",
        [provision.organizationId, randomUUID()],
      );
    });
    for (const values of [
      adminCtx(),
      { ...provisionCtx(), claim: randomUUID() },
      { ...supportCtx(), tenant: provision.organizationId, claim: provision.claimId },
    ])
      await tx(control, values, async (client) => {
        assert.equal(await bool(client, "app.control_can_seed($1)", [provision.organizationId]), false);
        await denied(
          client,
          "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,'Synthetic denied role','[]')",
          [provision.organizationId, randomUUID()],
        );
      });
    await tx(control, adminCtx(), async (client) => {
      await denied(
        client,
        "INSERT INTO app.control_job(organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id,claim_id,lease_until)VALUES($1,$2,'organization.provision','succeeded',$3,$4,clock_timestamp()+interval '1 minute')",
        [f.orgA, id.admin, f.ownerUser, randomUUID()],
      );
      assert.equal(
        (
          await client.query("UPDATE app.organization SET status='active'WHERE id=$1", [
            provision.organizationId,
          ])
        ).rowCount,
        0,
      );
    });
  });
  await probe("12_clock_expiry_blocks_seed_and_success", async () => {
    const p = await makeProvision();
    await fresh.query(
      "UPDATE app.control_job SET lease_until=clock_timestamp()+interval '150 milliseconds'WHERE id=$1",
      [p.jobId],
    );
    await tx(control, provisionCtx(p), async (client) => {
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), true);
      await client.query("SELECT pg_sleep(0.2)");
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), false);
      await denied(
        client,
        "INSERT INTO app.lead_source(tenant_id,id,code,label)VALUES($1,$2,'synthetic-expired','Synthetic expired')",
        [p.organizationId, randomUUID()],
      );
      assert.equal(
        (await client.query("UPDATE app.organization SET status='active'WHERE id=$1", [p.organizationId]))
          .rowCount,
        0,
      );
      await denied(client, "UPDATE app.control_job SET state='succeeded'WHERE id=$1", [p.jobId]);
    });
    assert.equal(
      (await fresh.query("SELECT status FROM app.organization WHERE id=$1", [p.organizationId])).rows[0]
        .status,
      "provisioning",
    );
  });
  await probe("13_claim_takeover_and_conditional_completion", async () => {
    const p = await makeProvision(),
      next = randomUUID();
    await fresh.query("UPDATE app.control_job SET claim_id=$1,row_version=row_version+1 WHERE id=$2", [
      next,
      p.jobId,
    ]);
    await tx(control, provisionCtx(p), async (client) => {
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), false);
      assert.equal(
        (
          await client.query(
            "UPDATE app.control_job SET state='failed'WHERE id=$1 AND claim_id=$2 AND row_version=2",
            [p.jobId, p.claimId],
          )
        ).rowCount,
        0,
      );
      await denied(client, "UPDATE app.control_job SET state='succeeded'WHERE id=$1", [p.jobId]);
    });
    await tx(control, provisionCtx({ ...p, claimId: next }), async (client) => {
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), true);
      await client.query(
        "UPDATE app.organization SET status='active',row_version=row_version+1 WHERE id=$1",
        [p.organizationId],
      );
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), false);
      await denied(
        client,
        "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants)VALUES($1,$2,'Synthetic late seed','[]')",
        [p.organizationId, randomUUID()],
      );
      assert.equal(
        (
          await client.query(
            "UPDATE app.control_job SET state='succeeded',row_version=row_version+1 WHERE id=$1 AND claim_id=$2 AND row_version=3",
            [p.jobId, next],
          )
        ).rowCount,
        1,
      );
      assert.equal(await bool(client, "app.control_provision_claim_current($1)", [p.organizationId]), false);
      assert.equal(await bool(client, "app.control_can_seed($1)", [p.organizationId]), false);
      assert.equal(
        (await client.query("UPDATE app.control_job SET state='running'WHERE id=$1", [p.jobId])).rowCount,
        0,
      );
    });
  });
  await probe("14_transactional_module_seed_rollback", async () => {
    const p = await makeProvision(),
      roleId = randomUUID(),
      memberId = randomUUID(),
      sourceId = randomUUID();
    const ownerReader = await control.connect(),
      ownerWriter = await fresh.connect();
    let ownerVersion;
    try {
      await ownerReader.query("BEGIN");
      await context(ownerReader, { ...provisionCtx(p), issuer: "urn:estate:synthetic", subject: "owner" });
      const lockedOwner = await ownerReader.query(
        "SELECT id,row_version FROM app.user_identity WHERE id=$1 FOR SHARE",
        [f.ownerUser],
      );
      assert.equal(lockedOwner.rowCount, 1);
      ownerVersion = lockedOwner.rows[0].row_version;
      await denied(ownerReader, "UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1", [
        f.ownerUser,
      ]);
      await ownerReader.query("UPDATE app.organization SET status='active'WHERE id=$1", [p.organizationId]);
      for (const sql of [
        "UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1",
        "UPDATE app.user_identity SET email_verified=false WHERE id=$1",
      ]) {
        await ownerWriter.query("BEGIN");
        await ownerWriter.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(
          () => ownerWriter.query(sql, [f.ownerUser]),
          (error) => error.code === "55P03",
        );
        await ownerWriter.query("ROLLBACK");
      }
      await ownerReader.query("ROLLBACK");
      await fresh.query("UPDATE app.user_identity SET row_version=row_version+1 WHERE id=$1", [f.ownerUser]);
      await tx(
        control,
        { ...adminCtx(), issuer: "urn:estate:synthetic", subject: "owner" },
        async (client) => {
          assert.equal(
            (
              await client.query("SELECT id FROM app.user_identity WHERE id=$1 AND row_version=$2", [
                f.ownerUser,
                ownerVersion,
              ])
            ).rowCount,
            0,
          );
        },
      );
      await fresh.query("UPDATE app.user_identity SET email_verified=false WHERE id=$1", [f.ownerUser]);
      await tx(
        control,
        { ...adminCtx(), issuer: "urn:estate:synthetic", subject: "owner" },
        async (client) => {
          assert.equal(await count(client, "user_identity"), 0);
        },
      );
    } finally {
      await ownerReader.query("ROLLBACK").catch(() => {});
      await ownerWriter.query("ROLLBACK").catch(() => {});
      ownerReader.release();
      ownerWriter.release();
      await fresh.query(
        "UPDATE app.user_identity SET email_verified=true,row_version=row_version+1 WHERE id=$1",
        [f.ownerUser],
      );
    }
    const eventId = randomUUID(),
      stamp = new Date().toISOString();
    const event = {
      eventId,
      type: "integration.state_changed",
      version: 1,
      tenantId: p.organizationId,
      occurredAt: stamp,
      ingestedAt: stamp,
      producer: "control-plane",
      aggregateType: "organization",
      aggregateId: p.organizationId,
      correlationId: randomUUID(),
      payload: {
        resourceId: p.organizationId,
        resourceVersion: 1,
        relatedResourceIds: [p.jobId],
        safeCode: "bootstrap_core_ready",
      },
    };
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    assert(ajv.compile(JSON.parse(await readFile("packages/contracts/events.schema.json", "utf8")))(event));
    await assert.rejects(
      () =>
        tx(control, provisionCtx(p), async (client) => {
          await client.query(
            "INSERT INTO app.role_definition(tenant_id,id,name,permission_grants,builtin)VALUES($1,$2,'Owner','[]',true)",
            [p.organizationId, roleId],
          );
          await client.query(
            "INSERT INTO app.membership(tenant_id,id,user_id,role_id,status,display_name)VALUES($1,$2,$3,$4,'active','Synthetic owner')",
            [p.organizationId, memberId, f.ownerUser, roleId],
          );
          await client.query(
            "INSERT INTO app.business_profile(tenant_id,name)VALUES($1,'Synthetic rollback profile')",
            [p.organizationId],
          );
          await client.query(
            "INSERT INTO app.pipeline_stage(tenant_id,name,position)VALUES($1,'Uncontacted',0)",
            [p.organizationId],
          );
          await client.query(
            "INSERT INTO app.lead_source(tenant_id,id,code,label)VALUES($1,$2,'synthetic-rollback','Synthetic rollback')",
            [p.organizationId, sourceId],
          );
          await client.query(
            "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'crm','enabled')",
            [p.organizationId],
          );
          await client.query(
            "INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id)VALUES($1,$2,'organization.provisioned','organization',$4,$3)",
            [p.organizationId, id.admin, randomUUID(), p.organizationId],
          );
          await client.query(
            "INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload)VALUES($1,$2,'integration.state_changed',$3,$4)",
            [p.organizationId, eventId, p.organizationId, event],
          );
          await client.query("UPDATE app.organization SET status='active'WHERE id=$1", [p.organizationId]);
          await client.query("UPDATE app.control_job SET state='succeeded'WHERE id=$1 AND claim_id=$2", [
            p.jobId,
            p.claimId,
          ]);
          throw new Error("controlled_caller_rollback");
        }),
      (error) => {
        if (error.message !== "controlled_caller_rollback") throw error;
        return true;
      },
    );
    for (const table of [
      "role_definition",
      "membership",
      "business_profile",
      "pipeline_stage",
      "lead_source",
      "entitlement",
      "audit_event",
      "outbox",
    ])
      assert.equal(
        (
          await fresh.query(`SELECT count(*)::int count FROM app.${table} WHERE tenant_id=$1`, [
            p.organizationId,
          ])
        ).rows[0].count,
        0,
      );
    assert.equal(
      (await fresh.query("SELECT status FROM app.organization WHERE id=$1", [p.organizationId])).rows[0]
        .status,
      "provisioning",
    );
    assert.equal(
      (await fresh.query("SELECT state FROM app.control_job WHERE id=$1", [p.jobId])).rows[0].state,
      "running",
    );
  });
  await probe("15_forced_rls_minimal_grants_and_existing_runtime", async () => {
    assert.equal(
      (
        await fresh.query(
          "SELECT count(*)::int count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'AND c.relname IN('staff_session','control_job','control_idempotency')AND c.relrowsecurity AND c.relforcerowsecurity",
        )
      ).rows[0].count,
      3,
    );
    for (const pool of [runtime, worker])
      await tx(pool, { actor: f.ownerUser, tenant: f.orgA }, async (client) => {
        for (const table of ["staff_session", "control_job", "control_idempotency"])
          await denied(client, `SELECT * FROM app.${table}`);
      });
    await tx(control, adminCtx(), async (client) => {
      await context(client, { issuer: "urn:estate:synthetic", subject: "owner" });
      const approvedOwner = await client.query(
        "SELECT id,issuer,subject,display_name,email_verified,row_version FROM app.user_identity",
      );
      assert.equal(approvedOwner.rowCount, 1);
      assert.equal(approvedOwner.rows[0].id, f.ownerUser);
      await denied(client, "SELECT email,phone FROM app.user_identity");
      for (const sql of [
        "UPDATE app.control_idempotency SET key=key",
        "DELETE FROM app.control_idempotency",
        "TRUNCATE app.control_idempotency",
      ])
        await denied(client, sql);
      assert(
        (
          await client.query(
            "SELECT tenant_id,id,actor_ref,action,resource_type,resource_id,trace_id,created_at FROM app.audit_event",
          )
        ).rowCount >= 0,
      );
    });
    await tx(runtime, { actor: f.ownerUser, tenant: f.orgA }, async (client) => {
      assert.equal(await count(client, "contact"), 1);
      assert.equal(
        (await client.query("SELECT id FROM app.user_identity WHERE id=$1", [f.ownerUser])).rowCount,
        1,
      );
    });
    await tx(runtime, { issuer: "urn:estate:synthetic", subject: "owner" }, async (client) =>
      assert.equal(
        (
          await client.query(
            "SELECT id FROM app.user_identity WHERE issuer='urn:estate:synthetic'AND subject='owner'",
          )
        ).rowCount,
        1,
      ),
    );
  });
  const report = {
    controlPlaneCandidate: "passed",
    probes: passed.length,
    newForcedRlsTables: 3,
    runtimeConsumers: "not_started",
    productionIdentity: "unconfigured",
    verifiedAt: new Date().toISOString(),
    candidateChecksumReplay: "passed",
    checks: passed,
    separationChecks,
    migrations: migrationHashes,
    unimplementedGates: [
      "verified OIDC staff issuance consumer",
      "HTTP CSRF/mode/socket/banner",
      "current replay/principal/grant application ports",
      "complete bootstrap module defaults and failure/retry orchestration",
    ],
  };
  await writeFile(
    "apps/api/proposals/control-plane-verification.json",
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      controlPlaneCandidate: report.controlPlaneCandidate,
      probes: report.probes,
      newForcedRlsTables: report.newForcedRlsTables,
      candidateChecksumReplay: report.candidateChecksumReplay,
      runtimeConsumers: report.runtimeConsumers,
      productionIdentity: report.productionIdentity,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      controlPlaneCandidate: "failed",
      stage,
      passed: passed.length,
      sqlstate: /^[A-Z0-9]{5}$/.test(error.code ?? "") ? error.code : null,
      position: /^\d+$/.test(error.position ?? "") ? Number(error.position) : null,
      verifierLine: Number(error.stack?.match(/verify-control-plane\.mjs:(\d+):\d+/)?.[1] ?? 0) || null,
      denialKind: error.denialKind ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const pool of pools) await pool.end().catch(() => {});
  await fresh.end().catch(() => {});
  if (tempRoleCreated) {
    await admin.query(`REVOKE ${ownedTempRole} FROM estate_control`).catch(() => {});
    await admin.query(`REVOKE estate_staff_issuer FROM ${ownedTempRole}`).catch(() => {});
    await admin.query(`DROP ROLE ${ownedTempRole}`).catch(() => {});
  }
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  for (const role of ownedRoles.reverse()) {
    assert(["estate_control", "estate_staff_issuer"].includes(role));
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }
  await admin.end();
}
