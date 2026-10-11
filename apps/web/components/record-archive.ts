import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

/** ADR-047 recoverable Contact/Lead archive: one immutable command, strict historical acknowledgement. */
export const recordArchiveBodyLimit = 64 * 1024;
export const recordArchiveRetryWindowMs = 23 * 60 * 60 * 1000;
export type RecordArchiveKind = "contact" | "lead";
export const recordArchiveJobKinds: Readonly<Record<RecordArchiveKind, string>> = Object.freeze({
  contact: "crm.contact.archived",
  lead: "crm.lead.archived",
});
const writePermission: Readonly<Record<RecordArchiveKind, string>> = Object.freeze({
  contact: "crm.contacts.write",
  lead: "crm.leads.write",
});
export type RecordArchiveCommand = Readonly<{
  context: string;
  kind: RecordArchiveKind;
  resourceId: string;
  organizationId: string;
  route: string;
  version: number;
  key: string;
  jobKind: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type RecordArchivePhase =
  | "idle"
  | "sending"
  | "unknown"
  | "acknowledged"
  | "blocked"
  | "unavailable"
  | "rejected"
  | "denied"
  | "forgotten";
export type RecordArchiveSnapshot = Readonly<{
  command: RecordArchiveCommand | null;
  phase: RecordArchivePhase;
  /** Identity of the last resolved command; used only to match a drawer, never rendered. */
  subject: Readonly<{ kind: RecordArchiveKind; resourceId: string }> | null;
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:record-archive",
  components: {
    schemas: { Job: contract.components.schemas.Job, Problem: contract.components.schemas.Problem },
  },
});
const validJob = ajv.compile<Schema<"Job">>({ $ref: "estate:record-archive#/components/schemas/Job" });
const validProblem = ajv.compile<Schema<"Problem">>({
  $ref: "estate:record-archive#/components/schemas/Problem",
});
const validId = ajv.compile(contract.components.schemas.Contact.properties.id);

