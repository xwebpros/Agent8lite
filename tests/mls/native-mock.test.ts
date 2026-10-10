import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixtures } from "../../packages/db/fixtures";
import {
  getNativeMockListing,
  type ListingCriteria,
  type NativeMockSnapshot,
  normalizeListingCriteria,
  projectNativeMockListing,
  searchNativeMockListings,
} from "../../packages/mls";
import { MOCK_CLOCK, MockMlsAdapter } from "../../packages/providers/mls/mock";
import { assertContract } from "../helpers/api";
import {
  context,
  displayPolicy,
  feedId,
  mockSnapshot,
  nativeRights,
  options,
  providerContext,
} from "./fixtures";

let snapshot: NativeMockSnapshot;
beforeEach(async () => {
  snapshot = await mockSnapshot();
});
const first = () => snapshot.listings[0];
const feed = () => snapshot.feeds[0];
const read = (filter: unknown = {}) =>
  searchNativeMockListings(snapshot, context, { filter, limit: 100 }, options);
const policyFields = (fields: string[]) => ({
  ...feed(),
  nativeRights: { ...nativeRights, allowedFields: fields },
});

describe("W07 native projection — frozen contract and current rights", () => {
  it("builds an explicit synthetic v1 projection without raw provider metadata or media", () => {
    const item = projectNativeMockListing(first(), feed(), options.now)!;
    assertContract("Listing", item);
    expect(item).toMatchObject({
      id: first().id,
      feedId,
      synthetic: true,
      currency: "USD",
      media: [],
      sourceListingId: "SYNTHETIC-VEGAS-001",
    });
    expect(item.attribution.disclaimer).toMatch(/^SYNTHETIC DEMO DATA/);
    expect(item.attribution.logoUrl).toBeNull();
    expect(item.longitude).toBe(first().canonical.coordinates![0]);
    expect(item.latitude).toBe(first().canonical.coordinates![1]);
    for (const key of [
      "sourceListingKey",
      "sourceStatus",
      "displayAllowed",
      "addressAllowed",
      "ingestedAt",
      "name",
      "fixtureCase",
      "coordinates",
      "policy",
      "content_hash",
    ])
      expect(item).not.toHaveProperty(key);
    assertContract("PageListing", read());
  });

  it.each(["unapproved", "revoked"])(
    "denies %s current rights independently of stored projections",
    (approvalState) => {
      expect(
        projectNativeMockListing(
          first(),
          { ...feed(), nativeRights: { ...nativeRights, approvalState } },
          options.now,
        ),
      ).toBeNull();
    },
  );

  it.each(["denied", "unknown", null, "allowed-by-default"])(
    "denies unresolved display right %s",
    (display) => {
      expect(
        projectNativeMockListing(
          first(),
          { ...feed(), nativeRights: { ...nativeRights, rights: { ...nativeRights.rights, display } } },
          options.now,
        ),
      ).toBeNull();
    },
  );

  it.each([
    null,
    {},
    { ...nativeRights, maxDataAgeSeconds: null },
    { ...nativeRights, maxDataAgeSeconds: 0 },
    { ...nativeRights, maxDataAgeSeconds: Number.NaN },
  ])("denies malformed/unresolved policy %j", (rights) => {
    expect(projectNativeMockListing(first(), { ...feed(), nativeRights: rights }, options.now)).toBeNull();
  });

  it("requires both policies to approve status and fields", () => {
    for (const policy of [
      null,
      {},
      { ...displayPolicy, approved: false },
      { ...displayPolicy, allowedStatuses: ["pending"] },
      { ...displayPolicy, displayFields: [] },
    ])
      expect(projectNativeMockListing(first(), { ...feed(), displayPolicy: policy }, options.now)).toBeNull();
    expect(
      projectNativeMockListing(
        first(),
        policyFields(nativeRights.allowedFields.filter((field) => field !== "status")),
        options.now,
      ),
    ).toBeNull();
  });

  it("denies unknown policy keys, rights keys and coerced enum values", () => {
    for (const rights of [
      { ...nativeRights, inventedPermission: "allowed" },
      { ...nativeRights, rights: { ...nativeRights.rights, externalMedia: "allowed" } },
      { ...nativeRights, addressRule: { toString: () => "visible" } },
    ])
      expect(projectNativeMockListing(first(), { ...feed(), nativeRights: rights }, options.now)).toBeNull();
  });

  it.each(["live", "sandbox"])("rejects %s feed separation even with approved policy", (mode) => {
    expect(projectNativeMockListing(first(), { ...feed(), mode }, options.now)).toBeNull();
  });

  it("rejects nonsynthetic, wrong-feed and wrong-tenant records", () => {
    for (const native of [
      { ...first(), canonical: { ...first().canonical, synthetic: false } },
      { ...first(), canonical: { ...first().canonical, sourceListingKey: "REAL-PROPERTY" } },
      { ...first(), tenantId: fixtures.orgB },
      { ...first(), feedId: "a0000000-0000-4000-8000-000000000002" },
    ])
      expect(projectNativeMockListing(native, feed(), options.now)).toBeNull();
  });

  it("masks all nongranted optional fields in either policy and never grants media", () => {
    const item = projectNativeMockListing(first(), policyFields(["status"]), options.now)!;
    assertContract("Listing", item);
    expect(item).toMatchObject({
      sourceListingId: null,
      listPrice: null,
      bedrooms: null,
      bathrooms: null,
      livingAreaSqft: null,
      propertyType: null,
      displayAddress: null,
      longitude: null,
      latitude: null,
      remarks: null,
      sourceUpdatedAt: null,
      media: [],
    });
    expect(item.attribution).toMatchObject({ brokerageName: "", agentName: null, logoUrl: null });
    const other = projectNativeMockListing(
      first(),
      { ...feed(), displayPolicy: { ...displayPolicy, displayFields: ["status"] } },
      options.now,
    )!;
    expect(other).toEqual(item);
    const invented = projectNativeMockListing(
      first(),
      {
        ...feed(),
        nativeRights: {
          ...nativeRights,
          rights: {
            ...nativeRights.rights,
            storeMedia: "allowed",
            cache: "allowed",
            alerts: "allowed",
            aiUse: "allowed",
          },
        },
      },
      options.now,
    )!;
    expect(invented.media).toEqual([]);
  });

  it.each(["hidden", "coarse"])("hides exact coordinates for location rule %s", (locationRule) => {
    const item = projectNativeMockListing(
      first(),
      { ...feed(), nativeRights: { ...nativeRights, locationRule } },
      options.now,
    )!;
    expect(item.displayAddress).toBe(first().canonical.address);
    expect(item.latitude).toBeNull();
    expect(item.longitude).toBeNull();
  });

  it("address suppression hides coordinates even under exact location rights", () => {
    for (const [native, rights] of [
      [first(), { ...nativeRights, addressRule: "hidden", locationRule: "exact" }],
      [{ ...first(), canonical: { ...first().canonical, addressAllowed: false } }, nativeRights],
    ] as const) {
      const item = projectNativeMockListing(native, { ...feed(), nativeRights: rights }, options.now)!;
      expect(item.displayAddress).toBeNull();
      expect(item.latitude).toBeNull();
      expect(item.longitude).toBeNull();
    }
  });

  it("enforces source expiry, stricter age, invalid clocks and future ingestion", () => {
    for (const canonical of [
      { ...first().canonical, expiresAt: MOCK_CLOCK.toISOString() },
      { ...first().canonical, expiresAt: "invalid" },
      { ...first().canonical, ingestedAt: "invalid" },
      { ...first().canonical, ingestedAt: new Date(MOCK_CLOCK.getTime() + 1).toISOString() },
    ])
      expect(projectNativeMockListing({ ...first(), canonical }, feed(), options.now)).toBeNull();
    const tightened = { ...feed(), displayPolicy: { ...displayPolicy, maxStaleSeconds: 60 } };
    const item = projectNativeMockListing(first(), tightened, options.now)!;
    expect(Date.parse(item.expiresAt)).toBe(MOCK_CLOCK.getTime() + 60_000);
    expect(projectNativeMockListing(first(), tightened, new Date(MOCK_CLOCK.getTime() + 60_000))).toBeNull();
    expect(projectNativeMockListing(first(), feed(), new Date("invalid"))).toBeNull();
  });

  it("omits unreviewed area units and fails closed on source values that cannot satisfy v1", () => {
    const item = projectNativeMockListing(
      { ...first(), canonical: { ...first().canonical, area: { value: 100, unit: "sqm" } } },
      feed(),
      options.now,
    )!;
    expect(item.livingAreaSqft).toBeNull();
    for (const canonical of [
      { ...first().canonical, listPrice: -1 },
      { ...first().canonical, bedrooms: 2.5 },
      { ...first().canonical, coordinates: [181, 36] as const },
      { ...first().canonical, address: "x".repeat(301) },
      { ...first().canonical, sourceModifiedAt: "invalid" },
    ])
      expect(projectNativeMockListing({ ...first(), canonical }, feed(), options.now)).toBeNull();
  });

  it("withdrawal removes detail and all filtered/spatial results on the next read", () => {
    const id = first().id;
    expect(getNativeMockListing(snapshot, context, id, options.now)).not.toBeNull();
    snapshot = {
      ...snapshot,
      listings: snapshot.listings.map((row) =>
        row.id === id ? { ...row, withdrawnAt: MOCK_CLOCK.toISOString(), revision: 2 } : row,
      ),
    };
    expect(getNativeMockListing(snapshot, context, id, options.now)).toBeNull();
    expect(getNativeMockListing(snapshot, context, fixtures.contactB, options.now)).toBeNull();
    expect(read().items.map((item) => item.id)).not.toContain(id);
    expect(read({ bbox: [-115.16, 36.11, -115.14, 36.13] }).items).toEqual([]);
    expect(read({ q: "Juniper" }).items).toEqual([]);
  });

  it("covers active → pending → off-market without resurrecting withdrawn records", () => {
    const native = first();
    expect(projectNativeMockListing(native, feed(), options.now)?.status).toBe("active");
    expect(
      projectNativeMockListing(
        { ...native, canonical: { ...native.canonical, status: "pending" } },
        feed(),
        options.now,
      )?.status,
    ).toBe("pending");
    expect(
      projectNativeMockListing(
        { ...native, canonical: { ...native.canonical, status: "off_market" } },
        { ...feed(), displayPolicy: { ...displayPolicy, allowedStatuses: ["off_market"] } },
        options.now,
      ),
    ).toBeNull();
  });
});

