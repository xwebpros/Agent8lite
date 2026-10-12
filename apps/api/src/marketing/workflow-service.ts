import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import { validateWorkflowDefinition, type WorkflowDefinition } from "../../../../packages/marketing";
import { validateSchema } from "../contract-validation";
import { assertUuid, CrmService } from "../crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../cursors";
import { campaignEtag } from "./model";
import { campaignKey, campaignPagination, type CampaignQuery } from "./input";
import { WorkflowAuthority } from "./workflow-authority";
import { WorkflowCommandError } from "./workflow-errors";
import { appendCampaignWorkflowEvent } from "./workflow-events";
import { WorkflowSources } from "./workflow-sources";
import { workflowJson, workflowSnapshot } from "./workflow-json";

export { WorkflowCommandError } from "./workflow-errors";
export type CampaignWorkflowVersion = components["schemas"]["CampaignVersion"];
export type CampaignWorkflowPage = components["schemas"]["PageCampaignVersion"];
export type CampaignWorkflowMutation = { body: CampaignWorkflowVersion; status: 201; etag: string };
type VersionRow = {
  id: string;
  campaign_id: string;
  version: number;
  state: "draft" | "published";
  definition: WorkflowDefinition;
};
type Receipt = {
  request_hash: string;
  response_body: CampaignWorkflowVersion;
  status_code: number;
  response_etag: string;
};
const unavailable = (): never => {
  throw new AccessError(404, "resource_unavailable", "Workflow unavailable or out of scope.");
};

function definition(value: WorkflowDefinition): WorkflowDefinition {
  const snapshot = workflowSnapshot(value);
  validateSchema("CampaignVersionWrite", snapshot);
  if (Buffer.byteLength(workflowJson(snapshot), "utf8") > 262144)
    throw new WorkflowCommandError(422, "workflow_size_exceeded", "Workflow definition is too large.", [
      { field: "definition", message: "Workflow definition must not exceed 256 KiB." },
    ]);
  const issues = validateWorkflowDefinition(snapshot);
  if (issues.length)
    throw new WorkflowCommandError(422, "workflow_invalid", "Workflow definition is invalid.", issues);
  return snapshot;
}

function model(row: VersionRow): CampaignWorkflowVersion {
  const result: CampaignWorkflowVersion = {
    id: row.id,
    campaignId: row.campaign_id,
    version: Number(row.version),
    state: row.state,
    definition: definition(row.definition),
  };
  validateSchema("CampaignVersion", result, true);
  if (result.state !== "draft" || !Number.isInteger(result.version) || result.version > 2147483647)
    throw new AccessError(503, "workflow_revision_unavailable", "Workflow revision is unavailable.");
  return Object.freeze(result);
}

function publishedModel(row: VersionRow): CampaignWorkflowVersion {
  const result: CampaignWorkflowVersion = {
    id: row.id,
    campaignId: row.campaign_id,
    version: Number(row.version),
    state: row.state,
    definition: definition(row.definition),
  };
  validateSchema("CampaignVersion", result, true);
  if (result.state !== "published" || !Number.isInteger(result.version) || result.version > 2147483647)
    throw new AccessError(503, "workflow_revision_unavailable", "Published workflow version is unavailable.");
  return Object.freeze(result);
}

