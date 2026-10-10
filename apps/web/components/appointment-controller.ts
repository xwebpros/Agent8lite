import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export interface AppointmentClient {
  list(cursor?: string | null, signal?: AbortSignal): Promise<unknown>;
}
export type AppointmentState = Readonly<{
  online: boolean;
  canRead: boolean;
  visible: boolean;
  page: Schema<"PageAppointment"> | null;
  pageStale: boolean;
  reading: boolean;
  phase: "idle" | "denied" | "unavailable";
  error: string;
  refreshedAt: string | null;
}>;
export const appointmentPageSize = 25;
export const appointmentRowLimit = 200;
export const appointmentResponseLimit = 256 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:stored-appointments",
  components: {
    schemas: {
      Appointment: contract.components.schemas.Appointment,
      PageAppointment: contract.components.schemas.PageAppointment,
    },
  },
});
const validAppointment = ajv.compile<Schema<"Appointment">>({
  $ref: "estate:stored-appointments#/components/schemas/Appointment",
});
const validPage = ajv.compile<Schema<"PageAppointment">>({
  $ref: "estate:stored-appointments#/components/schemas/PageAppointment",
});
const validId = ajv.compile(contract.components.schemas.Appointment.properties.id);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Detach own JSON data before serialization; never invoke accessors or inherited hooks. */
function snapshot<T>(value: T, maximum = appointmentResponseLimit): T {
  const ancestors = new Set<object>();
  let count = 0;
  const copy = (input: unknown, depth: number): unknown => {
    if (++count > 10000 || depth > 12) throw new Error();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && !/[\uD800-\uDFFF]/u.test(input)) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object" || ancestors.has(input)) throw new Error();
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(input);
    if (keys.length > 1001 || (array && (input.length > 1000 || keys.length !== input.length + 1)))
      throw new Error();
    const detached = array ? Object.setPrototypeOf(new Array(input.length), null) : Object.create(null);
    ancestors.add(input);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(detached, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(input);
    return detached;
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
    throw new Error("Stored appointment data could not be verified within its private memory limits.");
  }
}
function frozen<T>(input: T): T {
  if (input && typeof input === "object") {
    for (const child of Object.values(input)) frozen(child);
    Object.freeze(input);
  }
  return input;
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
export function validAppointmentTimezone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
/** Both overlap occurrences retain their own UTC offset; never use the workstation zone. */
export function formatAppointmentInstant(instant: unknown, timezone: unknown): string | null {
  if (!canonicalInstant(instant) || !validAppointmentTimezone(timezone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    }).format(new Date(instant));
  } catch {
    return null;
  }
}
export function requireAppointment(value: unknown): Schema<"Appointment"> {
  const result = snapshot(value);
  if (
    !validAppointment(result) ||
    !canonicalInstant(result.startsAt) ||
    !canonicalInstant(result.endsAt) ||
    new Date(result.endsAt).getTime() <= new Date(result.startsAt).getTime() ||
    !validAppointmentTimezone(result.timezone)
  )
    throw new Error("Stored appointment metadata is unavailable.");
  return frozen(result);
}
export function requireAppointmentPage(value: unknown): Schema<"PageAppointment"> {
  const result = snapshot(value);
  if (
    !validPage(result) ||
    result.items.length > appointmentPageSize ||
    result.hasMore !== Boolean(result.nextCursor) ||
    (result.hasMore && !result.items.length) ||
    result.items.some((item, index) => index > 0 && item.id <= result.items[index - 1].id)
  )
    throw new Error("The stored appointment page could not be verified.");
  for (const item of result.items) requireAppointment(item);
  return frozen(result);
}
export function appointmentContextBinding(input: {
  session: Schema<"Session">;
  memberId: string;
  accessRevision: number;
}): string {
  return [
    input.session.userId,
    input.session.activeOrgId || "",
    input.memberId,
    String(input.accessRevision),
    ...[...input.session.permissions].sort(),
  ]
    .map((part) => part.length + ":" + part)
    .join("|");
}
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Stored appointment response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error("Stored appointment response exceeds its private memory limit.");
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
/** The frozen read accepts only cursor and limit; no owner/date/scope filters are added. */
export async function appointmentRequest(
  organizationId: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !validId(organizationId) ||
    (cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== "string" || !cursor || cursor.length > 4096))
  )
    throw new Error("Stored appointment request context is invalid.");
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" +
        encodeURIComponent(organizationId) +
        "/appointments?limit=25" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      },
    );
    if (!response.ok) {
      let code = "appointments_request_failed";
      try {
        const problem = snapshot(await boundedJson(response, 64 * 1024), 64 * 1024);
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Keep the actual denial even when the response is malformed. */
      }
      throw new ApiError(response.status, "Stored appointments could not be read.", code);
    }
    if (response.status !== 200) throw new Error("Stored appointment response status is unexpected.");
    return await boundedJson(response, appointmentResponseLimit);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export class AppointmentController {
  private state: AppointmentState;
  private readonly listeners = new Set<() => void>();
  private readonly cursors = new Set<string>();
  private generation = 0;
  private epoch = 0;
  private detached = false;
  private revoked = false;
  private request: AbortController | null = null;
  constructor(
    private readonly options: {
      binding: string;
      client: AppointmentClient;
      online: boolean;
      canRead: boolean;
      isCurrent?(): boolean;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = frozen({
      online: options.online,
      canRead: options.canRead,
      visible: true,
      page: null,
      pageStale: false,
      reading: false,
      phase: options.canRead ? "idle" : "denied",
      error: "",
      refreshedAt: null,
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<AppointmentState>) {
    this.state = frozen({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private active() {
    return (
      !this.detached &&
      !this.revoked &&
      this.state.online &&
      this.state.visible &&
      this.state.canRead &&
      this.options.isCurrent?.() !== false
    );
  }
  private clearRows() {
    ++this.generation;
    ++this.epoch;
    this.request?.abort();
    this.request = null;
    this.cursors.clear();
    this.update({ page: null, pageStale: false, reading: false, refreshedAt: null, error: "" });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.clearRows();
  }
  invalidate() {
    this.clearRows();
  }
  revoke() {
    this.revoked = true;
    this.clearRows();
    this.update({
      canRead: false,
      phase: "denied",
      error: "Stored appointment access changed. Refresh workspace access before reopening this agenda.",
    });
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    this.clearRows();
    this.update({ online });
  }
  setVisible(visible: boolean) {
    if (visible === this.state.visible) return;
    this.clearRows();
    this.update({ visible });
  }
  setPermissions(canRead: boolean) {
    if (this.revoked || canRead === this.state.canRead) return;
    this.clearRows();
    this.update({ canRead, phase: canRead ? "idle" : "denied" });
  }
  async loadPage(append = false) {
    if (!this.active() || this.state.reading) return;
    const previous = this.state.page;
    const cursor = append ? previous?.nextCursor : null;
    if (append && (!previous?.hasMore || !cursor || previous.items.length >= appointmentRowLimit)) return;
    const generation = this.generation,
      epoch = ++this.epoch;
    const current = () => generation === this.generation && epoch === this.epoch && this.active();
    const request = new AbortController();
    this.request = request;
    this.update({ reading: true, pageStale: Boolean(previous), error: "" });
    try {
      const page = requireAppointmentPage(await this.options.client.list(cursor, request.signal));
      if (!current()) return;
      const items = append && previous ? [...previous.items, ...page.items] : [...page.items];
      if (
        items.length > appointmentRowLimit ||
        items.some((item, index) => index > 0 && item.id <= items[index - 1].id) ||
        (page.nextCursor && (page.nextCursor === cursor || (append && this.cursors.has(page.nextCursor))))
      )
        throw new Error("Stored appointment pagination changed. Refresh the current list.");
      if (!append) this.cursors.clear();
      if (cursor) this.cursors.add(cursor);
      this.update({
        page: frozen(snapshot({ ...page, items }, 1024 * 1024)),
        pageStale: false,
        phase: "idle",
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.revoke();
        this.options.onAccessRevoked?.();
        return;
      }
      this.cursors.clear();
      this.update({
        page: null,
        pageStale: false,
        refreshedAt: null,
        phase: "unavailable",
        error: "Stored appointments are unavailable. Refresh to retry; no empty calendar has been inferred.",
      });
    } finally {
      if (current()) {
        this.request = null;
        this.update({ reading: false });
      }
    }
  }
}
