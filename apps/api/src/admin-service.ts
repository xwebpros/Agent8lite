import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { assertDelegation } from "../../../packages/auth/permissions";
import { hashToken, type ServerSession } from "../../../packages/auth/sessions";
import { runtimePool } from "../../../packages/db/pool";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { organization, role } from "./models";
import { assertUuid, CrmService } from "./crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";

type Schemas = components["schemas"];
type Row = Record<string, any>;
type Mutation = { body: unknown; status: number; etag?: string };
const memberModel = (row: Row): Schemas["Member"] => ({
  id: row.id,
  displayName: row.display_name,
  roleId: row.role_id,
  status: row.status,
  version: Number(row.row_version),
});

const signingKey =
  process.env.INVITATION_SIGNING_KEY ??
  (["development", "test"].includes(process.env.APP_ENV ?? "") ? "local-synthetic-invitations-only" : "");
export function syntheticInvitationToken(id: string) {
  if (!signingKey)
    throw new AccessError(503, "invitation_key_unconfigured", "Invitation signing key is unavailable.");
  return `${id}.${createHmac("sha256", signingKey).update(id).digest("base64url")}`;
}
function version(row: Row, expected: string | undefined) {
  if (!expected) throw new AccessError(400, "revision_required", "If-Match revision required.");
  if (expected.replaceAll('"', "") !== String(row.row_version))
    throw new AccessError(412, "revision_changed", "Resource changed. Reload before retrying.");
}
function validText(value: string) {
  if (!value.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  return value.trim();
}
function validTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new AccessError(422, "timezone_invalid", "Valid IANA timezone required.");
  }
  return value;
}
const officeModel = (row: Row): Schemas["Office"] => ({
  id: row.id,
  name: row.name,
  timezone: row.timezone,
  version: Number(row.row_version),
});
const profileModel = (row: Row): Schemas["BusinessProfile"] => ({
  id: row.id,
  name: row.name,
  websiteUrl: row.profile.websiteUrl ?? null,
  brand: row.brand_tokens?.primaryColor ? row.brand_tokens : { primaryColor: "#4766e7", fontToken: "sans" },
  version: Number(row.row_version),
});
export const jobModel = (row: Row): Schemas["Job"] => ({
  id: row.id,
  state: row.state,
  kind: row.kind,
  createdAt: new Date(row.created_at).toISOString(),
  resultUrl:
    row.kind === "data.export" && row.state === "succeeded" ? (row.safe_result?.resultUrl ?? null) : null,
  error: row.safe_error
    ? {
        type: `https://estate.example/problems/${["synthetic_billing_failed", "synthetic_provider_state_unavailable"].includes(row.safe_error) ? row.safe_error : "operation_attention_required"}`,
        title: "This operation requires attention. Review its current status before retrying.",
        status: 503,
        code: ["synthetic_billing_failed", "synthetic_provider_state_unavailable"].includes(row.safe_error)
          ? row.safe_error
          : "operation_attention_required",
        traceId: row.id,
      }
    : null,
});

