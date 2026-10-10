import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyReads } from "../../apps/web/features/properties/read-lifecycle";
import { loadMorePropertyPage, refreshPropertyPages } from "../../apps/web/features/properties/refresh-pages";
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

  it("rejects a terminal refresh response retaining a continuation cursor", async () => {
    const first = read(initial());
    await expect(
      refreshPropertyPages(
        initial(),
        20,
        async () => ({ ...first, hasMore: false }),
        () => true,
      ),
    ).rejects.toThrow(/changed/);
  });

  it("rejects more-results claims after refreshing the complete bounded cohort", async () => {
    await expect(
      refreshPropertyPages(
        initial(),
        500,
        async (query) => ({
          ...read(query),
          hasMore: true,
          nextCursor:
            query.has("cursor") && read(query).nextCursor === null
              ? "synthetic-outside-cohort"
              : read(query).nextCursor,
        }),
        () => true,
      ),
    ).rejects.toThrow(/changed/);
  });
});

describe("W07 continuation of a current accumulated property page", () => {
  const firstPage = () => read(initial());
  const continuation = (page: ReturnType<typeof read>, params = initial()) => {
    const query = new URLSearchParams(params);
    query.set("cursor", page.nextCursor!);
    return query;
  };

  it.each(["price_asc", "price_desc", "updated_desc"] as const)(
    "appends %s after a bounded refresh with the current limit and consumed cursor history",
    async (sort) => {
      const refreshed = (await refreshPropertyPages(
        propertySearchParams(emptyPropertyFilters, sort),
        120,
        async (query) => read(query),
        () => true,
      ))!;
      expect(refreshed.consumedCursors).toHaveLength(1);
      const query = continuation(refreshed.page, refreshed.params);
      const response = (await loadMorePropertyPage(
        refreshed.page,
        query,
        refreshed.consumedCursors,
        async (query) => read(query),
        () => true,
      ))!;
      expect(response.page.items).toEqual([...refreshed.page.items, ...read(query).items]);
      expect(response.page.items).toHaveLength(180);
      expect(response.params.get("limit")).toBe("60");
      expect(response.params.has("cursor")).toBe(false);
      expect(query.get("cursor")).toBe(refreshed.page.nextCursor);
      expect(response.consumedCursors).toEqual([...refreshed.consumedCursors, refreshed.page.nextCursor]);
    },
  );

  it("accepts a terminal empty continuation while retaining the current earlier records", async () => {
    const previous = firstPage();
    const response = (await loadMorePropertyPage(
      previous,
      continuation(previous),
      [],
      async () => ({ items: [], hasMore: false, nextCursor: null }),
      () => true,
    ))!;
    expect(response.page).toEqual({ items: previous.items, hasMore: false, nextCursor: null });
  });

  it.each(["cleared", "changed-scope", "disabled"])(
    "discards a deferred continuation after %s",
    async (loss) => {
      const previous = firstPage();
      const query = continuation(previous);
      const reads = new PropertyReads();
      const request = reads.begin("list", "current-scope");
      let scope = "current-scope";
      let enabled = true;
      let finish!: (page: ReturnType<typeof read>) => void;
      const delayed = new Promise<ReturnType<typeof read>>((resolve) => {
        finish = resolve;
      });
      const pending = loadMorePropertyPage(
        previous,
        query,
        [],
        () => delayed,
        () => reads.current(request, scope, enabled),
      );
      if (loss === "cleared") reads.clear();
      else if (loss === "changed-scope") scope = "another-org";
      else enabled = false;
      finish(read(query));
      expect(await pending).toBeNull();
    },
  );

  it.each(["wrong-cursor", "used-cursor", "no-more", "empty-parent", "full-cohort"])(
    "rejects %s before making a continuation request",
    async (fault) => {
      const first = firstPage();
      const previous =
        fault === "no-more"
          ? { ...first, hasMore: false, nextCursor: null }
          : fault === "empty-parent"
            ? { ...first, items: [] }
            : fault === "full-cohort"
              ? {
                  ...first,
                  items: Array.from({ length: 500 }, (_, index) => ({
                    ...first.items[0],
                    id: `synthetic-${index}`,
                  })),
                }
              : first;
      const query = continuation(first);
      if (fault === "wrong-cursor") query.set("cursor", "different-source-cursor");
      const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
      await expect(
        loadMorePropertyPage(
          previous,
          query,
          fault === "used-cursor" ? [first.nextCursor!] : [],
          fetchPage,
          () => true,
        ),
      ).rejects.toThrow(/changed/);
      expect(fetchPage).not.toHaveBeenCalled();
    },
  );

  it.each([
    "prior-id",
    "repeated-id",
    "same-cursor",
    "earlier-cursor",
    "empty-more",
    "oversized",
    "missing-cursor",
    "terminal-cursor",
  ])("rejects %s progress without changing the earlier page", async (fault) => {
    const previous = firstPage();
    const before = structuredClone(previous);
    const query = continuation(previous);
    const next = read(query);
    if (fault === "prior-id") next.items[0] = previous.items[0];
    if (fault === "repeated-id") next.items[1] = next.items[0];
    if (fault === "same-cursor") next.nextCursor = query.get("cursor");
    if (fault === "earlier-cursor") next.nextCursor = "an-earlier-consumed-cursor";
    if (fault === "empty-more") next.items = [];
    if (fault === "oversized") next.items.push({ ...next.items[0], id: "extra-synthetic-id" });
    if (fault === "missing-cursor") next.nextCursor = null;
    if (fault === "terminal-cursor") next.hasMore = false;
    await expect(
      loadMorePropertyPage(
        previous,
        query,
        ["an-earlier-consumed-cursor"],
        async () => next,
        () => true,
      ),
    ).rejects.toThrow(/changed/);
    expect(previous).toEqual(before);
  });

  it("does not exceed the 500-record cohort when the next page itself is within its limit", async () => {
    const first = firstPage();
    const previous = {
      ...first,
      items: Array.from({ length: 499 }, (_, index) => ({ ...first.items[0], id: `synthetic-${index}` })),
    };
    const next = { items: [first.items[0], first.items[1]], hasMore: false, nextCursor: null };
    await expect(
      loadMorePropertyPage(
        previous,
        continuation(previous),
        [],
        async () => next,
        () => true,
      ),
    ).rejects.toThrow(/changed/);
  });

  it.each([false, true])(
    "requires terminal progress at exactly 500 records (hasMore=%s)",
    async (hasMore) => {
      const first = firstPage();
      const previous = {
        ...first,
        items: Array.from({ length: 499 }, (_, index) => ({ ...first.items[0], id: `synthetic-${index}` })),
      };
      const next = {
        items: [first.items[0]],
        hasMore,
        nextCursor: hasMore ? "synthetic-outside-cohort" : null,
      };
      const pending = loadMorePropertyPage(
        previous,
        continuation(previous),
        [],
        async () => next,
        () => true,
      );
      if (hasMore) await expect(pending).rejects.toThrow(/changed/);
      else expect((await pending)?.page.items).toHaveLength(500);
    },
  );

  it("rejects earlier records that expire while a new page is awaited", async () => {
    const previous = firstPage();
    previous.items[0] = { ...previous.items[0], expiresAt: new Date(Date.now() + 1).toISOString() };
    const query = continuation(previous);
    const next = read(query);
    await expect(
      loadMorePropertyPage(
        previous,
        query,
        [],
        async () => {
          vi.advanceTimersByTime(1);
          return next;
        },
        () => true,
      ),
    ).rejects.toThrow(/expired/);
  });

  it("denies an already expired parent before requesting more records", async () => {
    const previous = firstPage();
    previous.items[0] = { ...previous.items[0], expiresAt: new Date().toISOString() };
    const fetchPage = vi.fn(async (query: URLSearchParams) => read(query));
    await expect(
      loadMorePropertyPage(previous, continuation(previous), [], fetchPage, () => true),
    ).rejects.toThrow(/expired/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError(403, "Current field rights revoked."),
    new DOMException("The current read was interrupted.", "AbortError"),
  ])("preserves current provider failure $name for private clearing/revocation", async (failure) => {
    const previous = firstPage();
    await expect(
      loadMorePropertyPage(
        previous,
        continuation(previous),
        [],
        async () => {
          throw failure;
        },
        () => true,
      ),
    ).rejects.toBe(failure);
  });
});
