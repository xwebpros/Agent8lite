// Candidate-only real-login verifier. The coordinator supplies the reviewed SHA before execution.
// Run: NATIVE_MESSAGE_POLICY_SQL_SHA256=<approved hash> node --import tsx tests/marketing/verify-native-message-design-policy.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import * as fixtureModule from "../../packages/db/fixtures.ts";
import * as seedModule from "../../packages/db/seed.ts";
import * as tenantModule from "../../packages/db/tenant-transaction.ts";
import * as runtimeModule from "../../packages/db/runtime-role.ts";
import * as staffModule from "../../packages/db/staff-pools.ts";

const exported = (module, name) => module[name] ?? module.default?.[name];
const fixtures = exported(fixtureModule, "fixtures");
const seed = exported(seedModule, "seed");
const withTenantTransaction = exported(tenantModule, "withTenantTransaction");
const assertRuntimeRole = exported(runtimeModule, "assertRuntimeRole");
const assertStaffRole = exported(staffModule, "assertStaffRole");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const candidatePath = "docs/proposals/W06/native-message-design-storage.sql";
const candidate = await readFile(candidatePath, "utf8");
const candidateHash = sha(candidate);
assert.match(
  process.env.NATIVE_MESSAGE_POLICY_SQL_SHA256 ?? "",
  /^[a-f0-9]{64}$/,
  "The coordinator's reviewed candidate SHA-256 is required before any database connection.",
);
assert.equal(candidateHash, process.env.NATIVE_MESSAGE_POLICY_SQL_SHA256, "Reviewed SQL hash mismatch.");
const forbiddenClusterSql = (sql) => {
  assert(!/\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i.test(sql), "Cluster-role writes are prohibited.");
  assert(
    !/^\s*(?:GRANT|REVOKE)\s+(?:(?!\bON\b)[^;])+\s+(?:TO|FROM)\b/im.test(sql),
    "Cluster-role membership writes are prohibited.",
  );
};
forbiddenClusterSql(candidate);

const database = "estate_message_policy_" + randomBytes(8).toString("hex");
assert.match(database, /^estate_message_policy_[0-9a-f]{16}$/);
function localUrl(value) {
  try {
    const url = new URL(value);
    assert(["postgres:", "postgresql:"].includes(url.protocol));
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert(!url.search && !url.hash);
    assert(decodeURIComponent(url.username));
    return url;
  } catch {
    // URL/URI errors may otherwise echo a credential-bearing input.
    throw new Error("A valid explicit loopback PostgreSQL identity is required.");
  }
}
const source = localUrl(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
const identities = [
  ["estate_runtime", "DATABASE_URL", "local-runtime-only"],
  ["estate_worker", "WORKER_DATABASE_URL", "local-worker-only"],
  ["estate_control", "CONTROL_DATABASE_URL", "local-control-only"],
  ["estate_staff_issuer", "STAFF_ISSUER_DATABASE_URL", "local-staff-issuer-only"],
];
assert(
  !identities.some(([role]) => role === decodeURIComponent(source.username)),
  "Migration login required.",
);
const clusterUrl = new URL(source);
clusterUrl.pathname = "/postgres";
const freshUrl = new URL(source);
freshUrl.pathname = "/" + database;
const cluster = new pg.Pool({ connectionString: clusterUrl.href, max: 1, connectionTimeoutMillis: 5000 });
const fresh = new pg.Pool({ connectionString: freshUrl.href, max: 4, connectionTimeoutMillis: 5000 });
const pools = [fresh];
const roles = {};
for (const [role, variable, password] of identities) {
  const url = localUrl(process.env[variable] ?? source.href);
  if (process.env[variable]) assert.equal(decodeURIComponent(url.username), role, "Exact login required.");
  else {
    url.username = role;
    url.password = password;
  }
  assert.equal(url.hostname, source.hostname, "All identities must use the same loopback server.");
  assert.equal(url.port, source.port);
  url.pathname = "/" + database;
  process.env[variable] = url.href;
  roles[role] = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 5000 });
  pools.push(roles[role]);
}
const runtime = roles.estate_runtime;
const parallel = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 5000,
});
pools.push(parallel);
const ownerA = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const ownerB = { userId: fixtures.ownerUser, organizationId: fixtures.orgB };
const approvedTables = new Set([
  "message_design",
  "campaign_version",
  "message_design_revision",
  "campaign_workflow_design_reference",
]);
const native = (text = "Synthetic static message.", subject = "Synthetic subject") => ({
  name: "Synthetic native message",
  channel: "email",
  subject,
  editor: "native",
  design: { schemaVersion: 1, blocks: [{ type: "text", text }] },
  content: text,
  hash: sha(text),
});
const basic = native();
const ids = Object.fromEntries(
  ["sourceA", "sourceB", "legacyA", "legacyWorkflow", "parentA", "parentB"].map((name) => [
    name,
    randomUUID(),
  ]),
);
const withoutMessages = {
  nodes: [{ key: "start", kind: "wait", delaySeconds: 0 }],
  edges: [],
  timezone: "UTC",
};
const workflow = (designId, channel = "email") => ({
  nodes: [{ key: "start", kind: channel, messageDesignId: designId }],
  edges: [],
  timezone: "UTC",
});
const passed = [];
const migrations = [];
function diagnostic(error, currentStage) {
  const code = typeof error?.code === "string" ? error.code : error?.name;
  const constraint = error?.constraint;
  const location =
    typeof error?.stack === "string"
      ? error.stack.match(/verify-native-message-design-policy\.mjs:(\d+):(\d+)/)
      : null;
  const safeAssertions = new Set([
    "Expected closed database denial.",
    "Required real database lock wait was not observed.",
    "Exact reviewed0001–0018 baseline required.",
    "Expected existing-role bootstrap required.",
    "Exact owned database cleanup failed.",
    "Unrelated global identity or database privileges changed.",
    "The assertion must observe deferred COMMIT rather than INSERT failure.",
  ]);
  return {
    stage: currentStage,
    code: typeof code === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(code) ? code : "verification_failed",
    ...(typeof constraint === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(constraint) ? { constraint } : {}),
    ...(location
      ? {
          location:
            "tests/marketing/verify-native-message-design-policy.mjs:" + location[1] + ":" + location[2],
        }
      : {}),
    ...(error?.name === "AssertionError" &&
    error.generatedMessage === false &&
    safeAssertions.has(error.message)
      ? { assertion: error.message }
      : {}),
  };
}
let stage = "initialize",
  created = false,
  dropped = false,
  globalsBefore,
  beforePrivileges,
  failure;
let globalRolesUnchanged = false,
  unrelatedPrivilegesUnchanged = false,
  originalMigrationsUnchanged = false;

