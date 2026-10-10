import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertStaffPermission, withStaffTransaction } from "../../../../packages/auth/staff-sessions";
import type {
  BillingBootstrapPort,
  BootstrapPolicy,
  ControlProvisioningPort,
  CrmBootstrapPort,
  ProvisioningClaim,
  ProvisioningExecutionPort,
  VerifiedProvisioningContext,
  VerifiedStaffContext,
} from "../../../../packages/contracts/internal/control-plane-port";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";
import { decodeCursor, encodeCursor } from "../cursors";
import { organization, type Schemas } from "../models";
import {
  BillingBootstrap,
  canonical,
  CrmBootstrap,
  SaasBootstrap,
  SyntheticBootstrapPolicy,
} from "./bootstrap-ports";
import { validateControlEvent } from "./validation";

type Row = Record<string, any>;
type Failure = Parameters<ControlProvisioningPort["fail"]>[2];
const digest = (body: unknown) => createHash("sha256").update(canonical(body)).digest("hex");
function commandKey(key: string) {
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(key))
    throw new AccessError(422, "idempotency_key_invalid", "A bounded idempotency key is required.");
}
export function jobEntity(row: Row): Schemas["Job"] {
  const result: Schemas["Job"] = {
    id: row.id,
    kind: row.kind,
    state: row.state,
    createdAt: new Date(row.created_at).toISOString(),
    resultUrl: null,
    error: row.safe_error
      ? {
          type: "about:blank",
          title: "Provisioning requires review.",
          status: 409,
          code: row.safe_error,
          traceId: row.id,
        }
      : null,
  };
  validateSchema("Job", result, true);
  return result;
}
export async function bindProvisioning(client: PoolClient, claim: ProvisioningClaim) {
  await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.provision_claim',$2,true)", [
    claim.organizationId,
    claim.claimId,
  ]);
}
async function audit(
  client: PoolClient,
  staff: VerifiedStaffContext,
  organizationId: string,
  jobId: string,
  traceId: string,
  action: string,
) {
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [organizationId]);
  await client.query(
    "INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)VALUES($1,$2,$3,'control_job',$4,$5,'{}')",
    [organizationId, staff.userId, action, jobId, traceId],
  );
}

