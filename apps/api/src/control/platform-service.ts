import type { PoolClient } from "pg";
import type { VerifiedStaffContext } from "../../../../packages/contracts/internal/control-plane-port";
import { AccessError } from "../../../../packages/db/tenant-transaction";

function requirePermission(staff: VerifiedStaffContext, code: string) {
  if (!staff.permissionCodes.includes(code))
    throw new AccessError(403, "permission_denied", `Requires ${code}.`);
}

interface PlanRow {
  id: string;
  code: string;
  name: string;
  price_minor: string;
  currency: string;
  billing_interval: string;
  provider_price_id: string | null;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  active: boolean;
  row_version: string;
  created_at: string;
}

function planModel(row: PlanRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    priceMinor: Number(row.price_minor),
    currency: row.currency,
    billingInterval: row.billing_interval,
    providerPriceId: row.provider_price_id,
    features: row.features ?? {},
    limits: row.limits ?? {},
    version: Number(row.row_version),
  };
}

export class PlatformService {
  constructor(
    private readonly client: PoolClient,
    private readonly staff: VerifiedStaffContext,
    private readonly traceId: string,
  ) {}

  async healthSummary() {
    requirePermission(this.staff, "platform.health.read");
    const orgCount = await this.client.query("SELECT count(*)::int AS c FROM app.organization");
    const pending = await this.client.query(
      "SELECT count(*)::int AS c FROM app.control_job WHERE state IN ('pending','claimed')",
    );
    const failed = await this.client.query(
      "SELECT count(*)::int AS c FROM app.control_job WHERE state='failed'",
    );
    const providers = await this.client.query(
      `SELECT provider, state,
              CASE WHEN last_success_at IS NOT NULL THEN to_char(last_success_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END AS last_success_at
       FROM app.integration_connection
       ORDER BY provider`,
    );
    return {
      organizations: orgCount.rows[0].c,
      pendingJobs: pending.rows[0].c,
      failedJobs: failed.rows[0].c,
      providerStates: providers.rows.map((r: { provider: string; state: string; last_success_at: string | null }) => ({
        provider: r.provider,
        state: r.state,
        lastSuccessAt: r.last_success_at ?? null,
      })),
      asOf: new Date().toISOString(),
    };
  }

  async configuration() {
    requirePermission(this.staff, "platform.config.read");
    return {
      releaseVersion: process.env.RELEASE_VERSION ?? "0.0.0-dev",
      featureFlags: {},
      region: process.env.REGION ?? "local",
      editableVia: "reviewed_deployment_config" as const,
    };
  }

  async listPlans(query: { limit?: string; cursor?: string }) {
    requirePermission(this.staff, "platform.plans.read");
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const params: unknown[] = [limit + 1];
    let where = "";
    if (query.cursor) {
      where = "WHERE created_at < $2";
      params.push(query.cursor);
    }
    const result = await this.client.query(
      `SELECT * FROM app.plan ${where} ORDER BY created_at DESC LIMIT $1`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = (hasMore ? result.rows.slice(0, limit) : result.rows).map(planModel);
    return {
      items,
      nextCursor: hasMore ? result.rows[limit - 1].created_at.toISOString() : null,
      hasMore,
    };
  }

  async createPlan(input: {
    code: string;
    name: string;
    priceMinor: number;
    currency: string;
    billingInterval: string;
    providerPriceId: string | null;
    features: Record<string, unknown>;
    limits: Record<string, unknown>;
  }) {
    requirePermission(this.staff, "platform.plans.manage");
    const result = await this.client.query(
      `INSERT INTO app.plan(code, name, price_minor, currency, billing_interval, provider_price_id, features, limits)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        input.code,
        input.name,
        input.priceMinor,
        input.currency,
        input.billingInterval,
        input.providerPriceId,
        JSON.stringify(input.features),
        JSON.stringify(input.limits),
      ],
    );
    return planModel(result.rows[0]);
  }

  async updatePlan(
    planId: string,
    input: {
      code?: string;
      name?: string;
      priceMinor?: number;
      currency?: string;
      billingInterval?: string;
      providerPriceId?: string | null;
      features?: Record<string, unknown>;
      limits?: Record<string, unknown>;
    },
    expectedVersion: string,
  ) {
    requirePermission(this.staff, "platform.plans.manage");
    if (!expectedVersion)
      throw new AccessError(428, "revision_required", "If-Match header is required.");
    const current = await this.client.query(
      "SELECT * FROM app.plan WHERE id=$1 FOR UPDATE",
      [planId],
    );
    if (!current.rows.length)
      throw new AccessError(404, "plan_not_found", "Plan not found.");
    if (String(current.rows[0].row_version) !== expectedVersion)
      throw new AccessError(412, "revision_mismatch", "Plan has been modified.");
    const row = current.rows[0];
    const result = await this.client.query(
      `UPDATE app.plan SET
         code=$2, name=$3, price_minor=$4, currency=$5, billing_interval=$6,
         provider_price_id=$7, features=$8, limits=$9,
         row_version=row_version+1, updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [
        planId,
        input.code ?? row.code,
        input.name ?? row.name,
        input.priceMinor ?? Number(row.price_minor),
        input.currency ?? row.currency,
        input.billingInterval ?? row.billing_interval,
        input.providerPriceId !== undefined ? input.providerPriceId : row.provider_price_id,
        input.features ? JSON.stringify(input.features) : row.features,
        input.limits ? JSON.stringify(input.limits) : row.limits,
      ],
    );
    return planModel(result.rows[0]);
  }

  async listAuditEvents(query: { limit?: string; cursor?: string }) {
    requirePermission(this.staff, "platform.audit.read");
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
    const params: unknown[] = [limit + 1];
    let where = "";
    if (query.cursor) {
      where = "WHERE created_at < $2";
      params.push(query.cursor);
    }
    const result = await this.client.query(
      `SELECT id, actor_ref, action, resource_type, resource_id, trace_id, created_at
       FROM app.audit_event ${where}
       ORDER BY created_at DESC LIMIT $1`,
      params,
    );
    const hasMore = result.rows.length > limit;
    const items = (hasMore ? result.rows.slice(0, limit) : result.rows).map(
      (r: { id: string; actor_ref: string; action: string; resource_type: string; resource_id: string | null; trace_id: string; created_at: Date }) => ({
        id: r.id,
        actorRef: r.actor_ref,
        action: r.action,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        traceId: r.trace_id,
        createdAt: r.created_at.toISOString(),
      }),
    );
    return {
      items,
      nextCursor: hasMore ? result.rows[limit - 1].created_at.toISOString() : null,
      hasMore,
    };
  }
}
