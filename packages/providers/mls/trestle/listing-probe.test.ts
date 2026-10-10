import { expect, it, vi } from "vitest";
import { probeTrestleListing, type ListingInspection } from "./listing-probe";
import { listingInspectionHtml } from "./listing-report";
import { propertySchemaInventory } from "./metadata-inventory";

const names = [
  "ListingKey",
  "OriginatingSystemName",
  "StandardStatus",
  "InternetEntireListingDisplayYN",
  "InternetAddressDisplayYN",
  "PublicRemarks",
];
const xml = `<edmx:Edmx><edmx:DataServices><Schema Namespace="Fixture"><EntityType Name="Property">${names.map((name) => `<Property Name="${name}" Type="Edm.String"/>`).join("")}<NavigationProperty Name="Media" Type="Collection(Fixture.Media)"/></EntityType></Schema></edmx:DataServices></edmx:Edmx>`;
const config = {
  organizationId: "fixture-org",
  feedId: "fixture-feed",
  productId: "fixture-product",
  mlsName: "Fixture MLS",
  feedType: "IDX Plus - WebAPI",
  connectionState: "approved",
  brokerAuthorization: "approved",
  operatorPurpose: "single-listing-local-inspection",
  localInspectionApproved: true,
  originatingSystemNames: ["Fixture MLS"],
  endpoints: {
    tokenUrl: "https://api.cotality.com/trestle/oidc/connect/token",
    odataBaseUrl: "https://api.cotality.com/trestle/odata/",
  },
};
const environment = {
  TRESTLE_LISTING_TEST_ENABLED: "true",
  TRESTLE_CLIENT_ID: "fixture-id",
  TRESTLE_CLIENT_SECRET: "fixture-secret",
  TRESTLE_CREDENTIAL_VERSION: "fixture-v1",
  TRESTLE_CREDENTIAL_EXPIRES_AT: "2027-01-01T00:00:00Z",
};
const row = {
  ListingKey: "fixture-123",
  OriginatingSystemName: "Fixture MLS",
  StandardStatus: "Active",
  InternetEntireListingDisplayYN: true,
  InternetAddressDisplayYN: true,
  PublicRemarks: "Fixture remarks",
  Media: [{ MediaURL: "https://example.invalid/image.jpg" }],
};
const now = () => new Date("2026-10-10T00:00:00Z");
const mockFetch = (record: unknown = row, metadata = xml) =>
  vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/token"))
      return new Response(
        JSON.stringify({ token_type: "Bearer", access_token: "fixture-token", expires_in: 3600 }),
      );
    if (url.endsWith("/$metadata")) return new Response(metadata);
    return new Response(
      JSON.stringify({ value: [record], "@odata.nextLink": "https://example.invalid/never-follow" }),
    );
  });
const probe = (fetch: typeof globalThis.fetch, readConfig: () => Promise<unknown> = async () => config) =>
  probeTrestleListing({ enabled: true, environment, readConfig, fetch, now });

