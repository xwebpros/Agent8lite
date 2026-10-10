import { describe, expect, it } from "vitest";
import {
  propertiesAreCurrent,
  propertyExpiryDelay,
  PropertyReads,
} from "../../apps/web/features/properties/read-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("W07 private property read completion ordering (no browser acceptance)", () => {
  it.each(["list-first", "detail-first"])(
    "keeps unavailable detail invalidation final even when a list transport ignores abort (%s)",
    async (order) => {
      const reads = new PropertyReads();
      const list = reads.begin("list", "member:org:revision");
      const detail = reads.begin("detail", "member:org:revision");
      const response = deferred<string>();
      let visible: string | null = "previous private page";
      let completions = 0;
      const completion = response.promise.then((value) => {
        ++completions;
        if (reads.current(list, "member:org:revision", true)) visible = value;
      });
      const unavailable = () => {
        expect(reads.current(detail, "member:org:revision", true)).toBe(true);
        reads.clear();
        visible = null;
      };
      if (order === "list-first") {
        response.resolve("overlapping private page");
        await completion;
        expect(visible).toBe("overlapping private page");
        unavailable();
      } else {
        unavailable();
        response.resolve("late private page");
        await completion;
      }
      expect(completions).toBe(1);
      expect(list.controller.signal.aborted).toBe(true);
      expect(detail.controller.signal.aborted).toBe(true);
      expect(visible).toBeNull();
    },
  );

  it.each(["list", "detail"] as const)(
    "ignores an older %s response that finishes after its replacement",
    async (kind) => {
      const reads = new PropertyReads();
      const first = reads.begin(kind, "current-scope");
      const oldResponse = deferred<string>();
      const second = reads.begin(kind, "current-scope");
      const newResponse = deferred<string>();
      const visible: string[] = [];
      const oldCompletion = oldResponse.promise.then((value) => {
        if (reads.current(first, "current-scope", true)) visible.push(value);
      });
      const newCompletion = newResponse.promise.then((value) => {
        if (reads.current(second, "current-scope", true)) visible.push(value);
      });
      newResponse.resolve("fresh current response");
      await newCompletion;
      oldResponse.resolve("stale private response");
      await oldCompletion;
      expect(first.controller.signal.aborted).toBe(true);
      expect(second.controller.signal.aborted).toBe(false);
      expect(visible).toEqual(["fresh current response"]);
    },
  );

  it.each([
    ["changed-org", true],
    ["changed-member", true],
    ["changed-access-revision", true],
    ["original-scope", false],
  ])("rejects completion before cleanup when current scope/access changes to %s/%s", (scope, enabled) => {
    const reads = new PropertyReads();
    const request = reads.begin("list", "original-scope");
    expect(request.controller.signal.aborted).toBe(false);
    expect(reads.current(request, scope, enabled)).toBe(false);
  });

  it("closing or changing detail selection preserves the independently current list", () => {
    const reads = new PropertyReads();
    const list = reads.begin("list", "current-scope");
    const detail = reads.begin("detail", "current-scope");
    reads.cancel("detail");
    expect(reads.current(detail, "current-scope", true)).toBe(false);
    expect(reads.current(list, "current-scope", true)).toBe(true);
    reads.clear();
    expect(reads.current(list, "current-scope", true)).toBe(false);
  });

  it("requires a fresh read after expiry, unmount or revoked-access clearing", () => {
    const reads = new PropertyReads();
    const list = reads.begin("list", "current-scope");
    const detail = reads.begin("detail", "current-scope");
    reads.clear();
    reads.clear();
    expect(reads.current(list, "current-scope", true)).toBe(false);
    expect(reads.current(detail, "current-scope", true)).toBe(false);
    const fresh = reads.begin("list", "current-scope");
    expect(reads.current(fresh, "current-scope", true)).toBe(true);
  });
});

describe("W07 property expiry without depending on timely browser timers", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  const property = (milliseconds: number) => ({ expiresAt: new Date(milliseconds).toISOString() });

  it("hides the whole stored surface exactly at the earliest expiry on a later render", () => {
    const items = [property(now + 5_000), property(now + 10_000)];
    expect(propertiesAreCurrent(items, now + 4_999)).toBe(true);
    // Simulate a suspended tab whose timer has not run, then render at the deadline.
    expect(propertiesAreCurrent(items, now + 5_000)).toBe(false);
    expect(propertyExpiryDelay(items, now + 5_000)).toBe(0);
    expect(propertiesAreCurrent(items, now + 20_000)).toBe(false);
  });

  it.each(["invalid", "", "2026-10-09T23:59:59Z"])(
    "denies malformed or expired response time %j",
    (expiresAt) => {
      expect(propertiesAreCurrent([{ expiresAt }], now)).toBe(false);
      expect(propertyExpiryDelay([{ expiresAt }], now)).toBe(0);
    },
  );

  it("bounds long timer delays and rechecks rather than falsely expiring future records", () => {
    const items = [property(now + 3_000_000_000)];
    const delay = propertyExpiryDelay(items, now)!;
    expect(delay).toBe(2_147_483_647);
    expect(propertiesAreCurrent(items, now + delay)).toBe(true);
    expect(propertyExpiryDelay(items, now + delay)).toBe(852_516_353);
    expect(propertyExpiryDelay(items, now + 3_000_000_000)).toBe(0);
  });

  it("uses the earliest list/detail deadline and does not schedule an empty surface", () => {
    expect(propertyExpiryDelay([property(now + 20_000), property(now + 1_000)], now)).toBe(1_000);
    expect(propertyExpiryDelay([], now)).toBeNull();
    expect(propertiesAreCurrent([], now)).toBe(true);
    expect(propertiesAreCurrent([property(now + 1_000)], Number.NaN)).toBe(false);
  });
});
