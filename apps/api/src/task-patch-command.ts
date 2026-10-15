import { createHash } from "node:crypto";
import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { contactCommandJson } from "./contact-command";
import { validateSchema } from "./contract-validation";

type TaskWrite = components["schemas"]["TaskWrite"];
type Task = components["schemas"]["Task"];
type TaskPatchFields = Readonly<Omit<TaskWrite, "dueAt" | "title"> & { title: string; dueAt: string }>;
export type TaskPatchCommand = Readonly<{
  id: string;
  body: TaskWrite;
  normalized: TaskPatchFields;
  expectedVersion: string;
  version: number;
  key: string;
  routeKey: string;
  requestHash: string;
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const limit = 32 * 1024;
export const taskPatchJson = contactCommandJson;

function invalid(response = false): never {
  throw new AccessError(
    response ? 503 : 422,
    response ? "receipt_unavailable" : "schema_invalid",
    response ? "The saved command receipt is unavailable." : "Task input must match the API schema.",
  );
}

/** Both published shapes are flat own JSON data; nothing can run a getter or JSON hook. */
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
  if (Buffer.byteLength(taskPatchJson(result), "utf8") > limit) return invalid(response);
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

export function taskPatchRevision(value: unknown): number {
  const raw = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw))
    throw new AccessError(503, "resource_unavailable", "Task revision is unavailable.");
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new AccessError(503, "resource_unavailable", "Task revision is unavailable.");
  return version;
}

export function prepareTaskPatch(
  id: unknown,
  body: unknown,
  expectedVersion: unknown,
  key: unknown,
  routeKey: unknown,
  organizationId: string,
): TaskPatchCommand {
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
    typeof routeKey === "string" ? /^PATCH \/v1\/orgs\/([^/]+)\/tasks\/([^/]+)$/.exec(routeKey) : null;
  if (
    !route ||
    route[1].toLowerCase() !== organizationId.toLowerCase() ||
    route[2].toLowerCase() !== id.toLowerCase()
  )
    throw new AccessError(422, "route_invalid", "Task command route is invalid.");
  const detached = snapshot(body);
  validateSchema("TaskWrite", detached);
  const input = detached as TaskWrite;
  if (!input.title.trim()) throw new AccessError(422, "empty_text", "Text cannot be empty.");
  const dueAt = new Date(input.dueAt);
  if (!Number.isFinite(dueAt.getTime()))
    throw new AccessError(422, "due_invalid", "A valid Task due instant is required.");
  const normalized: TaskPatchFields = Object.freeze({
    assigneeMemberId: input.assigneeMemberId.toLowerCase(),
    title: input.title.trim(),
    dueAt: dueAt.toISOString(),
    timezone: namedTimezone(input.timezone),
    ...(input.leadId === undefined ? {} : { leadId: input.leadId?.toLowerCase() ?? null }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.state === undefined ? {} : { state: input.state }),
  });
  const requestHash = createHash("sha256")
    .update(taskPatchJson({ body: input, expectedVersion }))
    .digest("hex");
  return Object.freeze({
    id: id.toLowerCase(),
    body: input,
    normalized,
    expectedVersion: expectedVersion as string,
    version,
    key,
    routeKey: routeKey as string,
    requestHash,
  });
}

export function taskPatchReceipt(value: unknown, command: TaskPatchCommand): Task {
  const detached = snapshot(value, true);
  try {
    validateSchema("Task", detached, true);
  } catch {
    return invalid(true);
  }
  const task = detached as Task;
  const expected = command.normalized;
  if (
    !Number.isSafeInteger(command.version + 1) ||
    task.id.toLowerCase() !== command.id ||
    task.version !== command.version + 1 ||
    task.leadId === undefined ||
    task.description === undefined ||
    task.assigneeMemberId.toLowerCase() !== expected.assigneeMemberId ||
    task.title !== expected.title ||
    task.dueAt !== expected.dueAt ||
    task.timezone !== expected.timezone ||
    (expected.leadId !== undefined && (task.leadId?.toLowerCase() ?? null) !== expected.leadId) ||
    (expected.description !== undefined && task.description !== expected.description) ||
    (expected.priority !== undefined && task.priority !== expected.priority) ||
    (expected.state !== undefined && task.state !== expected.state)
  )
    return invalid(true);
  return task;
}
