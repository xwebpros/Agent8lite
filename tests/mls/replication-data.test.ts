import { describe, expect, it } from "vitest";
import {
  createMockReplicationCheckpoint,
  getMockReplicationFeedBinding,
  isMockReplicationCheckpoint,
  MockReplicationReadError,
  stepMockReplication,
} from "../../packages/mls";
import { providerContext } from "./fixtures";
import { deferred, page, replicationHarness, upsert } from "./replication-fixtures";

function getter<T extends object>(value: T, key: keyof T, read: () => void): T {
  const result = structuredClone(value);
  const field = result[key];
  Object.defineProperty(result, key, {
    enumerable: true,
    configurable: true,
    get: () => {
      read();
      return field;
    },
  });
  return result;
}
function proxy<T extends object>(value: T, trap: () => void, promiseData = false): T {
  const reject = () => {
    trap();
    throw new Error("synthetic trap must never run");
  };
  return new Proxy(value, {
    // Native Promise resolution checks then before the helper receives a returned object.
    get: (_target, key) => (promiseData && key === "then" ? undefined : reject()),
    ownKeys: reject,
    getPrototypeOf: reject,
    getOwnPropertyDescriptor: reject,
  });
}
function untouched(h: Awaited<ReturnType<typeof replicationHarness>>) {
  expect(h.store.checkpoint.revision).toBe(0);
  expect(h.store.receipts.size).toBe(0);
  expect(h.store.listings.size).toBe(0);
  expect(h.store.invalidations.size).toBe(0);
  expect(h.store.events).toEqual([]);
}

