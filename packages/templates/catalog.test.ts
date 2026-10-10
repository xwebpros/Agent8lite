import { describe, expect, it } from "vitest";
import { instantiateTemplate, listTemplateDefinitions } from "./catalog";
import { renderRegisteredBlocks } from "./registry";

describe("independent versioned template families", () => {
  it("supplies every specified family with a registered, safe draft starter", () => {
    const templates = listTemplateDefinitions();
    expect(templates.map((item) => item.family).sort()).toEqual(["agent", "brokerage", "landing"]);
    for (const template of templates) {
      const draft = instantiateTemplate(template.code, template.version)!;
      expect(draft.schemaVersion).toBe(template.blockSchemaVersion);
      expect(draft.seo.noindex).toBe(true);
      expect(renderRegisteredBlocks(draft, { approvedLinkOrigins: new Set() })).toContain("<section");
      expect(draft).not.toHaveProperty("publishedRevisionId");
    }
  });
  it("preserves exact version selection and rejects an unknown catalog entry", () => {
    expect(instantiateTemplate("agent-introduction", "2.0.0")).toBeNull();
    expect(instantiateTemplate("unknown", "1.0.0")).toBeNull();
  });
  it("isolates catalog and document edits from later consumers", () => {
    const metadata = listTemplateDefinitions();
    metadata[0].name = "Tenant edit";
    expect(listTemplateDefinitions()[0].name).not.toBe("Tenant edit");
    const draft = instantiateTemplate("agent-introduction", "1.0.0")!;
    draft.blocks[0].props.heading = "Tenant heading";
    expect(instantiateTemplate("agent-introduction", "1.0.0")!.blocks[0].props.heading).not.toBe(
      "Tenant heading",
    );
  });
});
