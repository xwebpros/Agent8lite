/** ADR-049: Contact merge command helpers — preparation, receipt validation, event, and merge result model. */
import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { validateSchema } from "./contract-validation";
import mergedEventSchema from "../../../packages/contracts/internal/native-contact-merged-event-v1.schema.json";

type Job = components["schemas"]["Job"];
type ContactMerge = components["schemas"]["ContactMerge"];
type ConsentMergeOutcome = components["schemas"]["ConsentMergeOutcome"];

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validMergedEvent = ajv.compile(mergedEventSchema);

export type MergeCommand = Readonly<{
  survivorId: string;
  sourceId: string;
  survivorExpectedVersion: number;
  sourceExpectedVersion: number;
  acknowledgePhoneOnly: boolean;
  key: string;
  routeKey: string;
  requestHash: string;
}>;

export const mergeJobKind = "crm.contact.merged" as const;

function unavailableReceipt(): never {
  throw new AccessError(503, "receipt_unavailable", "The saved merge receipt is unavailable.");
}

export function mergeJson(value: unknown): string {
  // Safe JSON for receipt/event payloads; never includes raw user text or channel destinations.
  return JSON.stringify(value);
}

export function prepareMerge(
  survivorId: unknown,
  body: unknown,
  key: unknown,
  routeKey: unknown,
  ifMatch: unknown,
  organizationId: string,
): MergeCommand {
  if (typeof survivorId !== "string" || !uuid.test(survivorId))
    throw new AccessError(422, "uuid_invalid", "Valid survivor UUID required.");
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  const route =
    typeof routeKey === "string"
      ? new RegExp(`^POST /v1/orgs/([^/]+)/contacts/([^/]+)/merges$`).exec(routeKey)
      : null;
  if (
    !route ||
    route[1].toLowerCase() !== organizationId.toLowerCase() ||
    route[2].toLowerCase() !== survivorId.toLowerCase()
  )
    throw new AccessError(422, "route_invalid", "Merge command route is invalid.");

  // Validate If-Match for the survivor (required)
  if (typeof ifMatch !== "string" || !ifMatch || ifMatch.length > 100)
    throw new AccessError(400, "revision_required", "If-Match revision header is required.");
  const survivorVersionMatch = /^(?:"(\d+)"|(\d+))$/.exec(ifMatch);
  if (!survivorVersionMatch) throw new AccessError(400, "revision_invalid", "If-Match revision is invalid.");
  const survivorExpectedVersion = Number(survivorVersionMatch[1] ?? survivorVersionMatch[2]);
  if (!Number.isSafeInteger(survivorExpectedVersion) || survivorExpectedVersion < 1)
    throw new AccessError(400, "revision_invalid", "If-Match revision must be a positive integer.");

  // Validate body
  if (
    body === null ||
    typeof body !== "object" ||
    types.isProxy(body) ||
    Array.isArray(body) ||
    (Object.getPrototypeOf(body) !== null && Object.getPrototypeOf(body) !== Object.prototype)
  )
    throw new AccessError(422, "body_invalid", "Request body must be a JSON object.");

  try {
    validateSchema("ContactMergeRequest", body);
  } catch {
    throw new AccessError(422, "body_invalid", "Request body failed schema validation.");
  }

  const bodyRecord = body as Record<string, unknown>;
  const sourceId = bodyRecord.sourceContactId;
  if (typeof sourceId !== "string" || !uuid.test(sourceId))
    throw new AccessError(422, "uuid_invalid", "Valid sourceContactId UUID required.");
  if (sourceId.toLowerCase() === survivorId.toLowerCase())
    throw new AccessError(409, "merge_same_contact", "Source and survivor contacts must differ.");

  const rawSourceVersion = bodyRecord.sourceVersion;
  if (typeof rawSourceVersion !== "number" || !Number.isSafeInteger(rawSourceVersion) || rawSourceVersion < 1)
    throw new AccessError(422, "source_version_invalid", "sourceVersion must be a positive integer.");

  const acknowledgePhoneOnly = bodyRecord.acknowledgePhoneOnly === true;

  const requestHash = createHash("sha256")
    .update(
      mergeJson({
        sourceContactId: sourceId.toLowerCase(),
        sourceVersion: rawSourceVersion,
        survivorVersion: survivorExpectedVersion,
        acknowledgePhoneOnly,
      }),
    )
    .digest("hex");

  return Object.freeze({
    survivorId: survivorId.toLowerCase(),
    sourceId: sourceId.toLowerCase(),
    survivorExpectedVersion,
    sourceExpectedVersion: rawSourceVersion,
    acknowledgePhoneOnly,
    key,
    routeKey: routeKey as string,
    requestHash,
  });
}

