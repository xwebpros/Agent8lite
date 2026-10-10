import { createHash } from "node:crypto";
import { isUuid, type Listing, type ListingSort, MlsReadError, type PageListing } from "./contracts";
import { matchesListingCriteria, normalizeListingCriteria } from "./criteria";
import { decodeListingCursor, encodeListingCursor } from "./cursor";
import { projectNativeMockListing } from "./projection";
import type { ListingReadContext, NativeMockSnapshot } from "./types";

export const MAX_NATIVE_MOCK_RECORDS = 500;
export interface NativeListingSearch {
  readonly filter?: unknown;
  readonly limit?: number;
  readonly sort?: ListingSort;
  readonly cursor?: string | null;
}

export function requireListingRead(context: ListingReadContext): void {
  if (
    ![context.organizationId, context.userId, context.memberId, context.roleId].every(isUuid) ||
    !context.permissions.some((grant) => grant.code === "mls.read" && grant.scope === "organization")
  )
    throw new MlsReadError(403, "permission_denied", "Organization MLS read permission is required.");
}

function validateSnapshot(snapshot: NativeMockSnapshot, context: ListingReadContext): void {
  requireListingRead(context);
  if (snapshot.listings.length > MAX_NATIVE_MOCK_RECORDS || snapshot.feeds.length > 20)
    throw new MlsReadError(503, "mock_limit_exceeded", "The bounded mock dataset is unavailable.");
  const feeds = new Set<string>();
  const ids = new Set<string>();
  const sources = new Set<string>();
  for (const feed of snapshot.feeds) {
    if (feed.tenantId !== context.organizationId || !isUuid(feed.id) || feeds.has(feed.id))
      throw new MlsReadError(503, "snapshot_invalid", "The listing snapshot is unavailable.");
    feeds.add(feed.id);
  }
  for (const listing of snapshot.listings) {
    const source = `${listing.feedId}:${listing.canonical.sourceListingKey}`;
    if (
      listing.tenantId !== context.organizationId ||
      !isUuid(listing.id) ||
      ids.has(listing.id) ||
      sources.has(source) ||
      !feeds.has(listing.feedId)
    )
      throw new MlsReadError(503, "snapshot_invalid", "The listing snapshot is unavailable.");
    ids.add(listing.id);
    sources.add(source);
  }
}

function projections(snapshot: NativeMockSnapshot, now: Date): Listing[] {
  const feeds = new Map(snapshot.feeds.map((feed) => [feed.id, feed]));
  return snapshot.listings.flatMap((native) => {
    const feed = feeds.get(native.feedId);
    const item = feed ? projectNativeMockListing(native, feed, now) : null;
    return item ? [item] : [];
  });
}

function compare(a: Listing, b: Listing, sort: ListingSort) {
  const left =
    sort === "updated_desc"
      ? a.sourceUpdatedAt
        ? Date.parse(a.sourceUpdatedAt)
        : null
      : (a.listPrice ?? null);
  const right =
    sort === "updated_desc"
      ? b.sourceUpdatedAt
        ? Date.parse(b.sourceUpdatedAt)
        : null
      : (b.listPrice ?? null);
  if (left === null && right !== null) return 1;
  if (right === null && left !== null) return -1;
  const direction = sort === "price_asc" ? 1 : -1;
  return left !== right && left !== null && right !== null
    ? (left - right) * direction
    : a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}

/** Cursor binding includes current source/rights generations, never returns them as listing fields. */
export function searchNativeMockListings(
  snapshot: NativeMockSnapshot,
  context: ListingReadContext,
  input: NativeListingSearch,
  options: { readonly now: Date; readonly signingKey: string },
): PageListing {
  validateSnapshot(snapshot, context);
  if (!Number.isFinite(options.now.getTime()))
    throw new MlsReadError(503, "clock_invalid", "The listing clock is unavailable.");
  const criteria = normalizeListingCriteria(input.filter ?? {});
  const limit = input.limit ?? 20;
  const sort = input.sort ?? "updated_desc";
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !["updated_desc", "price_asc", "price_desc"].includes(sort)
  )
    throw new MlsReadError(422, "query_invalid", "The listing limit or sort is invalid.");
  const binding = createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          context: {
            ...context,
            permissions: [...context.permissions].sort(
              (a, b) => a.code.localeCompare(b.code) || a.scope.localeCompare(b.scope),
            ),
          },
          criteria,
          limit,
          sort,
          feeds: [...snapshot.feeds].sort((a, b) => a.id.localeCompare(b.id)),
          listings: [...snapshot.listings].sort((a, b) => a.id.localeCompare(b.id)),
        }),
      ),
    )
    .digest("hex");
  const lastId = decodeListingCursor(input.cursor, binding, options.now, options.signingKey);
  const matches = projections(snapshot, options.now)
    .filter((item) => matchesListingCriteria(item, criteria))
    .sort((a, b) => compare(a, b, sort));
  const index = lastId === null ? -1 : matches.findIndex((item) => item.id === lastId);
  if (lastId !== null && index < 0)
    throw new MlsReadError(422, "cursor_invalid", "Pagination expired or does not match the current search.");
  const items = matches.slice(index + 1, index + 1 + limit);
  const hasMore = index + 1 + items.length < matches.length;
  const earliestExpiry = Math.min(...matches.map((item) => Date.parse(item.expiresAt)));
  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? encodeListingCursor(
          items[items.length - 1].id,
          binding,
          options.now,
          earliestExpiry,
          options.signingKey,
        )
      : null,
  };
}

export function getNativeMockListing(
  snapshot: NativeMockSnapshot,
  context: ListingReadContext,
  listingId: string,
  now: Date,
): Listing | null {
  validateSnapshot(snapshot, context);
  if (!isUuid(listingId)) return null;
  return projections(snapshot, now).find((item) => item.id === listingId) ?? null;
}
