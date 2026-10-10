import type { FeedContext, ListingCriteria } from "../port";
import { safeText, TrestleError } from "./safety";
import { selectedFields } from "./trestle.mapper";
import type { TrestleFeedAuthorization } from "./types";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function propertyQuery(
  base: string,
  context: FeedContext,
  criteria: ListingCriteria,
  authorization: TrestleFeedAuthorization,
  pageSize: number,
  listingKey?: string,
): URL {
  if (
    !criteria ||
    typeof criteria !== "object" ||
    Array.isArray(criteria) ||
    Object.keys(criteria).some(
      (key) =>
        ![
          "feedIds",
          "status",
          "priceMin",
          "priceMax",
          "bedroomsMin",
          "bathroomsMin",
          "propertyTypes",
          "bbox",
          "q",
        ].includes(key),
    )
  )
    throw new TrestleError("TRESTLE_INVALID_CRITERIA");
  if (criteria.q !== undefined) throw new TrestleError("TRESTLE_KEYWORD_NOT_IMPLEMENTED");
  if (
    criteria.feedIds !== undefined &&
    (!Array.isArray(criteria.feedIds) ||
      criteria.feedIds.length !== 1 ||
      criteria.feedIds[0] !== context.feedId)
  )
    throw new TrestleError("TRESTLE_SOURCE_SCOPE_DENIED");
  const fields = selectedFields(authorization);
  const requireField = (field: string) => {
    if (!fields.includes(field)) throw new TrestleError("TRESTLE_FILTER_FIELD_DENIED");
  };
  const filters = [
    `(${authorization.originatingSystemIds.map((id) => `OriginatingSystemID eq ${literal(id)}`).join(" or ")})`,
    "InternetEntireListingDisplayYN eq true",
  ];
  const statuses = criteria.status ?? ["active", "pending"];
  if (
    !Array.isArray(statuses) ||
    statuses.length === 0 ||
    statuses.length > 4 ||
    statuses.some((status) => !["active", "pending"].includes(status))
  )
    throw new TrestleError("TRESTLE_STATUS_NOT_SUPPORTED");
  const sourceStatuses = [
    ...new Set(
      statuses.flatMap((status) => (status === "active" ? ["Active"] : ["Pending", "ActiveUnderContract"])),
    ),
  ];
  filters.push(`(${sourceStatuses.map((status) => `StandardStatus eq ${literal(status)}`).join(" or ")})`);
  for (const [key, field, operator] of [
    ["priceMin", "ListPrice", "ge"],
    ["priceMax", "ListPrice", "le"],
    ["bedroomsMin", "BedroomsTotal", "ge"],
    ["bathroomsMin", "BathroomsTotalInteger", "ge"],
  ] as const) {
    const value = criteria[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12)
      throw new TrestleError("TRESTLE_INVALID_CRITERIA");
    requireField(field);
    filters.push(`${field} ${operator} ${value}`);
  }
  if (
    criteria.priceMin !== undefined &&
    criteria.priceMax !== undefined &&
    criteria.priceMin > criteria.priceMax
  )
    throw new TrestleError("TRESTLE_INVALID_CRITERIA");
  if (criteria.propertyTypes !== undefined) {
    if (
      !Array.isArray(criteria.propertyTypes) ||
      criteria.propertyTypes.length === 0 ||
      criteria.propertyTypes.length > 20 ||
      criteria.propertyTypes.some((type) => !safeText(type))
    )
      throw new TrestleError("TRESTLE_INVALID_CRITERIA");
    requireField("PropertyType");
    filters.push(
      `(${criteria.propertyTypes.map((type) => `PropertyType eq ${literal(type)}`).join(" or ")})`,
    );
  }
  if (criteria.bbox !== undefined) {
    const box = criteria.bbox;
    if (
      !Array.isArray(box) ||
      box.length !== 4 ||
      box.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      box[0] < -180 ||
      box[2] > 180 ||
      box[1] < -90 ||
      box[3] > 90 ||
      box[0] >= box[2] ||
      box[1] >= box[3] ||
      box[2] - box[0] > 5 ||
      box[3] - box[1] > 5
    )
      throw new TrestleError("TRESTLE_INVALID_CRITERIA");
    if (
      !["visible", "listing_specific"].includes(authorization.policy.addressRule) ||
      !["exact", "listing_specific"].includes(authorization.policy.locationRule)
    )
      throw new TrestleError("TRESTLE_FILTER_FIELD_DENIED");
    requireField("Longitude");
    requireField("Latitude");
    requireField("UnparsedAddress");
    filters.push(
      "InternetAddressDisplayYN eq true",
      `Longitude ge ${box[0]}`,
      `Longitude le ${box[2]}`,
      `Latitude ge ${box[1]}`,
      `Latitude le ${box[3]}`,
    );
  }
  if (listingKey !== undefined) {
    if (!safeText(listingKey)) throw new TrestleError("TRESTLE_INVALID_LISTING_KEY");
    filters.push(`ListingKey eq ${literal(listingKey)}`);
  }
  const url = new URL("Property", base);
  url.searchParams.set("$filter", filters.join(" and "));
  url.searchParams.set("$select", fields.join(","));
  url.searchParams.set("$top", String(listingKey === undefined ? pageSize : 2));
  url.searchParams.set("$orderby", "ListingKey");
  return url;
}

/** A continuation must preserve the original approved selection and filter. */
export function continuation(value: unknown, query: URL): URL | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 16000)
    throw new TrestleError("TRESTLE_CONTINUATION_DENIED");
  let next: URL;
  try {
    next = new URL(value, query);
  } catch {
    throw new TrestleError("TRESTLE_CONTINUATION_DENIED");
  }
  if (
    next.origin !== query.origin ||
    next.pathname !== query.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    [...next.searchParams.keys()].some(
      (key) => !["$filter", "$select", "$top", "$orderby", "$skip", "$skiptoken"].includes(key),
    ) ||
    [...new Set(next.searchParams.keys())].some((key) => next.searchParams.getAll(key).length !== 1) ||
    ["$filter", "$select", "$top", "$orderby"].some(
      (key) => next.searchParams.get(key) !== query.searchParams.get(key),
    ) ||
    !(next.searchParams.has("$skip") || next.searchParams.has("$skiptoken"))
  )
    throw new TrestleError("TRESTLE_CONTINUATION_DENIED");
  if (next.searchParams.has("$skip") && !/^\d{1,12}$/.test(next.searchParams.get("$skip") ?? ""))
    throw new TrestleError("TRESTLE_CONTINUATION_DENIED");
  if (
    next.href === query.href ||
    (next.searchParams.has("$skip") &&
      Number(next.searchParams.get("$skip")) <= Number(query.searchParams.get("$skip") ?? 0)) ||
    (next.searchParams.has("$skiptoken") &&
      (!safeText(next.searchParams.get("$skiptoken"), 8000) ||
        next.searchParams.get("$skiptoken") === query.searchParams.get("$skiptoken")))
  )
    throw new TrestleError("TRESTLE_CONTINUATION_DENIED");
  return next;
}
