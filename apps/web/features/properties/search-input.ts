import type { components, operations } from "../../../../packages/contracts/generated/api";

export type PropertyFilters = {
  q: string;
  priceMin: string;
  priceMax: string;
  bedroomsMin: string;
  bathroomsMin: string;
  propertyType: string;
  status: string;
  west: string;
  south: string;
  east: string;
  north: string;
};
export type PropertySort = NonNullable<
  NonNullable<operations["searchPublicListings"]["parameters"]["query"]>["sort"]
>;
export const emptyPropertyFilters: PropertyFilters = {
  q: "",
  priceMin: "",
  priceMax: "",
  bedroomsMin: "",
  bathroomsMin: "",
  propertyType: "",
  status: "",
  west: "",
  south: "",
  east: "",
  north: "",
};
export function propertySearchParams(input: PropertyFilters, sort: PropertySort): URLSearchParams {
  const criteria: components["schemas"]["ListingCriteria"] = {};
  if (input.q.length > 120) throw new Error("Keywords can contain at most 120 characters.");
  if (input.q) criteria.q = input.q;
  for (const field of ["priceMin", "priceMax", "bedroomsMin", "bathroomsMin"] as const) {
    if (input[field] !== "") {
      const value = Number(input[field]);
      if (
        !Number.isFinite(value) ||
        value < 0 ||
        (field === "bedroomsMin" && (!Number.isInteger(value) || value > 100))
      )
        throw new Error("Enter valid nonnegative price, bedroom and bathroom filters.");
      criteria[field] = value;
    }
  }
  if (
    criteria.priceMin !== undefined &&
    criteria.priceMax !== undefined &&
    criteria.priceMin > criteria.priceMax
  )
    throw new Error("The minimum price must not exceed the maximum price.");
  if (input.propertyType) {
    if (input.propertyType.length > 80) throw new Error("Property type is too long.");
    criteria.propertyTypes = [input.propertyType];
  }
  if (input.status) {
    if (!["active", "pending"].includes(input.status))
      throw new Error("Choose a supported synthetic status.");
    criteria.status = [input.status as "active" | "pending"];
  }
  const values = [input.west, input.south, input.east, input.north];
  if (values.some(Boolean)) {
    if (values.some((value) => !value.trim())) throw new Error("Enter all four location bounds.");
    const [w, s, e, n] = values.map(Number);
    if (
      [w, s, e, n].some((value) => !Number.isFinite(value)) ||
      w >= e ||
      s >= n ||
      w < -180 ||
      e > 180 ||
      s < -90 ||
      n > 90 ||
      e - w > 5 ||
      n - s > 5
    )
      throw new Error("Enter valid longitude/latitude bounds spanning at most five degrees.");
    criteria.bbox = [w, s, e, n];
  }
  return new URLSearchParams({ filter: JSON.stringify(criteria), sort, limit: "20" });
}
