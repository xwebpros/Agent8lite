import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import nativeDesignSchema from "../../../../packages/contracts/internal/native-message-text-design-v1.schema.json";
import type { WorkflowDefinition } from "../../../../packages/marketing";
import { WorkflowAuthority } from "./workflow-authority";
import { workflowReference } from "./workflow-errors";
import { workflowJson } from "./workflow-json";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validDesign = ajv.compile(nativeDesignSchema);
type Source = { id: string; field: string };
type DesignRow = {
  id: string;
  channel: string;
  editor_kind: string;
  name: string;
  version: number;
  row_version: string;
  design: unknown;
  rendered_content: string;
  content_hash: string;
};
const bytes = (value: unknown) => Buffer.byteLength(workflowJson(value), "utf8");
const staticText = (value: unknown): value is string =>
  typeof value === "string" &&
  !!value.trim() &&
  [...value].length <= 100000 &&
  !/[<>]|\{\{|\$\{|[\x00-\x08\x0b-\x1f\x7f]|(?:javascript|data|https?|ftp):|www\./i.test(value);

/** CRM reads are source locks only; no CRM or message-design table writes. */
export class WorkflowSources {
  constructor(
    private readonly client: PoolClient,
    private readonly authority: WorkflowAuthority,
  ) {}

  private async sources(table: "membership" | "pipeline_stage" | "lead_source" | "tag", refs: Source[]) {
    if (!refs.length) return;
    const ids = [...new Set(refs.map((ref) => ref.id.toLowerCase()))].sort();
    const query = `SELECT id FROM app.${table} WHERE tenant_id=app.current_tenant()
      AND id=ANY($1::uuid[]) ${table === "membership" ? "AND status='active'" : ""}`;
    await this.client.query(`${query} ORDER BY id FOR SHARE`, [ids]);
    // Reevaluate predicates after locks, including a membership status changed while waiting.
    const current = await this.client.query<{ id: string }>(`${query} ORDER BY id`, [ids]);
    const found = new Set(current.rows.map((row) => row.id));
    for (const ref of refs) if (!found.has(ref.id.toLowerCase())) workflowReference(ref.field);
  }

  async assertCurrent(definition: WorkflowDefinition) {
    const owner: Source[] = [],
      stage: Source[] = [],
      source: Source[] = [],
      tags: Source[] = [];
    const designs: { id: string; channel: "email" | "sms"; field: string }[] = [];
    definition.nodes.forEach((node, index) => {
      const path = `nodes.${index}`;
      if (node.kind === "email" || node.kind === "sms")
        designs.push({ id: node.messageDesignId!, channel: node.kind, field: `${path}.messageDesignId` });
      if (node.kind !== "condition") return;
      const filter = node.condition!;
      if (filter.ownerMemberId)
        owner.push({ id: filter.ownerMemberId, field: `${path}.condition.ownerMemberId` });
      if (filter.stageId) stage.push({ id: filter.stageId, field: `${path}.condition.stageId` });
      if (filter.sourceId) source.push({ id: filter.sourceId, field: `${path}.condition.sourceId` });
      for (const [tagIndex, id] of (filter.tagIds ?? []).entries())
        tags.push({ id, field: `${path}.condition.tagIds.${tagIndex}` });
    });
    if (definition.nodes.some((node) => node.kind === "condition")) {
      await this.authority.require("crm.leads.read");
      if (owner.length) await this.authority.require("members.read");
      if (stage.length) await this.authority.require("crm.pipeline.read");
      if (source.length) await this.authority.require("crm.sources.read");
      if (tags.length) await this.authority.require("crm.tags.read");
      await this.sources("membership", owner);
      await this.sources("pipeline_stage", stage);
      await this.sources("lead_source", source);
      await this.sources("tag", tags);
      await this.authority.require("crm.leads.read");
    }
    if (!designs.length) return;
    await this.authority.require("campaigns.read");
    const ids = [...new Set(designs.map((ref) => ref.id.toLowerCase()))].sort();
    const result = await this.client.query<DesignRow>(
      `SELECT id,channel,editor_kind,name,version,row_version,design,rendered_content,content_hash
       FROM app.message_design WHERE tenant_id=app.current_tenant() AND id=ANY($1::uuid[])
       ORDER BY id FOR SHARE`,
      [ids],
    );
    const rows = new Map(result.rows.map((row) => [row.id, row]));
    for (const ref of designs) {
      const row = rows.get(ref.id.toLowerCase());
      if (!row || row.channel !== ref.channel) workflowReference(ref.field);
      if (row.editor_kind !== "native") workflowReference(ref.field, "editor_unavailable");
      if (
        !Number.isSafeInteger(row.version) ||
        row.version < 1 ||
        !Number.isSafeInteger(Number(row.row_version)) ||
        Number(row.row_version) < 1 ||
        !row.name?.trim() ||
        [...row.name].length > 120 ||
        !validDesign(row.design) ||
        bytes(row.design) > 262144 ||
        !staticText(row.rendered_content)
      )
        workflowReference(ref.field, "design_unavailable");
      // The reviewed schema establishes the exact closed static text format.
      const native = row.design as { schemaVersion: 1; blocks: { type: "text"; text: string }[] };
      if (
        native.blocks.some((block) => !staticText(block.text)) ||
        native.blocks.map((block) => block.text).join("\n") !== row.rendered_content ||
        !/^[a-f0-9]{64}$/.test(row.content_hash) ||
        createHash("sha256").update(row.rendered_content, "utf8").digest("hex") !== row.content_hash
      )
        workflowReference(ref.field, "design_unavailable");
    }
    await this.authority.require("campaigns.read");
  }
}
