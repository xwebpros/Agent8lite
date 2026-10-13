import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import api from "../../packages/contracts/openapi.json";
import { requireIdxIsolation } from "./isolation";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "idx-api", components: api.components });
const inquiryValid = ajv.compile({ $ref: "idx-api#/components/schemas/IdxTemplateInquiryWrite" });
const listingValid = ajv.compile({ $ref: "idx-api#/components/schemas/IdxTemplateListing" });
const search = api.paths["/v1/public/sites/{siteId}/idx-template/listings"].get;
const queryValid = ajv.compile({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    search.parameters
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => [parameter.name, parameter.schema]),
  ),
});
const inquiry = () => ({
  formId: randomUUID(),
  formVersion: 1,
  listingKey: "SYNTHETIC-IDX-001",
  listingId: "SYNTHETIC-MLS-001",
  name: "Synthetic Visitor",
  email: "visitor@example.test",
  phone: "+12025550123",
  message: "Question about this synthetic property.\nPlease preserve this second line.",
});
const listing = () => ({
  listingKey: "SYNTHETIC-IDX-001",
  listingId: "SYNTHETIC-MLS-001",
  synthetic: true,
  expiresAt: "2026-10-13T01:00:00.000Z",
  photos: ["/templates/las-vegas-idx/fixture.svg"],
});

describe("reviewed public template inquiry contract", () => {
  it("accepts the original inquiry fields at the preserved source identifier bounds", () => {
    expect(inquiryValid({ ...inquiry(), listingKey: "a".repeat(200), listingId: "b".repeat(100) })).toBe(
      true,
    );
    const body = inquiry();
    expect(inquiryValid(body)).toBe(true);
    expect(body.message).toContain("\n");
  });
  it.each(["tenantId", "ownerMemberId", "sourceId", "bindingId", "consentChoices"])(
    "rejects public authority or inferred consent field %s",
    (field) => {
      expect(inquiryValid({ ...inquiry(), [field]: randomUUID() })).toBe(false);
    },
  );
  it.each([
    { listingKey: "a".repeat(201) },
    { listingId: "b".repeat(101) },
    { message: "" },
    { message: "m".repeat(2001) },
    { name: "a" },
    { email: "invalid" },
    { formVersion: 0 },
    { formId: "invalid" },
  ])("rejects malformed or oversized request %s", (change) => {
    expect(inquiryValid({ ...inquiry(), ...change })).toBe(false);
  });
});

describe("bounded source listing gallery and filters", () => {
  it("preserves a complete gallery larger than the old forty-photo cut-off", () => {
    const photos = Array.from(
      { length: 65 },
      (_, index) => `https://fixture.example.test/photo-${index}.jpg`,
    );
    expect(listingValid({ ...listing(), photos })).toBe(true);
    expect(photos).toHaveLength(65);
    expect(listingValid({ ...listing(), photos: Array(1025).fill(photos[0]) })).toBe(false);
  });
  it.each(["synthetic", "expiresAt"])("rejects a listing without required policy marker %s", (key) => {
    const body: Record<string, unknown> = listing();
    delete body[key];
    expect(listingValid(body)).toBe(false);
  });
  it.each([
    "javascript:alert(1)",
    "http://fixture.example.test/photo.jpg",
    "//unapproved.example.test/photo.jpg",
  ])("rejects unapproved media protocol %s", (url) => {
    expect(listingValid({ ...listing(), photos: [url] })).toBe(false);
  });
  it("accepts all source advanced controls while rejecting invalid location and fractional pagination", () => {
    expect(
      queryValid({
        minPrice: 100000,
        maxPrice: 900000,
        beds: 3,
        baths: 2.5,
        address: "Synthetic Street",
        city: "Las Vegas",
        zip: "89109",
        status: "Active",
        propertyType: "Residential",
        propertySubType: "SingleFamilyResidence",
        minSqft: 1000,
        maxSqft: 5000,
        minYearBuilt: 1990,
        maxYearBuilt: 2026,
        pool: true,
        singleStory: true,
        hoa: false,
        gated: true,
        minGarageSpaces: 2,
        minLotSizeSqft: 4000,
        minLatitude: 36,
        maxLatitude: 37,
        minLongitude: -116,
        maxLongitude: -115,
        sort: "price-asc",
        page: 100,
      }),
    ).toBe(true);
    for (const change of [
      { page: 1.5 },
      { page: 101 },
      { zip: "\\ddddd" },
      { maxLatitude: 91 },
      { arbitraryOdata: "$filter=true" },
    ])
      expect(queryValid(change)).toBe(false);
  });
});

describe("test isolation refusal", () => {
  const safe = {
    TEST_IDX_ISOLATED: "true",
    TEST_MIGRATION_DATABASE_URL:
      "postgresql://postgres:fixture@127.0.0.1:54434/estate_acceptance_0123456789abcdef",
    TEST_DATABASE_URL:
      "postgresql://estate_runtime:fixture@127.0.0.1:54434/estate_acceptance_0123456789abcdef",
    TEST_API_ORIGIN: "http://127.0.0.1:49152",
  };
  it("requires the owned disposable cluster and API listener", () => {
    expect(requireIdxIsolation(safe).api).toBe(safe.TEST_API_ORIGIN);
    for (const change of [
      { TEST_IDX_ISOLATED: "false" },
      { TEST_DATABASE_URL: "postgresql://estate_runtime:fixture@127.0.0.1:55432/estate" },
      {
        TEST_MIGRATION_DATABASE_URL:
          "postgresql://postgres:fixture@remote.example.test:54434/estate_acceptance_0123456789abcdef",
      },
      { TEST_API_ORIGIN: "http://127.0.0.1:3001" },
    ])
      expect(() => requireIdxIsolation({ ...safe, ...change })).toThrow();
  });
});
