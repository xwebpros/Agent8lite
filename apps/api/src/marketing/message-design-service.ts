import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import type { PreparedNativeMessageDesign } from "../../../../packages/marketing/native-design";
import { validateSchema } from "../contract-validation";
import { assertUuid, CrmService } from "../crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "../cursors";
import { campaignKey, campaignPagination, campaignRevision, type CampaignQuery } from "./input";
import {
  MessageDesignCommandError,
  messageDesignStorageError,
  prepareMessageDesignCommand,
} from "./message-design-errors";
import { appendMessageDesignDraftEvent } from "./message-design-events";
import {
  type MessageDesign,
  type MessageDesignMutation,
  type MessageDesignPage,
  type MessageDesignRow,
  type MessageDesignWrite,
  messageDesignEtag,
  messageDesignModel,
  messageDesignReceipt,
} from "./message-design-model";
import { WorkflowAuthority } from "./workflow-authority";
import { workflowJson } from "./workflow-json";

export { MessageDesignCommandError } from "./message-design-errors";
export type {
  MessageDesign,
  MessageDesignMutation,
  MessageDesignPage,
  MessageDesignWrite,
} from "./message-design-model";
type Permission = "campaigns.read" | "campaigns.write";
type Receipt = {
  request_hash: string;
  response_body: unknown;
  status_code: number;
  response_etag: string;
};
const unavailable = (): never => {
  throw new AccessError(404, "resource_unavailable", "Message design unavailable or out of scope.");
};
const stale = (): never => {
  throw new AccessError(412, "revision_stale", "Message design changed; refresh before updating.");
};

/**
 * Only native static drafts. Construct inside the caller's verified tenant
 * transaction; the caller owns commit/rollback and HTTP session/CSRF guards.
 * No lifecycle, rendering, workflow execution, delivery or provider effects.
 */
