import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export type NotificationReadCommand = Readonly<{
  binding: string;
  notificationId: string;
  idempotencyKey: string;
}>;
export interface NotificationClient {
  list(cursor?: string | null): Promise<unknown>;
  markRead(command: NotificationReadCommand): Promise<unknown>;
}
export type NotificationState = Readonly<{
  online: boolean;
  canRead: boolean;
  canWrite: boolean;
  page: Schema<"PageNotification"> | null;
  pageStale: boolean;
  reading: boolean;
  pending: NotificationReadCommand | null;
  phase: "idle" | "sending" | "uncertain" | "denied" | "unavailable";
  error: string;
  message: string;
}>;
export const notificationPageSize = 50;
export const notificationRowLimit = 200;
export const notificationResponseLimit = 256 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:member-notifications",
  components: {
    schemas: {
      Notification: contract.components.schemas.Notification,
      PageNotification: contract.components.schemas.PageNotification,
    },
  },
});
const validNotification = ajv.compile<Schema<"Notification">>({
  $ref: "estate:member-notifications#/components/schemas/Notification",
});
const validPage = ajv.compile<Schema<"PageNotification">>({
  $ref: "estate:member-notifications#/components/schemas/PageNotification",
});
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);
const validId = ajv.compile(contract.components.schemas.Notification.properties.id);

