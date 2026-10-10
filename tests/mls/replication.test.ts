import { describe, expect, it } from "vitest";
import {
  createMockReplicationCheckpoint,
  isMockReplicationCheckpoint,
  MockReplicationReadError,
  projectNativeMockListing,
  stepMockReplication,
  type MockReplicationCheckpoint,
  type MockReplicationPagePlan,
} from "../../packages/mls";
import { MOCK_CLOCK } from "../../packages/providers/mls/mock";
import type { ChangePage } from "../../packages/providers/mls/port";
import { nativeRights, providerContext, syntheticAttributionContacts } from "./fixtures";
import { deferred, page, replicationHarness, ScriptedMock, upsert, watermark } from "./replication-fixtures";

const blocked = (code: string) => ({ status: "blocked", code });
const unknownCommit = { status: "reload_required", code: "commit_unknown" };
const nextWatermark = "2026-10-10T00:02:00.000Z";
async function finishCycle(h: Awaited<ReturnType<typeof replicationHarness>>) {
  for (let index = 0; index < 100; index += 1) {
    const result = await stepMockReplication(h.store.checkpoint, h.ports);
    expect(["advanced", "completed"]).toContain(result.status);
    if (result.status === "completed") return result.checkpoint;
  }
  throw new Error("test cycle did not finish");
}

describe("mock incremental replication pages", () => {
  it("uses the existing mock, commits every page and replaces only the completed watermark", async () => {
    const h = await replicationHarness();
    let steps = 0;
    while (true) {
      const before = structuredClone(h.store.checkpoint);
      const result = await stepMockReplication(before, h.ports);
      steps += 1;
      expect(["advanced", "completed"]).toContain(result.status);
      expect(h.store.checkpoint.revision).toBe(steps);
      if (result.status === "completed") break;
      expect(result.status).toBe("advanced");
      expect(h.store.checkpoint.watermark).toBe(null);
      expect(h.store.checkpoint.cursor).not.toBe(null);
      expect(before.revision).toBe(steps - 1);
    }
    expect(steps).toBe(Math.ceil(h.records.length / 2));
    expect(h.store.listings.size).toBe(h.records.length);
    expect(new Set([...h.store.listings.values()].map((listing) => listing.id)).size).toBe(h.records.length);
    expect(h.store.checkpoint).toMatchObject({ cursor: null, watermark, pagesInCycle: 0, cursorHashes: [] });
    expect(h.authorizations()).toBe(steps * 2);
  });

  it("forwards opaque cursors, the same completed watermark and overlap verbatim", async () => {
    const token = "  /not-a-local-offset?$skiptoken=a%2Fb&x=☃  ";
    const h = await replicationHarness([page([], token, null), page([], null, nextWatermark)], {
      watermark,
      overlapSeconds: 37,
    });
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("advanced");
    expect(h.store.checkpoint.watermark).toBe(watermark);
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("completed");
    const reads = (h.adapter as ScriptedMock).reads;
    expect(reads.map((read) => read.input)).toEqual([
      { cursor: null, watermark, overlapSeconds: 37, limit: 2 },
      { cursor: token, watermark, overlapSeconds: 37, limit: 2 },
    ]);
    expect(reads.every((read) => JSON.stringify(read.context) === JSON.stringify(providerContext))).toBe(
      true,
    );
    expect(h.store.checkpoint.watermark).toBe(nextWatermark);
  });

  it("processes different keys and changed values at equal timestamps across page boundaries", async () => {
    const h = await replicationHarness([]);
    const first = { ...h.records[0], sourceModifiedAt: watermark };
    const second = { ...h.records[1], sourceModifiedAt: watermark };
    const pending = { ...first, status: "pending" as const, sourceStatus: "Mock pending", listPrice: 123456 };
    (h.adapter as ScriptedMock).script.push(
      page([upsert(first)], "equal:1", null),
      page([upsert(second), upsert(pending)]),
    );
    await stepMockReplication(h.store.checkpoint, h.ports);
    const id = h.store.listings.get(first.sourceListingKey)!.id;
    await finishCycle(h);
    expect(h.store.listings.size).toBe(2);
    expect(h.store.listings.get(first.sourceListingKey)).toMatchObject({
      id,
      revision: 2,
      canonical: { status: "pending", listPrice: 123456 },
    });
    expect(h.store.listings.get(second.sourceListingKey)!.canonical.sourceModifiedAt).toBe(watermark);
  });

  it("accepts an empty page with a new opaque continuation", async () => {
    const h = await replicationHarness([page([], "empty-next", null), page()]);
    await finishCycle(h);
    expect(h.store.checkpoint.revision).toBe(2);
    expect(h.store.listings.size).toBe(0);
  });

  it("keeps the successful boundary after a later partial page read failure and retries exactly there", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(
      page([upsert(h.records[0])], "resume-exactly-here", null),
      new Error("private raw provider message"),
      page([upsert(h.records[1])]),
    );
    await stepMockReplication(h.store.checkpoint, h.ports);
    const before = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(before, h.ports)).toEqual(blocked("read_failed"));
    expect(h.store.checkpoint).toEqual(before);
    expect(h.store.listings.size).toBe(1);
    expect((await stepMockReplication(before, h.ports)).status).toBe("completed");
    expect((h.adapter as ScriptedMock).reads.slice(1).map((read) => read.input.cursor)).toEqual([
      before.cursor,
      before.cursor,
    ]);
    expect(h.store.listings.size).toBe(2);
  });

  it("rejects a cursor cycle without committing its page or losing the previous watermark", async () => {
    const h = await replicationHarness([page([], "A", null), page([], "B", null), page([], "A", null)], {
      watermark,
    });
    await stepMockReplication(h.store.checkpoint, h.ports);
    await stepMockReplication(h.store.checkpoint, h.ports);
    const before = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(before, h.ports)).toEqual(blocked("invalid_page"));
    expect(h.store.checkpoint).toEqual(before);
    expect(before.watermark).toBe(watermark);
  });

  it("allows 100 bounded pages including the final page", async () => {
    const script = Array.from({ length: 100 }, (_, index) =>
      index === 99 ? page() : page([], `opaque-${index}`, null),
    );
    const h = await replicationHarness(script);
    await finishCycle(h);
    expect(h.store.checkpoint.revision).toBe(100);
  });

  it("fails explicitly at the bound when page 100 still requests continuation", async () => {
    const h = await replicationHarness(
      Array.from({ length: 100 }, (_, index) => page([], `opaque-${index}`, null)),
    );
    for (let index = 0; index < 99; index += 1) await stepMockReplication(h.store.checkpoint, h.ports);
    const before = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(before, h.ports)).toEqual(blocked("invalid_page"));
    expect(h.store.checkpoint).toEqual(before);
  });
});

