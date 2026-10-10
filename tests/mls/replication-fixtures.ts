import { createHash } from "node:crypto";
import {
  createMockReplicationCheckpoint,
  getMockReplicationFeedBinding,
  type MockReplicationCheckpoint,
  type MockReplicationCommit,
  type MockReplicationPagePlan,
  type MockReplicationPorts,
  type NativeMockFeed,
  type NativeMockListing,
} from "../../packages/mls";
import { MOCK_CLOCK, MockMlsAdapter } from "../../packages/providers/mls/mock";
import type {
  CanonicalListing,
  ChangePage,
  FeedContext,
  SourceChange,
} from "../../packages/providers/mls/port";
import { mockSnapshot, nativeRights, providerContext } from "./fixtures";

export const watermark = MOCK_CLOCK.toISOString();
export type ReadInput = Parameters<MockMlsAdapter["readChanges"]>[1];
type Script = ChangePage | Error | ((input: ReadInput) => Promise<ChangePage>);

/** Test-only extension of the existing provider: synthetic pages/faults, never network. */
export class ScriptedMock extends MockMlsAdapter {
  readonly reads: { context: FeedContext; input: ReadInput }[] = [];
  constructor(readonly script: Script[]) {
    super(
      () => MOCK_CLOCK,
      () => nativeRights,
    );
  }
  override async readChanges(context: FeedContext, input: ReadInput): Promise<ChangePage> {
    this.reads.push(structuredClone({ context, input }));
    const next = this.script.shift();
    if (!next) throw new Error("missing synthetic test page");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(input) : structuredClone(next);
  }
}

const content = (listing: CanonicalListing) =>
  JSON.stringify({ ...listing, ingestedAt: null, expiresAt: null });
const copy = <T>(value: T): T => structuredClone(value);

/** In-memory transaction model only. It proves atomic publish/order/CAS; it is not DB durability. */
export class MemoryReplicationStore {
  listings = new Map<string, NativeMockListing>();
  tombstones = new Set<string>();
  invalidations = new Set<string>();
  receipts = new Set<string>();
  readonly events: string[] = [];
  failure: "before_commit" | "after_commit" | number | null = null;
  beforePublish?: () => Promise<void>;
  constructor(
    public checkpoint: MockReplicationCheckpoint,
    public feed: NativeMockFeed,
  ) {}

  async commitPage(plan: MockReplicationPagePlan): Promise<MockReplicationCommit> {
    const eligible = () => {
      const binding = getMockReplicationFeedBinding(plan.expected.context, this.feed);
      return (
        JSON.stringify(this.checkpoint) === JSON.stringify(plan.expected) &&
        binding?.feedRevision === plan.feedRevision &&
        binding.rightsFingerprint === plan.rightsFingerprint
      );
    };
    if (!eligible()) return { status: "conflict" };
    const listings = new Map([...this.listings].map(([key, listing]) => [key, copy(listing)]));
    const tombstones = new Set(this.tombstones);
    const invalidations = new Set(this.invalidations);
    for (const [index, change] of plan.changes.entries()) {
      if (this.failure === index) throw new Error("synthetic change-processing crash");
      const key = change.sourceListingKey;
      const existing = listings.get(key);
      if (change.kind === "delete") {
        if (!tombstones.has(key)) {
          tombstones.add(key);
          invalidations.add(`withdraw:${key}`);
          if (existing)
            listings.set(key, { ...existing, revision: existing.revision + 1, withdrawnAt: watermark });
        }
      } else if (change.listing && !tombstones.has(key)) {
        const listing = change.listing;
        // Test contract: unchanged overlap does not renew age/expiry or duplicate invalidations.
        if (existing && content(existing.canonical) === content(listing)) continue;
        // Known older changes cannot roll back a newer value; equal timestamps still process.
        if (
          existing?.canonical.sourceModifiedAt &&
          listing.sourceModifiedAt &&
          Date.parse(listing.sourceModifiedAt) < Date.parse(existing.canonical.sourceModifiedAt)
        )
          continue;
        const digest = createHash("sha256")
          .update(`${plan.expected.context.organizationId}/${plan.expected.context.feedId}/${key}`)
          .digest("hex");
        listings.set(key, {
          tenantId: plan.expected.context.organizationId,
          feedId: plan.expected.context.feedId,
          id:
            existing?.id ?? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4000-8000-${digest.slice(12, 24)}`,
          sourceListingId: key,
          currency: "USD",
          revision: (existing?.revision ?? 0) + 1,
          withdrawnAt: listing.status === "off_market" || listing.status === "closed" ? watermark : null,
          canonical: copy(listing),
        });
        // Stable event identity for this test ledger; production source identity needs review.
        invalidations.add(`change:${key}:${content(listing)}`);
        if (listing.status === "off_market" || listing.status === "closed") {
          tombstones.add(key);
          invalidations.add(`withdraw:${key}`);
        }
      }
      this.events.push(`processed:${key}`);
    }
    await this.beforePublish?.();
    if (!eligible()) return { status: "conflict" };
    if (this.failure === "before_commit") throw new Error("synthetic transaction crash");
    this.events.push("checkpoint");
    // Atomic publish represents a single successful transaction in this test double.
    this.listings = listings;
    this.tombstones = tombstones;
    this.invalidations = invalidations;
    this.checkpoint = copy(plan.next);
    this.receipts.add(plan.receiptId);
    this.events.push("commit");
    if (this.failure === "after_commit") throw new Error("synthetic lost commit acknowledgement");
    return { status: "committed", receiptId: plan.receiptId, checkpoint: copy(this.checkpoint) };
  }
}

export const upsert = (listing: CanonicalListing): SourceChange => ({
  kind: "upsert",
  sourceListingKey: listing.sourceListingKey,
  listing: copy(listing),
});
export const page = (
  changes: readonly SourceChange[] = [],
  cursor: string | null = null,
  complete: string | null = watermark,
): ChangePage => ({
  changes,
  nextOpaqueCursor: cursor,
  completedWatermark: complete,
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

export async function replicationHarness(
  script?: Script[],
  options: Parameters<typeof createMockReplicationCheckpoint>[1] = {},
) {
  const snapshot = await mockSnapshot();
  const checkpoint = createMockReplicationCheckpoint(providerContext, { limit: 2, ...options });
  const store = new MemoryReplicationStore(copy(checkpoint), copy(snapshot.feeds[0]));
  const adapter = script
    ? new ScriptedMock(script)
    : new MockMlsAdapter(
        () => MOCK_CLOCK,
        () => nativeRights,
      );
  let authorizations = 0;
  const ports: MockReplicationPorts = {
    adapter,
    authorize: async () => {
      authorizations += 1;
      return copy(store.feed);
    },
    commitPage: (plan) => store.commitPage(plan),
  };
  return {
    store,
    adapter,
    ports,
    checkpoint,
    records: snapshot.listings.map((listing) => listing.canonical),
    authorizations: () => authorizations,
  };
}
