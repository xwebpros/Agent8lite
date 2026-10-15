import { randomUUID } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { PoolClient } from "pg";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import eventSchema from "../../../packages/contracts/internal/native-contact-created-event-v1.schema.json";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";

const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailable(): never {
  throw new AccessError(
    403,
    "contact_event_context_unavailable",
    "Current contact creation authority is unavailable.",
  );
}

function ownObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function ownData(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return unavailable();
  return descriptor.value;
}

/** Copy only authority data; request-session extras and inherited hooks are never inspected. */
function detachContext(value: TenantContext): TenantContext {
  if (!ownObject(value)) return unavailable();
  const context: Record<string, unknown> = Object.create(null);
  for (const key of ["organizationId", "userId", "memberId", "roleId"]) {
    const id = ownData(value, key);
    if (typeof id !== "string" || !uuid.test(id)) return unavailable();
    context[key] = id.toLowerCase();
  }
  const roleName = ownData(value, "roleName"),
    timezone = ownData(value, "timezone");
  if (
    typeof roleName !== "string" ||
    !roleName ||
    roleName.length > 255 ||
    typeof timezone !== "string" ||
    !timezone ||
    timezone.length > 80
  )
    return unavailable();
  context.roleName = roleName;
  context.timezone = timezone;
  const raw = ownData(value, "permissions");
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype)
    return unavailable();
  const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
  if (!Number.isInteger(length) || length < 0 || length > 100 || Reflect.ownKeys(raw).length !== length + 1)
    return unavailable();
  const permissions: TenantContext["permissions"] = [];
  const codes = new Set<string>();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !ownObject(descriptor.value))
      return unavailable();
    const keys = Reflect.ownKeys(descriptor.value);
    if (keys.length !== 2 || keys.some((key) => key !== "code" && key !== "scope")) return unavailable();
    const code = ownData(descriptor.value, "code"),
      scope = ownData(descriptor.value, "scope");
    if (
      typeof code !== "string" ||
      !code ||
      code.length > 120 ||
      codes.has(code) ||
      (scope !== "own" && scope !== "team" && scope !== "organization")
    )
      return unavailable();
    codes.add(code);
    permissions.push(Object.freeze({ code, scope }));
  }
  context.permissions = Object.freeze(permissions);
  return Object.freeze(context) as TenantContext;
}

/** Fresh creation only, in the caller transaction; replay and fixture insertion never call this port. */
export async function appendContactCreatedEvent(
  client: PoolClient,
  suppliedContext: TenantContext,
  traceId: string,
  contactId: string,
): Promise<void> {
  const context = detachContext(suppliedContext);
  if (
    typeof contactId !== "string" ||
    !uuid.test(contactId) ||
    typeof traceId !== "string" ||
    !traceId ||
    [...traceId].length > 80 ||
    /[\uD800-\uDFFF]/u.test(traceId)
  )
    throw new AccessError(500, "event_contract_failure", "Contact reference event validation failed.");
  const id = contactId.toLowerCase();
  requirePermission(context, "crm.contacts.write");
  const permissions = contactCommandJson(context.permissions);
  const authorityParameters = [
    context.organizationId,
    context.userId,
    context.memberId,
    context.roleId,
    permissions,
    context.roleName,
    context.timezone,
  ];
  const authority = async (lock = false) => {
    const result = await client.query(
      `SELECT 1 FROM app.membership m
       JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       JOIN app.organization o ON o.id=m.tenant_id
       WHERE session_user='estate_runtime' AND current_user='estate_runtime'
         AND app.current_tenant()=$1::uuid AND app.current_actor()=$2::uuid
         AND m.tenant_id=$1 AND m.user_id=$2 AND m.id=$3 AND m.role_id=$4
         AND m.status='active' AND o.status='active' AND r.permission_grants=$5::jsonb
         AND r.name=$6 AND o.timezone=$7 ${lock ? "FOR SHARE OF m,r,o" : ""}`,
      authorityParameters,
    );
    if (!result.rowCount) return unavailable();
  };
  // Both fresh call sites allocate this Contact for the initiating member before any lead exists.
  // Creator/no-active-lead is authorized in own, team and organization contact-write scope.
  const source = `SELECT date_trunc('milliseconds',clock_timestamp()) AS occurred_at FROM app.contact c
    WHERE c.tenant_id=app.current_tenant() AND c.id=$1 AND c.row_version=1
      AND c.archived_at IS NULL AND c.created_by_member_id=$2
      AND NOT EXISTS(SELECT 1 FROM app.lead l WHERE l.tenant_id=c.tenant_id
        AND l.contact_id=c.id AND l.archived_at IS NULL)`;
  const sourceParameters = [id, context.memberId];
  await authority(true);
  await requireEntitlement(client, "crm.contacts.write");
  if (!(await client.query(`${source} FOR SHARE OF c`, sourceParameters)).rowCount) return unavailable();
  await authority();
  await requireEntitlement(client, "crm.contacts.write", { lock: false });
  // Capture the timestamp after all lock waits; earlier SELECT predicates are not use-time evidence.
  const current = await client.query<{ occurred_at: Date }>(source, sourceParameters);
  if (!current.rowCount) return unavailable();
  const occurredAt = current.rows[0]?.occurred_at;
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime()))
    throw new AccessError(503, "contact_event_unavailable", "Contact reference event time is unavailable.");
  const timestamp = occurredAt.toISOString();
  const event = {
    eventId: randomUUID(),
    type: "contact.created",
    version: 1,
    tenantId: context.organizationId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "crm",
    aggregateType: "contact",
    aggregateId: id,
    correlationId: traceId,
    payload: { resourceId: id, resourceVersion: 1 },
  };
  if (!validEvent(event) || event.aggregateId !== event.payload.resourceId)
    throw new AccessError(500, "event_contract_failure", "Contact reference event validation failed.");
  await client.query(
    `INSERT INTO app.outbox(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id)
     VALUES($1,$2,'contact.created',$3,$4,$5)`,
    [context.organizationId, event.eventId, id, contactCommandJson(event), context.userId],
  );
  await authority();
  if (!(await client.query(source, sourceParameters)).rowCount) return unavailable();
  await requireEntitlement(client, "crm.contacts.write", { lock: false });
}
