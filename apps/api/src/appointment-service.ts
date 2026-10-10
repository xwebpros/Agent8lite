import { types } from "node:util";
import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import type { components } from "../../../packages/contracts/generated/api";
import {
  AccessError,
  type PermissionGrant,
  type TenantContext,
} from "../../../packages/db/tenant-transaction";
import { cursorBinding, decodeCursor, encodeCursor } from "./cursors";

type Appointment = components["schemas"]["Appointment"];
type PageAppointment = components["schemas"]["PageAppointment"];
type AppointmentRow = Record<string, unknown> & {
  id: unknown;
  lead_id: unknown;
  starts_at: unknown;
  ends_at: unknown;
  timezone: unknown;
  state: unknown;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const contextUnavailable = (): never => {
  throw new AccessError(403, "appointment_context_invalid", "Current appointment access is unavailable.");
};
const metadataUnavailable = (): never => {
  throw new AccessError(503, "appointment_metadata_unavailable", "Appointment metadata is unavailable.");
};

function ownData(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataField(value: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return contextUnavailable();
  return descriptor.value;
}

function grants(value: unknown): PermissionGrant[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > 1000) return contextUnavailable();
  const result: PermissionGrant[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !ownData(descriptor.value))
      return contextUnavailable();
    const grant = descriptor.value;
    if (Reflect.ownKeys(grant).some((key) => key !== "code" && key !== "scope")) return contextUnavailable();
    const code = dataField(grant, "code");
    const scope = dataField(grant, "scope");
    if (
      typeof code !== "string" ||
      !/^[a-z][a-z0-9_.-]{0,99}$/.test(code) ||
      (scope !== "own" && scope !== "team" && scope !== "organization")
    )
      return contextUnavailable();
    result.push(Object.freeze({ code, scope }));
  }
  return result;
}

function contextSnapshot(value: TenantContext): TenantContext {
  if (!ownData(value)) return contextUnavailable();
  const result: Record<string, unknown> = Object.create(null);
  for (const field of ["userId", "organizationId", "memberId", "roleId"]) {
    const id = dataField(value, field);
    if (typeof id !== "string" || !uuid.test(id)) return contextUnavailable();
    result[field] = id.toLowerCase();
  }
  for (const field of ["roleName", "timezone"]) {
    const text = dataField(value, field);
    if (typeof text !== "string" || text.length > 255) return contextUnavailable();
    result[field] = text;
  }
  result.permissions = grants(dataField(value, "permissions"));
  Object.freeze(result.permissions);
  return Object.freeze(result) as TenantContext;
}

function grantIdentity(value: PermissionGrant[]): string {
  return value.map((grant) => `${grant.code.length}:${grant.code}:${grant.scope}`).join("|");
}

function listInput(query: Record<string, unknown>): { limit: number; cursor: string | undefined } {
  const invalid = (): never => {
    throw new AccessError(422, "query_invalid", "Only scalar cursor and limit values are supported.");
  };
  if (!ownData(query)) return invalid();
  const data: Record<string, unknown> = Object.create(null);
  for (const field of Reflect.ownKeys(query)) {
    if (typeof field !== "string" || (field !== "limit" && field !== "cursor")) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(query, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid();
    data[field] = descriptor.value;
  }
  const suppliedLimit = data.limit;
  if (
    suppliedLimit !== undefined &&
    typeof suppliedLimit !== "number" &&
    (typeof suppliedLimit !== "string" || !/^\d{1,3}$/.test(suppliedLimit))
  )
    throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
  const limit = suppliedLimit === undefined ? 25 : Number(suppliedLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new AccessError(422, "limit_invalid", "Limit must be between 1 and 100.");
  if (
    data.cursor !== undefined &&
    (typeof data.cursor !== "string" || !data.cursor || data.cursor.length > 4096)
  )
    throw new AccessError(422, "cursor_invalid", "A valid scalar pagination cursor is required.");
  return { limit, cursor: data.cursor as string | undefined };
}

function storedUuid(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) return metadataUnavailable();
  return value.toLowerCase();
}

function instant(value: unknown): string {
  let milliseconds: number;
  if (value instanceof Date && !types.isProxy(value)) milliseconds = Date.prototype.getTime.call(value);
  else if (typeof value === "string") milliseconds = Date.parse(value);
  else return metadataUnavailable();
  if (!Number.isFinite(milliseconds)) return metadataUnavailable();
  const result = new Date(milliseconds).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)) return metadataUnavailable();
  if (typeof value === "string" && value !== result) return metadataUnavailable();
  return result;
}

function timezone(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
  )
    return metadataUnavailable();
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    if (resolved !== "UTC" && !resolved.includes("/")) return metadataUnavailable();
  } catch {
    return metadataUnavailable();
  }
  return value;
}

function projection(row: AppointmentRow): Appointment {
  const startsAt = instant(row.starts_at);
  const endsAt = instant(row.ends_at);
  if (Date.parse(endsAt) <= Date.parse(startsAt)) return metadataUnavailable();
  if (row.state !== "scheduled" && row.state !== "cancelled" && row.state !== "completed")
    return metadataUnavailable();
  return {
    id: storedUuid(row.id),
    leadId: storedUuid(row.lead_id),
    startsAt,
    endsAt,
    timezone: timezone(row.timezone),
    state: row.state,
  };
}

