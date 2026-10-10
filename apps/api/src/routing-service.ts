import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { CrmService, requireVersion } from "./crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";
import { validateSchema } from "./contract-validation";
import { jobModel } from "./admin-service";

type Rule = components["schemas"]["RoutingRule"];
type Weights = NonNullable<Rule["memberWeights"]>;
type Row = Record<string, any>;
export function postal(value: string) {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!/^[A-Z0-9 -]{1,16}$/.test(normalized))
    throw new AccessError(
      422,
      "postal_invalid",
      "Postal routing values must contain letters, digits, spaces or hyphens.",
    );
  return normalized;
}
export function routingModel(row: Row): Rule {
  return {
    id: row.id,
    priority: row.priority,
    kind: row.condition.kind,
    enabled: row.enabled,
    ...(row.assignment.memberWeights?.length ? { memberWeights: row.assignment.memberWeights } : {}),
    ...(row.condition.postalCodes?.length ? { postalCodes: row.condition.postalCodes } : {}),
    version: Number(row.row_version),
  };
}
/** MOD-D service bound to the caller's verified transaction. */
export class RoutingService {
  readonly foundation: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }
  async state(lock: "share" | "update" = "share") {
    const state = await this.client.query(
      `SELECT * FROM app.crm_routing_state WHERE tenant_id=app.current_tenant() FOR ${lock === "share" ? "SHARE" : "UPDATE"}`,
    );
    if (!state.rowCount)
      throw new AccessError(
        409,
        "routing_uninitialized",
        "Routing must be initialized for this organization.",
      );
    return state.rows[0];
  }
  async rules() {
    const rules = await this.client.query(
      "SELECT * FROM app.routing_rule WHERE tenant_id=app.current_tenant() AND NOT coalesce((condition->>'retired')::boolean,false) ORDER BY priority,id",
    );
    return rules.rows;
  }
  async eligible(memberIds: string[], restrictCaller = false) {
    if (!memberIds.length) return new Set<string>();
    // Member/role locks keep eligibility current until the caller's command commits.
    const recipients = await this.client.query(
      `SELECT m.id,r.permission_grants,EXISTS(SELECT 1 FROM app.office_member om WHERE om.tenant_id=m.tenant_id AND om.member_id=m.id) AS has_office FROM app.membership m JOIN app.role_definition r ON(r.tenant_id,r.id)=(m.tenant_id,m.role_id) WHERE m.tenant_id=app.current_tenant() AND m.id=ANY($1::uuid[]) AND m.status='active' ORDER BY m.id FOR SHARE OF m,r`,
      [memberIds],
    );
    return new Set<string>(
      recipients.rows
        .filter((row) => {
          const grants = row.permission_grants as TenantContext["permissions"];
          return (
            (!restrictCaller || row.id === this.context.memberId) &&
            ["crm.leads.read", "crm.leads.write"].every((code) =>
              grants.some((grant) => grant.code === code && (grant.scope !== "team" || row.has_office)),
            )
          );
        })
        .map((row) => row.id),
    );
  }
  async list(query: Record<string, unknown>) {
    const scope = requirePermission(this.context, "crm.routing.read");
    const state = await this.state();
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    let filter = {};
    if (query.filter) {
      try {
        filter = JSON.parse(String(query.filter));
      } catch {
        throw new AccessError(422, "filter_invalid", "Filter must be valid JSON.");
      }
      validateSchema("LeadFilter", filter);
      if (Object.keys(filter).length)
        throw new AccessError(422, "filter_not_available", "Routing filters are unavailable.");
    }
    const visible = await this.client.query(
      `SELECT m.id FROM app.membership m WHERE m.tenant_id=app.current_tenant() AND $1::uuid IS NOT NULL AND ${scope === "organization" ? "TRUE" : scope === "own" ? "m.id=$1" : "EXISTS(SELECT 1 FROM app.office_member target JOIN app.office_member mine ON(mine.tenant_id,mine.office_id)=(target.tenant_id,target.office_id) WHERE target.tenant_id=m.tenant_id AND target.member_id=m.id AND mine.member_id=$1)"} ORDER BY m.id`,
      [this.context.memberId],
    );
    const visibleMembers = new Set(visible.rows.map((row) => row.id));
    const binding = cursorBinding(
      this.context,
      "routing",
      scope,
      filter,
      `priority:asc,id:asc:${state.row_version}:${[...visibleMembers].join(",")}`,
    );
    const cursor = decodeCursor(query.cursor, binding);
    const rules = (await this.rules()).flatMap((rule) => {
      if (!rule.assignment.memberWeights?.length) return [rule];
      const memberWeights = rule.assignment.memberWeights.filter((weight: Weights[number]) =>
        visibleMembers.has(weight.memberId),
      );
      return memberWeights.length ? [{ ...rule, assignment: { memberWeights } }] : [];
    });
    const index = cursor ? rules.findIndex((rule) => rule.id === cursor) : -1;
    if (cursor && index === -1)
      throw new AccessError(422, "cursor_invalid", "Routing cursor no longer matches configuration.");
    const rows = rules.slice(index + 1, index + 1 + limit);
    const hasMore = rules.length > index + 1 + limit;
    return {
      body: {
        items: rows.map(routingModel),
        hasMore,
        nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      },
      status: 200,
      etag: `"${state.row_version}"`,
      routingCanReplace:
        scope === "organization" &&
        this.context.permissions.some(
          (grant) => grant.code === "crm.routing.manage" && grant.scope === "organization",
        ),
    };
  }
  private validateRule(rule: Rule) {
    const weights = rule.memberWeights ?? [];
    const codes = (rule.postalCodes ?? []).map(postal);
    if (
      new Set(weights.map((item) => item.memberId)).size !== weights.length ||
      new Set(codes).size !== codes.length
    )
      throw new AccessError(422, "routing_duplicate", "Recipients and postal routing values must be unique.");
    if (
      (["first_touch", "listing_agent"].includes(rule.kind) && (weights.length || codes.length)) ||
      (rule.kind === "round_robin" && (!weights.length || codes.length)) ||
      (rule.kind === "geography" && (!weights.length || !codes.length))
    )
      throw new AccessError(
        422,
        "routing_shape_invalid",
        "Rule fields must match the selected routing kind.",
      );
    return { weights, codes };
  }
  async replace(body: components["schemas"]["RoutingWrite"], expected: string | undefined) {
    if (requirePermission(this.context, "crm.routing.manage") !== "organization")
      throw new AccessError(
        403,
        "routing_scope_unavailable",
        "Replacing the organization routing configuration requires organization scope.",
      );
    const state = await this.state("update");
    requireVersion(state, expected);
    if (
      new Set(body.rules.map((rule) => rule.id)).size !== body.rules.length ||
      new Set(body.rules.map((rule) => rule.priority)).size !== body.rules.length
    )
      throw new AccessError(422, "routing_duplicate", "Routing IDs and priorities must be unique.");
    const all = await this.client.query(
      "SELECT * FROM app.routing_rule WHERE tenant_id=app.current_tenant() ORDER BY id",
    );
    const existing = new Map<string, Row>(all.rows.map((row) => [row.id, row]));
    const prepared = body.rules.map((rule) => {
      const old = existing.get(rule.id);
      if (old?.condition.retired)
        throw new AccessError(
          409,
          "routing_rule_retired",
          "Retired routing IDs preserve history and cannot be reactivated.",
        );
      if (old) requireVersion(old, String(rule.version));
      else if (rule.version !== 1)
        throw new AccessError(422, "routing_version_invalid", "New routing rules require version one.");
      return { rule, ...this.validateRule(rule) };
    });
    const recipients = [
      ...new Set(prepared.flatMap((item) => item.weights.map((weight) => weight.memberId))),
    ];
    const eligible = await this.eligible(recipients);
    if (eligible.size !== recipients.length)
      throw new AccessError(
        422,
        "recipient_invalid",
        "Routing recipients must be active eligible members of this organization.",
      );
    // Negative positions are internal historical slots; allocate below every retained row.
    let internalPriority = Math.min(-1, ...all.rows.map((row) => row.priority - 1));
    for (const row of all.rows.filter((item) => !item.condition.retired)) {
      const retained = prepared.some((item) => item.rule.id === row.id);
      const condition = retained
        ? row.condition
        : { ...row.condition, retired: true, originalPriority: row.priority };
      await this.client.query(
        "UPDATE app.routing_rule SET priority=$1,enabled=CASE WHEN $2 THEN enabled ELSE false END,condition=$3,row_version=row_version+CASE WHEN $2 THEN 0 ELSE 1 END,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$4",
        [internalPriority--, retained, JSON.stringify(condition), row.id],
      );
      if (!retained)
        await this.foundation.audit(
          "routing_rule.retired",
          "routing_rule",
          row.id,
          Number(row.row_version) + 1,
        );
    }
    for (const item of prepared) {
      const { rule, weights, codes } = item;
      const condition = JSON.stringify({
        kind: rule.kind,
        retired: false,
        ...(codes.length ? { postalCodes: codes } : {}),
      });
      const assignment = JSON.stringify(weights.length ? { memberWeights: weights } : {});
      const old = existing.get(rule.id);
      const changed = old
        ? await this.client.query(
            "UPDATE app.routing_rule SET priority=$1,enabled=$2,condition=$3,assignment=$4,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$5 RETURNING row_version",
            [rule.priority, rule.enabled, condition, assignment, rule.id],
          )
        : await this.client.query(
            "INSERT INTO app.routing_rule(tenant_id,id,priority,enabled,condition,assignment)VALUES($1,$2,$3,$4,$5,$6)RETURNING row_version",
            [this.context.organizationId, rule.id, rule.priority, rule.enabled, condition, assignment],
          );
      await this.foundation.audit(
        `routing_rule.${old ? "updated" : "created"}`,
        "routing_rule",
        rule.id,
        Number(changed.rows[0].row_version),
      );
    }
    await this.client.query(
      "UPDATE app.crm_routing_state SET row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant()",
    );
    const job = await this.client.query(
      "INSERT INTO app.integration_job(tenant_id,kind,state,requesting_member_id,safe_result)VALUES($1,'crm.routing.updated','succeeded',$2,$3)RETURNING *",
      [
        this.context.organizationId,
        this.context.memberId,
        JSON.stringify({ routingVersion: Number(state.row_version) + 1 }),
      ],
    );
    return { body: jobModel(job.rows[0]), status: 202, etag: `"${Number(state.row_version) + 1}"` };
  }
  async weighted(rule: Row, weights: Weights, restrictCaller: boolean) {
    const eligible = await this.eligible(
      weights.map((weight) => weight.memberId),
      restrictCaller,
    );
    const recipients = weights
      .filter((weight) => eligible.has(weight.memberId))
      .sort((a, b) => a.memberId.localeCompare(b.memberId));
    if (!recipients.length) return null;
    await this.client.query(
      "INSERT INTO app.routing_distribution(tenant_id,rule_id)VALUES($1,$2)ON CONFLICT DO NOTHING",
      [this.context.organizationId, rule.id],
    );
    const counter = await this.client.query(
      "SELECT next_sequence FROM app.routing_distribution WHERE tenant_id=app.current_tenant() AND rule_id=$1 FOR UPDATE",
      [rule.id],
    );
    const total = recipients.reduce((sum, item) => sum + item.weight, 0);
    let index = Number(BigInt(counter.rows[0].next_sequence) % BigInt(total));
    const selected = recipients.find((item) => {
      index -= item.weight;
      return index < 0;
    })!;
    await this.client.query(
      "UPDATE app.routing_distribution SET next_sequence=next_sequence+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND rule_id=$1",
      [rule.id],
    );
    return selected.memberId;
  }
}