describe("W07 native/mock equivalence and hidden-field search", () => {
  const filters: ListingCriteria[] = [
    {},
    { status: ["active"] },
    { status: ["pending"] },
    { status: ["closed"] },
    { priceMin: 390000, priceMax: 450000 },
    { bedroomsMin: 3 },
    { bathroomsMin: 2.5 },
    { propertyTypes: ["sample residential"] },
    { propertyTypes: ["unknown"] },
    { feedIds: [feedId] },
    { feedIds: ["a0000000-0000-4000-8000-000000000002"] },
    { q: "Mesa" },
    { q: "101 Example Only" },
    { q: "not-a-real-search-match" },
    { bbox: [-115.14, 36.11, -115.1, 36.13] },
    {
      priceMin: 390000,
      bedroomsMin: 3,
      status: ["active", "pending"],
      bbox: [-115.14, 36.11, -115.1, 36.13],
    },
  ];
  it.each(filters)("matches the existing mock seam for permitted filter %j", async (criteria) => {
    const adapter = new MockMlsAdapter(
      () => MOCK_CLOCK,
      () => nativeRights,
    );
    const bbox = criteria.bbox;
    const mock = await adapter.search(providerContext, {
      ...criteria,
      bbox: bbox ? [bbox[0], bbox[1], bbox[2], bbox[3]] : undefined,
    });
    const native = read(criteria);
    const keys = new Map(snapshot.listings.map((row) => [row.id, row.canonical.sourceListingKey]));
    expect(native.items.map((item) => keys.get(item.id)).sort()).toEqual(
      mock.items.map((item) => item.sourceListingKey).sort(),
    );
    for (const item of native.items) {
      const canonical = mock.items.find((source) => source.sourceListingKey === keys.get(item.id))!;
      expect(item).toMatchObject({
        status: canonical.status,
        listPrice: canonical.listPrice,
        bedrooms: canonical.bedrooms,
        bathrooms: canonical.bathrooms,
        displayAddress: canonical.address,
        longitude: canonical.coordinates?.[0] ?? null,
        latitude: canonical.coordinates?.[1] ?? null,
        propertyType: canonical.propertyType,
        remarks: canonical.publicRemarks,
        synthetic: true,
      });
      expect(getNativeMockListing(snapshot, context, item.id, options.now)).toEqual(item);
    }
  });

  it("cannot infer hidden address, coordinates, prices or property types by filtering", () => {
    snapshot = { ...snapshot, feeds: [policyFields(["status"])] };
    expect(read().items.length).toBeGreaterThan(0);
    for (const criteria of [
      { q: "Juniper" },
      { q: "100 Example" },
      { priceMin: 1 },
      { priceMax: 99999999 },
      { bedroomsMin: 1 },
      { bathroomsMin: 1 },
      { propertyTypes: ["sample residential"] },
      { bbox: [-116, 36, -115, 37] },
    ])
      expect(read(criteria).items).toEqual([]);
    expect(
      searchNativeMockListings(snapshot, context, { sort: "price_desc", limit: 100 }, options).items.map(
        (item) => item.id,
      ),
    ).toEqual(read().items.map((item) => item.id));
  });

  it("uses only mock data and makes no remote requests", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("remote fetch forbidden"));
    try {
      const adapter = new MockMlsAdapter();
      expect((await adapter.search(providerContext, {})).items.length).toBeGreaterThan(0);
      expect(read().items.length).toBeGreaterThan(0);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

describe("W07 strict frozen filter validation", () => {
  it.each([
    null,
    [],
    "query",
    { secret: true },
    { q: "x".repeat(121) },
    { priceMin: Number.NaN },
    { priceMax: Number.POSITIVE_INFINITY },
    { priceMin: 2, priceMax: 1 },
    { bedroomsMin: 1.5 },
    { bedroomsMin: 101 },
    { feedIds: ["provider-key"] },
    { feedIds: Array(21).fill(feedId) },
    { status: ["unknown"] },
    { bbox: [-115, 36, -116, 37] },
    { bbox: [-180, -90, 180, 90] },
    { bbox: [-115, 36, -114, 36] },
  ])("rejects malformed/unsupported filter %j", (criteria) => {
    expect(() => normalizeListingCriteria(criteria)).toThrow();
  });

  it("normalizes unordered sets/casing for equivalent cursor bindings without changing keyword whitespace", () => {
    expect(
      normalizeListingCriteria({
        status: ["pending", "active", "pending"],
        feedIds: [feedId, feedId],
        q: " Mesa ",
      }),
    ).toEqual({ status: ["active", "pending"], feedIds: [feedId], q: " mesa " });
  });
});
