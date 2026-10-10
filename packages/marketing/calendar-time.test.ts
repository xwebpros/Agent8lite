import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarTimeInputV1 } from "../contracts/internal/calendar-time";
import { CalendarTimeError, resolveCalendarTime } from "./calendar-time";

const input = (localDate = "2026-03-08", localTime = "12:00", timeZone = "UTC"): CalendarTimeInputV1 => ({
  localDate,
  localTime,
  timeZone,
});
const invalid = (value: unknown, code = "calendar_time_invalid") => {
  expect(() => resolveCalendarTime(value)).toThrowError(
    expect.objectContaining({ name: "CalendarTimeError", code }),
  );
};
afterEach(() => vi.restoreAllMocks());

describe("pure explicit local calendar-time resolution", () => {
  it.each([
    ["2026-03-08", "12:00", "UTC", "2026-03-08T12:00:00.000Z"],
    ["2000-01-01", "00:00", "UTC", "2000-01-01T00:00:00.000Z"],
    ["2100-12-31", "23:59", "UTC", "2100-12-31T23:59:00.000Z"],
    ["2000-02-29", "00:00", "UTC", "2000-02-29T00:00:00.000Z"],
    ["2000-01-01", "00:00", "Pacific/Kiritimati", "1999-12-31T10:00:00.000Z"],
    ["2100-12-31", "23:59", "Etc/GMT+12", "2101-01-01T11:59:00.000Z"],
    ["2026-01-15", "12:00", "Etc/GMT+5", "2026-01-15T17:00:00.000Z"],
    ["2026-01-15", "12:00", "Etc/GMT-3", "2026-01-15T09:00:00.000Z"],
    ["2026-01-15", "12:00", "Asia/Calcutta", "2026-01-15T06:30:00.000Z"],
    ["2026-01-15", "12:00", "Asia/Katmandu", "2026-01-15T06:15:00.000Z"],
    ["2026-01-15", "12:00", "Australia/Eucla", "2026-01-15T03:15:00.000Z"],
    ["2026-07-15", "12:00", "Pacific/Chatham", "2026-07-14T23:15:00.000Z"],
  ])("resolves an exact minute case %#", (date, time, zone, instant) => {
    expect(resolveCalendarTime(input(date, time, zone))).toEqual({
      timeZone: zone,
      requestedLocal: { date, time },
      effectiveLocal: { date, time },
      instant,
      decision: "exact",
    });
  });

  it.each([
    ["2026-03-08", "02:30", "America/New_York", "2026-03-08", "03:00", "2026-03-08T07:00:00.000Z"],
    ["2026-03-29", "02:30", "Europe/Berlin", "2026-03-29", "03:00", "2026-03-29T01:00:00.000Z"],
    ["2026-10-04", "02:15", "Australia/Lord_Howe", "2026-10-04", "02:30", "2026-10-03T15:30:00.000Z"],
    ["2026-09-27", "03:00", "Pacific/Chatham", "2026-09-27", "03:45", "2026-09-26T14:00:00.000Z"],
    ["2018-11-04", "00:30", "America/Sao_Paulo", "2018-11-04", "01:00", "2018-11-04T03:00:00.000Z"],
    ["2011-12-30", "12:30", "Pacific/Apia", "2011-12-31", "00:00", "2011-12-30T10:00:00.000Z"],
    ["2011-12-30", "00:00", "Pacific/Apia", "2011-12-31", "00:00", "2011-12-30T10:00:00.000Z"],
    ["2011-12-30", "23:59", "Pacific/Apia", "2011-12-31", "00:00", "2011-12-30T10:00:00.000Z"],
  ])(
    "chooses the first valid wall boundary after a gap case %#",
    (date, time, zone, nextDate, nextTime, instant) => {
      expect(resolveCalendarTime(input(date, time, zone))).toEqual({
        timeZone: zone,
        requestedLocal: { date, time },
        effectiveLocal: { date: nextDate, time: nextTime },
        instant,
        decision: "gap-first-valid",
      });
    },
  );

  it.each([
    ["2026-11-01", "01:30", "America/New_York", "2026-11-01T05:30:00.000Z"],
    ["2026-10-25", "02:30", "Europe/Berlin", "2026-10-25T00:30:00.000Z"],
    ["2026-04-05", "01:45", "Australia/Lord_Howe", "2026-04-04T14:45:00.000Z"],
    ["2026-04-05", "03:00", "Pacific/Chatham", "2026-04-04T13:15:00.000Z"],
    ["2014-10-26", "01:30", "Europe/Moscow", "2014-10-25T21:30:00.000Z"],
  ])("chooses the earlier overlap occurrence case %#", (date, time, zone, instant) => {
    const result = resolveCalendarTime(input(date, time, zone));
    expect(result).toMatchObject({ instant, decision: "overlap-earlier", effectiveLocal: { date, time } });
  });

  it.each([
    ["2026-03-08", "01:59", "2026-03-08T06:59:00.000Z", "exact"],
    ["2026-03-08", "02:00", "2026-03-08T07:00:00.000Z", "gap-first-valid"],
    ["2026-03-08", "02:59", "2026-03-08T07:00:00.000Z", "gap-first-valid"],
    ["2026-03-08", "03:00", "2026-03-08T07:00:00.000Z", "exact"],
    ["2026-11-01", "01:00", "2026-11-01T05:00:00.000Z", "overlap-earlier"],
    ["2026-11-01", "01:59", "2026-11-01T05:59:00.000Z", "overlap-earlier"],
    ["2026-11-01", "02:00", "2026-11-01T07:00:00.000Z", "exact"],
  ])("preserves exact gap/overlap endpoint semantics case %#", (date, time, instant, decision) => {
    expect(resolveCalendarTime(input(date, time, "America/New_York"))).toMatchObject({ instant, decision });
  });

  it("returns detached deeply frozen deterministic results without consulting the current/local clock", () => {
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock called");
    });
    const local = vi.spyOn(Date.prototype, "getTimezoneOffset").mockImplementation(() => {
      throw new Error("local clock called");
    });
    const value = { ...input() };
    const first = resolveCalendarTime(value);
    const second = resolveCalendarTime(value);
    value.localDate = "2026-03-09";
    expect(first).toEqual(second);
    expect(first.requestedLocal.date).toBe("2026-03-08");
    for (const object of [first, first.requestedLocal, first.effectiveLocal])
      expect(Object.isFrozen(object)).toBe(true);
    expect(first.requestedLocal).not.toBe(second.requestedLocal);
    expect(clock).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
  });

  it("uses at most the fixed 5,761 minute observations including both endpoints", () => {
    const calls = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    resolveCalendarTime(input("2011-12-30", "12:00", "Pacific/Apia"));
    expect(calls).toHaveBeenCalledTimes(5761);
    for (const [instant] of calls.mock.calls) expect(typeof instant).toBe("number");
  });

  it.each([
    "1999-12-31",
    "2101-01-01",
    "2100-02-29",
    "2026-02-29",
    "2026-04-31",
    "2026-00-10",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-01",
    "26-01-01",
    "2026-01-01Z",
    " 2026-01-01",
    "2026-01-01\n",
    "２０２６-01-01",
  ])("rejects invalid calendar spelling/value case %#", (date) => invalid(input(date)));
  it.each([
    "24:00",
    "23:60",
    "-1:00",
    "00:00:00",
    "0:00",
    "12:0",
    "12:00Z",
    " 12:00",
    "12:00\n",
    "１２:００",
    "",
  ])("rejects invalid local minute case %#", (time) => invalid(input(undefined, time)));
  it.each([
    "",
    "GMT",
    "EST",
    "Z",
    "+05:30",
    "-05:00",
    "UTC+5",
    "utc",
    "america/New_York",
    "US/Eastern",
    "Etc/UTC",
    "Asia/Kolkata",
    "Europe/Unknown",
    "America/New_York ",
    "America//New_York",
    "America/New_York\n",
    "x".repeat(81),
  ])("rejects noncanonical or unavailable zone input case %#", (zone) =>
    invalid(input(undefined, undefined, zone)),
  );
  it.each(
    [
      null,
      undefined,
      true,
      1,
      "2026-03-08",
      [],
      new Date(0),
      new String("UTC"),
      {},
      { ...input(), extra: true },
      { ...input(), localTime: 1200 },
      { ...input(), timeZone: null },
    ].map((value) => ({ value })),
  )("rejects non-closed input case %#", ({ value }) => invalid(value));

  it("accepts null-prototype own data and rejects hidden/symbol fields or custom prototypes", () => {
    expect(resolveCalendarTime(Object.assign(Object.create(null), input())).decision).toBe("exact");
    invalid(Object.create(input()));
    invalid(Object.assign(Object.create({ extra: true }), input()));
    invalid(Object.defineProperty(input(), "extra", { value: true, enumerable: false }));
    invalid(Object.defineProperty(input(), "localDate", { value: "2026-03-08", enumerable: false }));
    invalid({ ...input(), [Symbol("extra")]: "ignored" });
  });

  it("never executes getters, coercion, toJSON or proxy reflection traps", () => {
    let hooks = 0;
    const hook = () => {
      hooks += 1;
      throw new Error("private hook");
    };
    invalid(Object.defineProperty(input(), "localDate", { enumerable: true, get: hook }));
    invalid({ ...input(), toJSON: hook });
    invalid({ ...input(), localTime: { toString: hook, valueOf: hook } });
    invalid(
      new Proxy(input(), { get: hook, getPrototypeOf: hook, ownKeys: hook, getOwnPropertyDescriptor: hook }),
    );
    const revoked = Proxy.revocable(input(), {});
    revoked.revoke();
    invalid(revoked.proxy);
    expect(hooks).toBe(0);
  });

  it("does not run inherited JSON hooks while preparing or returning results", () => {
    let hooks = 0;
    const beforeObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const beforeArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    const hook = () => {
      hooks += 1;
      throw new Error("JSON hook");
    };
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      const result = resolveCalendarTime(input());
      expect(result.instant).toBe("2026-03-08T12:00:00.000Z");
      expect(hooks).toBe(0);
    } finally {
      if (beforeObject) Object.defineProperty(Object.prototype, "toJSON", beforeObject);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
      if (beforeArray) Object.defineProperty(Array.prototype, "toJSON", beforeArray);
      else delete (Array.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it.each([[], [{ type: "year", value: "2026" }], null].map((parts) => ({ parts })))(
    "fails closed for incomplete Intl parts case %#",
    ({ parts }) => {
      vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(
        parts as Intl.DateTimeFormatPart[],
      );
      invalid(input(), "calendar_time_unavailable");
    },
  );
  it.each([
    { type: "second", value: "30" },
    { type: "hour", value: "24" },
    { type: "month", value: "13" },
    { type: "year", value: "1900" },
    { type: "minute", value: "NaN" },
  ])("fails closed for unsupported formatter parts case %#", (replacement) => {
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      instant,
    ) {
      return original
        .call(this, instant)
        .map((part) => (part.type === replacement.type ? (replacement as Intl.DateTimeFormatPart) : part));
    });
    invalid(input(), "calendar_time_unavailable");
  });
  it.each(
    [
      null,
      undefined,
      {},
      { timeZone: "UTC", calendar: "islamic", numberingSystem: "latn", hourCycle: "h23" },
      { timeZone: "UTC", calendar: "gregory", numberingSystem: "arab", hourCycle: "h23" },
      { timeZone: "UTC", calendar: "gregory", numberingSystem: "latn", hourCycle: "h24" },
    ].map((options) => ({ options })),
  )("fails closed for incomplete or unsupported resolved Intl options case %#", ({ options }) => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue(
      options as Intl.ResolvedDateTimeFormatOptions,
    );
    invalid(input(), "calendar_time_unavailable");
  });
  it("rejects hooked or revoked-proxy formatter results without executing their traps", () => {
    let hooks = 0;
    const hook = () => {
      hooks += 1;
      throw new Error("formatter hook");
    };
    const options = Object.defineProperty({}, "timeZone", { get: hook });
    const resolved = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue(options as Intl.ResolvedDateTimeFormatOptions);
    invalid(input(), "calendar_time_unavailable");
    resolved.mockRestore();
    const revoked = Proxy.revocable([], { get: hook });
    revoked.revoke();
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(revoked.proxy);
    invalid(input(), "calendar_time_unavailable");
    expect(hooks).toBe(0);
  });
  it("does not manufacture a gap when the bounded formatter observations never cross the requested wall time", () => {
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
    const parts = format.formatToParts(Date.UTC(2026, 2, 9, 12));
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue(parts);
    invalid(input(), "calendar_time_unavailable");
  });
  it("returns fixed safe errors without retaining formatter exceptions or supplied content", () => {
    const marker = "private-calendar-error-marker";
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(() => {
      throw new Error(marker);
    });
    try {
      resolveCalendarTime(input());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarTimeError);
      expect((error as Error).message).toBe("Calendar time is unavailable.");
      expect(String(error)).not.toContain(marker);
      expect(Object.keys(error as object)).toEqual(["code", "name"]);
    }
  });
});
