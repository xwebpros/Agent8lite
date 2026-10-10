import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuietHoursInputV1 } from "../contracts/internal/quiet-hours";
import { QuietHoursError, resolveQuietHours } from "./quiet-hours";

const input = (
  dueInstant = "2026-06-01T23:14:12.345Z",
  start = "22:00",
  end = "08:00",
  recipientTimeZone: string | null = "UTC",
): QuietHoursInputV1 => ({
  dueInstant,
  recipientTimeZone,
  organizationTimeZone: "UTC",
  quietHours: { start, end },
});

function failure(value: unknown, code = "quiet_hours_invalid") {
  try {
    resolveQuietHours(value);
    throw new Error("Expected a fixed quiet-hours error.");
  } catch (error) {
    expect(error).toBeInstanceOf(QuietHoursError);
    expect(error).toMatchObject({
      code,
      message:
        code === "quiet_hours_invalid" ? "Quiet hours input is invalid." : "Quiet hours are unavailable.",
    });
    expect(Object.keys(error as object)).toEqual(["code", "name"]);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("quiet-hours earliest at-or-after UTC calculation", () => {
  it.each([
    ["2026-06-01T08:59:59.999Z", "09:00", "17:00", "2026-06-01T08:59:59.999Z", "unchanged"],
    ["2026-06-01T09:00:00.000Z", "09:00", "17:00", "2026-06-01T17:00:00.000Z", "quiet-hours-deferred"],
    ["2026-06-01T16:59:59.999Z", "09:00", "17:00", "2026-06-01T17:00:00.000Z", "quiet-hours-deferred"],
    ["2026-06-01T17:00:00.000Z", "09:00", "17:00", "2026-06-01T17:00:00.000Z", "unchanged"],
    ["2026-06-01T17:00:00.001Z", "09:00", "17:00", "2026-06-01T17:00:00.001Z", "unchanged"],
    ["2026-06-01T21:59:59.999Z", "22:00", "08:00", "2026-06-01T21:59:59.999Z", "unchanged"],
    ["2026-06-01T22:00:00.000Z", "22:00", "08:00", "2026-06-02T08:00:00.000Z", "quiet-hours-deferred"],
    ["2026-06-02T00:00:00.001Z", "22:00", "08:00", "2026-06-02T08:00:00.000Z", "quiet-hours-deferred"],
    ["2026-06-02T07:59:59.999Z", "22:00", "08:00", "2026-06-02T08:00:00.000Z", "quiet-hours-deferred"],
    ["2026-06-02T08:00:00.000Z", "22:00", "08:00", "2026-06-02T08:00:00.000Z", "unchanged"],
    ["2026-06-02T08:00:00.999Z", "22:00", "08:00", "2026-06-02T08:00:00.999Z", "unchanged"],
    ["2026-06-01T00:00:59.999Z", "00:00", "00:01", "2026-06-01T00:01:00.000Z", "quiet-hours-deferred"],
    ["2026-06-01T23:59:59.999Z", "23:59", "00:00", "2026-06-02T00:00:00.000Z", "quiet-hours-deferred"],
  ])(
    "applies half-open same-day and overnight millisecond endpoints case %#",
    (due, start, end, eligible, decision) => {
      expect(resolveQuietHours(input(due, start, end))).toEqual({
        dueInstant: due,
        eligibleInstant: eligible,
        timeZone: "UTC",
        timeZoneSource: "recipient",
        decision,
      });
    },
  );

  it.each([
    ["2026-11-01T05:20:00.000Z", "00:30", "01:30", "2026-11-01T05:30:00.000Z"],
    ["2026-11-01T06:20:00.000Z", "00:30", "01:30", "2026-11-01T06:30:00.000Z"],
    ["2026-11-01T05:40:09.345Z", "01:30", "01:50", "2026-11-01T05:50:00.000Z"],
    ["2026-11-01T06:40:09.345Z", "01:30", "01:50", "2026-11-01T06:50:00.000Z"],
    ["2026-11-01T05:50:00.000Z", "01:30", "02:30", "2026-11-01T06:00:00.000Z"],
    ["2026-11-01T06:20:00.000Z", "00:30", "02:30", "2026-11-01T07:30:00.000Z"],
  ])("evaluates each overlap occurrence and rollback independently case %#", (due, start, end, eligible) => {
    expect(resolveQuietHours(input(due, start, end, "America/New_York"))).toMatchObject({
      eligibleInstant: eligible,
      decision: "quiet-hours-deferred",
    });
  });

  it("keeps an allowed first overlap occurrence even when a later rollback re-enters quiet hours", () => {
    const due = "2026-11-01T05:45:12.345Z";
    expect(resolveQuietHours(input(due, "00:30", "01:30", "America/New_York"))).toMatchObject({
      eligibleInstant: due,
      decision: "unchanged",
    });
  });

  it.each([
    ["2026-03-08T06:20:00.000Z", "00:30", "02:30", "2026-03-08T07:00:00.000Z"],
    ["2026-03-08T06:20:00.000Z", "22:00", "03:30", "2026-03-08T07:30:00.000Z"],
    ["2026-03-08T06:59:59.999Z", "02:10", "02:50", "2026-03-08T06:59:59.999Z"],
    ["2026-03-08T07:00:00.000Z", "02:10", "02:50", "2026-03-08T07:00:00.000Z"],
    ["2026-03-08T07:10:00.000Z", "02:30", "03:30", "2026-03-08T07:30:00.000Z"],
    ["2026-03-08T06:50:00.000Z", "03:00", "02:30", "2026-03-09T06:30:00.000Z"],
  ])(
    "checks the actual post-gap predicate instead of assuming a skipped end is eligible case %#",
    (due, start, end, eligible) => {
      expect(resolveQuietHours(input(due, start, end, "America/New_York")).eligibleInstant).toBe(eligible);
    },
  );

  it.each([
    ["2026-04-04T14:40:00.000Z", "01:15", "01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    ["2026-04-04T15:10:00.000Z", "01:15", "01:45", "Australia/Lord_Howe", "2026-04-04T15:15:00.000Z"],
    ["2026-10-03T15:20:00.000Z", "00:30", "02:15", "Australia/Lord_Howe", "2026-10-03T15:30:00.000Z"],
    ["2026-10-03T15:20:00.000Z", "00:30", "02:45", "Australia/Lord_Howe", "2026-10-03T15:45:00.000Z"],
    ["2026-09-26T13:45:00.000Z", "00:00", "03:30", "Pacific/Chatham", "2026-09-26T14:00:00.000Z"],
    ["2026-09-26T13:45:00.000Z", "22:00", "04:00", "Pacific/Chatham", "2026-09-26T14:15:00.000Z"],
    ["2011-12-30T09:30:00.000Z", "22:00", "08:00", "Pacific/Apia", "2011-12-30T18:00:00.000Z"],
    ["2026-06-01T12:00:00.000Z", "22:00", "08:00", "Etc/GMT+5", "2026-06-01T13:00:00.000Z"],
    ["2026-06-01T02:30:00.000Z", "22:00", "08:30", "Asia/Calcutta", "2026-06-01T03:00:00.000Z"],
  ])(
    "resolves half-hour, quarter-hour, fixed-offset and skipped-day cases %#",
    (due, start, end, zone, eligible) => {
      expect(resolveQuietHours(input(due, start, end, zone))).toMatchObject({
        eligibleInstant: eligible,
        decision: "quiet-hours-deferred",
      });
    },
  );

  it.each([
    ["2000-02-29T23:00:00.000Z", "UTC", "22:00", "08:00", "2000-03-01T08:00:00.000Z"],
    ["2000-01-01T00:00:00.000Z", "America/New_York", "18:00", "20:00", "2000-01-01T01:00:00.000Z"],
    ["2100-12-31T23:59:59.999Z", "UTC", "22:00", "08:00", "2101-01-01T08:00:00.000Z"],
  ])(
    "accepts leap boundaries and projected dates beyond the input-year interval case %#",
    (due, zone, start, end, eligible) => {
      expect(resolveQuietHours(input(due, start, end, zone)).eligibleInstant).toBe(eligible);
    },
  );

  it("uses only an explicit unknown-recipient organization fallback", () => {
    const value = {
      ...input(undefined, undefined, undefined, null),
      organizationTimeZone: "America/New_York",
    };
    expect(resolveQuietHours(value)).toEqual({
      dueInstant: value.dueInstant,
      eligibleInstant: value.dueInstant,
      timeZone: "America/New_York",
      timeZoneSource: "organization-fallback",
      decision: "unchanged",
    });
  });

  it.each([null, "UTC", "America/New_York"])(
    "preserves milliseconds when quiet hours are explicitly disabled case %#",
    (recipientTimeZone) => {
      const value = { ...input(undefined, undefined, undefined, recipientTimeZone), quietHours: null };
      expect(resolveQuietHours(value)).toMatchObject({
        dueInstant: value.dueInstant,
        eligibleInstant: value.dueInstant,
        timeZone: recipientTimeZone ?? "UTC",
        timeZoneSource: recipientTimeZone === null ? "organization-fallback" : "recipient",
        decision: "quiet-hours-disabled",
      });
    },
  );

  it("returns detached frozen deterministic results without the current or workstation clock", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("private clock");
    });
    const local = vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(() => {
      throw new Error("private clock");
    });
    const value = { ...input(), quietHours: { start: "22:00", end: "08:00" } };
    const first = resolveQuietHours(value);
    const second = resolveQuietHours(value);
    value.dueInstant = "2026-06-01T12:00:00.000Z";
    value.quietHours.end = "10:00";
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.eligibleInstant).toBe("2026-06-02T08:00:00.000Z");
    expect(clock).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it.each([
    "1999-12-31T23:59:59.999Z",
    "2101-01-01T00:00:00.000Z",
    "2100-02-29T00:00:00.000Z",
    "2026-02-29T00:00:00.000Z",
    "2026-04-31T00:00:00.000Z",
    "2026-00-01T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-01-00T00:00:00.000Z",
    "2026-01-32T00:00:00.000Z",
    "2026-06-01T24:00:00.000Z",
    "2026-06-01T23:60:00.000Z",
    "2026-06-01T23:59:60.000Z",
    "2026-6-01T23:59:00.000Z",
    "2026-06-01 23:59:00.000Z",
    "2026-06-01T23:59:00.000z",
    "2026-06-01T23:59:00Z",
    "2026-06-01T23:59:00.00Z",
    "2026-06-01T23:59:00.0000Z",
    "2026-06-01T23:59:00.000+00:00",
    "2026-06-01T23:59:00.000Z\n",
    "２０２６-06-01T23:59:00.000Z",
  ])("rejects noncanonical/impossible UTC input case %#", (due) => failure(input(due)));

  it.each(["", "24:00", "12:60", "1:00", "01:0", "01:00Z", "01:00\n", "０１:００"])(
    "rejects invalid quiet minute case %#",
    (start) => failure(input(undefined, start)),
  );
  it("rejects equal endpoints rather than guessing all-day or disabled policy", () =>
    failure(input(undefined, "12:00", "12:00")));
  it.each([
    "",
    "GMT",
    "EST",
    "+05:30",
    "UTC+5",
    "utc",
    "US/Eastern",
    "Etc/UTC",
    "Asia/Kolkata",
    "Europe/Unknown",
    "america/New_York",
    "America//New_York",
    "America/New_York\n",
    "x".repeat(81),
  ])("rejects a noncanonical/invalid known zone even when unused or disabled case %#", (zone) => {
    failure(input(undefined, undefined, undefined, zone));
    failure({ ...input(), organizationTimeZone: zone });
    failure({ ...input(), quietHours: null, recipientTimeZone: zone });
  });

  it.each(
    [
      null,
      undefined,
      true,
      1,
      "UTC",
      [],
      new Date(0),
      {},
      { ...input(), dueInstant: new Date(0) },
      { ...input(), recipientTimeZone: undefined },
      { ...input(), organizationTimeZone: null },
      { ...input(), quietHours: undefined },
      { ...input(), quietHours: {} },
      { ...input(), quietHours: { start: "22:00", end: "08:00", extra: true } },
      { ...input(), quietHours: { start: 22, end: "08:00" } },
      { ...input(), extra: true },
    ].map((value) => ({ value })),
  )("rejects non-closed data without coercion case %#", ({ value }) => failure(value));

  it.each(["dueInstant", "recipientTimeZone", "organizationTimeZone", "quietHours"])(
    "requires explicit field %s",
    (field) => {
      const value: Record<string, unknown> = { ...input() };
      delete value[field];
      failure(value);
    },
  );

  it("accepts null-prototype own data and rejects hidden/symbol/custom-prototype data", () => {
    const value = Object.assign(Object.create(null), input());
    value.quietHours = Object.assign(Object.create(null), value.quietHours);
    expect(resolveQuietHours(value).decision).toBe("quiet-hours-deferred");
    failure(Object.create(input()));
    failure(Object.assign(Object.create({ extra: true }), input()));
    failure(Object.defineProperty(input(), "dueInstant", { value: input().dueInstant, enumerable: false }));
    failure(Object.defineProperty(input(), "extra", { value: true }));
    failure({ ...input(), [Symbol("secret")]: true });
    failure({ ...input(), quietHours: Object.create({ start: "22:00", end: "08:00" }) });
    failure({
      ...input(),
      quietHours: Object.defineProperty({ start: "22:00", end: "08:00" }, "end", { enumerable: false }),
    });
    failure({ ...input(), quietHours: { start: "22:00", end: "08:00", [Symbol("secret")]: true } });
  });

  it("does not execute input getters, hooks, proxies or coercion", () => {
    let hooks = 0;
    const hook = () => {
      hooks++;
      throw new Error("private input hook");
    };
    const traps = { get: hook, getPrototypeOf: hook, ownKeys: hook, getOwnPropertyDescriptor: hook };
    failure(Object.defineProperty(input(), "dueInstant", { enumerable: true, get: hook }));
    failure({ ...input(), toJSON: hook });
    failure({ ...input(), dueInstant: { valueOf: hook, toString: hook } });
    failure({
      ...input(),
      quietHours: Object.defineProperty({ end: "08:00" }, "start", { enumerable: true, get: hook }),
    });
    failure(new Proxy(input(), traps));
    failure({ ...input(), quietHours: new Proxy({ start: "22:00", end: "08:00" }, traps) });
    const revoked = Proxy.revocable(input(), {});
    revoked.revoke();
    failure(revoked.proxy);
    expect(hooks).toBe(0);
  });

  it("does not execute inherited JSON hooks", () => {
    let hooks = 0;
    const beforeObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const beforeArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const hook = () => {
      hooks++;
      throw new Error("private JSON hook");
    };
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      expect(resolveQuietHours(input()).decision).toBe("quiet-hours-deferred");
      expect(hooks).toBe(0);
    } finally {
      if (beforeObject) Object.defineProperty(Object.prototype, "toJSON", beforeObject);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
      if (beforeArray) Object.defineProperty(Array.prototype, "toJSON", beforeArray);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it("bounds unsupported never-eligible data to2881 chronological numeric observations", () => {
    const parts: Intl.DateTimeFormatPart[] = [
      { type: "year", value: "2026" },
      { type: "month", value: "06" },
      { type: "day", value: "01" },
      { type: "hour", value: "12" },
      { type: "minute", value: "00" },
      { type: "second", value: "00" },
    ];
    const calls = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(parts);
    const value = input("2026-06-01T12:00:00.000Z", "00:00", "23:59");
    failure(value, "quiet_hours_unavailable");
    expect(calls).toHaveBeenCalledTimes(2881);
    expect(calls.mock.calls[0][0]).toBe(Date.UTC(2026, 5, 1, 12));
    expect(calls.mock.calls[2880][0]).toBe(Date.UTC(2026, 5, 3, 12));
    for (let index = 1; index < calls.mock.calls.length; index++)
      expect(Number(calls.mock.calls[index][0]) - Number(calls.mock.calls[index - 1][0])).toBe(60_000);
  });

  it("starts after a quiet fractional minute and never rounds an allowed due instant", () => {
    const calls = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    resolveQuietHours(input("2026-06-01T07:59:59.999Z"));
    expect(calls.mock.calls.map(([instant]) => instant)).toEqual([
      Date.UTC(2026, 5, 1, 7, 59, 59, 999),
      Date.UTC(2026, 5, 1, 8),
    ]);
    calls.mockClear();
    resolveQuietHours(input("2026-06-01T08:00:12.345Z"));
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it.each([[], [{ type: "year", value: "2026" }], null].map((parts) => ({ parts })))(
    "fails closed on malformed Intl parts case %#",
    ({ parts }) => {
      vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(
        parts as Intl.DateTimeFormatPart[],
      );
      failure(input(), "quiet_hours_unavailable");
    },
  );

  it.each([
    ["year", "1998"],
    ["year", "2102"],
    ["month", "13"],
    ["day", "31"],
    ["hour", "24"],
    ["minute", "60"],
    ["second", "60"],
    ["second", "13"],
    ["hour", "secret"],
    ["era", "1"],
  ])("fails closed on invalid or subminute-offset Intl data case %#", (field, value) => {
    const original = new Intl.DateTimeFormat("en-US", {
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
    }).formatToParts(Date.UTC(2026, 5, 1, 23, 14, 12));
    const malformed = original.map((part) => (part.type === field ? { ...part, value } : part));
    if (field === "era") malformed.push({ type: "era", value });
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(malformed);
    failure(input(), "quiet_hours_unavailable");
  });

  it("does not execute hostile Intl part descriptors or proxies", () => {
    let hooks = 0;
    const hook = () => {
      hooks++;
      throw new Error("private Intl hook");
    };
    const part = Object.defineProperty({ type: "year" }, "value", { get: hook });
    const calls = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    calls.mockReturnValue([part, part, part, part, part, part] as Intl.DateTimeFormatPart[]);
    failure(input(), "quiet_hours_unavailable");
    calls.mockRestore();
    const before = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "formatToParts")!;
    try {
      // A spy records returned promise-like values, which itself reads a proxy's properties.
      // A plain method replacement tests only the resolver's own proxy boundary.
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", {
        ...before,
        value: () => new Proxy([], { get: hook, getPrototypeOf: hook }),
      });
      failure(input(), "quiet_hours_unavailable");
    } finally {
      Object.defineProperty(Intl.DateTimeFormat.prototype, "formatToParts", before);
    }
    expect(hooks).toBe(0);
  });

  it("does not reflect constructor, options or formatter exceptions", () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
      throw new Error("private formatter");
    });
    failure(input(), "quiet_hours_unavailable");
    vi.restoreAllMocks();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => {
      throw new Error("private options");
    });
    failure(input(), "quiet_hours_unavailable");
    vi.restoreAllMocks();
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      throw new Error("private constructor");
    });
    failure(input(), "quiet_hours_unavailable");
  });

  it.each(["calendar", "numberingSystem", "hourCycle"])(
    "fails closed when Intl ignores the requested %s",
    (field) => {
      const options = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        calendar: "gregory",
        numberingSystem: "latn",
        hourCycle: "h23",
        hour: "2-digit",
      }).resolvedOptions();
      vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
        ...options,
        [field]: "unsupported",
      });
      failure(input(), "quiet_hours_unavailable");
    },
  );
});
