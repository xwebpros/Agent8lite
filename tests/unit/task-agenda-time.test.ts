import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatTaskAgendaInstant,
  partitionLoadedTasks,
  taskAgendaInputLimit,
  taskAgendaVisibleLimit,
  validTaskAgendaTimezone,
} from "../../apps/web/components/task-agenda-time";
import type { Schema } from "../../apps/web/lib/api";

const id = (n: number) => `db000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n = 1, dueAt = "2026-10-10T12:00:00.000Z"): Schema<"Task"> => ({
  id: id(n),
  assigneeMemberId: id(999),
  title: `Loaded synthetic task ${n}`,
  dueAt,
  timezone: "America/Los_Angeles",
  priority: "normal",
  state: "open",
  version: 1,
});
function ready(rows: Schema<"Task">[], now: unknown, zone: unknown = "America/Los_Angeles") {
  const result = partitionLoadedTasks(rows, now, zone);
  expect(result.state).toBe("ready");
  if (result.state !== "ready") throw new Error("Expected a valid loaded task partition.");
  return result;
}
function groups(dates: string[], now: string, zone = "America/Los_Angeles") {
  const result = ready(
    dates.map((due, index) => task(index + 1, due)),
    now,
    zone,
  );
  return Object.fromEntries(
    Object.entries(result.groups).map(([key, rows]) => [key, rows.map((row) => row.id)]),
  );
}
afterEach(() => vi.restoreAllMocks());

describe("loaded task timing with one explicit UTC clock and user Gregorian date", () => {
  it("uses a strict instant comparison and preserves millisecond equality", () => {
    expect(
      groups(
        ["2026-10-10T11:59:59.999Z", "2026-10-10T12:00:00.000Z", "2026-10-10T12:00:00.001Z"],
        "2026-10-10T12:00:00.000Z",
        "UTC",
      ),
    ).toEqual({ overdue: [id(1)], today: [id(2), id(3)], upcoming: [] });
  });
  it("uses the 23-hour Los Angeles spring day rather than a UTC date or fixed24 hours", () => {
    expect(
      groups(
        [
          "2026-03-08T07:59:59.999Z",
          "2026-03-08T08:00:00.000Z",
          "2026-03-09T06:59:59.999Z",
          "2026-03-09T07:00:00.000Z",
        ],
        "2026-03-08T08:00:00.000Z",
      ),
    ).toEqual({ overdue: [id(1)], today: [id(2), id(3)], upcoming: [id(4)] });
  });
  it("distinguishes both fall01:30 instants and the 25-hour local day", () => {
    expect(
      groups(
        [
          "2026-11-01T08:30:00.000Z",
          "2026-11-01T09:30:00.000Z",
          "2026-11-02T07:59:59.999Z",
          "2026-11-02T08:00:00.000Z",
        ],
        "2026-11-01T08:45:00.000Z",
      ),
    ).toEqual({ overdue: [id(1)], today: [id(2), id(3)], upcoming: [id(4)] });
  });
  it("derives leap-day dates in the explicitly selected zone", () => {
    expect(
      groups(
        ["2028-03-01T04:59:59.999Z", "2028-03-01T05:00:00.000Z"],
        "2028-02-29T18:00:00.000Z",
        "America/New_York",
      ),
    ).toEqual({ overdue: [], today: [id(1)], upcoming: [id(2)] });
  });
  it("honors Kathmandu's45-minute offset at its midnight", () => {
    expect(
      groups(
        ["2026-10-10T18:14:59.999Z", "2026-10-10T18:15:00.000Z"],
        "2026-10-10T18:14:59.999Z",
        "Asia/Kathmandu",
      ),
    ).toEqual({ overdue: [], today: [id(1)], upcoming: [id(2)] });
  });
  it("honors Lord Howe's half-hour spring transition", () => {
    expect(
      groups(
        ["2026-10-03T15:29:59.999Z", "2026-10-03T15:30:00.000Z", "2026-10-04T13:00:00.000Z"],
        "2026-10-03T15:30:00.000Z",
        "Australia/Lord_Howe",
      ),
    ).toEqual({ overdue: [id(1)], today: [id(2)], upcoming: [id(3)] });
  });
  it("classifies by user time rather than the stored source zone", () => {
    const row = { ...task(1, "2026-10-11T06:00:00.000Z"), timezone: "Asia/Tokyo" };
    const result = ready([row], "2026-10-10T20:00:00.000Z");
    expect(result.userDay).toBe("2026-10-10");
    expect(result.groups.today.map((r) => r.id)).toEqual([row.id]);
  });
  it("normalizes a valid UTC clock without consulting Date.now", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Workstation clock must not be consulted.");
    });
    const result = ready([task()], "2026-10-10T12:00:00Z", "UTC");
    expect(result.capturedAt).toBe("2026-10-10T12:00:00.000Z");
    expect(result.userTimezone).toBe("UTC");
  });
  it("excludes valid completed/cancelled records without mutating or truncating loaded data", () => {
    const rows = [
      task(),
      { ...task(2), state: "done" as const },
      { ...task(3), state: "cancelled" as const },
    ];
    const original = JSON.stringify(rows);
    const result = ready(rows, "2026-10-10T12:00:00Z", "UTC");
    expect(result.groups.today.map((r) => r.id)).toEqual([id(1)]);
    expect(JSON.stringify(rows)).toBe(original);
    expect(result.groups.today[0]).not.toBe(rows[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.groups.today)).toBe(true);
    expect(Object.isFrozen(result.groups.today[0])).toBe(true);
  });
  it("accepts an explicitly empty loaded subset without inventing additional tasks", () => {
    expect(ready([], "2026-10-10T12:00:00Z", "UTC").groups).toEqual({ overdue: [], today: [], upcoming: [] });
  });
  it.each([
    undefined,
    null,
    1791633600000,
    new Date("2026-10-10T12:00:00Z"),
    "2026-10-10T12:00:00+00:00",
    "not-an-instant",
    "2028-02-30T12:00:00Z",
  ])("does not substitute a default for invalid supplied current clock %#", (now) => {
    expect(partitionLoadedTasks([task()], now, "UTC").state).toBe("unavailable");
  });
  it.each([undefined, null, "", "PRIVATE_INVALID_ZONE", "+05:45", "GMT+5"])(
    "denies missing or invalid named user timezone %#",
    (zone) => {
      expect(partitionLoadedTasks([task()], "2026-10-10T12:00:00Z", zone).state).toBe("unavailable");
    },
  );
  it.each([
    { title: "" },
    { timezone: "PRIVATE_INVALID_ZONE" },
    { dueAt: "2028-02-30T12:00:00Z" },
    { dueAt: "invalid" },
    { version: 0 },
    { state: "unknown" },
    { unexpected: "private" },
    { dueAt: "invalid", state: "done" },
    { timezone: "PRIVATE_INVALID_ZONE", state: "cancelled" },
  ])("makes the whole loaded subset unavailable for invalid source metadata %#", (patch) => {
    const rows = [task(), { ...task(2), ...patch } as Schema<"Task">];
    expect(partitionLoadedTasks(rows, "2026-10-10T12:00:00Z", "UTC")).toEqual({
      state: "unavailable",
      code: "task_agenda_metadata_unavailable",
    });
  });
  it("does not execute clock/zone/source accessors or coercion hooks", () => {
    const hooks = vi.fn(() => "2026-10-10T12:00:00Z");
    const hostile = { toString: hooks, valueOf: hooks };
    expect(partitionLoadedTasks([task()], hostile, "UTC").state).toBe("unavailable");
    expect(partitionLoadedTasks([task()], "2026-10-10T12:00:00Z", hostile).state).toBe("unavailable");
    const row = task();
    Object.defineProperty(row, "dueAt", { enumerable: true, get: hooks });
    expect(partitionLoadedTasks([row], "2026-10-10T12:00:00Z", "UTC").state).toBe("unavailable");
    expect(hooks).not.toHaveBeenCalled();
  });
  it("does not invoke inherited JSON hooks while classifying own plain data", () => {
    const hooks = vi.fn(() => {
      throw new Error("Inherited serializer hook executed.");
    });
    const oldObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const oldArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let result: ReturnType<typeof partitionLoadedTasks>;
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get: hooks });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, get: hooks });
      result = partitionLoadedTasks([task()], "2026-10-10T12:00:00Z", "UTC");
    } finally {
      if (oldObject) Object.defineProperty(Object.prototype, "toJSON", oldObject);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (oldArray) Object.defineProperty(Array.prototype, "toJSON", oldArray);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(result!.state).toBe("ready");
    expect(hooks).not.toHaveBeenCalled();
  });
  it("rejects sparse and augmented arrays instead of silently dropping fields", () => {
    const sparse = [task(), , task(3)] as Schema<"Task">[];
    const extra = Object.assign([task()], { privatePayload: "must not be ignored" });
    for (const rows of [sparse, extra])
      expect(partitionLoadedTasks(rows, "2026-10-10T12:00:00Z", "UTC").state).toBe("unavailable");
  });
  it("bounds source rows and UTF8 bytes before classification, without partial success", () => {
    expect(taskAgendaInputLimit).toBe(500);
    expect(taskAgendaVisibleLimit).toBe(5);
    expect(
      ready(
        Array.from({ length: 500 }, (_, i) => task(i + 1)),
        "2026-10-10T12:00:00Z",
        "UTC",
      ).groups.today,
    ).toHaveLength(500);
    expect(
      partitionLoadedTasks(
        Array.from({ length: 501 }, (_, i) => task(i + 1)),
        "2026-10-10T12:00:00Z",
        "UTC",
      ).state,
    ).toBe("unavailable");
    const large = Array.from({ length: 500 }, (_, i) => ({
      ...task(i + 1),
      title: "🌱".repeat(100),
      description: "🌱".repeat(2000),
    }));
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(4 * 1024 * 1024);
    expect(partitionLoadedTasks(large, "2026-10-10T12:00:00Z", "UTC").state).toBe("unavailable");
  });
  it("formats both repeated-hour offsets and retains safe explicit UTC data", () => {
    expect(validTaskAgendaTimezone("America/Los_Angeles")).toBe(true);
    expect(formatTaskAgendaInstant("2026-11-01T08:30:00Z", "America/Los_Angeles")).toMatch(
      /01:30(?::00)? GMT-7/,
    );
    expect(formatTaskAgendaInstant("2026-11-01T09:30:00Z", "America/Los_Angeles")).toMatch(
      /01:30(?::00)? GMT-8/,
    );
    expect(formatTaskAgendaInstant("2026-03-08T10:00:00Z", "America/Los_Angeles")).toMatch(
      /03:00(?::00)? GMT-7/,
    );
    expect(formatTaskAgendaInstant("invalid", "UTC")).toBeNull();
    expect(formatTaskAgendaInstant("2026-10-10T12:00:00Z", "PRIVATE_INVALID_ZONE")).toBeNull();
  });
});
