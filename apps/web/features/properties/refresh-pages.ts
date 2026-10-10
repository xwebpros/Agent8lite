import type { components } from "../../../../packages/contracts/generated/api";
import { propertiesAreCurrent } from "./read-lifecycle";

type Page = components["schemas"]["PageListing"];
const MAX_VISIBLE_PROPERTIES = 500;
const MAX_REFRESH_REQUESTS = 5;

/** Rebuild the visible count with current cursors; previous records are never reused. */
export async function refreshPropertyPages(
  params: URLSearchParams,
  visibleCount: number,
  read: (query: URLSearchParams) => Promise<Page>,
  current: () => boolean,
): Promise<{ page: Page; params: URLSearchParams } | null> {
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
      (page.hasMore && (!page.items.length || !page.nextCursor || cursors.has(page.nextCursor)))
    )
      throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
    for (const item of page.items) {
      if (ids.has(item.id))
        throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
      ids.add(item.id);
      items.push(item);
    }
    if (!propertiesAreCurrent(items))
      throw new Error("These synthetic results expired while loading. Refresh the search.");
    if (items.length >= target || !page.hasMore) return { page: { ...page, items }, params: paging };
    cursors.add(page.nextCursor!);
    query.set("cursor", page.nextCursor!);
  }
  throw new Error("Synthetic results changed while refreshing. Apply filters to start a fresh search.");
}
