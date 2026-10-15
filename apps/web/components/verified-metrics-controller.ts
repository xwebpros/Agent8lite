import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

type Dashboard = Schema<"Dashboard">;
type Metric = Schema<"Metric">;
export const dashboardReportFreshnessMs = 5 * 60 * 1000;
export const dashboardReportResponseLimit = 1024 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:member-dashboard",
  components: {
    schemas: {
      Dashboard: contract.components.schemas.Dashboard,
      Period: contract.components.schemas.Period,
      Metric: contract.components.schemas.Metric,
      Task: contract.components.schemas.Task,
      Notification: contract.components.schemas.Notification,
      Integration: contract.components.schemas.Integration,
    },
  },
});
const validReport = ajv.compile<Dashboard>({ $ref: "estate:member-dashboard#/components/schemas/Dashboard" });
const validMetric = ajv.compile<Metric>(contract.components.schemas.Metric);
const validId = ajv.compile(contract.components.schemas.Task.properties.id);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

function snapshot<T>(input: T, maximum = dashboardReportResponseLimit): T {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 12) throw new Error();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
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
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(detached, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return detached;
  };
  try {
    const json = JSON.stringify(copy(input, 0));
    if (!json || new TextEncoder().encode(json).byteLength > maximum) throw new Error();
    return JSON.parse(json, (_key, item: unknown) => {
      if (item && typeof item === "object" && !Array.isArray(item)) Object.setPrototypeOf(item, null);
      return item;
    }) as T;
  } catch {
    throw new Error("Dashboard reporting data could not be verified within its private memory limits.");
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function utcInstant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value),
    epoch = date.getTime();
  return Number.isFinite(epoch) && date.toISOString() === value ? epoch : null;
}
export function validDashboardTimezone(value: unknown): value is string {
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
export function formatDashboardInstant(value: unknown, timezone: unknown): string | null {
  const epoch = utcInstant(value);
  if (epoch === null || !validDashboardTimezone(timezone)) return null;
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
      second: "2-digit",
      timeZoneName: "shortOffset",
    }).format(epoch);
  } catch {
    return null;
  }
}
const definitions = Object.freeze([
  Object.freeze({
    key: "leads.created",
    version: 2,
    source: "crm-own-utc-month-query-v2",
    unit: "leads",
    title: "Your leads created in the UTC month",
    description:
      "Currently unarchived leads assigned to you, created within the returned UTC period and intersected with your current lead-read permission. Reassignment or archival can change this count; it is not an immutable acquisition funnel.",
    denominator: "Not applicable to this count.",
  }),
  Object.freeze({
    key: "contacts.created",
    version: 1,
    source: "crm-scope-utc-month-query-v1",
    unit: "contacts",
    title: "Contacts created in the UTC month",
    description:
      "Currently unarchived contacts created within the returned UTC period, intersected with your current contact-read permission scope.",
    denominator: "Not applicable to this count.",
  }),
  Object.freeze({
    key: "deals.created",
    version: 1,
    source: "crm-own-utc-month-query-v1",
    unit: "deals",
    title: "Your deals created in the UTC month",
    description:
      "Deals assigned to you, created within the returned UTC period. Reassignment or archival can change this count.",
    denominator: "Not applicable to this count.",
  }),
  Object.freeze({
    key: "deals.pipeline_value",
    version: 1,
    source: "crm-own-utc-month-query-v1",
    unit: "USD",
    title: "Your pipeline value in the UTC month",
    description:
      "Sum of deal values assigned to you, created within the returned UTC period. Only deals with non-negative values are counted.",
    denominator: "Total of qualifying deal values.",
  }),
  Object.freeze({
    key: "tasks.completed",
    version: 1,
    source: "crm-own-utc-month-query-v1",
    unit: "tasks",
    title: "Your tasks completed in the UTC month",
    description:
      "Tasks assigned to you that were marked completed within the returned UTC period.",
    denominator: "Not applicable to this count.",
  }),
  Object.freeze({
    key: "revenue",
    version: 1,
    source: "billing-unconfigured",
    unit: "USD",
    title: "Revenue measurement",
    description: "Revenue measurement is not configured. No billing or engagement value is inferred.",
    denominator: "No measured numerator or denominator is available.",
  }),
]);
export type DashboardMetricPresentation = Readonly<{
  definition: (typeof definitions)[number] | null;
  state: "available" | "loading" | "empty" | "unavailable" | "unsupported" | "stale";
  value: number | null;
}>;
/** The catalog is presentation metadata; the generated Metric remains the only response contract. */
export function dashboardMetricPresentation(input: Metric, now: unknown): DashboardMetricPresentation {
  try {
    const metric = snapshot(input);
    if (!validMetric(metric)) throw new Error();
    const definition =
      definitions.find(
        (item) =>
          item.key === metric.key &&
          item.version === metric.definitionVersion &&
          item.source === metric.source &&
          item.unit === metric.unit,
      ) ?? null;
    if (!definition) return { definition: null, state: "unsupported", value: null };
    if (definition.key === "revenue") return { definition, state: "unavailable", value: null };
    const refreshed = utcInstant(metric.refreshedAt),
      current = utcInstant(now);
    if (metric.state !== "available")
      return { definition, state: metric.value === null ? metric.state : "unavailable", value: null };
    if (
      metric.value === null ||
      !Number.isSafeInteger(metric.value) ||
      metric.value < 0 ||
      metric.denominator != null ||
      refreshed === null ||
      current === null ||
      refreshed > current
    )
      return { definition, state: "unavailable", value: null };
    if (current - refreshed >= dashboardReportFreshnessMs) return { definition, state: "stale", value: null };
    return { definition, state: "available", value: metric.value };
  } catch {
    return { definition: null, state: "unavailable", value: null };
  }
}
export function requireDashboardReport(input: unknown): Dashboard {
  const report = snapshot(input);
  if (!validReport(report)) throw new Error("Dashboard reporting metadata is unavailable.");
  const from = utcInstant(report.period.from),
    to = utcInstant(report.period.to);
  if (report.period.timezone !== "UTC" || from === null || to === null || from > to)
    throw new Error("Dashboard reporting period is unavailable.");
  const start = new Date(to);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  if (
    report.period.from !== start.toISOString() ||
    new Set(report.metrics.map((metric) => metric.key)).size !== report.metrics.length
  )
    throw new Error("Dashboard reporting period or definitions are unavailable.");
  for (const metric of report.metrics) {
    if (
      !Number.isSafeInteger(metric.definitionVersion) ||
      ![metric.key, metric.unit, metric.source].every(
        (value) => value.trim() && !/[\u0000-\u001f\u007f]/u.test(value),
      ) ||
      (metric.refreshedAt != null && utcInstant(metric.refreshedAt) === null)
    )
      throw new Error("Dashboard metric metadata is unavailable.");
    if (
      metric.key === "leads.created" &&
      metric.definitionVersion === 2 &&
      metric.source === "crm-own-utc-month-query-v2" &&
      metric.unit === "leads" &&
      metric.state === "available" &&
      metric.refreshedAt != null &&
      (utcInstant(metric.refreshedAt) as number) < to
    )
      throw new Error("Dashboard measured refresh metadata is unavailable.");
  }
  return frozen(report);
}
export function dashboardReportExpired(report: Dashboard, now: unknown): boolean {
  try {
    const safe = requireDashboardReport(report),
      current = utcInstant(now);
    const measured = safe.metrics
      .filter((metric) => ["available", "stale"].includes(dashboardMetricPresentation(metric, now).state))
      .map((metric) => utcInstant(metric.refreshedAt) as number);
    const anchor = measured.length ? Math.min(...measured) : utcInstant(safe.period.to);
    return (
      current === null ||
      anchor === null ||
      current < anchor ||
      current - anchor >= dashboardReportFreshnessMs
    );
  } catch {
    return true;
  }
}
export function dashboardReportContextBinding(input: {
  session: Schema<"Session">;
  memberId: string;
  accessRevision: number;
}): string {
  return [
    input.session.userId,
    input.session.activeOrgId || "",
    input.memberId,
    String(input.accessRevision),
    input.session.profile.timezone || "",
    ...[...input.session.permissions].sort(),
  ]
    .map((part) => part.length + ":" + part)
    .join("|");
}
async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Dashboard response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Dashboard response was interrupted.");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Dashboard response was interrupted.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => {});
        throw new Error("Dashboard response is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
export async function dashboardReportRequest(organizationId: string, signal?: AbortSignal): Promise<unknown> {
  if (!validId(organizationId)) throw new Error("Dashboard request context is invalid.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch("/api/v1/orgs/" + encodeURIComponent(organizationId) + "/dashboard", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
    });
    if (!response.ok) {
      let code = "dashboard_request_failed";
      try {
        const problem = snapshot(await boundedJson(response, 64 * 1024, abort.signal), 64 * 1024);
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Preserve HTTP denials without exposing response content. */
      }
      throw new ApiError(response.status, "Dashboard reporting could not be read.", code);
    }
    if (response.status !== 200) throw new Error("Dashboard response status is unexpected.");
    return await boundedJson(response, dashboardReportResponseLimit, abort.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
export interface DashboardReportClient {
  read(signal?: AbortSignal): Promise<unknown>;
}
export type DashboardReportState = Readonly<{
  online: boolean;
  visible: boolean;
  canRead: boolean;
  reading: boolean;
  snapshot: Dashboard | null;
  receivedAt: string | null;
  stale: boolean;
  phase: "idle" | "ready" | "denied" | "unavailable" | "stale";
  error: string;
}>;
export class DashboardReportController {
  private state: DashboardReportState;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private detached = false;
  private revoked = false;
  private request: AbortController | null = null;
  constructor(
    private readonly options: {
      binding: string;
      client: DashboardReportClient;
      online: boolean;
      canRead: boolean;
      isCurrent?(): boolean;
      now?(): string;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = frozen({
      online: options.online,
      visible: true,
      canRead: options.canRead,
      reading: false,
      snapshot: null,
      receivedAt: null,
      stale: false,
      phase: options.canRead ? "idle" : "denied",
      error: "",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<DashboardReportState>) {
    this.state = frozen({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
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
  private clear() {
    ++this.epoch;
    this.request?.abort();
    this.request = null;
    this.update({
      snapshot: null,
      receivedAt: null,
      reading: false,
      stale: false,
      phase: this.state.canRead ? "idle" : "denied",
      error: "",
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.clear();
  }
  invalidate() {
    this.clear();
  }
  revoke() {
    this.revoked = true;
    this.clear();
    this.update({
      canRead: false,
      phase: "denied",
      error: "Reporting access changed. Refresh workspace access before reopening this report.",
    });
  }
  setOnline(online: boolean) {
    if (online !== this.state.online) {
      this.clear();
      this.update({ online });
    }
  }
  setVisible(visible: boolean) {
    if (visible !== this.state.visible) {
      this.clear();
      this.update({ visible });
    }
  }
  setPermissions(canRead: boolean) {
    if (!this.revoked && canRead !== this.state.canRead) {
      this.clear();
      this.update({ canRead, phase: canRead ? "idle" : "denied" });
    }
  }
  tick() {
    if (!this.active()) {
      if (this.state.snapshot || this.state.reading) this.clear();
      return;
    }
    if (this.state.snapshot && dashboardReportExpired(this.state.snapshot, this.now())) {
      this.clear();
      this.update({
        stale: true,
        phase: "stale",
        error: "Reporting snapshot is stale. Refresh to read a new measurement.",
      });
    }
  }
  async refresh(): Promise<void> {
    if (!this.active()) return;
    this.clear();
    const epoch = this.epoch,
      request = new AbortController();
    this.request = request;
    const current = () => epoch === this.epoch && this.active();
    this.update({ reading: true, phase: "idle", error: "" });
    try {
      const report = requireDashboardReport(await this.options.client.read(request.signal));
      if (!current()) return;
      const receivedAt = this.now();
      if (dashboardReportExpired(report, receivedAt)) {
        this.update({
          snapshot: null,
          stale: true,
          phase: "stale",
          error: "Reporting snapshot is stale. Refresh to read a new measurement.",
        });
        return;
      }
      this.update({ snapshot: report, receivedAt, stale: false, phase: "ready", error: "" });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.revoke();
        this.options.onAccessRevoked?.();
      } else
        this.update({
          snapshot: null,
          receivedAt: null,
          phase: "unavailable",
          error: "Reporting is unavailable. Retry the current report when connected.",
        });
    } finally {
      if (current()) {
        this.request = null;
        this.update({ reading: false });
      }
    }
  }
}
