import { createHash, randomUUID } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { components } from "../../../packages/contracts/generated/api";
import eventSchema from "../../../packages/contracts/events.schema.json";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";
import { validateSchema } from "./contract-validation";

type StageTransition = components["schemas"]["StageTransition"];
type Lead = components["schemas"]["Lead"];
export type StageTransitionCommand = Readonly<{
  id: string;
  body: StageTransition;
  expectedVersion: string;
  version: number;
  key: string;
  routeKey: string;
  requestHash: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
addFormats(ajv);
const validEvent = ajv.compile(eventSchema);
export const stageTransitionJson = contactCommandJson;

function invalid(response = false): never {
  throw new AccessError(
    response ? 503 : 422,
    response ? "receipt_unavailable" : "schema_invalid",
    response ? "The saved command receipt is unavailable." : "Stage input must match the API schema.",
  );
}

/** Both frozen shapes are flat own JSON data. Copy before validation, hashing or waiting. */
function snapshot(value: unknown, response = false): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return invalid(response);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid(response);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 12) return invalid(response);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string") return invalid(response);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(response);
    const input = descriptor.value;
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > 16 * 1024 || /[\uD800-\uDFFF]/u.test(input))
        return invalid(response);
    } else if (input !== null && !(typeof input === "number" && Number.isFinite(input))) {
      return invalid(response);
    }
    Object.defineProperty(result, key, { value: input, enumerable: true });
  }
  if (Buffer.byteLength(stageTransitionJson(result), "utf8") > 16 * 1024) return invalid(response);
  return Object.freeze(result);
}

export function stageTransitionRevision(value: unknown): number {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw))
    throw new AccessError(503, "resource_unavailable", "Lead revision is unavailable.");
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "resource_unavailable", "Lead revision is unavailable.");
  return version;
}

export function prepareStageTransition(
  id: unknown,
  body: unknown,
  expectedVersion: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
): StageTransitionCommand {
  if (typeof id !== "string" || !uuid.test(id))
    throw new AccessError(422, "uuid_invalid", "Valid UUID required.");
  if (expectedVersion === undefined || expectedVersion === "")
    throw new AccessError(400, "revision_required", "If-Match revision required.");
  const revision =
    typeof expectedVersion === "string" && expectedVersion.length <= 100
      ? /^(?:"(\d+)"|(\d+))$/.exec(expectedVersion)
      : null;
  const version = revision ? Number(revision[1] ?? revision[2]) : NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(400, "revision_invalid", "A positive safe If-Match revision is required.");
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  const route =
    typeof routeKey === "string"
      ? /^POST \/v1\/orgs\/([^/]+)\/leads\/([^/]+)\/stage-transitions$/.exec(routeKey)
      : null;
  if (
    !route ||
    route[1].toLowerCase() !== organizationId.toLowerCase() ||
    route[2].toLowerCase() !== id.toLowerCase()
  )
    throw new AccessError(422, "route_invalid", "Stage command route is invalid.");
  const detached = snapshot(body);
  validateSchema("StageTransition", detached);
  const requestHash = createHash("sha256")
    .update(stageTransitionJson({ body: detached, expectedVersion }))
    .digest("hex");
  return Object.freeze({
    id: id.toLowerCase(),
    body: detached as StageTransition,
    expectedVersion: expectedVersion as string,
    version,
    key,
    routeKey: routeKey as string,
    requestHash,
  });
}

export function stageTransitionReceipt(value: unknown, command: StageTransitionCommand): Lead {
  const detached = snapshot(value, true);
  try {
    validateSchema("Lead", detached, true);
  } catch {
    return invalid(true);
  }
  const receipt = detached as Lead;
  if (
    !Number.isSafeInteger(command.version + 1) ||
    receipt.id.toLowerCase() !== command.id ||
    receipt.version !== command.version + 1 ||
    receipt.stageId.toLowerCase() !== command.body.toStageId.toLowerCase()
  )
    return invalid(true);
  stageTransitionRevision(receipt.version);
  return receipt;
}

/** Reference-only frozen v1 event. Authority and source checks remain in the transaction-bound service. */
export function stageTransitionEvent(
  tenantId: string,
  leadId: string,
  stageId: string,
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
    !Number.isSafeInteger(version)
  )
    throw new AccessError(503, "event_contract_failure", "Stage reference event validation failed.");
  const timestamp = instant.toISOString();
  const event = {
    eventId: randomUUID(),
    type: "lead.stage_changed",
    version: 1,
    tenantId,
    occurredAt: timestamp,
    ingestedAt: timestamp,
    producer: "crm",
    aggregateType: "lead",
    aggregateId: leadId,
    correlationId,
    payload: { resourceId: leadId, resourceVersion: version, relatedResourceIds: [stageId] },
  };
  if (!validEvent(event) || version < 1)
    throw new AccessError(503, "event_contract_failure", "Stage reference event validation failed.");
  return event;
}
