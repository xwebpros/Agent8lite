import { types } from "node:util";
import type {
  QuietHoursErrorCode,
  QuietHoursInputV1,
  QuietHoursResolutionV1,
} from "../contracts/internal/quiet-hours";

export type { QuietHoursInputV1, QuietHoursResolutionV1 } from "../contracts/internal/quiet-hours";

/** Fixed safe errors: no input, recipient data or underlying Intl exception is retained. */
export class QuietHoursError extends Error {
  constructor(readonly code: QuietHoursErrorCode) {
    super(code === "quiet_hours_invalid" ? "Quiet hours input is invalid." : "Quiet hours are unavailable.");
    this.name = "QuietHoursError";
  }
}

const minute = 60_000;
const searchWindow = 48 * 60 * minute;
const fields = ["dueInstant", "recipientTimeZone", "organizationTimeZone", "quietHours"] as const;
const intervalFields = ["start", "end"] as const;
const partsFields = ["year", "month", "day", "hour", "minute", "second"] as const;
const fail = (code: QuietHoursErrorCode): never => {
  throw new QuietHoursError(code);
};

function closedData(value: unknown, expected: readonly string[]): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return fail("quiet_hours_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("quiet_hours_invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== "string" || !expected.includes(key))
  )
    return fail("quiet_hours_invalid");
  const result: Record<string, unknown> = Object.create(null);
  for (const field of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
      return fail("quiet_hours_invalid");
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function inputSnapshot(value: unknown): QuietHoursInputV1 {
  const data = closedData(value, fields);
  if (
    typeof data.dueInstant !== "string" ||
    data.dueInstant.length !== 24 ||
    typeof data.organizationTimeZone !== "string" ||
    data.organizationTimeZone.length > 80 ||
    (data.recipientTimeZone !== null &&
      (typeof data.recipientTimeZone !== "string" || data.recipientTimeZone.length > 80))
  )
    return fail("quiet_hours_invalid");
  let quietHours: QuietHoursInputV1["quietHours"] = null;
  if (data.quietHours !== null) {
    const interval = closedData(data.quietHours, intervalFields);
    if (
      typeof interval.start !== "string" ||
      typeof interval.end !== "string" ||
      interval.start.length !== 5 ||
      interval.end.length !== 5 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(interval.start) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(interval.end) ||
      interval.start === interval.end
    )
      return fail("quiet_hours_invalid");
    quietHours = Object.freeze({ start: interval.start, end: interval.end });
  }
  return Object.freeze({
    dueInstant: data.dueInstant,
    recipientTimeZone: data.recipientTimeZone,
    organizationTimeZone: data.organizationTimeZone,
    quietHours,
  });
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function dueStamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/.test(value))
    return fail("quiet_hours_invalid");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 2000 || year > 2100 || !validDate(year, month, day)) return fail("quiet_hours_invalid");
  return Date.UTC(
    year,
    month - 1,
    day,
    Number(value.slice(11, 13)),
    Number(value.slice(14, 16)),
    Number(value.slice(17, 19)),
    Number(value.slice(20, 23)),
  );
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  if (!/^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(timeZone)) return fail("quiet_hours_invalid");
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
    return fail(error instanceof RangeError ? "quiet_hours_invalid" : "quiet_hours_unavailable");
  }
  if (result === null || typeof result !== "object" || types.isProxy(result))
    return fail("quiet_hours_unavailable");
  let options: unknown;
  try {
    options = result.resolvedOptions();
  } catch {
    return fail("quiet_hours_unavailable");
  }
  if (options === null || typeof options !== "object" || types.isProxy(options))
    return fail("quiet_hours_unavailable");
  const readOption = (field: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(options, field);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string")
      return fail("quiet_hours_unavailable");
    return descriptor.value as string;
  };
  if (readOption("timeZone") !== timeZone) return fail("quiet_hours_invalid");
  if (
    readOption("calendar") !== "gregory" ||
    readOption("numberingSystem") !== "latn" ||
    readOption("hourCycle") !== "h23"
  )
    return fail("quiet_hours_unavailable");
  return result;
}

function wallMinuteAt(format: Intl.DateTimeFormat, instant: number): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    // An explicit numeric instant prevents Intl from consulting the current clock.
    parts = format.formatToParts(instant);
  } catch {
    return fail("quiet_hours_unavailable");
  }
  if (types.isProxy(parts) || !Array.isArray(parts) || parts.length < 6 || parts.length > 24)
    return fail("quiet_hours_unavailable");
  const values = new Map<string, number>();
  for (let index = 0; index < parts.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(parts, String(index));
    const part: unknown = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
    if (part === null || typeof part !== "object" || types.isProxy(part))
      return fail("quiet_hours_unavailable");
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
      return fail("quiet_hours_unavailable");
    if (kind.value === "literal") continue;
    if (
      !partsFields.includes(kind.value as (typeof partsFields)[number]) ||
      values.has(kind.value) ||
      !/^\d{1,4}$/.test(text.value)
    )
      return fail("quiet_hours_unavailable");
    values.set(kind.value, Number(text.value));
  }
  if (values.size !== partsFields.length) return fail("quiet_hours_unavailable");
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
    seconds > 59 ||
    seconds !== Math.floor((instant % minute) / 1000)
  )
    return fail("quiet_hours_unavailable");
  return hour * 60 + minutes;
}

const localMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/**
 * Earliest allowed UTC instant at or after a supplied due time, never send authority.
 * Pinned ICU/tzdb; at most2,881 observations over48 hours. No calendar overlap shortcut.
 */
export function resolveQuietHours(value: unknown): QuietHoursResolutionV1 {
  const input = inputSnapshot(value);
  const due = dueStamp(input.dueInstant);
  const organizationFormat = formatter(input.organizationTimeZone);
  const timeZone = input.recipientTimeZone ?? input.organizationTimeZone;
  const format = timeZone === input.organizationTimeZone ? organizationFormat : formatter(timeZone);
  const observedDue = wallMinuteAt(format, due);
  const result = (eligibleInstant: string, decision: QuietHoursResolutionV1["decision"]) =>
    Object.freeze({
      dueInstant: input.dueInstant,
      eligibleInstant,
      timeZone,
      timeZoneSource: input.recipientTimeZone === null ? "organization-fallback" : "recipient",
      decision,
    }) as QuietHoursResolutionV1;
  if (input.quietHours === null) return result(input.dueInstant, "quiet-hours-disabled");
  const start = localMinute(input.quietHours.start);
  const end = localMinute(input.quietHours.end);
  const quiet = (wall: number) => (start < end ? wall >= start && wall < end : wall >= start || wall < end);
  if (!quiet(observedDue)) return result(input.dueInstant, "unchanged");
  const deadline = due + searchWindow;
  for (let instant = Math.floor(due / minute) * minute + minute; instant <= deadline; instant += minute) {
    if (!quiet(wallMinuteAt(format, instant)))
      return result(new Date(instant).toISOString(), "quiet-hours-deferred");
  }
  return fail("quiet_hours_unavailable");
}