/** Private detached snapshots never invoke accessors or prototype serialization hooks. */
function snapshot<T>(value: T, maximum = notificationResponseLimit): T {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 12) throw new Error();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string" && !/[\uD800-\uDFFF]/u.test(item)) return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 1001 || (array && (item.length > 1000 || keys.length !== item.length + 1)))
      throw new Error();
    const clone = array ? Object.setPrototypeOf(new Array(item.length), null) : Object.create(null);
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(clone, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    ancestors.delete(item);
    return clone;
  };
  try {
    const json = JSON.stringify(copy(value, 0));
    if (!json || new TextEncoder().encode(json).byteLength > maximum) throw new Error();
    return JSON.parse(json, (_key, item: unknown) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item))
        Object.setPrototypeOf(item, null);
      return item;
    }) as T;
  } catch {
    throw new Error("Notification data could not be verified within its private memory limits.");
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Notification links select an existing member view; they confer no resource authority. */
export function safeNotificationHref(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\s\u0000-\u001f\u007f]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|2e|2f|5c|25)/i.test(value)
  )
    return null;
  try {
    if (/[\\\u0000-\u0020\u007f]/.test(decodeURIComponent(value))) return null;
    const url = new URL(value, "https://estate.invalid");
    if (
      url.origin !== "https://estate.invalid" ||
      !/^\/(?:dashboard|contacts|pipeline|tasks|properties|websites|campaigns|notifications|settings)?$/.test(
        url.pathname,
      ) ||
      url.pathname + url.search + url.hash !== value
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function requireNotification(value: unknown, expectedId?: string): Schema<"Notification"> {
  const result = snapshot(value);
  if (
    !validNotification(result) ||
    !result.kind.trim() ||
    !result.title.trim() ||
    /[\u0000-\u001f\u007f]/u.test(result.kind + result.title) ||
    (expectedId !== undefined && result.id !== expectedId) ||
    (result.href !== undefined && safeNotificationHref(result.href) === null)
  )
    throw new Error("The member notification could not be verified.");
  return frozen(result);
}
export function requireNotificationPage(value: unknown): Schema<"PageNotification"> {
  const result = snapshot(value);
  if (
    !validPage(result) ||
    result.items.length > notificationPageSize ||
    result.hasMore !== Boolean(result.nextCursor) ||
    (result.hasMore && !result.items.length) ||
    new Set(result.items.map((item) => item.id)).size !== result.items.length
  )
    throw new Error("The member notification page could not be verified.");
  for (const item of result.items) requireNotification(item);
  return frozen(result);
}
export function notificationContextBinding(input: {
  session: Schema<"Session">;
  memberId: string;
  csrf: string;
  accessRevision: number;
}): string {
  const session = input.session;
  return [
    session.userId,
    session.activeOrgId || "",
    input.memberId,
    input.csrf,
    String(input.accessRevision),
    ...[...session.permissions].sort(),
  ]
    .map((value) => String(value.length) + ":" + value)
    .join("|");
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Notification response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error("Notification response is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}
/** No private persistence, automatic resend or unbounded response parsing. */
export async function notificationRequest(
  path: string,
  options: RequestInit = {},
  expectedStatus = 200,
): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20000);
  try {
    const response = await fetch("/api" + path, {
      ...options,
      signal: abort.signal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      let code = "notification_request_failed";
      try {
        const problem = snapshot(await boundedJson(response, 64 * 1024), 64 * 1024);
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        // Preserve the actual HTTP denial even if its body is malformed or unavailable.
      }
      throw new ApiError(response.status, "The notification request could not be completed.", code);
    }
    if (response.status !== expectedStatus) throw new Error("Notification receipt status is unexpected.");
    return await boundedJson(response, notificationResponseLimit);
  } finally {
    clearTimeout(timer);
  }
}

export class NotificationController {
  private state: NotificationState;
  private readonly listeners = new Set<() => void>();
  private readonly cursors = new Set<string>();
  private generation = 0;
  private readEpoch = 0;
  private writing = false;
  private detached = false;
  private revoked = false;
  constructor(
    private readonly options: {
      binding: string;
      client: NotificationClient;
      online: boolean;
      canRead: boolean;
      canWrite: boolean;
      createKey(): string;
      isCurrent?(): boolean;
      onProtectedChange?(value: boolean): void;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = frozen({
      online: options.online,
      canRead: options.canRead,
      canWrite: options.canWrite,
      page: null,
      pageStale: false,
      reading: false,
      pending: null,
      phase: options.canRead ? "idle" : "denied",
      error: "",
      message: "Read a notification without changing its linked record.",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  isProtected = () => this.writing || Boolean(this.state.pending);
  private update(patch: Partial<NotificationState>) {
    this.state = frozen({ ...this.state, ...patch });
    this.options.onProtectedChange?.(this.isProtected());
    for (const listener of this.listeners) listener();
  }
  private active() {
    return (
      !this.detached &&
      !this.revoked &&
      this.state.online &&
      this.state.canRead &&
      this.options.isCurrent?.() !== false
    );
  }
  private clearRows() {
    ++this.generation;
    ++this.readEpoch;
    this.cursors.clear();
    this.writing = false;
    this.update({
      page: null,
      pageStale: false,
      reading: false,
      phase: this.state.pending ? "uncertain" : this.state.phase,
    });
  }
  attach() {
    if (this.revoked) return;
    this.detached = false;
    this.options.onProtectedChange?.(this.isProtected());
  }
  detach() {
    this.detached = true;
    this.clearRows();
  }
  revoke() {
    this.revoked = true;
    this.clearRows();
    this.update({
      pending: null,
      canRead: false,
      canWrite: false,
      phase: "denied",
      error: "Notification access changed. Refresh workspace access before reopening notifications.",
      message: "",
    });
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    if (!online) this.clearRows();
    this.update({ online });
  }
  setPermissions(canRead: boolean, canWrite: boolean) {
    if (this.revoked) return;
    if (canRead === this.state.canRead && canWrite === this.state.canWrite) return;
    this.clearRows();
    this.update({ pending: null, canRead, canWrite, phase: canRead ? "idle" : "denied" });
  }
  /** Focus/visibility invalidates private projections while retaining an unresolved same-session key. */
  invalidate() {
    this.clearRows();
  }
  async loadPage(append = false) {
    if (!this.active() || this.writing || this.state.reading) return;
    const previous = this.state.page;
    const cursor = append ? previous?.nextCursor : null;
    if (append && (!previous?.hasMore || !cursor || previous.items.length >= notificationRowLimit)) return;
    const generation = this.generation;
    const epoch = ++this.readEpoch;
    const current = () => generation === this.generation && epoch === this.readEpoch && this.active();
    this.update({ reading: true, error: "", pageStale: Boolean(previous) });
    try {
      const page = requireNotificationPage(await this.options.client.list(cursor));
      if (!current()) return;
      const items = append && previous ? [...previous.items, ...page.items] : [...page.items];
      if (
        items.length > notificationRowLimit ||
        new Set(items.map((item) => item.id)).size !== items.length ||
        (page.nextCursor && (page.nextCursor === cursor || (append && this.cursors.has(page.nextCursor))))
      )
        throw new Error("Notification pagination changed. Refresh the notification list.");
      if (!append) this.cursors.clear();
      if (cursor) this.cursors.add(cursor);
      this.update({
        page: frozen(snapshot({ ...page, items }, 1024 * 1024)),
        pageStale: false,
        phase: this.state.pending ? "uncertain" : "idle",
        message: this.state.pending
          ? "A read command is still unconfirmed. Reconcile it with its original key."
          : "Only notifications owned by your current membership appear here.",
      });
    } catch (error) {
      if (!current()) return;
      if (this.denied(error)) return;
      this.update({
        page: null,
        pageStale: false,
        phase: this.state.pending ? "uncertain" : "unavailable",
        error: "Notifications are unavailable. Refresh to retry; no empty list has been inferred.",
      });
      this.cursors.clear();
    } finally {
      if (current()) this.update({ reading: false });
    }
  }
  private denied(error: unknown) {
    if (!(error instanceof ApiError && [401, 403].includes(error.status))) return false;
    this.revoke();
    this.options.onAccessRevoked?.();
    return true;
  }
  async markRead(id: string) {
    if (!this.active() || !this.state.canWrite || this.writing || this.state.pending || this.state.reading)
      return;
    const row = this.state.page?.items.find((item) => item.id === id);
    if (!row || row.readAt || !validId(id)) return;
    let key: string;
    try {
      key = this.options.createKey();
    } catch {
      this.update({ error: "A safe command key could not be created. Retry when available." });
      return;
    }
    if (typeof key !== "string" || !validId(key)) {
      this.update({ error: "A safe command key could not be created. Retry when available." });
      return;
    }
    const command = frozen({ binding: this.options.binding, notificationId: id, idempotencyKey: key });
    this.update({ pending: command });
    await this.send(command, false);
  }
  async reconcile() {
    if (!this.active() || !this.state.canWrite || this.writing || this.state.reading || !this.state.pending)
      return;
    await this.send(this.state.pending, true);
  }
  private async send(command: NotificationReadCommand, uncertain: boolean) {
    if (command.binding !== this.options.binding) return;
    this.writing = true;
    ++this.readEpoch;
    const generation = this.generation;
    const current = () => generation === this.generation && this.active() && this.state.pending === command;
    this.update({ phase: "sending", error: "", message: "Awaiting the read receipt…" });
    try {
      const receipt = requireNotification(
        await this.options.client.markRead(command),
        command.notificationId,
      );
      if (!current()) return;
      if (!receipt.readAt) throw new Error("The notification read timestamp is unconfirmed.");
      const page = this.state.page;
      this.writing = false;
      this.update({
        pending: null,
        page: page
          ? frozen({
              ...page,
              items: page.items.map((item) =>
                item.id === receipt.id ? frozen(snapshot({ ...item, readAt: receipt.readAt })) : item,
              ),
            })
          : null,
        phase: "idle",
        message: "Notification marked read. Its linked record was not changed.",
      });
    } catch (error) {
      if (!current()) return;
      if (this.denied(error)) return;
      this.writing = false;
      const rejected =
        !uncertain &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408;
      this.update({
        pending: rejected ? null : command,
        phase: rejected ? "unavailable" : "uncertain",
        error: rejected
          ? "The read command was rejected. Refresh notifications before trying again."
          : "The read result is unconfirmed. Reconcile with the same command; do not submit another key.",
        message: "",
      });
    }
  }
}
