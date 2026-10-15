import { types } from "node:util";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { assertUuid, CrmService } from "./crm-service";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";

type Notification = components["schemas"]["Notification"];
type PageNotification = components["schemas"]["PageNotification"];
type NotificationRow = Record<string, unknown> & {
  id: string;
  kind: unknown;
  safe_payload: unknown;
  read_at: Date | string | null;
  row_version: string;
};
export type NotificationCommandResponse = { status: 201; body: Notification };

const columns = "id,kind,safe_payload,read_at,row_version";
const memberViews = new Set([
  "dashboard",
  "contacts",
  "pipeline",
  "tasks",
  "properties",
  "websites",
  "campaigns",
  "settings",
  "notifications",
]);
const unavailable = (): never => {
  throw new AccessError(
    404,
    "resource_unavailable",
    "Notification unavailable or outside your member scope.",
  );
};
const metadataUnavailable = (): never => {
  throw new AccessError(503, "notification_metadata_unavailable", "Notification metadata is unavailable.");
};

function ownData(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readData(value: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor || !Object.hasOwn(descriptor, "value")) return metadataUnavailable();
  return descriptor.value;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length > maximum * 2 ||
    [...value].length > maximum ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return metadataUnavailable();
  return value;
}

function href(value: unknown): string {
  const result = boundedText(value, 500);
  if (
    !result.startsWith("/") ||
    result.startsWith("//") ||
    /[\\\s]/u.test(result) ||
    /%(?:2f|5c|2e|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(result)
  )
    return metadataUnavailable();
  try {
    const decoded = decodeURIComponent(result);
    if (/[\\\u0000-\u0020\u007f]/.test(decoded)) return metadataUnavailable();
    const localPath = result.split(/[?#]/, 1)[0];
    if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(localPath)) return metadataUnavailable();
    const url = new URL(result, "https://estate.invalid");
    if (
      url.origin !== "https://estate.invalid" ||
      url.username ||
      url.password ||
      url.pathname !== localPath ||
      url.pathname + url.search + url.hash !== result ||
      (url.pathname !== "/" && !memberViews.has(url.pathname.slice(1)))
    )
      return metadataUnavailable();
  } catch {
    return metadataUnavailable();
  }
  return result;
}

function readInstant(value: unknown): string | null {
  if (value === null) return null;
  if (!(value instanceof Date) && typeof value !== "string") return metadataUnavailable();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return metadataUnavailable();
  return date.toISOString();
}

function projection(row: NotificationRow): Notification {
  if (!ownData(row.safe_payload)) return metadataUnavailable();
  const result: Notification = {
    id: row.id,
    kind: boundedText(row.kind, 255),
    title: boundedText(readData(row.safe_payload, "title"), 200),
    readAt: readInstant(row.read_at),
  };
  if (Object.hasOwn(row.safe_payload, "href")) result.href = href(readData(row.safe_payload, "href"));
  return result;
}

function receipt(value: unknown, id: string): Notification {
  if (!ownData(value)) return metadataUnavailable();
  const allowed = ["id", "kind", "title", "href", "readAt"];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.includes(key)))
    return metadataUnavailable();
  if (readData(value, "id") !== id) return metadataUnavailable();
  const readAt = readInstant(readData(value, "readAt"));
  if (readAt === null) return metadataUnavailable();
  const result: Notification = {
    id,
    kind: boundedText(readData(value, "kind"), 255),
    title: boundedText(readData(value, "title"), 200),
    readAt,
  };
  if (Object.hasOwn(value, "href")) result.href = href(readData(value, "href"));
  return result;
}

