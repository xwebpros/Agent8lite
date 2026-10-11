import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import { AccessError, type TenantContext } from "../../../../packages/db/tenant-transaction";
import { eligibleDestinationSql } from "../consent-eligibility-sql";
import { validateSchema } from "../contract-validation";
import { stable } from "../crm-service";
import { WorkflowAuthority } from "./workflow-authority";
import { WorkflowCommandError } from "./workflow-errors";
import { workflowJson } from "./workflow-json";
import { WorkflowSources } from "./workflow-sources";

type BroadcastRequest = components["schemas"]["BroadcastRequest"];
type BroadcastPreview = components["schemas"]["BroadcastPreview"];
type LeadFilter = components["schemas"]["LeadFilter"];
export type BroadcastPreviewMutation = { body: BroadcastPreview; status: 201 };

/** Larger segments are refused rather than shown as a capped count. */
export const broadcastAudienceLimit = 5000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const purposeFor = { email: "email_marketing", sms: "sms_marketing" } as const;
const kindFor = { email: "email", sms: "phone" } as const;

function invalid(field: string, message: string): never {
  throw new WorkflowCommandError(422, "broadcast_invalid", "The broadcast segment is invalid.", [
    { field, message },
  ]);
}

/** Same named-zone boundary as Task commands: UTC or Area/Location resolved by Intl. */
function namedTimezone(value: string) {
  if (value.length > 80 || (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)))
    invalid("timezone", "Use UTC or a named IANA timezone.");
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    if (typeof resolved !== "string" || (resolved !== "UTC" && !resolved.includes("/"))) throw new Error();
  } catch {
    invalid("timezone", "Use UTC or a named IANA timezone.");
  }
}

/** Detach and validate before any wait; prototype hooks and getters never execute. */
export function prepareBroadcastPreview(body: unknown, key: unknown) {
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  let request: BroadcastRequest;
  try {
    request = JSON.parse(workflowJson(body)) as BroadcastRequest;
  } catch {
    throw new AccessError(422, "body_invalid", "Use bounded plain JSON for the broadcast segment.");
  }
  validateSchema("BroadcastRequest", request);
  const filter = request.filter;
  if (!Object.keys(filter).length) invalid("filter", "Choose at least one segment field.");
  if (filter.tagIds) {
    if (!filter.tagIds.length) invalid("filter.tagIds", "Choose at least one tag or remove the tag field.");
    if (new Set(filter.tagIds.map((id) => id.toLowerCase())).size !== filter.tagIds.length)
      invalid("filter.tagIds", "Each tag may appear once.");
  }
  if (filter.q !== undefined && (!filter.q.trim() || [...filter.q].length > 200))
    invalid("filter.q", "Name text must be nonblank and at most 200 characters.");
  namedTimezone(request.timezone);
  if (request.scheduledAt !== undefined && !Number.isFinite(Date.parse(request.scheduledAt)))
    invalid("scheduledAt", "Use a valid scheduled instant.");
  const requestHash = createHash("sha256")
    .update(stable({ body: request, expectedVersion: null }))
    .digest("hex");
  return Object.freeze({ request, key, requestHash });
}

function permissionsFor(filter: LeadFilter) {
  return [
    "campaigns.send",
    "campaigns.read",
    "crm.leads.read",
    "crm.contacts.read",
    ...(filter.ownerMemberId ? ["members.read"] : []),
    ...(filter.stageId ? ["crm.pipeline.read"] : []),
    ...(filter.sourceId ? ["crm.sources.read"] : []),
    ...(filter.tagIds?.length ? ["crm.tags.read"] : []),
  ];
}

