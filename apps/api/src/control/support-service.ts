import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  assertStaffPermission,
  staffSessionResponse,
  type StaffSession,
} from "../../../../packages/auth/staff-sessions";
import type {
  SupportAccessPort,
  SupportGrantReference,
  SupportReadContext,
  SyntheticStaffSessionResponse,
  SyntheticSupportSelection,
} from "../../../../packages/contracts/internal/control-plane-port";
import { requireSyntheticStaffMode } from "../../../../packages/db/staff-pools";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { assertUuid, requireVersion } from "../crm-service";
import { validateSchema } from "../contract-validation";
import type { Schemas } from "../models";
import { canonical } from "./bootstrap-ports";
import { jobEntity } from "./provisioning-service";
import { validateStaff } from "./validation";

type Row = Record<string, any>;
export const supportReadPermissions = [
  "crm.contacts.read",
  "crm.leads.read",
  "crm.tasks.read",
  "crm.deals.read",
  "crm.pipeline.read",
  "crm.sources.read",
  "crm.tags.read",
] as const;
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const unavailable = (): never => {
  throw new AccessError(403, "support_context_unavailable", "Current support access is unavailable.");
};
export interface StaffSessionView {
  readonly body: SyntheticStaffSessionResponse;
  readonly state: "none" | "active" | "stale";
  readonly grant?: SupportGrantReference;
}

