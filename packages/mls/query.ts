import { normalizeListingCriteria } from "./criteria";
import { MlsReadError } from "./contracts";
import type { NativeListingSearch } from "./search";

/** Closed parser for the frozen search query. Route registration remains coordinator-owned. */
export function parseNativeListingQuery(query: unknown): NativeListingSearch {
  if (!query || typeof query !== "object" || Array.isArray(query))
    throw new MlsReadError(422, "query_invalid", "The listing query is invalid.");
  const input = query as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["filter", "sort", "limit", "cursor"].includes(key)))
    throw new MlsReadError(422, "query_invalid", "The listing query contains unsupported parameters.");
  let filter: unknown = {};
  if (input.filter !== undefined) {
    if (typeof input.filter !== "string" || input.filter.length > 8192)
      throw new MlsReadError(422, "filter_invalid", "The listing filter is invalid.");
    try {
      filter = JSON.parse(input.filter);
    } catch {
      throw new MlsReadError(422, "filter_invalid", "The listing filter is invalid.");
    }
  }
  const parsed: NativeListingSearch = { filter: normalizeListingCriteria(filter) };
  const limit =
    input.limit === undefined
      ? 20
      : typeof input.limit === "string" && /^(?:[1-9]\d?|100)$/.test(input.limit)
        ? Number(input.limit)
        : Number.NaN;
  if (!Number.isInteger(limit)) throw new MlsReadError(422, "query_invalid", "The listing limit is invalid.");
  const sort = input.sort ?? "updated_desc";
  if (sort !== "updated_desc" && sort !== "price_asc" && sort !== "price_desc")
    throw new MlsReadError(422, "query_invalid", "The listing sort is invalid.");
  if (
    input.cursor !== undefined &&
    (typeof input.cursor !== "string" || !input.cursor || input.cursor.length > 2048)
  )
    throw new MlsReadError(422, "cursor_invalid", "The listing cursor is invalid.");
  return { ...parsed, limit, sort, cursor: input.cursor as string | undefined };
}
