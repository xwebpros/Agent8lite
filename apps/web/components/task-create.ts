import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export const taskCreateBodyLimit = 64 * 1024;
export const taskCreateRetryWindowMs = 23 * 60 * 60 * 1000;
export type TaskCreateCommand = Readonly<{
  context: string;
  key: string;
  body: Readonly<Schema<"TaskWrite">>;
  serializedBody: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type TaskCreateSnapshot = Readonly<{
  command: TaskCreateCommand | null;
  phase: "idle" | "sending" | "unknown" | "acknowledged" | "rejected" | "denied" | "forgotten";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Task.properties.id);
const validWrite = ajv.compile<Schema<"TaskWrite">>(contract.components.schemas.TaskWrite);
const validTask = ajv.compile<Schema<"Task">>(contract.components.schemas.Task);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Detach own JSON data before serialization; never execute original or inherited hooks. */
function snapshot<T>(input: T): { value: T; json: string } {
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
    if (!json || new TextEncoder().encode(json).byteLength > taskCreateBodyLimit) throw new Error();
    return {
      value: JSON.parse(json, (_key, child: unknown) => {
        if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
        return child;
      }) as T,
      json,
    };
  } catch {
    throw new Error("Task creation data could not be verified.");
  }
}
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
function validTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 80 ||
    value.trim() !== value ||
    // Same named-zone boundary as the server (task-create/patch-command.ts namedTimezone).
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
export function requireTaskCreateWrite(input: unknown): Readonly<Schema<"TaskWrite">> {
  const data = snapshot(input).value;
  if (
    !validWrite(data) ||
    !data.title.trim() ||
    !validTimezone(data.timezone) ||
    !Number.isFinite(new Date(data.dueAt).getTime())
  )
    throw new Error("Task input or its time zone is unavailable.");
  return freeze(data);
}
export function requireTaskCreateTask(input: unknown): Readonly<Schema<"Task">> {
  const data = snapshot(input).value;
  if (
    !validTask(data) ||
    !Number.isSafeInteger(data.version) ||
    !data.title.trim() ||
    !validTimezone(data.timezone) ||
    !Number.isFinite(new Date(data.dueAt).getTime())
  )
    throw new Error("The task receipt could not be verified.");
  return freeze(data);
}
/** Trusted device-local conversion happens once, before the first command is captured. */
export function captureTaskCreateTiming(
  entered: string,
  resolver: (value: string) => { dueAt: string; timezone: string },
): Readonly<{ dueAt: string; timezone: string }> {
  if (
    typeof entered !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(entered) ||
    typeof resolver !== "function"
  )
    throw new Error("Enter a valid device-local due date and time.");
  const year = Number(entered.slice(0, 4)),
    month = Number(entered.slice(5, 7)),
    day = Number(entered.slice(8, 10));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    Number(entered.slice(11, 13)) > 23 ||
    Number(entered.slice(14, 16)) > 59 ||
    (entered.length > 16 && Number(entered.slice(17, 19)) > 59)
  )
    throw new Error("Enter a valid device-local due date and time.");
  const timing = snapshot(resolver(entered)).value;
  if (
    Object.keys(timing).length !== 2 ||
    typeof timing.dueAt !== "string" ||
    !validTimezone(timing.timezone) ||
    !Number.isFinite(new Date(timing.dueAt).getTime()) ||
    new Date(timing.dueAt).toISOString() !== timing.dueAt
  )
    throw new Error("The converted due instant or time zone is unavailable.");
  return freeze(timing);
}
export function taskCreateContext(input: {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
}): string | null {
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
      !session.permissions.includes("crm.tasks.write")
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
export type TaskCreateCurrent = Readonly<{
  binding: string | null;
  active: boolean;
  online: boolean;
  visible: boolean;
  changingOrganization: boolean;
  busy: boolean;
  loading: boolean;
  detailLoading: boolean;
  modal: "task" | "lead" | null;
  otherProtected: boolean;
}>;
export function taskCreateEligible(binding: string | null, current: TaskCreateCurrent): boolean {
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
      data.current.modal === "task" &&
      data.current.otherProtected === false
    );
  } catch {
    return false;
  }
}
/** A durable receipt acknowledges historical creation, never replaces a current Task. */
export class TaskCreateProtocol {
  private context: string | null = null;
  private state: TaskCreateSnapshot = Object.freeze({ command: null, phase: "idle" });
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
      typeof context === "string" && context.length > 0 && context.length <= taskCreateBodyLimit
        ? context
        : null;
    if (next !== this.context) {
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
  getSnapshot(): TaskCreateSnapshot {
    return this.state;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }
  isCurrent(command: TaskCreateCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }
  begin(input: Schema<"TaskWrite">, key: string): TaskCreateCommand {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Resolve the earlier task creation before starting another.");
    const body = requireTaskCreateWrite(input),
      firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !validId(key) ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Task command key or clock is unavailable.");
    const command = freeze({
      context: this.context,
      key,
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
        wall - command.firstWall >= taskCreateRetryWindowMs ||
        monotonic - command.firstMonotonic >= taskCreateRetryWindowMs
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
  retry(): TaskCreateCommand {
    const command = this.state.command;
    if (!command || this.state.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original task command cannot be resent; its outcome remains unconfirmed.");
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
  acknowledge(command: TaskCreateCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const task = requireTaskCreateTask(input),
        body = command.body;
      if (
        task.version !== 1 ||
        etag !== '"1"' ||
        !sameId(task.assigneeMemberId, body.assigneeMemberId) ||
        ((body.leadId ?? null) === null ? task.leadId != null : !sameId(task.leadId, body.leadId)) ||
        task.title !== body.title.trim() ||
        (task.description ?? null) !== (body.description ?? null) ||
        task.timezone !== body.timezone ||
        new Date(task.dueAt).getTime() !== new Date(body.dueAt).getTime() ||
        task.priority !== (body.priority ?? "normal") ||
        task.state !== (body.state ?? "open")
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
  reject(command: TaskCreateCommand, error: unknown): "cleared" | "unknown" | "ignored" {
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
      this.state = Object.freeze({ command: null, phase: "rejected" });
      return "cleared";
    }
    this.state = Object.freeze({ command, phase: "unknown" });
    this.reconciling = true;
    return "unknown";
  }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Task response unavailable.");
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
      if (bytes > taskCreateBodyLimit) {
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
export async function taskCreateRequest(
  organizationId: string,
  command: TaskCreateCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value;
  if (
    !validId(organizationId) ||
    !validId(captured.key) ||
    typeof captured.context !== "string" ||
    !captured.context ||
    typeof csrf !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(csrf) ||
    snapshot(requireTaskCreateWrite(captured.body)).json !== captured.serializedBody
  )
    throw new Error("The original task command is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch("/api/v1/orgs/" + encodeURIComponent(organizationId) + "/tasks", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, "Idempotency-Key": captured.key },
      body: captured.serializedBody,
    });
    if (!response.ok) {
      let code = "task_create_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Never display unverified/private response text. */
      }
      throw new ApiError(response.status, "The task creation could not be verified.", code);
    }
    if (response.status !== 201) throw new Error("Task response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
