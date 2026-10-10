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
  it("marks completed reads idle while keeping a queued current state update valid", () => {
    const reads = new PropertyReads();
    const list = reads.begin("list", "current-scope");
    const detail = reads.begin("detail", "current-scope");
    expect(reads.busy("list") || reads.busy("detail")).toBe(true);
    reads.finish(list);
    expect(reads.busy("list")).toBe(false);
    expect(reads.busy("detail")).toBe(true);
    expect(reads.current(list, "current-scope", true)).toBe(true);
    reads.finish(detail);
    expect(reads.busy("list") || reads.busy("detail")).toBe(false);
  });

  it("finishing an aborted old read does not mark its replacement idle", () => {
    const reads = new PropertyReads();
    const old = reads.begin("list", "current-scope");
    const replacement = reads.begin("list", "current-scope");
    reads.finish(old);
    expect(reads.busy("list")).toBe(true);
    expect(reads.current(old, "current-scope", true)).toBe(false);
    expect(reads.current(replacement, "current-scope", true)).toBe(true);
    reads.clear();
    expect(reads.busy("list")).toBe(false);
  });

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

describe("W07 synchronous property abort callbacks", () => {
  it.each(["list", "detail"] as const)(
    "retires %s tracking before cancellation callbacks and preserves their fresh read",
    (kind) => {
      const reads = new PropertyReads();
      const old = reads.begin(kind, "current-scope");
      const otherKind = kind === "list" ? "detail" : "list";
      const other = reads.begin(otherKind, "current-scope");
      let busyDuringAbort = true;
      let replacement: ReturnType<PropertyReads["begin"]> | undefined;
      old.controller.signal.addEventListener("abort", () => {
        busyDuringAbort = reads.busy(kind);
        replacement = reads.begin(kind, "current-scope");
      });
      reads.cancel(kind);
      expect(busyDuringAbort).toBe(false);
      expect(reads.current(old, "current-scope", true)).toBe(false);
      expect(reads.current(replacement!, "current-scope", true)).toBe(true);
      expect(reads.current(other, "current-scope", true)).toBe(true);
      reads.finish(old);
      expect(reads.busy(kind)).toBe(true);
      reads.clear();
      expect(replacement!.controller.signal.aborted).toBe(true);
    },
  );

  it.each(["list", "detail"] as const)(
    "keeps the newest %s request when replacing an old read invokes another begin",
    (kind) => {
      const reads = new PropertyReads();
      const old = reads.begin(kind, "current-scope");
      let newest: ReturnType<PropertyReads["begin"]> | undefined;
      old.controller.signal.addEventListener("abort", () => {
        newest = reads.begin(kind, "current-scope");
      });
      const superseded = reads.begin(kind, "current-scope");
      expect(old.controller.signal.aborted).toBe(true);
      expect(superseded.controller.signal.aborted).toBe(true);
      expect(newest!.controller.signal.aborted).toBe(false);
      expect(reads.current(superseded, "current-scope", true)).toBe(false);
      expect(reads.current(newest!, "current-scope", true)).toBe(true);
      reads.finish(old);
      reads.finish(superseded);
      expect(reads.busy(kind)).toBe(true);
      reads.clear();
      expect(newest!.controller.signal.aborted).toBe(true);
      expect(reads.busy(kind)).toBe(false);
    },
  );

  it.each(["list", "detail"] as const)(
    "invalidates both surfaces before the first %s abort callback runs",
    (firstKind) => {
      const reads = new PropertyReads();
      const first = reads.begin(firstKind, "current-scope");
      const otherKind = firstKind === "list" ? "detail" : "list";
      const second = reads.begin(otherKind, "current-scope");
      let observed: boolean[] = [];
      first.controller.signal.addEventListener("abort", () => {
        observed = [
          reads.current(first, "current-scope", true),
          reads.current(second, "current-scope", true),
          reads.busy(firstKind),
          reads.busy(otherKind),
        ];
        reads.finish(second);
      });
      reads.clear();
      expect(observed).toEqual([false, false, false, false]);
      expect(first.controller.signal.aborted).toBe(true);
      expect(second.controller.signal.aborted).toBe(true);
    },
  );

  it.each([
    ["list", "list"],
    ["list", "detail"],
    ["detail", "list"],
    ["detail", "detail"],
  ] as const)("denies a %s abort callback's new %s read during whole-view clearing", (oldKind, newKind) => {
    const reads = new PropertyReads();
    const old = reads.begin(oldKind, "current-scope");
    let attempted: ReturnType<PropertyReads["begin"]> | undefined;
    let acceptedDuringAbort = true;
    old.controller.signal.addEventListener("abort", () => {
      attempted = reads.begin(newKind, "current-scope");
      acceptedDuringAbort = reads.current(attempted, "current-scope", true);
    });
    reads.clear();
    expect(acceptedDuringAbort).toBe(false);
    expect(attempted!.controller.signal.aborted).toBe(true);
    expect(reads.current(attempted!, "current-scope", true)).toBe(false);
    expect(reads.busy("list") || reads.busy("detail")).toBe(false);
    const fresh = reads.begin(newKind, "current-scope");
    reads.finish(attempted!);
    expect(reads.current(fresh, "current-scope", true)).toBe(true);
    expect(reads.busy(newKind)).toBe(true);
  });

  it("keeps the outer clear active across nested clearing and permits reads only after it finishes", () => {
    const reads = new PropertyReads();
    const list = reads.begin("list", "current-scope");
    const detail = reads.begin("detail", "current-scope");
    const attempts: ReturnType<PropertyReads["begin"]>[] = [];
    list.controller.signal.addEventListener("abort", () => {
      reads.clear();
      attempts.push(reads.begin("detail", "current-scope"));
    });
    detail.controller.signal.addEventListener("abort", () => {
      reads.clear();
      attempts.push(reads.begin("list", "current-scope"));
    });
    reads.clear();
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.controller.signal.aborted)).toBe(true);
    expect(attempts.some((attempt) => reads.current(attempt, "current-scope", true))).toBe(false);
    expect(reads.busy("list") || reads.busy("detail")).toBe(false);
    const fresh = reads.begin("list", "current-scope");
    expect(reads.current(fresh, "current-scope", true)).toBe(true);
  });

  it("prevents a callback-created late response from restoring cleared private records", async () => {
    const reads = new PropertyReads();
    const detail = reads.begin("detail", "current-scope");
    const response = deferred<string>();
    let completion = Promise.resolve();
    let visible: string | null = "previous private page";
    detail.controller.signal.addEventListener("abort", () => {
      const attempted = reads.begin("list", "current-scope");
      completion = response.promise.then((value) => {
        if (reads.current(attempted, "current-scope", true)) visible = value;
      });
    });
    reads.clear();
    visible = null;
    response.resolve("late private page");
    await completion;
    expect(visible).toBeNull();
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
