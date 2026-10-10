import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { assertUuid, CrmService, stable, requireVersion } from "./crm-service";
import { createHash } from "node:crypto";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";
import * as models from "./models";
import { validateSchema } from "./contract-validation";

type Schemas = components["schemas"];
type Resource = "pipeline-stages" | "lead-sources" | "tags";
type Row = Record<string, any>;
const configuration = {
  "pipeline-stages": { table: "pipeline_stage", domain: "pipeline", mapper: models.stage },
  "lead-sources": { table: "lead_source", domain: "sources", mapper: models.source },
  tags: {
    table: "tag",
    domain: "tags",
    mapper: (row: Row): Schemas["Tag"] => ({ id: row.id, name: row.name, version: Number(row.row_version) }),
  },
};
function text(value: string) {
  if (!value.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  return value.trim();
}
export class CrmConfigurationService {
  readonly foundation: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }
  private async row(resource: Resource, id: string, writing = false, lock = false) {
    assertUuid(id);
    const config = configuration[resource];
    requirePermission(this.context, `crm.${config.domain}.${writing ? "write" : "read"}`);
    const found = await this.client.query(
      `SELECT * FROM app.${config.table} WHERE tenant_id=app.current_tenant() AND id=$1 ${lock ? "FOR UPDATE" : ""}`,
      [id],
    );
    if (!found.rowCount)
      throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
    return found.rows[0];
  }
  async detail(resource: Resource, id: string) {
    return configuration[resource].mapper(await this.row(resource, id));
  }
  async list(resource: Resource, query: Record<string, unknown>) {
    const config = configuration[resource];
    const scope = requirePermission(this.context, `crm.${config.domain}.read`);
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
    if (Object.keys(filter).some((key) => key !== "q" && !(key === "tagIds" && !filter.tagIds?.length)))
      throw new AccessError(
        422,
        "filter_not_available",
        "This filter is not supported for CRM configuration.",
      );
    // Stage pagination is invalidated by every stage revision, including changes away from the boundary.
    const stageSnapshot =
      resource === "pipeline-stages"
        ? await this.client.query(
            "SELECT id,position,row_version FROM app.pipeline_stage WHERE tenant_id=app.current_tenant() ORDER BY id",
          )
        : null;
    const stageRevision = stageSnapshot
      ? createHash("sha256").update(stable(stageSnapshot.rows)).digest("hex")
      : "";
    const binding = cursorBinding(
      this.context,
      resource,
      scope,
      filter,
      resource === "pipeline-stages" ? `position:asc,id:asc:${stageRevision}` : "id:asc",
    );
    const cursor = decodeCursor(query.cursor, binding);
    if (cursor) assertUuid(cursor);
    let position = -1;
    if (resource === "pipeline-stages" && cursor) {
      const last = await this.row(resource, cursor);
      position = last.position;
    }
    const params: unknown[] = [cursor, limit + 1];
    const boundary =
      resource === "pipeline-stages"
        ? "($1::uuid IS NULL OR (position,id)>($3::integer,$1::uuid))"
        : "($1::uuid IS NULL OR id>$1::uuid)";
    if (resource === "pipeline-stages") params.push(position);
    const where = ["tenant_id=app.current_tenant()", boundary];
    if (filter.q) {
      params.push(`%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`${resource === "lead-sources" ? "label" : "name"} ILIKE $${params.length} ESCAPE '\\'`);
    }
    const found = await this.client.query(
      `SELECT * FROM app.${config.table} WHERE ${where.join(" AND ")} ORDER BY ${resource === "pipeline-stages" ? "position,id" : "id"} LIMIT $2`,
      params,
    );
    const rows = found.rows.slice(0, limit);
    const hasMore = found.rows.length > limit;
    return {
      items: rows.map((row) => config.mapper(row)),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
  async write(
    resource: Resource,
    body: Schemas["StageWrite"] | Schemas["LeadSourceWrite"] | Schemas["TagWrite"],
    id?: string,
    expected?: string,
  ) {
    const config = configuration[resource];
    requirePermission(this.context, `crm.${config.domain}.write`);
    if (resource === "pipeline-stages")
      await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${this.context.organizationId}:pipeline-configuration`,
      ]);
    const current = id ? await this.row(resource, id, true, true) : null;
    if (current) requireVersion(current, expected);
    let result;
    if (resource === "pipeline-stages") {
      const stage = body as Schemas["StageWrite"];
      result = id
        ? await this.client.query(
            `UPDATE app.pipeline_stage SET name=$1,position=$2,terminal=$3,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$4 RETURNING *`,
            [text(stage.name), stage.position, stage.terminal, id],
          )
        : await this.client.query(
            `INSERT INTO app.pipeline_stage(tenant_id,name,position,terminal)VALUES($1,$2,$3,$4)RETURNING *`,
            [this.context.organizationId, text(stage.name), stage.position, stage.terminal],
          );
    } else if (resource === "lead-sources") {
      const source = body as Schemas["LeadSourceWrite"];
      if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(source.code))
        throw new AccessError(
          422,
          "source_code_invalid",
          "Source code requires lowercase letters, digits, dots, underscores or hyphens.",
        );
      if (current && current.code !== source.code)
        throw new AccessError(
          422,
          "source_code_immutable",
          "Source codes preserve attribution and cannot be changed.",
        );
      result = id
        ? await this.client.query(
            `UPDATE app.lead_source SET label=$1,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$2 RETURNING *`,
            [text(source.label), id],
          )
        : await this.client.query(
            `INSERT INTO app.lead_source(tenant_id,code,label)VALUES($1,$2,$3)RETURNING *`,
            [this.context.organizationId, source.code, text(source.label)],
          );
    } else {
      const tag = body as Schemas["TagWrite"];
      result = id
        ? await this.client.query(
            `UPDATE app.tag SET name=$1,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$2 RETURNING *`,
            [text(tag.name), id],
          )
        : await this.client.query(`INSERT INTO app.tag(tenant_id,name)VALUES($1,$2)RETURNING *`, [
            this.context.organizationId,
            text(tag.name),
          ]);
    }
    const row = result.rows[0];
    await this.foundation.audit(
      `${config.table}.${id ? "updated" : "created"}`,
      config.table,
      row.id,
      Number(row.row_version),
    );
    return { body: config.mapper(row), status: id ? 200 : 201, etag: `"${row.row_version}"` };
  }
  async replaceLeadTags(id: string, body: Schemas["LeadTagsWrite"], expected: string | undefined) {
    requirePermission(this.context, "crm.tags.read");
    const lead = await this.foundation.row("leads", id, true, true);
    requireVersion(lead, expected);
    if (new Set(body.tagIds).size !== body.tagIds.length)
      throw new AccessError(422, "tag_duplicate", "Each tag may appear once.");
    if (body.tagIds.length) {
      const tags = await this.client.query(
        "SELECT id FROM app.tag WHERE tenant_id=app.current_tenant() AND id=ANY($1::uuid[])",
        [body.tagIds],
      );
      if (tags.rowCount !== body.tagIds.length)
        throw new AccessError(422, "tag_invalid", "Every tag must belong to this organization.");
    }
    await this.client.query("DELETE FROM app.lead_tag WHERE tenant_id=app.current_tenant() AND lead_id=$1", [
      id,
    ]);
    for (const tagId of body.tagIds)
      await this.client.query("INSERT INTO app.lead_tag(tenant_id,lead_id,tag_id)VALUES($1,$2,$3)", [
        this.context.organizationId,
        id,
        tagId,
      ]);
    const updated = await this.client.query(
      "UPDATE app.lead SET row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$1 RETURNING *",
      [id],
    );
    await this.foundation.audit("lead.tags_replaced", "lead", id, Number(updated.rows[0].row_version));
    return { body: models.lead(updated.rows[0]), status: 200, etag: `"${updated.rows[0].row_version}"` };
  }
}