describe("pure replication own-data boundaries", () => {
  it.each(["revision", "context", "cursor"] as const)(
    "predicate rejects a %s getter without reading it",
    async (key) => {
      const h = await replicationHarness([]);
      let reads = 0;
      const input = getter(h.checkpoint, key, () => reads++);
      expect(isMockReplicationCheckpoint(input)).toBe(false);
      expect(reads).toBe(0);
    },
  );

  it("blocks a getter checkpoint before calling ports", async () => {
    const h = await replicationHarness([page()]);
    let reads = 0;
    const input = getter(h.checkpoint, "revision", () => reads++);
    expect(await stepMockReplication(input, h.ports)).toEqual({
      status: "blocked",
      code: "invalid_checkpoint",
    });
    expect(reads).toBe(0);
    expect(h.authorizations()).toBe(0);
    untouched(h);
  });

  it("rejects a proxy checkpoint without triggering reflection or rejecting the promise", async () => {
    const h = await replicationHarness([page()]);
    let traps = 0;
    const input = proxy(h.checkpoint, () => traps++);
    await expect(stepMockReplication(input, h.ports)).resolves.toEqual({
      status: "blocked",
      code: "invalid_checkpoint",
    });
    expect(isMockReplicationCheckpoint(input)).toBe(false);
    expect(traps).toBe(0);
    expect(h.authorizations()).toBe(0);
    untouched(h);
  });

  it("checkpoint creation rejects context getters without executing them", () => {
    let reads = 0;
    const context = getter(providerContext, "feedId", () => reads++);
    expect(() => createMockReplicationCheckpoint(context)).toThrow("invalid_checkpoint");
    expect(reads).toBe(0);
  });

  it("checkpoint creation rejects option getters without executing them", () => {
    let reads = 0;
    const options = getter({ limit: 2 }, "limit", () => reads++);
    expect(() => createMockReplicationCheckpoint(providerContext, options)).toThrow("invalid_checkpoint");
    expect(reads).toBe(0);
  });

  it.each(["context", "feed"] as const)("binding rejects a %s getter without reading it", async (target) => {
    const h = await replicationHarness([]);
    let reads = 0;
    const context = target === "context" ? getter(providerContext, "feedId", () => reads++) : providerContext;
    const feed = target === "feed" ? getter(h.store.feed, "displayPolicy", () => reads++) : h.store.feed;
    expect(getMockReplicationFeedBinding(context, feed)).toBeNull();
    expect(reads).toBe(0);
  });

  it("binding rejects inherited feed authority", async () => {
    const h = await replicationHarness([]);
    expect(getMockReplicationFeedBinding(providerContext, Object.create(h.store.feed))).toBeNull();
  });

  it.each([1, 2])("authorization check %i rejects executable policy data", async (faultAt) => {
    const h = await replicationHarness([page()]);
    let calls = 0;
    let reads = 0;
    const unsafe = getter(h.store.feed, "displayPolicy", () => reads++);
    h.ports.authorize = async () => (++calls === faultAt ? unsafe : h.store.feed);
    expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
      status: "blocked",
      code: "policy_denied",
    });
    expect(reads).toBe(0);
    expect(calls).toBe(faultAt);
    untouched(h);
  });

  it("capability getters cannot cause a provider read", async () => {
    const h = await replicationHarness([page()]);
    const capability = await h.adapter.capabilities(providerContext);
    let reads = 0;
    let pages = 0;
    h.adapter.capabilities = async () => getter(capability, "mode", () => reads++);
    h.adapter.readChanges = async () => {
      pages++;
      return page();
    };
    expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
      status: "blocked",
      code: "read_failed",
    });
    expect(reads).toBe(0);
    expect(pages).toBe(0);
    untouched(h);
  });

  it.each(["page", "listing"] as const)("rejects a %s getter before creating a plan", async (target) => {
    const h = await replicationHarness([]);
    let reads = 0;
    const listing =
      target === "listing" ? getter(h.records[0], "publicRemarks", () => reads++) : h.records[0];
    const change = { kind: "upsert" as const, sourceListingKey: listing.sourceListingKey, listing };
    const value = page([change]);
    const unsafe = target === "page" ? getter(value, "completedWatermark", () => reads++) : value;
    h.adapter.readChanges = async () => unsafe;
    expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
      status: "blocked",
      code: "read_failed",
    });
    expect(reads).toBe(0);
    untouched(h);
  });

  it.each([
    "symbol",
    "hidden",
    "toJSON",
    "prototype",
    "sparse",
    "augmented",
    "cycle",
    "depth",
    "nonfinite",
    "negative_zero",
    "string_budget",
    "array_budget",
    "object_budget",
    "node_budget",
    "byte_budget",
  ])("rejects %s provider data without committing", async (fault) => {
    const h = await replicationHarness([]);
    const value = page([upsert(h.records[0])]);
    const extra = value as unknown as Record<string | symbol, unknown>;
    let hooks = 0;
    if (fault === "symbol") extra[Symbol("synthetic metadata")] = true;
    if (fault === "hidden") Object.defineProperty(value, "hidden", { value: true });
    if (fault === "toJSON")
      extra.toJSON = () => {
        hooks++;
        return value;
      };
    if (fault === "prototype") Object.setPrototypeOf(value, { inherited: true });
    if (fault === "sparse") extra.changes = new Array(1);
    if (fault === "augmented") Object.assign(value.changes, { extra: "synthetic" });
    if (fault === "cycle") extra.extra = value;
    if (fault === "depth") {
      let item: unknown = null;
      for (let index = 0; index < 14; index++) item = { item };
      extra.extra = item;
    }
    if (fault === "nonfinite") extra.extra = NaN;
    if (fault === "negative_zero") extra.extra = -0;
    if (fault === "string_budget") extra.extra = "x".repeat(25001);
    if (fault === "array_budget") extra.extra = Array(501).fill(null);
    if (fault === "object_budget")
      extra.extra = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [String(index), null]));
    if (fault === "node_budget") extra.extra = Array.from({ length: 100 }, () => Array(500).fill(null));
    if (fault === "byte_budget") extra.extra = Array(151).fill("x".repeat(20000));
    h.adapter.readChanges = async () => value;
    expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
      status: "blocked",
      code: "read_failed",
    });
    expect(hooks).toBe(0);
    untouched(h);
  });

  it("rejects a resolved proxy page before data/reflection traps or commit", async () => {
    const h = await replicationHarness([]);
    let traps = 0;
    h.adapter.readChanges = async () => proxy(page(), () => traps++, true);
    expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
      status: "blocked",
      code: "read_failed",
    });
    expect(traps).toBe(0);
    untouched(h);
  });

  it.each(["status", "checkpoint"] as const)(
    "unknown %s acknowledgment reloads after the actual commit",
    async (key) => {
      const h = await replicationHarness([]);
      h.adapter.readChanges = async () => page([upsert(h.records[0])]);
      let reads = 0;
      let commits = 0;
      h.ports.commitPage = async (plan) => {
        commits++;
        const receipt = await h.store.commitPage(plan);
        if (receipt.status !== "committed") throw new Error("test commit unexpectedly conflicted");
        return getter(receipt, key, () => reads++);
      };
      expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
        status: "reload_required",
        code: "commit_unknown",
      });
      expect(reads).toBe(0);
      expect(commits).toBe(1);
      expect(h.store.checkpoint.revision).toBe(1);
      expect(h.store.receipts.size).toBe(1);
      expect(h.store.listings.size).toBe(1);
    },
  );

  it.each(["code", "retryAfterSeconds"] as const)(
    "fault %s getter is not inspected or classified",
    async (key) => {
      const h = await replicationHarness([]);
      let reads = 0;
      const error = new MockReplicationReadError("rate_limited", 20);
      const value = error[key];
      Object.defineProperty(error, key, {
        enumerable: true,
        get: () => {
          reads++;
          return value;
        },
      });
      h.adapter.readChanges = async () => {
        throw error;
      };
      expect(await stepMockReplication(h.checkpoint, h.ports)).toEqual({
        status: "blocked",
        code: "read_failed",
      });
      expect(reads).toBe(0);
      untouched(h);
    },
  );

  it("a proxy fault cannot execute traps during classification", async () => {
    const h = await replicationHarness([]);
    let traps = 0;
    h.adapter.readChanges = async () => {
      throw proxy(new MockReplicationReadError("rate_limited", 20), () => traps++);
    };
    await expect(stepMockReplication(h.checkpoint, h.ports)).resolves.toEqual({
      status: "blocked",
      code: "read_failed",
    });
    expect(traps).toBe(0);
    untouched(h);
  });

  it("accepts null-prototype JSON with the same receipts as ordinary data", async () => {
    const a = await replicationHarness([page()]);
    const b = await replicationHarness([page()]);
    const input = Object.assign(Object.create(null), b.checkpoint);
    const feed = Object.assign(Object.create(null), b.store.feed);
    b.ports.authorize = async () => feed;
    expect(isMockReplicationCheckpoint(input)).toBe(true);
    expect(await stepMockReplication(input, b.ports)).toEqual(
      await stepMockReplication(a.checkpoint, a.ports),
    );
    expect([...b.store.receipts]).toEqual([...a.store.receipts]);
  });

  it("provider data is detached before a later authorization wait", async () => {
    const h = await replicationHarness([]);
    const source = page([upsert(h.records[0])]);
    const ready = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    h.adapter.readChanges = async () => source;
    h.ports.authorize = async () => {
      if (++calls === 2) {
        ready.resolve();
        await release.promise;
      }
      return h.store.feed;
    };
    const pending = stepMockReplication(h.checkpoint, h.ports);
    await ready.promise;
    Object.assign(source.changes[0].listing!, { status: "off_market", displayAllowed: false });
    release.resolve();
    expect((await pending).status).toBe("completed");
    expect(h.store.listings.get(h.records[0].sourceListingKey)?.canonical.status).toBe(h.records[0].status);
    expect(source.changes[0].listing?.status).toBe("off_market");
  });
});
