import type { CanonicalListing, FeedContext } from "../providers/mls/port";
import { isUuid } from "./contracts";

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
export const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const nullableText = (value: unknown, max: number) =>
  value === null || (typeof value === "string" && value.length <= max);
const numberOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
export const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** Mock checkpoints use UTC timestamps; no overlap arithmetic or source-time filtering. */
export function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return false;
  const time = Date.parse(value);
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z")
  );
}

export function isReplicationContext(value: unknown): value is FeedContext {
  return (
    record(value) &&
    closed(value, ["organizationId", "feedId", "policyVersion"]) &&
    isUuid(value.organizationId) &&
    isUuid(value.feedId) &&
    text(value.policyVersion, 200) &&
    value.policyVersion.trim().length > 0
  );
}

const listingKeys = [
  "sourceListingKey",
  "sourceStatus",
  "status",
  "sourceModifiedAt",
  "ingestedAt",
  "expiresAt",
  "listPrice",
  "bedrooms",
  "bathrooms",
  "area",
  "address",
  "coordinates",
  "publicRemarks",
  "propertyType",
  "displayAllowed",
  "addressAllowed",
  "attribution",
  "synthetic",
];

/** Reject an entire page rather than carry extra/private provider fields into persistence. */
export function isSyntheticCanonical(value: unknown): value is CanonicalListing {
  if (!record(value) || !closed(value, listingKeys)) return false;
  const coordinates = value.coordinates;
  const area = value.area;
  const attribution = value.attribution;
  return (
    text(value.sourceListingKey, 200) &&
    value.sourceListingKey.startsWith("SYNTHETIC-") &&
    text(value.sourceStatus, 100) &&
    ["active", "pending", "closed", "off_market", "unknown"].includes(value.status as string) &&
    (value.sourceModifiedAt === null || timestamp(value.sourceModifiedAt)) &&
    timestamp(value.ingestedAt) &&
    timestamp(value.expiresAt) &&
    numberOrNull(value.listPrice) &&
    numberOrNull(value.bedrooms) &&
    numberOrNull(value.bathrooms) &&
    (area === null ||
      (record(area) &&
        closed(area, ["value", "unit"]) &&
        area.value !== null &&
        numberOrNull(area.value) &&
        ["sqft", "sqm"].includes(area.unit as string))) &&
    nullableText(value.address, 500) &&
    (coordinates === null ||
      (Array.isArray(coordinates) &&
        coordinates.length === 2 &&
        coordinates.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate)) &&
        Math.abs(coordinates[0]) <= 180 &&
        Math.abs(coordinates[1]) <= 90)) &&
    nullableText(value.publicRemarks, 20000) &&
    nullableText(value.propertyType, 100) &&
    typeof value.displayAllowed === "boolean" &&
    typeof value.addressAllowed === "boolean" &&
    record(attribution) &&
    closed(attribution, ["brokerage", "agent", "disclaimer"]) &&
    nullableText(attribution.brokerage, 200) &&
    nullableText(attribution.agent, 200) &&
    text(attribution.disclaimer, 2000) &&
    value.synthetic === true
  );
}

/** The existing mock spreads four synthetic fixture labels beyond its canonical port type. */
export function normalizeSyntheticCanonical(value: unknown): CanonicalListing | null {
  if (!record(value)) return null;
  const fixtureKeys = ["id", "name", "fixtureCase", "media"];
  if (Object.keys(value).some((key) => !listingKeys.includes(key) && !fixtureKeys.includes(key))) return null;
  if (
    ("id" in value && !isUuid(value.id)) ||
    ("name" in value && !text(value.name, 200)) ||
    ("fixtureCase" in value && !text(value.fixtureCase, 100)) ||
    ("media" in value && (!Array.isArray(value.media) || value.media.length !== 0))
  )
    return null;
  const canonical = Object.fromEntries(
    listingKeys.filter((key) => key in value).map((key) => [key, value[key]]),
  );
  return isSyntheticCanonical(canonical) ? canonical : null;
}
