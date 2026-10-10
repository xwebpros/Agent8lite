import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  SupportAccessPort,
  SupportCrmReadPort,
  SupportReadContext,
  SupportResource,
  SupportResourceEntity,
  SupportResourcePage,
  VerifiedStaffContext,
} from "../../../../packages/contracts/internal/control-plane-port";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";
import { assertUuid, stable } from "../crm-service";
import { decodeCursor, encodeCursor } from "../cursors";
import * as models from "../models";
import type { Schemas } from "../models";

type Row = Record<string, any>;
const configuration = {
  contacts: {
    table: "contact",
    permission: "crm.contacts.read",
    schema: "Contact",
    page: "PageContact",
    mapper: models.contact,
  },
  leads: {
    table: "lead",
    permission: "crm.leads.read",
    schema: "Lead",
    page: "PageLead",
    mapper: models.lead,
  },
  tasks: {
    table: "task",
    permission: "crm.tasks.read",
    schema: "Task",
    page: "PageTask",
    mapper: models.task,
  },
  deals: {
    table: "deal",
    permission: "crm.deals.read",
    schema: "Deal",
    page: "PageDeal",
    mapper: (row: Row): Schemas["Deal"] => ({
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
    }),
  },
  "pipeline-stages": {
    table: "pipeline_stage",
    permission: "crm.pipeline.read",
    schema: "PipelineStage",
    page: "PagePipelineStage",
    mapper: models.stage,
  },
  "lead-sources": {
    table: "lead_source",
    permission: "crm.sources.read",
    schema: "LeadSource",
    page: "PageLeadSource",
    mapper: models.source,
  },
  tags: {
    table: "tag",
    permission: "crm.tags.read",
    schema: "Tag",
    page: "PageTag",
    mapper: (row: Row): Schemas["Tag"] => ({ id: row.id, name: row.name, version: Number(row.row_version) }),
  },
} as const;
const missing = (): never => {
  throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
};

