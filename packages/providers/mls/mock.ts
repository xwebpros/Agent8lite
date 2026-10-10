import fixtures from "../../../blueprint/fixtures/synthetic-listings.json";
import type {
  CanonicalListing,
  Capabilities,
  ChangePage,
  FeedContext,
  ListingCriteria,
  MediaDescriptor,
  MlsPolicy,
  SearchPage,
  SourceChange,
} from "./port";

export const SYNTHETIC_BANNER = fixtures.banner;
export const MOCK_CLOCK = new Date(fixtures.clock);
export const mockPolicy: MlsPolicy = {
  approvalState: "approved",
  rights: {
    display: "allowed",
    replicate: "allowed",
    cache: "denied",
    storeMedia: "denied",
    alerts: "denied",
    aiUse: "denied",
  },
  allowedFields: [
    "address",
    "coordinates",
    "listPrice",
    "bedrooms",
    "bathrooms",
    "area",
    "status",
    "publicRemarks",
  ],
  addressRule: "listing_specific",
  locationRule: "listing_specific",
  maxDataAgeSeconds: 86400,
  maxCacheAgeSeconds: 0,
  retentionDays: 1,
  attributionText: SYNTHETIC_BANNER,
  attributionLogoAssetId: null,
  disclaimerVersion: "synthetic-v1",
};

export function displayProjection(
  listing: CanonicalListing,
  policy: MlsPolicy,
  now: Date,
): CanonicalListing | null {
  if (
    !Number.isFinite(now.getTime()) ||
    policy.approvalState !== "approved" ||
    policy.rights.display !== "allowed" ||
    !Number.isFinite(policy.maxDataAgeSeconds) ||
    policy.maxDataAgeSeconds === null ||
    policy.maxDataAgeSeconds <= 0 ||
    !listing.displayAllowed ||
    !["active", "pending"].includes(listing.status) ||
    !Number.isFinite(new Date(listing.expiresAt).getTime()) ||
    new Date(listing.expiresAt) <= now ||
    !Number.isFinite(new Date(listing.ingestedAt).getTime()) ||
    new Date(listing.ingestedAt) > now ||
    now.getTime() - new Date(listing.ingestedAt).getTime() > policy.maxDataAgeSeconds * 1000
  )
    return null;
  const has = (field: string) => policy.allowedFields.includes(field);
  const address = listing.addressAllowed && policy.addressRule !== "hidden" && has("address");
  // Coarse projection needs an explicit, reviewed rounding scheme. Until then,
  // omit coordinates rather than leak exact coordinates under coarse rights.
  const coordinates =
    address && ["exact", "listing_specific"].includes(policy.locationRule) && has("coordinates");
  return {
    ...listing,
    address: address ? listing.address : null,
    coordinates: coordinates ? listing.coordinates : null,
    listPrice: has("listPrice") ? listing.listPrice : null,
    bedrooms: has("bedrooms") ? listing.bedrooms : null,
    bathrooms: has("bathrooms") ? listing.bathrooms : null,
    area: has("area") ? listing.area : null,
    publicRemarks: has("publicRemarks") ? listing.publicRemarks : null,
    addressAllowed: address,
  };
}

export function validateCriteria(input: ListingCriteria): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_FILTER");
  const keys = [
    "feedIds",
    "status",
    "priceMin",
    "priceMax",
    "bedroomsMin",
    "bathroomsMin",
    "propertyTypes",
    "bbox",
    "q",
  ];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("UNSUPPORTED_FILTER");
  for (const value of [input.priceMin, input.priceMax, input.bedroomsMin, input.bathroomsMin])
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("INVALID_FILTER");
  if (input.priceMin !== undefined && input.priceMax !== undefined && input.priceMin > input.priceMax)
    throw new Error("INVALID_PRICE_RANGE");
  if (input.q !== undefined && typeof input.q !== "string") throw new Error("INVALID_FILTER");
  if (input.q && input.q.length > 200) throw new Error("QUERY_TOO_LONG");
  for (const list of [input.feedIds, input.status, input.propertyTypes])
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.length > 100 ||
        list.some((value) => typeof value !== "string" || !value || value.length > 200))
    )
      throw new Error("INVALID_FILTER");
  if (input.status?.some((value) => !["active", "pending", "closed", "off_market"].includes(value)))
    throw new Error("INVALID_FILTER");
  if (input.bbox !== undefined) {
    if (!Array.isArray(input.bbox)) throw new Error("INVALID_BBOX");
    const [w, s, e, n] = input.bbox;
    if (
      !Array.isArray(input.bbox) ||
      input.bbox.length !== 4 ||
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
      throw new Error("INVALID_BBOX");
  }
}

