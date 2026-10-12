import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import {
  AccessError,
  requirePermission,
  type TenantContext,
} from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";
import { assertUuid, stable } from "../crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../cursors";

type Schemas = components["schemas"];
type AutomationRow = {
  id: string;
  name: string;
  trigger_type: string;
  condition: Schemas["LeadFilter"];
  campaign_version_id: string;
  restart_policy: string;
  inactivity_seconds: number | null;
  active: boolean;
  version: number;
  row_version: number;
};
type EnrollmentRow = {
  id: string;
  lead_id: string;
  campaign_version_id: string;
  state: string;
  current_step: string | null;
  version: number;
  row_version: number;
};
type ReceiptRow = {
  request_hash: string;
  response_body: unknown;
  status_code: number;
  response_etag: string;
};

export type AutomationMutation = { body: Schemas["Automation"]; status: 200 | 201; etag: string };
export type EnrollmentMutation = { body: Schemas["Enrollment"]; status: 201; etag: string };
export type CancelMutation = { body: Schemas["Enrollment"]; status: 200; etag: string };
export type AutomationPage = Schemas["PageAutomation"];
export type EnrollmentPage = Schemas["PageEnrollment"];

type Permission = "automations.read" | "automations.write";

function automationEtag(version: number): string {
  return '"' + version + '"';
}
function enrollmentEtag(version: number): string {
  return '"' + version + '"';
}

function automationModel(row: AutomationRow): Schemas["Automation"] {
  const body: Schemas["Automation"] = {
    id: row.id,
    version: Number(row.version),
    definition: {
      name: row.name,
      trigger: row.trigger_type as Schemas["AutomationWrite"]["trigger"],
      conditions: row.condition,
      campaignVersionId: row.campaign_version_id,
      restartPolicy: row.restart_policy as Schemas["AutomationWrite"]["restartPolicy"],
      ...(row.inactivity_seconds != null ? { inactivitySeconds: Number(row.inactivity_seconds) } : {}),
      active: row.active,
    },
  };
  validateSchema("Automation", body, true);
  return body;
}

function enrollmentModel(row: EnrollmentRow): Schemas["Enrollment"] {
  const body: Schemas["Enrollment"] = {
    id: row.id,
    leadId: row.lead_id,
    campaignVersionId: row.campaign_version_id,
    state: row.state as Schemas["Enrollment"]["state"],
    ...(row.current_step != null ? { currentStep: row.current_step } : {}),
    version: Number(row.version),
  };
  validateSchema("Enrollment", body, true);
  return body;
}