describe("safe provider failure outcomes", () => {
  it("returns bounded 429 backoff without sleeping/retrying or advancing", async () => {
    const h = await replicationHarness([
      page([], "throttled-cursor", null),
      new MockReplicationReadError("rate_limited", 17),
      page(),
    ]);
    await stepMockReplication(h.store.checkpoint, h.ports);
    const before = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(before, h.ports)).toEqual({
      status: "retry",
      code: "rate_limited",
      retryAfterSeconds: 17,
    });
    expect((h.adapter as ScriptedMock).reads).toHaveLength(2);
    expect(h.store.checkpoint).toEqual(before);
    expect((await stepMockReplication(before, h.ports)).status).toBe("completed");
    expect(
      (h.adapter as ScriptedMock).reads.slice(1).every((read) => read.input.cursor === before.cursor),
    ).toBe(true);
  });

  it.each(["credential_expired", "cursor_expired"] as const)(
    "stops on %s and retains the completed watermark and opaque continuation",
    async (code) => {
      const h = await replicationHarness(
        [page([], "kept-cursor", null), new MockReplicationReadError(code)],
        { watermark },
      );
      await stepMockReplication(h.store.checkpoint, h.ports);
      const before = structuredClone(h.store.checkpoint);
      expect(await stepMockReplication(before, h.ports)).toEqual(blocked(code));
      expect(h.store.checkpoint).toEqual(before);
      expect((h.adapter as ScriptedMock).reads).toHaveLength(2);
    },
  );

  it.each([0, -1, 3601, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects an invalid 429 delay %s without leaking errors",
    async (delay) => {
      const h = await replicationHarness([new MockReplicationReadError("rate_limited", delay)]);
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("read_failed"));
      expect(h.store.checkpoint.revision).toBe(0);
    },
  );

  it("never classifies arbitrary exception text or includes credentials/payloads in outcomes", async () => {
    const h = await replicationHarness([new Error("429 expired token bearer DO-NOT-EXPOSE raw-listing")]);
    const result = await stepMockReplication(h.store.checkpoint, h.ports);
    expect(result).toEqual(blocked("read_failed"));
    expect(JSON.stringify(result)).not.toMatch(/DO-NOT-EXPOSE|raw-listing|bearer/);
    expect(h.store.receipts.size).toBe(0);
  });
});