/** Point-in-time segment estimate; it never sends, schedules or writes another module's rows. */
export class BroadcastPreviewService {
  private readonly authority: WorkflowAuthority;
  private readonly sources: WorkflowSources;
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    private readonly traceId: string,
  ) {
    this.authority = new WorkflowAuthority(client, context);
    this.sources = new WorkflowSources(client, this.authority);
  }

  private async requireAll(filter: LeadFilter) {
    for (const permission of permissionsFor(filter)) await this.authority.require(permission);
  }

  /** ADR-023 reference and native design checks, reported on BroadcastRequest field paths. */
  private async assertReferences(request: BroadcastRequest): Promise<"email" | "sms"> {
    const design = await this.client.query<{ channel: string }>(
      "SELECT channel FROM app.message_design WHERE tenant_id=app.current_tenant() AND id=$1",
      [request.messageDesignId],
    );
    const channel = design.rows[0]?.channel;
    if (channel !== "email" && channel !== "sms")
      throw new WorkflowCommandError(
        422,
        "workflow_reference_unavailable",
        "A broadcast source prerequisite is unavailable.",
        [
          {
            field: "messageDesignId",
            message: "This source is unavailable or incompatible with the broadcast.",
          },
        ],
      );
    try {
      await this.sources.assertCurrent({
        nodes: [
          { key: "segment", kind: "condition", condition: request.filter },
          { key: "message", kind: channel, messageDesignId: request.messageDesignId },
        ],
        edges: [],
        timezone: request.timezone,
      });
    } catch (error) {
      if (!(error instanceof WorkflowCommandError)) throw error;
      throw new WorkflowCommandError(
        error.status,
        error.code,
        "A broadcast source prerequisite is unavailable.",
        error.errors.map((issue) => ({
          field: issue.field.replace(/^nodes\.0\.condition/, "filter").replace(/^nodes\.1\./, ""),
          message: "This source is unavailable or incompatible with the broadcast.",
        })),
      );
    }
    return channel;
  }

  private async receipt(routeKey: string, key: string) {
    return (
      await this.client.query(
        `SELECT request_hash,response_body,status_code,response_ref,expires_at>clock_timestamp() AS unexpired
         FROM app.idempotency_record WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3`,
        [this.context.userId, routeKey, key],
      )
    ).rows[0];
  }

  private async count(request: BroadcastRequest, channel: "email" | "sms") {
    const filter = request.filter;
    const params: unknown[] = [
      kindFor[channel],
      purposeFor[channel],
      syntheticMode(),
      broadcastAudienceLimit + 1,
    ];
    const where = ["l.tenant_id=app.current_tenant()", "l.archived_at IS NULL", "c.archived_at IS NULL"];
    for (const [field, column] of [
      ["stageId", "stage_id"],
      ["ownerMemberId", "owner_member_id"],
      ["sourceId", "source_id"],
      ["intent", "intent"],
    ] as const) {
      if (filter[field] === undefined) continue;
      params.push(filter[field]);
      where.push(`l.${column}=$${params.length}`);
    }
    if (filter.tagIds?.length) {
      params.push(filter.tagIds.map((id) => id.toLowerCase()));
      const tags = `$${params.length}::uuid[]`;
      where.push(
        `(SELECT count(DISTINCT lt.tag_id) FROM app.lead_tag lt WHERE lt.tenant_id=l.tenant_id AND lt.lead_id=l.id AND lt.tag_id=ANY(${tags}))=cardinality(${tags})`,
      );
    }
    if (filter.q !== undefined) {
      params.push(`%${filter.q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`c.display_name ILIKE $${params.length} ESCAPE '\\'`);
    }
    const result = await this.client.query<{ matched: number; eligible: number; recipients: number }>(
      `WITH matched AS (
         SELECT l.id AS lead_id,l.contact_id FROM app.lead l
         JOIN app.contact c ON(c.tenant_id,c.id)=(l.tenant_id,l.contact_id)
         WHERE ${where.join(" AND ")} LIMIT $4
       ), destinations AS (
         SELECT DISTINCT ON(ch.contact_id) ch.contact_id,ch.normalized_value FROM app.contact_channel ch
         WHERE ch.tenant_id=app.current_tenant() AND ch.active AND ch.kind=$1
           AND ch.contact_id IN(SELECT contact_id FROM matched)
           AND ${eligibleDestinationSql("ch", "$2", "$3::boolean")}
         ORDER BY ch.contact_id,ch.is_primary DESC,ch.created_at,ch.id
       )
       SELECT (SELECT count(*) FROM matched)::int AS matched,
         (SELECT count(*) FROM matched m WHERE EXISTS(SELECT 1 FROM destinations d WHERE d.contact_id=m.contact_id))::int AS eligible,
         (SELECT count(DISTINCT normalized_value) FROM destinations)::int AS recipients`,
      params,
    );
    const row = result.rows[0];
    if (!row || row.matched > broadcastAudienceLimit)
      throw new AccessError(
        422,
        "broadcast_audience_too_large",
        `Segments are limited to ${broadcastAudienceLimit} matched leads. Narrow the segment.`,
      );
    return {
      eligible: row.eligible,
      ineligible: row.matched - row.eligible,
      estimatedRecipients: row.recipients,
    };
  }

  async preview(body: unknown, key: string | undefined, routeKey: string): Promise<BroadcastPreviewMutation> {
    const command = prepareBroadcastPreview(body, key);
    const { request } = command;
    if (!/^POST \/v1\/orgs\/[^/]+\/broadcast-previews$/.test(routeKey))
      throw new AccessError(422, "route_invalid", "Broadcast preview route is invalid.");
    await this.requireAll(request.filter);
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:${this.context.userId}:${routeKey}:${command.key}`,
    ]);
    await this.requireAll(request.filter);
    const saved = await this.receipt(routeKey, command.key);
    if (saved) {
      if (saved.request_hash !== command.requestHash)
        throw new AccessError(409, "idempotency_conflict", "This key was used with a different request.");
      if (!saved.unexpired)
        throw new AccessError(409, "receipt_expired", "The original preview receipt has expired.");
      const stored = saved.response_body as BroadcastPreview;
      try {
        validateSchema("BroadcastPreview", stored, true);
        if (saved.status_code !== 201 || !uuid.test(stored.id) || saved.response_ref !== stored.id)
          throw new Error();
      } catch {
        throw new AccessError(503, "receipt_unavailable", "The saved preview receipt is unavailable.");
      }
      // Historical counts are returned only while their references remain currently authorized.
      await this.assertReferences(request);
      await this.requireAll(request.filter);
      return { body: stored, status: 201 };
    }
    if (
      request.scheduledAt !== undefined &&
      !(await this.client.query("SELECT $1::timestamptz>clock_timestamp() AS future", [request.scheduledAt]))
        .rows[0].future
    )
      invalid("scheduledAt", "A scheduled time must be in the future.");
    const channel = await this.assertReferences(request);
    const counts = await this.count(request, channel);
    const id = randomUUID();
    const clock = await this.client.query<{ expires: Date }>(
      "SELECT clock_timestamp()+interval '15 minutes' AS expires",
    );
    const response: BroadcastPreview = { id, ...counts, expiresAt: clock.rows[0].expires.toISOString() };
    validateSchema("BroadcastPreview", response, true);
    await this.client.query(
      `INSERT INTO app.audit_event(tenant_id,actor_ref,action,resource_type,resource_id,trace_id,safe_diff)
       VALUES($1,$2,'broadcast.previewed','broadcast_preview',$3,$4,$5)`,
      [
        this.context.organizationId,
        this.context.userId,
        id,
        this.traceId,
        JSON.stringify({ messageDesignId: request.messageDesignId, channel, ...counts }),
      ],
    );
    await this.client.query(
      `INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,response_ref,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,201,$7,clock_timestamp()+interval '1 day')`,
      [
        this.context.organizationId,
        this.context.userId,
        routeKey,
        command.key,
        command.requestHash,
        JSON.stringify(response),
        id,
      ],
    );
    await this.requireAll(request.filter);
    if (!(await this.receipt(routeKey, command.key))?.unexpired)
      throw new AccessError(409, "receipt_expired", "The original preview receipt has expired.");
    return { body: response, status: 201 };
  }
}

function syntheticMode() {
  return (
    ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true"
  );
}