/** Staff authority remains separate from member permissions; every command uses this invoking transaction. */
export class SupportService implements SupportAccessPort {
  constructor(
    private readonly client: PoolClient,
    private readonly staff: StaffSession,
    private readonly traceId: string,
  ) {}
  private async authorize(manager = false) {
    await assertStaffPermission(this.client, this.staff, manager ? "platform.support.grant" : "");
  }
  private async bind(organizationId: string, grantId: string) {
    await this.client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.support_grant_id',$2,true)",
      [organizationId, grantId],
    );
  }
  private async selection() {
    return (
      await this.client.query(
        "SELECT selected_tenant_id,selected_grant_id FROM app.staff_session WHERE token_hash=$1 AND staff_user_id=$2 AND expires_at>clock_timestamp()",
        [this.staff.sessionHash, this.staff.userId],
      )
    ).rows[0];
  }
  private async lookup(route: string, key: string, body: unknown) {
    await this.authorize();
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(key))
      throw new AccessError(422, "idempotency_key_invalid", "A bounded idempotency key is required.");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.staff.userId}:${route}:${key}`,
    ]);
    const row = (
      await this.client.query(
        "SELECT request_hash,response_body FROM app.control_idempotency WHERE staff_user_id=$1 AND route_key=$2 AND key=$3",
        [this.staff.userId, route, key],
      )
    ).rows[0];
    if (row && row.request_hash !== digest(body))
      throw new AccessError(
        409,
        "idempotency_conflict",
        "This command key was used with a different request.",
      );
    return row?.response_body ?? null;
  }
  private async record(route: string, key: string, body: unknown, response: unknown, status: number) {
    await this.authorize();
    await this.client.query(
      "INSERT INTO app.control_idempotency(staff_user_id,route_key,key,request_hash,response_body,status_code)VALUES($1,$2,$3,$4,$5,$6)",
      [this.staff.userId, route, key, digest(body), response, status],
    );
  }
  private contextRoute(action: "select" | "clear") {
    return `staff.support.${action}:${digest({ opaqueSession: this.staff.sessionHash })}`;
  }
  private requireContextMutation() {
    if (this.staff.intent !== "context-mutation")
      throw new AccessError(
        503,
        "staff_context_transaction_required",
        "Own session context transaction required.",
      );
  }
  private async audit(organizationId: string, grantId: string, action: string, version: string) {
    await this.client.query("SELECT set_config('app.tenant_id',$1,true)", [organizationId]);
    await this.client.query(
      "INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)VALUES($1,$2,$3,'support_access_grant',$4,$5,$6)",
      [
        organizationId,
        this.staff.userId,
        action,
        grantId,
        this.traceId,
        { resourceVersion: Number(version) },
      ],
    );
  }
  private reference(row: Row): SupportGrantReference {
    if (!Number.isSafeInteger(Number(row.row_version)) || Number(row.row_version) < 1) unavailable();
    return { accessGrantId: row.id, grantVersion: String(row.row_version) };
  }
  async createGrant(organizationId: string, body: Schemas["AccessGrant"], key: string) {
    assertUuid(organizationId);
    validateSchema("AccessGrant", body);
    await this.authorize(true);
    if (
      !body.reason.trim() ||
      body.reason.length > 1000 ||
      body.permissions.length < 1 ||
      body.permissions.length > 7 ||
      new Set(body.permissions).size !== body.permissions.length ||
      body.permissions.some((code) => !(supportReadPermissions as readonly string[]).includes(code))
    )
      throw new AccessError(
        422,
        "support_grant_invalid",
        "A reason and one to seven distinct CRM read permissions are required.",
      );
    const route = `POST /v1/platform/organizations/${organizationId}/access-grants`,
      replay = await this.lookup(route, key, body);
    if (replay) return (await this.readCommand(replay.id)).job;
    // Creation deliberately uses a current metadata snapshot; it gains no unselected organization UPDATE lock.
    const organization = (
      await this.client.query("SELECT id FROM app.organization WHERE id=$1 AND status='active'", [
        organizationId,
      ])
    ).rows[0];
    if (!organization)
      throw new AccessError(404, "organization_unavailable", "Active organization unavailable.");
    if (
      !(await this.client.query("SELECT app.control_staff_recipient_active($1)AS active", [body.staffUserId]))
        .rows[0].active
    )
      throw new AccessError(
        422,
        "support_recipient_unavailable",
        "Active synthetic staff recipient required.",
      );
    const stamp = (await this.client.query("SELECT clock_timestamp()AS stamp")).rows[0].stamp,
      expiry = Date.parse(body.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= stamp.getTime() || expiry > stamp.getTime() + 3600000)
      throw new AccessError(
        422,
        "support_expiry_invalid",
        "Grant expiry must be in the next database-clock hour.",
      );
    const id = randomUUID(),
      jobId = randomUUID();
    await this.client.query(
      "INSERT INTO app.support_access_grant(tenant_id,id,staff_user_id,permission_codes,reason,created_at,expires_at,issuing_staff_user_id,provenance)VALUES($1,$2,$3,$4,$5,$6,$7,$8,'synthetic-local')",
      [
        organizationId,
        id,
        body.staffUserId,
        body.permissions,
        body.reason.trim(),
        stamp,
        body.expiresAt,
        this.staff.userId,
      ],
    );
    const row = (
      await this.client.query(
        "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,result_ref)VALUES($1,$2,$3,'staff.support.grant','succeeded',$4)RETURNING *",
        [jobId, organizationId, this.staff.userId, id],
      )
    ).rows[0];
    await this.audit(organizationId, id, "staff.support.granted", "1");
    const job = jobEntity(row);
    await this.record(route, key, body, job, 202);
    await this.authorize(true);
    return job;
  }
  async readCommand(jobId: string) {
    assertUuid(jobId);
    await this.authorize(true);
    const row = (
      await this.client.query(
        "SELECT * FROM app.control_job WHERE id=$1 AND requesting_staff_user_id=$2 AND kind IN('staff.support.grant','staff.support.revoke')",
        [jobId, this.staff.userId],
      )
    ).rows[0];
    if (!row) throw new AccessError(404, "job_unavailable", "Job unavailable.");
    const grant = (
      await this.client.query(
        "SELECT id,row_version FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2",
        [row.organization_id, row.result_ref],
      )
    ).rows[0];
    if (!grant) throw new AccessError(404, "support_grant_unavailable", "Support grant unavailable.");
    await this.authorize(true);
    return { job: jobEntity(row), grant: this.reference(grant) };
  }
  async resolveCurrent(permission: string): Promise<SupportReadContext> {
    requireSyntheticStaffMode();
    await this.authorize();
    if (permission && !(supportReadPermissions as readonly string[]).includes(permission)) unavailable();
    const selected = await this.selection();
    if (!selected?.selected_tenant_id || !selected.selected_grant_id) unavailable();
    await this.bind(selected.selected_tenant_id, selected.selected_grant_id);
    const grant = (
      await this.client.query(
        "SELECT *,expires_at>clock_timestamp()AS live FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2 AND staff_user_id=$3 FOR SHARE",
        [selected.selected_tenant_id, selected.selected_grant_id, this.staff.userId],
      )
    ).rows[0];
    if (
      !grant ||
      !grant.live ||
      grant.revoked_at ||
      !["synthetic-local", "oidc-verified"].includes(grant.provenance) ||
      !grant.issuing_staff_user_id ||
      !grant.reason.trim() ||
      grant.reason.length > 1000 ||
      !Array.isArray(grant.permission_codes) ||
      !grant.permission_codes.length ||
      grant.permission_codes.length > 7 ||
      new Set(grant.permission_codes).size !== grant.permission_codes.length ||
      grant.permission_codes.some(
        (code: string) => !(supportReadPermissions as readonly string[]).includes(code),
      ) ||
      (permission && !grant.permission_codes.includes(permission))
    )
      unavailable();
    if (
      (
        await this.client.query("SELECT id FROM app.organization WHERE id=$1 AND status='active'FOR SHARE", [
          grant.tenant_id,
        ])
      ).rowCount !== 1
    )
      unavailable();
    if (
      (
        await this.client.query(
          "SELECT id FROM app.entitlement WHERE tenant_id=$1 AND feature='crm'AND state='enabled'AND(effective_until IS NULL OR effective_until>clock_timestamp())FOR SHARE",
          [grant.tenant_id],
        )
      ).rowCount !== 1
    )
      unavailable();
    // Lock waits can outlive source validity; never use transaction-start timestamps for eligibility.
    if (
      !(
        await this.client.query(
          "SELECT app.control_grant_allows($1)AND EXISTS(SELECT 1 FROM app.organization WHERE id=$2 AND status='active')AND EXISTS(SELECT 1 FROM app.entitlement WHERE tenant_id=$2 AND feature='crm'AND state='enabled'AND(effective_until IS NULL OR effective_until>clock_timestamp()))AS allowed",
          [permission, grant.tenant_id],
        )
      ).rows[0].allowed
    )
      unavailable();
    await this.authorize();
    return {
      organizationId: grant.tenant_id,
      staffUserId: this.staff.userId,
      staffPrincipalId: this.staff.staffPrincipalId,
      principalVersion: this.staff.principalVersion,
      accessGrantId: grant.id,
      grantVersion: String(grant.row_version),
      expiresAt: new Date(grant.expires_at).toISOString(),
      permissionCodes: grant.permission_codes,
      provenance: this.staff.provenance,
    };
  }
  async assertCurrent(context: SupportReadContext, permission: string) {
    const current = await this.resolveCurrent(permission);
    if (
      context.organizationId !== current.organizationId ||
      context.staffUserId !== current.staffUserId ||
      context.staffPrincipalId !== current.staffPrincipalId ||
      context.principalVersion !== current.principalVersion ||
      context.accessGrantId !== current.accessGrantId ||
      context.grantVersion !== current.grantVersion
    )
      unavailable();
    return current;
  }
  async sessionView(): Promise<StaffSessionView> {
    const selected = await this.selection(),
      identity = staffSessionResponse(this.staff);
    if (!selected?.selected_tenant_id && !selected?.selected_grant_id)
      return { body: identity, state: "none" };
    try {
      const context = await this.resolveCurrent("");
      const grant = (
        await this.client.query("SELECT reason FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2", [
          context.organizationId,
          context.accessGrantId,
        ])
      ).rows[0];
      const body: SyntheticStaffSessionResponse = {
        ...identity,
        supportContext: {
          organizationId: context.organizationId,
          accessGrantId: context.accessGrantId,
          permissions: context.permissionCodes,
          reason: grant.reason,
          expiresAt: context.expiresAt,
        },
      };
      validateStaff("SessionResponse", body, true);
      await this.assertCurrent(context, "");
      return {
        body,
        state: "active",
        grant: { accessGrantId: context.accessGrantId, grantVersion: context.grantVersion },
      };
    } catch (error) {
      if (error instanceof AccessError && error.code === "support_context_unavailable")
        return { body: identity, state: "stale" };
      throw error;
    }
  }
  async select(selection: SyntheticSupportSelection, key: string) {
    this.requireContextMutation();
    validateStaff("SupportSelection", selection);
    await this.authorize();
    const route = this.contextRoute("select"),
      replay = await this.lookup(route, key, selection);
    if (replay) return (await this.sessionView()).body;
    // The caller must already hold this own session UPDATE lock; no SHARE-to-UPDATE upgrade.
    const candidate = (
      await this.client.query(
        "SELECT id FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2 AND staff_user_id=$3",
        [selection.organizationId, selection.accessGrantId, this.staff.userId],
      )
    ).rows[0];
    if (!candidate) unavailable();
    await this.client.query(
      "UPDATE app.staff_session SET selected_tenant_id=$3,selected_grant_id=$4 WHERE token_hash=$1 AND staff_user_id=$2",
      [this.staff.sessionHash, this.staff.userId, selection.organizationId, selection.accessGrantId],
    );
    const context = await this.resolveCurrent("");
    await this.audit(
      context.organizationId,
      context.accessGrantId,
      "staff.support.selected",
      context.grantVersion,
    );
    await this.record(route, key, selection, { recorded: true }, 200);
    return (await this.sessionView()).body;
  }
  async clear(key: string) {
    this.requireContextMutation();
    await this.authorize();
    const route = this.contextRoute("clear"),
      replay = await this.lookup(route, key, {});
    if (replay) return (await this.sessionView()).body;
    // This append-only evidence INSERT is the reviewed bounded clear command: its trigger clears exactly this own session atomically.
    await this.client.query(
      "INSERT INTO app.control_command_audit(staff_user_id,staff_principal_id,principal_version,session_binding,action,command_digest,trace_id,previous_context_fingerprint)SELECT $1,$2,$3,app.control_command_session_binding(),'staff.support.selection.clear',$4,$5,app.control_command_context_fingerprint(selected_tenant_id,selected_grant_id)FROM app.staff_session WHERE token_hash=$6 AND staff_user_id=$1",
      [
        this.staff.userId,
        this.staff.staffPrincipalId,
        this.staff.principalVersion,
        digest({ route, key }),
        this.traceId,
        this.staff.sessionHash,
      ],
    );
    await this.client.query(
      "SELECT set_config('app.tenant_id','',true),set_config('app.support_grant_id','',true)",
    );
    await this.record(route, key, {}, { recorded: true }, 200);
    return (await this.sessionView()).body;
  }
  async revoke(organizationId: string, grantId: string, key: string, expectedVersion: string) {
    assertUuid(organizationId);
    assertUuid(grantId);
    await this.authorize(true);
    const route = `POST /dev/staff/support/organizations/${organizationId}/access-grants/${grantId}/revoke`,
      input = { expectedVersion },
      replay = await this.lookup(route, key, input);
    if (replay) return (await this.readCommand(replay.id)).job;
    if (!expectedVersion)
      throw new AccessError(400, "revision_required", "Grant If-Match revision required.");
    if (!/^"[1-9]\d*"$/.test(expectedVersion) || !Number.isSafeInteger(Number(expectedVersion.slice(1, -1))))
      throw new AccessError(400, "revision_invalid", "A strong grant If-Match revision is required.");
    let grant = (
      await this.client.query("SELECT * FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2", [
        organizationId,
        grantId,
      ])
    ).rows[0];
    if (!grant) throw new AccessError(404, "support_grant_unavailable", "Support grant unavailable.");
    requireVersion(grant, expectedVersion);
    if (grant.revoked_at)
      throw new AccessError(409, "support_grant_revoked", "Support grant is already revoked.");
    grant = (
      await this.client.query(
        "SELECT * FROM app.support_access_grant WHERE tenant_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE",
        [organizationId, grantId],
      )
    ).rows[0];
    if (!grant) throw new AccessError(412, "revision_changed", "Support grant changed.");
    requireVersion(grant, expectedVersion);
    const result = await this.client.query(
      "UPDATE app.support_access_grant SET revoked_at=clock_timestamp(),row_version=row_version+1,updated_at=clock_timestamp()WHERE tenant_id=$1 AND id=$2 AND row_version=$3 AND revoked_at IS NULL RETURNING *",
      [organizationId, grantId, grant.row_version],
    );
    if (result.rowCount !== 1) throw new AccessError(412, "revision_changed", "Support grant changed.");
    const row = (
      await this.client.query(
        "INSERT INTO app.control_job(organization_id,requesting_staff_user_id,kind,state,result_ref)VALUES($1,$2,'staff.support.revoke','succeeded',$3)RETURNING *",
        [organizationId, this.staff.userId, grantId],
      )
    ).rows[0];
    await this.audit(organizationId, grantId, "staff.support.revoked", String(result.rows[0].row_version));
    const job = jobEntity(row);
    await this.record(route, key, input, job, 202);
    await this.authorize(true);
    return job;
  }
}
