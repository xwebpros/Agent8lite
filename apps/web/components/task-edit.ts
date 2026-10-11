import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export const taskEditBodyLimit = 64 * 1024;
export const taskEditRetryWindowMs = 23 * 60 * 60 * 1000;
export type TaskEditCommand = Readonly<{
  context: string;
  taskId: string;
  originalTask: Readonly<Schema<"Task">>;
  version: number;
  key: string;
  ifMatch: string;
  body: Readonly<Schema<"TaskWrite">>;
  serializedBody: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type TaskEditSnapshot = Readonly<{
  command: TaskEditCommand | null;
  phase: "idle" | "sending" | "unknown" | "acknowledged" | "conflict" | "rejected" | "denied" | "forgotten";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Task.properties.id);
const validBody = ajv.compile<Schema<"TaskWrite">>(contract.components.schemas.TaskWrite);
const validTask = ajv.compile<Schema<"Task">>(contract.components.schemas.Task);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Serialize only a bounded detached own-data tree, never original or inherited hooks. */
export function copyTaskEditData<T>(input: T): { value: T; json: string } {
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
    if (!json || new TextEncoder().encode(json).byteLength > taskEditBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Task update data could not be verified.");
  }
}
const snapshot = copyTaskEditData;
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
function matchingRevision(value: unknown, version: number): value is string {
  if (typeof value !== "string" || value.length > 30) return false;
  const match = /^(?:"([0-9]+)"|([0-9]+))$/.exec(value);
  return Boolean(
    match && Number(match[1] ?? match[2]) === version && Number.isSafeInteger(version) && version > 0,
  );
}
export function validTaskEditTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
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
export function requireTaskEditWrite(input: unknown): Readonly<Schema<"TaskWrite">> {
  const data = snapshot(input).value;
  if (
    !validBody(data) ||
    !data.title.trim() ||
    !validTaskEditTimezone(data.timezone) ||
    !Number.isFinite(new Date(data.dueAt).getTime())
  )
    throw new Error("Task input or timing could not be verified.");
  return freeze(data);
}
export function requireTaskEditTask(input: unknown): Readonly<Schema<"Task">> {
  const data = snapshot(input).value;
  if (
    !validTask(data) ||
    !Number.isSafeInteger(data.version) ||
    !data.title.trim() ||
    !validTaskEditTimezone(data.timezone) ||
    !Number.isFinite(new Date(data.dueAt).getTime())
  )
    throw new Error("The task receipt could not be verified.");
  return freeze(data);
}
type TaskEditContextInput = {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
};
export function taskEditContext(input: TaskEditContextInput): string | null {
  return contextBinding(input, "crm.tasks.write");
}
export function taskEditReadContext(input: TaskEditContextInput): string | null {
  return contextBinding(input, "crm.tasks.read");
}
function contextBinding(input: TaskEditContextInput, permission: string): string | null {
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
export type TaskEditCurrent = Readonly<{
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
  taskId: string | null;
}>;
export function taskEditEligible(
  binding: string | null,
  current: TaskEditCurrent,
  expectedTaskId?: string,
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
      validId(data.current.taskId) &&
      (expectedTaskId === undefined || sameId(data.current.taskId, expectedTaskId)) &&
      data.current.dirty === false &&
      data.current.otherProtected === false
    );
  } catch {
    return false;
  }
}
/** One exact command. Historical acknowledgment never inserts a historical Task into the current view. */
export class TaskEditProtocol {
  private context: string | null = null;
  private state: TaskEditSnapshot = Object.freeze({ command: null, phase: "idle" });
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
      typeof context === "string" && context.length > 0 && context.length <= taskEditBodyLimit
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
  getSnapshot(): TaskEditSnapshot {
    return this.state;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }
  isCurrent(command: TaskEditCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }
  begin(
    input: { task: Schema<"Task">; body: Schema<"TaskWrite">; ifMatch?: string },
    key: string,
  ): TaskEditCommand {
    if (!this.context || this.state.command || this.state.phase === "forgotten")
      throw new Error("Resolve the earlier task update command before starting another.");
    const data = snapshot(input).value;
    const task = requireTaskEditTask(data.task),
      body = requireTaskEditWrite(data.body);
    const ifMatch = Object.hasOwn(data, "ifMatch") ? data.ifMatch : `"${task.version}"`;
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !validId(key) ||
      task.version >= Number.MAX_SAFE_INTEGER ||
      !matchingRevision(ifMatch, task.version) ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Task update, revision or command clock is unavailable.");
    const command = freeze({
      context: this.context,
      taskId: task.id,
      originalTask: task,
      version: task.version,
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
        wall - command.firstWall >= taskEditRetryWindowMs ||
        monotonic - command.firstMonotonic >= taskEditRetryWindowMs
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
  retry(): TaskEditCommand {
    const command = this.state.command;
    if (!command || this.state.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original task update command cannot be resent; its outcome remains unconfirmed.");
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
  acknowledge(command: TaskEditCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const task = requireTaskEditTask(input),
        body = command.body,
        original = command.originalTask;
      if (
        !sameId(task.id, command.taskId) ||
        task.version !== command.version + 1 ||
        etag !== `"${task.version}"` ||
        !sameId(task.assigneeMemberId, body.assigneeMemberId) ||
        task.title !== body.title.trim() ||
        task.timezone !== body.timezone ||
        new Date(task.dueAt).getTime() !== new Date(body.dueAt).getTime() ||
        (task.description ?? null) !==
          (Object.hasOwn(body, "description") ? body.description : (original.description ?? null)) ||
        task.priority !== (body.priority ?? original.priority) ||
        task.state !== (body.state ?? original.state) ||
        ((Object.hasOwn(body, "leadId") ? body.leadId : original.leadId) == null
          ? task.leadId != null
          : !sameId(task.leadId, Object.hasOwn(body, "leadId") ? body.leadId : original.leadId))
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
  reject(command: TaskEditCommand, error: unknown): "cleared" | "unknown" | "ignored" {
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
  if (!reader) throw new Error("Task update response unavailable.");
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
      if (bytes > taskEditBodyLimit) {
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
export async function taskEditRequest(
  organizationId: string,
  command: TaskEditCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value;
  const original = requireTaskEditTask(captured.originalTask);
  if (
    !validId(organizationId) ||
    !validId(captured.taskId) ||
    !validId(captured.key) ||
    typeof captured.context !== "string" ||
    !captured.context ||
    typeof csrf !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(csrf) ||
    !Number.isSafeInteger(captured.version) ||
    captured.version < 1 ||
    captured.version >= Number.MAX_SAFE_INTEGER ||
    !sameId(original.id, captured.taskId) ||
    original.version !== captured.version ||
    !matchingRevision(captured.ifMatch, captured.version) ||
    snapshot(requireTaskEditWrite(captured.body)).json !== captured.serializedBody
  )
    throw new Error("The original task update command is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" + encodeURIComponent(organizationId) + "/tasks/" + encodeURIComponent(captured.taskId),
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
      let code = "task_edit_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (!validProblem(problem) || problem.status !== response.status) throw new Error();
        code = problem.code;
      } catch {
        if (![401, 403].includes(response.status))
          throw new Error("The task update outcome could not be verified.");
      }
      throw new ApiError(response.status, "The task update command could not be verified.", code);
    }
    if (response.status !== 200) throw new Error("Task update response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
