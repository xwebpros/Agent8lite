import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { assertUuid, CrmService, requireVersion } from "./crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";
import { validateSchema } from "./contract-validation";

type Schemas = components["schemas"];
type Row = Record<string, any>;
type Scope = "own" | "team" | "organization";
const missing = (): never => {
  throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
};
const model = (row: Row): Schemas["Deal"] => ({
  id: row.id,
  leadId: row.lead_id,
  name: row.name,
  amount: row.amount === null ? null : Number(row.amount),
  currency: row.currency,
  state: row.state,
  expectedCloseDate:
    row.expected_close_date instanceof Date
      ? `${row.expected_close_date.getFullYear()}-${String(row.expected_close_date.getMonth() + 1).padStart(2, "0")}-${String(row.expected_close_date.getDate()).padStart(2, "0")}`
      : (row.expected_close_date ?? null),
  version: Number(row.row_version),
});
export class DealService {
  readonly foundation: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }
  private scopeSql(scope: Scope, owner = "l.owner_member_id", member = "$2") {
    if (scope === "organization") return "TRUE";
    if (scope === "own") return `${owner}=${member}`;
    return `EXISTS(SELECT 1 FROM app.office_member target JOIN app.office_member mine ON mine.tenant_id=target.tenant_id AND mine.office_id=target.office_id WHERE target.tenant_id=app.current_tenant() AND target.member_id=${owner} AND mine.member_id=${member})`;
  }
  async row(id: string, writing = false, lock = false) {
    assertUuid(id);
    const dealScope = requirePermission(this.context, writing ? "crm.deals.write" : "crm.deals.read");
    const leadScope = requirePermission(this.context, writing ? "crm.leads.write" : "crm.leads.read");
    const leadReadScope = requirePermission(this.context, "crm.leads.read");
    const found = await this.client.query(
      `SELECT r.* FROM app.deal r JOIN app.lead l ON(l.tenant_id,l.id)=(r.tenant_id,r.lead_id) WHERE r.tenant_id=app.current_tenant() AND r.id=$1 AND $2::uuid IS NOT NULL AND l.archived_at IS NULL AND ${this.scopeSql(dealScope)} AND ${this.scopeSql(leadScope)} AND ${this.scopeSql(leadReadScope)} ${lock ? "FOR UPDATE OF r,l" : ""}`,
      [id, this.context.memberId],
    );
    return found.rows[0] ?? missing();
  }
  async detail(id: string) {
    return model(await this.row(id));
  }
  async list(query: Record<string, unknown>) {
    const scope = requirePermission(this.context, "crm.deals.read");
    const leadScope = requirePermission(this.context, "crm.leads.read");
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    let filter: Schemas["LeadFilter"] = {};
    if (query.filter) {
      try {
        filter = JSON.parse(String(query.filter));
      } catch {
        throw new AccessError(422, "filter_invalid", "Filter must be valid JSON.");
      }
      validateSchema("LeadFilter", filter);
    }
    const binding = cursorBinding(this.context, "deals", scope, filter);
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const params: unknown[] = [cursor, this.context.memberId, limit + 1];
    const where = [
      "r.tenant_id=app.current_tenant()",
      "($1::uuid IS NULL OR r.id>$1::uuid)",
      "$2::uuid IS NOT NULL",
      "l.archived_at IS NULL",
      this.scopeSql(scope),
      this.scopeSql(leadScope),
    ];
    for (const [key, column] of [
      ["stageId", "stage_id"],
      ["sourceId", "source_id"],
      ["ownerMemberId", "owner_member_id"],
      ["intent", "intent"],
    ] as const)
      if (filter[key]) {
        params.push(filter[key]);
        where.push(`l.${column}=$${params.length}`);
      }
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`r.name ILIKE $${params.length} ESCAPE '\\'`);
    }
    if (filter.tagIds?.length) {
      requirePermission(this.context, "crm.tags.read");
      if (new Set(filter.tagIds).size !== filter.tagIds.length)
        throw new AccessError(422, "tag_duplicate", "Each tag filter may appear once.");
      const tags = await this.client.query(
        "SELECT id FROM app.tag WHERE tenant_id=app.current_tenant() AND id=ANY($1::uuid[])",
        [filter.tagIds],
      );
      if (tags.rowCount !== filter.tagIds.length)
        throw new AccessError(422, "tag_invalid", "Tag filters must belong to this organization.");
      params.push(filter.tagIds);
      const tagsParam = `$${params.length}::uuid[]`;
      where.push(
        `(SELECT count(*) FROM app.lead_tag lt WHERE lt.tenant_id=app.current_tenant() AND lt.lead_id=l.id AND lt.tag_id=ANY(${tagsParam}))=cardinality(${tagsParam})`,
      );
    }
    const found = await this.client.query(
      `SELECT r.* FROM app.deal r JOIN app.lead l ON(l.tenant_id,l.id)=(r.tenant_id,r.lead_id) WHERE ${where.join(" AND ")} ORDER BY r.id LIMIT $3`,
      params,
    );
    const rows = found.rows.slice(0, limit);
    const hasMore = found.rows.length > limit;
    return {
      items: rows.map(model),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
  async write(body: Schemas["DealWrite"], id?: string, expected?: string) {
    const scope = requirePermission(this.context, "crm.deals.write");
    requirePermission(this.context, "crm.leads.write");
    requirePermission(this.context, "crm.leads.read");
    if (!body.name.trim() || !/^[A-Z]{3}$/.test(body.currency))
      throw new AccessError(
        422,
        "deal_values_invalid",
        "A name and uppercase three-letter currency code are required.",
      );
    if (
      body.amount !== undefined &&
      body.amount !== null &&
      (!Number.isFinite(body.amount) ||
        body.amount > 999999999999.99 ||
        Math.abs(body.amount * 100 - Math.round(body.amount * 100)) > 0.001)
    )
      throw new AccessError(
        422,
        "deal_amount_invalid",
        "Deal amount must fit the database range with at most two decimal places.",
      );
    if (id) {
      const existing = await this.row(id, true);
      if (existing.lead_id !== body.leadId)
        throw new AccessError(422, "deal_lead_immutable", "A deal's lead reference cannot be changed.");
    }
    await this.foundation.row("leads", body.leadId);
    const lead = await this.foundation.row("leads", body.leadId, true, true);
    const eligible = await this.client.query(
      `SELECT l.id FROM app.lead l WHERE l.tenant_id=app.current_tenant() AND l.id=$1 AND $2::uuid IS NOT NULL AND ${this.scopeSql(scope)}`,
      [lead.id, this.context.memberId],
    );
    if (!eligible.rowCount) missing();
    let updated: Row;
    if (id) {
      const current = await this.row(id, true, true);
      requireVersion(current, expected);
      if (current.lead_id !== body.leadId)
        throw new AccessError(422, "deal_lead_immutable", "A deal's lead reference cannot be changed.");
      const result = await this.client.query(
        `UPDATE app.deal SET name=$1,amount=$2,currency=$3,state=$4,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$5 RETURNING *`,
        [body.name.trim(), body.amount ?? null, body.currency, body.state, id],
      );
      updated = result.rows[0];
    } else {
      const result = await this.client.query(
        `INSERT INTO app.deal(tenant_id,lead_id,name,amount,currency,state)VALUES($1,$2,$3,$4,$5,$6)RETURNING *`,
        [
          this.context.organizationId,
          body.leadId,
          body.name.trim(),
          body.amount ?? null,
          body.currency,
          body.state,
        ],
      );
      updated = result.rows[0];
    }
    await this.foundation.audit(
      id ? "deal.updated" : "deal.created",
      "deal",
      updated.id,
      Number(updated.row_version),
    );
    await this.client.query(
      `INSERT INTO app.activity_event(tenant_id,lead_id,event_type,source_event_id,occurred_at,safe_data)VALUES($1,$2,$3,$4,now(),$5)`,
      [
        this.context.organizationId,
        body.leadId,
        id ? "deal.updated" : "deal.created",
        this.traceId,
        JSON.stringify({ resourceId: updated.id, resourceVersion: Number(updated.row_version) }),
      ],
    );
    return { body: model(updated), status: id ? 200 : 201, etag: `"${updated.row_version}"` };
  }
}
