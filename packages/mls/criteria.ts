import { isListingCriteria, type Listing, type ListingCriteria, MlsReadError } from "./contracts";

export function normalizeListingCriteria(input: unknown): ListingCriteria {
  if (!isListingCriteria(input))
    throw new MlsReadError(422, "filter_invalid", "Listing filters do not match the v1 contract.");
  if (input.priceMin !== undefined && input.priceMax !== undefined && input.priceMin > input.priceMax)
    throw new MlsReadError(422, "filter_invalid", "The minimum price exceeds the maximum price.");
  if (input.bbox) {
    const [w, s, e, n] = input.bbox;
    if (
      input.bbox.some((value) => !Number.isFinite(value)) ||
      w >= e ||
      s >= n ||
      w < -180 ||
      e > 180 ||
      s < -90 ||
      n > 90 ||
      e - w > 5 ||
      n - s > 5
    )
      throw new MlsReadError(422, "filter_invalid", "The bounding box is invalid or too broad.");
  }
  const result: ListingCriteria = {};
  for (const key of ["priceMin", "priceMax", "bedroomsMin", "bathroomsMin"] as const) {
    const value = input[key];
    if (value !== undefined) {
      if (!Number.isFinite(value)) throw new MlsReadError(422, "filter_invalid", "Invalid numeric filter.");
      result[key] = value;
    }
  }
  for (const key of ["feedIds", "status", "propertyTypes"] as const) {
    if (input[key] !== undefined) Object.assign(result, { [key]: [...new Set(input[key])].sort() });
  }
  if (input.bbox) result.bbox = [...input.bbox];
  // Preserve whitespace semantics of the existing mock provider, normalize casing for cursor binding.
  if (input.q) result.q = input.q.toLowerCase();
  return result;
}

/** All filters run on permitted fields, including keywords and spatial predicates. */
export function matchesListingCriteria(item: Listing, criteria: ListingCriteria): boolean {
  return (
    (!criteria.feedIds || criteria.feedIds.includes(item.feedId)) &&
    (!criteria.status || criteria.status.includes(item.status)) &&
    (criteria.priceMin === undefined || (item.listPrice != null && item.listPrice >= criteria.priceMin)) &&
    (criteria.priceMax === undefined || (item.listPrice != null && item.listPrice <= criteria.priceMax)) &&
    (criteria.bedroomsMin === undefined ||
      (item.bedrooms != null && item.bedrooms >= criteria.bedroomsMin)) &&
    (criteria.bathroomsMin === undefined ||
      (item.bathrooms != null && item.bathrooms >= criteria.bathroomsMin)) &&
    (!criteria.propertyTypes ||
      (item.propertyType != null && criteria.propertyTypes.includes(item.propertyType))) &&
    (!criteria.q ||
      `${item.displayAddress ?? ""} ${item.remarks ?? ""}`.toLowerCase().includes(criteria.q)) &&
    (!criteria.bbox ||
      (item.longitude != null &&
        item.latitude != null &&
        item.longitude >= criteria.bbox[0] &&
        item.longitude <= criteria.bbox[2] &&
        item.latitude >= criteria.bbox[1] &&
        item.latitude <= criteria.bbox[3]))
  );
}
