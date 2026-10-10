import { createHash } from "node:crypto";
import type { ChangePage, FeedContext, ReplicationAdapter, SourceChange } from "../providers/mls/port";
import { isDisplayPolicy } from "./contracts";
import { isNativeRights } from "./projection";
import {
  closed,
  integer,
  isReplicationContext,
  isSyntheticCanonical,
  normalizeSyntheticCanonical,
  record,
  text,
  timestamp,
} from "./replication-validation";
import type { NativeMockFeed } from "./types";

/** Internal server state, never a Listing DTO, public cursor, credential or browser cache. */
export interface MockReplicationCheckpoint {
  readonly schemaVersion: 1;
  readonly context: FeedContext;
  readonly resource: "listing";
  readonly revision: number;
  readonly cursor: string | null;
  readonly watermark: string | null;
  readonly overlapSeconds: number;
  readonly limit: number;
  readonly pagesInCycle: number;
  readonly cursorHashes: readonly string[];
  readonly cycleBinding: MockReplicationFeedBinding | null;
}

export interface MockReplicationFeedBinding {
  readonly feedRevision: number;
  readonly rightsFingerprint: string;
}

export interface MockReplicationPagePlan extends MockReplicationFeedBinding {
  readonly expected: MockReplicationCheckpoint;
  readonly next: MockReplicationCheckpoint;
  readonly changes: readonly SourceChange[];
  readonly receiptId: string;
}

export type MockReplicationCommit =
  | {
      readonly status: "committed";
      readonly receiptId: string;
      readonly checkpoint: MockReplicationCheckpoint;
    }
  | { readonly status: "conflict" };

export interface MockReplicationPorts {
  readonly adapter: ReplicationAdapter;
  /** Trusted service verifies current tenant/job identity, mls.sync permission and capability. */
  authorize(context: FeedContext): Promise<NativeMockFeed>;
  /** Atomic page + invalidation + checkpoint CAS transaction; acknowledge only after commit. */
  commitPage(plan: MockReplicationPagePlan): Promise<MockReplicationCommit>;
}

type BlockReason =
  | "invalid_checkpoint"
  | "policy_denied"
  | "policy_changed"
  | "capability_denied"
  | "read_failed"
  | "invalid_page"
  | "credential_expired"
  | "cursor_expired";
export type MockReplicationResult =
  | { readonly status: "advanced" | "completed"; readonly checkpoint: MockReplicationCheckpoint }
  | { readonly status: "retry"; readonly code: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly status: "blocked"; readonly code: BlockReason }
  | { readonly status: "reload_required"; readonly code: "commit_unknown" | "checkpoint_conflict" };