/** Stored default-own agenda, bound to the caller's verified tenant transaction. */
export class AppointmentService {
  constructor(
    private readonly client: PoolClient,
    private readonly context: TenantContext,
  ) {}

  private async authority(context: TenantContext): Promise<boolean> {
    const result = await this.client.query(
      `SELECT m.id,m.role_id,r.name,r.permission_grants,o.timezone
       FROM app.membership m
       JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE session_user='estate_runtime' AND current_user='estate_runtime'
         AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
         AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
         AND m.status='active' AND o.status='active' FOR SHARE OF m,r,o`,
      [context.organizationId, context.userId, context.memberId, context.roleId],
    );
    const row = result.rows[0];
    if (!row) return contextUnavailable();
    const currentGrants = grants(row.permission_grants);
    if (
      row.name !== context.roleName ||
      row.timezone !== context.timezone ||
      grantIdentity(currentGrants) !== grantIdentity(context.permissions)
    )
      return contextUnavailable();
    const allowed = (code: string, scope: PermissionGrant["scope"]) =>
      currentGrants.some((grant) => grant.code === code && grant.scope === scope);
    const organization = allowed("crm.leads.read", "organization");
    const own = allowed("crm.leads.read", "own");
    const team = allowed("crm.leads.read", "team");
    if (!allowed("appointments.read", "organization") || (!organization && !own && !team))
      throw new AccessError(403, "permission_denied", "Current appointment source permission is required.");
    return team && !organization && !own;
  }

  async list(query: Record<string, unknown>): Promise<PageAppointment> {
    const { limit, cursor: suppliedCursor } = listInput(query);
    // Detach supplied identity/grants before awaiting; actual transaction context is checked below.
    const context = contextSnapshot(this.context);
    const teamOnly = await this.authority(context);
    await requireEntitlement(this.client, "crm.leads.read");
    await requireEntitlement(this.client, "crm.leads.read", { lock: false });
    if (teamOnly)
      await this.client.query(
        `SELECT office_id,member_id FROM app.office_member
         WHERE tenant_id=$1 AND member_id=$2 ORDER BY office_id,member_id FOR SHARE`,
        [context.organizationId, context.memberId],
      );
    const binding = cursorBinding(context, "appointments", "default-own", {});
    const cursor = decodeCursor(suppliedCursor, binding);
    if (cursor !== null && !uuid.test(cursor))
      throw new AccessError(422, "cursor_invalid", "A valid pagination cursor is required.");
    const source = `SELECT a.id,a.lead_id,a.starts_at,a.ends_at,a.timezone,a.state
       FROM app.appointment a
       JOIN app.lead l ON (l.tenant_id,l.id)=(a.tenant_id,a.lead_id)
       JOIN app.contact c ON (c.tenant_id,c.id)=(l.tenant_id,l.contact_id)
       WHERE a.tenant_id=$1 AND a.tenant_id=app.current_tenant()
         AND l.owner_member_id=$2 AND l.archived_at IS NULL AND c.archived_at IS NULL
         AND (NOT $5::boolean OR EXISTS(SELECT 1 FROM app.office_member om
           WHERE om.tenant_id=a.tenant_id AND om.member_id=$2))
         AND ($3::uuid IS NULL OR a.id>$3::uuid)`;
    const pageOrder = " ORDER BY a.id LIMIT $4";
    const parameters = [context.organizationId, context.memberId, cursor, limit + 1, teamOnly];
    // Appointment privilege is SELECT-only. Only its currently eligible CRM parents are SHARE-locked.
    const locked = await this.client.query<AppointmentRow>(
      `${source}${pageOrder} FOR SHARE OF l,c`,
      parameters,
    );
    const selectedIds = locked.rows.map((row) => storedUuid(row.id));
    const selectedLeads = locked.rows.map((row) => storedUuid(row.lead_id));
    await this.authority(context);
    await requireEntitlement(this.client, "crm.leads.read", { lock: false });
    // Re-evaluate only initial ID/lead pairs after waited source locks. Inserts and relinks wait for
    // refresh, so every returned parent was locked. Appointment state is still a current read,
    // not a locked snapshot or evidence that provider scheduling/cancellation is configured.
    const result = await this.client.query<AppointmentRow>(
      `${source} AND EXISTS(SELECT 1 FROM unnest($6::uuid[],$7::uuid[]) AS selected(appointment_id,lead_id)
         WHERE selected.appointment_id=a.id AND selected.lead_id=a.lead_id)${pageOrder}`,
      [...parameters, selectedIds, selectedLeads],
    );
    await this.authority(context);
    await requireEntitlement(this.client, "crm.leads.read", { lock: false });
    const appointments = result.rows.map(projection);
    const hasMore = appointments.length > limit;
    const items = appointments.slice(0, limit);
    return {
      items,
      nextCursor: hasMore ? encodeCursor(items.at(-1)!.id, binding) : null,
      hasMore,
    };
  }
}
