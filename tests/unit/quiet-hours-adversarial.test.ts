import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuietHoursInputV1 } from "../../packages/contracts/internal/quiet-hours";
import { QuietHoursError, resolveQuietHours } from "../../packages/marketing/quiet-hours";

const input = (
  dueInstant = "2026-01-15T12:00:00.000Z",
  quietHours: QuietHoursInputV1["quietHours"] = { start: "09:00", end: "17:00" },
  recipientTimeZone: string | null = "UTC",
  organizationTimeZone = "UTC",
): QuietHoursInputV1 => ({ dueInstant, recipientTimeZone, organizationTimeZone, quietHours });
const denied = (value: unknown, code = "quiet_hours_invalid") => {
  expect(() => resolveQuietHours(value)).toThrowError(expect.objectContaining({ code }));
};
afterEach(() => vi.restoreAllMocks());

describe("half-open quiet windows preserve exact UTC milliseconds", () => {
  it.each([
    ["2026-01-15T08:59:59.999Z", "09:00", "17:00", "2026-01-15T08:59:59.999Z"],
    ["2026-01-15T09:00:00.000Z", "09:00", "17:00", "2026-01-15T17:00:00.000Z"],
    ["2026-01-15T16:59:59.999Z", "09:00", "17:00", "2026-01-15T17:00:00.000Z"],
    ["2026-01-15T17:00:00.000Z", "09:00", "17:00", "2026-01-15T17:00:00.000Z"],
    ["2026-01-15T21:59:59.999Z", "22:00", "08:00", "2026-01-15T21:59:59.999Z"],
    ["2026-01-15T22:00:00.001Z", "22:00", "08:00", "2026-01-16T08:00:00.000Z"],
    ["2026-01-15T07:59:59.999Z", "22:00", "08:00", "2026-01-15T08:00:00.000Z"],
    ["2026-01-15T08:00:00.001Z", "22:00", "08:00", "2026-01-15T08:00:00.001Z"],
    ["2026-01-15T00:00:00.000Z", "00:00", "08:00", "2026-01-15T08:00:00.000Z"],
    ["2026-01-15T23:59:59.999Z", "22:00", "00:00", "2026-01-16T00:00:00.000Z"],
    ["2026-01-16T00:00:00.000Z", "22:00", "00:00", "2026-01-16T00:00:00.000Z"],
    ["2028-02-29T22:05:12.345Z", "22:00", "08:00", "2028-03-01T08:00:00.000Z"],
    ["2100-12-31T23:59:59.999Z", "22:00", "08:00", "2101-01-01T08:00:00.000Z"],
  ])("resolves independent UTC endpoint case %#", (due, start, end, eligible) => {
    expect(resolveQuietHours(input(due, { start, end }))).toEqual({
      dueInstant: due,
      eligibleInstant: eligible,
      timeZone: "UTC",
      timeZoneSource: "recipient",
      decision: eligible === due ? "unchanged" : "quiet-hours-deferred",
    });
    expect(Date.parse(eligible)).toBeGreaterThanOrEqual(Date.parse(due));
  });
});

