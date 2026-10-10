import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type {
  SyntheticStaffSessionResponse,
  SyntheticSupportSelection,
} from "../../../packages/contracts/internal/control-plane-port";
import staffSchema from "../../../packages/contracts/internal/synthetic-staff-v1.schema.json";
import openapi from "../../../packages/contracts/openapi.json";
import type { Schema } from "../lib/api";
import { staffContextKey, validStaffJobId, verifyStaffSession } from "./staff-console-protocol";

/** ADR-019's bounded display policy. These codes never establish server authority. */
export const supportReadPermissions = Object.freeze([
  "crm.contacts.read",
  "crm.leads.read",
  "crm.tasks.read",
  "crm.deals.read",
  "crm.pipeline.read",
  "crm.sources.read",
  "crm.tags.read",
] as const);
export type SupportJobKind = "staff.support.grant" | "staff.support.revoke";
export type SupportState = "none" | "active" | "stale";
type HeaderReader = Pick<Headers, "get">;

const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validateJob = ajv.compile<Schema<"Job">>({
  components: {
    schemas: { Job: openapi.components.schemas.Job, Problem: openapi.components.schemas.Problem },
  },
  $ref: "#/components/schemas/Job",
});
const validateGrant = ajv.compile<Schema<"AccessGrant">>(openapi.components.schemas.AccessGrant);
const validateSelection = ajv.compile<SyntheticSupportSelection>({
  ...staffSchema,
  $ref: "#/$defs/SupportSelection",
});

/** Only detached JSON data may enter the memory-only state, not prototypes or accessors. */
function plainJson(value: unknown): boolean {
  const ancestors = new Set<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "string") return item.length <= 256 * 1024;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return false;
    const keys = Reflect.ownKeys(item);
    if (keys.length > 20_000 || (array && (item.length > 20_000 || keys.length !== item.length + 1)))
      return false;
    ancestors.add(item);
    try {
      for (const key of keys) {
        if (typeof key !== "string") return false;
        if (array && key === "length") continue;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor) || !walk(descriptor.value, depth + 1)) return false;
      }
      return true;
    } finally {
      ancestors.delete(item);
    }
  };
  try {
    return walk(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 256 * 1024;
  } catch {
    return false;
  }
}
function frozenCopy<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy);
  return copy;
}
function validNow(now: number): boolean {
  return Number.isFinite(now) && now >= 0;
}
function readonlyPermissions(value: readonly string[]): boolean {
  return (
    value.length >= 1 &&
    value.length <= supportReadPermissions.length &&
    new Set(value).size === value.length &&
    value.every((code) => supportReadPermissions.some((allowed) => allowed === code))
  );
}

export function parseStrongSupportEtag(value: string | null): string {
  if (!value || !/^"[1-9][0-9]*"$/.test(value)) throw new Error("The operation version is unavailable.");
  const version = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("The operation version is unavailable.");
  return value;
}
function strongTransportEtag(value: string): string {
  if (value.length > 4096 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value))
    throw new Error("The operation transport reference could not be verified.");
  return value;
}
export type SupportGrantReference = Readonly<{ grantId: string; grantEtag: string }>;
function grantReference(headers: HeaderReader): SupportGrantReference {
  const grantId = headers.get("X-Synthetic-Support-Grant-Id");
  if (!validStaffJobId(grantId)) throw new Error("The support grant reference could not be verified.");
  return Object.freeze({
    grantId,
    grantEtag: parseStrongSupportEtag(headers.get("X-Synthetic-Support-Grant-ETag")),
  });
}

