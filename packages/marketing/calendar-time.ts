import { types } from "node:util";
import type {
  CalendarTimeErrorCode,
  CalendarTimeInputV1,
  CalendarTimeResolutionV1,
} from "../contracts/internal/calendar-time";

export type { CalendarTimeInputV1, CalendarTimeResolutionV1 } from "../contracts/internal/calendar-time";

/** Fixed safe errors only: supplied dates, zones and Intl errors are never retained. */
export class CalendarTimeError extends Error {
  constructor(readonly code: CalendarTimeErrorCode) {
    super(
      code === "calendar_time_invalid" ? "Calendar time input is invalid." : "Calendar time is unavailable.",
    );
    this.name = "CalendarTimeError";
  }
}

const minute = 60_000;
const windowRadius = 48 * 60 * minute;
const fields = ["localDate", "localTime", "timeZone"] as const;
const partsFields = ["year", "month", "day", "hour", "minute", "second"] as const;
type Wall = { stamp: number; date: string; time: string };
const fail = (code: CalendarTimeErrorCode): never => {
  throw new CalendarTimeError(code);
};

function inputSnapshot(value: unknown): CalendarTimeInputV1 {
  if (value === null || typeof value !== "object" || types.isProxy(value))
    return fail("calendar_time_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("calendar_time_invalid");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key as (typeof fields)[number])))
    return fail("calendar_time_invalid");
  const result: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value") ||
      typeof descriptor.value !== "string" ||
      descriptor.value.length > (field === "timeZone" ? 80 : field === "localDate" ? 10 : 5)
    )
      return fail("calendar_time_invalid");
    result[field] = descriptor.value;
  }
  return Object.freeze(result) as CalendarTimeInputV1;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function requestedStamp(input: CalendarTimeInputV1): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime))
    return fail("calendar_time_invalid");
  const year = Number(input.localDate.slice(0, 4));
  const month = Number(input.localDate.slice(5, 7));
  const day = Number(input.localDate.slice(8));
  if (year < 2000 || year > 2100 || !validDate(year, month, day)) return fail("calendar_time_invalid");
  return Date.UTC(
    year,
    month - 1,
    day,
    Number(input.localTime.slice(0, 2)),
    Number(input.localTime.slice(3)),
  );
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!/^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(timeZone)) return fail("calendar_time_invalid");
  let result: Intl.DateTimeFormat;
  try {
    result = new Intl.DateTimeFormat("en-US", {
      timeZone,
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
  } catch (error) {
    return fail(error instanceof RangeError ? "calendar_time_invalid" : "calendar_time_unavailable");
  }
  let options: unknown;
  try {
    options = result.resolvedOptions();
  } catch {
    return fail("calendar_time_unavailable");
  }
  if (options === null || typeof options !== "object" || types.isProxy(options))
    return fail("calendar_time_unavailable");
  const readOption = (field: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string")
      return fail("calendar_time_unavailable");
    return descriptor.value as string;
  };
  if (readOption("timeZone") !== timeZone) return fail("calendar_time_invalid");
  if (
    readOption("calendar") !== "gregory" ||
    readOption("numberingSystem") !== "latn" ||
    readOption("hourCycle") !== "h23"
  )
    return fail("calendar_time_unavailable");
  return result;
}

function wallAt(format: Intl.DateTimeFormat, instant: number): Wall {
  let parts: Intl.DateTimeFormatPart[];
  try {
    // Always pass a numeric instant: omitting it would consult the current clock.
    parts = format.formatToParts(instant);
  } catch {
    return fail("calendar_time_unavailable");
  }
  if (types.isProxy(parts) || !Array.isArray(parts) || parts.length < 6 || parts.length > 24)
    return fail("calendar_time_unavailable");
  const values = new Map<string, number>();
  for (let index = 0; index < parts.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(parts, String(index));
    const part: unknown = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (part === null || typeof part !== "object" || types.isProxy(part))
      return fail("calendar_time_unavailable");
    const kind = Object.getOwnPropertyDescriptor(part, "type");
    const text = Object.getOwnPropertyDescriptor(part, "value");
    if (
      !kind ||
      !text ||
      !Object.hasOwn(kind, "value") ||
      !Object.hasOwn(text, "value") ||
      typeof kind.value !== "string" ||
      typeof text.value !== "string"
    )
      return fail("calendar_time_unavailable");
    if (kind.value === "literal") continue;
    if (
      !partsFields.includes(kind.value as (typeof partsFields)[number]) ||
      values.has(kind.value) ||
      !/^\d{1,4}$/.test(text.value)
    )
      return fail("calendar_time_unavailable");
    values.set(kind.value, Number(text.value));
  }
  if (values.size !== partsFields.length) return fail("calendar_time_unavailable");
  const year = values.get("year")!;
  const month = values.get("month")!;
  const day = values.get("day")!;
  const hour = values.get("hour")!;
  const minutes = values.get("minute")!;
  const seconds = values.get("second")!;
  if (
    year < 1999 ||
    year > 2101 ||
    !validDate(year, month, day) ||
    hour > 23 ||
    minutes > 59 ||
    seconds !== 0
  )
    return fail("calendar_time_unavailable");
  return {
    stamp: Date.UTC(year, month - 1, day, hour, minutes),
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
  };
}

/**
 * Pure minute-resolution calendar candidate, never a schedule or send authority.
 * Uses pinned ICU/tzdb and at most 5,761 parts calls across a fixed 96-hour window.
 * Modern named-zone offsets must be minute-aligned; unsupported data fails closed.
 */
export function resolveCalendarTime(value: unknown): CalendarTimeResolutionV1 {
  const input = inputSnapshot(value);
  const requested = requestedStamp(input);
  const format = formatter(input.timeZone);
  let exactCount = 0;
  let earliestExact: number | undefined;
  let previousWall: number | undefined;
  let gapProven = false;
  let next: { wall: Wall; instant: number } | undefined;
  for (let instant = requested - windowRadius; instant <= requested + windowRadius; instant += minute) {
    const wall = wallAt(format, instant);
    if (wall.stamp === requested) {
      exactCount += 1;
      earliestExact ??= instant;
    }
    if (wall.stamp > requested && (!next || wall.stamp < next.wall.stamp)) next = { wall, instant };
    if (
      previousWall !== undefined &&
      previousWall < requested &&
      wall.stamp > requested &&
      wall.stamp - previousWall > minute
    )
      gapProven = true;
    previousWall = wall.stamp;
  }
  if (earliestExact === undefined && (!gapProven || !next)) return fail("calendar_time_unavailable");
  const instant = earliestExact ?? next!.instant;
  return Object.freeze({
    timeZone: input.timeZone,
    requestedLocal: Object.freeze({ date: input.localDate, time: input.localTime }),
    effectiveLocal: Object.freeze(
      earliestExact === undefined
        ? { date: next!.wall.date, time: next!.wall.time }
        : { date: input.localDate, time: input.localTime },
    ),
    instant: new Date(instant).toISOString(),
    decision: earliestExact === undefined ? "gap-first-valid" : exactCount > 1 ? "overlap-earlier" : "exact",
  });
}