export class MessageDesignDraftService {
  private readonly authority: WorkflowAuthority;
  private readonly audit: CrmService;

  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    private readonly traceId: string,
  ) {
    this.authority = new WorkflowAuthority(client, context);
    this.audit = new CrmService(client, context, traceId);
  }

  private async current(id: string, permission: Permission, lock: "read" | "write" = "read") {
    const locked = await this.client.query(
      `SELECT d.id FROM app.message_design d
      WHERE d.tenant_id=app.current_tenant() AND d.id=$1 AND d.availability_state='draft'
      AND d.history_ready AND d.editor_kind='native' ${lock === "write" ? "FOR UPDATE OF d" : "FOR SHARE OF d"}`,
      [id],
    );
    if (!locked.rowCount) unavailable();
    // Clock predicates can be evaluated before a lock wait on an unchanged
    // tuple. Reauthorize and reload the actual source after acquiring its lock.
    await this.authority.require(permission);
    const result = await this.client.query<MessageDesignRow>(
      `SELECT d.id,d.name,d.channel,d.subject,d.editor_kind,d.design,d.rendered_content,d.content_hash,
      d.version,d.row_version,d.availability_state,d.history_ready,
      r.version AS revision_version,r.content_hash AS revision_hash,r.source_row_version AS revision_row_version
      FROM app.message_design d LEFT JOIN app.message_design_revision r
      ON (r.tenant_id,r.message_design_id,r.version)=(d.tenant_id,d.id,d.version)
      WHERE d.tenant_id=app.current_tenant() AND d.id=$1 AND d.availability_state='draft'
      AND d.history_ready AND d.editor_kind='native'`,
      [id],
    );
    if (!result.rowCount) unavailable();
    const row = result.rows[0];
    return { row, body: messageDesignModel(row) };
  }

  async get(id: string): Promise<MessageDesign> {
    assertUuid(id);
    await this.authority.require("campaigns.read");
    const { body } = await this.current(id.toLowerCase(), "campaigns.read");
    await this.authority.require("campaigns.read");
    return body;
  }

  async list(query: CampaignQuery = {}): Promise<MessageDesignPage> {
    const page = campaignPagination(query);
    await this.authority.require("campaigns.read");
    const binding = cursorBinding(this.context, "marketing:native-message-designs", "organization", {
      limit: page.limit,
      editor: "native",
      availability: "draft",
      history: "proven",
    });
    const after = decodeCursor(page.cursor, binding);
    if (after) assertUuid(after);
    const result = await this.client.query<{ id: string }>(
      `SELECT d.id FROM app.message_design d WHERE d.tenant_id=app.current_tenant()
      AND d.availability_state='draft' AND d.history_ready AND d.editor_kind='native'
      AND ($1::uuid IS NULL OR d.id>$1) ORDER BY d.id LIMIT $2 FOR SHARE OF d`,
      [after, Math.min(page.limit, 5) + 1],
    );
    await this.authority.require("campaigns.read");
    const items: MessageDesign[] = [];
    let itemBytes = 2;
    for (const row of result.rows.slice(0, Math.min(page.limit, 5))) {
      const { body } = await this.current(row.id, "campaigns.read");
      const addition = Buffer.byteLength(workflowJson(body), "utf8") + (items.length ? 1 : 0);
      // Whole entities only; reserve 8,576 bytes for Page fields and cursor.
      if (itemBytes + addition > 1040000) break;
      items.push(body);
      itemBytes += addition;
    }
    const hasMore = result.rows.length > items.length;
    if (hasMore && !items.length)
      throw new AccessError(
        503,
        "design_source_unavailable",
        "Current design exceeds the private response bound.",
      );
    const body: MessageDesignPage = {
      items,
      hasMore,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
    };
    validateSchema("PageMessageDesign", body, true);
    await this.authority.require("campaigns.read");
    return body;
  }

  private async command(
    route: string,
    prepared: PreparedNativeMessageDesign,
    key: string,
    ifMatch: string | null,
    status: 200 | 201,
    mutation: () => Promise<MessageDesign>,
    expectedId?: string,
  ): Promise<MessageDesignMutation> {
    // Canonical own-data preparation and original scalar headers are captured
    // before the first wait; never reserialize caller input after acquiring locks.
    const requestHash = createHash("sha256")
      .update(`{"body":${prepared.canonicalBody},"ifMatch":${JSON.stringify(ifMatch)}}`)
      .digest("hex");
    await this.authority.require("campaigns.write");
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${route}:${key}`,
    ]);
    await this.authority.require("campaigns.write");
    const existing = await this.client.query<Receipt>(
      `SELECT request_hash,response_body,status_code,response_etag FROM app.idempotency_record
      WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
      [this.context.userId, route, key],
    );
    if (existing.rowCount) {
      const receipt = existing.rows[0];
      if (receipt.request_hash !== requestHash)
        throw new AccessError(409, "idempotency_conflict", "The command key was used with different input.");
      const historical = messageDesignReceipt(receipt.response_body);
      if (
        receipt.status_code !== status ||
        (expectedId && historical.id.toLowerCase() !== expectedId) ||
        receipt.response_etag !== messageDesignEtag(historical.version)
      )
        throw new AccessError(
          503,
          "replay_metadata_unavailable",
          "Historical message-design receipt is unavailable.",
        );
      const current = await this.current(historical.id.toLowerCase(), "campaigns.write");
      if (current.body.version < historical.version || current.body.channel !== historical.channel)
        throw new AccessError(
          503,
          "replay_metadata_unavailable",
          "Historical message-design receipt is unavailable.",
        );
      await this.authority.require("campaigns.write");
      return { body: historical, status, etag: receipt.response_etag };
    }
    const body = await mutation(),
      etag = messageDesignEtag(body.version);
    await this.authority.require("campaigns.write");
    await this.client.query(
      `INSERT INTO app.idempotency_record
      (tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_etag,expires_at)
      VALUES(app.current_tenant(),$1,$2,$3,$4,$5,$6,$7,'infinity'::timestamptz)`,
      [this.context.userId, route, key, requestHash, workflowJson(body), status, etag],
    );
    await this.authority.require("campaigns.write");
    return { body, status, etag };
  }

  async create(
    body: MessageDesignWrite,
    headers: { key: string | undefined },
  ): Promise<MessageDesignMutation> {
    const prepared = prepareMessageDesignCommand(body),
      key = campaignKey(headers.key);
    return this.command("marketing:message-design:create", prepared, key, null, 201, async () => {
      let created;
      try {
        created = await this.client.query<{ id: string }>(
          `INSERT INTO app.message_design(tenant_id,name,channel,subject,editor_kind,design,rendered_content,content_hash)
          VALUES(app.current_tenant(),$1,$2,$3,'native',$4,$5,$6) RETURNING id`,
          [
            prepared.body.name,
            prepared.body.channel,
            prepared.body.subject ?? null,
            prepared.canonicalDesign,
            prepared.renderedContent,
            prepared.contentHash,
          ],
        );
      } catch (error) {
        messageDesignStorageError(error);
      }
      const { body: design } = await this.current(created.rows[0].id, "campaigns.write");
      await this.audit.audit("message_design.draft_created", "message_design", design.id, design.version);
      await appendMessageDesignDraftEvent(this.client, this.context, this.traceId, design, "create");
      return design;
    });
  }

  async update(
    id: string,
    body: MessageDesignWrite,
    headers: { key: string | undefined; ifMatch?: string },
  ): Promise<MessageDesignMutation> {
    assertUuid(id);
    const target = id.toLowerCase(),
      prepared = prepareMessageDesignCommand(body),
      key = campaignKey(headers.key),
      ifMatch = headers.ifMatch,
      expected = campaignRevision(ifMatch);
    if (expected > 2147483647)
      throw new AccessError(
        400,
        "revision_required",
        "A supported strong numeric If-Match revision is required.",
      );
    return this.command(
      `marketing:message-design:update:${target}`,
      prepared,
      key,
      ifMatch!,
      200,
      async () => {
        const current = await this.current(target, "campaigns.write", "write");
        if (current.body.version !== expected) stale();
        if (prepared.body.channel !== current.body.channel || prepared.body.editor !== current.body.editor)
          throw new MessageDesignCommandError(
            422,
            "design_identity_immutable",
            "Design channel and editor cannot change.",
            [
              {
                field: "channel",
                message: "Keep the current channel and native editor; create a copy for a different channel.",
              },
            ],
          );
        if (current.body.version >= 2147483647 || BigInt(current.row.row_version) >= 9223372036854775807n)
          throw new AccessError(409, "design_revision_exhausted", "The design revision cannot be advanced.");
        await this.authority.require("campaigns.write");
        let changed;
        try {
          changed = await this.client.query<{ id: string }>(
            `UPDATE app.message_design d SET name=$2,subject=$3,design=$4,rendered_content=$5,content_hash=$6
            WHERE d.tenant_id=app.current_tenant() AND d.id=$1 AND d.version=$7 AND d.row_version=$8::bigint
            AND d.availability_state='draft' AND d.history_ready AND d.editor_kind='native' RETURNING d.id`,
            [
              target,
              prepared.body.name,
              prepared.body.subject ?? null,
              prepared.canonicalDesign,
              prepared.renderedContent,
              prepared.contentHash,
              expected,
              current.row.row_version,
            ],
          );
        } catch (error) {
          messageDesignStorageError(error);
        }
        if (!changed.rowCount) stale();
        const { body: design } = await this.current(target, "campaigns.write");
        await this.audit.audit("message_design.draft_updated", "message_design", design.id, design.version);
        await appendMessageDesignDraftEvent(this.client, this.context, this.traceId, design, "update");
        return design;
      },
      target,
    );
  }
}
