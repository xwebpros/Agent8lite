import { createHash } from "node:crypto";
import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";
import { validateSchema } from "./contract-validation";

type Schemas = components["schemas"];
export type CapturePostResource = "contacts" | "leads";
type CaptureWrite<Resource extends CapturePostResource> = Resource extends "contacts"
  ? Schemas["ContactWrite"]
  : Schemas["LeadCreate"];
export type CapturePostCommand<Resource extends CapturePostResource = CapturePostResource> = Readonly<{
  resource: Resource;
  body: CaptureWrite<Resource>;
  key: string;
  routeKey: string;
  requestHash: string;
}>;

const jsonLimit = 16 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const capturePostJson = contactCommandJson;

function invalid(response = false): never {
  throw new AccessError(
    response ? 503 : 422,
    response ? "receipt_unavailable" : "schema_invalid",
    response ? "The saved command receipt is unavailable." : "Capture input must match the API schema.",
  );
}

/** Detach own JSON data before any wait; inherited serialization hooks are never invoked. */
function snapshot(value: unknown, response = false): unknown {
  let nodes = 0;
  const detach = (input: unknown, depth: number): unknown => {
    if (++nodes > 120 || depth > 4) return invalid(response);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid(response);
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > jsonLimit || /[\uD800-\uDFFF]/u.test(input))
        return invalid(response);
      return input;
    }
    if (!input || typeof input !== "object" || types.isProxy(input)) return invalid(response);
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) return invalid(response);
      const length = Object.getOwnPropertyDescriptor(input, "length")?.value;
      if (
        !Number.isInteger(length) ||
        length < 0 ||
        length > 10 ||
        Reflect.ownKeys(input).length !== length + 1
      )
        return invalid(response);
      const array = new Array(length);
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(response);
        Object.defineProperty(array, String(index), {
          value: detach(descriptor.value, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(array);
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) return invalid(response);
    const keys = Reflect.ownKeys(input);
    if (keys.length > 12) return invalid(response);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return invalid(response);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(response);
      Object.defineProperty(result, key, { value: detach(descriptor.value, depth + 1), enumerable: true });
    }
    return Object.freeze(result);
  };
  const detached = detach(value, 0);
  if (Buffer.byteLength(capturePostJson(detached), "utf8") > jsonLimit) return invalid(response);
  return detached;
}

export function prepareCapturePost<Resource extends CapturePostResource>(
  resource: Resource,
  body: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
  legacyExpectedVersion?: unknown,
): CapturePostCommand<Resource> {
  if (resource !== "contacts" && resource !== "leads") return invalid();
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  if (typeof routeKey !== "string")
    throw new AccessError(422, "route_invalid", "Capture command route is invalid.");
  const route = /^POST \/v1\/orgs\/([^/]+)\/(contacts|leads)$/.exec(routeKey);
  if (!route || route[1].toLowerCase() !== organizationId.toLowerCase() || route[2] !== resource)
    throw new AccessError(422, "route_invalid", "Capture command route is invalid.");
  // POST has no revision/CAS requirement. Preserve historically hashed header spelling if supplied.
  if (
    legacyExpectedVersion !== undefined &&
    (typeof legacyExpectedVersion !== "string" || legacyExpectedVersion.length > 4096)
  )
    throw new AccessError(400, "revision_invalid", "The supplied command header is invalid.");
  const detached = snapshot(body);
  validateSchema(resource === "contacts" ? "ContactWrite" : "LeadCreate", detached);
  if (resource === "contacts") {
    const input = detached as Schemas["ContactWrite"];
    if (!input.displayName.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
    if (input.phones?.some((phone) => !/^\+?[0-9]{7,15}$/.test(phone.trim().replace(/[\s().-]/g, ""))))
      throw new AccessError(
        422,
        "channel_invalid",
        "Phone channels require 7–15 digits with an optional leading +.",
      );
  }
  const requestHash = createHash("sha256")
    .update(capturePostJson({ body: detached, expectedVersion: legacyExpectedVersion ?? null }))
    .digest("hex");
  return Object.freeze({ resource, body: detached as CaptureWrite<Resource>, key, routeKey, requestHash });
}

export function contactPostReceipt(
  value: unknown,
  command: CapturePostCommand<"contacts">,
): Schemas["Contact"] {
  const detached = snapshot(value, true);
  try {
    validateSchema("Contact", detached, true);
  } catch {
    return invalid(true);
  }
  const receipt = detached as Schemas["Contact"];
  if (
    !uuid.test(receipt.id) ||
    receipt.version !== 1 ||
    receipt.displayName !== command.body.displayName.trim()
  )
    return invalid(true);
  for (const field of ["emails", "phones"] as const) {
    const expected = new Set(
      (command.body[field] ?? []).map((entry) =>
        field === "emails" ? entry.trim().toLowerCase() : entry.trim().replace(/[\s().-]/g, ""),
      ),
    );
    const returned = new Set(receipt[field]);
    if (
      expected.size !== returned.size ||
      returned.size !== receipt[field].length ||
      [...expected].some((entry) => !returned.has(entry))
    )
      return invalid(true);
  }
  if ((receipt.birthday ?? null) !== (command.body.birthday ?? null)) return invalid(true);
  return receipt;
}

export function leadPostReceipt(
  value: unknown,
  command: CapturePostCommand<"leads">,
  memberId: string,
): Schemas["Lead"] {
  const detached = snapshot(value, true);
  try {
    validateSchema("Lead", detached, true);
  } catch {
    return invalid(true);
  }
  const receipt = detached as Schemas["Lead"];
  const owner = command.body.ownerMemberId === undefined ? memberId : command.body.ownerMemberId;
  const returnedOwner = receipt.ownerMemberId;
  const score = receipt.score ?? null,
    scoreVersion = receipt.scoreVersion ?? null;
  if (
    !uuid.test(receipt.id) ||
    !uuid.test(receipt.stageId) ||
    receipt.version !== 1 ||
    receipt.contactId.toLowerCase() !== command.body.contactId.toLowerCase() ||
    receipt.sourceId.toLowerCase() !== command.body.sourceId.toLowerCase() ||
    returnedOwner === undefined ||
    (returnedOwner === null || owner === null
      ? returnedOwner !== owner
      : returnedOwner.toLowerCase() !== owner.toLowerCase()) ||
    receipt.intent !== command.body.intent ||
    (receipt.timeline ?? null) !== (command.body.timeline ?? null) ||
    (score === null ? scoreVersion !== null : typeof scoreVersion !== "string" || !scoreVersion.trim())
  )
    return invalid(true);
  return receipt;
}
