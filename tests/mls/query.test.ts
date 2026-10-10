import { describe, expect, it } from "vitest";
import { parseNativeListingQuery } from "../../packages/mls";

describe("W07 closed native search query parser", () => {
  it("uses the frozen query names and normalizes valid JSON filters", () => {
    expect(parseNativeListingQuery({})).toEqual({
      filter: {},
      limit: 20,
      sort: "updated_desc",
      cursor: undefined,
    });
    expect(
      parseNativeListingQuery({ limit: "100", sort: "price_asc", filter: '{"q":"Mesa","priceMin":1}' }),
    ).toEqual({ filter: { priceMin: 1, q: "mesa" }, limit: 100, sort: "price_asc", cursor: undefined });
  });

  it.each([
    null,
    [],
    "query",
    { orgId: "forged" },
    { filter: {} },
    { filter: ["{}", "{}"] },
    { filter: "{" },
    { filter: "null" },
    { filter: "x".repeat(8193) },
    { limit: ["1", "2"] },
    { limit: 20 },
    { limit: "01" },
    { limit: "1.5" },
    { limit: "101" },
    { limit: "" },
    { sort: ["price_asc"] },
    { sort: "source_private" },
    { cursor: "" },
    { cursor: ["first", "second"] },
    { cursor: "x".repeat(2049) },
  ])("rejects repeated/coerced/oversized/unknown request query %j", (query) => {
    expect(() => parseNativeListingQuery(query)).toThrow();
  });
});