/** Serialize only a bounded detached own-data tree, never original or inherited hooks. */
export function copyRecordArchiveData<T>(input: T): { value: T; json: string } {
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
    if (!json || new TextEncoder().encode(json).byteLength > recordArchiveBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Archive data could not be verified.");
  }
}
const snapshot = copyRecordArchiveData;
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
function validKind(value: unknown): value is RecordArchiveKind {
  return value === "contact" || value === "lead";
}
function validCsrf(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
}
export function recordArchiveRoute(
  organizationId: string,
  kind: RecordArchiveKind,
  resourceId: string,
): string {
  if (!validId(organizationId) || !validKind(kind) || !validId(resourceId))
    throw new Error("Archive route identity is unavailable.");
  return (
    "/v1/orgs/" +
    encodeURIComponent(organizationId) +
    (kind === "contact" ? "/contacts/" : "/leads/") +
    encodeURIComponent(resourceId) +
    "/archive"
  );
}
type RecordArchiveContextInput = {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
};
/** Verified user/org/member/CSRF/access-revision/full-grant binding; requires either archive grant. */
export function recordArchiveContext(input: RecordArchiveContextInput): string | null {
  try {
    const data = snapshot(input).value,
      session = data.session;
    if (
      !session ||
      !validId(session.userId) ||
      !validId(session.activeOrgId) ||
      !validId(data.memberId) ||
      !validCsrf(data.csrf) ||
      !Number.isSafeInteger(data.accessRevision) ||
      data.accessRevision < 0 ||
      !Array.isArray(session.permissions) ||
      session.permissions.length > 100 ||
      session.permissions.some((code) => typeof code !== "string" || !code || code.length > 100) ||
      !(
        session.permissions.includes(writePermission.contact) ||
        session.permissions.includes(writePermission.lead)
      )
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
type ParsedContext = Readonly<{ organizationId: string; csrf: string; permissions: readonly string[] }>;
function parseContext(context: unknown): ParsedContext | null {
  try {
    if (typeof context !== "string" || !context || context.length > recordArchiveBodyLimit) return null;
    const data: unknown = JSON.parse(context);
    if (
      !Array.isArray(data) ||
      data.length !== 6 ||
      !validId(data[0]) ||
      !validId(data[1]) ||
      !validId(data[2]) ||
      !validCsrf(data[3]) ||
      !Number.isSafeInteger(data[4]) ||
      !Array.isArray(data[5]) ||
      data[5].some((code: unknown) => typeof code !== "string")
    )
      return null;
    return { organizationId: data[1] as string, csrf: data[3], permissions: data[5] as string[] };
  } catch {
    return null;
  }
}
/** Whether a verified binding carries the write grant for this kind. The server still decides scope. */
export function recordArchiveContextAllows(context: string | null, kind: RecordArchiveKind): boolean {
  const parsed = parseContext(context);
  return Boolean(parsed && validKind(kind) && parsed.permissions.includes(writePermission[kind]));
}
export type RecordArchiveCurrent = Readonly<{
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
  kind: string | null;
  resourceId: string | null;
}>;
export function recordArchiveEligible(
  binding: string | null,
  current: RecordArchiveCurrent,
  expectedKind: RecordArchiveKind,
  expectedId: string,
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
      data.current.dirty === false &&
      data.current.otherProtected === false &&
      validKind(expectedKind) &&
      data.current.kind === expectedKind &&
      sameId(data.current.resourceId, expectedId) &&
      recordArchiveContextAllows(data.binding, expectedKind)
    );
  } catch {
    return false;
  }
}
const idle: RecordArchiveSnapshot = Object.freeze({ command: null, phase: "idle", subject: null });
/** One exact archive command. A historical acknowledgement never inserts record state into the view. */
export class RecordArchiveProtocol {
  private context: string | null = null;
  private state: RecordArchiveSnapshot = idle;
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
      typeof context === "string" && context.length > 0 && context.length <= recordArchiveBodyLimit
        ? context
        : null;
    if (this.context !== next) {
      this.reset();
      this.context = next;
    }
  }
  private reset(): void {
    this.state = idle;
    this.reconciling = false;
    this.invalidClock = false;
    this.lastWall = 0;
    this.lastMonotonic = 0;
  }
  private settle(
    command: RecordArchiveCommand | null,
    phase: RecordArchivePhase,
    from: RecordArchiveCommand,
  ) {
    this.state = Object.freeze({
      command,
      phase,
      subject: Object.freeze({ kind: from.kind, resourceId: from.resourceId }),
    });
  }
  getSnapshot(): RecordArchiveSnapshot {
    return this.state;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }
  isCurrent(command: RecordArchiveCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }
  begin(
    input: { kind: RecordArchiveKind; resourceId: string; version: number },
    key: string,
  ): RecordArchiveCommand {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Resolve the earlier archive command before starting another.");
    const data = snapshot(input).value,
      parsed = parseContext(this.context);
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !parsed ||
      !validKind(data.kind) ||
      !parsed.permissions.includes(writePermission[data.kind]) ||
      !validId(data.resourceId) ||
      !validId(key) ||
      !Number.isSafeInteger(data.version) ||
      data.version < 1 ||
      data.version >= Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Archive target, revision or command clock is unavailable.");
    const command: RecordArchiveCommand = freeze({
      context: this.context,
      kind: data.kind,
      resourceId: data.resourceId,
      organizationId: parsed.organizationId,
      route: recordArchiveRoute(parsed.organizationId, data.kind, data.resourceId),
      version: data.version,
      key,
      jobKind: recordArchiveJobKinds[data.kind],
      firstWall,
      firstMonotonic,
    });
    this.reconciling = false;
    this.invalidClock = false;
    this.lastWall = firstWall;
    this.lastMonotonic = firstMonotonic;
    this.settle(command, "sending", command);
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
        wall - command.firstWall >= recordArchiveRetryWindowMs ||
        monotonic - command.firstMonotonic >= recordArchiveRetryWindowMs
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
  retry(): RecordArchiveCommand {
    const command = this.state.command;
    if (!command || this.state.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original archive command cannot be resent; its outcome remains unconfirmed.");
    this.reconciling = true;
    this.settle(command, "sending", command);
    return command;
  }
  canForget(): boolean {
    const command = this.state.command;
    return this.state.phase === "unknown" && Boolean(command && this.isCurrent(command)) && !this.canRetry();
  }
  forget(): boolean {
    if (!this.canForget()) return false;
    this.reset();
    this.state = Object.freeze({ command: null, phase: "forgotten", subject: null });
    return true;
  }
  /** Strict: 202 Job of the exact kind, succeeded, no result/error, quoted ETag above the captured version. */
  acknowledge(command: RecordArchiveCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const job = snapshot(input).value as Schema<"Job">;
      const revision = typeof etag === "string" ? /^"([1-9][0-9]{0,15})"$/.exec(etag) : null;
      const next = revision ? Number(revision[1]) : Number.NaN;
      if (
        !validJob(job) ||
        job.kind !== command.jobKind ||
        job.state !== "succeeded" ||
        (job.resultUrl ?? null) !== null ||
        (job.error ?? null) !== null ||
        !Number.isSafeInteger(next) ||
        next <= command.version
      )
        throw new Error();
      this.settle(null, "acknowledged", command);
      this.reconciling = false;
      return true;
    } catch {
      this.settle(command, "unknown", command);
      this.reconciling = true;
      return false;
    }
  }
  reject(command: RecordArchiveCommand, error: unknown): "cleared" | "unknown" | "ignored" {
    if (!this.isCurrent(command)) return "ignored";
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.bind(null);
      this.settle(null, "denied", command);
      return "cleared";
    }
    if (
      !this.reconciling &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      this.settle(
        null,
        command.kind === "contact" && error.status === 409 && error.code === "contact_has_active_leads"
          ? "blocked"
          : error.status === 404
            ? "unavailable"
            : "rejected",
        command,
      );
      return "cleared";
    }
    this.settle(command, "unknown", command);
    this.reconciling = true;
    return "unknown";
  }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Archive response unavailable.");
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
      if (bytes > recordArchiveBodyLimit) {
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
/** Sends exactly the captured route and key: POST, no body, no If-Match. */
export async function recordArchiveRequest(
  command: RecordArchiveCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value,
    parsed = parseContext(captured.context);
  if (
    !parsed ||
    !validKind(captured.kind) ||
    !validId(captured.resourceId) ||
    !validId(captured.key) ||
    !sameId(captured.organizationId, parsed.organizationId) ||
    !parsed.permissions.includes(writePermission[captured.kind]) ||
    captured.jobKind !== recordArchiveJobKinds[captured.kind] ||
    captured.route !== recordArchiveRoute(captured.organizationId, captured.kind, captured.resourceId) ||
    !Number.isSafeInteger(captured.version) ||
    captured.version < 1 ||
    captured.version >= Number.MAX_SAFE_INTEGER ||
    !validCsrf(csrf) ||
    csrf !== parsed.csrf
  )
    throw new Error("The original archive command is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch("/api" + captured.route, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: { "X-CSRF-Token": csrf, "Idempotency-Key": captured.key },
    });
    if (!response.ok) {
      let code = "record_archive_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (!validProblem(problem) || problem.status !== response.status) throw new Error();
        code = problem.code;
      } catch {
        if (![401, 403].includes(response.status))
          throw new Error("The archive outcome could not be verified.");
      }
      throw new ApiError(response.status, "The archive command could not be verified.", code);
    }
    if (response.status !== 202) throw new Error("Archive response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