describe("atomic commit, replay and crash recovery", () => {
  it("waits for durable acknowledgement and processes all changes before publishing a checkpoint", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(page(h.records.slice(0, 2).map(upsert)));
    const reached = deferred<void>();
    const release = deferred<void>();
    h.store.beforePublish = async () => {
      reached.resolve();
      await release.promise;
    };
    let settled = false;
    const pending = stepMockReplication(h.store.checkpoint, h.ports).then((result) => {
      settled = true;
      return result;
    });
    await reached.promise;
    expect(settled).toBe(false);
    expect(h.store.checkpoint.revision).toBe(0);
    expect(h.store.listings.size).toBe(0);
    expect(h.store.events).toEqual(
      h.records.slice(0, 2).map((record) => `processed:${record.sourceListingKey}`),
    );
    release.resolve();
    expect((await pending).status).toBe("completed");
    expect(h.store.events.slice(-2)).toEqual(["checkpoint", "commit"]);
  });

  it("rolls back the whole page on a failure after its first change, then resumes from durable state", async () => {
    const h = await replicationHarness([]);
    const changes = h.records.slice(0, 2).map(upsert);
    (h.adapter as ScriptedMock).script.push(page(changes), page(changes));
    h.store.failure = 1;
    const before = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(before, h.ports)).toEqual(unknownCommit);
    expect(h.store.checkpoint).toEqual(before);
    expect(h.store.listings.size).toBe(0);
    expect(h.store.invalidations.size).toBe(0);
    expect(h.store.receipts.size).toBe(0);
    h.store.failure = null;
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("completed");
    expect(h.store.listings.size).toBe(2);
    expect(h.store.invalidations.size).toBe(2);
    expect(h.store.receipts.size).toBe(1);
  });

  it("recovers a crash before transaction commit without assuming any page persisted", async () => {
    const h = await replicationHarness([]);
    const complete = page([upsert(h.records[0])]);
    (h.adapter as ScriptedMock).script.push(complete, complete);
    h.store.failure = "before_commit";
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(unknownCommit);
    expect(h.store.checkpoint.revision).toBe(0);
    expect(h.store.listings.size).toBe(0);
    h.store.failure = null;
    await finishCycle(h);
    expect(h.store.listings.size).toBe(1);
    expect(h.store.checkpoint.revision).toBe(1);
  });

  it("reloads after a lost acknowledgement and rejects blind stale-plan replay", async () => {
    const h = await replicationHarness([]);
    const first = page([upsert(h.records[0])], "durable-after-crash", null);
    (h.adapter as ScriptedMock).script.push(first, first, page([upsert(h.records[1])]));
    const stale = structuredClone(h.store.checkpoint);
    h.store.failure = "after_commit";
    expect(await stepMockReplication(stale, h.ports)).toEqual(unknownCommit);
    expect(h.store.checkpoint).toMatchObject({ cursor: "durable-after-crash", revision: 1, watermark: null });
    expect(h.store.listings.size).toBe(1);
    h.store.failure = null;
    expect(await stepMockReplication(stale, h.ports)).toEqual({
      status: "reload_required",
      code: "checkpoint_conflict",
    });
    expect(h.store.listings.size).toBe(1);
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("completed");
    expect((h.adapter as ScriptedMock).reads.at(-1)!.input.cursor).toBe("durable-after-crash");
    expect(h.store.listings.size).toBe(2);
    expect(h.store.receipts.size).toBe(2);
  });

  it("serializes concurrent attempts through checkpoint CAS so one page has one durable effect", async () => {
    const h = await replicationHarness([]);
    const complete = page([upsert(h.records[0])]);
    (h.adapter as ScriptedMock).script.push(complete, complete);
    const both = deferred<void>();
    const release = deferred<void>();
    let arrivals = 0;
    h.store.beforePublish = async () => {
      arrivals += 1;
      if (arrivals === 2) both.resolve();
      await release.promise;
    };
    const stale = structuredClone(h.store.checkpoint);
    const a = stepMockReplication(stale, h.ports);
    const b = stepMockReplication(stale, h.ports);
    await both.promise;
    release.resolve();
    const results = await Promise.all([a, b]);
    expect(results.map((result) => result.status).sort()).toEqual(["completed", "reload_required"]);
    expect(h.store.checkpoint.revision).toBe(1);
    expect(h.store.listings.size).toBe(1);
    expect(h.store.invalidations.size).toBe(1);
    expect(h.store.receipts.size).toBe(1);
  });

  it.each(["receipt", "checkpoint", "extra_field"])(
    "requires an exact matching %s acknowledgement",
    async (fault) => {
      const h = await replicationHarness([page()]);
      h.ports.commitPage = async (plan) => {
        const commit = await h.store.commitPage(plan);
        if (commit.status !== "committed") return commit;
        if (fault === "receipt") return { ...commit, receiptId: "incorrect" };
        if (fault === "checkpoint")
          return { ...commit, checkpoint: { ...commit.checkpoint, watermark: nextWatermark } };
        return { ...commit, rawProviderPayload: "private" };
      };
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(unknownCommit);
      expect(h.store.checkpoint.revision).toBe(1);
    },
  );

  it("passes immutable plans and returns an immutable committed checkpoint", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(page([upsert(h.records[0])]));
    let plan!: MockReplicationPagePlan;
    h.ports.commitPage = async (value) => {
      plan = value;
      return h.store.commitPage(value);
    };
    const result = await stepMockReplication(h.store.checkpoint, h.ports);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.changes[0].listing!.attribution)).toBe(true);
    expect(Object.isFrozen(plan.expected.context)).toBe(true);
    expect(plan.receiptId).toMatch(/^[a-f0-9]{64}$/);
    if (result.status !== "completed") throw new Error("unexpected failure");
    expect(Object.isFrozen(result.checkpoint)).toBe(true);
    expect(Object.isFrozen(result.checkpoint.cursorHashes)).toBe(true);
  });
});