/** Requester authority is explicit in every query even when metadata RLS permits broader health reads. */
export class ControlProvisioningService implements ControlProvisioningPort {
  constructor(
    private readonly client: PoolClient,
    private readonly staff: VerifiedStaffContext,
    private readonly traceId: string,
  ) {}
  private async authorize() {
    await assertStaffPermission(this.client, this.staff, "platform.orgs.provision");
  }
  async readJob(jobId: string) {
    await this.authorize();
    const result = await this.client.query(
      "SELECT * FROM app.control_job WHERE id=$1 AND requesting_staff_user_id=$2 AND kind='organization.provision'",
      [jobId, this.staff.userId],
    );
    if (result.rowCount !== 1) throw new AccessError(404, "job_unavailable", "Job unavailable.");
    return jobEntity(result.rows[0]);
  }
  async lookupCommand(route: string, key: string, body: unknown) {
    await this.authorize();
    commandKey(key);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.staff.userId}:${route}:${key}`,
    ]);
    const result = await this.client.query(
      "SELECT request_hash,response_body FROM app.control_idempotency WHERE staff_user_id=$1 AND route_key=$2 AND key=$3",
      [this.staff.userId, route, key],
    );
    if (!result.rowCount) return null;
    if (result.rows[0].request_hash !== digest(body))
      throw new AccessError(
        409,
        "idempotency_conflict",
        "This command key was used with a different request.",
      );
    return this.readJob(result.rows[0].response_body.id);
  }
  async recordCommand(
    route: string,
    key: string,
    body: unknown,
    job: Schemas["Job"],
    attempt?: { readonly claimId: string | null; readonly number: number },
  ) {
    await this.authorize();
    commandKey(key);
    await this.client.query(
      "INSERT INTO app.control_idempotency(staff_user_id,route_key,key,request_hash,response_body,status_code)VALUES($1,$2,$3,$4,$5,202)ON CONFLICT DO NOTHING",
      [this.staff.userId, route, key, digest(body), attempt ? { ...job, internalRunAttempt: attempt } : job],
    );
  }
  /** This must commit before execution: retries reconcile this binding and never start another attempt. */
  async prepareRun(jobId: string, key: string) {
    const route = `POST /dev/staff/jobs/${jobId}/run`,
      replay = await this.lookupCommand(route, key, {});
    if (replay) return { replay, claim: null, job: replay };
    const claim = await this.claim(jobId),
      job = await this.readJob(jobId);
    const current = (
      await this.client.query(
        "SELECT claim_id,attempt_count FROM app.control_job WHERE id=$1 AND requesting_staff_user_id=$2",
        [jobId, this.staff.userId],
      )
    ).rows[0];
    await this.recordCommand(route, key, {}, job, {
      claimId: current.claim_id,
      number: Number(current.attempt_count),
    });
    return { replay: null, claim, job };
  }
  async enqueue(body: Schemas["OrganizationCreate"], key: string) {
    validateSchema("OrganizationCreate", body);
    if (!body.name.trim())
      throw new AccessError(422, "organization_name_invalid", "Organization name is required.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: body.timezone }).format();
      new Intl.Locale(body.locale ?? "en-US");
    } catch {
      throw new AccessError(422, "organization_locale_invalid", "A valid timezone and locale are required.");
    }
    const route = "POST /v1/platform/organizations",
      replay = await this.lookupCommand(route, key, body);
    if (replay) return replay;
    const policy = await new SyntheticBootstrapPolicy(this.client).resolve();
    const organizationId = randomUUID(),
      jobId = randomUUID();
    await this.client.query(
      "INSERT INTO app.organization(id,name,status,timezone,locale)VALUES($1,$2,'provisioning',$3,$4)",
      [organizationId, body.name.trim(), body.timezone, body.locale ?? "en-US"],
    );
    const result = await this.client.query(
      "INSERT INTO app.control_job(id,organization_id,requesting_staff_user_id,kind,state,bootstrap_owner_user_id,bootstrap_policy)VALUES($1,$2,$3,'organization.provision','queued',$4,$5)RETURNING *",
      [jobId, organizationId, this.staff.userId, policy.ownerUserId, policy],
    );
    await audit(
      this.client,
      this.staff,
      organizationId,
      jobId,
      this.traceId,
      "organization.provisioning_queued",
    );
    const job = jobEntity(result.rows[0]);
    await this.recordCommand(route, key, body, job);
    return job;
  }
  async claim(jobId: string): Promise<ProvisioningClaim | null> {
    await this.authorize();
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `provisioning:${jobId}`,
    ]);
    const existing = await this.readJob(jobId);
    if (existing.state === "succeeded" || existing.state === "cancelled") return null;
    const row = (
      await this.client.query(
        "SELECT *,lease_until>clock_timestamp()AS leased FROM app.control_job WHERE id=$1 AND requesting_staff_user_id=$2 FOR UPDATE",
        [jobId, this.staff.userId],
      )
    ).rows[0];
    if (!row || (row.state === "running" && row.leased)) return null;
    const claimId = randomUUID();
    const result = await this.client.query(
      "UPDATE app.control_job SET state='running',safe_error=NULL,claim_id=$3,lease_until=clock_timestamp()+interval '60 seconds',attempt_count=attempt_count+1,row_version=row_version+1,updated_at=clock_timestamp()WHERE id=$1 AND requesting_staff_user_id=$2 AND row_version=$4 RETURNING *",
      [jobId, this.staff.userId, claimId, row.row_version],
    );
    if (result.rowCount !== 1) throw new AccessError(409, "provisioning_lease_lost", "Job claim changed.");
    await audit(
      this.client,
      this.staff,
      row.organization_id,
      jobId,
      this.traceId,
      "organization.provisioning_claimed",
    );
    return {
      jobId,
      organizationId: row.organization_id,
      claimId,
      expiresAt: new Date(result.rows[0].lease_until).toISOString(),
      initiatingStaffUserId: this.staff.userId,
      policy: row.bootstrap_policy as BootstrapPolicy,
    };
  }
  async fail(jobId: string, claimId: string, code: Failure) {
    await this.authorize();
    const allowed: readonly Failure[] = [
      "bootstrap_owner_unavailable",
      "bootstrap_policy_changed",
      "bootstrap_defaults_invalid",
      "provisioning_lease_lost",
      "provisioning_unavailable",
    ];
    if (!allowed.includes(code))
      throw new AccessError(422, "provisioning_error_invalid", "A safe provisioning error is required.");
    const result = await this.client.query(
      "UPDATE app.control_job SET state='failed',safe_error=$4,row_version=row_version+1,updated_at=clock_timestamp()WHERE id=$1 AND requesting_staff_user_id=$2 AND claim_id=$3 AND state='running' RETURNING *",
      [jobId, this.staff.userId, claimId, code],
    );
    if (result.rowCount === 1)
      await audit(
        this.client,
        this.staff,
        result.rows[0].organization_id,
        jobId,
        this.traceId,
        "organization.provisioning_failed",
      );
    return this.readJob(jobId);
  }
  async listOrganizations(query: { limit?: string; cursor?: string }) {
    await assertStaffPermission(this.client, this.staff, "platform.orgs.read");
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "page_limit_invalid", "Limit must be between 1 and 100.");
    const binding = digest({
      resource: "platform.organizations",
      user: this.staff.userId,
      principal: this.staff.staffPrincipalId,
      version: this.staff.principalVersion,
      permissions: this.staff.permissionCodes,
      session: this.staff.sessionHash,
      sort: "id:asc",
    });
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor && !/^[0-9a-f-]{36}$/.test(cursor))
      throw new AccessError(422, "cursor_invalid", "Invalid page cursor.");
    const rows = (
      await this.client.query(
        "SELECT * FROM app.organization WHERE($1::uuid IS NULL OR id>$1)ORDER BY id LIMIT $2",
        [cursor, limit + 1],
      )
    ).rows;
    const hasMore = rows.length > limit,
      page = rows.slice(0, limit);
    const result: Schemas["PageOrganization"] = {
      items: page.map(organization),
      hasMore,
      nextCursor: hasMore ? encodeCursor(page.at(-1)!.id, binding) : null,
    };
    validateSchema("PageOrganization", result, true);
    return result;
  }
}

export interface BootstrapPortFactory {
  crm(client: PoolClient, context: VerifiedProvisioningContext): CrmBootstrapPort;
  billing(client: PoolClient, context: VerifiedProvisioningContext): BillingBootstrapPort;
}
const defaultPorts: BootstrapPortFactory = {
  crm: (client, context) => new CrmBootstrap(client, context),
  billing: (client, context) => new BillingBootstrap(client, context),
};
/** Ports use exactly the caller client: activation, defaults, event and Job cannot partially commit. */
export class ProvisioningExecution implements ProvisioningExecutionPort {
  constructor(
    private readonly client: PoolClient,
    private readonly staff: VerifiedStaffContext,
    private readonly context: VerifiedProvisioningContext,
    private readonly ports: BootstrapPortFactory = defaultPorts,
  ) {}
  async execute() {
    await assertStaffPermission(this.client, this.staff, "platform.orgs.provision");
    const row = (
      await this.client.query(
        "SELECT *,lease_until>clock_timestamp()AS leased FROM app.control_job WHERE id=$1 AND requesting_staff_user_id=$2 FOR UPDATE",
        [this.context.jobId, this.staff.userId],
      )
    ).rows[0];
    if (
      !row ||
      row.state !== "running" ||
      row.claim_id !== this.context.claimId ||
      !row.leased ||
      row.organization_id !== this.context.organizationId ||
      row.requesting_staff_user_id !== this.context.initiatingStaffUserId ||
      canonical(row.bootstrap_policy) !== canonical(this.context.policy)
    )
      throw new AccessError(409, "provisioning_lease_lost", "Current provisioning claim required.");
    await bindProvisioning(this.client, this.context);
    const policy = new SyntheticBootstrapPolicy(this.client);
    await policy.assertCurrent(this.context.policy);
    const org = (
      await this.client.query(
        "SELECT * FROM app.organization WHERE id=$1 AND status='provisioning'FOR UPDATE",
        [this.context.organizationId],
      )
    ).rows[0];
    if (!org) throw new AccessError(409, "provisioning_lease_lost", "Provisioning organization required.");
    const saas = new SaasBootstrap(this.client, this.context),
      crm = this.ports.crm(this.client, this.context),
      billing = this.ports.billing(this.client, this.context);
    const owner = await saas.seedDefaults();
    await crm.seedDefaults(owner);
    await billing.seedApprovedPolicy();
    await saas.verifyDefaults(owner);
    await crm.verifyDefaults(owner);
    await billing.assertReady();
    await policy.assertCurrent(this.context.policy);
    await assertStaffPermission(this.client, this.staff, "platform.orgs.provision");
    const lease = (
      await this.client.query("SELECT app.control_can_seed($1)AS current", [this.context.organizationId])
    ).rows[0]?.current;
    if (!lease) throw new AccessError(409, "provisioning_lease_lost", "Provisioning lease expired.");
    const stamp = (await this.client.query("SELECT clock_timestamp()AS stamp")).rows[0].stamp.toISOString();
    const eventId = randomUUID(),
      event = {
        eventId,
        type: "integration.state_changed",
        version: 1,
        tenantId: this.context.organizationId,
        occurredAt: stamp,
        ingestedAt: stamp,
        producer: "control-plane",
        aggregateType: "organization",
        aggregateId: this.context.organizationId,
        correlationId: this.context.traceId,
        payload: {
          resourceId: this.context.organizationId,
          resourceVersion: Number(org.row_version) + 1,
          relatedResourceIds: [this.context.jobId],
          safeCode: "bootstrap_core_ready",
        },
      };
    validateControlEvent(event);
    await this.client.query(
      "INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)VALUES($1::uuid,$2,'integration.state_changed',$1::text,$3,$4)",
      [this.context.organizationId, eventId, event, this.staff.userId],
    );
    await audit(
      this.client,
      this.staff,
      this.context.organizationId,
      this.context.jobId,
      this.context.traceId,
      "organization.provisioned",
    );
    const activated = await this.client.query(
      "UPDATE app.organization SET status='active',row_version=row_version+1,updated_at=clock_timestamp()WHERE id=$1 AND status='provisioning'AND row_version=$2 RETURNING id",
      [this.context.organizationId, org.row_version],
    );
    if (activated.rowCount !== 1)
      throw new AccessError(409, "provisioning_lease_lost", "Organization activation changed.");
    const completed = await this.client.query(
      "UPDATE app.control_job SET state='succeeded',result_ref=organization_id,safe_error=NULL,row_version=row_version+1,updated_at=clock_timestamp()WHERE id=$1 AND requesting_staff_user_id=$2 AND claim_id=$3 AND state='running'AND lease_until>clock_timestamp()AND row_version=$4 RETURNING *",
      [this.context.jobId, this.staff.userId, this.context.claimId, row.row_version],
    );
    if (completed.rowCount !== 1)
      throw new AccessError(409, "provisioning_lease_lost", "Provisioning completion changed.");
    return jobEntity(completed.rows[0]);
  }
}

/** Local explicit execution only. Claim commits before work; failures never retain partial module writes. */
export async function runProvisioning(
  pool: Pool,
  token: string,
  jobId: string,
  key: string,
  traceId: string,
  ports?: BootstrapPortFactory,
) {
  const initial = await withStaffTransaction(pool, token, (client, staff) =>
    new ControlProvisioningService(client, staff, traceId).prepareRun(jobId, key),
  );
  if (initial.replay) return initial.replay;
  let job = initial.job;
  if (initial.claim) {
    try {
      job = await withStaffTransaction(pool, token, (client, staff) =>
        new ProvisioningExecution(client, staff, { ...initial.claim!, traceId }, ports).execute(),
      );
    } catch (error) {
      const codes: readonly Failure[] = [
        "bootstrap_owner_unavailable",
        "bootstrap_policy_changed",
        "bootstrap_defaults_invalid",
        "provisioning_lease_lost",
      ];
      const code: Failure =
        error instanceof AccessError && codes.includes(error.code as Failure)
          ? (error.code as Failure)
          : "provisioning_unavailable";
      job = await withStaffTransaction(pool, token, (client, staff) =>
        new ControlProvisioningService(client, staff, traceId).fail(jobId, initial.claim!.claimId, code),
      );
    }
  }
  return job;
}
