import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreservedIdxClient } from "../../packages/providers/mls/las-vegas-idx/preserved-client";

const environment = {
  TRESTLE_BASE_URL: "https://provider.example.test/trestle",
  TRESTLE_CLIENT_ID: "synthetic-client-id",
  TRESTLE_CLIENT_SECRET: "synthetic-unit-secret-only",
};
const rawListing = (index = 1) => ({
  ListingKey: `SYNTHETIC-KEY-${index}`,
  ListingId: `SYNTHETIC-ID-${index}`,
  StandardStatus: "Active",
  UnparsedAddress: "12 Synthetic Avenue, Las Vegas, NV 89109",
  City: "Las Vegas",
  StateOrProvince: "NV",
  PostalCode: "89109",
  ListPrice: 500000,
  ListOfficeName: "Synthetic Brokerage",
  ListAgentFullName: "Synthetic Display Name",
  PublicRemarks: "Fictional listing only.",
  Media: Array.from({ length: 65 }, (_, i) => ({
    MediaURL: `https://media.example.test/photo-${i}.jpg`,
    Order: i,
  })),
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function transport(properties: (url: URL) => Record<string, unknown>[] = () => [rawListing()]) {
  const calls: URL[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://provider.example.test")
      throw new Error("Unexpected fixture transport target.");
    calls.push(url);
    if (url.pathname.endsWith("/oidc/connect/token")) {
      expect(init?.method).toBe("POST");
      expect(new URLSearchParams(init?.body as URLSearchParams).get("grant_type")).toBe("client_credentials");
      return json({ access_token: "synthetic-token", expires_in: 3600 });
    }
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic-token");
    return json({ value: properties(url) });
  });
  return { fetch, calls };
}

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("External network forbidden in preserved-client tests.");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pinned source MLS client through an injected synthetic transport", () => {
  it("does not request token, metadata or property data without configured credentials", async () => {
    const fake = transport();
    const client = createPreservedIdxClient({}, fake.fetch);
    expect(await client.checkLiveStatus()).toMatchObject({ configured: false, live: false, property: false });
    await expect(client.listProperties({ page: 1 })).rejects.toMatchObject({ status: 503 });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it.each(["getProperty", "getPropertyByListingId"] as const)(
    "keeps every detail image and safely quotes the identifier for %s",
    async (method) => {
      const fake = transport();
      const client = createPreservedIdxClient(environment, fake.fetch);
      const result = await client[method]("SYNTHETIC'OData");
      expect(result?.photos).toHaveLength(65);
      expect(result?.listingOffice).toBe("Synthetic Brokerage");
      expect(result?.listingAgent).toBe("Synthetic Display Name");
      const query = fake.calls.find((url) => url.pathname.endsWith("/Property"))!.searchParams;
      expect(query.get("$filter")).toContain("eq 'SYNTHETIC''OData'");
      expect(query.get("$expand")).toContain("$orderby=Order asc");
      expect(query.get("$expand")).not.toContain("$top=");
    },
  );

  it("preserves filter pagination, sort and one-photo list semantics while reusing the token and short-lived page cache", async () => {
    const fake = transport(() => Array.from({ length: 25 }, (_, i) => rawListing(i)));
    const client = createPreservedIdxClient(environment, fake.fetch);
    const filters = {
      minPrice: 0,
      beds: 3,
      zip: "89109",
      pool: true,
      hoa: false,
      sort: "price-asc" as const,
      page: 2,
    };
    const first = await client.listProperties(filters);
    const replay = await client.listProperties(filters);
    expect(first.items).toHaveLength(24);
    expect(first).toMatchObject({ page: 2, pageSize: 24, hasMore: true, live: true });
    expect(replay).toEqual(first);
    expect(fake.calls.filter((url) => url.pathname.endsWith("/token"))).toHaveLength(1);
    expect(fake.calls.filter((url) => url.pathname.endsWith("/Property"))).toHaveLength(1);
    const query = fake.calls.find((url) => url.pathname.endsWith("/Property"))!.searchParams;
    expect(query.get("$filter")).toContain("ListPrice ge 0");
    expect(query.get("$filter")).toContain("BedroomsTotal ge 3");
    expect(query.get("$filter")).toContain("PostalCode eq '89109'");
    expect(query.get("$filter")).toContain("PoolFeatures ne 'None'");
    expect(query.get("$filter")).not.toContain("AssociationYN");
    expect(query.get("$skip")).toBe("24");
    expect(query.get("$orderby")).toBe("ListPrice asc");
    expect(query.get("$expand")).toContain("$top=1");
  });

  it("scans provider pages for normalized partial addresses and applies result pagination locally", async () => {
    const fake = transport((url) => {
      const skip = Number(url.searchParams.get("$skip"));
      if (skip === 0)
        return Array.from({ length: 100 }, (_, i) => ({
          ...rawListing(i),
          UnparsedAddress: i < 26 ? "12 SYNTHETIC  Avenue" : "Other fictional address",
        }));
      expect(skip).toBe(100);
      return [rawListing(100)];
    });
    const result = await createPreservedIdxClient(environment, fake.fetch).listProperties({
      address: " synthetic  avenue ",
      page: 2,
    });
    expect(result.items).toHaveLength(3);
    expect(result.hasMore).toBe(false);
    const pages = fake.calls.filter((url) => url.pathname.endsWith("/Property"));
    expect(pages.map((url) => url.searchParams.get("$skip"))).toEqual(["0", "100"]);
    expect(pages.every((url) => !url.searchParams.get("$filter")?.includes("contains("))).toBe(true);
  });

  it("invalidates a rejected token and reports provider failure without blindly repeating the request", async () => {
    let tokens = 0;
    let properties = 0;
    const fake = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/token")) {
        tokens++;
        return json({ access_token: `synthetic-${tokens}`, expires_in: 3600 });
      }
      properties++;
      return properties === 1
        ? json({ privateProviderError: "not exposed" }, 401)
        : json({ value: [rawListing()] });
    });
    const client = createPreservedIdxClient(environment, fake);
    await expect(client.getProperty("SYNTHETIC-KEY-1")).rejects.toMatchObject({
      status: 401,
      message: "Live IDX request failed",
    });
    expect(tokens).toBe(1);
    expect(properties).toBe(1);
    expect((await client.getProperty("SYNTHETIC-KEY-1"))?.listingKey).toBe("SYNTHETIC-KEY-1");
    expect(tokens).toBe(2);
    expect(properties).toBe(2);
  });
});