export type StaffSupportSessionView = Readonly<{
  session: SyntheticStaffSessionResponse;
  csrf: string;
  supportState: SupportState;
  grant: SupportGrantReference | null;
}>;
export function verifyStaffSupportSession(
  value: unknown,
  headers: HeaderReader,
  now = Date.now(),
): StaffSupportSessionView {
  if (!plainJson(value) || !validNow(now)) throw new Error("The staff session could not be verified.");
  const csrf = headers.get("X-CSRF-Token");
  const session = verifyStaffSession(value, csrf);
  const supportState = headers.get("X-Synthetic-Support-State");
  if (supportState !== "none" && supportState !== "active" && supportState !== "stale")
    throw new Error("The current support state could not be verified.");
  let grant: SupportGrantReference | null = null;
  if (supportState === "active") {
    grant = grantReference(headers);
    const context = session.supportContext;
    if (
      !context ||
      context.accessGrantId !== grant.grantId ||
      !readonlyPermissions(context.permissions) ||
      !context.reason.trim() ||
      Date.parse(context.expiresAt) <= now
    )
      throw new Error("The selected support context is unavailable.");
  } else if (
    session.supportContext !== null ||
    headers.get("X-Synthetic-Support-Grant-Id") !== null ||
    headers.get("X-Synthetic-Support-Grant-ETag") !== null
  ) {
    throw new Error("An inaccessible support context must not be retained.");
  }
  // There is deliberately no Session ETag or derived Session version in this view.
  return frozenCopy({ session, csrf: csrf as string, supportState, grant });
}
export function supportAccessIdentity(view: StaffSupportSessionView): string {
  return JSON.stringify([staffContextKey(view.session), view.supportState, view.grant]);
}
/** A display ceiling, never an eligibility or authorization proof. */
export function supportContextUnexpired(view: StaffSupportSessionView, now = Date.now()): boolean {
  return (
    validNow(now) &&
    view.supportState === "active" &&
    view.session.supportContext !== null &&
    Date.parse(view.session.supportContext.expiresAt) > now
  );
}

export type SupportGrantReceipt = Readonly<{
  job: Schema<"Job">;
  grant: SupportGrantReference;
  jobEtag: string | null;
}>;
export function verifySupportGrantReceipt(
  value: unknown,
  headers: HeaderReader,
  expectedKind: SupportJobKind,
  expectedJobId?: string,
): SupportGrantReceipt {
  if (
    (expectedKind !== "staff.support.grant" && expectedKind !== "staff.support.revoke") ||
    !plainJson(value) ||
    !validateJob(value) ||
    !validStaffJobId(value.id) ||
    value.kind !== expectedKind ||
    (expectedJobId !== undefined && (!validStaffJobId(expectedJobId) || value.id !== expectedJobId))
  )
    throw new Error("The support operation could not be verified. Keep its original request.");
  const transportEtag = headers.get("ETag");
  return frozenCopy({
    job: value,
    grant: grantReference(headers),
    // Frozen Job has no version field. This metadata is not a grant revision.
    jobEtag: transportEtag === null ? null : strongTransportEtag(transportEtag),
  });
}
export const pendingSupportJob = (job: Schema<"Job">): boolean =>
  job.state === "queued" || job.state === "running" || job.state === "unknown";

export type StaffSupportRequestTicket = Readonly<{ generation: number; sequence: number }>;
/** No storage, routes or fetches: the caller owns actual requests and private projection clearing. */
export class StaffSupportLifetime {
  private generationValue = 1;
  private sequence = 0;
  private settledSequence = 0;
  private accessRevisionValue = 0;
  private viewValue: StaffSupportSessionView | null = null;
  private identity: Readonly<{ staffUserId: string; csrf: string }> | null = null;

  get generation(): number {
    return this.generationValue;
  }
  get accessRevision(): number {
    return this.accessRevisionValue;
  }
  get current(): StaffSupportSessionView | null {
    return this.viewValue;
  }
  beginRequest(): StaffSupportRequestTicket {
    return Object.freeze({ generation: this.generationValue, sequence: ++this.sequence });
  }
  isCurrentRequest(ticket: StaffSupportRequestTicket): boolean {
    return ticket.generation === this.generationValue && ticket.sequence === this.sequence;
  }
  acceptSession(
    ticket: StaffSupportRequestTicket,
    value: unknown,
    headers: HeaderReader,
    now = Date.now(),
  ): StaffSupportSessionView | null {
    if (!this.isCurrentRequest(ticket) || ticket.sequence <= this.settledSequence) return null;
    this.settledSequence = ticket.sequence;
    let next: StaffSupportSessionView;
    try {
      next = verifyStaffSupportSession(value, headers, now);
    } catch (error) {
      // Malformed acknowledgement may follow an accepted command. Hide the projection,
      // but retain this opaque lifetime so its original key remains reconcilable.
      this.unverify();
      throw error;
    }
    if (
      this.identity &&
      (this.identity.staffUserId !== next.session.staffUserId || this.identity.csrf !== next.csrf)
    )
      this.generationValue++;
    if (!this.viewValue || supportAccessIdentity(this.viewValue) !== supportAccessIdentity(next))
      this.accessRevisionValue++;
    this.identity = Object.freeze({ staffUserId: next.session.staffUserId, csrf: next.csrf });
    this.viewValue = next;
    return next;
  }
  /** A mismatched or unverifiable response clears access, not the unknown command's opaque lifetime. */
  unverify(): void {
    this.sequence++;
    this.viewValue = null;
    this.accessRevisionValue++;
  }
  /** Call on explicit identity issuance/logout or definite401/403 identity loss. */
  invalidate(): void {
    this.generationValue++;
    this.sequence++;
    this.viewValue = null;
    this.identity = null;
    this.accessRevisionValue++;
  }
}