describe("withdrawal, overlap and freshness", () => {
  it("keeps pending B when historical equal-timestamp A replays before a later page failure", async () => {
    const h = await replicationHarness([]);
    const active = { ...h.records[0], sourceModifiedAt: watermark };
    const pending = { ...active, status: "pending" as const, sourceStatus: "Mock pending" };
    (h.adapter as ScriptedMock).script.push(
      page([upsert(active)], "initial-B", null),
      page([upsert(pending)]),
      page([upsert(active)], "historical-B", null),
      new Error("synthetic later overlap page failure"),
      page([upsert(pending)]),
    );
    await finishCycle(h);
    const before = structuredClone(h.store.listings.get(active.sourceListingKey)!);
    const invalidations = [...h.store.invalidations];
    expect(before.canonical.status).toBe("pending");
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("advanced");
    expect(h.store.listings.get(active.sourceListingKey)).toEqual(before);
    const boundary = structuredClone(h.store.checkpoint);
    expect(await stepMockReplication(boundary, h.ports)).toEqual(blocked("read_failed"));
    expect(h.store.checkpoint).toEqual(boundary);
    expect(h.store.listings.get(active.sourceListingKey)).toEqual(before);
    await finishCycle(h);
    expect(h.store.listings.get(active.sourceListingKey)).toEqual(before);
    expect([...h.store.invalidations]).toEqual(invalidations);
    expect(h.store.appliedSourceChanges.get(active.sourceListingKey)?.size).toBe(2);
  });

  it("recognizes historical source identity despite reordered fields and refreshed ingestion clocks", async () => {
    const h = await replicationHarness([]);
    const active = h.records[0];
    const pending = { ...active, status: "pending" as const, sourceStatus: "Mock pending" };
    const historical = {
      ...active,
      ingestedAt: "2026-10-11T00:01:00Z",
      expiresAt: "2026-10-12T00:01:00Z",
      attribution: Object.fromEntries(
        Object.entries(active.attribution).reverse(),
      ) as typeof active.attribution,
    };
    (h.adapter as ScriptedMock).script.push(
      page([upsert(active)]),
      page([upsert(pending)]),
      page([upsert(historical)]),
    );
    await finishCycle(h);
    await finishCycle(h);
    const before = structuredClone(h.store.listings.get(active.sourceListingKey)!);
    await finishCycle(h);
    expect(h.store.listings.get(active.sourceListingKey)).toEqual(before);
    expect(h.store.appliedSourceChanges.get(active.sourceListingKey)?.size).toBe(2);
  });

  it.each([1, "before_commit"] as const)(
    "rolls back source identities on %s and permits the original retry",
    async (failure) => {
      const h = await replicationHarness([]);
      const changes = [upsert(h.records[0]), upsert(h.records[1])];
      (h.adapter as ScriptedMock).script.push(page(changes), page(changes));
      h.store.failure = failure;
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(unknownCommit);
      expect(h.store.appliedSourceChanges.size).toBe(0);
      expect(h.store.listings.size).toBe(0);
      h.store.failure = null;
      expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("completed");
      expect(h.store.listings.size).toBe(2);
      expect(h.store.appliedSourceChanges.size).toBe(2);
    },
  );

  it("publishes the source identity ledger with an acknowledged-lost commit", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(page([upsert(h.records[0])]), page([upsert(h.records[0])]));
    h.store.failure = "after_commit";
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(unknownCommit);
    expect(h.store.appliedSourceChanges.get(h.records[0].sourceListingKey)?.size).toBe(1);
    const before = structuredClone(h.store.listings.get(h.records[0].sourceListingKey)!);
    h.store.failure = null;
    await finishCycle(h);
    expect(h.store.listings.get(h.records[0].sourceListingKey)).toEqual(before);
  });

  it("replays the existing mock without duplicate native IDs, invalidations or expiry renewal", async () => {
    const h = await replicationHarness();
    await finishCycle(h);
    const before = structuredClone([...h.store.listings]);
    const invalidations = [...h.store.invalidations];
    await finishCycle(h);
    expect([...h.store.listings]).toEqual(before);
    expect([...h.store.invalidations]).toEqual(invalidations);
    expect(h.store.checkpoint.watermark).toBe(watermark);
  });

  it("does not renew original ingestion/expiry on an identical overlap snapshot", async () => {
    const h = await replicationHarness([]);
    const original = h.records[0];
    const refreshed = { ...original, ingestedAt: "2026-10-11T00:01:00Z", expiresAt: "2026-10-12T00:01:00Z" };
    (h.adapter as ScriptedMock).script.push(page([upsert(original)]), page([upsert(refreshed)]));
    await finishCycle(h);
    const before = structuredClone(h.store.listings.get(original.sourceListingKey)!);
    await finishCycle(h);
    expect(h.store.listings.get(original.sourceListingKey)).toEqual(before);
    expect(projectNativeMockListing(before, h.store.feed, new Date(before.canonical.expiresAt))).toBe(null);
  });

  it("makes actual mock withdrawal unavailable and tombstones prevent historical replay revival", async () => {
    const h = await replicationHarness();
    await finishCycle(h);
    const key = h.records[0].sourceListingKey;
    const before = structuredClone(h.store.listings.get(key)!);
    expect(projectNativeMockListing(before, h.store.feed, MOCK_CLOCK)).not.toBe(null);
    h.adapter.withdraw(key);
    await finishCycle(h);
    const withdrawn = h.store.listings.get(key)!;
    expect(withdrawn.id).toBe(before.id);
    expect(withdrawn.withdrawnAt).not.toBe(null);
    expect(projectNativeMockListing(withdrawn, h.store.feed, MOCK_CLOCK)).toBe(null);
    const invalidations = [...h.store.invalidations];
    // The mock starts its historical log again. Its first page must not revive this key.
    expect((await stepMockReplication(h.store.checkpoint, h.ports)).status).toBe("advanced");
    expect(projectNativeMockListing(h.store.listings.get(key)!, h.store.feed, MOCK_CLOCK)).toBe(null);
    await finishCycle(h);
    expect([...h.store.invalidations]).toEqual(invalidations);
    expect(h.store.invalidations.has(`withdraw:${key}`)).toBe(true);
  });

  it("keeps native identity through active→pending→off-market and current projection denies withdrawn data", async () => {
    const h = await replicationHarness([]);
    const active = h.records[0];
    const pending = { ...active, status: "pending" as const, sourceStatus: "Mock pending" };
    const offMarket = { ...active, status: "off_market" as const, sourceStatus: "Mock withdrawn" };
    (h.adapter as ScriptedMock).script.push(
      page([upsert(active)]),
      page([upsert(pending)]),
      page([upsert(offMarket)]),
      page([upsert(active)]),
    );
    await finishCycle(h);
    const id = h.store.listings.get(active.sourceListingKey)!.id;
    await finishCycle(h);
    expect(
      projectNativeMockListing(h.store.listings.get(active.sourceListingKey)!, h.store.feed, MOCK_CLOCK)
        ?.status,
    ).toBe("pending");
    await finishCycle(h);
    expect(h.store.listings.get(active.sourceListingKey)!.id).toBe(id);
    expect(
      projectNativeMockListing(h.store.listings.get(active.sourceListingKey)!, h.store.feed, MOCK_CLOCK),
    ).toBe(null);
    await finishCycle(h);
    expect(h.store.listings.get(active.sourceListingKey)).toMatchObject({
      id,
      revision: 3,
      canonical: { status: "off_market" },
    });
  });

  it("retains existing address/no-media/current rights behavior after ingestion", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(page([upsert({ ...h.records[0], addressAllowed: false })]));
    await finishCycle(h);
    const native = [...h.store.listings.values()][0];
    const projected = projectNativeMockListing(native, h.store.feed, MOCK_CLOCK)!;
    expect(projected).toMatchObject({
      displayAddress: null,
      latitude: null,
      longitude: null,
      media: [],
      synthetic: true,
    });
    h.store.feed = {
      ...h.store.feed,
      nativeRights: { ...nativeRights, rights: { ...nativeRights.rights, display: "unknown" } },
    };
    expect(projectNativeMockListing(native, h.store.feed, MOCK_CLOCK)).toBe(null);
  });
});