/** Automation rules and lead enrollment service. Constructed inside withTenantTransaction. */
export class AutomationService {
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
  ) {}

  private async authorize(permission: Permission) {
    if (requirePermission(this.context, permission) !== "organization")
      throw new AccessError(403, "permission_denied", "Organization automation scope is required.");
    const current = await this.client.query(
      `SELECT 1 FROM app.membership m
       JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE current_user='estate_runtime' AND app.current_tenant()=$1::uuid
       AND app.current_actor()=$2::uuid AND m.tenant_id=$1 AND m.user_id=$2
       AND m.id=$3 AND m.role_id=$4 AND m.status='active' AND o.status='active'
       AND r.permission_grants @> $5::jsonb`,
      [
        this.context.organizationId,
        this.context.userId,
        this.context.memberId,
        this.context.roleId,
        JSON.stringify([{ code: permission, scope: "organization" }]),
      ],
    );
    if (!current.rowCount)
      throw new AccessError(403, "permission_denied", "Current automation authority is unavailable.");
    await requireEntitlement(this.client, permission);
    await requireEntitlement(this.client, permission, { lock: false });
  }

  // --- Automations ---

  async getAutomation(id: string): Promise<Schemas["Automation"]> {
    assertUuid(id);
    await this.authorize("automations.read");
    const result = await this.client.query<AutomationRow>(
      `SELECT id,name,trigger_type,condition,campaign_version_id,restart_policy,inactivity_seconds,active,version,row_version
       FROM app.automation_rule WHERE tenant_id=app.current_tenant() AND id=$1`,
      [id],
    );
    if (!result.rowCount)
      throw new AccessError(404, "resource_unavailable", "Automation unavailable or out of scope.");
    const body = automationModel(result.rows[0]);
    await this.authorize("automations.read");
    return body;
  }

  async listAutomations(query: { cursor?: string; limit?: number } = {}): Promise<AutomationPage> {
    await this.authorize("automations.read");
    const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
    const binding = cursorBinding(this.context, "marketing:automation-rules", "organization", { limit });
    const after = decodeCursor(query.cursor, binding);
    if (after) assertUuid(after);
    const result = await this.client.query<AutomationRow>(
      `SELECT id,name,trigger_type,condition,campaign_version_id,restart_policy,inactivity_seconds,active,version,row_version
       FROM app.automation_rule WHERE tenant_id=app.current_tenant()
       AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
      [after, limit + 1],
    );
    const items = result.rows.slice(0, limit).map(automationModel);
    const hasMore = result.rows.length > limit;
    const body: AutomationPage = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
    validateSchema("PageAutomation", body, true);
    await this.authorize("automations.read");
    return body;
  }

  async createAutomation(
    input: Schemas["AutomationWrite"],
    headers: { key: string | undefined },
  ): Promise<AutomationMutation> {
    await this.authorize("automations.write");
    const key =
      String(headers.key ?? "").slice(0, 255) ||
      (() => {
        throw new AccessError(400, "idempotency_key_required", "Idempotency-Key is required.");
      })();
    const route = `marketing:automation:create`;
    const requestHash = createHash("sha256").update(stable(input)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("automations.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Automation", receipt.response_body, true);
      await this.authorize("automations.write");
      return {
        body: receipt.response_body as Schemas["Automation"],
        status: 201,
        etag: receipt.response_etag,
      };
    }
    await this.assertPublishedVersion(input.campaignVersionId);
    const row = (
      await this.client.query<AutomationRow>(
        `INSERT INTO app.automation_rule(tenant_id,name,trigger_type,condition,campaign_version_id,restart_policy,inactivity_seconds,active)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,$6,$7)
       RETURNING id,name,trigger_type,condition,campaign_version_id,restart_policy,inactivity_seconds,active,version,row_version`,
        [
          input.name,
          input.trigger,
          JSON.stringify(input.conditions ?? {}),
          input.campaignVersionId,
          input.restartPolicy,
          input.inactivitySeconds ?? null,
          input.active,
        ],
      )
    ).rows[0];
    const body = automationModel(row);
    const etag = automationEtag(body.version);
    await this.authorize("automations.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,201,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(body), etag],
    );
    await this.authorize("automations.write");
    return { body, status: 201, etag };
  }

  async updateAutomation(
    id: string,
    input: Schemas["AutomationWrite"],
    headers: { key: string | undefined; ifMatch: string | undefined },
  ): Promise<AutomationMutation> {
    assertUuid(id);
    await this.authorize("automations.write");
    const key =
      String(headers.key ?? "").slice(0, 255) ||
      (() => {
        throw new AccessError(400, "idempotency_key_required", "Idempotency-Key is required.");
      })();
    const expectedVersion = headers.ifMatch ? parseInt(headers.ifMatch.replace(/"/g, ""), 10) : NaN;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
      throw new AccessError(
        428,
        "revision_required",
        "If-Match header with a valid version ETag is required.",
      );
    const route = `marketing:automation:update:${id}`;
    const requestHash = createHash("sha256")
      .update(stable({ body: input, ifMatch: headers.ifMatch ?? null }))
      .digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("automations.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Automation", receipt.response_body, true);
      await this.authorize("automations.write");
      return {
        body: receipt.response_body as Schemas["Automation"],
        status: 200,
        etag: receipt.response_etag,
      };
    }
    await this.assertPublishedVersion(input.campaignVersionId);
    const updated = await this.client.query<AutomationRow>(
      `UPDATE app.automation_rule
       SET name=$1,trigger_type=$2,condition=$3,campaign_version_id=$4,restart_policy=$5,
           inactivity_seconds=$6,active=$7,version=version+1,row_version=row_version+1,updated_at=now()
       WHERE tenant_id=app.current_tenant() AND id=$8 AND row_version=$9
       RETURNING id,name,trigger_type,condition,campaign_version_id,restart_policy,inactivity_seconds,active,version,row_version`,
      [
        input.name,
        input.trigger,
        JSON.stringify(input.conditions ?? {}),
        input.campaignVersionId,
        input.restartPolicy,
        input.inactivitySeconds ?? null,
        input.active,
        id,
        expectedVersion,
      ],
    );
    if (!updated.rowCount)
      throw new AccessError(412, "revision_stale", "Automation changed; refresh before updating.");
    const body = automationModel(updated.rows[0]);
    const etag = automationEtag(body.version);
    await this.authorize("automations.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,200,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(body), etag],
    );
    await this.authorize("automations.write");
    return { body, status: 200, etag };
  }

  // --- Enrollments ---

  async enrollLead(
    input: Schemas["EnrollmentWrite"],
    headers: { key: string | undefined },
  ): Promise<EnrollmentMutation> {
    await this.authorize("automations.write");
    assertUuid(input.leadId);
    assertUuid(input.campaignVersionId);
    const key =
      String(headers.key ?? "").slice(0, 255) ||
      (() => {
        throw new AccessError(400, "idempotency_key_required", "Idempotency-Key is required.");
      })();
    const route = `marketing:enrollment:enroll`;
    const requestHash = createHash("sha256").update(stable(input)).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("automations.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Enrollment", receipt.response_body, true);
      await this.authorize("automations.write");
      return {
        body: receipt.response_body as Schemas["Enrollment"],
        status: 201,
        etag: receipt.response_etag,
      };
    }
    await this.assertPublishedVersion(input.campaignVersionId);
    await this.assertLead(input.leadId);
    const row = (
      await this.client.query<EnrollmentRow>(
        `INSERT INTO app.enrollment(tenant_id,lead_id,campaign_version_id,source_event_id,state)
       VALUES(app.current_tenant(),$1,$2,$3,'active')
       RETURNING id,lead_id,campaign_version_id,state,current_step,version,row_version`,
        [input.leadId, input.campaignVersionId, key],
      )
    ).rows[0];
    const body = enrollmentModel(row);
    const etag = enrollmentEtag(body.version);
    await this.authorize("automations.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,201,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(body), etag],
    );
    await this.authorize("automations.write");
    return { body, status: 201, etag };
  }

  async listEnrollments(query: { cursor?: string; limit?: number } = {}): Promise<EnrollmentPage> {
    await this.authorize("automations.read");
    const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
    const binding = cursorBinding(this.context, "marketing:enrollments", "organization", { limit });
    const after = decodeCursor(query.cursor, binding);
    if (after) assertUuid(after);
    const result = await this.client.query<EnrollmentRow>(
      `SELECT id,lead_id,campaign_version_id,state,current_step,version,row_version
       FROM app.enrollment WHERE tenant_id=app.current_tenant()
       AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`,
      [after, limit + 1],
    );
    const items = result.rows.slice(0, limit).map(enrollmentModel);
    const hasMore = result.rows.length > limit;
    const body: EnrollmentPage = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
    validateSchema("PageEnrollment", body, true);
    await this.authorize("automations.read");
    return body;
  }

  async cancelEnrollment(id: string, headers: { key: string | undefined }): Promise<CancelMutation> {
    assertUuid(id);
    await this.authorize("automations.write");
    const key =
      String(headers.key ?? "").slice(0, 255) ||
      (() => {
        throw new AccessError(400, "idempotency_key_required", "Idempotency-Key is required.");
      })();
    const route = `marketing:enrollment:cancel:${id}`;
    const requestHash = createHash("sha256").update(id).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("automations.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Enrollment", receipt.response_body, true);
      await this.authorize("automations.write");
      return {
        body: receipt.response_body as Schemas["Enrollment"],
        status: 200,
        etag: receipt.response_etag,
      };
    }
    const updated = await this.client.query<EnrollmentRow>(
      `UPDATE app.enrollment
       SET state='cancelled',version=version+1,row_version=row_version+1,updated_at=now()
       WHERE tenant_id=app.current_tenant() AND id=$1 AND state NOT IN ('completed','cancelled')
       RETURNING id,lead_id,campaign_version_id,state,current_step,version,row_version`,
      [id],
    );
    if (!updated.rowCount)
      throw new AccessError(
        409,
        "enrollment_not_cancellable",
        "Enrollment is already completed or cancelled, or does not exist.",
      );
    const body = enrollmentModel(updated.rows[0]);
    const etag = enrollmentEtag(body.version);
    await this.authorize("automations.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,200,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(body), etag],
    );
    await this.authorize("automations.write");
    return { body, status: 200, etag };
  }

  private async assertPublishedVersion(versionId: string) {
    assertUuid(versionId);
    // Published campaign versions are hidden from estate_runtime by RLS; check the idempotency log.
    const published = await this.client.query(
      `SELECT 1 FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND route_key=$1 LIMIT 1`,
      [`marketing:workflow:publish:${versionId}`],
    );
    if (!published.rowCount)
      throw new AccessError(422, "campaign_version_not_published", "Campaign version is not published.");
  }

  private async assertLead(leadId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM app.contact WHERE tenant_id=app.current_tenant() AND id=$1 LIMIT 1`,
      [leadId],
    );
    if (!result.rowCount)
      throw new AccessError(422, "lead_not_found", "Lead does not exist or is out of scope.");
  }
}