function listInput(query: Record<string, unknown>): { limit: number; cursor: string | undefined } {
  if (!ownData(query)) throw new AccessError(422, "query_invalid", "Only cursor and limit are supported.");
  const data: Record<string, unknown> = Object.create(null);
  for (const field of Reflect.ownKeys(query)) {
    if (typeof field !== "string" || !["limit", "cursor"].includes(field))
      throw new AccessError(422, "query_invalid", "Only cursor and limit are supported.");
    const descriptor = Object.getOwnPropertyDescriptor(query, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new AccessError(422, "query_invalid", "Only scalar cursor and limit values are supported.");
    data[field] = descriptor.value;
  }
  const rawLimit = data.limit;
  if (
    rawLimit !== undefined &&
    typeof rawLimit !== "number" &&
    (typeof rawLimit !== "string" || !/^\d{1,3}$/.test(rawLimit))
  )
    throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
  const limit = rawLimit === undefined ? 25 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
  if (
    data.cursor !== undefined &&
    (typeof data.cursor !== "string" || !data.cursor || data.cursor.length > 4096)
  )
    throw new AccessError(422, "cursor_invalid", "A valid scalar pagination cursor is required.");
  return { limit, cursor: data.cursor as string | undefined };
}

/** Member-only notification state; constructed inside the verified tenant transaction. */
export class NotificationService {
  private readonly foundation: CrmService;

  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
    traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }

  async list(query: Record<string, unknown>): Promise<PageNotification> {
    requirePermission(this.context, "self.notifications.read");
    const { limit, cursor: suppliedCursor } = listInput(query);
    const binding = cursorBinding(this.context, "self.notifications", "own", {});
    const cursor = decodeCursor(suppliedCursor, binding);
    if (cursor) assertUuid(cursor);
    const result = await this.client.query<NotificationRow>(
      `SELECT ${columns} FROM app.notification WHERE tenant_id=$1 AND tenant_id=app.current_tenant()
        AND member_id=$2 AND($3::uuid IS NULL OR id>$3::uuid) ORDER BY id LIMIT $4`,
      [this.context.organizationId, this.context.memberId, cursor, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(projection),
      nextCursor: hasMore ? encodeCursor(rows.at(-1)!.id, binding) : null,
      hasMore,
    };
  }

  async markRead(id: string, key: string | undefined): Promise<NotificationCommandResponse> {
    requirePermission(this.context, "self.notifications.read");
    requirePermission(this.context, "self.notifications.write");
    if (typeof id !== "string") return unavailable();
    assertUuid(id);
    id = id.toLowerCase();
    // The current owned source is locked and validated before even historical replay is considered.
    const found = await this.client.query<NotificationRow>(
      `SELECT ${columns} FROM app.notification WHERE tenant_id=$1 AND tenant_id=app.current_tenant()
        AND member_id=$2 AND id=$3 FOR UPDATE`,
      [this.context.organizationId, this.context.memberId, id],
    );
    const owned = found.rows[0] ?? unavailable();
    projection(owned);
    const result = await this.foundation.idempotent(
      key,
      `POST /v1/orgs/${this.context.organizationId}/notifications/${id}/read`,
      {},
      undefined,
      async () => {
        if (owned.read_at !== null) return { body: projection(owned), status: 201 };
        const version = Number(owned.row_version);
        if (!Number.isSafeInteger(version) || version < 1 || version >= Number.MAX_SAFE_INTEGER)
          throw new AccessError(
            409,
            "notification_version_exhausted",
            "Notification revision is unavailable.",
          );
        const changed = await this.client.query<NotificationRow>(
          `UPDATE app.notification SET read_at=clock_timestamp()
            WHERE tenant_id=$1 AND tenant_id=app.current_tenant() AND member_id=$2 AND id=$3 AND read_at IS NULL
            RETURNING ${columns}`,
          [this.context.organizationId, this.context.memberId, id],
        );
        const row = changed.rows[0] ?? unavailable();
        const body = projection(row);
        if (body.readAt === null) return metadataUnavailable();
        await this.foundation.audit("notification.read", "notification", id, Number(row.row_version));
        return { body, status: 201 };
      },
      async (body) => {
        requirePermission(this.context, "self.notifications.read");
        requirePermission(this.context, "self.notifications.write");
        receipt(body, id);
      },
    );
    return { status: 201, body: receipt(result.body, id) };
  }
}
