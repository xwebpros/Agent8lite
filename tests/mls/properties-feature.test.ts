import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PropertyCard,
  PropertyDetail,
  propertyPrice,
  PropertyResultFeedback,
} from "../../apps/web/features/properties/property-view";
import { emptyPropertyFilters, propertySearchParams } from "../../apps/web/features/properties/search-input";
import { projectNativeMockListing } from "../../packages/mls";
import { normalizeListingCriteria } from "../../packages/mls/criteria";
import { mockSnapshot, options, syntheticAttributionContacts } from "./fixtures";

describe("W07 responsive feature request/presentation seams (no browser acceptance)", () => {
  it.each(["list", "detail"])(
    "places supplied firm/contact beside primary facts in %s without contact links",
    async (view) => {
      const snapshot = await mockSnapshot();
      for (const contact of syntheticAttributionContacts) {
        const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
        item.attribution.contact = contact;
        const markup = renderToStaticMarkup(
          view === "list"
            ? createElement(PropertyCard, { item, timezone: "America/Los_Angeles", onOpen: () => {} })
            : createElement(PropertyDetail, { item, timezone: "America/Los_Angeles" }),
        );
        const attribution = markup.indexOf('aria-label="Listing attribution"');
        expect(attribution).toBeGreaterThan(markup.indexOf(propertyPrice(item)));
        expect(attribution).toBeLessThan(markup.indexOf("<dl"));
        expect(markup).toContain(`Listing firm: ${item.attribution.brokerageName}`);
        expect(markup).toContain(contact.value);
        expect(markup).not.toMatch(/<a\b|mailto:|tel:|href=/);
        expect(markup.split(contact.value)).toHaveLength(2);
      }
    },
  );

  it.each(["list", "detail"])("escapes participant firm and contact text in %s", async (view) => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    item.attribution.brokerageName = '<img src="https://example.invalid/logo" onerror="private()">';
    item.attribution.contact = { kind: "email", value: "<script>private()</script>@example.invalid" };
    const markup = renderToStaticMarkup(
      view === "list"
        ? createElement(PropertyCard, { item, timezone: "America/Los_Angeles", onOpen: () => {} })
        : createElement(PropertyDetail, { item, timezone: "America/Los_Angeles" }),
    );
    expect(markup).toContain("&lt;img");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toMatch(/<script|<img|<a\b/);
  });

  it.each(["list", "detail"])("does not infer a missing contact from agent text in %s", async (view) => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    delete item.attribution.contact;
    item.attribution.agentName = "Unrelated sample agent";
    const markup = renderToStaticMarkup(
      view === "list"
        ? createElement(PropertyCard, { item, timezone: "America/Los_Angeles", onOpen: () => {} })
        : createElement(PropertyDetail, { item, timezone: "America/Los_Angeles" }),
    );
    expect(markup).toContain("Unrelated sample agent");
    expect(markup).not.toMatch(/Email:|Phone:|@|tel:|mailto:/);
  });
  it("sends only frozen read filters/sorts and validates the produced criteria through the contract", () => {
    const query = propertySearchParams(
      {
        ...emptyPropertyFilters,
        q: "Mesa",
        priceMin: "390000",
        priceMax: "450000",
        bedroomsMin: "3",
        bathroomsMin: "2.5",
        propertyType: "sample residential",
        status: "pending",
        west: "-115.14",
        south: "36.11",
        east: "-115.10",
        north: "36.13",
      },
      "price_asc",
    );
    expect([...query.keys()].sort()).toEqual(["filter", "limit", "sort"]);
    expect(query.get("limit")).toBe("20");
    expect(normalizeListingCriteria(JSON.parse(query.get("filter")!))).toEqual({
      q: "mesa",
      priceMin: 390000,
      priceMax: 450000,
      bedroomsMin: 3,
      bathroomsMin: 2.5,
      propertyTypes: ["sample residential"],
      status: ["pending"],
      bbox: [-115.14, 36.11, -115.1, 36.13],
    });
  });

  it.each([
    { priceMin: "-1" },
    { priceMin: "NaN" },
    { priceMin: "2", priceMax: "1" },
    { bedroomsMin: "2.5" },
    { bedroomsMin: "101" },
    { q: "x".repeat(121) },
    { propertyType: "x".repeat(81) },
    { status: "off_market" },
    { west: "-115" },
    { west: "-115", south: "36", east: "-116", north: "37" },
    { west: "-180", south: "-90", east: "180", north: "90" },
  ])("rejects invalid UI criteria before sending private read %j", (input) => {
    expect(() => propertySearchParams({ ...emptyPropertyFilters, ...input }, "updated_desc")).toThrow();
  });

  it("renders synthetic attribution, labelled details and null-field alternatives without images", async () => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    const card = renderToStaticMarkup(
      createElement(PropertyCard, { item, timezone: "America/Los_Angeles", onOpen: () => {} }),
    );
    expect(card).toContain("SYNTHETIC DEMO DATA");
    expect(card).toContain("View synthetic property details");
    expect(card).toContain('aria-expanded="false"');
    expect(card).not.toContain("aria-controls");
    expect(card).toContain("Valid until");
    expect(card).toContain("Fictional Sample Brokerage");
    expect(card).not.toMatch(/<img|provider_url|logoUrl|sourceListingKey/);
    const hidden = renderToStaticMarkup(
      createElement(PropertyDetail, {
        item: {
          ...item,
          displayAddress: null,
          latitude: null,
          longitude: null,
          listPrice: null,
          bedrooms: null,
          remarks: null,
          propertyType: null,
        },
        timezone: "America/Los_Angeles",
      }),
    );
    expect(hidden).toContain("Address withheld by current policy");
    expect(hidden).toContain("Price withheld");
    expect(hidden).toContain("Remarks withheld");
    expect(hidden).not.toContain("100 Example Only Lane");
    expect(hidden).not.toContain("Permitted synthetic location");
  });

  it("treats permitted provider text as escaped text without executable HTML or implicit link fetching", async () => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    const markup = renderToStaticMarkup(
      createElement(PropertyDetail, {
        item: {
          ...item,
          remarks: '<script>private()</script><img src="https://example.test/provider-photo">',
        },
        timezone: "America/Los_Angeles",
      }),
    );
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toMatch(/<script|<img/);
  });

  it("links an expanded card to the existing detail panel without serializing native refs", async () => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    let registered = false;
    const markup = renderToStaticMarkup(
      createElement(PropertyCard, {
        item,
        timezone: "America/Los_Angeles",
        onOpen: () => {},
        expanded: true,
        controlsId: "property-detail-panel",
        registerControl: () => {
          registered = true;
          return () => {};
        },
      }),
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-controls="property-detail-panel"');
    expect(registered).toBe(false);
    expect(markup).not.toMatch(/registerControl|isConnected|onOpen|ref=/);
  });
});