export class AdminService {
  readonly foundation: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }
  async getOrganization() {
    requirePermission(this.context, "org.read");
    const rows = await this.client.query("SELECT * FROM app.organization WHERE id=$1", [
      this.context.organizationId,
    ]);
    return organization(rows.rows[0]);
  }
  async updateOrganization(
    body: Schemas["OrganizationCreate"],
    expected: string | undefined,
  ): Promise<Mutation> {
    requirePermission(this.context, "org.manage");
    const current = await this.client.query("SELECT * FROM app.organization WHERE id=$1 FOR UPDATE", [
      this.context.organizationId,
    ]);
    version(current.rows[0], expected);
    const row = current.rows[0];
    const updated = await this.client.query(
      `UPDATE app.organization SET name=$1,timezone=$2,locale=$3,row_version=row_version+1,updated_at=now() WHERE id=$4 RETURNING *`,
      [
        body.name ? validText(body.name) : row.name,
        body.timezone ? validTimezone(body.timezone) : row.timezone,
        body.locale ?? row.locale,
        this.context.organizationId,
      ],
    );
    await this.foundation.audit(
      "organization.updated",
      "organization",
      row.id,
      Number(updated.rows[0].row_version),
    );
    return { body: organization(updated.rows[0]), status: 200, etag: `"${updated.rows[0].row_version}"` };
  }
  async list(resource: "offices" | "business-profiles" | "roles", query: Record<string, unknown>) {
    requirePermission(
      this.context,
      resource === "offices" ? "offices.read" : resource === "roles" ? "roles.read" : "profiles.read",
    );
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    const binding = cursorBinding(this.context, resource, "organization", {});
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const table = resource === "offices" ? "office" : resource === "roles" ? "role_definition" : "business_profile";
    const result = await this.client.query(
      `SELECT * FROM app.${table} WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`,
      [cursor, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const mapper = resource === "roles" ? role : resource === "offices" ? officeModel : profileModel;
    return {
      items: rows.map((row) => mapper(row)),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
  async get(resource: "offices" | "business-profiles" | "roles", id: string) {
    requirePermission(
      this.context,
      resource === "offices" ? "offices.read" : resource === "roles" ? "roles.read" : "profiles.read",
    );
    assertUuid(id);
    const table = resource === "offices" ? "office" : resource === "roles" ? "role_definition" : "business_profile";
    const rows = await this.client.query(`SELECT * FROM app.${table} WHERE id=$1`, [id]);
    if (!rows.rowCount) throw new AccessError(404, "resource_unavailable", "Resource unavailable.");
    const mapper = resource === "roles" ? role : resource === "offices" ? officeModel : profileModel;
    return mapper(rows.rows[0]);
  }
  async write(
    resource: "offices" | "business-profiles" | "roles",
    body: Row,
    id?: string,
    expected?: string,
  ): Promise<Mutation> {
    requirePermission(
      this.context,
      resource === "offices" ? "offices.write" : resource === "roles" ? "roles.write" : "profiles.write",
    );
    const table =
      resource === "offices" ? "office" : resource === "roles" ? "role_definition" : "business_profile";
    let current: Row | undefined;
    if (id) {
      assertUuid(id);
      const result = await this.client.query(`SELECT * FROM app.${table} WHERE id=$1 FOR UPDATE`, [id]);
      current = result.rows[0];
      if (!current) throw new AccessError(404, "resource_unavailable", "Resource unavailable.");
      version(current, expected);
    }
    const name = validText(body.name);
    let result;
    if (resource === "roles") {
      if (current?.builtin)
        throw new AccessError(409, "builtin_role_immutable", "Built-in roles cannot be modified.");
      if (
        [
          "Owner",
          "Organization manager",
          "Agent",
          "Marketing editor",
          "Billing administrator",
          "Read-only analyst",
        ].some((preset) => preset.toLowerCase() === name.toLowerCase())
      )
        throw new AccessError(422, "reserved_role_name", "Built-in role names are reserved.");
      assertDelegation(this.context, body.permissions);
      if (id)
        result = await this.client.query(
          "UPDATE app.role_definition SET name=$1,permission_grants=$2,row_version=row_version+1,updated_at=now() WHERE id=$3 RETURNING *",
          [name, JSON.stringify(body.permissions), id],
        );
      else
        result = await this.client.query(
          "INSERT INTO app.role_definition(tenant_id,name,permission_grants)VALUES($1,$2,$3)RETURNING *",
          [this.context.organizationId, name, JSON.stringify(body.permissions)],
        );
    } else if (resource === "offices") {
      const zone = validTimezone(body.timezone);
      if (id)
        result = await this.client.query(
          "UPDATE app.office SET name=$1,timezone=$2,row_version=row_version+1,updated_at=now() WHERE id=$3 RETURNING *",
          [name, zone, id],
        );
      else
        result = await this.client.query(
          "INSERT INTO app.office(tenant_id,name,timezone)VALUES($1,$2,$3)RETURNING *",
          [this.context.organizationId, name, zone],
        );
    } else {
      if (body.websiteUrl) {
        const url = new URL(body.websiteUrl);
        if (!["http:", "https:"].includes(url.protocol))
          throw new AccessError(422, "url_invalid", "Website links require HTTPS or HTTP.");
      }
      if (body.brand.logoAssetId)
        throw new AccessError(
          422,
          "logo_upload_unavailable",
          "Logo assets require the scoped media module which is not available yet.",
        );
      if (id)
        result = await this.client.query(
          "UPDATE app.business_profile SET name=$1,profile=$2,brand_tokens=$3,row_version=row_version+1,updated_at=now() WHERE id=$4 RETURNING *",
          [name, JSON.stringify({ websiteUrl: body.websiteUrl ?? null }), JSON.stringify(body.brand), id],
        );
      else
        result = await this.client.query(
          "INSERT INTO app.business_profile(tenant_id,name,profile,brand_tokens)VALUES($1,$2,$3,$4)RETURNING *",
          [
            this.context.organizationId,
            name,
            JSON.stringify({ websiteUrl: body.websiteUrl ?? null }),
            JSON.stringify(body.brand),
          ],
        );
    }
    const row = result.rows[0];
    await this.foundation.audit(
      `${table}.${id ? "updated" : "created"}`,
      table,
      row.id,
      Number(row.row_version),
    );
    return {
      body: (resource === "roles" ? role : resource === "offices" ? officeModel : profileModel)(row),
      status: id ? 200 : 201,
      etag: `"${row.row_version}"`,
    };
  }
  async invite(body: Schemas["InviteMember"]): Promise<Mutation> {
    requirePermission(this.context, "members.manage");
    const result = await this.client.query("SELECT * FROM app.role_definition WHERE id=$1", [body.roleId]);
    if (!result.rowCount)
      throw new AccessError(422, "role_invalid", "Role must belong to this organization.");
    if (result.rows[0].name === "Owner" && this.context.roleName !== "Owner")
      throw new AccessError(403, "owner_change_denied", "Only an owner may invite another owner.");
    assertDelegation(this.context, result.rows[0].permission_grants);
    for (const id of body.officeIds ?? []) {
      assertUuid(id);
      const office = await this.client.query("SELECT id FROM app.office WHERE id=$1", [id]);
      if (!office.rowCount)
        throw new AccessError(422, "office_invalid", "Office must belong to this organization.");
    }
    const email = body.email.trim().toLowerCase();
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:invite:${email}`,
    ]);
    const existing = await this.client.query(
      `SELECT id FROM app.member_invitation WHERE lower(email)=$1 AND accepted_at IS NULL AND expires_at>now()`,
      [email],
    );
    if (existing.rowCount)
      throw new AccessError(
        409,
        "invitation_pending",
        "An unexpired invitation already exists for this email.",
      );
    const invitationId = randomUUID();
    const token = syntheticInvitationToken(invitationId);
    await this.client.query(
      `INSERT INTO app.member_invitation(tenant_id,id,email,token_hash,role_id,invited_by_member_id,expires_at,office_ids)VALUES($1,$2,$3,$4,$5,$6,now()+interval '48 hours',$7)`,
      [
        this.context.organizationId,
        invitationId,
        email,
        hashToken(token),
        body.roleId,
        this.context.memberId,
        body.officeIds ?? [],
      ],
    );
    const job = await this.client.query(
      `INSERT INTO app.integration_job(tenant_id,kind,state,result_ref,requesting_member_id,safe_result)VALUES($1,'member.invitation.created.no-delivery','succeeded',$2,$3,'{"delivery":"disabled"}')RETURNING *`,
      [this.context.organizationId, invitationId, this.context.memberId],
    );
    await this.foundation.audit("member.invited", "member_invitation", invitationId, 1);
    return { body: jobModel(job.rows[0]), status: 202 };
  }
  async listMembers(query: Record<string, unknown>): Promise<Schemas["PageMember"]> {
    requirePermission(this.context, "members.read");
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    const binding = cursorBinding(this.context, "members", "organization", {});
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const result = await this.client.query(
      `SELECT * FROM app.membership WHERE tenant_id=app.current_tenant() AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2`,
      [cursor, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(memberModel),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
  async updateMember(
    memberId: string,
    body: Schemas["MemberPatch"],
    expected: string | undefined,
  ): Promise<Mutation> {
    requirePermission(this.context, "members.manage");
    assertUuid(memberId);
    const current = await this.client.query("SELECT * FROM app.membership WHERE id=$1 FOR UPDATE", [memberId]);
    if (!current.rowCount) throw new AccessError(404, "resource_unavailable", "Member not found.");
    const row = current.rows[0];
    version(row, expected);
    if (memberId === this.context.memberId && body.status === "disabled")
      throw new AccessError(422, "self_disable_denied", "Cannot disable your own membership.");
    if (body.roleId) {
      assertUuid(body.roleId);
      const role = await this.client.query("SELECT * FROM app.role_definition WHERE id=$1", [body.roleId]);
      if (!role.rowCount)
        throw new AccessError(422, "role_invalid", "Role must belong to this organization.");
      if (role.rows[0].name === "Owner" && this.context.roleName !== "Owner")
        throw new AccessError(403, "owner_change_denied", "Only an owner may assign the Owner role.");
      assertDelegation(this.context, role.rows[0].permission_grants);
    }
    const newRoleId = body.roleId ?? row.role_id;
    const newStatus = body.status ?? row.status;
    if (newStatus === "disabled" && row.status === "active") {
      const currentRole = await this.client.query("SELECT name FROM app.role_definition WHERE id=$1", [row.role_id]);
      if (currentRole.rows[0]?.name === "Owner") {
        const otherOwners = await this.client.query(
          `SELECT count(*)::int AS n FROM app.membership m JOIN app.role_definition r ON r.id=m.role_id AND r.tenant_id=m.tenant_id WHERE m.id!=$1 AND m.status='active' AND r.name='Owner'`,
          [memberId],
        );
        if ((otherOwners.rows[0]?.n ?? 0) < 1)
          throw new AccessError(422, "final_owner_protected", "The last active owner cannot be disabled.");
      }
    }
    const updated = await this.client.query(
      `UPDATE app.membership SET role_id=$1,status=$2,row_version=row_version+1,updated_at=now() WHERE id=$3 RETURNING *`,
      [newRoleId, newStatus, memberId],
    );
    if (body.officeIds !== undefined) {
      await this.client.query("DELETE FROM app.office_member WHERE member_id=$1", [memberId]);
      for (const officeId of body.officeIds) {
        assertUuid(officeId);
        const office = await this.client.query("SELECT id FROM app.office WHERE id=$1", [officeId]);
        if (!office.rowCount)
          throw new AccessError(422, "office_invalid", "Office must belong to this organization.");
        await this.client.query(
          "INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)",
          [this.context.organizationId, officeId, memberId],
        );
      }
    }
    await this.foundation.audit("membership.updated", "membership", memberId, Number(updated.rows[0].row_version));
    return { body: memberModel(updated.rows[0]), status: 200, etag: `"${updated.rows[0].row_version}"` };
  }
  async job(id: string) {
    requirePermission(this.context, "jobs.read");
    assertUuid(id);
    const result = await this.client.query(
      `SELECT * FROM app.integration_job WHERE id=$1 AND requesting_member_id=$2`,
      [id, this.context.memberId],
    );
    if (!result.rowCount)
      throw new AccessError(404, "resource_unavailable", "Job unavailable or outside your request scope.");
    return jobModel(result.rows[0]);
  }
  async listJobs(query: { cursor?: string; limit?: number; state?: string; kind?: string } = {}) {
    requirePermission(this.context, "jobs.read");
    const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
    const binding = cursorBinding(this.context, "admin:jobs", "own", { limit });
    const after = decodeCursor(query.cursor, binding);
    if (after) assertUuid(after);
    const conditions = ["tenant_id=app.current_tenant()", "requesting_member_id=$1"];
    const params: unknown[] = [this.context.memberId];
    if (query.state && /^[a-z]{2,30}$/.test(query.state)) {
      params.push(query.state);
      conditions.push(`state=$${params.length}`);
    }
    if (query.kind && /^[a-z][a-z0-9_.]{1,80}$/.test(query.kind)) {
      params.push(query.kind);
      conditions.push(`kind=$${params.length}`);
    }
    params.push(after);
    conditions.push(`($${params.length}::uuid IS NULL OR id<$${params.length})`);
    params.push(limit + 1);
    const result = await this.client.query(
      `SELECT * FROM app.integration_job WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    const items = result.rows.slice(0, limit).map(jobModel);
    const hasMore = result.rows.length > limit;
    return {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
  }
  async invitationTokenForJob(id: string) {
    const result = await this.client.query(
      `SELECT result_ref FROM app.integration_job WHERE id=$1 AND requesting_member_id=$2 AND kind='member.invitation.created.no-delivery'`,
      [id, this.context.memberId],
    );
    return result.rowCount ? syntheticInvitationToken(result.rows[0].result_ref) : null;
  }
}

export async function acceptInvitation(
  session: ServerSession,
  token: string,
  traceId: string,
  key: string | undefined,
): Promise<Mutation> {
  if (!key || key.length > 100)
    throw new AccessError(400, "idempotency_required", "Idempotency-Key required.");
  const client = await runtimePool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.actor_id',$1,true),set_config('app.invitation_hash',$2,true)",
      [session.userId, hashToken(token)],
    );
    const invitation = await client.query("SELECT * FROM app.member_invitation WHERE token_hash=$1", [
      hashToken(token),
    ]);
    if (!invitation.rowCount)
      throw new AccessError(422, "invitation_invalid", "Invitation is invalid, expired or already used.");
    const tenant = invitation.rows[0].tenant_id;
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const locked = await client.query("SELECT * FROM app.member_invitation WHERE token_hash=$1 FOR UPDATE", [
      hashToken(token),
    ]);
    const row = locked.rows[0];
    const identities = await client.query("SELECT email,email_verified FROM app.user_identity WHERE id=$1", [
      session.userId,
    ]);
    const identity = identities.rows[0];
    if (!identity?.email_verified || identity.email?.toLowerCase() !== row.email.toLowerCase())
      throw new AccessError(
        403,
        "invitation_email_mismatch",
        "Sign in with the verified email addressed by this invitation.",
      );
    const requestHash = createHash("sha256").update(token).digest("hex");
    const previous = await client.query(
      `SELECT request_hash,response_body,status_code FROM app.idempotency_record WHERE actor_ref=$1 AND route_key='POST /v1/member-invitations/accept' AND key=$2 AND expires_at>now()`,
      [session.userId, key],
    );
    if (previous.rowCount) {
      if (previous.rows[0].request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "This key was used for another invitation.");
      const membership = await client.query(
        `SELECT m.id FROM app.membership m JOIN app.organization o ON o.id=m.tenant_id WHERE m.user_id=$1 AND m.tenant_id=$2 AND m.status='active' AND o.status='active'`,
        [session.userId, tenant],
      );
      if (!membership.rowCount)
        throw new AccessError(
          403,
          "membership_required",
          "Invitation acceptance replay requires current organization access.",
        );
      await client.query("COMMIT");
      return { body: previous.rows[0].response_body, status: previous.rows[0].status_code };
    }
    if (row.accepted_at || new Date(row.expires_at).getTime() < Date.now())
      throw new AccessError(422, "invitation_invalid", "Invitation is invalid, expired or already used.");
    const org = await client.query("SELECT status FROM app.organization WHERE id=$1 FOR UPDATE", [tenant]);
    if (org.rows[0]?.status !== "active")
      throw new AccessError(403, "organization_unavailable", "Organization is unavailable.");
    const existing = await client.query("SELECT id FROM app.membership WHERE user_id=$1 AND tenant_id=$2", [
      session.userId,
      tenant,
    ]);
    if (existing.rowCount)
      throw new AccessError(409, "membership_exists", "This identity already belongs to the organization.");
    const member = await client.query(
      `INSERT INTO app.membership(tenant_id,user_id,role_id,status,display_name)SELECT $1,id,$2,'active',display_name FROM app.user_identity WHERE id=$3 RETURNING id`,
      [tenant, row.role_id, session.userId],
    );
    const memberId = member.rows[0].id;
    for (const office of row.office_ids)
      await client.query("INSERT INTO app.office_member(tenant_id,office_id,member_id)VALUES($1,$2,$3)", [
        tenant,
        office,
        memberId,
      ]);
    await client.query(
      "UPDATE app.member_invitation SET accepted_at=now(),updated_at=now(),row_version=row_version+1 WHERE id=$1",
      [row.id],
    );
    await client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id)VALUES($1,$2,'member.invitation_accepted','membership',$3,$4)`,
      [tenant, session.userId, memberId, traceId],
    );
    const job = await client.query(
      `INSERT INTO app.integration_job(tenant_id,kind,state,requesting_member_id)VALUES($1,'member.invitation.accepted','succeeded',$2)RETURNING *`,
      [tenant, memberId],
    );
    await client.query(
      `INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,expires_at)VALUES($1,$2,'POST /v1/member-invitations/accept',$3,$4,$5,202,now()+interval '1 day')`,
      [tenant, session.userId, key, requestHash, JSON.stringify(jobModel(job.rows[0]))],
    );
    await client.query("COMMIT");
    return { body: jobModel(job.rows[0]), status: 202 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