async function globals() {
  const logins = (
    await cluster.query(
      "SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolvaliduntil FROM pg_roles ORDER BY oid",
    )
  ).rows;
  assert.equal(logins.filter((row) => identities.some(([role]) => role === row.rolname)).length, 4);
  const memberships = (
    await cluster.query(
      "SELECT roleid,member,grantor,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor",
    )
  ).rows;
  const databases = (
    await cluster.query("SELECT datname,datdba,datacl FROM pg_database WHERE datname<>$1 ORDER BY datname", [
      database,
    ])
  ).rows;
  return sha(JSON.stringify({ logins, memberships, databases }));
}
async function unrelatedPrivileges() {
  const relations = (
    await fresh.query(
      "SELECT n.nspname,c.relname,c.relacl,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl)ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('app','public')AND c.relkind IN('r','v','m','p','S')AND c.relname<>ALL($1::text[])ORDER BY n.nspname,c.relname",
      [[...approvedTables]],
    )
  ).rows;
  const functions = (
    await fresh.query(
      "SELECT p.oid,p.proacl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('app','public')AND p.oid=ANY($1::oid[])ORDER BY p.oid",
      [beforePrivileges?.functionIds ?? []],
    )
  ).rows;
  return { relations, functions };
}
async function probe(label, operation) {
  stage = label;
  await operation();
  passed.push(label);
  console.log(JSON.stringify({ probe: label, state: "passed" }));
}
async function transaction(pool, operation, commit = false) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='15s'");
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
async function context(client, tenant = fixtures.orgA, actor = fixtures.ownerUser) {
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_id',$2,true)", [
    tenant,
    actor,
  ]);
}
async function denied(client, sql, values = [], codes = ["42501"], constraint) {
  await client.query("SAVEPOINT expected_denial");
  try {
    let error;
    try {
      await client.query(sql, values);
    } catch (caught) {
      error = caught;
    }
    assert(error && codes.includes(error.code), "Expected closed database denial.");
    if (constraint) assert.equal(error.constraint, constraint);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT expected_denial");
    await client.query("RELEASE SAVEPOINT expected_denial");
  }
}
async function insertDesign(client, tenant, id, body = basic, extras = "") {
  return client.query(
    "INSERT INTO app.message_design(tenant_id,id,name,channel,subject,editor_kind,design,rendered_content,content_hash" +
      extras +
      ")VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9" +
      (extras ? ",DEFAULT" : "") +
      ")RETURNING id,version,row_version,subject,design,rendered_content,content_hash,history_ready",
    [
      tenant,
      id,
      body.name,
      body.channel,
      body.subject,
      body.editor,
      JSON.stringify(body.design),
      body.content,
      body.hash,
    ],
  );
}
async function editDesign(client, id, body = native("Synthetic edited message.")) {
  return client.query(
    "UPDATE app.message_design SET name=$2,subject=$3,design=$4,rendered_content=$5,content_hash=$6 WHERE id=$1 RETURNING id,version,row_version,subject,design,rendered_content,content_hash",
    [id, body.name, body.subject, JSON.stringify(body.design), body.content, body.hash],
  );
}
async function insertWorkflow(
  client,
  tenant,
  parent,
  id,
  definition = workflow(ids.sourceA),
  state = "draft",
) {
  return client.query(
    "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,1,$4,$5)RETURNING id,version,definition,state,design_bindings_ready",
    [tenant, id, parent, JSON.stringify(definition), state],
  );
}
async function referenceProof(client, tenant, version, definition) {
  return (
    await client.query("SELECT app.native_workflow_reference_proof($1,$2,$3)AS valid", [
      tenant,
      version,
      JSON.stringify(definition),
    ])
  ).rows[0].valid;
}
async function newParent(tenant = fixtures.orgA) {
  const id = randomUUID();
  await fresh.query(
    "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic policy parent','synthetic','draft')",
    [tenant, id],
  );
  return id;
}
async function currentDesign(id) {
  return (
    await fresh.query(
      "SELECT tenant_id,id,name,channel,subject,editor_kind,design,rendered_content,content_hash,version,row_version,availability_state,history_ready FROM app.message_design WHERE id=$1",
      [id],
    )
  ).rows[0];
}
async function history(id) {
  return (
    await fresh.query(
      "SELECT version,source_row_version,name,channel,subject,editor_kind,design,rendered_content,content_hash FROM app.message_design_revision WHERE message_design_id=$1 ORDER BY version",
      [id],
    )
  ).rows;
}
async function observedWait(pid, blockerPid, expired = false) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const row = (
      await fresh.query(
        "SELECT wait_event_type,pg_blocking_pids(pid)AS blockers,(SELECT effective_until<=clock_timestamp()FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing')AS expired FROM pg_stat_activity WHERE pid=$2 AND datname=$3",
        [fixtures.orgA, pid, database],
      )
    ).rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.includes(blockerPid) && (!expired || row.expired))
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Required real database lock wait was not observed.");
}
async function blockedMutation({ lock, operation, change, expired = false, expected = "42501" }) {
  const blocker = await fresh.connect();
  let held = false,
    pending,
    resolvePid;
  const started = new Promise((resolve) => {
    resolvePid = resolve;
  });
  try {
    await blocker.query("BEGIN");
    held = true;
    const blockerPid = (await blocker.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    await lock(blocker);
    if (expired)
      await fresh.query(
        "UPDATE app.entitlement SET effective_until=clock_timestamp()+interval '500 milliseconds' WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    pending = transaction(
      parallel,
      async (client) => {
        await context(client);
        resolvePid((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
        return operation(client);
      },
      true,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await observedWait(await started, blockerPid, expired);
    if (change) await change(blocker);
    await blocker.query("COMMIT");
    held = false;
    const result = await pending;
    assert.equal(result.error?.code, expected);
  } finally {
    if (held) await blocker.query("ROLLBACK").catch(() => {});
    if (pending) await pending;
    blocker.release();
    if (expired)
      await fresh.query(
        "UPDATE app.entitlement SET effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
  }
}

try {
  globalsBefore = await globals();
  await cluster.query('CREATE DATABASE "' + database + '"');
  created = true;
  stage = "reviewed_baseline";
  const names = (await readdir("packages/db/migrations"))
    .filter((name) => /^\d{4}-.+\.sql$/.test(name) && name.slice(0, 4) <= "0018")
    .sort();
  assert.equal(names.length, 18, "Exact reviewed0001–0018 baseline required.");
  for (const name of names) {
    const original = await readFile("packages/db/migrations/" + name, "utf8");
    migrations.push({ name, hash: sha(original) });
    let sql = original;
    if (name.startsWith("0002-") || name.startsWith("0012-")) {
      const bootstrap = /DO \$\$ BEGIN\s*IF NOT EXISTS[\s\S]*?END \$\$;/;
      assert(bootstrap.test(sql), "Expected existing-role bootstrap required.");
      sql = sql.replace(bootstrap, "-- Existing cluster-role bootstrap omitted by verifier.");
      sql = sql.replace(/^ALTER ROLE estate_(runtime|worker|control|staff_issuer)[^;]*;\r?\n/gm, "");
    }
    forbiddenClusterSql(sql);
    await fresh.query(sql);
  }
  await fresh.query(
    "CREATE TABLE public.estate_migration(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const { name, hash } of migrations)
    await fresh.query("INSERT INTO public.estate_migration(name,sha256)VALUES($1,$2)", [name, hash]);
  process.env.APP_ENV = "test";
  process.env.DEV_AUTH_ENABLED = "true";
  process.env.MIGRATION_DATABASE_URL = freshUrl.href;
  stage = "baseline_seed";
  await seed();
  stage = "baseline_legacy_fixtures";
  for (const tenant of [fixtures.orgA, fixtures.orgB])
    await fresh.query(
      "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')",
      [tenant],
    );
  for (const [tenant, id] of [
    [fixtures.orgA, ids.parentA],
    [fixtures.orgB, ids.parentB],
  ])
    await fresh.query(
      "INSERT INTO app.campaign(tenant_id,id,name,category,state)VALUES($1,$2,'Synthetic baseline parent','synthetic','draft')",
      [tenant, id],
    );
  await fresh.query(
    "INSERT INTO app.message_design(tenant_id,id,name,channel,version,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,$3,'email',1,'native',$4,$5,$6)",
    [fixtures.orgA, ids.legacyA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
  );
  await fresh.query(
    "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,1,$4,'draft')",
    [fixtures.orgA, ids.legacyWorkflow, ids.parentA, JSON.stringify(workflow(ids.legacyA))],
  );
  const legacyBefore = (await fresh.query("SELECT * FROM app.message_design WHERE id=$1", [ids.legacyA]))
    .rows[0];
  const functionIds = (
    await fresh.query(
      "SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('app','public')ORDER BY p.oid",
    )
  ).rows.map((row) => row.oid);
  beforePrivileges = { functionIds };
  beforePrivileges = { ...beforePrivileges, ...(await unrelatedPrivileges()) };
  stage = "apply_reviewed_candidate";
  await fresh.query(candidate);

  await probe("01 actual four nonowner nonbypass logins and recursive role separation", async () => {
    await assertRuntimeRole(runtime);
    await assertRuntimeRole(roles.estate_worker);
    await assertStaffRole(roles.estate_control, "estate_control");
    await assertStaffRole(roles.estate_staff_issuer, "estate_staff_issuer");
    for (const [role, pool] of Object.entries(roles))
      assert.deepEqual((await pool.query("SELECT current_user,session_user")).rows[0], {
        current_user: role,
        session_user: role,
      });
  });
  await probe("02 FORCE RLS exact private trigger paths and minimal grant surface", async () => {
    for (const table of approvedTables) {
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
    const definer = (
      await fresh.query(
        "SELECT p.oid,p.proname,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app'AND p.prosecdef AND p.proname IN('guard_native_message_design','snapshot_native_message_design','native_design_lock_writer','native_design_migration_login','native_design_is_referenced','prepare_native_workflow_design_bindings','native_workflow_reference_proof')ORDER BY p.proname",
      )
    ).rows;
    assert.equal(definer.length, 7);
    for (const row of definer) {
      assert.deepEqual(row.proconfig, ["search_path=pg_catalog"]);
      for (const role of Object.keys(roles))
        assert.equal(
          (await fresh.query("SELECT has_function_privilege($1,$2,'EXECUTE')AS allowed", [role, row.oid]))
            .rows[0].allowed,
          row.proname === "native_workflow_reference_proof" && role === "estate_runtime",
        );
      assert.equal(
        (
          await fresh.query(
            "SELECT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))a WHERE p.oid=$1 AND a.grantee=0 AND a.privilege_type='EXECUTE')AS allowed",
            [row.oid],
          )
        ).rows[0].allowed,
        false,
      );
    }
    for (const table of ["message_design_revision", "campaign_workflow_design_reference"])
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"])
        assert.equal(
          (
            await fresh.query("SELECT has_table_privilege('estate_runtime',$1,$2)AS allowed", [
              "app." + table,
              privilege,
            ])
          ).rows[0].allowed,
          false,
        );
  });
  await probe(
    "03 preserved legacy content is not rewritten guessed snapshotted or current-readable",
    async () => {
      const row = await currentDesign(ids.legacyA);
      assert.equal(row.subject, null);
      assert.equal(row.history_ready, false);
      assert.equal(row.version, legacyBefore.version);
      for (const column of ["design", "rendered_content", "content_hash", "row_version", "created_at"])
        assert.deepEqual(
          row[column] ??
            (await fresh.query("SELECT " + column + " FROM app.message_design WHERE id=$1", [ids.legacyA]))
              .rows[0][column],
          legacyBefore[column],
        );
      assert.equal((await history(ids.legacyA)).length, 0);
      assert.equal(
        (
          await fresh.query(
            "SELECT * FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [ids.legacyWorkflow],
          )
        ).rowCount,
        0,
      );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(
          (await client.query("SELECT id FROM app.message_design WHERE id=$1", [ids.legacyA])).rowCount,
          0,
        );
        assert.equal(
          (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [ids.legacyWorkflow]))
            .rowCount,
          0,
        );
        assert.equal((await editDesign(client, ids.legacyA)).rowCount, 0);
      });
    },
  );
  await probe(
    "04 missing context has no source history binding visibility and no insert authority",
    async () => {
      await transaction(runtime, async (client) => {
        for (const table of approvedTables)
          assert.equal(
            (await client.query("SELECT count(*)::int AS count FROM app." + table)).rows[0].count,
            0,
          );
        await denied(
          client,
          "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
          [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
        );
      });
    },
  );
  await probe("05 native create preserves subject exact text hash and one truthful snapshot", async () => {
    for (const [identity, tenant, id] of [
      [ownerA, fixtures.orgA, ids.sourceA],
      [ownerB, fixtures.orgB, ids.sourceB],
    ])
      await withTenantTransaction(runtime, identity, async (client) => {
        const row = (await insertDesign(client, tenant, id)).rows[0];
        assert.equal(row.version, 1);
        assert.equal(row.row_version, "1");
        assert.equal(row.history_ready, true);
        assert.equal(row.subject, basic.subject);
        assert.deepEqual(row.design, basic.design);
        assert.equal(row.rendered_content, basic.content);
        assert.equal(row.content_hash, basic.hash);
      });
    assert.deepEqual(await history(ids.sourceA), [
      {
        version: 1,
        source_row_version: "1",
        name: basic.name,
        channel: "email",
        subject: basic.subject,
        editor_kind: "native",
        design: basic.design,
        rendered_content: basic.content,
        content_hash: basic.hash,
      },
    ]);
  });
  await probe("06 tenant actor foreignIDs and pooled A B anonymous contexts remain isolated", async () => {
    const a = await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.equal(
        (await client.query("SELECT id FROM app.message_design WHERE id=$1", [ids.sourceB])).rowCount,
        0,
      );
      await denied(
        client,
        "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
        [fixtures.orgB, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
      );
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    const b = await withTenantTransaction(runtime, ownerB, async (client) => {
      assert.deepEqual((await client.query("SELECT id FROM app.message_design")).rows, [{ id: ids.sourceB }]);
      return (await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
    });
    assert.equal(a, b);
    const row = (
      await runtime.query(
        "SELECT pg_backend_pid()AS pid,nullif(current_setting('app.tenant_id',true),'')AS tenant,nullif(current_setting('app.actor_id',true),'')AS actor,(SELECT count(*)::int FROM app.message_design)AS designs",
      )
    ).rows[0];
    assert.deepEqual(row, { pid: a, tenant: null, actor: null, designs: 0 });
    for (const actor of ["", randomUUID(), fixtures.agentUser])
      await transaction(runtime, async (client) => {
        await context(client, fixtures.orgA, actor);
        assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
        await denied(
          client,
          "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
          [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
        );
      });
  });
  await probe(
    "07 edits append coupled immutable revisions without a runtime history body directory",
    async () => {
      const body = native("Synthetic second snapshot.", null);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        const row = (await editDesign(client, ids.sourceA, body)).rows[0];
        assert.equal(row.version, 2);
        assert.equal(row.row_version, "2");
        assert.equal(row.subject, null);
        assert.deepEqual(
          (
            await client.query(
              "SELECT version,content_hash,source_row_version FROM app.message_design_revision WHERE message_design_id=$1",
              [ids.sourceA],
            )
          ).rows,
          [{ version: 2, content_hash: body.hash, source_row_version: "2" }],
        );
        for (const column of [
          "name",
          "subject",
          "design",
          "rendered_content",
          "channel",
          "editor_kind",
          "observed_at",
        ])
          await denied(
            client,
            "SELECT " + column + " FROM app.message_design_revision WHERE message_design_id=$1",
            [ids.sourceA],
          );
      });
      assert.equal((await history(ids.sourceA)).length, 2);
      assert.equal((await history(ids.sourceA))[0].content_hash, basic.hash);
    },
  );
  await probe(
    "08 mismatched content hash design editor and unsafe static syntax reject atomically",
    async () => {
      const before = await currentDesign(ids.sourceA),
        snapshots = await history(ids.sourceA);
      const bad = [
        { ...basic, hash: "0".repeat(64) },
        { ...basic, content: "Mismatched content" },
        { ...basic, editor: "unlayer" },
        { ...basic, design: { ...basic.design, extra: true } },
        { ...native("<p>Unsafe markup</p>") },
        { ...native("http://unavailable.example.test") },
        { ...native("Hello {{contact.name}}") },
        { ...native("$" + "{arbitrary_template}") },
        { ...native("   ") },
        { ...basic, subject: "Subject\nnewline" },
      ];
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const body of bad.filter((body) => body.editor === "native"))
          await denied(
            client,
            "UPDATE app.message_design SET name=$2,subject=$3,design=$4,rendered_content=$5,content_hash=$6 WHERE id=$1",
            [ids.sourceA, body.name, body.subject, JSON.stringify(body.design), body.content, body.hash],
            ["23514"],
          );
        for (const body of bad)
          await denied(
            client,
            "INSERT INTO app.message_design(tenant_id,name,channel,subject,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              fixtures.orgA,
              body.name,
              body.channel,
              body.subject,
              body.editor,
              JSON.stringify(body.design),
              body.content,
              body.hash,
            ],
            ["23514"],
          );
      });
      assert.deepEqual(await currentDesign(ids.sourceA), before);
      assert.deepEqual(await history(ids.sourceA), snapshots);
    },
  );
  await probe(
    "09 protected identity lifecycle counters flags and private trigger calls cannot be written",
    async () => {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const column of [
          "tenant_id",
          "id",
          "channel",
          "editor_kind",
          "version",
          "created_at",
          "updated_at",
          "availability_state",
          "history_ready",
        ])
          await denied(client, "UPDATE app.message_design SET " + column + "=" + column + " WHERE id=$1", [
            ids.sourceA,
          ]);
        await denied(
          client,
          "UPDATE app.message_design SET row_version=row_version+1 WHERE id=$1",
          [ids.sourceA],
          ["23514"],
          "native_design_identity_immutable",
        );
        await denied(client, "DELETE FROM app.message_design WHERE id=$1", [ids.sourceA]);
        await denied(client, "TRUNCATE app.message_design");
        for (const extra of ["version", "row_version", "history_ready", "availability_state"])
          await denied(
            client,
            "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash," +
              extra +
              ")VALUES($1,$2,'email','native',$3,$4,$5,DEFAULT)",
            [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
          );
        await denied(client, "SELECT app.native_design_is_referenced($1,$2)", [fixtures.orgA, ids.sourceA]);
        await denied(client, "SELECT app.native_design_lock_writer()");
        await denied(client, "INSERT INTO app.campaign_workflow_design_reference(tenant_id)VALUES($1)", [
          fixtures.orgA,
        ]);
        await denied(client, "INSERT INTO app.message_design_revision(tenant_id)VALUES($1)", [fixtures.orgA]);
      });
    },
  );
  await probe(
    "10 source read locks require read authority while real mutations require organization write",
    async () => {
      const original = (
        await fresh.query(
          "SELECT permission_grants FROM app.role_definition WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA],
        )
      ).rows[0].permission_grants;
      try {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA, JSON.stringify([{ code: "campaigns.read", scope: "organization" }])],
        );
        await withTenantTransaction(runtime, ownerA, async (client) => {
          assert.equal(
            (await client.query("SELECT id FROM app.message_design WHERE id=$1 FOR SHARE", [ids.sourceA]))
              .rowCount,
            1,
          );
          await denied(client, "UPDATE app.message_design SET name=$2 WHERE id=$1", [
            ids.sourceA,
            "Synthetic read-only edit",
          ]);
          await denied(
            client,
            "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
            [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
          );
        });
        for (const scope of ["own", "team"]) {
          await fresh.query(
            "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
            [
              fixtures.ownerMemberA,
              JSON.stringify([
                { code: "campaigns.read", scope },
                { code: "campaigns.write", scope },
              ]),
            ],
          );
          await transaction(runtime, async (client) => {
            await context(client);
            assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
          });
        }
      } finally {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA, JSON.stringify(original)],
        );
      }
    },
  );
  await probe(
    "11 actual other identities gain no marketing source history or binding privileges",
    async () => {
      for (const role of ["estate_worker", "estate_control", "estate_staff_issuer"])
        await transaction(roles[role], async (client) => {
          await context(client);
          for (const table of approvedTables) {
            await denied(client, "SELECT * FROM app." + table);
            await denied(client, "INSERT INTO app." + table + "(tenant_id)VALUES($1)", [fixtures.orgA]);
            await denied(client, "DELETE FROM app." + table);
            await denied(client, "TRUNCATE app." + table);
          }
        });
    },
  );
  await probe("12 snapshots and bindings reject bypass-owner update or deletion too", async () => {
    await transaction(fresh, async (client) => {
      for (const operation of [
        "UPDATE app.message_design_revision SET name=name",
        "DELETE FROM app.message_design_revision",
      ])
        await denied(client, operation, [], ["55000"]);
    });
  });
  await probe(
    "13 current disabled absent expired capability and disabled actor deny source writes",
    async () => {
      try {
        for (const clause of [
          "state='disabled'",
          "state='enabled',effective_until=clock_timestamp()-interval '1 second'",
        ]) {
          await fresh.query(
            "UPDATE app.entitlement SET " + clause + " WHERE tenant_id=$1 AND feature='marketing'",
            [fixtures.orgA],
          );
          await transaction(runtime, async (client) => {
            await context(client);
            assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
            await denied(
              client,
              "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
              [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
            );
          });
        }
        await fresh.query("DELETE FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing'", [
          fixtures.orgA,
        ]);
        await transaction(runtime, async (client) => {
          await context(client);
          assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
          await denied(
            client,
            "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
            [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
          );
        });
      } finally {
        await fresh.query(
          "INSERT INTO app.entitlement(tenant_id,feature,state)VALUES($1,'marketing','enabled')ON CONFLICT(tenant_id,feature)DO UPDATE SET state='enabled',effective_until=NULL",
          [fixtures.orgA],
        );
      }
      try {
        await fresh.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [fixtures.ownerMemberA]);
        await transaction(runtime, async (client) => {
          await context(client);
          assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
        });
      } finally {
        await fresh.query("UPDATE app.membership SET status='active'WHERE id=$1", [fixtures.ownerMemberA]);
      }
    },
  );
  await probe("14 expiry after an observed aggregate UPDATE wait denies edit and snapshot", async () => {
    const before = await currentDesign(ids.sourceA),
      snapshots = await history(ids.sourceA);
    await blockedMutation({
      lock: (client) =>
        client.query("SELECT id FROM app.message_design WHERE id=$1 FOR UPDATE", [ids.sourceA]),
      operation: (client) => editDesign(client, ids.sourceA),
      expired: true,
    });
    assert.deepEqual(await currentDesign(ids.sourceA), before);
    assert.deepEqual(await history(ids.sourceA), snapshots);
  });
  await probe("15 current actor is rechecked after genuine membership SHARE lock wait", async () => {
    const id = randomUUID();
    try {
      await blockedMutation({
        lock: (client) =>
          client.query("SELECT id FROM app.membership WHERE id=$1 FOR UPDATE", [fixtures.ownerMemberA]),
        operation: (client) => insertDesign(client, fixtures.orgA, id),
        change: (client) =>
          client.query("UPDATE app.membership SET status='disabled'WHERE id=$1", [fixtures.ownerMemberA]),
      });
      assert.equal((await fresh.query("SELECT id FROM app.message_design WHERE id=$1", [id])).rowCount, 0);
    } finally {
      await fresh.query("UPDATE app.membership SET status='active'WHERE id=$1", [fixtures.ownerMemberA]);
    }
  });
  await probe("16 enabled capability is rechecked after genuine entitlement SHARE lock wait", async () => {
    const id = randomUUID();
    try {
      await blockedMutation({
        lock: (client) =>
          client.query(
            "SELECT id FROM app.entitlement WHERE tenant_id=$1 AND feature='marketing'FOR UPDATE",
            [fixtures.orgA],
          ),
        operation: (client) => insertDesign(client, fixtures.orgA, id),
        change: (client) =>
          client.query(
            "UPDATE app.entitlement SET state='disabled'WHERE tenant_id=$1 AND feature='marketing'",
            [fixtures.orgA],
          ),
      });
      assert.equal((await fresh.query("SELECT id FROM app.message_design WHERE id=$1", [id])).rowCount, 0);
    } finally {
      await fresh.query(
        "UPDATE app.entitlement SET state='enabled'WHERE tenant_id=$1 AND feature='marketing'",
        [fixtures.orgA],
      );
    }
  });
  await probe(
    "17 workflow reference captures authoritative current design ordinal hash and immutable source",
    async () => {
      const id = randomUUID(),
        parent = await newParent(),
        before = await currentDesign(ids.sourceA);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(
          (await insertWorkflow(client, fixtures.orgA, parent, id)).rows[0].design_bindings_ready,
          true,
        );
        assert.deepEqual(
          (
            await client.query(
              "SELECT node_key,message_design_id,design_version,content_hash FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
              [id],
            )
          ).rows,
          [
            {
              node_key: "start",
              message_design_id: ids.sourceA,
              design_version: before.version,
              content_hash: before.content_hash,
            },
          ],
        );
        await denied(
          client,
          "UPDATE app.message_design SET name=$2 WHERE id=$1",
          [ids.sourceA, "Referenced edit"],
          ["23514"],
          "native_design_unreferenced",
        );
      });
      await transaction(fresh, async (client) => {
        await denied(
          client,
          "UPDATE app.campaign_workflow_design_reference SET node_key=node_key",
          [],
          ["55000"],
        );
        await denied(client, "DELETE FROM app.campaign_workflow_design_reference", [], ["55000"]);
      });
    },
  );
  await probe(
    "18 foreign incompatible archived legacy and unlicensed source references are unavailable",
    async () => {
      const unavailable = randomUUID(),
        archived = randomUUID();
      await insertDesign(fresh, fixtures.orgA, unavailable, { ...basic, editor: "unlayer" });
      await insertDesign(fresh, fixtures.orgA, archived);
      await fresh.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [archived]);
      const parent = await newParent();
      await withTenantTransaction(runtime, ownerA, async (client) => {
        for (const [id, channel] of [
          [ids.sourceB, "email"],
          [ids.legacyA, "email"],
          [unavailable, "email"],
          [archived, "email"],
          [ids.sourceA, "sms"],
          [randomUUID(), "email"],
        ])
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,1,$3,'draft')",
            [fixtures.orgA, parent, JSON.stringify(workflow(id, channel))],
            ["23514"],
            "native_workflow_design_source",
          );
      });
      assert.equal(
        (await fresh.query("SELECT id FROM app.campaign_version WHERE campaign_id=$1", [parent])).rowCount,
        0,
      );
    },
  );
  await probe("19 hidden preserved workflow step and scheduled references deny source edits", async () => {
    for (const kind of ["workflow", "step", "scheduled"]) {
      const id = randomUUID(),
        parent = await newParent(),
        version = randomUUID();
      await insertDesign(fresh, fixtures.orgA, id);
      await insertWorkflow(
        fresh,
        fixtures.orgA,
        parent,
        version,
        kind === "workflow" ? workflow(id) : withoutMessages,
        "published",
      );
      if (kind === "step")
        await fresh.query(
          "INSERT INTO app.campaign_step(tenant_id,version_id,node_key,kind,message_design_id,config)VALUES($1,$2,'hidden','email',$3,'{}')",
          [fixtures.orgA, version, id],
        );
      if (kind === "scheduled")
        await fresh.query(
          "INSERT INTO app.scheduled_action(tenant_id,lead_id,message_design_id,kind,message_snapshot,due_at,idempotency_key,state)VALUES($1::uuid,$2::uuid,$3::uuid,'email','{}',clock_timestamp(),'synthetic-hidden-'||($3::uuid)::text,'pending')",
          [fixtures.orgA, fixtures.leadA, id],
        );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(
          (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
          0,
        );
        await denied(
          client,
          "UPDATE app.message_design SET name=$2 WHERE id=$1",
          [id, "Hidden reference edit"],
          ["23514"],
          "native_design_unreferenced",
        );
      });
    }
  });
  await probe("20 reference SHARE first serializes a concurrent edit into immutable denial", async () => {
    const id = randomUUID(),
      parent = await newParent(),
      version = randomUUID();
    await insertDesign(fresh, fixtures.orgA, id);
    const reader = await runtime.connect();
    let held = false,
      pending,
      resolvePid;
    const started = new Promise((resolve) => {
      resolvePid = resolve;
    });
    try {
      await reader.query("BEGIN");
      held = true;
      await context(reader);
      const readerPid = (await reader.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
      await insertWorkflow(reader, fixtures.orgA, parent, version, workflow(id));
      pending = transaction(
        parallel,
        async (client) => {
          await context(client);
          resolvePid((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
          return editDesign(client, id);
        },
        true,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await observedWait(await started, readerPid);
      await reader.query("COMMIT");
      held = false;
      assert.equal((await pending).error?.constraint, "native_design_unreferenced");
      assert.equal((await currentDesign(id)).version, 1);
      assert.equal(
        (
          await fresh.query(
            "SELECT design_version FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [version],
          )
        ).rows[0].design_version,
        1,
      );
    } finally {
      if (held) await reader.query("ROLLBACK").catch(() => {});
      if (pending) await pending;
      reader.release();
    }
  });
  await probe("21 edit UPDATE first makes waiting workflow capture the committed new snapshot", async () => {
    const id = randomUUID(),
      parent = await newParent(),
      version = randomUUID(),
      body = native("Synthetic race updated text.");
    await insertDesign(fresh, fixtures.orgA, id);
    const editor = await runtime.connect();
    let held = false,
      pending,
      resolvePid;
    const started = new Promise((resolve) => {
      resolvePid = resolve;
    });
    try {
      await editor.query("BEGIN");
      held = true;
      await context(editor);
      const editorPid = (await editor.query("SELECT pg_backend_pid()AS pid")).rows[0].pid;
      assert.equal((await editDesign(editor, id, body)).rows[0].version, 2);
      pending = transaction(
        parallel,
        async (client) => {
          await context(client);
          resolvePid((await client.query("SELECT pg_backend_pid()AS pid")).rows[0].pid);
          return insertWorkflow(client, fixtures.orgA, parent, version, workflow(id));
        },
        true,
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await observedWait(await started, editorPid);
      await editor.query("COMMIT");
      held = false;
      assert.equal((await pending).error, undefined);
      assert.deepEqual(
        (
          await fresh.query(
            "SELECT design_version,content_hash FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [version],
          )
        ).rows,
        [{ design_version: 2, content_hash: body.hash }],
      );
    } finally {
      if (held) await editor.query("ROLLBACK").catch(() => {});
      if (pending) await pending;
      editor.release();
    }
  });
  await probe(
    "22 archive during observed source SHARE wait denies workflow without stale bindings",
    async () => {
      const id = randomUUID(),
        parent = await newParent(),
        version = randomUUID();
      await insertDesign(fresh, fixtures.orgA, id);
      await blockedMutation({
        lock: (client) => client.query("SELECT id FROM app.message_design WHERE id=$1 FOR UPDATE", [id]),
        operation: (client) => insertWorkflow(client, fixtures.orgA, parent, version, workflow(id)),
        change: (client) =>
          client.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [id]),
        expected: "23514",
      });
      assert.equal(
        (await fresh.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
        0,
      );
      assert.equal(
        (
          await fresh.query(
            "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [version],
          )
        ).rowCount,
        0,
      );
    },
  );
  await probe("23 ordinal and rowversion exhaustion deny source mutation without new snapshot", async () => {
    for (const [version, rowVersion] of [
      [2147483647, "1"],
      [1, "9223372036854775807"],
    ]) {
      const id = randomUUID();
      await fresh.query(
        "INSERT INTO app.message_design(tenant_id,id,name,channel,subject,version,row_version,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,$3,'email',$4,$5,$6,'native',$7,$8,$9)",
        [
          fixtures.orgA,
          id,
          basic.name,
          basic.subject,
          version,
          rowVersion,
          JSON.stringify(basic.design),
          basic.content,
          basic.hash,
        ],
      );
      const before = await currentDesign(id),
        snapshots = await history(id);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await denied(
          client,
          "UPDATE app.message_design SET name=$2 WHERE id=$1",
          [id, "Exhausted source edit"],
          ["23514"],
          "native_design_sequence_available",
        );
      });
      assert.deepEqual(await currentDesign(id), before);
      assert.deepEqual(await history(id), snapshots);
    }
  });
  await probe(
    "24 caller rollback atomically removes source snapshot workflow and typed references",
    async () => {
      const id = randomUUID(),
        parent = await newParent(),
        version = randomUUID(),
        rollback = new Error("Synthetic caller rollback");
      await assert.rejects(
        withTenantTransaction(runtime, ownerA, async (client) => {
          await insertDesign(client, fixtures.orgA, id);
          await editDesign(client, id);
          await insertWorkflow(client, fixtures.orgA, parent, version, workflow(id));
          assert.equal(
            (
              await client.query(
                "SELECT message_design_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
                [version],
              )
            ).rowCount,
            1,
          );
          throw rollback;
        }),
        (error) => error === rollback,
      );
      for (const [table, column, value] of [
        ["message_design", "id", id],
        ["message_design_revision", "message_design_id", id],
        ["campaign_version", "id", version],
        ["campaign_workflow_design_reference", "campaign_version_id", version],
      ])
        assert.equal(
          (
            await fresh.query(
              "SELECT count(*)::int AS count FROM app." + table + " WHERE " + column + "=$1",
              [value],
            )
          ).rows[0].count,
          0,
        );
    },
  );
  await probe("25 no step enrollment scheduling delivery or permissive policy escape is gained", async () => {
    for (const table of [
      "campaign_step",
      "automation_rule",
      "enrollment",
      "scheduled_action",
      "delivery_attempt",
    ])
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await denied(client, "SELECT * FROM app." + table);
        await denied(client, "INSERT INTO app." + table + "(tenant_id)VALUES($1)", [fixtures.orgA]);
        await denied(client, "UPDATE app." + table + " SET row_version=row_version+1");
        await denied(client, "DELETE FROM app." + table);
        await denied(client, "TRUNCATE app." + table);
      });
    await fresh.query(
      "CREATE POLICY verifier_extra_permissive ON app.message_design TO estate_runtime USING(true)WITH CHECK(true)",
    );
    try {
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(
          (await client.query("SELECT id FROM app.message_design WHERE id=$1", [ids.sourceB])).rowCount,
          0,
        );
        assert.equal(
          (await client.query("SELECT id FROM app.message_design WHERE id=$1", [ids.legacyA])).rowCount,
          0,
        );
        await denied(
          client,
          "UPDATE app.message_design SET name=$2 WHERE id=$1",
          [ids.sourceA, "Referenced permissive edit"],
          ["23514"],
          "native_design_unreferenced",
        );
      });
    } finally {
      await fresh.query("DROP POLICY verifier_extra_permissive ON app.message_design");
    }
  });
  await probe("26 expiry during observed workflow source SHARE wait denies capture atomically", async () => {
    const id = randomUUID(),
      parent = await newParent(),
      version = randomUUID();
    await insertDesign(fresh, fixtures.orgA, id);
    await blockedMutation({
      lock: (client) => client.query("SELECT id FROM app.message_design WHERE id=$1 FOR UPDATE", [id]),
      operation: (client) => insertWorkflow(client, fixtures.orgA, parent, version, workflow(id)),
      expired: true,
    });
    assert.equal(
      (await fresh.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
      0,
    );
    assert.equal(
      (
        await fresh.query(
          "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
          [version],
        )
      ).rowCount,
      0,
    );
    assert.equal((await currentDesign(id)).version, 1);
  });
  await probe(
    "27 write-only authority cannot stand in for current referenced-content read scope",
    async () => {
      const parent = await newParent(),
        version = randomUUID();
      const original = (
        await fresh.query(
          "SELECT permission_grants FROM app.role_definition WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA],
        )
      ).rows[0].permission_grants;
      try {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA, JSON.stringify([{ code: "campaigns.write", scope: "organization" }])],
        );
        await transaction(runtime, async (client) => {
          await context(client);
          await denied(
            client,
            "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,1,$4,'draft')",
            [fixtures.orgA, version, parent, JSON.stringify(workflow(ids.sourceA))],
          );
          const empty = randomUUID();
          assert.equal(
            (await insertWorkflow(client, fixtures.orgA, parent, empty, withoutMessages)).rows[0]
              .design_bindings_ready,
            true,
          );
        });
      } finally {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA, JSON.stringify(original)],
        );
      }
      assert.equal(
        (await fresh.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
        0,
      );
    },
  );
  await probe(
    "28 role grant and organization status revocations after observed writer waits deny capture",
    async () => {
      const role = (
        await fresh.query(
          "SELECT r.id,r.permission_grants FROM app.role_definition r JOIN app.membership m ON m.tenant_id=r.tenant_id AND m.role_id=r.id WHERE m.id=$1",
          [fixtures.ownerMemberA],
        )
      ).rows[0];
      try {
        const id = randomUUID();
        await blockedMutation({
          lock: (client) =>
            client.query("SELECT id FROM app.role_definition WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [
              fixtures.orgA,
              role.id,
            ]),
          operation: (client) => insertDesign(client, fixtures.orgA, id),
          change: (client) =>
            client.query("UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2", [
              fixtures.orgA,
              role.id,
              JSON.stringify(role.permission_grants.filter((grant) => grant.code !== "campaigns.write")),
            ]),
        });
        assert.equal((await fresh.query("SELECT id FROM app.message_design WHERE id=$1", [id])).rowCount, 0);
      } finally {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$3 WHERE tenant_id=$1 AND id=$2",
          [fixtures.orgA, role.id, JSON.stringify(role.permission_grants)],
        );
      }
      try {
        const id = randomUUID();
        await blockedMutation({
          lock: (client) =>
            client.query("SELECT id FROM app.organization WHERE id=$1 FOR UPDATE", [fixtures.orgA]),
          operation: (client) => insertDesign(client, fixtures.orgA, id),
          change: (client) =>
            client.query("UPDATE app.organization SET status='suspended'WHERE id=$1", [fixtures.orgA]),
        });
        assert.equal((await fresh.query("SELECT id FROM app.message_design WHERE id=$1", [id])).rowCount, 0);
      } finally {
        await fresh.query("UPDATE app.organization SET status='active'WHERE id=$1", [fixtures.orgA]);
      }
    },
  );
  await probe("29 multiline Unicode blocks keep exact LF joining and escaped UTF8 byte bounds", async () => {
    const id = randomUUID(),
      text = "Synthetic emoji 😀\n\tSecond synthetic block.";
    const body = {
      ...native(text, null),
      design: {
        schemaVersion: 1,
        blocks: [
          { type: "text", text: "Synthetic emoji 😀" },
          { type: "text", text: "\tSecond synthetic block." },
        ],
      },
    };
    await withTenantTransaction(runtime, ownerA, async (client) => {
      const row = (await insertDesign(client, fixtures.orgA, id, body)).rows[0];
      assert.equal(row.rendered_content, text);
      assert.equal(row.content_hash, sha(text));
      assert.deepEqual(row.design, body.design);
      const oversized = native("😀".repeat(35_000));
      await denied(
        client,
        "INSERT INTO app.message_design(tenant_id,name,channel,subject,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email',$3,'native',$4,$5,$6)",
        [
          fixtures.orgA,
          oversized.name,
          oversized.subject,
          JSON.stringify(oversized.design),
          oversized.content,
          oversized.hash,
        ],
        ["23514"],
        "native_design_payload_valid",
      );
    });
    assert.equal((await history(id))[0].content_hash, sha(text));
  });
  await probe("30 a masked migration session cannot mint actual runtime design authority", async () => {
    await transaction(fresh, async (client) => {
      await context(client);
      await client.query("SET LOCAL ROLE estate_runtime");
      const identity = (await client.query("SELECT session_user,current_user")).rows[0];
      assert.notEqual(identity.session_user, "estate_runtime");
      assert.equal(identity.current_user, "estate_runtime");
      assert.equal((await client.query("SELECT id FROM app.message_design")).rowCount, 0);
      await denied(
        client,
        "INSERT INTO app.message_design(tenant_id,name,channel,editor_kind,design,rendered_content,content_hash)VALUES($1,$2,'email','native',$3,$4,$5)",
        [fixtures.orgA, basic.name, JSON.stringify(basic.design), basic.content, basic.hash],
      );
    });
  });
  await probe("31 INSERT RETURNING binds repeated email and SMS sources before new-row proof", async () => {
    const email = randomUUID(),
      sms = randomUUID(),
      parent = await newParent(),
      version = randomUUID();
    const emailBody = native("Synthetic repeated email text."),
      smsBody = { ...native("Synthetic SMS text.", null), channel: "sms" };
    const definition = {
      nodes: [
        { key: "start", kind: "email", messageDesignId: email },
        { key: "again", kind: "email", messageDesignId: email },
        { key: "sms", kind: "sms", messageDesignId: sms },
      ],
      edges: [
        { from: "start", to: "again", branch: "always" },
        { from: "again", to: "sms", branch: "always" },
      ],
      timezone: "UTC",
    };
    await withTenantTransaction(runtime, ownerA, async (client) => {
      await insertDesign(client, fixtures.orgA, email, emailBody);
      await insertDesign(client, fixtures.orgA, sms, smsBody);
      const row = (await insertWorkflow(client, fixtures.orgA, parent, version, definition)).rows[0];
      assert.equal(row.id, version);
      assert.equal(row.state, "draft");
      assert.equal(row.version, 1);
      assert.equal(row.design_bindings_ready, true);
      assert.deepEqual(row.definition, definition);
      assert.equal(await referenceProof(client, fixtures.orgA, version, definition), true);
      assert.equal(
        (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
        1,
      );
    });
    const rows = (
      await fresh.query(
        "SELECT node_key,message_design_id,design_version,content_hash,captured_campaign_id,initiating_actor_id,definition_hash FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1 ORDER BY node_key",
        [version],
      )
    ).rows;
    assert.deepEqual(
      rows.map(({ node_key, message_design_id, design_version, content_hash }) => ({
        node_key,
        message_design_id,
        design_version,
        content_hash,
      })),
      [
        { node_key: "again", message_design_id: email, design_version: 1, content_hash: emailBody.hash },
        { node_key: "sms", message_design_id: sms, design_version: 1, content_hash: smsBody.hash },
        { node_key: "start", message_design_id: email, design_version: 1, content_hash: emailBody.hash },
      ],
    );
    for (const row of rows) {
      assert.equal(row.captured_campaign_id, parent);
      assert.equal(row.initiating_actor_id, fixtures.ownerUser);
      assert.match(row.definition_hash, /^[a-f0-9]{64}$/);
    }
    assert.equal(new Set(rows.map((row) => row.definition_hash)).size, 1);
    assert.equal((await history(email)).length, 1);
    assert.equal((await history(sms)).length, 1);
  });
  await probe("32 private proof provenance and history bodies have no runtime projection", async () => {
    await withTenantTransaction(runtime, ownerA, async (client) => {
      for (const column of [
        "captured_at",
        "captured_campaign_id",
        "initiating_actor_id",
        "capture_transaction",
        "definition_hash",
      ])
        await denied(client, "SELECT " + column + " FROM app.campaign_workflow_design_reference");
      for (const column of [
        "observed_at",
        "name",
        "channel",
        "subject",
        "editor_kind",
        "design",
        "rendered_content",
      ])
        await denied(client, "SELECT " + column + " FROM app.message_design_revision");
      assert(
        (
          await client.query(
            "SELECT tenant_id,message_design_id,version,content_hash,source_row_version FROM app.message_design_revision",
          )
        ).rowCount > 0,
      );
      assert(
        (
          await client.query(
            "SELECT tenant_id,campaign_version_id,node_key,message_design_id,design_version,content_hash FROM app.campaign_workflow_design_reference",
          )
        ).rowCount > 0,
      );
    });
  });
  await probe(
    "33 scoped Boolean proof rejects supplied graph identity tenant and absent-row forgery",
    async () => {
      const source = randomUUID(),
        parent = await newParent(),
        version = randomUUID(),
        definition = workflow(source),
        missing = randomUUID();
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await insertDesign(client, fixtures.orgA, source);
        assert.equal(await referenceProof(client, fixtures.orgA, missing, definition), false);
        await insertWorkflow(client, fixtures.orgA, parent, version, definition);
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), true);
        assert.equal(await referenceProof(client, fixtures.orgB, version, definition), false);
        assert.equal(
          await referenceProof(client, fixtures.orgA, version, { ...definition, timezone: "Etc/UTC" }),
          false,
        );
        assert.equal(
          await referenceProof(client, fixtures.orgA, ids.legacyWorkflow, workflow(ids.legacyA)),
          false,
        );
      });
      await transaction(runtime, async (client) => {
        await context(client);
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), true);
        assert.equal(await referenceProof(client, fixtures.orgA, missing, definition), false);
        await context(client, fixtures.orgA, fixtures.agentUser);
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
        await context(client, fixtures.orgB);
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
        await client.query("SELECT set_config('app.tenant_id','',true),set_config('app.actor_id','',true)");
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
      });
      const hidden = randomUUID();
      await fresh.query(
        "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,2,$4,'published')",
        [fixtures.orgA, hidden, parent, JSON.stringify(definition)],
      );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(await referenceProof(client, fixtures.orgA, hidden, definition), false);
      });
    },
  );
  await probe("34 later duplicate-row and statement failures remove private BEFORE bindings", async () => {
    const source = randomUUID(),
      parent = await newParent(),
      existing = randomUUID();
    await insertDesign(fresh, fixtures.orgA, source);
    await insertWorkflow(fresh, fixtures.orgA, parent, existing, withoutMessages);
    await withTenantTransaction(runtime, ownerA, async (client) => {
      await denied(
        client,
        "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,1,$4,'draft')",
        [fixtures.orgA, existing, parent, JSON.stringify(workflow(source))],
        ["23505"],
      );
      assert.equal(
        (
          await client.query(
            "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [existing],
          )
        ).rowCount,
        0,
      );
    });
    const failedSource = randomUUID(),
      failedVersion = randomUUID();
    await assert.rejects(
      transaction(
        runtime,
        async (client) => {
          await context(client);
          await insertDesign(client, fixtures.orgA, failedSource);
          await insertWorkflow(client, fixtures.orgA, parent, failedVersion, workflow(failedSource));
          await client.query("SELECT 1/0");
        },
        true,
      ),
      (error) => error.code === "22012",
    );
    for (const [table, column, value] of [
      ["message_design", "id", failedSource],
      ["message_design_revision", "message_design_id", failedSource],
      ["campaign_version", "id", failedVersion],
      ["campaign_workflow_design_reference", "campaign_version_id", failedVersion],
    ])
      assert.equal(
        (await fresh.query("SELECT 1 FROM app." + table + " WHERE " + column + "=$1", [value])).rowCount,
        0,
      );
    assert.equal(
      (
        await fresh.query(
          "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
          [existing],
        )
      ).rowCount,
      0,
    );
  });
  await probe(
    "35 deferred workflow FK fails at COMMIT and rolls back source history and orphan proof",
    async () => {
      const source = randomUUID(),
        parent = await newParent(),
        missing = randomUUID();
      let statementReached = false;
      await assert.rejects(
        transaction(
          fresh,
          async (client) => {
            await insertDesign(client, fixtures.orgA, source);
            await client.query(
              "INSERT INTO app.campaign_workflow_design_reference(tenant_id,campaign_version_id,node_key,message_design_id,design_version,content_hash,captured_campaign_id,initiating_actor_id,capture_transaction,definition_hash)VALUES($1,$2,'start',$3,1,$4,$5,$6,pg_current_xact_id(),encode(sha256(convert_to($7::jsonb::text,'UTF8')),'hex'))",
              [
                fixtures.orgA,
                missing,
                source,
                basic.hash,
                parent,
                fixtures.ownerUser,
                JSON.stringify(workflow(source)),
              ],
            );
            statementReached = true;
            assert.equal(
              (
                await client.query(
                  "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
                  [missing],
                )
              ).rowCount,
              1,
            );
          },
          true,
        ),
        (error) => error.code === "23503",
      );
      assert.equal(
        statementReached,
        true,
        "The assertion must observe deferred COMMIT rather than INSERT failure.",
      );
      assert.equal(
        (await fresh.query("SELECT id FROM app.message_design WHERE id=$1", [source])).rowCount,
        0,
      );
      assert.equal((await history(source)).length, 0);
      assert.equal(
        (
          await fresh.query(
            "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [missing],
          )
        ).rowCount,
        0,
      );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(await referenceProof(client, fixtures.orgA, missing, workflow(source)), false);
      });
    },
  );
  await probe("36 current parent archive invalidates exact remembered workflow proof", async () => {
    const source = randomUUID(),
      parent = await newParent(),
      version = randomUUID(),
      definition = workflow(source);
    await withTenantTransaction(runtime, ownerA, async (client) => {
      await insertDesign(client, fixtures.orgA, source);
      await insertWorkflow(client, fixtures.orgA, parent, version, definition);
    });
    await fresh.query("UPDATE app.campaign SET state='archived'WHERE id=$1", [parent]);
    await withTenantTransaction(runtime, ownerA, async (client) => {
      assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
      assert.equal(
        (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
        0,
      );
    });
  });
  await probe(
    "37 source archive preserves immutable history while current proof and projection deny",
    async () => {
      const source = randomUUID(),
        parent = await newParent(),
        version = randomUUID(),
        definition = workflow(source);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await insertDesign(client, fixtures.orgA, source);
        await insertWorkflow(client, fixtures.orgA, parent, version, definition);
      });
      const snapshots = await history(source);
      await fresh.query("UPDATE app.message_design SET availability_state='archived'WHERE id=$1", [source]);
      const after = await currentDesign(source);
      assert.equal(after.version, 1);
      assert.equal(after.row_version, "2");
      assert.deepEqual(await history(source), snapshots);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
        assert.equal(
          (await client.query("SELECT id FROM app.message_design WHERE id=$1", [source])).rowCount,
          0,
        );
        assert.equal(
          (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query(
              "SELECT message_design_id FROM app.message_design_revision WHERE message_design_id=$1",
              [source],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await client.query(
              "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
              [version],
            )
          ).rowCount,
          0,
        );
      });
    },
  );
  await probe(
    "38 stored proof and workflow reads recheck current capability and organization grants",
    async () => {
      const source = randomUUID(),
        parent = await newParent(),
        version = randomUUID(),
        definition = workflow(source);
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await insertDesign(client, fixtures.orgA, source);
        await insertWorkflow(client, fixtures.orgA, parent, version, definition);
      });
      for (const assignment of [
        "state='disabled'",
        "effective_until=clock_timestamp()-interval '1 second'",
      ]) {
        try {
          await fresh.query(
            "UPDATE app.entitlement SET " + assignment + " WHERE tenant_id=$1 AND feature='marketing'",
            [fixtures.orgA],
          );
          await transaction(runtime, async (client) => {
            await context(client);
            assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
            assert.equal(
              (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
              0,
            );
          });
        } finally {
          await fresh.query(
            "UPDATE app.entitlement SET state='enabled',effective_until=NULL WHERE tenant_id=$1 AND feature='marketing'",
            [fixtures.orgA],
          );
        }
      }
      const original = (
        await fresh.query(
          "SELECT permission_grants FROM app.role_definition WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA],
        )
      ).rows[0].permission_grants;
      try {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [
            fixtures.ownerMemberA,
            JSON.stringify(
              original.filter((grant) => !["campaigns.read", "campaigns.write"].includes(grant.code)),
            ),
          ],
        );
        await transaction(runtime, async (client) => {
          await context(client);
          assert.equal(await referenceProof(client, fixtures.orgA, version, definition), false);
          assert.equal(
            (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [version])).rowCount,
            0,
          );
        });
      } finally {
        await fresh.query(
          "UPDATE app.role_definition SET permission_grants=$2 WHERE id=(SELECT role_id FROM app.membership WHERE id=$1)",
          [fixtures.ownerMemberA, JSON.stringify(original)],
        );
      }
    },
  );
  await probe(
    "39 source capture preserves hidden historical version allocation and exhaustion rollback",
    async () => {
      const parent = await newParent(),
        hidden = randomUUID(),
        created = randomUUID();
      await fresh.query(
        "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,10,$4,'published')",
        [fixtures.orgA, hidden, parent, JSON.stringify(withoutMessages)],
      );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        const row = (await insertWorkflow(client, fixtures.orgA, parent, created)).rows[0];
        assert.equal(row.version, 11);
        assert.equal(
          (await client.query("SELECT id FROM app.campaign_version WHERE id=$1", [hidden])).rowCount,
          0,
        );
      });
      const exhaustedParent = await newParent(),
        failed = randomUUID();
      await fresh.query(
        "INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)VALUES($1,$2,2147483647,$3,'published')",
        [fixtures.orgA, exhaustedParent, JSON.stringify(withoutMessages)],
      );
      await withTenantTransaction(runtime, ownerA, async (client) => {
        await denied(
          client,
          "INSERT INTO app.campaign_version(tenant_id,id,campaign_id,version,definition,state)VALUES($1,$2,$3,1,$4,'draft')",
          [fixtures.orgA, failed, exhaustedParent, JSON.stringify(workflow(ids.sourceA))],
          ["23514"],
          "native_workflow_sequence_available",
        );
      });
      assert.equal(
        (await fresh.query("SELECT id FROM app.campaign_version WHERE id=$1", [failed])).rowCount,
        0,
      );
      assert.equal(
        (
          await fresh.query(
            "SELECT campaign_version_id FROM app.campaign_workflow_design_reference WHERE campaign_version_id=$1",
            [failed],
          )
        ).rowCount,
        0,
      );
    },
  );
  await probe("40 candidate migrations unrelated privileges and cluster roles remain exact", async () => {
    assert.equal(sha(await readFile(candidatePath, "utf8")), candidateHash);
    for (const { name, hash } of migrations)
      assert.equal(sha(await readFile("packages/db/migrations/" + name, "utf8")), hash);
    originalMigrationsUnchanged = true;
    const after = await unrelatedPrivileges();
    assert.deepEqual(after.relations, beforePrivileges.relations);
    assert.deepEqual(after.functions, beforePrivileges.functions);
    unrelatedPrivilegesUnchanged = true;
    assert.equal(await globals(), globalsBefore);
    globalRolesUnchanged = true;
  });
} catch (error) {
  failure = diagnostic(error, stage);
  process.exitCode = 1;
} finally {
  const endings = await Promise.allSettled(pools.map((pool) => pool.end()));
  if (endings.some((result) => result.status === "rejected")) {
    failure ??= { stage: "pool_cleanup", code: "pool_end_failed" };
    process.exitCode = 1;
  }
  try {
    if (created) {
      assert.match(database, /^estate_message_policy_[0-9a-f]{16}$/);
      await cluster.query('DROP DATABASE "' + database + '" WITH (FORCE)');
      dropped =
        (await cluster.query("SELECT datname FROM pg_database WHERE datname=$1", [database])).rowCount === 0;
      assert(dropped, "Exact owned database cleanup failed.");
    }
    if (globalsBefore) {
      globalRolesUnchanged = (await globals()) === globalsBefore;
      assert(globalRolesUnchanged, "Unrelated global identity or database privileges changed.");
    }
  } catch (error) {
    failure ??= diagnostic(error, "cleanup");
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
      unrelatedPrivilegesUnchanged,
      originalMigrationsUnchanged,
      ...(failure ? { failure } : {}),
    }),
  );
}
