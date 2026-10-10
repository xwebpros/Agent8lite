import type { MlsPolicy } from "../providers/mls/port";
import { isDisplayPolicy, isListing, isUuid, type Listing } from "./contracts";
import type { NativeMockFeed, NativeMockListing } from "./types";

export const SYNTHETIC_DEMO_LABEL = "SYNTHETIC DEMO DATA — not actual MLS listings";
const rights = ["display", "replicate", "cache", "storeMedia", "alerts", "aiUse"] as const;
const permissionStates = ["allowed", "denied", "unknown"];
const policyKeys = [
  "approvalState",
  "rights",
  "allowedFields",
  "addressRule",
  "locationRule",
  "maxDataAgeSeconds",
  "maxCacheAgeSeconds",
  "retentionDays",
  "attributionText",
  "attributionLogoAssetId",
  "disclaimerVersion",
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const knownString = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value);
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const nonnegativeOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);

/** Invalid or unresolved policy data never acquires rights through defaults. */
export function isNativeRights(value: unknown): value is MlsPolicy {
  return (
    record(value) &&
    Object.keys(value).length === policyKeys.length &&
    Object.keys(value).every((key) => policyKeys.includes(key)) &&
    knownString(value.approvalState, ["unapproved", "approved", "revoked"]) &&
    record(value.rights) &&
    Object.keys(value.rights).length === rights.length &&
    rights.every((key) => knownString((value.rights as Record<string, unknown>)[key], permissionStates)) &&
    Array.isArray(value.allowedFields) &&
    value.allowedFields.length <= 100 &&
    value.allowedFields.every((field) => boundedText(field, 80)) &&
    knownString(value.addressRule, ["visible", "hidden", "listing_specific"]) &&
    knownString(value.locationRule, ["exact", "coarse", "hidden", "listing_specific"]) &&
    nonnegativeOrNull(value.maxDataAgeSeconds) &&
    nonnegativeOrNull(value.maxCacheAgeSeconds) &&
    nonnegativeOrNull(value.retentionDays) &&
    boundedText(value.attributionText, 2000) &&
    (value.attributionLogoAssetId === null || boundedText(value.attributionLogoAssetId, 200)) &&
    boundedText(value.disclaimerVersion, 200)
  );
}

/** Pure projection: the repository must supply current rows and rights for each read. */
export function projectNativeMockListing(
  native: NativeMockListing,
  feed: NativeMockFeed,
  now: Date,
): Listing | null {
  const time = now.getTime();
  const listing = native.canonical;
  if (
    !Number.isFinite(time) ||
    !isUuid(native.tenantId) ||
    !isUuid(native.id) ||
    !isUuid(native.feedId) ||
    native.tenantId !== feed.tenantId ||
    native.feedId !== feed.id ||
    native.withdrawnAt !== null ||
    !Number.isSafeInteger(native.revision) ||
    native.revision < 1 ||
    !Number.isSafeInteger(feed.revision) ||
    feed.revision < 1 ||
    feed.mode !== "mock" ||
    feed.transport !== "mock" ||
    feed.providerCode !== "mock-synthetic" ||
    feed.state !== "ready" ||
    !isDisplayPolicy(feed.displayPolicy) ||
    !isNativeRights(feed.nativeRights)
  )
    return null;
  const policy = feed.displayPolicy;
  const nativeRights = feed.nativeRights;
  const has = (field: string) =>
    nativeRights.allowedFields.includes(field) && policy.displayFields.includes(field);
  const ingested = Date.parse(listing.ingestedAt);
  const expires = Date.parse(listing.expiresAt);
  if (
    !policy.approved ||
    nativeRights.approvalState !== "approved" ||
    nativeRights.rights.display !== "allowed" ||
    nativeRights.maxDataAgeSeconds === null ||
    nativeRights.maxDataAgeSeconds <= 0 ||
    !has("status") ||
    !["active", "pending"].includes(listing.status) ||
    !policy.allowedStatuses.includes(listing.status as "active" | "pending") ||
    listing.synthetic !== true ||
    typeof listing.sourceListingKey !== "string" ||
    !listing.sourceListingKey.startsWith("SYNTHETIC-") ||
    listing.displayAllowed !== true ||
    !Number.isFinite(ingested) ||
    ingested > time ||
    !Number.isFinite(expires)
  )
    return null;
  const effectiveExpiry = Math.min(
    expires,
    ingested + Math.min(policy.maxStaleSeconds, nativeRights.maxDataAgeSeconds) * 1000,
  );
  if (effectiveExpiry <= time) return null;
  const showAddress =
    has("address") && listing.addressAllowed === true && nativeRights.addressRule !== "hidden";
  const coordinates =
    showAddress && has("coordinates") && ["exact", "listing_specific"].includes(nativeRights.locationRule)
      ? listing.coordinates
      : null;
  // Empty attribution fields do not substitute an invented real brokerage/agent.
  const disclaimer = [SYNTHETIC_DEMO_LABEL, policy.attributionText, nativeRights.attributionText];
  if (has("attribution.disclaimer")) disclaimer.push(listing.attribution.disclaimer);
  const projected: Listing = {
    id: native.id,
    feedId: native.feedId,
    sourceListingId: has("sourceListingId") ? native.sourceListingId : null,
    status: listing.status as "active" | "pending",
    listPrice: has("listPrice") ? listing.listPrice : null,
    currency: native.currency,
    displayAddress: showAddress ? listing.address : null,
    longitude: coordinates ? coordinates[0] : null,
    latitude: coordinates ? coordinates[1] : null,
    bedrooms: has("bedrooms") ? listing.bedrooms : null,
    bathrooms: has("bathrooms") ? listing.bathrooms : null,
    livingAreaSqft: has("area") && listing.area?.unit === "sqft" ? listing.area.value : null,
    propertyType: has("propertyType") ? listing.propertyType : null,
    remarks: has("publicRemarks") ? listing.publicRemarks : null,
    media: [],
    attribution: {
      brokerageName: has("attribution.brokerage") ? (listing.attribution.brokerage ?? "") : "",
      agentName: has("attribution.agent") ? listing.attribution.agent : null,
      ...(has("attribution.contact") && listing.attribution.contact !== undefined
        ? { contact: listing.attribution.contact === null ? null : { ...listing.attribution.contact } }
        : {}),
      disclaimer: [...new Set(disclaimer.filter(Boolean))].join(" | "),
      logoUrl: null,
    },
    synthetic: true,
    sourceUpdatedAt: has("sourceModifiedAt") ? listing.sourceModifiedAt : null,
    expiresAt: new Date(effectiveExpiry).toISOString(),
  };
  // Bad source values and oversized attribution fail closed; do not silently truncate policy text.
  return isListing(projected) ? projected : null;
}
