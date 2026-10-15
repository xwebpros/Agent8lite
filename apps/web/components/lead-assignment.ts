import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export const leadAssignmentBodyLimit = 64 * 1024;
export const leadAssignmentRetryWindowMs = 23 * 60 * 60 * 1000;
export type LeadAssignmentCommand = Readonly<{
  context: string;
  leadId: string;
  contactId: string;
  sourceId: string;
  originalStageId: string;
  originalLead: Readonly<Schema<"Lead">>;
  version: number;
  key: string;
  ifMatch: string;
  body: Readonly<Schema<"LeadPatch">>;
  serializedBody: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type LeadAssignmentSnapshot = Readonly<{
  command: LeadAssignmentCommand | null;
  phase: "idle" | "sending" | "unknown" | "acknowledged" | "conflict" | "rejected" | "denied" | "forgotten";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Lead.properties.id);
const validBody = ajv.compile<Schema<"LeadPatch">>(contract.components.schemas.LeadPatch);
const validLead = ajv.compile<Schema<"Lead">>(contract.components.schemas.Lead);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Serialize only a bounded detached own-data tree, never original or inherited hooks. */
export function copyLeadAssignmentData<T>(input: T): { value: T; json: string } {
  const ancestors = new Set<object>();
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4000 || depth > 12) throw new Error();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype && prototype !== null
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1001 || (array && (value.length > 1000 || keys.length !== value.length + 1)))
      throw new Error();
    const detached = array ? Object.setPrototypeOf(new Array(value.length), null) : Object.create(null);
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(detached, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return detached;
  };
  try {
    const json = JSON.stringify(copy(input, 0));
    if (!json || new TextEncoder().encode(json).byteLength > leadAssignmentBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Lead assignment data could not be verified.");
  }
}
const snapshot = copyLeadAssignmentData;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameId(a: unknown, b: unknown): boolean {
  return validId(a) && validId(b) && (a as string).toLowerCase() === (b as string).toLowerCase();
}
export function requireLeadAssignmentWrite(input: unknown): Readonly<Schema<"LeadPatch">> {
  const data = snapshot(input).value;
  if (!validBody(data)) throw new Error("Choose a valid assignee before saving.");
  return freeze(data);
}
export function requireLeadAssignmentLead(input: unknown): Readonly<Schema<"Lead">> {
  const data = snapshot(input).value;
  if (!validLead(data) || !Number.isSafeInteger(data.version))
    throw new Error("The lead receipt could not be verified.");
  return freeze(data);
}
type LeadAssignmentContextInput = {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
};
export function leadAssignmentContext(input: LeadAssignmentContextInput): string | null {
  return contextBinding(input, "crm.leads.write");
}
export function leadAssignmentReadContext(input: LeadAssignmentContextInput): string | null {
  return contextBinding(input, "crm.leads.read");
}
function contextBinding(input: LeadAssignmentContextInput, permission: string): string | null {
  try {
    const data = snapshot(input).value,
      session = data.session;
    if (
      !session ||
      !validId(session.userId) ||
      !validId(session.activeOrgId) ||
      !validId(data.memberId) ||
      typeof data.csrf !== "string" ||
      !/^[\x21-\x7e]{1,512}$/.test(data.csrf) ||
      !Number.isSafeInteger(data.accessRevision) ||
      data.accessRevision < 0 ||
      !Array.isArray(session.permissions) ||
      session.permissions.length > 100 ||
      session.permissions.some((code) => typeof code !== "string" || !code || code.length > 100) ||
      !session.permissions.includes(permission)
    )
      return null;
    return snapshot([
      session.userId,
      session.activeOrgId,
      data.memberId,
      data.csrf,
      data.accessRevision,
      [...session.permissions].sort(),
    ]).json;
  } catch {
    return null;
  }
}
export type LeadAssignmentCurrent = Readonly<{
  binding: string | null;
  active: boolean;
  online: boolean;
  visible: boolean;
  changingOrganization: boolean;
  busy: boolean;
  loading: boolean;
  detailLoading: boolean;
  dirty: boolean;
  otherProtected: boolean;
  leadId: string | null;
}>;
export function leadAssignmentEligible(
  binding: string | null,
  current: LeadAssignmentCurrent,
  expectedLeadId?: string,
): boolean {
  try {
    const data = snapshot({ binding, current }).value;
    return (
      typeof data.binding === "string" &&
      Boolean(data.binding) &&
      data.current.binding === data.binding &&
      data.current.active === true &&
      data.current.online === true &&
      data.current.visible === true &&
      data.current.changingOrganization === false &&
      data.current.busy === false &&
      data.current.loading === false &&
      data.current.detailLoading === false &&
      validId(data.current.leadId) &&
      (expectedLeadId === undefined || sameId(data.current.leadId, expectedLeadId)) &&
      data.current.dirty === false &&
      data.current.otherProtected === false
    );
  } catch {
    return false;
  }
}
/** One exact command. Historical acknowledgment never inserts a historical Lead into the current view. */
export class LeadAssignmentProtocol {
  private context: string | null = null;
  private state: LeadAssignmentSnapshot = Object.freeze({ command: null, phase: "idle" });
  private reconciling = false;
  private invalidClock = false;
  private lastWall = 0;
  private lastMonotonic = 0;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  constructor(options: { wallNow?: () => number; monotonicNow?: () => number } = {}) {
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }
  bind(context: string | null): void {
    const next =
      typeof context === "string" && context.length > 0 && context.length <= leadAssignmentBodyLimit
        ? context
        : null;
    if (this.context !== next) {
      this.reset();
      this.context = next;
    }
  }
  private reset(): void {
    this.state = Object.freeze({ command: null, phase: "idle" });
    this.reconciling = false;
    this.invalidClock = false;
    this.lastWall = 0;
    this.lastMonotonic = 0;
  }
  getSnapshot(): LeadAssignmentSnapshot {
    return this.state;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }
  isCurrent(command: LeadAssignmentCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }
  begin(
    input: { lead: Schema<"Lead">; body: Schema<"LeadPatch">; ifMatch?: string },
    key: string,
  ): LeadAssignmentCommand {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Resolve the earlier assignment command before starting another.");
    const data = snapshot(input).value;
    const lead = requireLeadAssignmentLead(data.lead),
      body = requireLeadAssignmentWrite(data.body);
    const ifMatch = Object.hasOwn(data, "ifMatch") ? data.ifMatch : `"${lead.version}"`;
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !validId(key) ||
      lead.version >= Number.MAX_SAFE_INTEGER ||
      ifMatch !== `"${lead.version}"` ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Assignment, revision or command clock is unavailable.");
    const command = freeze({
      context: this.context,
      leadId: lead.id,
      contactId: lead.contactId,
      sourceId: lead.sourceId,
      originalStageId: lead.stageId,
      originalLead: lead,
      version: lead.version,
      key,
      ifMatch,
      body,
      serializedBody: snapshot(body).json,
      firstWall,
      firstMonotonic,
    });
    this.reconciling = false;
    this.invalidClock = false;
    this.lastWall = firstWall;
    this.lastMonotonic = firstMonotonic;
    this.state = Object.freeze({ command, phase: "sending" });
    return command;
  }
  canRetry(command = this.state.command): boolean {
    if (!command || !this.isCurrent(command) || this.invalidClock) return false;
    try {
      const wall = this.wallNow(),
        monotonic = this.monotonicNow();
      if (
        !Number.isFinite(wall) ||
        !Number.isFinite(monotonic) ||
        wall < this.lastWall ||
        monotonic < this.lastMonotonic ||
        wall - command.firstWall >= leadAssignmentRetryWindowMs ||
        monotonic - command.firstMonotonic >= leadAssignmentRetryWindowMs
      ) {
        this.invalidClock = true;
        return false;
      }
      this.lastWall = wall;
      this.lastMonotonic = monotonic;
      return true;
    } catch {
      this.invalidClock = true;
      return false;
    }
  }
  retry(): LeadAssignmentCommand {
    const command = this.state.command;
    if (!command || this.state.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original assignment command cannot be resent; its outcome remains unconfirmed.");
    this.reconciling = true;
    this.state = Object.freeze({ command, phase: "sending" });
    return command;
  }
  canForget(): boolean {
    const command = this.state.command;
    return this.state.phase === "unknown" && Boolean(command && this.isCurrent(command)) && !this.canRetry();
  }
  forget(): boolean {
    if (!this.canForget()) return false;
    this.reset();
    this.state = Object.freeze({ command: null, phase: "forgotten" });
    return true;
  }
  acknowledge(command: LeadAssignmentCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const lead = requireLeadAssignmentLead(input);
      const original = command.originalLead;
      if (
        !sameId(lead.id, command.leadId) ||
        !sameId(lead.contactId, command.contactId) ||
        !sameId(lead.sourceId, command.sourceId) ||
        !sameId(lead.stageId, original.stageId) ||
        lead.version !== command.version + 1 ||
        etag !== `"${lead.version}"` ||
        ((Object.hasOwn(command.body, "ownerMemberId")
          ? command.body.ownerMemberId
          : original.ownerMemberId) == null
          ? lead.ownerMemberId != null
          : !sameId(
              lead.ownerMemberId,
              Object.hasOwn(command.body, "ownerMemberId")
                ? command.body.ownerMemberId
                : original.ownerMemberId,
            )) ||
        lead.intent !== (command.body.intent ?? original.intent) ||
        (lead.timeline ?? null) !==
          (Object.hasOwn(command.body, "timeline")
            ? (command.body.timeline ?? null)
            : (original.timeline ?? null)) ||
        (lead.score ?? null) !== (original.score ?? null) ||
        (lead.scoreVersion ?? null) !== (original.scoreVersion ?? null)
      )
        throw new Error();
      this.state = Object.freeze({ command: null, phase: "acknowledged" });
      this.reconciling = false;
      return true;
    } catch {
      this.state = Object.freeze({ command, phase: "unknown" });
      this.reconciling = true;
      return false;
    }
  }
  reject(command: LeadAssignmentCommand, error: unknown): "cleared" | "unknown" | "ignored" {
    if (!this.isCurrent(command)) return "ignored";
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.bind(null);
      this.state = Object.freeze({ command: null, phase: "denied" });
      return "cleared";
    }
    if (
      !this.reconciling &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      this.state = Object.freeze({ command: null, phase: error.status === 412 ? "conflict" : "rejected" });
      return "cleared";
    }
    this.state = Object.freeze({ command, phase: "unknown" });
    this.reconciling = true;
    return "unknown";
  }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Assignment response unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error();
      const chunk = await reader.read();
      if (signal.aborted) throw new Error();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > leadAssignmentBodyLimit) {
        cancel();
        throw new Error();
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
}
export async function leadAssignmentRequest(
  organizationId: string,
  command: LeadAssignmentCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value;
  const original = requireLeadAssignmentLead(captured.originalLead);
  if (
    !validId(organizationId) ||
    !validId(captured.leadId) ||
    !validId(captured.contactId) ||
    !validId(captured.sourceId) ||
    !validId(captured.originalStageId) ||
    !validId(captured.key) ||
    typeof captured.context !== "string" ||
    !captured.context ||
    typeof csrf !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(csrf) ||
    !Number.isSafeInteger(captured.version) ||
    captured.version < 1 ||
    captured.version >= Number.MAX_SAFE_INTEGER ||
    !sameId(original.id, captured.leadId) ||
    !sameId(original.contactId, captured.contactId) ||
    !sameId(original.sourceId, captured.sourceId) ||
    !sameId(original.stageId, captured.originalStageId) ||
    original.version !== captured.version ||
    captured.ifMatch !== `"${captured.version}"` ||
    snapshot(requireLeadAssignmentWrite(captured.body)).json !== captured.serializedBody
  )
    throw new Error("The original assignment command is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" + encodeURIComponent(organizationId) + "/leads/" + encodeURIComponent(captured.leadId),
      {
        method: "PATCH",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": captured.key,
          "If-Match": captured.ifMatch,
        },
        body: captured.serializedBody,
      },
    );
    if (!response.ok) {
      let code = "lead_assignment_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Never display unverified/private response text. */
      }
      throw new ApiError(response.status, "The assignment command could not be verified.", code);
    }
    if (response.status !== 200) throw new Error("Assignment response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