/** Strict historical receipt: a succeeded Job with resultUrl pointing at the merge result. */
export function mergeReceipt(value: unknown, command: MergeCommand): Job {
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
    if (input !== null && typeof input !== "string") return unavailableReceipt();
    if (input !== null && (input as string).length > 512) return unavailableReceipt();
    Object.defineProperty(detached, key, { value: input, enumerable: true });
  }
  // Manual field-level checks below replace schema-level validation here; uri-format
  // enforcement would reject the relative resultUrl paths that the service produces.
  const job = detached as Job;
  if (
    !uuid.test(job.id) ||
    job.kind !== mergeJobKind ||
    job.state !== "succeeded" ||
    typeof job.resultUrl !== "string" ||
    !job.resultUrl.includes("/contact-merges/") ||
    (job.error ?? null) !== null
  )
    return unavailableReceipt();
  return Object.freeze(job);
}

/** Internal contact.merged v1 event: references only, no channel values or personal data. */
export function contactMergedEvent(
  tenantId: string,
  survivorContactId: string,
  survivorVersion: number,
  mergedContactId: string,
  mergedVersion: number,
  channelsMoved: number,
  channelsCombined: number,
  leadsMoved: number,
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
    !uuid.test(tenantId) ||
    !uuid.test(survivorContactId) ||
    !uuid.test(mergedContactId) ||
    !Number.isSafeInteger(survivorVersion) ||
    survivorVersion < 1 ||
    !Number.isSafeInteger(mergedVersion) ||
    mergedVersion < 1 ||
    !Number.isSafeInteger(channelsMoved) ||
    channelsMoved < 0 ||
    !Number.isSafeInteger(channelsCombined) ||
    channelsCombined < 0 ||
    !Number.isSafeInteger(leadsMoved) ||
    leadsMoved < 0
  )
    throw new AccessError(503, "event_contract_failure", "Merge reference event validation failed.");
  const timestamp = instant.toISOString();
  const event = {
    eventId: randomUUID(),
    type: "contact.merged",
    version: 1,
    tenantId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "crm",
    aggregateType: "contact",
    aggregateId: survivorContactId,
    correlationId,
    payload: {
      survivorContactId,
      survivorVersion,
      mergedContactId,
      mergedVersion,
      channelsMoved,
      channelsCombined,
      leadsMoved,
    },
  };
  if (!validMergedEvent(event))
    throw new AccessError(503, "event_contract_failure", "Merge reference event validation failed.");
  return event;
}

/** Map a contact_merge database row to the ContactMerge API shape. */
export function contactMergeModel(row: Record<string, unknown>): ContactMerge {
  const outcomes = Array.isArray(row.consent_outcomes)
    ? (row.consent_outcomes as ConsentMergeOutcome[])
    : (JSON.parse(row.consent_outcomes as string) as ConsentMergeOutcome[]);
  return {
    id: String(row.id),
    survivorContactId: String(row.survivor_contact_id),
    mergedContactId: String(row.merged_contact_id),
    survivorVersion: Number(row.survivor_version),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    channelsMoved: Number(row.channels_moved),
    channelsCombined: Number(row.channels_combined),
    leadsMoved: Number(row.leads_moved),
    consentOutcomes: outcomes,
  };
}