/** Immutable drafts; constructed inside caller-owned withTenantTransaction, never opens/commits a transaction. */
export class CampaignWorkflowService {
  private readonly authority: WorkflowAuthority;
  private readonly sources: WorkflowSources;
  private readonly audit: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    private readonly traceId: string,
  ) {
    this.authority = new WorkflowAuthority(client, context);
    this.sources = new WorkflowSources(client, this.authority);
    this.audit = new CrmService(client, context, traceId);
  }

  private async parent(id: string, writing = false) {
    assertUuid(id);
    const result = await this.client.query(
      `SELECT id FROM app.campaign
      WHERE tenant_id=app.current_tenant() AND id=$1 AND state='draft' ${writing ? "FOR UPDATE" : "FOR SHARE"}`,
      [id],
    );
    if (!result.rowCount) unavailable();
  }

  private async version(id: string): Promise<CampaignWorkflowVersion> {
    assertUuid(id);
    const result = await this.client.query<VersionRow>(
      `SELECT id,campaign_id,version,state,definition
      FROM app.campaign_version WHERE tenant_id=app.current_tenant() AND id=$1 AND state='draft' AND published_at IS NULL`,
      [id],
    );
    if (!result.rowCount) unavailable();
    const version = model(result.rows[0]);
    await this.parent(version.campaignId);
    return version;
  }

  async get(id: string): Promise<CampaignWorkflowVersion> {
    await this.authority.require("campaigns.read");
    const version = await this.version(id);
    await this.sources.assertCurrent(version.definition);
    await this.authority.require("campaigns.read");
    return version;
  }

  async list(campaignId: string, query: CampaignQuery = {}): Promise<CampaignWorkflowPage> {
    await this.authority.require("campaigns.read");
    await this.parent(campaignId);
    const page = campaignPagination(query);
    const binding = cursorBinding(this.context, "marketing:workflow-drafts", "organization", {
      campaignId,
      limit: page.limit,
    });
    const after = decodeCursor(page.cursor, binding);
    if (after) assertUuid(after);
    // Definitions are large; a response is an upper-bounded page, never a truncated object.
    const result = await this.client.query<VersionRow>(
      `SELECT id,campaign_id,version,state,definition FROM app.campaign_version
      WHERE tenant_id=app.current_tenant() AND campaign_id=$1 AND state='draft' AND published_at IS NULL
      AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,
      [campaignId, after, Math.min(page.limit, 5) + 1],
    );
    const items: CampaignWorkflowVersion[] = [];
    // Count each complete entity before adding it, so an oversized candidate
    // page never crosses the serializer limit. Reserve 8,576 bytes for the
    // Page envelope and signed cursor within the 1 MiB transport bound.
    let itemBytes = 2;
    for (const row of result.rows.slice(0, Math.min(page.limit, 5))) {
      const version = model(row);
      const addition = Buffer.byteLength(workflowJson(version), "utf8") + (items.length ? 1 : 0);
      if (itemBytes + addition > 1040000) break;
      await this.sources.assertCurrent(version.definition);
      items.push(version);
      itemBytes += addition;
    }
    const hasMore = result.rows.length > items.length;
    const body: CampaignWorkflowPage = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
    validateSchema("PageCampaignVersion", body, true);
    await this.authority.require("campaigns.read");
    return body;
  }

  async create(
    campaignId: string,
    body: WorkflowDefinition,
    headers: { key: string | undefined },
  ): Promise<CampaignWorkflowMutation> {
    assertUuid(campaignId);
    const input = definition(body),
      key = campaignKey(headers.key),
      route = `marketing:workflow:create:${campaignId}`;
    const inputText = workflowJson(input);
    const requestHash = createHash("sha256").update(inputText).digest("hex");
    await this.authority.require("campaigns.write");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authority.require("campaigns.write");
    await this.parent(campaignId, true);
    await this.authority.require("campaigns.write");
    const existing = await this.client.query<Receipt>(
      `SELECT request_hash,response_body,status_code,response_etag
      FROM app.idempotency_record WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("CampaignVersion", receipt.response_body, true);
      const current = await this.version(receipt.response_body.id);
      if (
        receipt.status_code !== 201 ||
        receipt.response_body.campaignId !== campaignId ||
        receipt.response_etag !== campaignEtag(receipt.response_body.version) ||
        workflowJson(current) !== workflowJson(receipt.response_body)
      )
        throw new AccessError(
          503,
          "replay_metadata_unavailable",
          "Historical workflow receipt is unavailable.",
        );
      await this.sources.assertCurrent(current.definition);
      await this.authority.require("campaigns.write");
      return { body: current, status: 201, etag: receipt.response_etag };
    }
    await this.sources.assertCurrent(input);
    await this.authority.require("campaigns.write");
    // Reviewed allocator trigger assigns the next ordinal across all historical
    // states without granting access to published definitions. Never use an
    // RLS-filtered MAX(version) to infer a globally unique workflow sequence.
    let created;
    try {
      created = await this.client.query<VersionRow>(
        `INSERT INTO app.campaign_version(tenant_id,campaign_id,version,definition,state)
        VALUES(app.current_tenant(),$1,1,$2,'draft') RETURNING id,campaign_id,version,state,definition`,
        [campaignId, inputText],
      );
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        "constraint" in error &&
        error.code === "23514" &&
        error.constraint === "native_workflow_sequence_available"
      )
        throw new AccessError(409, "workflow_version_exhausted", "Workflow version sequence is exhausted.");
      throw error;
    }
    const version = model(created.rows[0]),
      etag = campaignEtag(version.version);
    await this.audit.audit(
      "campaign.workflow_draft_created",
      "campaign_version",
      version.id,
      version.version,
    );
    await appendCampaignWorkflowEvent(this.client, this.context, this.traceId, version);
    await this.sources.assertCurrent(version.definition);
    await this.authority.require("campaigns.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
      (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
      VALUES(app.current_tenant(),$1,$2,$3,$4,$5,201,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, workflowJson(version), etag],
    );
    await this.authority.require("campaigns.write");
    return { body: version, status: 201, etag };
  }

  /** ADR-059: publish a draft campaign version, activating its parent campaign. Idempotent. */
  async publish(versionId: string, headers: { key: string | undefined }): Promise<CampaignWorkflowMutation> {
    assertUuid(versionId);
    const key = campaignKey(headers.key);
    const route = `marketing:workflow:publish:${versionId}`;
    const requestHash = createHash("sha256").update(versionId).digest("hex");
    await this.authority.require("campaigns.publish");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authority.require("campaigns.publish");
    const existing = await this.client.query<Receipt>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("CampaignVersion", receipt.response_body, true);
      await this.authority.require("campaigns.publish");
      return {
        body: receipt.response_body as CampaignWorkflowVersion,
        status: 201,
        etag: receipt.response_etag,
      };
    }
    const draft = await this.version(versionId).catch(async () => {
      // RLS filters published versions from estate_runtime — check the idempotency log
      // to distinguish "already published" (lifecycle conflict) from "never existed" (404).
      const prior = await this.client.query(
        `SELECT 1 FROM app.idempotency_record
         WHERE tenant_id=app.current_tenant() AND route_key=$1 LIMIT 1`,
        [`marketing:workflow:publish:${versionId}`],
      );
      if (prior.rowCount)
        throw new AccessError(409, "campaign_lifecycle_conflict", "Campaign version is already published.");
      unavailable();
    });
    const result = await this.client.query<VersionRow>(
      `SELECT id,campaign_id,version::int AS version,state,definition
       FROM app.publish_campaign_version($1,$2)`,
      [versionId, draft!.campaignId],
    );
    if (!result.rowCount)
      throw new AccessError(
        409,
        "campaign_lifecycle_conflict",
        "Campaign version is already published or the campaign is not in draft state.",
      );
    const published = publishedModel(result.rows[0]);
    const etag = campaignEtag(published.version);
    await this.audit.audit(
      "campaign.workflow_published",
      "campaign_version",
      published.id,
      published.version,
    );
    await this.authority.require("campaigns.publish");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,201,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, workflowJson(published), etag],
    );
    await this.authority.require("campaigns.publish");
    return { body: published, status: 201, etag };
  }
}
