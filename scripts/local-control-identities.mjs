import pg from "pg";

// Explicit synthetic local tooling only. Never changes an existing role password.
if (!["development", "test"].includes(process.env.APP_ENV ?? "") || process.env.DEV_AUTH_ENABLED !== "true")
  throw new Error("Synthetic control identities require explicitly enabled development/test mode.");
const source = new URL(process.env.MIGRATION_DATABASE_URL ?? "");
if (
  !["postgres:", "postgresql:"].includes(source.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(source.hostname)
)
  throw new Error("Synthetic control identities require an explicit loopback migration database.");
const roles = [
  ["estate_control", "CONTROL_DATABASE_URL"],
  ["estate_staff_issuer", "STAFF_ISSUER_DATABASE_URL"],
];
const pool = new pg.Pool({ connectionString: source.href, max: 1 });
let stage = "configuration";
try {
  for (const [role, key] of roles) {
    const target = new URL(process.env[key] ?? "");
    if (
      !["postgres:", "postgresql:"].includes(target.protocol) ||
      target.username !== role ||
      !target.password ||
      target.hostname !== source.hostname ||
      target.port !== source.port ||
      target.pathname !== source.pathname ||
      target.search ||
      target.hash
    )
      throw new Error("Explicit control/issuer URLs must bind the expected role and same loopback database.");
    stage = "role_safety";
    const state = (
      await pool.query(
        "SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolpassword IS NULL AS unconfigured FROM pg_authid WHERE rolname=$1",
        [role],
      )
    ).rows[0];
    if (
      !state ||
      state.rolsuper ||
      state.rolbypassrls ||
      state.rolcreatedb ||
      state.rolcreaterole ||
      state.rolinherit
    )
      throw new Error("Reviewed control identity migration is required before local credential setup.");
    if (state.unconfigured) {
      stage = "initial_credential";
      const literal = (
        await pool.query("SELECT quote_literal($1::text) value", [decodeURIComponent(target.password)])
      ).rows[0].value;
      // role comes exclusively from the fixed allowlist; PostgreSQL quotes the password value.
      await pool.query(`ALTER ROLE ${role} PASSWORD ${literal}`);
    }
    stage = "login_verification";
    const login = new pg.Pool({ connectionString: target.href, max: 1, connectionTimeoutMillis: 3000 });
    try {
      const actual = (await login.query("SELECT current_user,session_user")).rows[0];
      if (actual.current_user !== role || actual.session_user !== role)
        throw new Error("Unexpected control identity login.");
    } finally {
      await login.end();
    }
    console.log(
      JSON.stringify({
        syntheticIdentity: role,
        configured: true,
        existingPasswordPreserved: !state.unconfigured,
      }),
    );
  }
} catch {
  throw new Error(
    `Synthetic control identity setup failed during ${stage}; existing credentials were not replaced.`,
  );
} finally {
  await pool.end();
}
