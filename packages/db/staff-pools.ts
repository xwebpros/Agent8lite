import { Pool } from "pg";
import { AccessError } from "./tenant-transaction";
import { assertRuntimeRole } from "./runtime-role";

export type StaffLoginRole = "estate_control" | "estate_staff_issuer";
export function requireSyntheticStaffMode(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  if (!["development", "test"].includes(environment.APP_ENV ?? "") || environment.DEV_AUTH_ENABLED !== "true")
    throw new AccessError(
      401,
      "identity_provider_unconfigured",
      "An approved staff identity provider is required.",
    );
}

/** Check the actual login and every control/issuer SET ROLE path, including NOINHERIT ancestry. */
export async function assertStaffRole(pool: Pool, expected: StaffLoginRole) {
  await assertRuntimeRole(pool);
  const result = await pool.query(`WITH RECURSIVE reachable AS (
    SELECT oid AS login_oid,oid FROM pg_roles WHERE rolname IN('estate_runtime','estate_worker','estate_control','estate_staff_issuer')
    UNION SELECT member_role.login_oid,membership.roleid FROM reachable member_role JOIN pg_auth_members membership ON membership.member=member_role.oid
  )SELECT current_user AS current_role,session_user AS login_role,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND(rolinherit OR rolcreatedb OR rolcreaterole)) AS unsafe_attributes,
    EXISTS(SELECT 1 FROM reachable JOIN pg_roles login ON login.oid=reachable.login_oid JOIN pg_roles parent ON parent.oid=reachable.oid
      WHERE login.rolname<>parent.rolname AND(
        (login.rolname='estate_staff_issuer'AND parent.rolname IN('estate_runtime','estate_worker','estate_control'))OR
        (parent.rolname='estate_staff_issuer'AND login.rolname IN('estate_runtime','estate_worker','estate_control'))OR
        (login.rolname='estate_control'AND parent.rolname IN('estate_runtime','estate_worker'))OR
        (parent.rolname='estate_control'AND login.rolname IN('estate_runtime','estate_worker'))))AS unsafe_crossing`);
  const row = result.rows[0];
  if (
    !row ||
    row.current_role !== expected ||
    row.login_role !== expected ||
    row.unsafe_attributes ||
    row.unsafe_crossing
  )
    throw new AccessError(
      503,
      "staff_database_role_unsafe",
      "Staff database identity separation is required.",
    );
}

export function createStaffPools(environment: Readonly<Record<string, string | undefined>> = process.env) {
  requireSyntheticStaffMode(environment);
  const resolve = (key: string, role: StaffLoginRole) => {
    let url: URL;
    try {
      url = new URL(environment[key] ?? "");
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username !== role
      )
        throw new Error();
    } catch {
      throw new AccessError(
        503,
        "staff_database_unconfigured",
        "Explicit separate loopback staff database identities are required.",
      );
    }
    return url.href;
  };
  const controlUrl = resolve("CONTROL_DATABASE_URL", "estate_control"),
    issuerUrl = resolve("STAFF_ISSUER_DATABASE_URL", "estate_staff_issuer");
  const make = (connectionString: string) =>
    new Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  return { control: make(controlUrl), issuer: make(issuerUrl) };
}