describe("earliest UTC eligibility through gaps and both overlap occurrences", () => {
  it.each([
    ["America/New_York", "2026-11-01T05:20:00.000Z", "00:30", "01:30", "2026-11-01T05:30:00.000Z"],
    ["America/New_York", "2026-11-01T06:20:00.000Z", "00:30", "01:30", "2026-11-01T06:30:00.000Z"],
    ["America/New_York", "2026-11-01T05:45:12.345Z", "00:30", "01:30", "2026-11-01T05:45:12.345Z"],
    ["America/New_York", "2026-11-01T05:59:59.999Z", "00:30", "01:30", "2026-11-01T05:59:59.999Z"],
    ["America/New_York", "2026-11-01T06:00:00.000Z", "00:30", "01:30", "2026-11-01T06:30:00.000Z"],
    ["America/New_York", "2026-11-01T06:30:00.000Z", "00:30", "01:30", "2026-11-01T06:30:00.000Z"],
    ["America/New_York", "2026-03-08T06:50:00.001Z", "01:00", "02:30", "2026-03-08T07:00:00.000Z"],
    ["America/New_York", "2026-03-08T07:00:00.001Z", "02:10", "02:50", "2026-03-08T07:00:00.001Z"],
    ["America/New_York", "2026-03-08T06:50:00.000Z", "03:00", "02:30", "2026-03-09T06:30:00.000Z"],
    ["Australia/Lord_Howe", "2026-04-04T14:40:00.000Z", "01:15", "01:45", "2026-04-04T14:45:00.000Z"],
    ["Australia/Lord_Howe", "2026-04-04T15:10:00.000Z", "01:15", "01:45", "2026-04-04T15:15:00.000Z"],
    ["Australia/Lord_Howe", "2026-10-03T15:20:00.000Z", "01:00", "02:15", "2026-10-03T15:30:00.000Z"],
    ["Pacific/Apia", "2011-12-30T09:30:00.000Z", "22:00", "08:00", "2011-12-30T18:00:00.000Z"],
    ["Asia/Calcutta", "2026-01-15T16:30:00.001Z", "22:00", "08:00", "2026-01-16T02:30:00.000Z"],
    ["Asia/Katmandu", "2026-01-15T16:15:00.001Z", "22:00", "08:00", "2026-01-16T02:15:00.000Z"],
    ["Etc/GMT+12", "2000-01-01T00:00:00.000Z", "09:00", "17:00", "2000-01-01T05:00:00.000Z"],
    ["Pacific/Kiritimati", "2100-12-31T20:00:00.000Z", "09:00", "17:00", "2101-01-01T03:00:00.000Z"],
  ])(
    "matches an independently expected transition/offset instant case %#",
    (zone, due, start, end, eligible) => {
      const result = resolveQuietHours(input(due, { start, end }, zone));
      expect(result).toEqual({
        dueInstant: due,
        eligibleInstant: eligible,
        timeZone: zone,
        timeZoneSource: "recipient",
        decision: due === eligible ? "unchanged" : "quiet-hours-deferred",
      });
      expect(Date.parse(result.eligibleInstant)).toBeGreaterThanOrEqual(Date.parse(due));
    },
  );
});

describe("explicit recipient zone and disabled interval policy", () => {
  it("uses a known recipient zone instead of the organization zone and records explicit fallback distinctly", () => {
    const due = "2026-01-15T14:00:12.345Z";
    const quiet = { start: "09:00", end: "17:00" };
    expect(resolveQuietHours(input(due, quiet, "America/New_York", "Asia/Bangkok"))).toEqual({
      dueInstant: due,
      eligibleInstant: "2026-01-15T22:00:00.000Z",
      timeZone: "America/New_York",
      timeZoneSource: "recipient",
      decision: "quiet-hours-deferred",
    });
    expect(resolveQuietHours(input(due, quiet, null, "Asia/Bangkok"))).toEqual({
      dueInstant: due,
      eligibleInstant: due,
      timeZone: "Asia/Bangkok",
      timeZoneSource: "organization-fallback",
      decision: "unchanged",
    });
  });
  it("explicit null disables deferral while preserving the exact supplied millisecond instant", () => {
    const due = "2026-11-01T06:20:09.987Z";
    expect(resolveQuietHours(input(due, null, null, "America/New_York"))).toEqual({
      dueInstant: due,
      eligibleInstant: due,
      timeZone: "America/New_York",
      timeZoneSource: "organization-fallback",
      decision: "quiet-hours-disabled",
    });
  });
  it.each(["Asia/Kolkata", "US/Eastern", "america/new_york", "GMT", "+05:30", "", "Unknown/Private"])(
    "does not silently fall back from invalid known recipient zone %s",
    (zone) => denied(input(undefined, null, zone)),
  );
  it("validates the unused organization zone even with a known recipient and disabled interval", () => {
    denied(input(undefined, null, "UTC", "US/Eastern"));
    denied(input(undefined, null, null, "Unknown/Private"));
  });
});

