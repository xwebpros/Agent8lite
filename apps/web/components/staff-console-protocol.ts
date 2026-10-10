import type { SyntheticStaffSessionResponse } from "../../../packages/contracts/internal/control-plane-port";
import type { Schema } from "../lib/api";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validStaffJobId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
export const pendingStaffJob = (job: Schema<"Job">) => ["queued", "running", "unknown"].includes(job.state);
// These allowlists are checked against the shared types; tests exercise their frozen JSON schemas.
const sessionKeys = [
  "staffUserId",
  "permissions",
  "synthetic",
  "supportContext",
] as const satisfies readonly (keyof SyntheticStaffSessionResponse)[];
const supportKeys = [
  "organizationId",
  "accessGrantId",
  "permissions",
  "reason",
  "expiresAt",
] as const satisfies readonly (keyof NonNullable<SyntheticStaffSessionResponse["supportContext"]>)[];
const jobKeys = [
  "id",
  "state",
  "kind",
  "createdAt",
  "resultUrl",
  "error",
] as const satisfies readonly (keyof Schema<"Job">)[];
const problemKeys = [
  "type",
  "title",
  "status",
  "detail",
  "instance",
  "code",
  "traceId",
  "errors",
] as const satisfies readonly (keyof Schema<"Problem">)[];
const organizationKeys = [
  "id",
  "name",
  "status",
  "timezone",
  "locale",
  "version",
] as const satisfies readonly (keyof Schema<"Organization">)[];
const pageKeys = [
  "items",
  "nextCursor",
  "hasMore",
] as const satisfies readonly (keyof Schema<"PageOrganization">)[];

function closed(value: unknown, keys: readonly string[], required = keys): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).every((key) => keys.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}
const text = (value: unknown, max: number, min = 0): value is string =>
  typeof value === "string" && Array.from(value).length >= min && Array.from(value).length <= max;
const permissions = (value: unknown, min = 0): value is string[] =>
  Array.isArray(value) &&
  value.length >= min &&
  value.length <= 20 &&
  value.every((item) => text(item, 100)) &&
  new Set(value).size === value.length;
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[tT](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[zZ]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHour, offsetMinute] =
    match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    (!offsetHour || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
  );
}
function uri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z][a-z\d+.-]*:[^\s]*$/i.test(value) ||
    /%(?![\da-f]{2})/i.test(value)
  )
    return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
function problem(value: unknown): boolean {
  if (!closed(value, problemKeys, ["type", "title", "status", "code", "traceId"])) return false;
  return (
    uri(value.type) &&
    text(value.title, 255) &&
    Number.isInteger(value.status) &&
    Number(value.status) >= 400 &&
    Number(value.status) <= 599 &&
    text(value.code, 80) &&
    text(value.traceId, 80) &&
    (!Object.hasOwn(value, "detail") || text(value.detail, 1000)) &&
    (!Object.hasOwn(value, "instance") || text(value.instance, 255)) &&
    (!Object.hasOwn(value, "errors") ||
      (Array.isArray(value.errors) &&
        value.errors.length <= 100 &&
        value.errors.every(
          (item) => closed(item, ["field", "message"]) && text(item.field, 100) && text(item.message, 300),
        )))
  );
}

export function verifyStaffSession(value: unknown, csrf: string | null): SyntheticStaffSessionResponse {
  if (
    !closed(value, sessionKeys) ||
    value.synthetic !== true ||
    !validStaffJobId(value.staffUserId) ||
    typeof csrf !== "string" ||
    !csrf ||
    csrf.length > 4096 ||
    !permissions(value.permissions)
  )
    throw new Error("The synthetic staff session could not be verified.");
  if (value.supportContext !== null) {
    const context = value.supportContext;
    if (
      !closed(context, supportKeys) ||
      !validStaffJobId(context.organizationId) ||
      !validStaffJobId(context.accessGrantId) ||
      !permissions(context.permissions, 1) ||
      !text(context.reason, 1000, 1) ||
      !timestamp(context.expiresAt)
    )
      throw new Error("The staff support context could not be verified.");
  }
  return value as unknown as SyntheticStaffSessionResponse;
}
export function staffContextKey(session: SyntheticStaffSessionResponse) {
  const context = session.supportContext;
  return JSON.stringify([
    session.staffUserId,
    [...session.permissions].sort(),
    context
      ? [
          context.organizationId,
          context.accessGrantId,
          [...context.permissions].sort(),
          context.reason,
          context.expiresAt,
        ]
      : null,
  ]);
}
export function verifyStaffJob(job: unknown, expectedId?: string): Schema<"Job"> {
  if (
    !closed(job, jobKeys, ["id", "state", "kind", "createdAt"]) ||
    !validStaffJobId(job.id) ||
    (expectedId && job.id !== expectedId) ||
    job.kind !== "organization.provision" ||
    typeof job.state !== "string" ||
    !["queued", "running", "succeeded", "failed", "cancelled", "unknown"].includes(job.state) ||
    !timestamp(job.createdAt) ||
    (Object.hasOwn(job, "resultUrl") && job.resultUrl !== null && !uri(job.resultUrl)) ||
    (Object.hasOwn(job, "error") && job.error !== null && !problem(job.error))
  )
    throw new Error(
      "The provisioning operation could not be verified. Keep the original request for reconciliation.",
    );
  return job as Schema<"Job">;
}
export function verifyOrganizationPage(page: unknown): Schema<"PageOrganization"> {
  if (
    !closed(page, pageKeys) ||
    !Array.isArray(page.items) ||
    page.items.length > 100 ||
    typeof page.hasMore !== "boolean" ||
    (page.nextCursor !== null && !text(page.nextCursor, 4096)) ||
    (page.hasMore && !page.nextCursor) ||
    page.items.some(
      (item) =>
        !closed(item, organizationKeys) ||
        !validStaffJobId(item.id) ||
        !text(item.name, 120) ||
        typeof item.status !== "string" ||
        !["provisioning", "active", "suspended", "archived"].includes(item.status) ||
        !text(item.timezone, 80) ||
        !text(item.locale, 20) ||
        !Number.isSafeInteger(item.version) ||
        Number(item.version) < 1,
    )
  )
    throw new Error("Organization metadata is unavailable because the response could not be verified.");
  return page as Schema<"PageOrganization">;
}
