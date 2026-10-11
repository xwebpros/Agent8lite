import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export type BroadcastRequest = Schema<"BroadcastRequest">;
export type BroadcastPreview = Schema<"BroadcastPreview">;
export type LeadFilter = Schema<"LeadFilter">;
export type BroadcastIssue = Readonly<{ field: string; message: string }>;
export type BroadcastCommand = Readonly<{ binding: string; idempotencyKey: string; body: BroadcastRequest }>;

const responseBytes = 64 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:broadcast-browser",
  components: {
    schemas: {
      BroadcastRequest: contract.components.schemas.BroadcastRequest,
      BroadcastPreview: contract.components.schemas.BroadcastPreview,
      LeadFilter: contract.components.schemas.LeadFilter,
    },
  },
});
const validateRequest = ajv.compile<BroadcastRequest>({
  $ref: "estate:broadcast-browser#/components/schemas/BroadcastRequest",
});
const validatePreview = ajv.compile<BroadcastPreview>({
  $ref: "estate:broadcast-browser#/components/schemas/BroadcastPreview",
});
const validateProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);
const knownField =
  /^(?:messageDesignId|timezone|scheduledAt|filter(?:\.(?:stageId|sourceId|ownerMemberId|q|intent|tagIds(?:\.(?:[0-9]|1[0-9]))?))?)$/;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Plain JSON copy; accessors, prototypes and sparse arrays are refused. */
export function copyBroadcastJson<T>(value: T): T {
  const json = JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object") {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
        throw new Error("Broadcast data must be plain JSON.");
    }
    return item;
  });
  if (json === undefined || json.length > 32 * 1024) throw new Error("Broadcast data is unavailable.");
  return JSON.parse(json) as T;
}

/** Same named-zone boundary as the server. */
export function validBroadcastTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    value.trim() !== value ||
    (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
  )
    return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return typeof resolved === "string" && (resolved === "UTC" || resolved.includes("/"));
  } catch {
    return false;
  }
}

/** Local checks mirroring the server's ADR-051 validation; the server remains authoritative. */
export function broadcastIssues(draft: Partial<BroadcastRequest>): readonly BroadcastIssue[] {
  const issues: BroadcastIssue[] = [];
  const filter = draft.filter ?? {};
  if (!draft.messageDesignId) issues.push({ field: "messageDesignId", message: "Choose a message design." });
  if (!Object.keys(filter).length)
    issues.push({ field: "filter", message: "Choose at least one segment field." });
  if (filter.tagIds) {
    if (!filter.tagIds.length || filter.tagIds.length > 20)
      issues.push({ field: "filter.tagIds", message: "Choose between 1 and 20 tags." });
    else if (new Set(filter.tagIds.map((id) => id.toLowerCase())).size !== filter.tagIds.length)
      issues.push({ field: "filter.tagIds", message: "Each tag may appear once." });
  }
  if (filter.q !== undefined && (!filter.q.trim() || [...filter.q].length > 200))
    issues.push({ field: "filter.q", message: "Name text must be nonblank and at most 200 characters." });
  if (!validBroadcastTimezone(draft.timezone))
    issues.push({ field: "timezone", message: "Use UTC or a named IANA timezone." });
  if (draft.scheduledAt !== undefined && !Number.isFinite(Date.parse(draft.scheduledAt)))
    issues.push({ field: "scheduledAt", message: "Use a valid scheduled time." });
  return freeze(issues);
}

export function requireBroadcastRequest(value: unknown): BroadcastRequest {
  const copy = copyBroadcastJson(value);
  if (!validateRequest(copy) || broadcastIssues(copy).length)
    throw new Error("The broadcast segment could not be verified.");
  return freeze(copy);
}

export function requireBroadcastPreview(value: unknown): BroadcastPreview {
  const copy = copyBroadcastJson(value);
  if (
    !validatePreview(copy) ||
    !Number.isFinite(Date.parse(copy.expiresAt)) ||
    copy.estimatedRecipients > copy.eligible
  )
    throw new Error("The broadcast preview could not be verified.");
  return freeze(copy);
}

export class BroadcastResponseError extends ApiError {
  readonly issues: readonly BroadcastIssue[];
  constructor(status: number, code: string | undefined, issues: readonly BroadcastIssue[]) {
    super(status, "The broadcast preview was not accepted.", code);
    this.issues = freeze(issues.map((issue) => ({ ...issue })));
  }
}

/** Bounded read; only known field paths are kept and private server text is never shown. */
export async function readBroadcastResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > responseBytes) throw new Error("Broadcast transport exceeds its limit.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    if (!response.ok) throw new BroadcastResponseError(response.status, undefined, []);
    throw new Error("Broadcast transport is not valid JSON.");
  }
  if (response.ok) return value;
  if (!validateProblem(value) || value.status !== response.status)
    throw new BroadcastResponseError(response.status, undefined, []);
  throw new BroadcastResponseError(
    response.status,
    value.code,
    (value.errors ?? [])
      .filter((issue) => knownField.test(issue.field))
      .map((issue) => ({ field: issue.field, message: "This field could not be accepted." })),
  );
}
