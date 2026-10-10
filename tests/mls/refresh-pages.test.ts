import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyReads } from "../../apps/web/features/properties/read-lifecycle";
import { refreshPropertyPages } from "../../apps/web/features/properties/refresh-pages";
import { emptyPropertyFilters, propertySearchParams } from "../../apps/web/features/properties/search-input";
import { ApiError } from "../../apps/web/lib/api";
import {
  type ListingSort,
  type NativeMockSnapshot,
  parseNativeListingQuery,
  searchNativeMockListings,
} from "../../packages/mls";
import { context, mockSnapshot, nativeRights, options } from "./fixtures";

let snapshot: NativeMockSnapshot;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(options.now);
  const source = await mockSnapshot();
  snapshot = {
    ...source,
    listings: Array.from({ length: 500 }, (_, index) => ({
      ...source.listings[0],
      id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      sourceListingId: `SYNTHETIC-REFRESH-${index}`,
      canonical: {
        ...source.listings[0].canonical,
        sourceListingKey: `SYNTHETIC-REFRESH-${index}`,
        listPrice: 300000 + index,
      },
    })),
  };
});
afterEach(() => vi.useRealTimers());
const initial = () => propertySearchParams(emptyPropertyFilters, "price_asc");
const read = (query: URLSearchParams) => {
  const input = parseNativeListingQuery(Object.fromEntries(query));
  return searchNativeMockListings(snapshot, context, input, { ...options, now: new Date() });
};