/** CRM-owned read-only projection. The control context is never converted into a member TenantContext. */
export class SupportCrmReader implements SupportCrmReadPort {
  constructor(
    private readonly client: PoolClient,
    private readonly context: SupportReadContext,
    private readonly access: SupportAccessPort,
    private readonly staff: VerifiedStaffContext,
  ) {}
  private async guard(resource: SupportResource) {
    const current = await this.access.assertCurrent(this.context, configuration[resource].permission);
    if (resource === "leads" || resource === "deals")
      await this.access.assertCurrent(current, "crm.contacts.read");
    if (resource === "deals") await this.access.assertCurrent(current, "crm.leads.read");
    return current;
  }
  private select(resource: SupportResource) {
    const fields =
      resource === "contacts"
        ? "r.*,ARRAY(SELECT c.normalized_value FROM app.contact_channel c WHERE c.tenant_id=r.tenant_id AND c.contact_id=r.id AND c.kind='email'AND c.active ORDER BY c.created_at,c.id)AS emails,ARRAY(SELECT c.normalized_value FROM app.contact_channel c WHERE c.tenant_id=r.tenant_id AND c.contact_id=r.id AND c.kind='phone'AND c.active ORDER BY c.created_at,c.id)AS phones"
        : "r.*";
    return `${fields},${this.sourceSnapshot(resource)} AS source_snapshot`;
  }
  private leadSnapshot(alias: "r" | "l") {
    return `jsonb_build_object('id',${alias}.id,'version',${alias}.row_version,'archivedAt',${alias}.archived_at,'owner',${alias}.owner_member_id,
      'contact',(SELECT jsonb_build_object('id',p.id,'version',p.row_version,'archivedAt',p.archived_at)FROM app.contact p WHERE(p.tenant_id,p.id)=(${alias}.tenant_id,${alias}.contact_id)),
      'stage',(SELECT jsonb_build_object('id',s.id,'version',s.row_version,'position',s.position,'name',s.name)FROM app.pipeline_stage s WHERE(s.tenant_id,s.id)=(${alias}.tenant_id,${alias}.stage_id)),
      'source',(SELECT jsonb_build_object('id',s.id,'version',s.row_version,'code',s.code,'label',s.label)FROM app.lead_source s WHERE(s.tenant_id,s.id)=(${alias}.tenant_id,${alias}.source_id)),
      'tags',(SELECT jsonb_agg(jsonb_build_array(lt.id,lt.row_version,lt.tag_id,t.row_version,t.name)ORDER BY lt.id)FROM app.lead_tag lt JOIN app.tag t ON(t.tenant_id,t.id)=(lt.tenant_id,lt.tag_id)WHERE(lt.tenant_id,lt.lead_id)=(${alias}.tenant_id,${alias}.id)))`;
  }
  private sourceSnapshot(resource: SupportResource) {
    if (resource === "contacts")
      return `jsonb_build_object('version',r.row_version,'archivedAt',r.archived_at,
        'channels',(SELECT jsonb_agg(jsonb_build_array(c.id,c.row_version,c.kind,c.active,c.normalized_value,c.created_at)ORDER BY c.id)FROM app.contact_channel c WHERE(c.tenant_id,c.contact_id)=(r.tenant_id,r.id)),
        'leads',(SELECT jsonb_agg(${this.leadSnapshot("l")} ORDER BY l.id)FROM app.lead l WHERE(l.tenant_id,l.contact_id)=(r.tenant_id,r.id)))`;
    if (resource === "leads") return this.leadSnapshot("r");
    if (resource === "tasks" || resource === "deals")
      return `jsonb_build_object('version',r.row_version,'lead',(SELECT ${this.leadSnapshot("l")}FROM app.lead l WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id)))`;
    return "jsonb_build_object('version',r.row_version)";
  }
  private assertProjectionUnchanged(resource: SupportResource, before: Row[], after: Row[]) {
    const snapshot = (rows: Row[]) =>
      stable(
        rows.map((row) => ({ projection: configuration[resource].mapper(row), source: row.source_snapshot })),
      );
    if (snapshot(before) !== snapshot(after))
      throw new AccessError(
        409,
        "support_source_changed",
        "CRM source changed during this read. Reload before retrying.",
      );
  }
  private visibility(resource: SupportResource) {
    if (resource === "contacts") return "r.archived_at IS NULL";
    if (resource === "leads")
      return "r.archived_at IS NULL AND EXISTS(SELECT 1 FROM app.contact c WHERE(c.tenant_id,c.id)=(r.tenant_id,r.contact_id)AND c.archived_at IS NULL)";
    if (resource === "tasks")
      return "(r.lead_id IS NULL OR EXISTS(SELECT 1 FROM app.lead l JOIN app.contact c ON(c.tenant_id,c.id)=(l.tenant_id,l.contact_id)WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id)AND l.archived_at IS NULL AND c.archived_at IS NULL))";
    if (resource === "deals")
      return "EXISTS(SELECT 1 FROM app.lead l JOIN app.contact c ON(c.tenant_id,c.id)=(l.tenant_id,l.contact_id)WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id)AND l.archived_at IS NULL AND c.archived_at IS NULL)";
    return "TRUE";
  }
  async detail<R extends SupportResource>(resource: R, id: string): Promise<SupportResourceEntity[R]> {
    assertUuid(id);
    const context = await this.guard(resource),
      config = configuration[resource];
    const statement = `SELECT ${this.select(resource)} FROM app.${config.table} r WHERE r.tenant_id=$1 AND r.id=$2 AND ${this.visibility(resource)}`,
      params = [context.organizationId, id],
      before = (await this.client.query(statement, params)).rows,
      row = before[0];
    if (!row) missing();
    const result = config.mapper(row);
    validateSchema(config.schema, result, true);
    // SELECT-only privileges: the final successful exact source query is the read linearization point.
    // No resource SHARE lock, snapshot durability or stability beyond that point is claimed.
    this.assertProjectionUnchanged(resource, before, (await this.client.query(statement, params)).rows);
    await this.guard(resource);
    return result as SupportResourceEntity[R];
  }
  async list<R extends SupportResource>(
    resource: R,
    query: { readonly cursor?: string; readonly limit?: string; readonly filter?: string },
  ): Promise<SupportResourcePage[R]> {
    const context = await this.guard(resource),
      config = configuration[resource],
      limit = query.limit === undefined ? 25 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
    let filter: Schemas["LeadFilter"] = {};
    if (query.filter !== undefined) {
      try {
        filter = JSON.parse(query.filter);
      } catch {
        throw new AccessError(422, "filter_invalid", "Filter must be valid JSON.");
      }
      validateSchema("LeadFilter", filter);
    }
    const supported: Record<SupportResource, string[]> = {
      contacts: ["q", "ownerMemberId", "tagIds"],
      leads: ["q", "ownerMemberId", "stageId", "sourceId", "intent", "tagIds"],
      tasks: ["q", "ownerMemberId"],
      deals: ["q", "ownerMemberId", "stageId", "sourceId", "intent", "tagIds"],
      "pipeline-stages": ["q"],
      "lead-sources": ["q"],
      tags: ["q"],
    };
    if (
      Object.keys(filter).some(
        (key) => !supported[resource].includes(key) && !(key === "tagIds" && !filter.tagIds?.length),
      )
    )
      throw new AccessError(422, "filter_not_available", "This filter is not supported for this resource.");
    if (resource === "contacts" && filter.ownerMemberId)
      await this.access.assertCurrent(context, "crm.leads.read");
    if (filter.tagIds?.length) {
      await this.access.assertCurrent(context, "crm.tags.read");
      await this.access.assertCurrent(context, "crm.leads.read");
      await this.access.assertCurrent(context, "crm.contacts.read");
      if (new Set(filter.tagIds).size !== filter.tagIds.length)
        throw new AccessError(422, "tag_duplicate", "Each tag filter may appear once.");
      if (
        (
          await this.client.query("SELECT id FROM app.tag WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [
            context.organizationId,
            filter.tagIds,
          ])
        ).rowCount !== filter.tagIds.length
      )
        throw new AccessError(422, "tag_invalid", "Tag filters must belong to the selected organization.");
    }
    const snapshot =
      resource === "pipeline-stages"
        ? (
            await this.client.query(
              "SELECT id,position,row_version FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY id",
              [context.organizationId],
            )
          ).rows
        : null;
    const binding = createHash("sha256")
      .update(
        stable({
          organizationId: context.organizationId,
          principalId: context.staffPrincipalId,
          principalVersion: context.principalVersion,
          staffUserId: context.staffUserId,
          grantId: context.accessGrantId,
          grantVersion: context.grantVersion,
          permissions: context.permissionCodes,
          expiresAt: context.expiresAt,
          provenance: context.provenance,
          session: this.staff.sessionHash,
          resource,
          filter,
          sort: snapshot ? `position,id:${stable(snapshot)}` : "id:asc",
        }),
      )
      .digest("hex");
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    const params: unknown[] = [context.organizationId, cursor, limit + 1],
      where = ["r.tenant_id=$1", this.visibility(resource)];
    if (resource === "pipeline-stages") {
      const last = cursor ? snapshot!.find((row: Row) => row.id === cursor) : null;
      if (cursor && !last) throw new AccessError(422, "cursor_invalid", "Pagination boundary changed.");
      params.push(last?.position ?? -1);
      where.push("($2::uuid IS NULL OR(r.position,r.id)>($4::integer,$2::uuid))");
    } else where.push("($2::uuid IS NULL OR r.id>$2::uuid)");
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
      const needle = `$${params.length}`;
      where.push(
        resource === "leads"
          ? `EXISTS(SELECT 1 FROM app.contact c WHERE(c.tenant_id,c.id)=(r.tenant_id,r.contact_id)AND c.archived_at IS NULL AND c.display_name ILIKE ${needle} ESCAPE '\\')`
          : `r.${resource === "contacts" ? "display_name" : resource === "tasks" ? "title" : resource === "lead-sources" ? "label" : "name"} ILIKE ${needle} ESCAPE '\\'`,
      );
    }
    for (const [field, column] of [
      ["stageId", "stage_id"],
      ["sourceId", "source_id"],
      ["ownerMemberId", "owner_member_id"],
      ["intent", "intent"],
    ] as const)
      if (filter[field] && ["leads", "deals"].includes(resource)) {
        params.push(filter[field]);
        const expression = `l.${column}=$${params.length}`;
        where.push(
          resource === "leads"
            ? `r.${column}=$${params.length}`
            : `EXISTS(SELECT 1 FROM app.lead l WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id)AND ${expression})`,
        );
      }
    if (filter.ownerMemberId && resource === "tasks") {
      params.push(filter.ownerMemberId);
      where.push(`r.assignee_member_id=$${params.length}`);
    }
    if (filter.ownerMemberId && resource === "contacts") {
      params.push(filter.ownerMemberId);
      where.push(
        `((r.created_by_member_id=$${params.length} AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=r.tenant_id AND l.contact_id=r.id AND l.archived_at IS NULL))OR EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=r.tenant_id AND l.contact_id=r.id AND l.archived_at IS NULL AND l.owner_member_id=$${params.length}))`,
      );
    }
    if (filter.tagIds?.length) {
      params.push(filter.tagIds);
      const tags = `$${params.length}::uuid[]`;
      const tagged = `(SELECT count(*)FROM app.lead_tag lt WHERE lt.tenant_id=r.tenant_id AND lt.lead_id=l.id AND lt.tag_id=ANY(${tags}))=cardinality(${tags})`;
      where.push(
        resource === "contacts"
          ? `EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=r.tenant_id AND l.contact_id=r.id AND l.archived_at IS NULL AND ${tagged})`
          : resource === "leads"
            ? tagged.replaceAll("l.id", "r.id")
            : `EXISTS(SELECT 1 FROM app.lead l WHERE(l.tenant_id,l.id)=(r.tenant_id,r.lead_id)AND ${tagged})`,
      );
    }
    const statement = `SELECT ${this.select(resource)} FROM app.${config.table} r WHERE ${where.join(" AND ")} ORDER BY ${resource === "pipeline-stages" ? "r.position,r.id" : "r.id"} LIMIT $3`,
      found = (await this.client.query(statement, params)).rows;
    const rows = found.slice(0, limit),
      hasMore = found.length > limit;
    const result = {
      items: rows.map((row) => config.mapper(row)),
      hasMore,
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
    };
    validateSchema(config.page, result, true);
    this.assertProjectionUnchanged(resource, found, (await this.client.query(statement, params)).rows);
    if (snapshot) {
      const current = (
        await this.client.query(
          "SELECT id,position,row_version FROM app.pipeline_stage WHERE tenant_id=$1 ORDER BY id",
          [context.organizationId],
        )
      ).rows;
      if (stable(snapshot) !== stable(current))
        throw new AccessError(
          409,
          "support_source_changed",
          "Pipeline ordering changed during this read. Reload before retrying.",
        );
    }
    await this.guard(resource);
    return result as SupportResourcePage[R];
  }
}
