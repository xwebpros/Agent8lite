import { describe, expect, it, vi } from "vitest";
import { NoDeliveryTransport } from "../../packages/providers/email/mock";
import type { DeliveryRequest } from "../../packages/providers/email/port";
import {
  displayProjection,
  MOCK_CLOCK,
  MockMlsAdapter,
  mockPolicy,
  SYNTHETIC_BANNER,
  validateCriteria,
} from "../../packages/providers/mls/mock";
import type {
  CanonicalListing,
  FeedContext,
  ListingCriteria,
  MlsPolicy,
} from "../../packages/providers/mls/port";

const context: FeedContext = {
  organizationId: "synthetic-organization",
  feedId: "synthetic-feed",
  policyVersion: "synthetic-v1",
};
const seedListing = async (): Promise<CanonicalListing> => {
  const listing = await new MockMlsAdapter().getListing(context, "SYNTHETIC-VEGAS-001");
  expect(listing).not.toBeNull();
  return listing!;
};

describe("M1 mock MLS seam — policy denial and synthetic separation", () => {
  it("exposes synthetic records and explicit unsupported capabilities without provider credentials or media", async () => {
    const adapter = new MockMlsAdapter();
    const capabilities = await adapter.capabilities(context);
    expect(adapter.providerCode).toBe("mock-synthetic");
    expect(capabilities.reso).toBeNull();
    expect(capabilities.supports).toMatchObject({ alerts: false, openHouses: false, inquiryWebhook: false });
    expect(capabilities.media).toBe("none");
    expect(await adapter.readMedia(context, "SYNTHETIC-VEGAS-001")).toEqual([]);
    const results = await adapter.search(context, {});
    expect(results.items.length).toBeGreaterThan(0);
    for (const listing of results.items) {
      expect(listing.synthetic).toBe(true);
      expect(listing.sourceListingKey).toMatch(/^SYNTHETIC-/);
      expect(listing.publicRemarks).toMatch(/SYNTHETIC SAMPLE/);
      expect(listing.attribution.disclaimer).toMatch(/Synthetic/);
    }
    expect(SYNTHETIC_BANNER).toMatch(/not actual MLS listings/);
    await expect(adapter.search({ ...context, policyVersion: "" }, {})).rejects.toThrow(
      "VERIFIED_FEED_REQUIRED",
    );
  });

  it.each(["unapproved", "revoked"] as const)(
    "suppresses search and detail when policy is %s",
    async (approvalState) => {
      const adapter = new MockMlsAdapter(
        () => MOCK_CLOCK,
        () => ({ ...mockPolicy, approvalState }),
      );
      expect((await adapter.search(context, {})).items).toEqual([]);
      expect(await adapter.getListing(context, "SYNTHETIC-VEGAS-001")).toBeNull();
    },
  );

  it.each(["denied", "unknown"] as const)(
    "suppresses display for %s rights and unresolved age limits",
    async (display) => {
      const listing = await seedListing();
      expect(
        displayProjection(listing, { ...mockPolicy, rights: { ...mockPolicy.rights, display } }, MOCK_CLOCK),
      ).toBeNull();
      expect(displayProjection(listing, { ...mockPolicy, maxDataAgeSeconds: null }, MOCK_CLOCK)).toBeNull();
    },
  );

  it("suppresses expired, stale, invalid timestamps, unmapped and denied records", async () => {
    const listing = await seedListing();
    for (const changed of [
      { expiresAt: MOCK_CLOCK.toISOString() },
      { expiresAt: "unresolved" },
      { ingestedAt: "unresolved" },
      { ingestedAt: "2026-10-08T00:00:00Z" },
      { displayAllowed: false },
      { status: "unknown" as const },
      { status: "off_market" as const },
    ])
      expect(
        displayProjection({ ...listing, ...changed }, mockPolicy, MOCK_CLOCK),
        JSON.stringify(changed),
      ).toBeNull();
  });

  it("masks hidden address and coordinates and strips every field outside the display allowlist", async () => {
    const listing = await seedListing();
    const hidden = displayProjection({ ...listing, addressAllowed: false }, mockPolicy, MOCK_CLOCK)!;
    expect(hidden).toMatchObject({ address: null, coordinates: null, addressAllowed: false });
    const policy: MlsPolicy = { ...mockPolicy, addressRule: "hidden", allowedFields: ["listPrice"] };
    const redacted = displayProjection(listing, policy, MOCK_CLOCK)!;
    expect(redacted).toMatchObject({
      address: null,
      coordinates: null,
      bedrooms: null,
      bathrooms: null,
      area: null,
      publicRemarks: null,
      listPrice: listing.listPrice,
    });
    expect(
      displayProjection(listing, { ...mockPolicy, locationRule: "hidden" }, MOCK_CLOCK)?.coordinates,
    ).toBeNull();
  });

  it("a coarse-only policy does not expose an exact location", async () => {
    const listing = await seedListing();
    const projected = displayProjection(listing, { ...mockPolicy, locationRule: "coarse" }, MOCK_CLOCK)!;
    expect(projected.coordinates).not.toEqual(listing.coordinates);
  });

  it("fails closed for invalid clocks, unresolved freshness limits and future ingestion", async () => {
    const listing = await seedListing();
    expect(displayProjection(listing, mockPolicy, new Date("invalid"))).toBeNull();
    for (const maxDataAgeSeconds of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 0])
      expect(displayProjection(listing, { ...mockPolicy, maxDataAgeSeconds }, MOCK_CLOCK)).toBeNull();
    expect(
      displayProjection(
        { ...listing, ingestedAt: new Date(MOCK_CLOCK.getTime() + 1).toISOString() },
        mockPolicy,
        MOCK_CLOCK,
      ),
    ).toBeNull();
    const adapter = new MockMlsAdapter(() => new Date("invalid"));
    expect(await adapter.getListing(context, listing.sourceListingKey)).toBeNull();
    await expect(adapter.search(context, {})).rejects.toThrow();
  });

  it("does not let mutation of returned listing/search/change objects alter later projections", async () => {
    const adapter = new MockMlsAdapter();
    const key = "SYNTHETIC-VEGAS-001";
    const original = await adapter.getListing(context, key);
    const detail = await adapter.getListing(context, key);
    (detail!.coordinates as unknown as [number, number])[0] = 0;
    (detail!.area as { value: number }).value = 0;
    (detail!.attribution as { disclaimer: string }).disclaimer = "Caller changed attribution";
    const search = await adapter.search(context, {});
    const listing = search.items.find((item) => item.sourceListingKey === key)!;
    (listing.coordinates as unknown as [number, number])[1] = 0;
    (listing as { synthetic: boolean }).synthetic = false;
    const changes = await adapter.readChanges(context, {
      cursor: null,
      watermark: null,
      overlapSeconds: 0,
      limit: 100,
    });
    const changed = changes.changes.find(
      (change) => change.kind === "upsert" && change.sourceListingKey === key,
    )!;
    if (changed.kind === "upsert") (changed.listing as { displayAllowed: boolean }).displayAllowed = false;
    expect(await adapter.getListing(context, key)).toEqual(original);
    expect((await adapter.search(context, {})).items.find((item) => item.sourceListingKey === key)).toEqual(
      original,
    );
  });
});