describe("closed hostile inputs and deterministic private results", () => {
  it.each([
    "1999-12-31T23:59:59.999Z",
    "2101-01-01T00:00:00.000Z",
    "2100-02-29T12:00:00.000Z",
    "2026-02-29T12:00:00.000Z",
    "2026-04-31T12:00:00.000Z",
    "2026-01-15T24:00:00.000Z",
    "2026-01-15T12:00:60.000Z",
    "2026-01-15T12:00:00Z",
    "2026-01-15T12:00:00.1Z",
    "2026-01-15T12:00:00.0000Z",
    "2026-01-15T12:00:00.000+00:00",
    "2026-01-15T12:00:00.000Z\n",
  ])("rejects a noncanonical or impossible supplied instant case %#", (due) => denied(input(due)));
  it.each([
    null,
    [],
    { ...input(), futurePolicy: "ignore" },
    { ...input(), recipientTimeZone: undefined },
    { ...input(), quietHours: undefined },
    { ...input(), quietHours: { start: "09:00", end: "09:00" } },
    { ...input(), quietHours: { start: "24:00", end: "08:00" } },
    { ...input(), quietHours: { start: "09:00", end: "17:00", callback: "private" } },
    { ...input(), quietHours: { start: "09:00" } },
    { ...input(), quietHours: [] },
  ])("requires the explicit closed input and window fields case %#", (value) => denied(value));
  it("does not equate omitted fields with explicit null policy", () => {
    const value = { ...input() } as Partial<Record<keyof QuietHoursInputV1, unknown>>;
    delete value.quietHours;
    denied(value);
    delete value.recipientTimeZone;
    denied(value);
  });
  it("rejects proxies, revoked proxies, accessors and coercion hooks without executing them", () => {
    const hook = vi.fn(() => {
      throw new Error("Never execute supplied code");
    });
    const proxy = new Proxy(input(), {
      get: hook,
      ownKeys: hook,
      getPrototypeOf: hook,
      getOwnPropertyDescriptor: hook,
    });
    denied(proxy);
    const revoked = Proxy.revocable(input(), { get: hook, ownKeys: hook });
    revoked.revoke();
    denied(revoked.proxy);
    denied(Object.defineProperty({ ...input() }, "dueInstant", { enumerable: true, get: hook }));
    denied({
      ...input(),
      quietHours: Object.defineProperty({ end: "17:00" }, "start", { enumerable: true, get: hook }),
    });
    denied({
      ...input(),
      quietHours: new Proxy({ start: "09:00", end: "17:00" }, { ownKeys: hook, get: hook }),
    });
    denied({ ...input(), dueInstant: { toString: hook, valueOf: hook, toJSON: hook } });
    denied(Object.defineProperty({ ...input() }, "toJSON", { get: hook }));
    expect(hook).not.toHaveBeenCalled();
  });
  it("rejects hidden/symbol/inherited fields without reading or filling them", () => {
    const hook = vi.fn(() => {
      throw new Error("Inherited field executed");
    });
    denied(Object.defineProperty({ ...input() }, "recipientTimeZone", { value: "UTC", enumerable: false }));
    denied({ ...input(), [Symbol("private-policy")]: "private" });
    denied(Object.create(input()));
    const value = { ...input() } as Partial<Record<keyof QuietHoursInputV1, unknown>>;
    delete value.dueInstant;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "dueInstant");
    try {
      Object.defineProperty(Object.prototype, "dueInstant", { configurable: true, get: hook });
      denied(value);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(Object.prototype, "dueInstant", original);
      else delete (Object.prototype as Record<string, unknown>).dueInstant;
    }
  });
  it("never invokes inherited Object/Array serialization hooks and accepts null-prototype own data", () => {
    const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const hook = vi.fn(() => {
      throw new Error("Prototype serialization executed");
    });
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      const value = Object.assign(Object.create(null), input());
      value.quietHours = Object.assign(Object.create(null), value.quietHours);
      const result = resolveQuietHours(value);
      expect(result.eligibleInstant).toBe("2026-01-15T17:00:00.000Z");
      expect(hook).not.toHaveBeenCalled();
    } finally {
      if (objectHook) Object.defineProperty(Object.prototype, "toJSON", objectHook);
      else delete (Object.prototype as Record<string, unknown>).toJSON;
      if (arrayHook) Object.defineProperty(Array.prototype, "toJSON", arrayHook);
      else delete (Array.prototype as unknown as Record<string, unknown>).toJSON;
    }
  });
  it("returns detached frozen deterministic values without current or workstation clock reads", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Current clock used");
    });
    const local = vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(() => {
      throw new Error("Workstation zone used");
    });
    const value = { ...input(), quietHours: { start: "09:00", end: "17:00" } };
    const first = resolveQuietHours(value),
      second = resolveQuietHours(value);
    value.dueInstant = "2026-01-16T12:00:00.000Z";
    value.quietHours.end = "18:00";
    expect(first).toEqual(second);
    expect(first.eligibleInstant).toBe("2026-01-15T17:00:00.000Z");
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first).sort()).toEqual([
      "decision",
      "dueInstant",
      "eligibleInstant",
      "timeZone",
      "timeZoneSource",
    ]);
    expect(clock).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });
});

