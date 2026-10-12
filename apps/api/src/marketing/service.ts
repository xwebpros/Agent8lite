import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../../packages/auth/entitlements";
import {
  AccessError,
  requirePermission,
  type TenantContext,
} from "../../../../packages/db/tenant-transaction";
import { validateSchema } from "../contract-validation";
import { assertUuid, CrmService, stable } from "../crm-service";
import { jobModel } from "../admin-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../cursors";
import { appendCampaignDraftEvent } from "./events";
import {
  type Campaign,
  type CampaignCommandHeaders,
  type CampaignPage,
  type CampaignQuery,
  type CampaignWrite,
  campaignInput,
  campaignKey,
  campaignPagination,
  campaignRevision,
} from "./input";
import { campaignEtag, campaignModel } from "./model";
import { CampaignDraftRepository } from "./repository";

type Permission = "campaigns.read" | "campaigns.write";
export type CampaignMutation = { body: Campaign; status: 200 | 201; etag: string };
export type CampaignArchiveMutation = { body: Schemas["Job"]; status: 202; etag: string };
type Schemas = import("../../../../packages/contracts/generated/api").components["schemas"];
type ReceiptRow = {
  request_hash: string;
  response_body: unknown;
  status_code: number;
  response_etag: string;
};

function unavailable(): never {
  throw new AccessError(404, "resource_unavailable", "Campaign unavailable or out of scope.");
}

/**
 * Construct only inside withTenantTransaction using the same client and verified
 * context. The caller owns commit/rollback and session/CSRF/rate safeguards.
 * This service neither begins a transaction nor creates versions or sends work.
 */
