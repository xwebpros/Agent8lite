import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardClockInstant, dashboardUtcPeriod } from "../../apps/api/src/dashboard-time";
import { CrmService } from "../../apps/api/src/crm-service";
import type { PoolClient } from "pg";
import type { TenantContext } from "../../packages/db/tenant-transaction";
import {
  dashboardMetricPresentation,
  dashboardReportContextBinding,
  dashboardReportExpired,
  dashboardReportRequest,
  formatDashboardInstant,
  requireDashboardReport,
  validDashboardTimezone,
} from "../../apps/web/components/verified-metrics-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const instant = "2026-10-10T12:00:00.123Z";
const org = "10000000-0000-4000-8000-000000000001";
function metric(patch: Partial<Schema<"Metric">> = {}): Schema<"Metric"> {
  return {
    key: "leads.created",
    definitionVersion: 2,
    value: 0,
    source: "crm-own-utc-month-query-v2",
    unit: "leads",
    state: "available",
    refreshedAt: instant,
    ...patch,
  };
}
function report(): Schema<"Dashboard"> {
  return {
    period: { from: "2026-10-01T00:00:00.000Z", to: instant, timezone: "UTC" },
    metrics: [
      metric(),
      {
        key: "revenue",
        definitionVersion: 1,
        value: null,
        source: "billing-unconfigured",
        unit: "USD",
        state: "unavailable",
        refreshedAt: null,
      },
    ],
    tasks: [],
    notifications: [],
    integrationHealth: [],
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("UTC closed dashboard measurement bounds", () => {
  it.each([
    ["object-getter", false],
    ["array-getter", false],
    ["object-function", false],
    ["array-function", false],
    ["object-getter", true],
    ["array-getter", true],
    ["object-function", true],
    ["array-function", true],
  ] as const)(
    "serializes current authority grants without executing inherited JSON hooks case%#",
    async (kind, taskRead) => {
      let calls = 0;
      let observed: unknown;
      let observedTask: unknown;
      let entitlementsChecked = 0;
      const prototype = kind.startsWith("array") ? Array.prototype : Object.prototype;
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      const context: TenantContext = {
        userId: org,
        organizationId: org,
        memberId: org,
        roleId: org,
        roleName: "Synthetic report role",
        timezone: "UTC",
        permissions: [
          { code: "dashboard.read", scope: "organization" },
          { code: "crm.leads.read", scope: "own" },
        ],
      };
      if (taskRead) context.permissions.push({ code: "crm.tasks.read", scope: "own" });
      const client = {
        query: async (statement: string, parameters: unknown[]) => {
          if (statement.includes("FROM app.entitlement")) {
            entitlementsChecked++;
            return { rowCount: 1, rows: [{ id: org }] };
          }
          if (parameters.length === 7) {
            observed = parameters[4];
            return { rowCount: taskRead ? 1 : 0, rows: taskRead ? [{}] : [] };
          }
          if (parameters.length === 5) observedTask = parameters[4];
          return { rowCount: 0, rows: [] };
        },
      } as unknown as PoolClient;
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get() {
                  calls++;
                  return undefined;
                },
              }
            : {
                configurable: true,
                value() {
                  calls++;
                  return [];
                },
              },
        );
        await new CrmService(client, context, "synthetic-no-database-proof")
          .dashboard({})
          .catch(() => undefined);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(calls).toBe(0);
      expect(typeof observed).toBe("string");
      expect(JSON.parse(observed as string)).toEqual(context.permissions);
      if (taskRead) {
        expect(entitlementsChecked).toBeGreaterThanOrEqual(1);
        expect(JSON.parse(observedTask as string)).toEqual([{ code: "crm.tasks.read", scope: "own" }]);
      }
    },
  );
  it.each([
    ["2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"],
    ["2026-03-08T10:30:00.001Z", "2026-03-01T00:00:00.000Z"],
    ["2026-11-01T08:30:00.999Z", "2026-11-01T00:00:00.000Z"],
    ["2026-11-01T09:30:00.123Z", "2026-11-01T00:00:00.000Z"],
    ["2028-02-29T23:59:59.999Z", "2028-02-01T00:00:00.000Z"],
    ["2027-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z"],
  ])("uses explicit UTC month start and exact captured millisecond for%s", (to, from) => {
    const value = dashboardUtcPeriod(to);
    expect(value).toEqual({ from, to, timezone: "UTC" });
    expect(Object.isFrozen(value)).toBe(true);
  });
  it("uses the actual Date internal clock without consulting shadowed own hooks", () => {
    const hook = vi.fn(() => {
      throw new Error("PRIVATE_DATE_HOOK");
    });
    const date = new Date(instant);
    for (const name of ["getTime", "toISOString", "toJSON"])
      Object.defineProperty(date, name, { configurable: true, get: hook });
    expect(dashboardClockInstant(date)).toBe(instant);
    expect(hook).not.toHaveBeenCalled();
  });
  it("rejects custom Date prototypes without consulting their clock hooks", () => {
    const hook = vi.fn(() => {
      throw new Error("PRIVATE_DATE_HOOK");
    });
    class HostileDate extends Date {
      getTime = hook;
      toISOString = hook;
      toJSON = hook;
    }
    expect(() => dashboardUtcPeriod(new HostileDate(instant))).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    null,
    0,
    "2026-10-10T12:00:00Z",
    "2026-10-10T12:00:00.123001Z",
    "2026-02-30T00:00:00.000Z",
    "2026-10-10T12:00:00.123+00:00",
    new Date(NaN),
  ])("denies malformed or nonpublic precision captured clocks without a fallback%s", (value) => {
    expect(() => dashboardUtcPeriod(value)).toThrow(
      expect.objectContaining({ status: 503, code: "dashboard_clock_unavailable" }),
    );
  });
  it("does not coerce an object or proxy clock", () => {
    const hook = vi.fn();
    expect(() => dashboardUtcPeriod({ valueOf: hook, toString: hook })).toThrow();
    expect(() => dashboardUtcPeriod(new Proxy(new Date(instant), { get: hook }))).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("closed reporting catalog and exact metadata", () => {
  it("preserves a measured zero and detaches/freeze all exposed private data", () => {
    const input = report(),
      output = requireDashboardReport(input);
    input.metrics[0].value = 999;
    expect(output.metrics[0].value).toBe(0);
    expect(Object.isFrozen(output.metrics[0])).toBe(true);
    expect(dashboardMetricPresentation(output.metrics[0], instant)).toMatchObject({
      state: "available",
      value: 0,
    });
  });
  it.each(["loading", "empty", "unavailable"] as const)(
    "keeps%s distinct without a fabricated zero",
    (state) => {
      expect(
        dashboardMetricPresentation(metric({ state, value: null, refreshedAt: null }), instant),
      ).toMatchObject({ state, value: null });
      expect(dashboardMetricPresentation(metric({ state, value: 12 }), instant)).toMatchObject({
        state: "unavailable",
        value: null,
      });
    },
  );
  it.each([
    { value: null },
    { value: -1 },
    { value: 1.5 },
    { value: Number.MAX_SAFE_INTEGER + 1 },
    { refreshedAt: null },
    { refreshedAt: undefined },
    { refreshedAt: "2026-10-10T12:00:01.123Z" },
    { denominator: 1 },
    { denominator: 0 },
  ])("withholds contradictory known count metadata%j", (patch) => {
    expect(dashboardMetricPresentation(metric(patch), instant)).toMatchObject({
      state: "unavailable",
      value: null,
    });
  });
  it.each([
    { key: "PRIVATE_UNKNOWN_METRIC" },
    { definitionVersion: 1 },
    { definitionVersion: 3 },
    { unit: "contacts" },
    { source: "provider-live" },
  ])("explicitly marks a frozen-schema unknown definition unsupported%j", (patch) => {
    const input = report();
    input.metrics[0] = metric(patch);
    const validated = requireDashboardReport(input);
    expect(dashboardMetricPresentation(validated.metrics[0], instant)).toMatchObject({
      state: "unsupported",
      value: null,
      definition: null,
    });
  });
  it("never presents unavailable revenue as a measured value even when a response claims otherwise", () => {
    expect(
      dashboardMetricPresentation(
        { ...report().metrics[1], state: "available", value: 450, refreshedAt: instant },
        instant,
      ),
    ).toMatchObject({ state: "unavailable", value: null });
  });
  it.each([
    (r: Schema<"Dashboard">) => {
      r.period.timezone = "America/Los_Angeles";
    },
    (r: Schema<"Dashboard">) => {
      r.period.from = "2026-09-30T17:00:00.000Z";
    },
    (r: Schema<"Dashboard">) => {
      r.period.to = "2026-10-10T12:00:00.123+00:00";
    },
    (r: Schema<"Dashboard">) => {
      r.metrics.push(metric());
    },
    (r: Schema<"Dashboard">) => {
      r.metrics[0].refreshedAt = "2026-10-10T11:59:59.999Z";
    },
    (r: Schema<"Dashboard">) => {
      r.metrics[0].definitionVersion = 1.5;
    },
    (r: Schema<"Dashboard">) => {
      r.metrics[0].source = "unsafe\nsource";
    },
    (r: Schema<"Dashboard">) => {
      Object.assign(r, { privateToken: "PRIVATE_EXTRA" });
    },
  ])("rejects malformed period, definitions or measured-before-period metadata", (change) => {
    const input = report();
    change(input);
    expect(() => requireDashboardReport(input)).toThrow();
  });
  it("does not invoke own accessors or JSON hooks while validating private input", () => {
    const hook = vi.fn();
    const accessor = report();
    Object.defineProperty(accessor.metrics[0], "value", { enumerable: true, get: hook });
    expect(() => requireDashboardReport(accessor)).toThrow();
    expect(() => requireDashboardReport({ ...report(), toJSON: hook })).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
  it("does not execute inherited JSON or optional field getters and does not fill missing required fields", () => {
    const hook = vi.fn(() => "PRIVATE_INHERITED");
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const denominator = Object.getOwnPropertyDescriptor(Object.prototype, "denominator");
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: hook });
      Object.defineProperty(Object.prototype, "denominator", { configurable: true, get: hook });
      const value = requireDashboardReport(report());
      expect(Object.hasOwn(value.metrics[0], "denominator")).toBe(false);
      expect(dashboardMetricPresentation(value.metrics[0], instant).value).toBe(0);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (denominator) Object.defineProperty(Object.prototype, "denominator", denominator);
      else Reflect.deleteProperty(Object.prototype, "denominator");
    }
  });
  it("bounds sparse, extra-property and oversized arrays instead of dropping private data", () => {
    for (const items of [
      new Array(1),
      Object.assign([], { extra: "PRIVATE" }),
      Array.from({ length: 51 }, (_, index) => metric({ key: "unknown." + index })),
    ]) {
      expect(() => requireDashboardReport({ ...report(), metrics: items })).toThrow();
    }
    expect(() =>
      requireDashboardReport({ ...report(), metrics: [metric({ source: "x".repeat(1024 * 1024) })] }),
    ).toThrow();
  });
});

describe("five minute freshness and labeled timezone references", () => {
  it("keeps just-before expiry available and withholds at the exact half-open freshness boundary", () => {
    expect(dashboardReportExpired(report(), "2026-10-10T12:05:00.122Z")).toBe(false);
    expect(dashboardReportExpired(report(), "2026-10-10T12:05:00.123Z")).toBe(true);
    expect(dashboardMetricPresentation(metric(), "2026-10-10T12:05:00.123Z")).toMatchObject({
      state: "stale",
      value: null,
    });
  });
  it("ignores unsupported measured metadata for report lifetime and falls back to period.to without a count", () => {
    const input = report();
    input.metrics = [metric({ key: "unknown", refreshedAt: "2026-10-10T12:10:00.000Z" })];
    expect(dashboardReportExpired(input, "2026-10-10T12:00:01.000Z")).toBe(false);
    expect(dashboardReportExpired(input, "2026-10-10T12:05:00.123Z")).toBe(true);
    input.metrics = [metric({ state: "empty", value: null, refreshedAt: null })];
    expect(dashboardReportExpired(input, "2026-10-10T12:05:00.123Z")).toBe(true);
  });
  it.each([undefined, "PRIVATE_CLOCK", "2026-10-10T11:59:59.999Z", "2026-10-10T12:00:00Z"])(
    "fails closed for missing, invalid or backwards visible clock%s",
    (now) => {
      expect(dashboardReportExpired(report(), now)).toBe(true);
    },
  );
  it("shows both repeated Los Angeles offsets and explicit UTC without using the device zone", () => {
    expect(formatDashboardInstant("2026-11-01T08:30:00.000Z", "America/Los_Angeles")).toContain(
      "01:30:00 GMT-7",
    );
    expect(formatDashboardInstant("2026-11-01T09:30:00.000Z", "America/Los_Angeles")).toContain(
      "01:30:00 GMT-8",
    );
    expect(formatDashboardInstant(instant, "UTC")).toContain("12:00:00 GMT");
    expect(formatDashboardInstant(instant, "Asia/Kathmandu")).toContain("GMT+5:45");
  });
  it.each([
    undefined,
    null,
    "",
    "PST",
    "+01:00",
    "PRIVATE_BAD_ZONE",
    {
      toString() {
        throw new Error("must not coerce");
      },
    },
  ])("does not silently replace an invalid user zone with UTC case%#", (zone) => {
    expect(validDashboardTimezone(zone)).toBe(false);
    expect(formatDashboardInstant(instant, zone)).toBeNull();
  });
  it("binds same-org reads to current user, member, permissions, revision and user timezone", () => {
    const session = {
      userId: org,
      activeOrgId: org,
      profile: { timezone: "UTC" },
      permissions: ["dashboard.read", "crm.leads.read"],
    } as Schema<"Session">;
    const base = { session, memberId: "member-a", accessRevision: 1 };
    const binding = dashboardReportContextBinding(base);
    expect(
      dashboardReportContextBinding({
        ...base,
        session: { ...session, permissions: [...session.permissions].reverse() },
      }),
    ).toBe(binding);
    for (const input of [
      { ...base, memberId: "member-b" },
      { ...base, accessRevision: 2 },
      { ...base, session: { ...session, userId: "other" } },
      { ...base, session: { ...session, profile: { ...session.profile, timezone: "Asia/Bangkok" } } },
      { ...base, session: { ...session, permissions: [] } },
    ])
      expect(dashboardReportContextBinding(input)).not.toBe(binding);
  });
});

describe("private exact dashboard transport", () => {
  it("sends only the frozen bodyless GET without scope/window query and never persists a response", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(report()), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await dashboardReportRequest(org)).toEqual(report());
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/orgs/" + org + "/dashboard");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.body).toBeUndefined();
  });
  it.each([401, 403, 503])("preserves actual HTTP%s on malformed private Problem content", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("PRIVATE_NOT_JSON", { status })),
    );
    await expect(dashboardReportRequest(org)).rejects.toMatchObject({ status });
    await expect(dashboardReportRequest(org)).rejects.not.toThrow("PRIVATE_NOT_JSON");
  });
  it("bounds actual response bytes rather than trusting Content-Length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x".repeat(1024 * 1024 + 1), { status: 200, headers: { "content-length": "1" } }),
      ),
    );
    await expect(dashboardReportRequest(org)).rejects.toThrow("too large");
  });
  it("rejects invalid org context before invoking transport", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(dashboardReportRequest("../other?scope=all")).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves provider timeout as unavailable and relays explicit cancellation", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const waiting = dashboardReportRequest(org);
    const assertion = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    const abort = new AbortController();
    const cancelled = dashboardReportRequest(org, abort.signal);
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await cancellation;
  });
});