it.each([
  [false, "true"],
  [true, "false"],
  [true, undefined],
])("requires both listing gates (%s,%s)", async (enabled, flag) => {
  const fetch = vi.fn();
  const readConfig = vi.fn();
  expect(
    await probeTrestleListing({
      enabled: enabled as boolean,
      environment: { TRESTLE_LISTING_TEST_ENABLED: flag as string | undefined },
      readConfig,
      fetch,
    }),
  ).toMatchObject({ state: "disabled" });
  expect(readConfig).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { connectionState: "pending" },
  { brokerAuthorization: "unknown" },
  { localInspectionApproved: false },
  { operatorPurpose: "publish" },
  { originatingSystemNames: [] },
])("rejects invalid approval before network %j", async (change) => {
  const fetch = mockFetch();
  await expect(probe(fetch, async () => ({ ...config, ...change }))).rejects.toHaveProperty("code");
  expect(fetch).not.toHaveBeenCalled();
});
it("requests all fields and bounded related resources for exactly one scoped record, never following URLs", async () => {
  const fetch = mockFetch();
  const result = await probe(fetch);
  expect(result).toMatchObject({
    state: "retrieved",
    listing: row,
    summary: {
      propertyRecords: 1,
      schemaFieldCount: 6,
      returnedFieldCount: 6,
      populatedFieldCount: 6,
      complete: true,
      imageDownloads: 0,
    },
  });
  expect(fetch).toHaveBeenCalledTimes(3);
  const url = new URL(String(fetch.mock.calls[2][0]));
  expect(url.searchParams.get("$top")).toBe("1");
  expect(url.searchParams.has("$select")).toBe(false);
  expect(url.searchParams.get("$expand")).toBe("Media($top=1000)");
  expect(url.searchParams.get("$filter")).toContain("OriginatingSystemName eq 'Fixture MLS'");
  expect(url.searchParams.get("$filter")).toContain("InternetAddressDisplayYN eq true");
  expect(JSON.stringify(result)).not.toContain("fixture-secret");
  expect(JSON.stringify(result)).not.toContain("fixture-token");
});
it("escapes source and selected key literals without widening the query", async () => {
  const name = "Fixture ' or true";
  const key = "key' or true";
  const fetch = mockFetch({ ...row, OriginatingSystemName: name, ListingKey: key });
  await probe(fetch, async () => ({ ...config, originatingSystemNames: [name], listingKey: key }));
  const filter = new URL(String(fetch.mock.calls[2][0])).searchParams.get("$filter");
  expect(filter).toContain("OriginatingSystemName eq 'Fixture '' or true'");
  expect(filter).toContain("ListingKey eq 'key'' or true'");
});
it.each([
  [{ OriginatingSystemName: "Foreign MLS" }, "TRESTLE_SOURCE_SCOPE_DENIED"],
  [{ ListingKey: "SYNTHETIC-DEMO" }, "TRESTLE_UNTRUSTED_SOURCE_RECORD"],
  [{ StandardStatus: "Closed" }, "TRESTLE_LISTING_DISPLAY_DENIED"],
  [{ InternetEntireListingDisplayYN: false }, "TRESTLE_LISTING_DISPLAY_DENIED"],
  [{ InternetAddressDisplayYN: "true" }, "TRESTLE_LISTING_DISPLAY_DENIED"],
  [{ UnknownPrivateField: "hidden" }, "TRESTLE_UNEXPECTED_PROPERTY_FIELD"],
  [{ PublicRemarks: "fixture-secret" }, "TRESTLE_UNSAFE_DIAGNOSTIC_RESPONSE"],
])("rejects untrusted or unsafe record %j", async (change, code) => {
  await expect(probe(mockFetch({ ...row, ...(change as object) }))).rejects.toMatchObject({ code });
});
it("discards a record when approval changes during the Property response", async () => {
  let current = { ...config };
  const base = mockFetch();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const response = await base(input);
    if (String(input).includes("/Property?")) current = { ...config, connectionState: "suspended" };
    return response;
  });
  await expect(probe(fetch, async () => current)).rejects.toMatchObject({
    code: "TRESTLE_FEED_NOT_AUTHORIZED",
  });
});
it("rejects multiple records instead of silently choosing the first", async () => {
  const base = mockFetch();
  const fetch = vi.fn(async (input: string | URL | Request) =>
    String(input).includes("/Property?") ? new Response(JSON.stringify({ value: [row, row] })) : base(input),
  );
  await expect(probe(fetch)).rejects.toMatchObject({ code: "TRESTLE_BAD_PROPERTY_RESPONSE" });
});
it("reports omitted fields and related paging as incomplete without following continuations", async () => {
  const partial: Record<string, unknown> = {
    ...row,
    "Media@odata.nextLink": "https://example.invalid/never-follow",
  };
  delete partial.PublicRemarks;
  const fetch = mockFetch(partial);
  expect(await probe(fetch)).toMatchObject({
    summary: {
      complete: false,
      missingFields: ["PublicRemarks"],
      related: [{ name: "Media", records: 1, complete: false }],
    },
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});
it("marks a collection at the bound incomplete", async () => {
  expect(await probe(mockFetch({ ...row, Media: Array.from({ length: 1000 }, () => ({})) }))).toMatchObject({
    summary: { complete: false },
  });
});
it.each([
  `<!DOCTYPE Edmx [<!ENTITY x SYSTEM 'file:///secret'>]>${xml}`,
  xml.replace('Name="PublicRemarks"', 'Name="ListingKey"'),
  xml.replace('Name="ListingKey"', 'Name="ListingKey)"'),
  xml.replace('<Property Name="ListingKey" Type="Edm.String"/>', ""),
])("rejects unsafe or incomplete metadata before a Property request", async (metadata) => {
  const fetch = mockFetch(row, metadata);
  await expect(probe(fetch)).rejects.toMatchObject({ code: "TRESTLE_BAD_METADATA_RESPONSE" });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("supports prefixed catalogue tags and ignores comments", () => {
  const prefixed = xml.replace(/<(\/?)(Property|NavigationProperty|EntityType)\b/g, "<$1edm:$2");
  expect(
    propertySchemaInventory(
      prefixed.replace("<Schema", '<!-- <EntityType Name="Property"></EntityType> --><Schema'),
    ).fields,
  ).toHaveLength(6);
});
it("escapes hostile provider text and loads no scripts or media in the local HTML report", async () => {
  const result = (await probe(
    mockFetch({ ...row, PublicRemarks: '<script>alert(1)</script><img src="https://example.invalid">' }),
  )) as ListingInspection;
  const html = listingInspectionHtml(result);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img ");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("default-src 'none'");
});