type CommandBinding = Readonly<{
  generation: number;
  staffUserId: string;
  accessIdentity: string;
  idempotencyKey: string;
}>;
function commandBinding(lifetime: StaffSupportLifetime, key: string): CommandBinding {
  const current = lifetime.current;
  if (!current || !key || key.length > 100 || !key.trim() || /[\u0000-\u001f\u007f]/.test(key))
    throw new Error("A verified staff session and original command key are required.");
  return Object.freeze({
    generation: lifetime.generation,
    staffUserId: current.session.staffUserId,
    accessIdentity: supportAccessIdentity(current),
    idempotencyKey: key,
  });
}
export function snapshotSupportSelection(
  lifetime: StaffSupportLifetime,
  input: SyntheticSupportSelection,
  key: string,
) {
  if (!plainJson(input) || !validateSelection(input))
    throw new Error("The support selection could not be verified.");
  return frozenCopy({ ...commandBinding(lifetime, key), kind: "select" as const, input });
}
export function snapshotSupportClear(lifetime: StaffSupportLifetime, key: string) {
  return frozenCopy({ ...commandBinding(lifetime, key), kind: "clear" as const, input: null });
}
export function snapshotSupportGrant(
  lifetime: StaffSupportLifetime,
  organizationId: string,
  input: Schema<"AccessGrant">,
  key: string,
) {
  if (
    !validStaffJobId(organizationId) ||
    !plainJson(input) ||
    !validateGrant(input) ||
    !validStaffJobId(input.staffUserId) ||
    !readonlyPermissions(input.permissions) ||
    !input.reason.trim()
  )
    throw new Error("The synthetic support grant request could not be verified.");
  return frozenCopy({
    ...commandBinding(lifetime, key),
    kind: "grant" as const,
    organizationId,
    input,
  });
}
export function snapshotSupportRevoke(
  lifetime: StaffSupportLifetime,
  organizationId: string,
  grant: SupportGrantReference,
  key: string,
) {
  if (!validStaffJobId(organizationId) || !validStaffJobId(grant.grantId))
    throw new Error("The support revocation reference could not be verified.");
  return frozenCopy({
    ...commandBinding(lifetime, key),
    kind: "revoke" as const,
    organizationId,
    grant: { grantId: grant.grantId, grantEtag: parseStrongSupportEtag(grant.grantEtag) },
    input: null,
  });
}
export type StaffSupportCommand =
  | ReturnType<typeof snapshotSupportSelection>
  | ReturnType<typeof snapshotSupportClear>
  | ReturnType<typeof snapshotSupportGrant>
  | ReturnType<typeof snapshotSupportRevoke>;
/** Context changes do not discard uncertain commands within the same exact opaque lifetime. */
export function canReconcileSupportCommand(
  lifetime: StaffSupportLifetime,
  command: StaffSupportCommand,
): boolean {
  return (
    lifetime.current !== null &&
    lifetime.generation === command.generation &&
    lifetime.current.session.staffUserId === command.staffUserId
  );
}
export function commandAccessUnchanged(
  lifetime: StaffSupportLifetime,
  command: StaffSupportCommand,
): boolean {
  return (
    canReconcileSupportCommand(lifetime, command) &&
    supportAccessIdentity(lifetime.current as StaffSupportSessionView) === command.accessIdentity
  );
}
export function selectionMatchesCurrent(
  view: StaffSupportSessionView,
  input: SyntheticSupportSelection | null,
  now = Date.now(),
): boolean {
  if (input === null) return view.supportState === "none" && view.session.supportContext === null;
  const context = view.session.supportContext;
  return (
    supportContextUnexpired(view, now) &&
    context?.organizationId === input.organizationId &&
    context.accessGrantId === input.accessGrantId
  );
}
export function supportCommandFailure(
  status?: number,
): "invalidate" | "review-current" | "rejected" | "uncertain" {
  if (status === 401 || status === 403) return "invalidate";
  if (status === 409 || status === 412) return "review-current";
  if (status === 400 || status === 404 || status === 422 || status === 429) return "rejected";
  return "uncertain";
}
