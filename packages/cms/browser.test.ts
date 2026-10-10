import { describe, expect, it } from "vitest";
import { instantiateTemplate, listTemplateDefinitions } from "../templates/catalog";
import { inspectDraft } from "../templates/registry";
import {
  BrowserContentError,
  browserDocumentVersion,
  copyBrowserJson,
  inspectBrowserDraft,
  requireBrowserShape,
} from "./browser";

const policy = { approvedLinkOrigins: new Set(["https://trusted.example"]) };
const starter = () => instantiateTemplate("agent-introduction", "1.0.0")!;
function boundaryDraft(bytes: number) {
  const draft = starter();
  const paragraphs = [...Array.from({ length: 42 }, () => "界".repeat(2000)), ""];
  draft.blocks = [{ id: draft.blocks[0].id, type: "text", props: { paragraphs } }];
  const remaining = bytes - new TextEncoder().encode(JSON.stringify(draft)).byteLength;
  paragraphs[42] = "界".repeat(Math.floor(remaining / 3)) + "x".repeat(remaining % 3);
  return draft;
}
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
  it.each([0, 1, 2])("rejects an array hole at index %s without substituting null", (index) => {
    const value = ["first", "second", "third"];
    delete value[index];
    expect(() => copyBrowserJson(value)).toThrow(BrowserContentError);
    expect(Object.hasOwn(value, index)).toBe(false);
    expect(value.length).toBe(3);
  });
  it.each(["extra", "01"])("rejects array property %s without silently discarding it", (key) => {
    const value = ["keep"];
    Object.defineProperty(value, key, { enumerable: true, value: "original data" });
    expect(() => copyBrowserJson(value)).toThrow(BrowserContentError);
    expect(Object.getOwnPropertyDescriptor(value, key)?.value).toBe("original data");
  });
  it("rejects custom array prototypes without reading their JSON hooks", () => {
    let reads = 0;
    const value = ["original"];
    Object.setPrototypeOf(
      value,
      Object.create(Array.prototype, {
        toJSON: {
          get: () => {
            reads++;
            return () => ["replacement"];
          },
        },
      }),
    );
    expect(() => copyBrowserJson(value)).toThrow(BrowserContentError);
    expect(reads).toBe(0);
    class ArraySubclass extends Array {}
    expect(() => copyBrowserJson(new ArraySubclass())).toThrow(BrowserContentError);
    expect(() => copyBrowserJson(Object.setPrototypeOf([], null))).toThrow(BrowserContentError);
  });
  it.each([
    ["array", Array.prototype],
    ["object", Object.prototype],
  ] as const)(
    "copies original JSON without invoking inherited %s serialization hooks",
    (_kind, prototype) => {
      const value = { nested: ["original", { toJSON: "harmless metadata" }] };
      let reads = 0;
      let calls = 0;
      let copied: typeof value | undefined;
      const previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          get: () => {
            reads++;
            return () => {
              calls++;
              return "replacement";
            };
          },
        });
        copied = copyBrowserJson(value);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(reads).toBe(0);
      expect(calls).toBe(0);
      expect(copied).toEqual(value);
      expect(copied).not.toBe(value);
    },
  );
  it("preserves dense arrays and prototype-named plain JSON fields in detached copies", () => {
    const value = JSON.parse('{"__proto__":{"keep":true},"toJSON":"metadata","items":[null,["",false,0]]}');
    const copied = copyBrowserJson(value);
    expect(copied).toEqual(value);
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    copied.items[1][0] = "changed";
    expect(value.items[1][0]).toBe("");
  });
  it("accepts a frozen revision with a complete 256 KiB draft plus its identity metadata", () => {
    const draft = boundaryDraft(256 * 1024);
    expect(inspectBrowserDraft(draft, policy).issues).toEqual([]);
    const value = {
      ...draft,
      id: "a2000000-0000-4000-8000-000000000090",
      documentId: "a2000000-0000-4000-8000-000000000010",
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    expect(new TextEncoder().encode(JSON.stringify(draft)).byteLength).toBe(256 * 1024);
    const copied = requireBrowserShape("Revision", value);
    expect(copied).toEqual(value);
    expect(copied).not.toBe(value);
    expect(copied.blocks).not.toBe(value.blocks);
  });
  it("keeps the independent draft byte limit inside the revision metadata allowance", () => {
    const value = {
      ...boundaryDraft(256 * 1024 + 1),
      id: "a2000000-0000-4000-8000-000000000090",
      documentId: "a2000000-0000-4000-8000-000000000010",
      createdAt: "2026-10-10T00:00:00.000Z",
    };
    expect(() => requireBrowserShape("Revision", value)).toThrow(BrowserContentError);
  });
});