describe("current replication authorization and capabilities", () => {
  it.each(["unknown", "denied"] as const)(
    "denies %s native replication rights before provider access",
    async (right) => {
      const h = await replicationHarness([page()]);
      h.store.feed = {
        ...h.store.feed,
        nativeRights: { ...nativeRights, rights: { ...nativeRights.rights, replicate: right } },
      };
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_denied"));
      expect((h.adapter as ScriptedMock).reads).toHaveLength(0);
    },
  );

  it.each(["unapproved", "revoked"] as const)("denies %s approval", async (approvalState) => {
    const h = await replicationHarness([page()]);
    h.store.feed = { ...h.store.feed, nativeRights: { ...nativeRights, approvalState } };
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_denied"));
  });

  it.each(["organization", "feed", "live", "transport", "provider", "state", "display_policy", "retention"])(
    "denies invalid %s provenance/replication authorization",
    async (fault) => {
      const h = await replicationHarness([page()]);
      const feed = h.store.feed;
      h.store.feed =
        fault === "organization"
          ? { ...feed, tenantId: "00000000-0000-4000-8000-000000000111" }
          : fault === "feed"
            ? { ...feed, id: "00000000-0000-4000-8000-000000000111" }
            : fault === "live"
              ? { ...feed, mode: "live" }
              : fault === "transport"
                ? { ...feed, transport: "reso_web_api" }
                : fault === "provider"
                  ? { ...feed, providerCode: "trestle" }
                  : fault === "state"
                    ? { ...feed, state: "disabled" }
                    : fault === "display_policy"
                      ? {
                          ...feed,
                          displayPolicy: { ...(feed.displayPolicy as object), allowReplication: false },
                        }
                      : { ...feed, nativeRights: { ...nativeRights, retentionDays: null } };
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_denied"));
      expect((h.adapter as ScriptedMock).reads).toHaveLength(0);
    },
  );

  it.each(["incremental", "deletions", "page_size", "unknown_size", "mode"])(
    "requires declared %s capability",
    async (fault) => {
      const h = await replicationHarness([page()]);
      const capabilities = await h.adapter.capabilities(providerContext);
      h.adapter.capabilities = async () =>
        fault === "mode"
          ? { ...capabilities, mode: "live_query" }
          : fault === "page_size"
            ? { ...capabilities, rate: { ...capabilities.rate, maxPageSize: 1 } }
            : fault === "unknown_size"
              ? { ...capabilities, rate: { ...capabilities.rate, maxPageSize: null } }
              : { ...capabilities, supports: { ...capabilities.supports, [fault]: false } };
      expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("capability_denied"));
      expect((h.adapter as ScriptedMock).reads).toHaveLength(0);
    },
  );

  it("denies job authorization failure safely before provider access", async () => {
    const h = await replicationHarness([page()]);
    h.ports.authorize = async () => {
      throw new Error("revoked job identity/private context");
    };
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_denied"));
    expect((h.adapter as ScriptedMock).reads).toHaveLength(0);
  });

  it("rechecks rights after an asynchronous read and rejects revocation", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(async () => {
      h.store.feed = { ...h.store.feed, nativeRights: { ...nativeRights, approvalState: "revoked" } };
      return page([upsert(h.records[0])]);
    });
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_denied"));
    expect(h.store.checkpoint.revision).toBe(0);
    expect(h.store.listings.size).toBe(0);
  });

  it("rejects a changed policy even when replication remains allowed", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(async () => {
      h.store.feed = { ...h.store.feed, nativeRights: { ...nativeRights, addressRule: "hidden" } };
      return page([upsert(h.records[0])]);
    });
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("policy_changed"));
    expect(h.store.checkpoint.revision).toBe(0);
  });

  it("requires the commit port to recheck current rights under its transaction", async () => {
    const h = await replicationHarness([page()]);
    h.ports.commitPage = async (plan) => {
      h.store.feed = { ...h.store.feed, nativeRights: { ...nativeRights, approvalState: "revoked" } };
      return h.store.commitPage(plan);
    };
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual({
      status: "reload_required",
      code: "checkpoint_conflict",
    });
    expect(h.store.checkpoint.revision).toBe(0);
  });
});

