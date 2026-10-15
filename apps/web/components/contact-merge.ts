import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

/** ADR-049 recoverable Contact merge: one immutable command, strict historical acknowledgement.
 * Withdrawal-wins consent is enforced server-side. Phone-only match requires explicit acknowledgement. */
export const contactMergeBodyLimit = 64 * 1024;
export const contactMergeRetryWindowMs = 23 * 60 * 60 * 1000;
export const contactMergeJobKind = "crm.contact.merged" as const;

export type ContactMergeCommand = Readonly<{
  context: string;
  survivorId: string;
  sourceId: string;
  organizationId: string;
  route: string;
  survivorVersion: number;
  sourceVersion: number;
  acknowledgePhoneOnly: boolean;
  key: string;
  firstWall: number;
  firstMonotonic: number;
}>;

export type ContactMergePhase =
  | "idle"
  | "sending"
  | "unknown"
  | "acknowledged"
  | "phone_only_warning"
  | "blocked"
  | "unavailable"
  | "rejected"
  | "denied"
  | "forgotten";

export type ContactMergeSnapshot = Readonly<{
  command: ContactMergeCommand | null;
  phase: ContactMergePhase;
  subject: Readonly<{ survivorId: string; sourceId: string }> | null;
}>;

const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:contact-merge",
  components: {
    schemas: {
      Job: contract.components.schemas.Job,
      Problem: contract.components.schemas.Problem,
    },
  },
});
const validJob = ajv.compile<Schema<"Job">>({ $ref: "estate:contact-merge#/components/schemas/Job" });
const validProblem = ajv.compile<Schema<"Problem">>({
  $ref: "estate:contact-merge#/components/schemas/Problem",
});
const validId = ajv.compile(contract.components.schemas.Contact.properties.id);

/** Serialize only a bounded detached own-data tree, never original or inherited hooks. */
export function copyContactMergeData<T>(input: T): { value: T; json: string } {
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
    if (!json || new TextEncoder().encode(json).byteLength > contactMergeBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Merge data could not be verified.");
  }
}

const snapshot = copyContactMergeData;

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

function validCsrf(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value);
}

export function contactMergeRoute(organizationId: string, survivorId: string): string {
  if (!validId(organizationId) || !validId(survivorId))
    throw new Error("Merge route identity is unavailable.");
  return (
    "/v1/orgs/" +
    encodeURIComponent(organizationId) +
    "/contacts/" +
    encodeURIComponent(survivorId) +
    "/merges"
  );
}

type ContactMergeContextInput = {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
};

/** Verified user/org/member/CSRF/access-revision binding; requires crm.contacts.write. */
export function contactMergeContext(input: ContactMergeContextInput): string | null {
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
      !session.permissions.includes("crm.contacts.write")
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
    if (typeof context !== "string" || !context || context.length > contactMergeBodyLimit) return null;
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

export function contactMergeContextAllows(context: string | null): boolean {
  const parsed = parseContext(context);
  return Boolean(parsed && parsed.permissions.includes("crm.contacts.write"));
}

export type ContactMergeCurrent = Readonly<{
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

export function contactMergeEligible(
  binding: string | null,
  current: ContactMergeCurrent,
  expectedSurvivorId: string,
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
      data.current.kind === "contact" &&
      sameId(data.current.resourceId, expectedSurvivorId) &&
      contactMergeContextAllows(data.binding)
    );
  } catch {
    return false;
  }
}

const idle: ContactMergeSnapshot = Object.freeze({ command: null, phase: "idle", subject: null });

/** One exact merge command. A historical acknowledgement never inserts record state into the view. */
export class ContactMergeProtocol {
  private context: string | null = null;
  private state: ContactMergeSnapshot = idle;
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
      typeof context === "string" && context.length > 0 && context.length <= contactMergeBodyLimit
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

  private settle(command: ContactMergeCommand | null, phase: ContactMergePhase, from: ContactMergeCommand) {
    this.state = Object.freeze({
      command,
      phase,
      subject: Object.freeze({ survivorId: from.survivorId, sourceId: from.sourceId }),
    });
  }

