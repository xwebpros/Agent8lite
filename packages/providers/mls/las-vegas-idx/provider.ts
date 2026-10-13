import type { components } from "../../../contracts/generated/api";
import type {
  IdxTemplateProvider,
  IdxTemplateProviderBinding,
  IdxTemplateQuery,
} from "../../../contracts/internal/idx-template-provider";
import { AccessError } from "../../../db/tenant-transaction";

type Listing = components["schemas"]["IdxTemplateListing"];
type ReadCurrent = () => Promise<Listing[]>;
const numericFilters = {
  minPrice: ["price", true],
  maxPrice: ["price", false],
  beds: ["bedrooms", true],
  baths: ["bathrooms", true],
  minSqft: ["livingArea", true],
  maxSqft: ["livingArea", false],
  minYearBuilt: ["yearBuilt", true],
  maxYearBuilt: ["yearBuilt", false],
  minGarageSpaces: ["garageSpaces", true],
  minLotSizeSqft: ["lotSizeSquareFeet", true],
  minLatitude: ["latitude", true],
  maxLatitude: ["latitude", false],
  minLongitude: ["longitude", true],
  maxLongitude: ["longitude", false],
} as const;
function matches(listing: Listing, query: IdxTemplateQuery) {
  for (const [name, [field, minimum]] of Object.entries(numericFilters)) {
    const value = query[name as keyof IdxTemplateQuery];
    const actual = listing[field];
    if (
      typeof value === "number" &&
      (typeof actual !== "number" || (minimum ? actual < value : actual > value))
    )
      return false;
  }
  for (const [name, field] of [
    ["city", "city"],
    ["zip", "postalCode"],
    ["propertyType", "propertyType"],
    ["propertySubType", "propertySubType"],
  ] as const)
    if (query[name] && listing[field]?.toLowerCase() !== query[name]?.toLowerCase()) return false;
  if (listing.status !== (query.status ?? "Active")) return false;
  if (query.address && !listing.streetAddress?.toLowerCase().includes(query.address.trim().toLowerCase()))
    return false;
  if (
    query.pool &&
    listing.poolPrivateYN !== true &&
    !listing.poolFeatures?.some((value) => value !== "None")
  )
    return false;
  if (query.singleStory && listing.stories !== 1 && listing.storiesTotal !== 1) return false;
  if (query.hoa && !(typeof listing.hoaFee === "number" && listing.hoaFee > 0)) return false;
  if (query.gated && !listing.communityFeatures?.includes("Gated")) return false;
  return true;
}
export function createMockIdxTemplateProvider(
  binding: IdxTemplateProviderBinding,
  assertCurrent: () => Promise<void>,
  readCurrent: ReadCurrent,
): IdxTemplateProvider {
  const deadline = (rows: Listing[]) =>
    new Date(
      Math.min(
        Date.now() + 60_000,
        Date.parse(binding.expiresAt),
        Date.parse(binding.policyExpiresAt),
        ...rows.map((row) => Date.parse(row.expiresAt)),
      ),
    ).toISOString();
  const current = async () => {
    await assertCurrent();
    const rows = await readCurrent();
    await assertCurrent();
    const now = Date.now();
    if (rows.some((row) => row.synthetic !== true))
      throw new AccessError(503, "idx_mock_source_invalid", "Synthetic preview data is unavailable.");
    return rows.filter((row) => Date.parse(row.expiresAt) > now);
  };
  return {
    async status() {
      const rows = await current();
      return {
        configured: true,
        authenticated: true,
        metadata: true,
        property: rows.length > 0,
        media: rows.some((row) => row.photos.length > 0),
        live: false,
        synthetic: true,
        message: "SYNTHETIC PREVIEW — not live MLS data",
      };
    },
    async search(query) {
      const rows = (await current()).filter((row) => matches(row, query));
      rows.sort((a, b) =>
        query.sort === "price-asc"
          ? (a.price ?? Infinity) - (b.price ?? Infinity) || a.listingKey.localeCompare(b.listingKey)
          : query.sort === "price-desc"
            ? (b.price ?? -Infinity) - (a.price ?? -Infinity) || a.listingKey.localeCompare(b.listingKey)
            : (b.modificationTimestamp ?? "").localeCompare(a.modificationTimestamp ?? "") ||
              a.listingKey.localeCompare(b.listingKey),
      );
      const page = query.page ?? 1;
      const start = (page - 1) * 24;
      return {
        items: rows.slice(start, start + 24),
        page,
        pageSize: 24,
        hasMore: rows.length > start + 24,
        live: false,
        synthetic: true,
        expiresAt: deadline(rows),
      };
    },
    async detail(key) {
      const row = (await current()).find((item) => item.listingKey === key);
      if (!row) throw new AccessError(404, "idx_listing_unavailable", "This property is unavailable.");
      return row;
    },
  };
}
/** Activation is a separate reviewed M6 decision, never a consequence of importing a template. */
export function createUnavailableIdxTemplateProvider(): IdxTemplateProvider {
  const unavailable = async (): Promise<never> => {
    throw new AccessError(
      503,
      "idx_live_activation_pending",
      "The preserved live MLS adapter requires its approved site/feed activation gates.",
    );
  };
  return {
    async status() {
      return {
        configured: false,
        authenticated: false,
        metadata: false,
        property: false,
        media: false,
        live: false,
        synthetic: false,
        message: "MLS activation is unavailable for this site.",
      };
    },
    search: unavailable,
    detail: unavailable,
  };
}