describe("commit authorization binding", () => {
  it.each(["revision", "rights"])(
    "stops continuation when the cycle's %s changes between pages",
    async (fault) => {
      const h = await replicationHarness([page([], "policy-bound", null), page()], { watermark });
      await stepMockReplication(h.store.checkpoint, h.ports);
      const before = structuredClone(h.store.checkpoint);
      h.store.feed =
        fault === "revision"
          ? { ...h.store.feed, revision: h.store.feed.revision + 1 }
          : { ...h.store.feed, nativeRights: { ...nativeRights, addressRule: "hidden" } };
      expect(await stepMockReplication(before, h.ports)).toEqual(blocked("policy_changed"));
      expect(h.store.checkpoint).toEqual(before);
      expect((h.adapter as ScriptedMock).reads).toHaveLength(1);
    },
  );

  it("clears a finished cycle's binding so a new approved policy can start a fresh cycle", async () => {
    const h = await replicationHarness([page(), page()]);
    await finishCycle(h);
    expect(h.store.checkpoint.cycleBinding).toBe(null);
    h.store.feed = { ...h.store.feed, revision: h.store.feed.revision + 1 };
    await finishCycle(h);
    expect(h.store.checkpoint.revision).toBe(2);
  });

  it("rejects changed still-approved rights after the helper's final check", async () => {
    const h = await replicationHarness([page()]);
    h.ports.commitPage = async (plan) => {
      h.store.feed = { ...h.store.feed, nativeRights: { ...nativeRights, addressRule: "hidden" } };
      return h.store.commitPage(plan);
    };
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual({
      status: "reload_required",
      code: "checkpoint_conflict",
    });
    expect(h.store.checkpoint.revision).toBe(0);
  });
});