  getSnapshot(): ContactMergeSnapshot {
    return this.state;
  }

  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }

  isCurrent(command: ContactMergeCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }

  begin(
    input: {
      survivorId: string;
      sourceId: string;
      survivorVersion: number;
      sourceVersion: number;
      acknowledgePhoneOnly?: boolean;
    },
    key: string,
  ): ContactMergeCommand {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Resolve the earlier merge command before starting another.");
    const data = snapshot(input).value,
      parsed = parseContext(this.context);
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !parsed ||
      !parsed.permissions.includes("crm.contacts.write") ||
      !validId(data.survivorId) ||
      !validId(data.sourceId) ||
      !validId(key) ||
      !Number.isSafeInteger(data.survivorVersion) ||
      data.survivorVersion < 1 ||
      data.survivorVersion >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(data.sourceVersion) ||
      data.sourceVersion < 1 ||
      data.sourceVersion >= Number.MAX_SAFE_INTEGER ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Merge target, revision or command clock is unavailable.");

    const command: ContactMergeCommand = freeze({
      context: this.context,
      survivorId: (data.survivorId as string).toLowerCase(),
      sourceId: (data.sourceId as string).toLowerCase(),
      organizationId: parsed.organizationId,
      route: contactMergeRoute(parsed.organizationId, data.survivorId as string),
      survivorVersion: data.survivorVersion as number,
      sourceVersion: data.sourceVersion as number,
      acknowledgePhoneOnly: data.acknowledgePhoneOnly === true,
      key,
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

  /** Pause to show the phone-only acknowledgement warning without beginning a new send. */
  showPhoneOnlyWarning(input: {
    survivorId: string;
    sourceId: string;
    survivorVersion: number;
    sourceVersion: number;
  }): void {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Cannot show phone-only warning: another command is pending.");
    const data = snapshot(input).value;
    const fakeSurvivor = data.survivorId as string;
    const fakeSource = data.sourceId as string;
    if (!validId(fakeSurvivor) || !validId(fakeSource))
      throw new Error("Phone-only warning: invalid contact IDs.");
    // Synthesize a minimal sentinel command for the warning state (will not be sent as-is)
    const parsed = parseContext(this.context);
    if (!parsed) throw new Error("Phone-only warning: binding is unavailable.");
    const sentinel = freeze({
      context: this.context,
      survivorId: fakeSurvivor.toLowerCase(),
      sourceId: fakeSource.toLowerCase(),
      organizationId: parsed.organizationId,
      route: contactMergeRoute(parsed.organizationId, fakeSurvivor),
      survivorVersion: data.survivorVersion as number,
      sourceVersion: data.sourceVersion as number,
      acknowledgePhoneOnly: false,
      key: "",
      firstWall: 0,
      firstMonotonic: 0,
    });
    this.state = Object.freeze({
      command: null,
      phase: "phone_only_warning",
      subject: Object.freeze({ survivorId: sentinel.survivorId, sourceId: sentinel.sourceId }),
    });
  }

  dismissPhoneOnlyWarning(): void {
    if (this.state.phase === "phone_only_warning") this.reset();
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
        wall - command.firstWall >= contactMergeRetryWindowMs ||
        monotonic - command.firstMonotonic >= contactMergeRetryWindowMs
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

  retry(): ContactMergeCommand {
    const command = this.state.command;
    if (!command || this.state.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original merge command cannot be resent; its outcome remains unconfirmed.");
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

  /** Strict: 202 Job, kind=crm.contact.merged, succeeded, resultUrl present, ETag above survivor version. */
  acknowledge(command: ContactMergeCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const job = snapshot(input).value as Schema<"Job">;
      const revision = typeof etag === "string" ? /^"([1-9][0-9]{0,15})"$/.exec(etag) : null;
      const next = revision ? Number(revision[1]) : Number.NaN;
      if (
        !validJob(job) ||
        job.kind !== contactMergeJobKind ||
        job.state !== "succeeded" ||
        typeof job.resultUrl !== "string" ||
        !job.resultUrl ||
        (job.error ?? null) !== null ||
        !Number.isSafeInteger(next) ||
        next <= command.survivorVersion
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

  reject(command: ContactMergeCommand, error: unknown): "cleared" | "unknown" | "ignored" {
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
      let phase: ContactMergePhase = "rejected";
      if (error.status === 404) phase = "unavailable";
      else if (error.status === 409 && error.code === "merge_phone_only_unacknowledged")
        phase = "phone_only_warning";
      else if (error.status === 409) phase = "blocked";
      this.settle(null, phase, command);
      return "cleared";
    }
    this.settle(command, "unknown", command);
    this.reconciling = true;
    return "unknown";
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Merge response unavailable.");
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
      if (bytes > contactMergeBodyLimit) {
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

/** Sends exactly the captured route and body: POST with Idempotency-Key, X-CSRF-Token, If-Match. */
export async function contactMergeRequest(
  command: ContactMergeCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value,
    parsed = parseContext(captured.context);
  if (
    !parsed ||
    !parsed.permissions.includes("crm.contacts.write") ||
    !validId(captured.survivorId) ||
    !validId(captured.sourceId) ||
    !sameId(captured.organizationId, parsed.organizationId) ||
    captured.route !== contactMergeRoute(captured.organizationId, captured.survivorId) ||
    !validId(captured.key) ||
    !Number.isSafeInteger(captured.survivorVersion) ||
    captured.survivorVersion < 1 ||
    captured.survivorVersion >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(captured.sourceVersion) ||
    captured.sourceVersion < 1 ||
    captured.sourceVersion >= Number.MAX_SAFE_INTEGER ||
    !validCsrf(csrf) ||
    csrf !== parsed.csrf
  )
    throw new Error("The original merge command is unavailable.");

  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);

  try {
    const body = JSON.stringify({
      sourceContactId: captured.sourceId,
      sourceVersion: captured.sourceVersion,
      ...(captured.acknowledgePhoneOnly ? { acknowledgePhoneOnly: true } : {}),
    });
    const response = await fetch("/api" + captured.route, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        "Idempotency-Key": captured.key,
        "If-Match": `"${captured.survivorVersion}"`,
      },
      body,
    });
    if (!response.ok) {
      let code = "contact_merge_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (!validProblem(problem) || problem.status !== response.status) throw new Error();
        code = problem.code;
      } catch {
        if (![401, 403].includes(response.status))
          throw new Error("The merge outcome could not be verified.");
      }
      throw new ApiError(response.status, "The merge command could not be verified.", code);
    }
    if (response.status !== 202) throw new Error("Merge response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
