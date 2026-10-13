import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import api from "../../packages/contracts/openapi.json";
import amendment from "../../packages/contracts/amendments/ADR-022-listing-attribution-contact.json";
import stageAmendment from "../../packages/contracts/amendments/ADR-043-stage-transition-if-match.json";
import mergeAmendment from "../../packages/contracts/amendments/ADR-049-contact-merge.json";
import idxAmendment from "../../packages/contracts/amendments/ADR-061-idx-template.json";
import { providedAttributionContact } from "../../packages/providers/mls/attribution";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validate = ajv.compile(api.components.schemas.Attribution);
const required = { brokerageName: "Fictional Sample Brokerage", disclaimer: "SYNTHETIC DEMO DATA" };

describe("reviewed listing participant attribution contact", () => {
  it("adds only the reviewed optional property to the immutable original API", () => {
    const original = JSON.parse(readFileSync("blueprint/contracts/openapi.json", "utf8"));
    const implementation = structuredClone(api);
    expect(original.components.schemas.Attribution.properties).not.toHaveProperty("contact");
    expect(implementation.components.schemas.Attribution.properties.contact).toEqual(amendment.definition);
    delete (implementation.components.schemas.Attribution.properties as Record<string, unknown>).contact;
    expect(stageAmendment.path).toBe("/v1/orgs/{orgId}/leads/{leadId}/stage-transitions");
    const stageOperation = implementation.paths["/v1/orgs/{orgId}/leads/{leadId}/stage-transitions"].post;
    expect(stageOperation.operationId).toBe(stageAmendment.operationId);
    expect(stageOperation.parameters.at(-1)).toEqual(stageAmendment.parameter);
    stageOperation.parameters.pop();
    // Strip ADR-049 additive paths and schemas before comparing to the frozen original.
    for (const path of Object.keys(mergeAmendment.paths)) {
      delete (implementation.paths as Record<string, unknown>)[path];
    }
    for (const schema of Object.keys(mergeAmendment.schemas)) {
      delete (implementation.components.schemas as Record<string, unknown>)[schema];
    }
    // Assert the exact reviewed ADR-061 additions before removing them for baseline comparison.
    for (const [path, definition] of Object.entries(idxAmendment.paths)) {
      expect((implementation.paths as Record<string, unknown>)[path]).toEqual(definition);
      delete (implementation.paths as Record<string, unknown>)[path];
    }
    for (const [schema, definition] of Object.entries(idxAmendment.schemas)) {
      expect((implementation.components.schemas as Record<string, unknown>)[schema]).toEqual(definition);
      delete (implementation.components.schemas as Record<string, unknown>)[schema];
    }
    expect(implementation).toEqual(original);
    expect(validate(required)).toBe(true);
    expect(validate({ ...required, contact: null })).toBe(true);
  });

  it.each([
    ["fictional-agent@example.invalid", "email"],
    ["702-555-0100", "phone"],
    ["+1 (702) 555-0100 ext 42", "phone"],
  ] as const)("preserves the provided %s as %s without fallback", (value, kind) => {
    const contact = providedAttributionContact(value);
    expect(contact).toEqual({ kind, value });
    expect(Object.isFrozen(contact)).toBe(true);
    expect(validate({ ...required, contact })).toBe(true);
  });

  it.each([
    "",
    "unknown",
    "mailto:fictional@example.invalid",
    "tel:7025550100",
    "12345",
    "123 ext 4567",
    "https://example.invalid",
    "<script>7025550100</script>",
    "702-555-0100\n",
    " fictional@example.invalid",
    null,
    { value: "702-555-0100" },
  ])("denies unavailable or malformed contact rather than invent a replacement %#", (value) => {
    expect(providedAttributionContact(value)).toBeNull();
  });

  it.each([
    { kind: "email", value: "not-an-email" },
    { kind: "phone", value: "12" },
    { kind: "phone", value: "123 ext 4567" },
    { kind: "website", value: "https://example.invalid" },
    { kind: "phone", value: "7025550100", ownerContact: "ignored" },
    { kind: "email", value: "fictional@example.invalid\n" },
  ])("rejects malformed and widened public contact bodies %#", (contact) => {
    expect(validate({ ...required, contact })).toBe(false);
  });
});