describe("mock normalization and receipt identity", () => {
  it.each([...syntheticAttributionContacts, null])(
    "accepts the reviewed nullable canonical contact %j",
    async (contact) => {
      const h = await replicationHarness([]);
      const listing = { ...h.records[0], attribution: { ...h.records[0].attribution, contact } };
      (h.adapter as ScriptedMock).script.push(page([upsert(listing)]));
      let plan!: MockReplicationPagePlan;
      h.ports.commitPage = async (value) => {
        plan = value;
        return h.store.commitPage(value);
      };
      await finishCycle(h);
      expect(h.store.listings.get(listing.sourceListingKey)?.canonical.attribution.contact).toEqual(contact);
      expect(plan.changes[0].listing?.attribution.contact).toEqual(contact);
      if (contact) expect(Object.isFrozen(plan.changes[0].listing?.attribution.contact)).toBe(true);
    },
  );

  it("accepts old canonical attribution without contact", async () => {
    const h = await replicationHarness([]);
    const listing = structuredClone(h.records[0]);
    delete listing.attribution.contact;
    (h.adapter as ScriptedMock).script.push(page([upsert(listing)]));
    await finishCycle(h);
    expect(h.store.listings.get(listing.sourceListingKey)?.canonical.attribution).not.toHaveProperty(
      "contact",
    );
  });

  it.each([
    { kind: "email", value: "not-an-email" },
    { kind: "phone", value: "123" },
    { kind: "phone", value: "123 ext4567" },
    { kind: "email", value: "agent@example.invalid", extra: "unreviewed" },
  ])("rejects an entire canonical page with malformed contact %j", async (contact) => {
    const h = await replicationHarness([]);
    const listing = {
      ...h.records[0],
      attribution: { ...h.records[0].attribution, contact },
    } as (typeof h.records)[0];
    (h.adapter as ScriptedMock).script.push(page([upsert(listing)]));
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("invalid_page"));
    expect(h.store.listings.size).toBe(0);
    expect(h.store.checkpoint.revision).toBe(0);
  });

  it("strips only the existing mock's known fixture fields from committed canonical records", async () => {
    const h = await replicationHarness([]);
    (h.adapter as ScriptedMock).script.push(page([upsert(h.records[0])]));
    let plan!: MockReplicationPagePlan;
    h.ports.commitPage = async (value) => {
      plan = value;
      return h.store.commitPage(value);
    };
    await finishCycle(h);
    const listing = plan.changes[0].listing!;
    for (const key of ["id", "name", "fixtureCase", "media"]) expect(listing).not.toHaveProperty(key);
    expect(listing).toMatchObject({ sourceListingKey: h.records[0].sourceListingKey, synthetic: true });
  });

  it("binds deterministic receipts to page content independently of object property order", async () => {
    const a = await replicationHarness([]);
    const b = await replicationHarness([]);
    (a.adapter as ScriptedMock).script.push(page([upsert(a.records[0])]));
    const reversed = Object.fromEntries(Object.entries(b.records[0]).reverse());
    (b.adapter as ScriptedMock).script.push(
      page([{ ...upsert(b.records[0]), listing: reversed as (typeof b.records)[0] }]),
    );
    await finishCycle(a);
    await finishCycle(b);
    expect([...a.store.receipts]).toEqual([...b.store.receipts]);
  });
});

