import { createHash } from "node:crypto";
import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";
import { validateSchema } from "./contract-validation";

type TaskWrite = components["schemas"]["TaskWrite"];
type Task = components["schemas"]["Task"];
type TaskFields = Readonly<Omit<Task, "id" | "version">>;
export type TaskCreateCommand = Readonly<{
  body: TaskWrite;
  normalized: TaskFields;
  key: string;
  routeKey: string;
  requestHash: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const limit = 32 * 1024;
export const taskCreateJson = contactCommandJson;

function invalid(response = false): never {
  throw new AccessError(
    response ? 503 : 422,
    response ? "receipt_unavailable" : "schema_invalid",
    response ? "The saved command receipt is unavailable." : "Task input must match the API schema.",
  );
}

/** The published Task shapes contain only flat, own JSON data. */
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
      if (Buffer.byteLength(input, "utf8") > limit || /[\uD800-\uDFFF]/u.test(input))
        return invalid(response);
    } else if (input !== null && !(typeof input === "number" && Number.isFinite(input))) {
      return invalid(response);
    }
    Object.defineProperty(result, key, { value: input, enumerable: true });
  }
  if (Buffer.byteLength(taskCreateJson(result), "utf8") > limit) return invalid(response);
  return Object.freeze(result);
}

function namedTimezone(value: string): string {
  if (value.length > 80 || (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value)))
    throw new AccessError(422, "timezone_invalid", "A valid named IANA timezone is required.");
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    if (typeof resolved !== "string" || (resolved !== "UTC" && !resolved.includes("/"))) throw new Error();
  } catch {
    throw new AccessError(422, "timezone_invalid", "A valid named IANA timezone is required.");
  }
  return value;
}

export function prepareTaskCreate(
  body: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
): TaskCreateCommand {
  if (typeof key !== "string" || !key || key.length > 100 || !/^[\x21-\x7e]+$/.test(key))
    throw new AccessError(400, "idempotency_required", "A printable Idempotency-Key is required.");
  const route = typeof routeKey === "string" ? /^POST \/v1\/orgs\/([^/]+)\/tasks$/.exec(routeKey) : null;
  if (!route || route[1].toLowerCase() !== organizationId.toLowerCase())
    throw new AccessError(422, "route_invalid", "Task command route is invalid.");
  const detached = snapshot(body);
  validateSchema("TaskWrite", detached);
  const input = detached as TaskWrite;
  if (!input.title.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  const instant = new Date(input.dueAt);
  if (!Number.isFinite(instant.getTime()))
    throw new AccessError(422, "due_invalid", "A valid Task due instant is required.");
  const normalized: TaskFields = Object.freeze({
    assigneeMemberId: input.assigneeMemberId.toLowerCase(),
    leadId: input.leadId?.toLowerCase() ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    dueAt: instant.toISOString(),
    timezone: namedTimezone(input.timezone),
    priority: input.priority ?? "normal",
    state: input.state ?? "open",
  });
  const requestHash = createHash("sha256")
    .update(taskCreateJson({ body: input, expectedVersion: null }))
    .digest("hex");
  return Object.freeze({ body: input, normalized, key, routeKey: routeKey as string, requestHash });
}

export function taskCreateReceipt(value: unknown, command: TaskCreateCommand): Task {
  const detached = snapshot(value, true);
  try {
    validateSchema("Task", detached, true);
  } catch {
    return invalid(true);
  }
  const receipt = detached as Task;
  const expected = command.normalized;
  if (
    !uuid.test(receipt.id) ||
    receipt.version !== 1 ||
    receipt.assigneeMemberId.toLowerCase() !== expected.assigneeMemberId ||
    (receipt.leadId?.toLowerCase() ?? null) !== expected.leadId ||
    receipt.title !== expected.title ||
    (receipt.description ?? null) !== expected.description ||
    receipt.dueAt !== expected.dueAt ||
    receipt.timezone !== expected.timezone ||
    receipt.priority !== expected.priority ||
    receipt.state !== expected.state
  )
    return invalid(true);
  return receipt;
}