export class MockMlsAdapter {
  readonly providerCode = "mock-synthetic";
  readonly mode = "replication" as const;
  private readonly listings = new Map<string, CanonicalListing>();
  private readonly changes: SourceChange[] = [];
  constructor(
    private readonly now: () => Date = () => MOCK_CLOCK,
    private readonly policy: () => MlsPolicy = () => mockPolicy,
  ) {
    for (const item of fixtures.listings) {
      const listing: CanonicalListing = {
        ...item,
        status: item.status as CanonicalListing["status"],
        area: { ...item.area, unit: "sqft" },
        coordinates: item.coordinates as [number, number] | null,
        propertyType: "sample residential",
      };
      if (!listing.synthetic) throw new Error("MOCK_REQUIRES_SYNTHETIC");
      this.listings.set(listing.sourceListingKey, listing);
      this.changes.push({ kind: "upsert", sourceListingKey: listing.sourceListingKey, listing });
    }
  }
  private context(context: FeedContext): void {
    if (!context.organizationId || !context.feedId || !context.policyVersion)
      throw new Error("VERIFIED_FEED_REQUIRED");
  }
  private requireReplication(): void {
    const policy = this.policy();
    if (policy.approvalState !== "approved" || policy.rights.replicate !== "allowed")
      throw new Error("REPLICATION_POLICY_DENIED");
  }
  async capabilities(context: FeedContext): Promise<Capabilities> {
    this.context(context);
    return {
      mode: "replication",
      reso: null,
      supports: {
        incremental: true,
        deletions: true,
        search: true,
        maps: true,
        savedSearches: true,
        alerts: false,
        openHouses: false,
        inquiryWebhook: false,
      },
      media: "none",
      rate: { requestsPerMinute: 60, maxPageSize: 100 },
    };
  }
  async health(context: FeedContext) {
    this.context(context);
    return { state: "ready" as const, lastSuccessAt: this.now().toISOString() };
  }
  async search(
    context: FeedContext,
    criteria: ListingCriteria,
    cursor: string | null = null,
  ): Promise<SearchPage> {
    this.context(context);
    validateCriteria(criteria);
    if (cursor) throw new Error("SEARCH_CURSOR_UNSUPPORTED");
    const items = [...this.listings.values()]
      .map((item) => displayProjection(item, this.policy(), this.now()))
      .filter((item): item is CanonicalListing => !!item)
      .filter(
        (item) =>
          (!criteria.status ||
            criteria.status.includes(item.status as "active" | "pending" | "closed" | "off_market")) &&
          (criteria.priceMin === undefined ||
            (item.listPrice !== null && item.listPrice >= criteria.priceMin)) &&
          (criteria.priceMax === undefined ||
            (item.listPrice !== null && item.listPrice <= criteria.priceMax)) &&
          (criteria.bedroomsMin === undefined ||
            (item.bedrooms !== null && item.bedrooms >= criteria.bedroomsMin)) &&
          (criteria.bathroomsMin === undefined ||
            (item.bathrooms !== null && item.bathrooms >= criteria.bathroomsMin)) &&
          (!criteria.propertyTypes ||
            (item.propertyType !== null && criteria.propertyTypes.includes(item.propertyType))) &&
          (!criteria.feedIds || criteria.feedIds.includes(context.feedId)) &&
          (!criteria.q ||
            `${item.address ?? ""} ${item.publicRemarks ?? ""}`
              .toLowerCase()
              .includes(criteria.q.toLowerCase())) &&
          (!criteria.bbox ||
            (item.coordinates !== null &&
              item.coordinates[0] >= criteria.bbox[0] &&
              item.coordinates[0] <= criteria.bbox[2] &&
              item.coordinates[1] >= criteria.bbox[1] &&
              item.coordinates[1] <= criteria.bbox[3])),
      );
    return { items: structuredClone(items), nextOpaqueCursor: null, asOf: this.now().toISOString() };
  }
  async getListing(context: FeedContext, key: string) {
    this.context(context);
    const item = this.listings.get(key);
    return item ? structuredClone(displayProjection(item, this.policy(), this.now())) : null;
  }
  async readChanges(
    context: FeedContext,
    input: { cursor: string | null; watermark: string | null; overlapSeconds: number; limit: number },
  ): Promise<ChangePage> {
    this.context(context);
    this.requireReplication();
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isFinite(input.overlapSeconds) ||
      input.overlapSeconds < 0
    )
      throw new Error("INVALID_PAGE");
    const offset = input.cursor === null ? 0 : Number(input.cursor.replace(/^mock:/, ""));
    if (
      input.cursor !== null &&
      (!/^mock:\d+$/.test(input.cursor) || !Number.isInteger(offset) || offset > this.changes.length)
    )
      throw new Error("INVALID_CURSOR");
    const changes = this.changes.slice(offset, offset + input.limit);
    const more = offset + changes.length < this.changes.length;
    return {
      changes: structuredClone(changes),
      nextOpaqueCursor: more ? `mock:${offset + changes.length}` : null,
      completedWatermark: more ? null : this.now().toISOString(),
    };
  }
  async readMedia(context: FeedContext, _key: string): Promise<readonly MediaDescriptor[]> {
    this.context(context);
    return [];
  }
  withdraw(key: string): void {
    this.listings.delete(key);
    this.changes.push({ kind: "delete", sourceListingKey: key });
  }
}
