import type { CanonicalListing, ListingCriteria } from "../port";
import { providedAttributionContact } from "../attribution";
import { instant, safeText, TrestleError } from "./safety";
import type { TrestleFeedAuthorization } from "./types";

export const CONTROL_FIELDS = [
  "ListingKey",
  "OriginatingSystemID",
  "StandardStatus",
  "ModificationTimestamp",
  "InternetEntireListingDisplayYN",
  "InternetAddressDisplayYN",
] as const;
export const FIELD_GROUPS: Readonly<Record<string, readonly string[]>> = {
  listPrice: ["ListPrice"],
  bedrooms: ["BedroomsTotal"],
  bathrooms: ["BathroomsTotalInteger"],
  area: ["LivingArea", "LivingAreaUnits"],
  address: ["UnparsedAddress"],
  coordinates: ["Longitude", "Latitude"],
  publicRemarks: ["PublicRemarks"],
  propertyType: ["PropertyType"],
  brokerage: ["ListOfficeName"],
  agent: ["ListAgentFullName"],
  attributionContact: ["AttributionContact"],
};

export function selectedFields(authorization: TrestleFeedAuthorization): string[] {
  if (CONTROL_FIELDS.some((field) => !authorization.observedPropertyFields.includes(field)))
    throw new TrestleError("TRESTLE_REQUIRED_FIELD_UNVERIFIED");
  if (
    !authorization.policy.allowedFields.includes("brokerage") ||
    !authorization.policy.allowedFields.includes("attributionContact") ||
    !authorization.observedPropertyFields.includes("ListOfficeName") ||
    !authorization.observedPropertyFields.includes("AttributionContact")
  )
    throw new TrestleError("TRESTLE_REQUIRED_ATTRIBUTION_UNVERIFIED");
  const fields: string[] = [...CONTROL_FIELDS];
  for (const field of authorization.policy.allowedFields) {
    for (const source of FIELD_GROUPS[field] ?? [])
      if (authorization.observedPropertyFields.includes(source)) fields.push(source);
  }
  return [...new Set(fields)];
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function mapTrestleListing(
  value: unknown,
  authorization: TrestleFeedAuthorization,
  now: Date,
): CanonicalListing | null {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TrestleError("TRESTLE_BAD_PROPERTY_RESPONSE");
  const row = value as Record<string, unknown>;
  const key = safeText(row.ListingKey);
  if (!key || row.synthetic === true || /^SYNTHETIC-/i.test(key))
    throw new TrestleError("TRESTLE_UNTRUSTED_SOURCE_RECORD");
  if (
    typeof row.OriginatingSystemID !== "string" ||
    !authorization.originatingSystemIds.includes(row.OriginatingSystemID)
  )
    throw new TrestleError("TRESTLE_SOURCE_SCOPE_DENIED");
  const status =
    row.StandardStatus === "Active"
      ? "active"
      : row.StandardStatus === "Pending" || row.StandardStatus === "ActiveUnderContract"
        ? "pending"
        : null;
  if (!status || row.InternetEntireListingDisplayYN !== true) return null;
  const modified =
    typeof row.ModificationTimestamp === "string" ? instant(row.ModificationTimestamp) : Number.NaN;
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(modified) || modified > now.getTime())
    throw new TrestleError("TRESTLE_SOURCE_TIME_INVALID");
  const policy = authorization.policy;
  const selected = selectedFields(authorization);
  const allowed = (canonical: string) =>
    policy.allowedFields.includes(canonical) &&
    (FIELD_GROUPS[canonical] ?? []).every((source) => selected.includes(source));
  const addressAllowed =
    row.InternetAddressDisplayYN === true &&
    ["visible", "listing_specific"].includes(policy.addressRule) &&
    allowed("address");
  const exact =
    addressAllowed && ["exact", "listing_specific"].includes(policy.locationRule) && allowed("coordinates");
  const coordinates: readonly [number, number] | null =
    exact &&
    typeof row.Longitude === "number" &&
    typeof row.Latitude === "number" &&
    Number.isFinite(row.Longitude) &&
    Number.isFinite(row.Latitude) &&
    row.Longitude >= -180 &&
    row.Longitude <= 180 &&
    row.Latitude >= -90 &&
    row.Latitude <= 90
      ? [row.Longitude, row.Latitude]
      : null;
  const area = allowed("area") ? finite(row.LivingArea) : null;
  const areaUnit =
    row.LivingAreaUnits === "SquareFeet" ? "sqft" : row.LivingAreaUnits === "SquareMeters" ? "sqm" : null;
  const brokerage = allowed("brokerage") ? safeText(row.ListOfficeName, 200) : null;
  const contact = allowed("attributionContact") ? providedAttributionContact(row.AttributionContact) : null;
  if (!brokerage?.trim() || !contact) return null;
  return {
    sourceListingKey: key,
    sourceStatus: String(row.StandardStatus),
    status,
    sourceModifiedAt: new Date(modified).toISOString(),
    ingestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (policy.maxDataAgeSeconds ?? 0) * 1000).toISOString(),
    listPrice: allowed("listPrice") ? finite(row.ListPrice) : null,
    bedrooms: allowed("bedrooms") ? finite(row.BedroomsTotal) : null,
    bathrooms: allowed("bathrooms") ? finite(row.BathroomsTotalInteger) : null,
    area: area !== null && areaUnit ? { value: area, unit: areaUnit } : null,
    address: addressAllowed ? safeText(row.UnparsedAddress, 1024) : null,
    coordinates,
    publicRemarks: allowed("publicRemarks") ? safeText(row.PublicRemarks, 8000) : null,
    propertyType: allowed("propertyType") ? safeText(row.PropertyType) : null,
    displayAllowed: true,
    addressAllowed,
    synthetic: false,
    attribution: {
      brokerage,
      agent: allowed("agent") ? safeText(row.ListAgentFullName) : null,
      disclaimer: policy.attributionText,
      contact,
    },
  };
}

export function matchesTrestleCriteria(listing: CanonicalListing, criteria: ListingCriteria): boolean {
  return (
    (!criteria.status || criteria.status.includes(listing.status as "active" | "pending")) &&
    (criteria.priceMin === undefined ||
      (listing.listPrice !== null && listing.listPrice >= criteria.priceMin)) &&
    (criteria.priceMax === undefined ||
      (listing.listPrice !== null && listing.listPrice <= criteria.priceMax)) &&
    (criteria.bedroomsMin === undefined ||
      (listing.bedrooms !== null && listing.bedrooms >= criteria.bedroomsMin)) &&
    (criteria.bathroomsMin === undefined ||
      (listing.bathrooms !== null && listing.bathrooms >= criteria.bathroomsMin)) &&
    (!criteria.propertyTypes ||
      (listing.propertyType !== null && criteria.propertyTypes.includes(listing.propertyType))) &&
    (!criteria.bbox ||
      (listing.coordinates !== null &&
        listing.coordinates[0] >= criteria.bbox[0] &&
        listing.coordinates[0] <= criteria.bbox[2] &&
        listing.coordinates[1] >= criteria.bbox[1] &&
        listing.coordinates[1] <= criteria.bbox[3]))
  );
}