/** Only explicitly classified mock faults are consumed. Arbitrary error text is never inspected. */
export class MockReplicationReadError extends Error {
  constructor(
    readonly code: "rate_limited" | "credential_expired" | "cursor_expired",
    readonly retryAfterSeconds = 60,
  ) {
    super(code);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const cursorText = (value: unknown): value is string =>
  text(value, 8192) && Buffer.byteLength(value, "utf8") <= 8192;
function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

const checkpointKeys = [
  "schemaVersion",
  "context",
  "resource",
  "revision",
  "cursor",
  "watermark",
  "overlapSeconds",
  "limit",
  "pagesInCycle",
  "cursorHashes",
  "cycleBinding",
];
export function isMockReplicationCheckpoint(value: unknown): value is MockReplicationCheckpoint {
  if (!record(value) || !closed(value, checkpointKeys)) return false;
  const hashes = value.cursorHashes;
  return (
    value.schemaVersion === 1 &&
    isReplicationContext(value.context) &&
    value.resource === "listing" &&
    integer(value.revision, 0, Number.MAX_SAFE_INTEGER) &&
    (value.cursor === null || cursorText(value.cursor)) &&
    (value.watermark === null || timestamp(value.watermark)) &&
    integer(value.overlapSeconds, 0, 86400) &&
    integer(value.limit, 1, 100) &&
    integer(value.pagesInCycle, 0, 99) &&
    Array.isArray(hashes) &&
    hashes.length === value.pagesInCycle &&
    [...hashes].every((entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry)) &&
    new Set(hashes).size === hashes.length &&
    (value.cursor === null
      ? value.pagesInCycle === 0 && value.cycleBinding === null
      : value.pagesInCycle > 0 &&
        hashes.at(-1) === hash(value.cursor) &&
        record(value.cycleBinding) &&
        closed(value.cycleBinding, ["feedRevision", "rightsFingerprint"]) &&
        integer(value.cycleBinding.feedRevision, 1, Number.MAX_SAFE_INTEGER) &&
        typeof value.cycleBinding.rightsFingerprint === "string" &&
        /^[a-f0-9]{64}$/.test(value.cycleBinding.rightsFingerprint))
  );
}

export function createMockReplicationCheckpoint(
  context: FeedContext,
  options: {
    readonly overlapSeconds?: number;
    readonly limit?: number;
    readonly watermark?: string | null;
  } = {},
): MockReplicationCheckpoint {
  const checkpoint: MockReplicationCheckpoint = {
    schemaVersion: 1,
    context: structuredClone(context),
    resource: "listing",
    revision: 0,
    cursor: null,
    watermark: options.watermark ?? null,
    overlapSeconds: options.overlapSeconds ?? 30,
    limit: options.limit ?? 100,
    pagesInCycle: 0,
    cursorHashes: [],
    cycleBinding: null,
  };
  if (!isMockReplicationCheckpoint(checkpoint)) throw new Error("invalid_checkpoint");
  return immutable(checkpoint);
}

function authorizedFeed(feed: NativeMockFeed, context: FeedContext): boolean {
  return (
    feed.tenantId === context.organizationId &&
    feed.id === context.feedId &&
    feed.mode === "mock" &&
    feed.transport === "mock" &&
    feed.providerCode === "mock-synthetic" &&
    feed.state === "ready" &&
    integer(feed.revision, 1, Number.MAX_SAFE_INTEGER) &&
    isDisplayPolicy(feed.displayPolicy) &&
    feed.displayPolicy.approved &&
    feed.displayPolicy.allowReplication &&
    feed.displayPolicy.rawRetentionSeconds > 0 &&
    isNativeRights(feed.nativeRights) &&
    feed.nativeRights.approvalState === "approved" &&
    feed.nativeRights.rights.replicate === "allowed" &&
    feed.nativeRights.retentionDays !== null &&
    feed.nativeRights.retentionDays > 0
  );
}
const rightsFingerprint = (feed: NativeMockFeed) =>
  hash({
    revision: feed.revision,
    displayPolicy: feed.displayPolicy,
    nativeRights: feed.nativeRights,
  });

/** Commit ports rederive this binding from current locked rows, never trust the supplied hash. */
export function getMockReplicationFeedBinding(
  context: FeedContext,
  feed: NativeMockFeed,
): MockReplicationFeedBinding | null {
  if (!isReplicationContext(context) || !authorizedFeed(feed, context)) return null;
  return { feedRevision: feed.revision, rightsFingerprint: rightsFingerprint(feed) };
}

function validPage(page: unknown, checkpoint: MockReplicationCheckpoint): page is ChangePage {
  if (!record(page) || !closed(page, ["changes", "nextOpaqueCursor", "completedWatermark"])) return false;
  const cursor = page.nextOpaqueCursor;
  const watermark = page.completedWatermark;
  return (
    Array.isArray(page.changes) &&
    page.changes.length <= checkpoint.limit &&
    [...page.changes].every((change) => {
      if (
        !record(change) ||
        !text(change.sourceListingKey, 200) ||
        !change.sourceListingKey.startsWith("SYNTHETIC-")
      )
        return false;
      if (change.kind === "delete") return closed(change, ["kind", "sourceListingKey"]);
      return (
        change.kind === "upsert" &&
        closed(change, ["kind", "sourceListingKey", "listing"]) &&
        isSyntheticCanonical(change.listing) &&
        change.listing.sourceListingKey === change.sourceListingKey
      );
    }) &&
    (cursor === null
      ? timestamp(watermark) &&
        (checkpoint.watermark === null || Date.parse(watermark) >= Date.parse(checkpoint.watermark))
      : cursorText(cursor) &&
        watermark === null &&
        checkpoint.pagesInCycle < 99 &&
        !checkpoint.cursorHashes.includes(hash(cursor)))
  );
}

/** One bounded page. Callers reload durable state after every ambiguous commit or CAS conflict. */
export async function stepMockReplication(
  input: MockReplicationCheckpoint,
  ports: MockReplicationPorts,
): Promise<MockReplicationResult> {
  if (!isMockReplicationCheckpoint(input) || input.revision === Number.MAX_SAFE_INTEGER)
    return { status: "blocked", code: "invalid_checkpoint" };
  const checkpoint = immutable(structuredClone(input));
  if (ports.adapter.providerCode !== "mock-synthetic" || ports.adapter.mode !== "replication")
    return { status: "blocked", code: "capability_denied" };
  let feed: NativeMockFeed;
  let fingerprint: string;
  try {
    feed = immutable(structuredClone(await ports.authorize(checkpoint.context)));
    if (!authorizedFeed(feed, checkpoint.context)) return { status: "blocked", code: "policy_denied" };
    fingerprint = rightsFingerprint(feed);
    if (
      checkpoint.cycleBinding !== null &&
      (checkpoint.cycleBinding.feedRevision !== feed.revision ||
        checkpoint.cycleBinding.rightsFingerprint !== fingerprint)
    )
      return { status: "blocked", code: "policy_changed" };
  } catch {
    return { status: "blocked", code: "policy_denied" };
  }
  let page: ChangePage;
  try {
    const capabilities = await ports.adapter.capabilities(checkpoint.context);
    if (
      capabilities.mode !== "replication" ||
      capabilities.supports.incremental !== true ||
      capabilities.supports.deletions !== true ||
      !integer(capabilities.rate.maxPageSize, checkpoint.limit, Number.MAX_SAFE_INTEGER)
    )
      return { status: "blocked", code: "capability_denied" };
    page = structuredClone(
      await ports.adapter.readChanges(checkpoint.context, {
        cursor: checkpoint.cursor,
        watermark: checkpoint.watermark,
        overlapSeconds: checkpoint.overlapSeconds,
        limit: checkpoint.limit,
      }),
    );
    if (Array.isArray(page.changes)) {
      page = {
        ...page,
        changes: page.changes.map((change) => {
          if (change.kind !== "upsert") return change;
          const canonical = normalizeSyntheticCanonical(change.listing);
          return canonical ? { ...change, listing: canonical } : change;
        }),
      };
    }
  } catch (error) {
    if (error instanceof MockReplicationReadError) {
      if (error.code === "rate_limited" && integer(error.retryAfterSeconds, 1, 3600))
        return { status: "retry", code: "rate_limited", retryAfterSeconds: error.retryAfterSeconds };
      if (error.code === "credential_expired" || error.code === "cursor_expired")
        return { status: "blocked", code: error.code };
    }
    return { status: "blocked", code: "read_failed" };
  }
  if (!validPage(page, checkpoint)) return { status: "blocked", code: "invalid_page" };
  try {
    const current = await ports.authorize(checkpoint.context);
    if (!authorizedFeed(current, checkpoint.context)) return { status: "blocked", code: "policy_denied" };
    if (rightsFingerprint(current) !== fingerprint) return { status: "blocked", code: "policy_changed" };
  } catch {
    return { status: "blocked", code: "policy_denied" };
  }
  const next: MockReplicationCheckpoint = {
    ...checkpoint,
    revision: checkpoint.revision + 1,
    cursor: page.nextOpaqueCursor,
    watermark: page.completedWatermark ?? checkpoint.watermark,
    pagesInCycle: page.nextOpaqueCursor === null ? 0 : checkpoint.pagesInCycle + 1,
    cursorHashes:
      page.nextOpaqueCursor === null ? [] : [...checkpoint.cursorHashes, hash(page.nextOpaqueCursor)],
    cycleBinding:
      page.nextOpaqueCursor === null ? null : { feedRevision: feed.revision, rightsFingerprint: fingerprint },
  };
  const content = {
    expected: checkpoint,
    next,
    feedRevision: feed.revision,
    rightsFingerprint: fingerprint,
    changes: page.changes,
  };
  const plan = immutable({ ...content, receiptId: hash(content) });
  try {
    const commit = await ports.commitPage(plan);
    if (commit?.status === "conflict") return { status: "reload_required", code: "checkpoint_conflict" };
    if (
      !record(commit) ||
      !closed(commit, ["status", "receiptId", "checkpoint"]) ||
      commit.status !== "committed" ||
      commit.receiptId !== plan.receiptId ||
      !isMockReplicationCheckpoint(commit.checkpoint) ||
      hash(commit.checkpoint) !== hash(next)
    )
      return { status: "reload_required", code: "commit_unknown" };
    return {
      status: next.cursor === null ? "completed" : "advanced",
      checkpoint: immutable(structuredClone(next)),
    };
  } catch {
    return { status: "reload_required", code: "commit_unknown" };
  }
}
