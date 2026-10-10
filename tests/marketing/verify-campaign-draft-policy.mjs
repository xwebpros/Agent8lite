// Candidate-only real-login probes. No listeners, shared fixtures, or cluster-role writes.
// Run: node --import tsx tests/marketing/verify-campaign-draft-policy.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import fixtureModule from "../../packages/db/fixtures.ts";
import seedModule from "../../packages/db/seed.ts";
import tenantModule from "../../packages/db/tenant-transaction.ts";
import runtimeModule from "../../packages/db/runtime-role.ts";
import staffModule from "../../packages/db/staff-pools.ts";

const { fixtures } = fixtureModule;
const { withTenantTransaction } = tenantModule;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const database = `estate_marketing_policy_${randomBytes(8).toString("hex")}`;
assert(/^estate_marketing_policy_[0-9a-f]{16}$/.test(database));
const source = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
assert(["127.0.0.1", "localhost", "[::1]"].includes(source.hostname), "Loopback PostgreSQL required.");
assert(["postgres:", "postgresql:"].includes(source.protocol), "PostgreSQL URL required.");
const clusterUrl = new URL(source);
clusterUrl.pathname = "/postgres";
const freshUrl = new URL(source);
freshUrl.pathname = "/" + database;
const cluster = new pg.Pool({ connectionString: clusterUrl.href, max: 1 });
const fresh = new pg.Pool({ connectionString: freshUrl.href, max: 1 });
const pools = [fresh];
const identities = [
  ["estate_runtime", "DATABASE_URL", "local-runtime-only"],
  ["estate_worker", "WORKER_DATABASE_URL", "local-worker-only"],
  ["estate_control", "CONTROL_DATABASE_URL", "local-control-only"],
  ["estate_staff_issuer", "STAFF_ISSUER_DATABASE_URL", "local-staff-issuer-only"],
];
const rolePools = {};
for (const [role, variable, password] of identities) {
  const url = new URL(process.env[variable] ?? source);
  if (process.env[variable]) assert.equal(url.username, role, "Explicit role URL must use its own login.");
  else {
    url.username = role;
    url.password = password;
  }
  assert.equal(
    url.hostname,
    source.hostname,
    "All verifier identities must share the selected local server.",
  );
  assert.equal(url.port, source.port);
  url.pathname = "/" + database;
  process.env[variable] = url.href;
  rolePools[role] = new pg.Pool({ connectionString: url.href, max: 1 });
  pools.push(rolePools[role]);
}
const runtime = rolePools.estate_runtime;
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
const draftA = randomUUID(),
  draftB = randomUUID();
const nonDraft = new Map(["active", "paused", "archived"].map((state) => [state, randomUUID()]));
const prohibited = [
  "campaign_version",
  "campaign_step",
  "message_design",
  "automation_rule",
  "enrollment",
  "scheduled_action",
  "delivery_attempt",
];
const candidatePath = "docs/proposals/W06/campaign-draft-policy.proposed.sql";
const candidate = await readFile(candidatePath, "utf8");
assert(!/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i.test(candidate), "Candidate cannot mutate cluster roles.");
const candidateHash = sha(candidate);
const passed = [];
let created = false,
  dropped = false,
  globalRolesUnchanged = false,
  stage = "initialize",
  globalsBefore,
  failure;

async function globals() {
  const roles = (
    await cluster.query(
      "SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)ORDER BY rolname",
      [identities.map(([role]) => role)],
    )
  ).rows;
  assert.equal(roles.length, 4, "Existing configured roles are required; this verifier never creates them.");
  const memberships = (
    await cluster.query(
      "SELECT roleid,member,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member",
    )
  ).rows;
  return sha(JSON.stringify({ roles, memberships }));
}
async function probe(label, operation) {
  stage = label;
  await operation();
  passed.push(label);
  console.log(JSON.stringify({ probe: label, state: "passed" }));
}
async function denied(client, sql, values = [], codes = ["42501"]) {
  await client.query("SAVEPOINT expected_denial");
  try {
    let caught;
    try {
      await client.query(sql, values);
    } catch (error) {
      caught = error;
    }
    assert(caught && codes.includes(caught.code), "Expected a database privilege or row-policy denial.");
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_denial");
    await client.query("RELEASE SAVEPOINT expected_denial");
  }
}
async function rawTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function insert(client, tenant, id, state = "draft") {
  return client.query(
    "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic candidate metadata','synthetic-test',$3)RETURNING id,state,row_version",
    [tenant, id, state],
  );
}