describe("closed checkpoint/page validation", () => {
  it.each(["context", "extra_field", "limit", "overlap", "watermark", "revision", "cursor_state"])(
    "rejects malformed %s checkpoints before calling ports",
    async (fault) => {
      const h = await replicationHarness([page()]);
      const base = h.store.checkpoint;
      const invalid =
        fault === "context"
          ? { ...base, context: { ...base.context, organizationId: "request-tenant" } }
          : fault === "extra_field"
            ? { ...base, accessToken: "never-persist" }
            : fault === "limit"
              ? { ...base, limit: 101 }
              : fault === "overlap"
                ? { ...base, overlapSeconds: -1 }
                : fault === "watermark"
                  ? { ...base, watermark: "2026-02-30T00:00:00Z" }
                  : fault === "revision"
                    ? { ...base, revision: Number.MAX_SAFE_INTEGER }
                    : { ...base, cursor: "unbound", pagesInCycle: 0 };
      expect(await stepMockReplication(invalid as MockReplicationCheckpoint, h.ports)).toEqual(
        blocked("invalid_checkpoint"),
      );
      expect(h.authorizations()).toBe(0);
      expect((h.adapter as ScriptedMock).reads).toHaveLength(0);
    },
  );

  it("validates and defensively copies checkpoint creation", () => {
    const context = { ...providerContext };
    const checkpoint = createMockReplicationCheckpoint(context);
    context.feedId = "changed-after-creation";
    expect(checkpoint.context).toEqual(providerContext);
    expect(isMockReplicationCheckpoint(checkpoint)).toBe(true);
    expect(() => createMockReplicationCheckpoint(providerContext, { limit: 101 })).toThrow(
      "invalid_checkpoint",
    );
  });

  it.each([
    "missing_watermark",
    "intermediate_watermark",
    "regressing_watermark",
    "oversize",
    "oversize_utf8",
    "too_many",
    "foreign_key",
    "non_synthetic",
    "extra_private",
    "bad_coordinate",
    "missing_listing",
    "delete_payload",
  ])("rejects the entire %s page", async (fault) => {
    const h = await replicationHarness([], { watermark });
    const change = upsert(h.records[0]);
    const valid = page([change]);
    const invalid: unknown =
      fault === "missing_watermark"
        ? { ...valid, completedWatermark: null }
        : fault === "intermediate_watermark"
          ? { ...valid, nextOpaqueCursor: "next", completedWatermark: watermark }
          : fault === "regressing_watermark"
            ? { ...valid, completedWatermark: "2026-10-09T00:01:00Z" }
            : fault === "oversize"
              ? page([], "x".repeat(8193), null)
              : fault === "oversize_utf8"
                ? page([], "☃".repeat(3000), null)
                : fault === "too_many"
                  ? page([change, change, change])
                  : fault === "foreign_key"
                    ? page([{ ...change, sourceListingKey: "SYNTHETIC-other" }])
                    : fault === "non_synthetic"
                      ? page([{ ...change, listing: { ...change.listing!, synthetic: false } }])
                      : fault === "extra_private"
                        ? page([
                            {
                              ...change,
                              listing: { ...change.listing!, privateAgentEmail: "secret@example.invalid" },
                            } as typeof change,
                          ])
                        : fault === "bad_coordinate"
                          ? page([{ ...change, listing: { ...change.listing!, coordinates: [1, 91] } }])
                          : fault === "missing_listing"
                            ? page([{ kind: "upsert", sourceListingKey: change.sourceListingKey }])
                            : page([
                                {
                                  kind: "delete",
                                  sourceListingKey: change.sourceListingKey,
                                  listing: change.listing,
                                },
                              ]);
    (h.adapter as ScriptedMock).script.push(invalid as ChangePage);
    expect(await stepMockReplication(h.store.checkpoint, h.ports)).toEqual(blocked("invalid_page"));
    expect(h.store.checkpoint.revision).toBe(0);
    expect(h.store.listings.size).toBe(0);
  });
});
