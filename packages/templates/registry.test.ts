import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContentValidationError,
  inspectDraft,
  isApprovedLink,
  renderRegisteredBlocks,
  validateForPublication,
} from "./registry";

const policy = { approvedLinkOrigins: new Set(["https://approved.example.test"]) };
const revision = () => ({
  schemaVersion: 1,
  blocks: [
    {
      id: randomUUID(),
      type: "hero",
      props: {
        heading: 'Find a home & build "your" future',
        action: { label: "Contact", href: "/contact?from=home&kind=buyer" },
      },
    },
    { id: randomUUID(), type: "text", props: { paragraphs: ["Original independent content."] } },
    {
      id: randomUUID(),
      type: "cta",
      props: { label: "Learn more", href: "https://approved.example.test/about" },
    },
    {
      id: randomUUID(),
      type: "footer",
      props: { text: "Fictional brokerage", links: [{ label: "Privacy", href: "/privacy" }] },
    },
  ],
  seo: {
    title: "Synthetic homes",
    description: "Independent template",
    canonicalPath: "/homes",
    noindex: true,
  },
});

describe("platform-owned content registry", () => {
  it("renders registered semantic blocks with escaped text/attributes and no executable content", () => {
    const html = renderRegisteredBlocks(revision(), policy);
    expect(html).toContain("Find a home &amp; build &quot;your&quot; future");
    expect(html).toContain('href="/contact?from=home&amp;kind=buyer"');
    expect(html).toContain('<nav aria-label="Footer">');
    expect(html).not.toMatch(/<script|style=|onclick=|<iframe/);
  });
  it("retains future versions/kinds unchanged for recovery but denies their publication", () => {
    const future = {
      schemaVersion: 7,
      blocks: [{ id: randomUUID(), type: "future", props: { raw: "retained" } }],
    };
    const inspected = inspectDraft(future, policy);
    expect(inspected.data).toEqual(future);
    expect(inspected.data).not.toBe(future);
    expect(() => validateForPublication(future, policy)).toThrow(ContentValidationError);
    const knownVersion = { ...future, schemaVersion: 1, seo: revision().seo };
    expect(inspectDraft(knownVersion, policy).issues).toContainEqual({
      path: "/blocks/0",
      code: "block_not_registered",
    });
    expect(() => renderRegisteredBlocks(knownVersion, policy)).toThrow(ContentValidationError);
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "//evil.example",
    "/\\evil.example",
    "/%2f%2fevil.example",
    "/%252f%252fevil.example",
    "/%0aevil",
    "https://approved.example.test@evil.example/",
    "https://user:secret@approved.example.test/",
    "http://approved.example.test/",
    "https://unapproved.example.test/",
    'https://approved.example.test/"onclick=bad',
    "https://approved.example.test/%zz",
  ])("denies unsafe or unapproved link %s", (href) => {
    expect(isApprovedLink(href, policy)).toBe(false);
    const value = revision();
    value.blocks[2].props.href = href;
    expect(() => renderRegisteredBlocks(value, policy)).toThrow(ContentValidationError);
  });
  it("rejects tenant HTML, executable properties and unsupported nesting without mutating the input", () => {
    const value: any = revision();
    value.blocks[0].props.heading = '<img src=x onerror="alert(1)">';
    value.blocks[0].props.style = "expression(bad)";
    value.blocks[0].children = [value.blocks[1].id];
    const before = structuredClone(value);
    const issues = inspectDraft(value, policy).issues;
    expect(issues.some((issue) => issue.code === "block_properties_invalid")).toBe(true);
    expect(issues.some((issue) => issue.code === "nested_blocks_unsupported")).toBe(true);
    expect(value).toEqual(before);
    expect(JSON.stringify(issues)).not.toContain("onerror");
  });
  it("rejects duplicate block IDs, cross-origin canonicals, media without rights and oversize documents", () => {
    const value: any = revision();
    value.blocks[1].id = value.blocks[0].id;
    value.seo.canonicalPath = "https://approved.example.test/homes";
    value.seo.ogAssetId = randomUUID();
    expect(inspectDraft(value, policy).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "block_id_duplicate",
        "canonical_path_invalid",
        "media_publication_unavailable",
      ]),
    );
    value.blocks[1].props.paragraphs = ["x".repeat(300_000)];
    expect(() => inspectDraft(value, policy)).toThrow(ContentValidationError);
  });
  it("returns detached validated data and rejects an invalid edit on every later render", () => {
    const value = revision();
    const valid = validateForPublication(value, policy);
    value.blocks[0].props.heading = "Changed original";
    expect(valid.blocks[0].props.heading).not.toBe("Changed original");
    valid.blocks[2].props.href = "javascript:alert(1)";
    expect(() => renderRegisteredBlocks(valid, policy)).toThrow(ContentValidationError);
  });
  it("retains malformed block kinds as recoverable JSON without coercing untrusted objects", () => {
    const value: any = revision();
    value.blocks[0].type = { toString: null };
    const inspected = inspectDraft(value, policy);
    expect(inspected.data).toEqual(value);
    expect(inspected.issues).toContainEqual({ path: "/blocks/0", code: "block_not_registered" });
    expect(() => validateForPublication(value, policy)).toThrow(ContentValidationError);
  });
  it("rejects non-JSON executable values, cycles and excessive depth without calling a getter", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get: () => {
        getterCalls++;
        return 1;
      },
    });
    const cyclic: any = {};
    cyclic.self = cyclic;
    let deep: any = {};
    for (let index = 0; index < 40; index++) deep = { child: deep };
    for (const value of [accessor, cyclic, deep, { callback: () => "script" }, { invalid: NaN }, new Date()])
      expect(() => inspectDraft(value, policy)).toThrow(ContentValidationError);
    expect(getterCalls).toBe(0);
  });
});
