// This is the approved public normalized model. Metadata may expose more MLS
// fields, but fields are not returned unless they are explicitly listed here.
export const PUBLIC_PROPERTY_FIELDS = [
  "ListingKey",
  "ListingId",
  "StandardStatus",
  "ListPrice",
  "UnparsedAddress",
  "City",
  "StateOrProvince",
  "PostalCode",
  "BedroomsTotal",
  "BathroomsTotalInteger",
  "LivingArea",
  "YearBuilt",
  "Latitude",
  "Longitude",
  "PublicRemarks",
  "PropertyType",
  "PropertySubType",
  "LotSizeSquareFeet",
  "LotSizeArea",
  "AssociationFee",
  "AssociationFeeFrequency",
  "GarageSpaces",
  "GarageYN",
  "PoolFeatures",
  "PoolPrivateYN",
  "Stories",
  "StoriesTotal",
  "CommunityFeatures",
  "InteriorFeatures",
  "ExteriorFeatures",
  "Heating",
  "Cooling",
  "Flooring",
  "Appliances",
  "View",
  "ParkingFeatures",
  "ListOfficeName",
  "ListOfficeEmail",
  "ListOfficePhone",
  "ListAgentFullName",
  "ModificationTimestamp",
].join(",");

export const MEDIA_SELECT = "MediaURL,Order,MediaCategory";

type RawRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const normalized = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function mapProperty(raw: RawRecord) {
  const media = Array.isArray(raw["Media"]) ? raw["Media"] : [];
  const photos = media
    .map((item) => (item && typeof item === "object" ? asString((item as RawRecord)["MediaURL"]) : undefined))
    .filter((url): url is string => Boolean(url));

  return {
    listingKey: asString(raw["ListingKey"]) ?? "",
    listingId: asString(raw["ListingId"]),
    status: asString(raw["StandardStatus"]),
    price: asNumber(raw["ListPrice"]),
    streetAddress: asString(raw["UnparsedAddress"]),
    city: asString(raw["City"]),
    state: asString(raw["StateOrProvince"]),
    postalCode: asString(raw["PostalCode"]),
    bedrooms: asNumber(raw["BedroomsTotal"]),
    bathrooms: asNumber(raw["BathroomsTotalInteger"]),
    livingArea: asNumber(raw["LivingArea"]),
    yearBuilt: asNumber(raw["YearBuilt"]),
    latitude: asNumber(raw["Latitude"]),
    longitude: asNumber(raw["Longitude"]),
    publicRemarks: asString(raw["PublicRemarks"]),
    propertyType: asString(raw["PropertyType"]),
    propertySubType: asString(raw["PropertySubType"]),
    lotSizeSquareFeet: asNumber(raw["LotSizeSquareFeet"]),
    lotSizeArea: asNumber(raw["LotSizeArea"]),
    hoaFee: asNumber(raw["AssociationFee"]),
    hoaFeeFrequency: asString(raw["AssociationFeeFrequency"]),
    garageSpaces: asNumber(raw["GarageSpaces"]),
    garageYN: asBoolean(raw["GarageYN"]),
    poolFeatures: asStringArray(raw["PoolFeatures"]),
    poolPrivateYN: asBoolean(raw["PoolPrivateYN"]),
    stories: asNumber(raw["Stories"]),
    storiesTotal: asNumber(raw["StoriesTotal"]),
    communityFeatures: asStringArray(raw["CommunityFeatures"]),
    interiorFeatures: asStringArray(raw["InteriorFeatures"]),
    exteriorFeatures: asStringArray(raw["ExteriorFeatures"]),
    heating: asStringArray(raw["Heating"]),
    cooling: asStringArray(raw["Cooling"]),
    flooring: asStringArray(raw["Flooring"]),
    appliances: asStringArray(raw["Appliances"]),
    view: asStringArray(raw["View"]),
    parkingFeatures: asStringArray(raw["ParkingFeatures"]),
    listingOffice: asString(raw["ListOfficeName"]),
    listingOfficeEmail: asString(raw["ListOfficeEmail"]),
    listingOfficePhone: asString(raw["ListOfficePhone"]),
    listingAgent: asString(raw["ListAgentFullName"]),
    modificationTimestamp: asString(raw["ModificationTimestamp"]),
    photos,
  };
}
