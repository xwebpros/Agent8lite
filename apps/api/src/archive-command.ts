import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { components } from "../../../packages/contracts/generated/api";
import eventSchema from "../../../packages/contracts/events.schema.json";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";
import { validateSchema } from "./contract-validation";

type Job = components["schemas"]["Job"];
export type ArchiveKind = "contacts" | "leads";
export type ArchiveCommand = Readonly<{
  kind: ArchiveKind;
  id: string;
  key: string;
  routeKey: string;
  requestHash: string;
  jobKind: "crm.contact.archived" | "crm.lead.archived";
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);
export const archiveJson = contactCommandJson;

function unavailableReceipt(): never {
  throw new AccessError(503, "receipt_unavailable", "The saved command receipt is unavailable.");
}

/** The frozen archive operations declare no request body; only absence or an empty object is accepted. */
function emptyBody(body: unknown) {
  if (body === undefined) return;
  if (
    body !== null &&
    typeof body === "object" &&
    !types.isProxy(body) &&
    !Array.isArray(body) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(body)) &&
    Reflect.ownKeys(body).length === 0
  )
    return;
  throw new AccessError(422, "body_not_allowed", "This command accepts no content fields.");
}

export function prepareArchive(
  kind: ArchiveKind,
  id: unknown,
  body: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
): ArchiveCommand {
  if (typeof id !== "string" || !uuid.test(id))
    throw new AccessError(422, "uuid_invalid", "Valid UUID required.");
  emptyBody(body);
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  const route =
    typeof routeKey === "string"
      ? new RegExp(`^POST /v1/orgs/([^/]+)/${kind}/([^/]+)/archive$`).exec(routeKey)
      : null;
  if (
    !route ||
    route[1].toLowerCase() !== organizationId.toLowerCase() ||
    route[2].toLowerCase() !== id.toLowerCase()
  )
    throw new AccessError(422, "route_invalid", "Archive command route is invalid.");
  // No If-Match is declared, so the canonical hash never depends on a supplied revision header.
  const requestHash = createHash("sha256")
    .update(archiveJson({ body: null, expectedVersion: null }))
    .digest("hex");
  return Object.freeze({
    kind,
    id: id.toLowerCase(),
    key,
    routeKey: routeKey as string,
    requestHash,
    jobKind: kind === "contacts" ? "crm.contact.archived" : "crm.lead.archived",
  });
}

/** Strict historical receipt: a succeeded Job of this command's kind with no result URL or error. */
export function archiveReceipt(value: unknown, command: ArchiveCommand): Job {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return unavailableReceipt();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return unavailableReceipt();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 6) return unavailableReceipt();
  const detached: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") return unavailableReceipt();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return unavailableReceipt();
    const input = descriptor.value;
    if (input !== null && (typeof input !== "string" || input.length > 255)) return unavailableReceipt();
    Object.defineProperty(detached, key, { value: input, enumerable: true });
  }
  try {
    validateSchema("Job", detached, true);
  } catch {
    return unavailableReceipt();
  }
  const job = detached as Job;
  if (
    !uuid.test(job.id) ||
    job.kind !== command.jobKind ||
    job.state !== "succeeded" ||
    (job.resultUrl ?? null) !== null ||
    (job.error ?? null) !== null
  )
    return unavailableReceipt();
  return Object.freeze(job);
}

export function archiveRevision(value: unknown): number {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw))
    throw new AccessError(503, "resource_unavailable", "Resource revision is unavailable.");
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "resource_unavailable", "Resource revision is unavailable.");
  return version;
}

/** Frozen catalog `contact.archived` v1: references only, database-clock times. */
export function contactArchivedEvent(
  tenantId: string,
  contactId: string,
  version: number,
  correlationId: string,
  instant: Date,
) {
  if (
    !(instant instanceof Date) ||
    !Number.isFinite(instant.getTime()) ||
    typeof correlationId !== "string" ||
    !correlationId ||
    [...correlationId].length > 80 ||
    /[\uD800-\uDFFF]/u.test(correlationId) ||
    !Number.isSafeInteger(version) ||
    version < 2 ||
    !uuid.test(tenantId) ||
    !uuid.test(contactId)
  )
    throw new AccessError(503, "event_contract_failure", "Archive reference event validation failed.");
  const timestamp = instant.toISOString();
  const event = {
    eventId: randomUUID(),
    type: "contact.archived",
    version: 1,
    tenantId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "crm",
    aggregateType: "contact",
    aggregateId: contactId,
    correlationId,
    payload: { resourceId: contactId, resourceVersion: version },
  };
  if (!validEvent(event) || event.aggregateId !== event.payload.resourceId)
    throw new AccessError(503, "event_contract_failure", "Archive reference event validation failed.");
  return event;
}
