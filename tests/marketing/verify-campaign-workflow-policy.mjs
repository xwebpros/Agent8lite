// Candidate-only real-login probes: owned database, no listeners or cluster-role writes.
// Run: node --import tsx tests/marketing/verify-campaign-workflow-policy.mjs
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
const database = `estate_workflow_policy_${randomBytes(8).toString("hex")}`;
assert(/^estate_workflow_policy_[0-9a-f]{16}$/.test(database));
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
const parentA = randomUUID(),
  parentB = randomUUID();
const versionA = randomUUID(),
  versionB = randomUUID(),
  published = randomUUID(),
  dirtyPublication = randomUUID();
const designA = randomUUID(),
  designB = randomUUID();
const nonDraftParents = new Map(["active", "paused", "archived"].map((state) => [state, randomUUID()]));
const nonDraftVersions = new Map([...nonDraftParents.keys()].map((state) => [state, randomUUID()]));
const definition = { nodes: [{ key: "start", kind: "wait", delaySeconds: 0 }], edges: [], timezone: "UTC" };
const definitionJson = JSON.stringify(definition);
const prohibited = ["campaign_step", "automation_rule", "enrollment", "scheduled_action", "delivery_attempt"];
const candidatePath = "docs/proposals/W06/campaign-workflow-policy.proposed.sql";
const candidate = await readFile(candidatePath, "utf8");
assert(!/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i.test(candidate), "Candidate cannot mutate cluster roles.");
const candidateHash = sha(candidate);
const passed = [];
let created = false,
  dropped = false,
  globalRolesUnchanged = false,
  globalsBefore,
  failure;
let stage = "initialize";

