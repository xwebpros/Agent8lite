import { describe, expect, it } from "vitest";
import { instantiateTemplate, listTemplateDefinitions } from "../templates/catalog";
import { inspectDraft } from "../templates/registry";
import { browserDocumentVersion, copyBrowserJson, inspectBrowserDraft } from "./browser";

const policy = { approvedLinkOrigins: new Set(["https://trusted.example"]) };
const starter = () => instantiateTemplate("agent-introduction", "1.0.0")!;
describe("browser registered-content adapter", () => {
  it("accepts all exact repository starters with detached JSON and server-equivalent issues", () => {
    for (const template of listTemplateDefinitions()) {
      const draft = instantiateTemplate(template.code, template.version)!;
      const result = inspectBrowserDraft(draft, policy);
      expect(result).toEqual(inspectDraft(draft, policy));
      expect(result.data).not.toBe(draft);
    }
  });
  it.each([
    "/contact",
    "https://trusted.example/contact",
    "https://untrusted.example/contact",
    "javascript:alert(1)",
    "//trusted.example",
    "/%2f%2fevil",
    "/%255csecret",
    "/bad%00path",
    "/bad%",
    "/x\\evil",
    "https://user@trusted.example",
    "http://trusted.example",
  ])("matches trusted server policy for %s", (href) => {
    const draft = starter();
    draft.blocks[0].props.action = { label: "Contact", href };
    expect(inspectBrowserDraft(draft, policy)).toEqual(inspectDraft(draft, policy));
  });
  it("preserves unknown blocks, versions, properties and nested content without making them editable", () => {
    for (const alter of [
      (value: ReturnType<typeof starter>) => {
        value.schemaVersion = 2;
      },
      (value: ReturnType<typeof starter>) => {
        value.blocks.push({
          id: "a2000000-0000-4000-8000-000000000099",
          type: "future_kind" as never,
          props: { nested: { keep: [1, true, "original"] } },
        });
      },
      (value: ReturnType<typeof starter>) => {
        value.blocks[0].props.futureField = "keep";
      },
      (value: ReturnType<typeof starter>) => {
        value.blocks[1].id = value.blocks[0].id;
      },
      (value: ReturnType<typeof starter>) => {
        value.blocks[0].children = [value.blocks[1].id];
      },
      (value: ReturnType<typeof starter>) => {
        value.seo.ogAssetId = "a2000000-0000-4000-8000-000000000099";
      },
      (value: ReturnType<typeof starter>) => {
        value.seo.canonicalPath = "//unsafe.example";
      },
    ]) {
      const draft = starter();
      alter(draft);
      const browser = inspectBrowserDraft(draft, policy);
      expect(browser).toEqual(inspectDraft(draft, policy));
      expect(browser.data).toEqual(draft);
      expect(browser.issues.length).toBeGreaterThan(0);
    }
  });
  it("uses UTF-8 byte limits and rejects executable/cyclic/oversized input without invoking getters", () => {
    let invoked = false;
    const getter = Object.defineProperty({}, "payload", {
      enumerable: true,
      get: () => {
        invoked = true;
        return 1;
      },
    });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const raw of [
      getter,
      cycle,
      { value: Number.NaN },
      { action: () => 1 },
      "界".repeat(90_000),
      Array.from({ length: 20_001 }, () => null),
    ]) {
      expect(() => copyBrowserJson(raw)).toThrow();
      expect(() => inspectDraft(raw, policy)).toThrow();
    }
    expect(invoked).toBe(false);
    expect(copyBrowserJson("界".repeat(80_000))).toHaveLength(80_000);
  });
  it.each(['W/"1"', "1", '"01"', '"0"', '"1", "2"', '"9007199254740992"', "*"])(
    "rejects a non-strong or unsafe document ETag %s",
    (etag) => expect(() => browserDocumentVersion(etag)).toThrow(),
  );
  it("reads a strong safe document ETag", () => expect(browserDocumentVersion('"12"')).toBe(12));
});
