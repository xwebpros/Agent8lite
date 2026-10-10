import type { components } from "../../../../packages/contracts/generated/api";
import { propertiesAreCurrent } from "./read-lifecycle";

type Page = components["schemas"]["PageListing"];
const MAX_VISIBLE_PROPERTIES = 500;
const MAX_REFRESH_REQUESTS = 5;
const changedResults = () => new Error("Synthetic results changed while loading. Refresh the search.");

/** Accept only progress from the displayed page's cursor; never silently replace duplicates. */
export async function loadMorePropertyPage(
  previous: Page,
  params: URLSearchParams,
  consumedCursors: readonly string[],
  read: (query: URLSearchParams) => Promise<Page>,
  current: () => boolean,
): Promise<{ page: Page; params: URLSearchParams; consumedCursors: readonly string[] } | null> {
  if (!current()) return null;
  const query = new URLSearchParams(params);
  const cursor = query.get("cursor");
  const limit = Number(query.get("limit"));
  const seen = new Set(consumedCursors);
  if (
    !previous.hasMore ||
    !cursor ||
    cursor !== previous.nextCursor ||
    seen.has(cursor) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !previous.items.length ||
    previous.items.length >= MAX_VISIBLE_PROPERTIES
  )
    throw changedResults();
  if (!propertiesAreCurrent(previous.items))
    throw new Error("These synthetic results expired while loading. Refresh the search.");
  seen.add(cursor);
  const next = await read(new URLSearchParams(query));
  if (!current()) return null;
  if (
    next.items.length > limit ||
    (next.hasMore
      ? !next.items.length || !next.nextCursor || seen.has(next.nextCursor)
      : next.nextCursor !== null)
  )
    throw changedResults();
  const items = [...previous.items, ...next.items];
  if (
    items.length > MAX_VISIBLE_PROPERTIES ||
    (items.length === MAX_VISIBLE_PROPERTIES && next.hasMore) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw changedResults();
  if (!propertiesAreCurrent(items))
    throw new Error("These synthetic results expired while loading. Refresh the search.");
  query.delete("cursor");
  return { page: { ...next, items }, params: query, consumedCursors: [...seen] };
}

/** Rebuild the visible count with current cursors; previous records are never reused. */
export async function refreshPropertyPages(
  params: URLSearchParams,
  visibleCount: number,
  read: (query: URLSearchParams) => Promise<Page>,
  current: () => boolean,
): Promise<{ page: Page; params: URLSearchParams; consumedCursors: readonly string[] } | null> {
  if (!Number.isInteger(visibleCount) || visibleCount < 0 || visibleCount > MAX_VISIBLE_PROPERTIES)
    throw new Error("The synthetic result set is too large. Apply filters to start a fresh search.");
  const target = Math.max(20, visibleCount);
  const limit = Math.ceil(target / Math.ceil(target / 100));
  const paging = new URLSearchParams(params);
  paging.delete("cursor");
  paging.set("limit", String(limit));
  const query = new URLSearchParams(paging);
  const items: Page["items"] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  for (let request = 0; request < MAX_REFRESH_REQUESTS; ++request) {
    if (!current()) return null;
    const page = await read(new URLSearchParams(query));
    if (!current()) return null;
    if (
      page.items.length > limit ||
      (page.hasMore
        ? !page.items.length || !page.nextCursor || cursors.has(page.nextCursor)
        : page.nextCursor !== null)
    )
      throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
    for (const item of page.items) {
      if (ids.has(item.id))
        throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
      ids.add(item.id);
      items.push(item);
    }
    if (items.length >= MAX_VISIBLE_PROPERTIES && page.hasMore)
      throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
    if (!propertiesAreCurrent(items))
      throw new Error("These synthetic results expired while loading. Refresh the search.");
    if (items.length >= target || !page.hasMore)
      return { page: { ...page, items }, params: paging, consumedCursors: [...cursors] };
    cursors.add(page.nextCursor!);
    query.set("cursor", page.nextCursor!);
  }
  throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
}