async function globals() {
  const roles = (
    await cluster.query(
      "SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)ORDER BY rolname",
      [identities.map(([role]) => role)],
    )
  ).rows;
  assert.equal(roles.length, 4, "Existing configured roles required; verifier never creates them.");
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
    assert(caught && codes.includes(caught.code), "Expected database privilege or row-policy denial.");
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
async function insert(client, tenant, id, parent, ordinal, state = "draft") {
  return client.query(
    "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,$4,$5,$6)RETURNING id,campaign_id,version,state,definition,row_version,published_at",
    [tenant, id, parent, ordinal, definitionJson, state],
  );
}
async function tableGrants() {
  return (
    await fresh.query(
      "SELECT c.relname,c.relacl,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl)ORDER BY a.attnum)FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app'AND c.relkind='r'AND c.relname NOT IN('campaign_version','message_design')ORDER BY c.relname",
    )
  ).rows;
}

try {
  globalsBefore = await globals();
  await cluster.query(`CREATE DATABASE "${database}"`);
  created = true;
  stage = "reviewed_baseline";
  const migrations = (await readdir("packages/db/migrations"))
    .filter((name) => /^\d{4}-.+\.sql$/.test(name) && name.slice(0, 4) <= "0016")
    .sort();
  assert.equal(migrations.length, 16);
  for (const name of migrations) {
    let sql = await readFile("packages/db/migrations/" + name, "utf8");
    if (name.startsWith("0002-") || name.startsWith("0012-")) {
      // Omit only documented existing-role bootstrap; keep every database policy/check.
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
  const beforeOtherGrants = await tableGrants();
  await fresh.query(candidate);
  for (const [tenant, id, state] of [
    [fixtures.orgA, parentA, "draft"],
    [fixtures.orgB, parentB, "draft"],
    ...[...nonDraftParents].map(([state, id]) => [fixtures.orgA, id, state]),
  ])
    await fresh.query(
      "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic workflow policy parent','synthetic-test',$3)",
      [tenant, id, state],
    );
  await insert(fresh, fixtures.orgA, versionA, parentA, 1);
  await insert(fresh, fixtures.orgB, versionB, parentB, 1);
  await insert(fresh, fixtures.orgA, published, parentA, 2, "published");
  await fresh.query(
    "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state,published_at)VALUES($1,$2,$3,3,$4,'draft',clock_timestamp())",
    [fixtures.orgA, dirtyPublication, parentA, definitionJson],
  );
  for (const [state, id] of nonDraftVersions)
    await insert(fresh, fixtures.orgA, id, nonDraftParents.get(state), 1);
  for (const [tenant, id] of [
    [fixtures.orgA, designA],
    [fixtures.orgB, designB],
  ])
    await fresh.query(
      "INSERT INTO app.message_design(tenant_id,id,name,channel,version,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'Synthetic source','sms',1,'native_sms','{}','Synthetic text',$3)",
      [tenant, id, sha("Synthetic text")],
    );

  await probe("01 genuine non-owner non-bypass identities", async () => {
    await runtimeModule.assertRuntimeRole(runtime);
    await runtimeModule.assertRuntimeRole(rolePools.estate_worker);
    await staffModule.assertStaffRole(rolePools.estate_control, "estate_control");
    await staffModule.assertStaffRole(rolePools.estate_staff_issuer, "estate_staff_issuer");
    for (const [role, pool] of Object.entries(rolePools))
      assert.deepEqual((await pool.query("SELECT current_user,session_user")).rows[0], {
        current_user: role,
        session_user: role,
      });
  });
  await probe("02 forced RLS restrictive version guards and immutable trigger", async () => {
    for (const table of ["campaign_version", "message_design"]) {
      const row = (
        await fresh.query(
          "SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)AS owner FROM pg_class WHERE oid=$1::regclass",
          ["app." + table],
        )
      ).rows[0];
      assert.equal(row.relrowsecurity, true);
      assert.equal(row.relforcerowsecurity, true);
      assert.notEqual(row.owner, "estate_runtime");
    }
    const policies = (
      await fresh.query(
        "SELECT polname,polcmd,polpermissive,polroles=ARRAY['estate_runtime'::regrole]::oid[]AS runtime_only FROM pg_policy WHERE polrelid='app.campaign_version'::regclass AND polname LIKE 'runtime_workflow_draft_%'ORDER BY polname",
      )
    ).rows;
    assert.deepEqual(policies, [
      { polname: "runtime_workflow_draft_insert", polcmd: "a", polpermissive: false, runtime_only: true },
      { polname: "runtime_workflow_draft_select", polcmd: "r", polpermissive: false, runtime_only: true },
    ]);
    const trigger = (
      await fresh.query(
        "SELECT tgenabled FROM pg_trigger WHERE tgrelid='app.campaign_version'::regclass AND tgname='campaign_version_immutable'AND NOT tgisinternal",
      )
    ).rows;
    assert.deepEqual(trigger, [{ tgenabled: "O" }]);
  });
  await probe("03 missing tenant context exposes no version or design and denies insert", async () => {
    await rawTransaction(runtime, async (client) => {
      for (const table of ["campaign_version", "message_design"])
        assert.equal(
          (await client.query(`SELECT count(*)::int AS count FROM app.${table}`)).rows[0].count,
          0,
        );
      await denied(
        client,
        "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,4,$3,'draft')",
        [fixtures.orgA, parentA, definitionJson],
      );
    });
  });
  const appended = randomUUID();
  await probe("04 current draft parent permits immutable append and exact definition read", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.deepEqual((await client.query("SELECT id FROM app.campaign_version ORDER BY id")).rows, [
        { id: versionA },
      ]);
      const row = (await insert(client, fixtures.orgA, appended, parentA, 4)).rows[0];
      assert.deepEqual(row, {
        id: appended,
        campaign_id: parentA,
        version: 4,
        state: "draft",
        definition,
        row_version: "1",
        published_at: null,
      });
    });
    assert.deepEqual(
      (await fresh.query("SELECT definition,state FROM app.campaign_version WHERE id=$1", [versionA]))
        .rows[0],
      { definition, state: "draft" },
    );
  });
  await probe(
    "05 published publication metadata and non-draft parents cannot supply read or append authority",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const id of [published, dirtyPublication, ...nonDraftVersions.values()])
          assert.equal(
            (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [id])).rowCount,
            0,
          );
        await denied(
          client,
          "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,5,$3,'published')",
          [fixtures.orgA, parentA, definitionJson],
        );
        for (const parent of nonDraftParents.values())
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2,$3,'draft')",
            [fixtures.orgA, parent, definitionJson],
          );
      });
      await fresh.query("UPDATE app.campaign SET state='archived'WHERE id=$1", [parentA]);
      try {
        await withTenantTransaction(runtime, ownerA, async (client) => {
          assert.equal(
            (await client.query("SELECT id FROM app.campaign_version WHERE campaign_id=$1", [parentA]))
              .rowCount,
            0,
          );
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,5,$3,'draft')",
            [fixtures.orgA, parentA, definitionJson],
          );
        });
      } finally {
        await fresh.query("UPDATE app.campaign SET state='draft'WHERE id=$1", [parentA]);
      }
    },
  );
  await probe("06 request tenant or foreign parent IDs cannot cross RLS", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.equal(
        (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [versionB])).rowCount,
        0,
      );
      await denied(
        client,
        "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2,$3,'draft')",
        [fixtures.orgB, parentB, definitionJson],
      );
      await denied(
        client,
        "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2,$3,'draft')",
        [fixtures.orgA, parentB, definitionJson],
      );
    });
  });
  await probe("07 same pooled backend A B anonymous retains no version or design context", async () => {
    const a = await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.equal(
        (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [versionB])).rowCount,
        0,
      );
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    const b = await withTenantTransaction(runtime, ownerB, async (client) => {
      assert.deepEqual((await client.query("SELECT id FROM app.campaign_version")).rows, [{ id: versionB }]);
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    const row = (
      await runtime.query(
        "SELECT pg_backend_pid()AS pid,nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor,(SELECT count(*)::int FROM app.campaign_version)AS versions,(SELECT count(*)::int FROM app.message_design)AS designs",
      )
    ).rows[0];
    assert.equal(a, b);
    assert.deepEqual(row, { pid: a, tenant: null, actor: null, versions: 0, designs: 0 });
  });
  await probe(
    "08 direct version updates deletes publication timestamp initial revision and truncate denied",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const column of [
          "tenant_id",
          "id",
          "campaign_id",
          "version",
          "definition",
          "state",
          "published_at",
          "row_version",
          "created_at",
          "updated_at",
        ])
          await denied(client, `UPDATE app.campaign_version SET ${column}=${column} WHERE id=$1`, [appended]);
        await denied(client, "DELETE FROM app.campaign_version WHERE id=$1", [appended]);
        await denied(client, "TRUNCATE app.campaign_version");
        for (const extra of ["row_version", "published_at", "created_at"])
          await denied(
            client,
            `INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state,${extra})VALUES($1,$2,5,$3,'draft',DEFAULT)`,
            [fixtures.orgA, parentA, definitionJson],
          );
        await denied(client, "UPDATE app.campaign SET state='active'WHERE id=$1", [parentA]);
      });
    },
  );
  await probe(
    "09 immutable row trigger rejects saved draft and published alteration even for bypass identity",
    async () => {
      await rawTransaction(fresh, async (client) => {
        for (const id of [versionA, published]) {
          await denied(client, "UPDATE app.campaign_version SET definition='{}'WHERE id=$1", [id], ["55000"]);
          await denied(client, "UPDATE app.campaign_version SET state=state WHERE id=$1", [id], ["55000"]);
          await denied(client, "DELETE FROM app.campaign_version WHERE id=$1", [id], ["55000"]);
        }
      });
    },
  );
  await probe(
    "10 current tenant message source SELECT and FOR SHARE work without foreign visibility",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.deepEqual((await client.query("SELECT id FROM app.message_design FOR SHARE")).rows, [
          { id: designA },
        ]);
        assert.equal(
          (await client.query("SELECT id FROM app.message_design WHERE id=$1 FOR SHARE", [designB])).rowCount,
          0,
        );
      });
      assert.equal(
        (await runtime.query("SELECT count(*)::int AS count FROM app.message_design")).rows[0].count,
        0,
      );
    },
  );
  await probe("11 message source lock privilege cannot mutate row version or business content", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      // This catches the previously permissive WITH CHECK tenant lock-only policy defect.
      await denied(client, "UPDATE app.message_design SET row_version=row_version+1 WHERE id=$1", [designA]);
      await denied(client, "UPDATE app.message_design SET row_version=row_version WHERE id=$1", [designA]);
      for (const column of [
        "tenant_id",
        "id",
        "name",
        "channel",
        "version",
        "editor_kind",
        "design",
        "rendered_content",
        "content_hash",
        "created_at",
        "updated_at",
      ])
        await denied(client, `UPDATE app.message_design SET ${column}=${column} WHERE id=$1`, [designA]);
      await denied(client, "INSERT INTO app.message_design(tenant_id)VALUES($1)", [fixtures.orgA]);
      await denied(client, "DELETE FROM app.message_design WHERE id=$1", [designA]);
      await denied(client, "TRUNCATE app.message_design");
    });
    assert.deepEqual(
      (
        await fresh.query("SELECT row_version,rendered_content FROM app.message_design WHERE id=$1", [
          designA,
        ])
      ).rows[0],
      { row_version: "1", rendered_content: "Synthetic text" },
    );
  });
  await probe(
    "12 steps automation enrollment schedule and delivery retain no runtime authority",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const table of prohibited) {
          await denied(client, `SELECT * FROM app.${table}`);
          await denied(client, `INSERT INTO app.${table}(tenant_id)VALUES($1)`, [fixtures.orgA]);
          await denied(client, `UPDATE app.${table} SET row_version=row_version+1`);
          await denied(client, `DELETE FROM app.${table}`);
          await denied(client, `TRUNCATE app.${table}`);
        }
      });
    },
  );
  await probe("13 worker control issuer gain no workflow version or design grants", async () => {
    for (const role of ["estate_worker", "estate_control", "estate_staff_issuer"])
      await rawTransaction(rolePools[role], async (client) => {
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [fixtures.orgA]);
        for (const table of ["campaign_version", "message_design"]) {
          await denied(client, `SELECT * FROM app.${table}`);
          await denied(client, `INSERT INTO app.${table}(tenant_id)VALUES($1)`, [fixtures.orgA]);
          await denied(client, `UPDATE app.${table} SET row_version=row_version+1`);
          await denied(client, `DELETE FROM app.${table}`);
          await denied(client, `TRUNCATE app.${table}`);
        }
      });
  });
  await probe(
    "14 restrictive version and lock-only source guards survive extra permissive policies",
    async () => {
      for (const table of ["campaign_version", "message_design"])
        await fresh.query(
          `CREATE POLICY workflow_verifier_permissive ON app.${table} TO estate_runtime USING(true)WITH CHECK(true)`,
        );
      try {
        await withTenantTransaction(runtime, ownerA, async (client) => {
          for (const id of [versionB, published, dirtyPublication, ...nonDraftVersions.values()])
            assert.equal(
              (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [id])).rowCount,
              0,
            );
          for (const parent of nonDraftParents.values())
            await denied(
              client,
              "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2,$3,'draft')",
              [fixtures.orgA, parent, definitionJson],
            );
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,5,$3,'published')",
            [fixtures.orgA, parentA, definitionJson],
          );
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2,$3,'draft')",
            [fixtures.orgB, parentB, definitionJson],
          );
          assert.equal(
            (await client.query("SELECT id FROM app.message_design WHERE id=$1", [designB])).rowCount,
            0,
          );
          await denied(client, "UPDATE app.message_design SET row_version=row_version+1 WHERE id=$1", [
            designA,
          ]);
          assert.equal(
            (await client.query("SELECT id FROM app.message_design WHERE id=$1 FOR SHARE", [designA]))
              .rowCount,
            1,
          );
        });
      } finally {
        for (const table of ["campaign_version", "message_design"])
          await fresh.query(`DROP POLICY workflow_verifier_permissive ON app.${table}`);
      }
    },
  );
  await probe("15 caller rollback removes append and restores anonymous pool context", async () => {
    const id = randomUUID(),
      rollback = new Error("Synthetic workflow caller rollback");
    await assert.rejects(
      withTenantTransaction(runtime, ownerA, async (client) => {
        await insert(client, fixtures.orgA, id, parentA, 5);
        throw rollback;
      }),
      (error) => error === rollback,
    );
    assert.equal((await fresh.query("SELECT id FROM app.campaign_version WHERE id=$1", [id])).rowCount, 0);
    assert.equal(
      (await runtime.query("SELECT count(*)::int AS count FROM app.campaign_version")).rows[0].count,
      0,
    );
  });
  await probe("16 unrelated grants and global role attributes memberships remain unchanged", async () => {
    assert.deepEqual(await tableGrants(), beforeOtherGrants);
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
      assert(/^estate_workflow_policy_[0-9a-f]{16}$/.test(database));
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
