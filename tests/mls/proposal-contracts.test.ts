import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import localRead from "../../docs/proposals/W07/local-read.schema.json";
import rightsContract from "../../docs/proposals/W07/native-rights.schema.json";
import frozenContract from "../../packages/contracts/openapi.json";
import { isNativeRights, parseNativeListingQuery } from "../../packages/mls";
import { context, nativeRights } from "./fixtures";

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "https://estate.example/schemas/openapi", components: frozenContract.components });
ajv.addSchema(localRead);
const validateRights = ajv.compile(rightsContract);

describe("W07 proposed closed schema review packet", () => {
  it("compiles every local definition against the existing frozen response contract", () => {
    for (const definition of Object.keys(localRead.$defs))
      expect(ajv.compile({ $ref: `${localRead.$id}#/$defs/${definition}` })).toBeTypeOf("function");
    expect(
      ajv.validate({ $ref: `${localRead.$id}#/$defs/SearchPath` }, { orgId: context.organizationId }),
    ).toBe(true);
    expect(ajv.validate({ $ref: `${localRead.$id}#/$defs/DetailQuery` }, { secret: "forged" })).toBe(false);
  });

  it.each([
    nativeRights,
    { ...nativeRights, approvalState: "revoked" },
    { ...nativeRights, maxDataAgeSeconds: null },
    { ...nativeRights, rights: { ...nativeRights.rights, display: "unknown" } },
    null,
    {},
    { ...nativeRights, invented: "allowed" },
    { ...nativeRights, allowedFields: [1] },
    { ...nativeRights, rights: { ...nativeRights.rights, alertFallback: "allowed" } },
    { ...nativeRights, addressRule: "unknown" },
    { ...nativeRights, maxCacheAgeSeconds: -1 },
  ])("agrees with the runtime rights guard for proposed persisted value %j", (value) => {
    expect(isNativeRights(value)).toBe(validateRights(value));
  });

  it("rejects coerced/repeated query parameters at the closed schema and runtime parser", () => {
    const validate = ajv.compile({ $ref: `${localRead.$id}#/$defs/SearchQuery` });
    for (const query of [
      { limit: 1 },
      { filter: {} },
      { sort: ["price_asc"] },
      { cursor: "" },
      { tenantId: "forged" },
    ]) {
      expect(validate(query)).toBe(false);
      expect(() => parseNativeListingQuery(query)).toThrow();
    }
    const valid = { filter: '{"bedroomsMin":2}', sort: "price_asc", limit: "20" };
    expect(validate(valid)).toBe(true);
    expect(parseNativeListingQuery(valid).filter).toEqual({ bedroomsMin: 2 });
  });
});