describe("mock MLS filters, lifecycle and durable change paging", () => {
  it("rejects malformed filter bodies, non-array collections, unsupported statuses and wrong value types", () => {
    for (const criteria of [
      null,
      [],
      "invalid",
      { feedIds: "one-feed" },
      { status: "active" },
      { status: ["unknown"] },
      { status: [null] },
      { propertyTypes: {} },
      { propertyTypes: Array(101).fill("residential") },
      { feedIds: [""] },
      { q: 123 },
      { bbox: "coordinates" },
      { bbox: null },
      { bbox: [0, 0, 1] },
    ])
      expect(() => validateCriteria(criteria as ListingCriteria), JSON.stringify(criteria)).toThrow();
  });
  it.each([
    { approvalState: "revoked" as const, replicate: "allowed" as const },
    { approvalState: "unapproved" as const, replicate: "allowed" as const },
    { approvalState: "approved" as const, replicate: "unknown" as const },
    { approvalState: "approved" as const, replicate: "denied" as const },
  ])(
    "denies raw replication when approval or rights do not allow it: %j",
    async ({ approvalState, replicate }) => {
      const adapter = new MockMlsAdapter(
        () => MOCK_CLOCK,
        () => ({ ...mockPolicy, approvalState, rights: { ...mockPolicy.rights, replicate } }),
      );
      await expect(
        adapter.readChanges(context, { cursor: null, watermark: null, overlapSeconds: 30, limit: 100 }),
      ).rejects.toThrow();
    },
  );
  it.each([
    { priceMin: -1 },
    { priceMin: Number.NaN },
    { priceMin: 500000, priceMax: 400000 },
    { bbox: [-181, 35, -180, 36] },
    { bbox: [-115, 36, -116, 37] },
    { bbox: [-115, 36, -114, 35] },
    { bbox: [-115, 36, -105, 37] },
    { bbox: [-115, 36, Number.POSITIVE_INFINITY, 37] },
    { q: "x".repeat(201) },
    { arbitraryProviderExpression: "unauthorized" },
  ])("rejects invalid or provider-specific criteria: %j", (criteria) => {
    expect(() => validateCriteria(criteria as ListingCriteria)).toThrow();
  });

  it("list and map filters agree and hidden locations cannot leak through map membership", async () => {
    const adapter = new MockMlsAdapter();
    const criteria: ListingCriteria = {
      priceMin: 300000,
      priceMax: 500000,
      bedroomsMin: 2,
      bathroomsMin: 2,
      status: ["active"],
      feedIds: [context.feedId],
      propertyTypes: ["sample residential"],
    };
    const list = (await adapter.search(context, criteria)).items;
    const bbox: ListingCriteria["bbox"] = [-115.17, 36.1, -115.11, 36.15];
    const map = (await adapter.search(context, { ...criteria, bbox })).items;
    const expected = list.filter(
      (listing) =>
        listing.coordinates &&
        listing.coordinates[0] >= bbox[0] &&
        listing.coordinates[0] <= bbox[2] &&
        listing.coordinates[1] >= bbox[1] &&
        listing.coordinates[1] <= bbox[3],
    );
    expect(map.map((listing) => listing.sourceListingKey)).toEqual(
      expected.map((listing) => listing.sourceListingKey),
    );
    expect((await adapter.search(context, { feedIds: ["unapproved-feed"] })).items).toEqual([]);
    const hidden = new MockMlsAdapter(
      () => MOCK_CLOCK,
      () => ({ ...mockPolicy, addressRule: "hidden" }),
    );
    expect((await hidden.search(context, { bbox })).items).toEqual([]);
    expect(
      (await adapter.search(context, { q: "Juniper Sample House" })).items.map(
        (listing) => listing.sourceListingKey,
      ),
    ).toEqual(["SYNTHETIC-VEGAS-001"]);
  });

  it("pages all changes exactly once, records withdrawal, and immediately suppresses derived detail/search", async () => {
    const adapter = new MockMlsAdapter();
    const changes = [];
    let cursor: string | null = null;
    let completedWatermark: string | null = null;
    do {
      const page = await adapter.readChanges(context, {
        cursor,
        watermark: null,
        overlapSeconds: 30,
        limit: 2,
      });
      changes.push(...page.changes);
      cursor = page.nextOpaqueCursor;
      completedWatermark = page.completedWatermark;
      if (cursor) expect(completedWatermark).toBeNull();
    } while (cursor);
    expect(changes.length).toBeGreaterThan(2);
    expect(new Set(changes.map((change) => change.sourceListingKey)).size).toBe(changes.length);
    expect(completedWatermark).toBe(MOCK_CLOCK.toISOString());
    adapter.withdraw("SYNTHETIC-VEGAS-001");
    expect(await adapter.getListing(context, "SYNTHETIC-VEGAS-001")).toBeNull();
    expect(
      (await adapter.search(context, {})).items.some(
        (listing) => listing.sourceListingKey === "SYNTHETIC-VEGAS-001",
      ),
    ).toBe(false);
    const delta = await adapter.readChanges(context, {
      cursor: `mock:${changes.length}`,
      watermark: completedWatermark,
      overlapSeconds: 30,
      limit: 100,
    });
    expect(delta.changes).toEqual([{ kind: "delete", sourceListingKey: "SYNTHETIC-VEGAS-001" }]);
  });

  it("rejects invalid pages and fabricated cursors", async () => {
    const adapter = new MockMlsAdapter();
    await expect(
      adapter.readChanges(context, { cursor: null, watermark: null, overlapSeconds: 0, limit: 101 }),
    ).rejects.toThrow("INVALID_PAGE");
    await expect(
      adapter.readChanges(context, { cursor: "provider:123", watermark: null, overlapSeconds: 0, limit: 10 }),
    ).rejects.toThrow("INVALID_CURSOR");
    await expect(
      adapter.readChanges(context, { cursor: "mock:1000000", watermark: null, overlapSeconds: 0, limit: 10 }),
    ).rejects.toThrow("INVALID_CURSOR");
  });
});