export class CampaignDraftService {
  private readonly repository: CampaignDraftRepository;
  private readonly audit: CrmService;

  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    private readonly traceId: string,
  ) {
    this.repository = new CampaignDraftRepository(client);
    this.audit = new CrmService(client, context, traceId);
  }

  private async authorize(permission: Permission) {
    if (requirePermission(this.context, permission) !== "organization")
      throw new AccessError(403, "permission_denied", "Organization campaign scope is required.");
    // Recomputed authority prevents a forged/stale typed permission list from
    // becoming evidence. withTenantTransaction holds these source rows SHARE.
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
      throw new AccessError(403, "permission_denied", "Current campaign authority is unavailable.");
    await requireEntitlement(this.client, permission);
    // A WHERE clock predicate can be evaluated before a row-lock wait. Passing
    // clock time is not protected by SHARE; always check again after acquisition.
    await requireEntitlement(this.client, permission, { lock: false });
  }

  private async draft(id: string, lock: "read" | "write" = "read") {
    assertUuid(id);
    const row = await this.repository.draft(id, lock);
    if (!row) unavailable();
    return row;
  }

  async get(id: string): Promise<Campaign> {
    await this.authorize("campaigns.read");
    const body = campaignModel(await this.draft(id));
    await this.authorize("campaigns.read");
    return body;
  }

  async list(query: CampaignQuery = {}): Promise<CampaignPage> {
    await this.authorize("campaigns.read");
    const page = campaignPagination(query);
    const binding = cursorBinding(this.context, "marketing:campaign-drafts", "organization", {
      state: "draft",
      limit: page.limit,
    });
    const after = decodeCursor(page.cursor, binding);
    if (after) assertUuid(after);
    const rows = await this.repository.list(after, page.limit + 1);
    const items = rows.slice(0, page.limit).map(campaignModel);
    const hasMore = rows.length > page.limit;
    const body: CampaignPage = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
    validateSchema("PageCampaign", body, true);
    await this.authorize("campaigns.read");
    return body;
  }

  private async idempotent(
    route: string,
    rawBody: CampaignWrite,
    headers: CampaignCommandHeaders,
    status: 200 | 201,
    command: () => Promise<Campaign>,
    expectedId?: string,
  ): Promise<CampaignMutation> {
    const key = campaignKey(headers.key);
    const requestHash = createHash("sha256")
      .update(stable({ body: rawBody, ifMatch: headers.ifMatch ?? null }))
      .digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("campaigns.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Campaign", receipt.response_body, true);
      const historical = receipt.response_body as Campaign;
      if (
        receipt.status_code !== status ||
        historical.state !== "draft" ||
        (expectedId && historical.id !== expectedId) ||
        receipt.response_etag !== campaignEtag(historical.version)
      )
        throw new AccessError(
          503,
          "replay_metadata_unavailable",
          "Historical campaign metadata is unavailable.",
        );
      await this.draft(historical.id);
      await this.authorize("campaigns.write");
      return { body: historical, status, etag: receipt.response_etag };
    }
    const body = await command();
    const etag = campaignEtag(body.version);
    await this.authorize("campaigns.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,$6,$7,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(body), status, etag],
    );
    await this.authorize("campaigns.write");
    return { body, status, etag };
  }

  /** ADR-059: archive a campaign (any non-archived state). Returns 202 Job. Idempotent. */
  async archive(id: string, headers: CampaignCommandHeaders): Promise<CampaignArchiveMutation> {
    assertUuid(id);
    await this.authorize("campaigns.write");
    const key = campaignKey(headers.key);
    const route = `marketing:campaign:archive:${id}`;
    const requestHash = createHash("sha256").update(id).digest("hex");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authorize("campaigns.write");
    const existing = await this.client.query<ReceiptRow>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
       WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      validateSchema("Job", receipt.response_body, true);
      await this.authorize("campaigns.write");
      return { body: receipt.response_body as Schemas["Job"], status: 202, etag: receipt.response_etag };
    }
    const archived = await this.client.query(`SELECT * FROM app.archive_campaign($1)`, [id]);
    if (!archived.rowCount || !archived.rows[0]?.id)
      throw new AccessError(404, "resource_unavailable", "Campaign unavailable or already archived.");
    const row = archived.rows[0];
    const etag = campaignEtag(Number(row.row_version));
    const jobRow = await this.client.query(
      `INSERT INTO app.integration_job(tenant_id,kind,state,requesting_member_id)
       VALUES(app.current_tenant(),'marketing.campaign.archived','succeeded',$1) RETURNING *`,
      [this.context.memberId],
    );
    const job = jobModel(jobRow.rows[0]);
    validateSchema("Job", job, true);
    await this.audit.audit("campaign.archived", "campaign", id, Number(row.row_version));
    await this.authorize("campaigns.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
       (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,202,$6,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, JSON.stringify(job), etag],
    );
    await this.authorize("campaigns.write");
    return { body: job, status: 202, etag };
  }

  async create(body: CampaignWrite, headers: CampaignCommandHeaders): Promise<CampaignMutation> {
    await this.authorize("campaigns.write");
    const input = campaignInput(body);
    return this.idempotent("marketing:draft:create", body, headers, 201, async () => {
      const created = campaignModel(await this.repository.create(input));
      await this.audit.audit("campaign.draft_created", "campaign", created.id, created.version);
      await appendCampaignDraftEvent(this.client, this.context, this.traceId, created, "create");
      return created;
    });
  }

  async update(id: string, body: CampaignWrite, headers: CampaignCommandHeaders): Promise<CampaignMutation> {
    assertUuid(id);
    await this.authorize("campaigns.write");
    const input = campaignInput(body);
    const expected = campaignRevision(headers.ifMatch);
    return this.idempotent(
      `marketing:draft:update:${id}`,
      body,
      headers,
      200,
      async () => {
        const current = campaignModel(await this.draft(id, "write"));
        await this.authorize("campaigns.write");
        if (current.version !== expected)
          throw new AccessError(412, "revision_stale", "Campaign changed; refresh before updating.");
        if (current.version >= Number.MAX_SAFE_INTEGER)
          throw new AccessError(409, "campaign_revision_exhausted", "Campaign revision cannot be advanced.");
        const changed = await this.repository.update(id, expected, input);
        if (!changed)
          throw new AccessError(412, "revision_stale", "Campaign changed; refresh before updating.");
        const updated = campaignModel(changed);
        await this.audit.audit("campaign.draft_updated", "campaign", updated.id, updated.version);
        await appendCampaignDraftEvent(this.client, this.context, this.traceId, updated, "update");
        return updated;
      },
      id,
    );
  }
}