describe("W07 current property result feedback (static presentation only)", () => {
  const empty = { items: [], hasMore: false, nextCursor: null };
  const feedback = (
    page: Parameters<typeof PropertyResultFeedback>[0]["page"],
    flags: Partial<Omit<Parameters<typeof PropertyResultFeedback>[0], "page">> = {},
  ) =>
    renderToStaticMarkup(
      createElement(PropertyResultFeedback, { page, loading: false, expired: false, notice: "", ...flags }),
    );

  it("keeps an unavailable/currently unscoped read distinct from a successful empty read", () => {
    const unavailable = feedback(null);
    expect(unavailable).toContain('role="status"');
    expect(unavailable).toContain('aria-live="polite"');
    expect(unavailable).not.toMatch(/properties loaded|match these filters/);
    const succeeded = feedback(empty);
    expect(succeeded).toContain("0 synthetic properties loaded.");
    expect(succeeded).toContain("No currently permitted synthetic properties match these filters.");
  });

  it.each([1, 2, 3])(
    "announces %i currently loaded properties without exposing their fields",
    async (count) => {
      const snapshot = await mockSnapshot();
      const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
      const markup = feedback({
        items: Array.from({ length: count }, () => item),
        hasMore: count === 3,
        nextCursor: count === 3 ? "private-synthetic-cursor" : null,
      });
      expect(markup).toContain(`${count} synthetic ${count === 1 ? "property" : "properties"} loaded`);
      expect(markup.includes("more available")).toBe(count === 3);
      expect(markup).not.toContain("match these filters");
      expect(markup).not.toContain(item.id);
      expect(markup).not.toContain(item.displayAddress);
      expect(markup).not.toContain("private-synthetic-cursor");
    },
  );

  it.each([0, 1])("does not turn an expired surface with %i list rows into no matches", async (count) => {
    const snapshot = await mockSnapshot();
    const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
    const markup = feedback({ ...empty, items: count ? [item] : [] }, { expired: true });
    expect(markup).toContain("Current synthetic results expired.");
    expect(markup).not.toMatch(/properties? loaded|match these filters/);
  });

  it.each([0, 1])(
    "announces a pending refresh/continuation with %i prior rows without a completed result",
    async (count) => {
      const snapshot = await mockSnapshot();
      const item = projectNativeMockListing(snapshot.listings[0], snapshot.feeds[0], options.now)!;
      const markup = feedback({ ...empty, items: count ? [item] : [] }, { loading: true });
      expect(markup).toContain("Checking current synthetic properties…");
      expect(markup).not.toMatch(/properties? loaded|match these filters/);
    },
  );

  it("keeps the expiry-cleared notice visible after its private page is discarded", () => {
    const markup = feedback(null, {
      notice: "Current synthetic results expired. Refresh to recheck access and availability.",
    });
    expect(markup).toContain("Current synthetic results expired.");
    expect(markup).not.toMatch(/properties? loaded|match these filters/);
  });

  it("escapes a notice and never claims a successful count after an unavailable read", () => {
    const markup = feedback(null, { notice: "<script>unavailable()</script>" });
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toMatch(/<script|properties? loaded|match these filters/);
  });
});