describe("no-delivery communication transport", () => {
  it("returns detached simulated receipts so caller mutation cannot change retry state", async () => {
    const transport = new NoDeliveryTransport();
    const request: DeliveryRequest = {
      tenantId: "synthetic-clone",
      attemptId: "attempt-clone",
      idempotencyKey: "immutable-receipt",
      eligible: true,
      channel: "email",
    };
    const first = await transport.deliver(request);
    (first as { state: string }).state = "externally-delivered";
    expect(await transport.deliver(request)).toMatchObject({
      state: "simulated",
      externalDelivery: false,
      providerReference: null,
    });
  });
  it("never makes network requests or claims external acceptance; retries return the same receipt", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const transport = new NoDeliveryTransport();
      const request: DeliveryRequest = {
        tenantId: "synthetic-a",
        attemptId: "attempt-1",
        idempotencyKey: "delivery-1",
        eligible: true,
        channel: "email",
      };
      const receipts = await Promise.all([
        transport.deliver(request),
        transport.deliver(request),
        transport.deliver(request),
      ]);
      expect(receipts).toEqual(
        Array(3).fill({
          attemptId: "attempt-1",
          state: "simulated",
          externalDelivery: false,
          providerReference: null,
        }),
      );
      expect(network).not.toHaveBeenCalled();
      await expect(transport.deliver({ ...request, channel: "sms" })).rejects.toThrow(
        "DELIVERY_IDEMPOTENCY_CONFLICT",
      );
      expect(await transport.deliver({ ...request, tenantId: "synthetic-b", eligible: false })).toMatchObject(
        { state: "suppressed", externalDelivery: false },
      );
    } finally {
      network.mockRestore();
    }
  });

  it("suppresses ineligible sends and requires tenant/attempt/idempotency references", async () => {
    const transport = new NoDeliveryTransport();
    const request: DeliveryRequest = {
      tenantId: "synthetic-a",
      attemptId: "attempt-1",
      idempotencyKey: "delivery-1",
      eligible: false,
      channel: "sms",
    };
    expect(await transport.deliver(request)).toMatchObject({
      state: "suppressed",
      externalDelivery: false,
      providerReference: null,
    });
    for (const field of ["tenantId", "attemptId", "idempotencyKey"] as const)
      await expect(transport.deliver({ ...request, [field]: "" })).rejects.toThrow(
        "Verified delivery references",
      );
  });
});