describe("W07 current cursor refresh of accumulated property results", () => {
  it.each([0, 40, 100, 120, 280, 500])(
    "rebuilds %i visible records within five current reads",
    async (count) => {
      const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
      const params = initial();
      params.set("cursor", "previous-stale-cursor");
      const response = await refreshPropertyPages(params, count, fetchPage, () => true);
      expect(response).not.toBeNull();
      expect(fetchPage.mock.calls.length).toBeLessThanOrEqual(5);
      expect(response!.page.items.length).toBeGreaterThanOrEqual(Math.max(20, count));
      expect(response!.page.items.length).toBeLessThanOrEqual(Math.max(20, count) + 4);
      expect(new Set(response!.page.items.map((item) => item.id)).size).toBe(response!.page.items.length);
      expect(fetchPage.mock.calls[0][0].has("cursor")).toBe(false);
      expect(params.get("cursor")).toBe("previous-stale-cursor");
      expect(params.get("limit")).toBe("20");
      expect(response!.params.has("cursor")).toBe(false);
      for (const [query] of fetchPage.mock.calls) {
        expect(query.get("filter")).toBe(params.get("filter"));
        expect(query.get("sort")).toBe("price_asc");
        expect(Number(query.get("limit"))).toBeLessThanOrEqual(100);
      }
    },
  );

  it.each(["price_asc", "price_desc", "updated_desc"] as const)(
    "preserves %s ordering and the correct limit binding for load-more after refresh",
    async (sort: ListingSort) => {
      const params = propertySearchParams(emptyPropertyFilters, sort);
      const response = await refreshPropertyPages(
        params,
        120,
        async (query) => read(query),
        () => true,
      );
      expect(response!.page.items.length).toBe(120);
      const continuation = new URLSearchParams(response!.params);
      continuation.set("cursor", response!.page.nextCursor!);
      const more = read(continuation);
      expect(more.items.length).toBe(60);
      const accumulated = [...response!.page.items, ...more.items];
      const expected = searchNativeMockListings(snapshot, context, { limit: 100, sort }, options).items;
      expect(accumulated.slice(0, 100)).toEqual(expected);
      expect(new Set(accumulated.map((item) => item.id)).size).toBe(180);
      continuation.set("limit", "20");
      expect(() => read(continuation)).toThrow(/Pagination/);
    },
  );

  it("uses freshly projected records and stops early after current withdrawal reduces the dataset", async () => {
    snapshot = {
      ...snapshot,
      listings: snapshot.listings.map((item, index) =>
        index < 35
          ? { ...item, canonical: { ...item.canonical, publicRemarks: "Fresh synthetic revision" } }
          : { ...item, withdrawnAt: options.now.toISOString() },
      ),
    };
    const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
    const response = await refreshPropertyPages(initial(), 120, fetchPage, () => true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(response!.page.items.length).toBe(35);
    expect(response!.page.hasMore).toBe(false);
    expect(response!.page.nextCursor).toBeNull();
    expect(response!.page.items.every((item) => item.remarks === "Fresh synthetic revision")).toBe(true);
  });

  it("discards partial refreshed pages if current rights change between requests", async () => {
    let requests = 0;
    const fetchPage = vi.fn(async (query: URLSearchParams) => {
      if (++requests === 2)
        snapshot = {
          ...snapshot,
          feeds: snapshot.feeds.map((feed) => ({
            ...feed,
            nativeRights: { ...nativeRights, approvalState: "revoked" },
          })),
        };
      return read(query);
    });
    await expect(refreshPropertyPages(initial(), 120, fetchPage, () => true)).rejects.toThrow(/Pagination/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not return an earlier page that expires while a later current read completes", async () => {
    const fetchPage = vi.fn(async (query: URLSearchParams) => {
      const page = read(query);
      if (!query.has("cursor"))
        page.items[0] = { ...page.items[0], expiresAt: new Date(Date.now() + 1).toISOString() };
      else vi.advanceTimersByTime(1);
      return page;
    });
    await expect(refreshPropertyPages(initial(), 120, fetchPage, () => true)).rejects.toThrow(/expired/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("returns no private partial batch when access is cleared during a deferred later request", async () => {
    const reads = new PropertyReads();
    const request = reads.begin("list", "current-scope");
    let complete!: (page: ReturnType<typeof read>) => void;
    const later = new Promise<ReturnType<typeof read>>((resolve) => {
      complete = resolve;
    });
    const fetchPage = vi.fn(async (query: URLSearchParams) => (query.has("cursor") ? later : read(query)));
    const pending = refreshPropertyPages(initial(), 120, fetchPage, () =>
      reads.current(request, "current-scope", true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    reads.clear();
    complete(read(fetchPage.mock.calls[1][0]));
    expect(await pending).toBeNull();
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("does not begin requests after current access has changed", async () => {
    const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
    expect(await refreshPropertyPages(initial(), 120, fetchPage, () => false)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("preserves a later permission failure so the component can revoke access", async () => {
    const failure = new ApiError(403, "Access revoked.");
    const fetchPage = vi.fn(async (query: URLSearchParams) => {
      if (query.has("cursor")) throw failure;
      return read(query);
    });
    await expect(refreshPropertyPages(initial(), 120, fetchPage, () => true)).rejects.toBe(failure);
  });

  it.each([-1, 501, 1.5, Number.NaN])(
    "rejects invalid visible-count bound %s before reads",
    async (count) => {
      const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
      await expect(refreshPropertyPages(initial(), count, fetchPage, () => true)).rejects.toThrow(
        /too large/,
      );
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it("rejects repeated cursors instead of repeatedly fetching an inconsistent source", async () => {
    const first = read(new URLSearchParams({ filter: "{}", sort: "price_asc", limit: "60" }));
    const fetchPage = vi.fn(async () => ({ ...first }));
    await expect(refreshPropertyPages(initial(), 120, fetchPage, () => true)).rejects.toThrow(/changed/);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("bounds malformed partial-page progress to five requests", async () => {
    let requests = 0;
    const first = read(new URLSearchParams({ filter: "{}", sort: "price_asc", limit: "5" }));
    const fetchPage = vi.fn(async () => ({
      items: [first.items[requests++]],
      hasMore: true,
      nextCursor: `synthetic-cursor-${requests}`,
    }));
    await expect(refreshPropertyPages(initial(), 120, fetchPage, () => true)).rejects.toThrow(/changed/);
    expect(fetchPage).toHaveBeenCalledTimes(5);
  });
});