try {
  globalsBefore = await globals();
  await cluster.query(`CREATE DATABASE "${database}"`);
  created = true;
  stage = "reviewed_baseline";
  const migrations = (await readdir("packages/db/migrations"))
    .filter((name) => /^\d{4}-.+\.sql$/.test(name) && name.slice(0, 4) <= "0015")
    .sort();
  assert.equal(migrations.length, 15);
  for (const name of migrations) {
    let sql = await readFile("packages/db/migrations/" + name, "utf8");
    if (name.startsWith("0002-") || name.startsWith("0012-")) {
      // Omit only the documented existing-role bootstrap; retain every database policy/check.
      const initialization = /DO \$\$ BEGIN\s*IF NOT EXISTS[\s\S]*?END \$\$;/;
      assert(initialization.test(sql));
      sql = sql.replace(initialization, "-- Existing cluster-role bootstrap omitted by owned verifier.");
      sql = sql.replace(/^ALTER ROLE estate_(runtime|worker|control|staff_issuer)[^;]*;\r?\n/gm, "");
    }
    assert(!/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i.test(sql), "Baseline cannot mutate cluster roles.");
    await fresh.query(sql);
  }
  await fresh.query(
    "CREATE TABLE public.estate_migration(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of migrations)
    await fresh.query("INSERT INTO public.estate_migration(name,sha256)VALUES($1,$2)", [
      name,
      sha(await readFile("packages/db/migrations/" + name, "utf8")),
    ]);
  process.env.APP_ENV = "test";
  process.env.DEV_AUTH_ENABLED = "true";
  process.env.MIGRATION_DATABASE_URL = freshUrl.href;
  await seedModule.seed();
  const beforeOtherGrants = (
    await fresh.query(
      "SELECT c.relname,c.relacl,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl)ORDER BY a.attnum)FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'AND c.relkind='r'AND c.relname<>'campaign'ORDER BY c.relname",
    )
  ).rows;
  await fresh.query(candidate);
  for (const [tenant, id, state] of [
    [fixtures.orgA, draftA, "draft"],
    [fixtures.orgB, draftB, "draft"],
    ...[...nonDraft].map(([state, id]) => [fixtures.orgA, id, state]),
  ])
    await fresh.query(
      "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic policy fixture','synthetic-test',$3)",
      [tenant, id, state],
    );

  await probe("01 genuine non-owner non-bypass role identities", async () => {
    await runtimeModule.assertRuntimeRole(runtime);
    await runtimeModule.assertRuntimeRole(rolePools.estate_worker);
    await staffModule.assertStaffRole(rolePools.estate_control, "estate_control");
    await staffModule.assertStaffRole(rolePools.estate_staff_issuer, "estate_staff_issuer");
    for (const [role, pool] of Object.entries(rolePools)) {
      const identity = (await pool.query("SELECT current_user,session_user")).rows[0];
      assert.deepEqual(identity, { current_user: role, session_user: role });
    }
  });
  await probe("02 FORCE RLS and restrictive SELECT/INSERT/UPDATE guards", async () => {
    const table = (
      await fresh.query(
        "SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)AS owner FROM pg_class WHERE oid='app.campaign'::regclass",
      )
    ).rows[0];
    assert.equal(table.relrowsecurity, true);
    assert.equal(table.relforcerowsecurity, true);
    assert.notEqual(table.owner, "estate_runtime");
    const policies = (
      await fresh.query(
        "SELECT polname,polcmd,polpermissive,polroles=ARRAY['estate_runtime'::regrole]::oid[]AS runtime_only FROM pg_policy WHERE polrelid='app.campaign'::regclass AND polname LIKE 'runtime_campaign_draft_%'ORDER BY polname",
      )
    ).rows;
    assert.deepEqual(policies, [
      { polname: "runtime_campaign_draft_insert", polcmd: "a", polpermissive: false, runtime_only: true },
      { polname: "runtime_campaign_draft_select", polcmd: "r", polpermissive: false, runtime_only: true },
      { polname: "runtime_campaign_draft_update", polcmd: "w", polpermissive: false, runtime_only: true },
    ]);
  });
  await probe("03 missing tenant context denies draft reads and writes", async () => {
    await rawTransaction(runtime, async (client) => {
      assert.equal((await client.query("SELECT count(*)::int AS count FROM app.campaign")).rows[0].count, 0);
      await denied(
        client,
        "INSERT INTO app.campaign(tenant_id,name,category,state)VALUES($1,'Synthetic','test','draft')",
        [fixtures.orgA],
      );
      assert.equal(
        (await client.query("UPDATE app.campaign SET name='Unexpected'WHERE id=$1", [draftA])).rowCount,
        0,
      );
    });
  });
  let createdDraft;
  await probe("04 verified tenant permits only draft metadata SELECT INSERT UPDATE", async () => {
    createdDraft = randomUUID();
    await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.deepEqual((await client.query("SELECT id FROM app.campaign ORDER BY id")).rows, [
        { id: draftA },
      ]);
      assert.deepEqual((await insert(client, fixtures.orgA, createdDraft)).rows, [
        { id: createdDraft, state: "draft", row_version: "1" },
      ]);
      const edited = await client.query(
        "UPDATE app.campaign SET name='Changed synthetic metadata',category='review',row_version=row_version+1,updated_at=clock_timestamp()WHERE id=$1 RETURNING state,row_version",
        [createdDraft],
      );
      assert.deepEqual(edited.rows, [{ state: "draft", row_version: "2" }]);
    });
  });
  await probe("05 active paused archived rows cannot be read created or edited", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      for (const [state, id] of nonDraft) {
        assert.equal((await client.query("SELECT id FROM app.campaign WHERE id=$1", [id])).rowCount, 0);
        await denied(
          client,
          "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic blocked','test',$3)",
          [fixtures.orgA, randomUUID(), state],
        );
        assert.equal(
          (await client.query("UPDATE app.campaign SET name='Unexpected'WHERE id=$1", [id])).rowCount,
          0,
        );
      }
    });
    assert(
      (
        await fresh.query("SELECT name FROM app.campaign WHERE id=ANY($1::uuid[])", [[...nonDraft.values()]])
      ).rows.every((row) => row.name === "Synthetic policy fixture"),
    );
  });
  await probe("06 tenant IDs cannot supply foreign read insert or update authority", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.equal(
        (await client.query("SELECT id FROM app.campaign WHERE tenant_id=$1", [fixtures.orgB])).rowCount,
        0,
      );
      await denied(
        client,
        "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic foreign','test','draft')",
        [fixtures.orgB, randomUUID()],
      );
      assert.equal(
        (await client.query("UPDATE app.campaign SET name='Unexpected'WHERE id=$1", [draftB])).rowCount,
        0,
      );
    });
    assert.equal(
      (await fresh.query("SELECT name FROM app.campaign WHERE id=$1", [draftB])).rows[0].name,
      "Synthetic policy fixture",
    );
  });
  await probe("07 pooled connection A B anonymous retains no transaction context", async () => {
    const a = await withTenantTransaction(runtime, ownerA, async (client) => {
      const pid = (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
      assert.equal((await client.query("SELECT id FROM app.campaign WHERE id=$1", [draftB])).rowCount, 0);
      return pid;
    });
    const b = await withTenantTransaction(runtime, ownerB, async (client) => {
      assert.deepEqual((await client.query("SELECT id FROM app.campaign")).rows, [{ id: draftB }]);
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    const cleared = (
      await runtime.query(
        "SELECT pg_backend_pid()AS pid,nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor,(SELECT count(*)::int FROM app.campaign)AS count",
      )
    ).rows[0];
    assert.equal(a, b);
    assert.deepEqual(cleared, { pid: a, tenant: null, actor: null, count: 0 });
  });
  await probe(
    "08 state identity initial revision lifecycle delete and truncate privileges denied",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const state of ["draft", "active", "paused", "archived"])
          await denied(client, "UPDATE app.campaign SET state=$2 WHERE id=$1", [createdDraft, state]);
        for (const column of ["tenant_id", "id", "created_at"])
          await denied(client, `UPDATE app.campaign SET ${column}=${column} WHERE id=$1`, [createdDraft]);
        await denied(
          client,
          "INSERT INTO app.campaign(tenant_id,name,category,state,row_version)VALUES($1,'Synthetic','test','draft',9)",
          [fixtures.orgA],
        );
        await denied(client, "DELETE FROM app.campaign WHERE id=$1", [createdDraft]);
        await denied(client, "TRUNCATE app.campaign");
      });
      assert.equal(
        (await fresh.query("SELECT state,row_version FROM app.campaign WHERE id=$1", [createdDraft])).rows[0]
          .state,
        "draft",
      );
    },
  );
  await probe("09 workflow version enrollment scheduling and delivery remain inaccessible", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      for (const table of prohibited) {
        await denied(client, `SELECT * FROM app.${table}`);
        await denied(client, `INSERT INTO app.${table}(tenant_id)VALUES($1)`, [fixtures.orgA]);
        await denied(client, `UPDATE app.${table} SET row_version=row_version+1`);
        await denied(client, `DELETE FROM app.${table}`);
        await denied(client, `TRUNCATE app.${table}`);
      }
    });
  });
  await probe("10 worker control issuer receive no campaign privilege", async () => {
    for (const role of ["estate_worker", "estate_control", "estate_staff_issuer"])
      await rawTransaction(rolePools[role], async (client) => {
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixtures.orgA]);
        await denied(client, "SELECT * FROM app.campaign");
        await denied(
          client,
          "INSERT INTO app.campaign(tenant_id,name,category,state)VALUES($1,'Synthetic','test','draft')",
          [fixtures.orgA],
        );
        await denied(client, "UPDATE app.campaign SET name='Unexpected'");
        await denied(client, "DELETE FROM app.campaign");
        await denied(client, "TRUNCATE app.campaign");
      });
  });
  await probe("11 restrictive guards survive an additional permissive policy", async () => {
    await fresh.query(
      "CREATE POLICY campaign_verifier_permissive ON app.campaign TO estate_runtime USING(true)WITH CHECK(true)",
    );
    try {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const id of [draftB, ...nonDraft.values()]) {
          assert.equal((await client.query("SELECT id FROM app.campaign WHERE id=$1", [id])).rowCount, 0);
          assert.equal(
            (await client.query("UPDATE app.campaign SET name='Unexpected'WHERE id=$1", [id])).rowCount,
            0,
          );
        }
        await denied(
          client,
          "INSERT INTO app.campaign(tenant_id,name,category,state)VALUES($1,'Synthetic','test','active')",
          [fixtures.orgA],
        );
        await denied(
          client,
          "INSERT INTO app.campaign(tenant_id,name,category,state)VALUES($1,'Synthetic','test','draft')",
          [fixtures.orgB],
        );
      });
    } finally {
      await fresh.query("DROP POLICY campaign_verifier_permissive ON app.campaign");
    }
  });
  await probe("12 caller rollback removes allowed metadata write and clears pooled context", async () => {
    const id = randomUUID(),
      rollback = new Error("Synthetic caller rollback");
    await assert.rejects(
      withTenantTransaction(runtime, ownerA, async (client) => {
        await insert(client, fixtures.orgA, id);
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.equal((await fresh.query("SELECT id FROM app.campaign WHERE id=$1", [id])).rowCount, 0);
    assert.equal((await runtime.query("SELECT count(*)::int AS count FROM app.campaign")).rows[0].count, 0);
  });
  await probe("13 candidate changes no unrelated table or column grants", async () => {
    const after = (
      await fresh.query(
        "SELECT c.relname,c.relacl,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl)ORDER BY a.attnum)FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'AND c.relkind='r'AND c.relname<>'campaign'ORDER BY c.relname",
      )
    ).rows;
    assert.deepEqual(after, beforeOtherGrants);
    assert.equal(
      sha(await readFile(candidatePath, "utf8")),
      candidateHash,
      "Candidate changed during verification.",
    );
    assert.equal(await globals(), globalsBefore, "Global role attributes or memberships changed.");
  });
} catch (error) {
  failure = { stage, code: typeof error.code === "string" ? error.code : error.name };
  process.exitCode = 1;
} finally {
  try {
    await Promise.all(pools.map((pool) => pool.end()));
    if (created) {
      assert(/^estate_marketing_policy_[0-9a-f]{16}$/.test(database));
      await cluster.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      dropped =
        (await cluster.query("SELECT datname FROM pg_database WHERE datname=$1", [database])).rowCount === 0;
      assert(dropped, "Owned disposable database was not removed.");
    }
    globalRolesUnchanged = (await globals()) === globalsBefore;
    assert(globalRolesUnchanged, "Global role attributes or memberships changed during cleanup.");
  } catch (error) {
    failure ??= { stage: "cleanup", code: typeof error.code === "string" ? error.code : error.name };
    process.exitCode = 1;
  } finally {
    await cluster.end();
  }
  console.log(
    JSON.stringify({
      result: failure ? "failed" : "passed",
      probes: passed.length,
      candidateSha256: candidateHash,
      ownedDatabaseRemoved: dropped,
      globalRolesUnchanged,
      ...(failure ? { failure } : {}),
    }),
  );
}