describe("unsupported formatter observations fail closed within the bounded scan", () => {
  it("does not manufacture an allowed time when every observation remains quiet", () => {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const constantQuiet = format.formatToParts(Date.UTC(2026, 0, 15, 12));
    const observed = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(constantQuiet);
    denied(input(), "quiet_hours_unavailable");
    expect(observed.mock.calls.length).toBeGreaterThan(1);
    expect(observed.mock.calls.length).toBeLessThanOrEqual(2881);
    for (const [instant] of observed.mock.calls) expect(typeof instant).toBe("number");
    expect(Math.max(...observed.mock.calls.map(([instant]) => Number(instant)))).toBeLessThanOrEqual(
      Date.parse(input().dueInstant) + 48 * 60 * 60 * 1000,
    );
  });
  it("requires usable Gregorian/Latin/h23 formatter options even for a disabled interval", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h24",
    } as Intl.ResolvedDateTimeFormatOptions);
    denied(input(undefined, null), "quiet_hours_unavailable");
  });
  it("rejects subminute offset evidence rather than adjusting a due instant", () => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      instant,
    ) {
      return original
        .call(this, instant)
        .map((part) => (part.type === "second" ? { type: "second", value: "01" } : part));
    });
    denied(input(), "quiet_hours_unavailable");
  });
  it("rejects hooked formatter options and revoked parts proxies without executing traps", () => {
    const hook = vi.fn(() => {
      throw new Error("Formatter trap executed");
    });
    const options = Object.defineProperty({}, "timeZone", { get: hook });
    const resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue(options as Intl.ResolvedDateTimeFormatOptions);
    denied(input(), "quiet_hours_unavailable");
    resolved.mockRestore();
    const proxy = Proxy.revocable([], { get: hook, ownKeys: hook });
    proxy.revoke();
    // A spy inspects returned values itself; use a plain method so only the helper observes this proxy.
    const original = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "formatToParts")!;
    try {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", {
        ...original,
        value: () => proxy.proxy,
      });
      denied(input(), "quiet_hours_unavailable");
      expect(hook).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", original);
    }
  });
  it("returns only fixed safe errors without retaining an Intl exception or private input", () => {
    const marker = "private-unrestricted-formatter-error";
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
      throw new Error(marker);
    });
    let thrown: unknown;
    try {
      resolveQuietHours(input());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(QuietHoursError);
    expect((thrown as QuietHoursError).code).toBe("quiet_hours_unavailable");
    expect(String(thrown)).not.toContain(marker);
    expect(Object.values(thrown as object)).not.toContain(marker);
    expect((thrown as Error).message).not.toContain(input().dueInstant);
  });
});
