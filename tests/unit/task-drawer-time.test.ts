import { describe, expect, it, vi } from "vitest";
import { resolveTaskDrawerTiming } from "../../apps/web/components/task-agenda-time";

const baseline = "2026-11-01T01:30";
const original = { dueAt: "2026-11-01T09:30:47.123Z", timezone: "US/Pacific" };

describe("captured task drawer baseline versus explicitly changed wall time", () => {
  it("preserves the exact second Los Angeles overlap instant, alias and subminute precision without resolving", () => {
    const resolver = vi.fn(() => {
      throw new Error("Unchanged wall input must not resolve again.");
    });
    const result = resolveTaskDrawerTiming(original, baseline, baseline, resolver);
    expect(result).toEqual(original);
    expect(result).not.toBe(original);
    expect(Object.isFrozen(result)).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each(["2026-11-01T08:30:01.001Z", "2026-11-01T09:30:59.999Z", "2026-11-01T01:30:47.123-08:00"])(
    "preserves supplied original representation %# when captured input remains unchanged",
    (dueAt) => {
      const resolver = vi.fn();
      expect(
        resolveTaskDrawerTiming({ dueAt, timezone: "America/Los_Angeles" }, baseline, baseline, resolver),
      ).toEqual({ dueAt, timezone: "America/Los_Angeles" });
      expect(resolver).not.toHaveBeenCalled();
    },
  );
  it("compares the captured input baseline without recomputing workstation local time", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("No current clock policy.");
    });
    const resolver = vi.fn();
    try {
      expect(resolveTaskDrawerTiming(original, "2026-11-01T16:30", "2026-11-01T16:30", resolver)).toEqual(
        original,
      );
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
  it("resolves a changed wall time exactly once through the supplied policy and validates/detaches output", () => {
    const output = { dueAt: "2026-11-01T10:30:00.000Z", timezone: "America/Los_Angeles" };
    const resolver = vi.fn(() => output);
    const result = resolveTaskDrawerTiming(original, baseline, "2026-11-01T02:30", resolver);
    expect(resolver).toHaveBeenCalledExactlyOnceWith("2026-11-01T02:30");
    expect(result).toEqual(output);
    expect(result).not.toBe(output);
    expect(Object.isFrozen(result)).toBe(true);
    output.timezone = "UTC";
    expect(result.timezone).toBe("America/Los_Angeles");
    expect(original).toEqual({ dueAt: "2026-11-01T09:30:47.123Z", timezone: "US/Pacific" });
  });
  it("does not infer a daylight-saving resolver choice for changed ambiguous wall input", () => {
    const resolver = vi.fn(() => ({ dueAt: "2026-11-01T09:45:00.000Z", timezone: "US/Pacific" }));
    expect(resolveTaskDrawerTiming(original, baseline, "2026-11-01T01:45", resolver)).toEqual({
      dueAt: "2026-11-01T09:45:00.000Z",
      timezone: "US/Pacific",
    });
    expect(resolver).toHaveBeenCalledExactlyOnceWith("2026-11-01T01:45");
  });
  it.each([
    undefined,
    null,
    1793515800000,
    new Date("2026-11-01T09:30Z"),
    "",
    "2026-11-01T01:30Z",
    "2026-02-30T01:30",
    "2026-11-01T25:30",
  ])("rejects invalid captured baseline without invoking a supplied resolver %#", (value) => {
    const resolver = vi.fn();
    expect(() => resolveTaskDrawerTiming(original, value, "2026-11-01T02:30", resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    null,
    1,
    "",
    " 2026-11-01T01:30",
    "2026-11-01T01:30Z",
    "2026-02-29T01:30",
    "2026-11-01T01:60",
  ])("rejects invalid entered wall time before resolving %#", (value) => {
    const resolver = vi.fn();
    expect(() => resolveTaskDrawerTiming(original, baseline, value, resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each([
    { dueAt: "invalid", timezone: "US/Pacific" },
    { dueAt: original.dueAt, timezone: "PRIVATE_INVALID_ZONE" },
    { dueAt: original.dueAt, timezone: "+01:00" },
    { ...original, unexpected: "PRIVATE_DATA" },
  ])("rejects invalid original source before either unchanged or changed path %#", (source) => {
    const resolver = vi.fn();
    expect(() => resolveTaskDrawerTiming(source, baseline, baseline, resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(() => resolveTaskDrawerTiming(source, baseline, "2026-11-01T02:30", resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { dueAt: "invalid", timezone: "UTC" },
    { dueAt: "2026-02-30T01:30:00Z", timezone: "UTC" },
    { dueAt: original.dueAt, timezone: "+01:00" },
    { dueAt: original.dueAt, timezone: "PRIVATE_INVALID_ZONE" },
    { ...original, privateData: "must not be accepted" },
  ])("rejects malformed or open resolver output rather than silently falling back %#", (output) => {
    const resolver = vi.fn(() => output);
    expect(() => resolveTaskDrawerTiming(original, baseline, "2026-11-01T02:30", resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(resolver).toHaveBeenCalledExactlyOnceWith("2026-11-01T02:30");
  });
  it("keeps errors fixed when the selected resolver fails with private diagnostics", () => {
    const resolver = vi.fn(() => {
      throw new Error("PRIVATE_EXCEPTION_AND_STACK");
    });
    expect(() => resolveTaskDrawerTiming(original, baseline, "2026-11-01T02:30", resolver)).toThrow(
      "Task timing could not be verified.",
    );
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it("never executes hostile wall coercions or timing descriptor accessors", () => {
    const hooks = vi.fn(() => baseline),
      resolver = vi.fn();
    const hostile = { valueOf: hooks, toString: hooks };
    expect(() => resolveTaskDrawerTiming(original, hostile, hostile, resolver)).toThrow();
    const source = { ...original };
    Object.defineProperty(source, "dueAt", { enumerable: true, get: hooks });
    expect(() => resolveTaskDrawerTiming(source, baseline, baseline, resolver)).toThrow();
    const response = { ...original };
    Object.defineProperty(response, "timezone", { enumerable: true, get: hooks });
    expect(() => resolveTaskDrawerTiming(original, baseline, "2026-11-01T02:30", () => response)).toThrow();
    expect(hooks).not.toHaveBeenCalled();
  });
});
