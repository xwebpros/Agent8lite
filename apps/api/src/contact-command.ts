import { createHash } from "node:crypto";
import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { validateSchema } from "./contract-validation";

type ContactWrite = components["schemas"]["ContactWrite"];
type Contact = components["schemas"]["Contact"];
export type ContactPatchCommand = Readonly<{
  id: string;
  body: ContactWrite;
  expectedVersion: string;
  version: number;
  key: string;
  routeKey: string;
  requestHash: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const jsonLimit = 16 * 1024;

function invalid(response: boolean): never {
  throw new AccessError(
    response ? 503 : 422,
    response ? "receipt_unavailable" : "schema_invalid",
    response ? "The saved command receipt is unavailable." : "Contact input must match the API schema.",
  );
}

/** Only primitive leaves are JSON encoded; neither objects nor arrays can invoke inherited hooks. */
export function contactCommandJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || types.isProxy(value)) return invalid(false);
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isInteger(length) || Reflect.ownKeys(value).length !== length + 1) return invalid(false);
    let result = "[";
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(false);
      if (index) result += ",";
      result += contactCommandJson(descriptor.value);
    }
    return `${result}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid(false);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return invalid(false);
  const ordered = (keys as string[]).sort((a, b) => a.localeCompare(b));
  let result = "{";
  for (let index = 0; index < ordered.length; index++) {
    const key = ordered[index];
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(false);
    if (index) result += ",";
    result += `${JSON.stringify(key)}:${contactCommandJson(descriptor.value)}`;
  }
  return `${result}}`;
}

function snapshot(value: unknown, response = false): unknown {
  let nodes = 0;
  const detach = (input: unknown, depth: number): unknown => {
    if (++nodes > 100 || depth > 4) return invalid(response);
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return invalid(response);
      return input;
    }
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
    if (prototype !== Object.prototype && prototype !== null) return invalid(response);
    const keys = Reflect.ownKeys(input);
    if (keys.length > 10) return invalid(response);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string") return invalid(response);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return invalid(response);
      Object.defineProperty(result, key, {
        value: detach(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  };
  const detached = detach(value, 0);
  if (Buffer.byteLength(contactCommandJson(detached), "utf8") > jsonLimit) return invalid(response);
  return detached;
}

export function contactRevision(value: unknown): number {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw))
    throw new AccessError(503, "resource_unavailable", "Contact revision is unavailable.");
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "resource_unavailable", "Contact revision is unavailable.");
  return version;
}

export function prepareContactPatch(
  id: unknown,
  body: unknown,
  expectedVersion: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
): ContactPatchCommand {
  if (typeof id !== "string" || !uuid.test(id))
    throw new AccessError(422, "uuid_invalid", "Valid UUID required.");
  if (expectedVersion === undefined || expectedVersion === "")
    throw new AccessError(400, "revision_required", "If-Match revision required.");
  if (typeof expectedVersion !== "string")
    throw new AccessError(400, "revision_invalid", "A positive If-Match revision is required.");
  const revision = expectedVersion.length <= 100 ? /^(?:"(\d+)"|(\d+))$/.exec(expectedVersion) : null;
  if (!revision) throw new AccessError(400, "revision_invalid", "A positive If-Match revision is required.");
  const version = Number(revision[1] ?? revision[2]);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(400, "revision_invalid", "A positive safe If-Match revision is required.");
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  if (typeof routeKey !== "string")
    throw new AccessError(422, "route_invalid", "Contact command route is invalid.");
  const route = /^PATCH \/v1\/orgs\/([^/]+)\/contacts\/([^/]+)$/.exec(routeKey);
  if (
    !route ||
    route[1].toLowerCase() !== organizationId.toLowerCase() ||
    route[2].toLowerCase() !== id.toLowerCase()
  )
    throw new AccessError(422, "route_invalid", "Contact command route is invalid.");
  const detached = snapshot(body);
  validateSchema("ContactWrite", detached);
  const input = detached as ContactWrite;
  if (!input.displayName.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  if (input.phones?.some((phone) => !/^\+?[0-9]{7,15}$/.test(phone.trim().replace(/[\s().-]/g, ""))))
    throw new AccessError(
      422,
      "channel_invalid",
      "Phone channels require 7–15 digits with an optional leading +.",
    );
  const requestHash = createHash("sha256")
    .update(contactCommandJson({ body: input, expectedVersion }))
    .digest("hex");
  return Object.freeze({ id, body: input, expectedVersion, version, key, routeKey, requestHash });
}

export function contactReceipt(value: unknown, command: ContactPatchCommand): Contact {
  const detached = snapshot(value, true);
  try {
    validateSchema("Contact", detached, true);
  } catch {
    return invalid(true);
  }
  const contact = detached as Contact;
  if (contact.id.toLowerCase() !== command.id.toLowerCase() || contact.version !== command.version + 1)
    return invalid(true);
  contactRevision(contact.version);
  if (contact.displayName !== command.body.displayName.trim()) return invalid(true);
  const matchingChannels = (field: "emails" | "phones") => {
    const requested = command.body[field];
    if (requested === undefined) return true;
    const normalized = new Set<string>();
    for (const value of requested)
      normalized.add(field === "emails" ? value.trim().toLowerCase() : value.trim().replace(/[\s().-]/g, ""));
    const returned = new Set(contact[field]);
    return (
      normalized.size === returned.size &&
      contact[field].length === returned.size &&
      [...normalized].every((value) => returned.has(value))
    );
  };
  if (!matchingChannels("emails") || !matchingChannels("phones")) return invalid(true);
  if (command.body.birthday !== undefined && (contact.birthday ?? null) !== command.body.birthday)
    return invalid(true);
  return contact;
}
