import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CmsPublicationPreparationInputV1 } from "../contracts/internal/cms-publication-preparation";
import { instantiateTemplate, listTemplateDefinitions } from "../templates/catalog";
import { renderRegisteredBlocks } from "../templates/registry";
import { prepareDraft } from "./drafts";
import { CmsPublicationPreparationError, prepareCmsPublication } from "./publication-preparation";

type Mutable<T> = T extends object ? { -readonly [P in keyof T]: Mutable<T[P]> } : T;
type Fixture = Mutable<CmsPublicationPreparationInputV1>;
const siteId = "a8000000-0000-4000-8000-000000000001";
const documentId = "a8000000-0000-4000-8000-000000000002";
const revisionId = "a8000000-0000-4000-8000-000000000003";
const otherId = "a8000000-0000-4000-8000-000000000009";
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function body(input: Fixture) {
  return {
    schemaVersion: input.revision.schemaVersion,
    blocks: input.revision.blocks,
    seo: input.revision.seo,
  };
}
function rehash(input: Fixture): Fixture {
  input.revisionContentHash = hash(canonical(body(input)));
  return input;
}
function fixture(): Fixture {
  const starter = instantiateTemplate("agent-introduction", "1.0.0")!;
  return rehash({
    schemaVersion: 1,
    command: { revisionId, expectedDocumentVersion: 7 },
    site: {
      id: siteId,
      name: "Private synthetic site",
      businessProfileId: otherId,
      state: "draft",
      themeVersion: "agent-introduction@1.0.0",
      version: 3,
    },
    document: { id: documentId, siteId, slug: "about/team", kind: "agent", title: "Our team", version: 7 },
    revision: { ...starter, id: revisionId, documentId, createdAt: "2026-10-10T12:00:00Z" },
    revisionContentHash: "",
    target: { mode: "synthetic", origin: "https://site.example.test", bindingVersion: 4 },
    policy: { code: "native-text-links-v1", rendererVersion: "1.0.0", approvedLinkOrigins: [] },
  });
}
function rejected(input: unknown, code?: string) {
  let caught: unknown;
  try {
    prepareCmsPublication(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CmsPublicationPreparationError);
  if (code) expect(caught).toMatchObject({ code });
  return caught as CmsPublicationPreparationError;
}

describe("pure synthetic CMS publication preparation", () => {
  it("projects an immutable complete candidate, without private metadata or revision JSON", () => {
    const input = fixture();
    const before = structuredClone(input);
    const output = prepareCmsPublication(input);
    expect(output).toMatchObject({
      schemaVersion: 1,
      synthetic: true,
      siteId,
      documentId,
      revisionId,
      expectedDocumentVersion: 7,
      nextDocumentVersion: 8,
      bindingVersion: 4,
      origin: "https://site.example.test",
      route: "/about/team",
      canonicalUrl: "https://site.example.test/about/team",
      title: "Our team",
      kind: "agent",
      themeVersion: "agent-introduction@1.0.0",
      policyCode: "native-text-links-v1",
      rendererVersion: "1.0.0",
      contentHash: input.revisionContentHash,
      htmlHash: hash(output.html),
    });
    expect(input).toEqual(before);
    expect(Object.keys(output).sort()).toEqual(
      [
        "schemaVersion",
        "synthetic",
        "siteId",
        "documentId",
        "revisionId",
        "expectedDocumentVersion",
        "nextDocumentVersion",
        "bindingVersion",
        "origin",
        "route",
        "canonicalUrl",
        "title",
        "kind",
        "themeVersion",
        "seo",
        "contentHash",
        "policyCode",
        "rendererVersion",
        "policyHash",
        "html",
        "htmlHash",
        "headers",
      ].sort(),
    );
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.seo)).toBe(true);
    expect(Object.isFrozen(output.headers)).toBe(true);
    expect(output.seo).not.toBe(input.revision.seo);
    expect(output.html).toMatch(/^<!doctype html>\n<html lang="en"><head>/);
    expect(output.html).toContain("Synthetic publication fixture");
    expect(output.html).toContain("<main>");
    expect(output.html).toMatch(/<\/main><\/body><\/html>$/);
    expect(output.html).not.toContain(input.site.name);
    expect(output.html).not.toContain(input.site.businessProfileId);
    expect(JSON.stringify(output)).not.toContain("createdAt");
    input.document.slug = "changed";
    input.document.title = "Changed";
    input.revision.seo.title = "Changed";
    input.revision.blocks[0].props.heading = "Changed";
    input.target.bindingVersion = 9;
    expect(output.route).toBe("/about/team");
    expect(output.title).toBe("Our team");
    expect(output.seo.title).toBe(before.revision.seo.title);
    expect(output.html).not.toContain("Changed");
    expect(output.bindingVersion).toBe(4);
  });

  it("uses no-store headers and a pinned hashed stylesheet with script-free CSP", () => {
    const output = prepareCmsPublication(fixture());
    expect(output.headers).toMatchObject({
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    const styles = /<style>(.*?)<\/style>/.exec(output.html)![1];
    const styleHash = createHash("sha256").update(styles).digest("base64");
    const csp = output.headers["Content-Security-Policy"];
    expect(csp).toContain(`style-src 'sha256-${styleHash}'`);
    for (const directive of [
      "default-src",
      "script-src",
      "img-src",
      "font-src",
      "connect-src",
      "object-src",
      "base-uri",
      "form-action",
      "frame-ancestors",
    ])
      expect(csp).toContain(`${directive} 'none'`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https:|\*/);
    expect(output.html).not.toMatch(/<script|<img|<iframe|<form|style=|onload=|onclick=/i);
  });

  it.each(listTemplateDefinitions())(
    "uses exact registered theme $code@$version and unchanged v1 fragment semantics",
    (template) => {
      const input = fixture();
      const starter = instantiateTemplate(template.code, template.version)!;
      input.site.themeVersion = `${template.code}@${template.version}`;
      input.revision = { ...input.revision, ...starter };
      rehash(input);
      const output = prepareCmsPublication(input);
      expect(output.themeVersion).toBe(input.site.themeVersion);
      expect(output.contentHash).toBe(
        prepareDraft(body(input), { approvedLinkOrigins: new Set() }).contentHash,
      );
      expect(output.html).toContain(renderRegisteredBlocks(body(input), { approvedLinkOrigins: new Set() }));
    },
  );

  it("escapes metadata and every rendered text/link field and honors canonical/noindex SEO", () => {
    const input = fixture();
    input.document.title = "Private title <&\"'";
    input.revision.seo = {
      title: "<title>&\"'",
      description: "Description <&\"'",
      noindex: false,
      canonicalPath: "/about/team",
      ogAssetId: null,
    };
    input.policy.approvedLinkOrigins = ["https://links.example.test"];
    input.revision.blocks = [
      {
        id: otherId,
        type: "hero",
        props: {
          heading: "Hero &\"'",
          summary: "Summary &\"'",
          action: { label: "Action &\"'", href: "https://links.example.test/go?a=1&b=2" },
        },
      },
      { id: revisionId, type: "text", props: { paragraphs: ["Text &\"'"] } },
      { id: documentId, type: "cta", props: { label: "CTA &\"'", href: "/contact?a=1&b=2" } },
      {
        id: siteId,
        type: "footer",
        props: { text: "Footer &\"'", links: [{ label: "Link &\"'", href: "/privacy" }] },
      },
    ];
    const output = prepareCmsPublication(rehash(input));
    expect(output.title).toBe(input.document.title);
    expect(output.html).toContain("<title>&lt;title&gt;&amp;&quot;&#39;</title>");
    for (const text of ["Hero", "Summary", "Action", "Text", "CTA", "Footer", "Link"])
      expect(output.html).toContain(`${text} &amp;&quot;&#39;`);
    expect(output.html).toContain('content="Description &lt;&amp;&quot;&#39;"');
    expect(output.html).toContain('href="https://links.example.test/go?a=1&amp;b=2"');
    expect(output.html).toContain('href="/contact?a=1&amp;b=2"');
    expect(output.html).toContain('rel="canonical" href="https://site.example.test/about/team"');
    expect(output.html).toContain('content="index, follow"');
    expect(prepareCmsPublication(fixture()).html).toContain('content="noindex, nofollow"');
  });

  it("hashes the canonical sorted unique policy, preserving content/HTML hash semantics", () => {
    const first = fixture();
    first.policy.approvedLinkOrigins = [
      "https://z.example.test",
      "https://a.example.test",
      "https://z.example.test",
    ];
    const second = structuredClone(first);
    second.policy.approvedLinkOrigins = ["https://a.example.test", "https://z.example.test"];
    const a = prepareCmsPublication(first);
    const b = prepareCmsPublication(second);
    expect(a.policyHash).toBe(
      hash(
        canonical({
          code: "native-text-links-v1",
          rendererVersion: "1.0.0",
          approvedLinkOrigins: second.policy.approvedLinkOrigins,
        }),
      ),
    );
    expect(a).toEqual(b);
    first.policy.approvedLinkOrigins = [];
    expect(prepareCmsPublication(first).policyHash).not.toBe(a.policyHash);
    first.document.title = "Another title";
    first.target.bindingVersion = 5;
    first.document.slug = "other";
    const changed = prepareCmsPublication(first);
    expect(changed.contentHash).toBe(a.contentHash);
    expect(changed.htmlHash).not.toBe(a.htmlHash);
    expect(changed).toMatchObject({ title: "Another title", route: "/other", bindingVersion: 5 });
  });

  it("keeps array order semantic while object key order is canonical", () => {
    const input = fixture();
    const output = prepareCmsPublication(input);
    input.revision.blocks[0] = {
      props: input.revision.blocks[0].props,
      type: input.revision.blocks[0].type,
      id: input.revision.blocks[0].id,
    };
    expect(prepareCmsPublication(input)).toEqual(output);
    input.revision.blocks.reverse();
    rejected(input, "content_hash_mismatch");
    const changed = prepareCmsPublication(rehash(input));
    expect(changed.contentHash).not.toBe(output.contentHash);
    expect(changed.htmlHash).not.toBe(output.htmlHash);
  });

  it("matches UUID identities case-insensitively and allows consistent draft/published snapshots", () => {
    const input = fixture();
    input.command.revisionId = revisionId.toUpperCase();
    input.revision.documentId = documentId.toUpperCase();
    input.document.siteId = siteId.toUpperCase();
    input.site.state = "published";
    input.site.publishedAt = "2026-10-10T11:00:00Z";
    input.document.publishedRevisionId = otherId;
    expect(prepareCmsPublication(input)).toMatchObject({
      synthetic: true,
      revisionId,
      nextDocumentVersion: 8,
    });
    input.document.version = Number.MAX_SAFE_INTEGER - 1;
    input.command.expectedDocumentVersion = input.document.version;
    input.target.bindingVersion = Number.MAX_SAFE_INTEGER;
    expect(prepareCmsPublication(input).nextDocumentVersion).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(["command", "site", "document", "revision", "target", "policy", "envelope"])(
    "rejects additional %s fields",
    (field) => {
      const input = fixture();
      const target = field === "envelope" ? input : input[field as keyof Fixture];
      Object.assign(target as object, { privateUnrecognized: "secret" });
      const error = rejected(input, "input_invalid_or_too_large");
      expect(error.message).not.toContain("secret");
      expect(Object.keys(error)).not.toContain("input");
    },
  );

  it.each([
    (input: Fixture) => {
      input.command.revisionId = otherId;
    },
    (input: Fixture) => {
      input.revision.documentId = otherId;
    },
    (input: Fixture) => {
      input.document.siteId = otherId;
    },
  ])("denies mismatched source identity %#", (change) => {
    const input = fixture();
    change(input);
    rejected(input, "snapshot_mismatch");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "denies document version %s",
    (version) => {
      const input = fixture();
      input.document.version = version;
      input.command.expectedDocumentVersion = version;
      rejected(input);
    },
  );
  it("denies stale expected document versions and unsafe site versions", () => {
    const input = fixture();
    input.command.expectedDocumentVersion--;
    rejected(input, "document_version_invalid");
    input.command.expectedDocumentVersion++;
    input.site.version = Number.MAX_SAFE_INTEGER + 1;
    rejected(input, "document_version_invalid");
  });
  it.each(["suspended", "publishing"] as const)("denies %s sites", (state) => {
    const input = fixture();
    input.site.state = state;
    rejected(input, "site_unavailable");
  });
  it.each(["agent-introduction", "agent-introduction@2.0.0", "unknown@1.0.0", "agent-introduction@1.0.0 "])(
    "denies theme %s without fallback",
    (theme) => {
      const input = fixture();
      input.site.themeVersion = theme;
      rejected(input, "theme_unsupported");
    },
  );

  const deniedOrigins = [
    "https://xn--a.example.test",
    `https://${"a".repeat(64)}.example.test`,
    "http://site.example.test",
    "https://site.example.com",
    "https://example.test.evil.test",
    "https://site.example.test/",
    "https://site.example.test/path",
    "https://site.example.test?x=1",
    "https://site.example.test#fragment",
    "https://user@site.example.test",
    "https://user:pass@site.example.test",
    "https://site.example.test:444",
    "https://site.example.test:443",
    "https://site.example.test.",
    "https://SITE.example.test",
    "HTTPS://site.example.test",
    "https://%73ite.example.test",
    "https://127.0.0.1",
    "https://[::1]",
    "https://site..example.test",
    "https://-site.example.test",
    "https://site-.example.test",
    "https://sité.example.test",
    "https://site.example.test\\evil",
    " https://site.example.test",
    "https://site.example.test\n",
    "https://site_example.test",
  ];
  it.each(deniedOrigins)("denies noncanonical target and approved origin %s", (origin) => {
    const input = fixture();
    input.target.origin = origin;
    rejected(input, "origin_invalid");
    input.target.origin = "https://site.example.test";
    input.policy.approvedLinkOrigins = [origin];
    rejected(input, "origin_invalid");
  });
  it.each(["https://example.test", "https://a.b.example.test"])(
    "accepts canonical fixture origin %s",
    (origin) => {
      const input = fixture();
      input.target.origin = origin;
      expect(prepareCmsPublication(input).origin).toBe(origin);
    },
  );
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("denies binding version %s", (version) => {
    const input = fixture();
    input.target.bindingVersion = version;
    rejected(input, "input_invalid_or_too_large");
  });
  it("denies unknown policy/mode/version and bounds raw origin count before deduplication", () => {
    const input = fixture();
    Object.assign(input.policy, { code: "other" });
    rejected(input);
    input.policy.code = "native-text-links-v1";
    Object.assign(input.policy, { rendererVersion: "2.0.0" });
    rejected(input);
    input.policy.rendererVersion = "1.0.0";
    Object.assign(input.target, { mode: "live" });
    rejected(input);
    input.target.mode = "synthetic";
    input.policy.approvedLinkOrigins = Array(51).fill("https://example.test");
    rejected(input);
    input.policy.approvedLinkOrigins.pop();
    expect(prepareCmsPublication(input).policyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    "",
    "/",
    "/about",
    "about/",
    "about//team",
    ".",
    "..",
    "about/../team",
    "About",
    "about_team",
    "about?x=1",
    "about#x",
    "about%2fteam",
    "about\\team",
    "-about",
    "about-",
    "api",
    "api/users",
    "v1/sites",
    "dev/editor",
    "staff",
    "preview/token",
  ])("denies route slug %s", (slug) => {
    const input = fixture();
    input.document.slug = slug;
    rejected(input, "route_invalid");
  });
  it("bounds slug and requires exact canonical path", () => {
    const input = fixture();
    input.document.slug = "a".repeat(160);
    expect(prepareCmsPublication(input).route).toHaveLength(161);
    input.document.slug += "a";
    rejected(input);
    input.document.slug = "about/team";
    input.revision.seo.canonicalPath = "/other";
    rejected(rehash(input), "route_invalid");
    input.revision.seo.canonicalPath = "/about/team";
    expect(prepareCmsPublication(rehash(input)).canonicalUrl).toBe("https://site.example.test/about/team");
  });

  it.each(["image", "agent", "testimonials", "community", "listing_grid", "search", "form", "map"] as const)(
    "rejects unavailable %s content without altering recovery data",
    (type) => {
      const input = fixture();
      input.revision.blocks[0].type = type;
      rehash(input);
      const before = structuredClone(input);
      rejected(input, "content_unsupported");
      expect(input).toEqual(before);
    },
  );
  it("rejects future schemas, nested children, duplicate IDs, media and unknown block properties", () => {
    const input = fixture();
    input.revision.schemaVersion = 2;
    rejected(rehash(input), "content_unsupported");
    input.revision.schemaVersion = 1;
    input.revision.blocks[0].children = [otherId];
    rejected(rehash(input), "content_unsupported");
    delete input.revision.blocks[0].children;
    input.revision.blocks[1].id = input.revision.blocks[0].id.toUpperCase();
    rejected(rehash(input), "content_unsupported");
    input.revision.blocks[1].id = otherId;
    input.revision.seo.ogAssetId = otherId;
    rejected(rehash(input), "content_unsupported");
    input.revision.seo.ogAssetId = null;
    input.revision.blocks[0].props.css = "color:red";
    rejected(rehash(input), "content_unsupported");
  });
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://links.example.test",
    "https://evil.test/path",
    "//evil.test/path",
    "https://user@links.example.test",
    "/%2f%2fevil.test",
    "/%252f%252fevil.test",
    "/bad\\path",
  ])("rejects unsafe/unapproved href %s", (href) => {
    const input = fixture();
    input.policy.approvedLinkOrigins = ["https://links.example.test"];
    input.revision.blocks = [{ id: otherId, type: "cta", props: { label: "Go", href } }];
    rejected(rehash(input), "link_denied");
  });
  it.each(["hero", "text", "cta", "footer"] as const)(
    "rejects executable markup in %s properties",
    (type) => {
      const input = fixture();
      const props = {
        hero: { heading: "<script>alert(1)</script>" },
        text: { paragraphs: ["<img onerror=alert(1)>"] },
        cta: { label: "<b>Go</b>", href: "/go" },
        footer: { text: "<iframe>" },
      }[type];
      input.revision.blocks = [{ id: otherId, type, props }];
      rejected(rehash(input), "content_unsupported");
    },
  );
  it("rejects missing/invalid frozen properties, control metadata and a mismatched stored hash", () => {
    const input = fixture();
    input.revisionContentHash = "0".repeat(64);
    rejected(input, "content_hash_mismatch");
    rehash(input);
    input.revision.createdAt = "not-a-date";
    rejected(input);
    input.revision.createdAt = "2026-10-10T12:00:00Z";
    input.revision.seo.title = "bad\u0000title";
    rejected(rehash(input), "content_unsupported");
    delete (input.command as Partial<Fixture["command"]>).revisionId;
    rejected(input);
  });

  it("accepts a full draft body at 256 KiB and rejects a body one UTF-8 byte larger independently of its envelope", () => {
    const input = fixture();
    input.revision.blocks = Array.from({ length: 2 }, (_, index) => ({
      id: index ? otherId : revisionId,
      type: "text" as const,
      props: { paragraphs: Array(50).fill("é".repeat(1250)) },
    }));
    const paragraphs = input.revision.blocks[1].props.paragraphs as string[];
    paragraphs.fill("", 30);
    const available = 256 * 1024 - Buffer.byteLength(canonical(body(input)));
    expect(available).toBeGreaterThan(0);
    // Each paragraph stays within the repository's 4,000-character property limit.
    let remaining = available;
    for (let index = 30; remaining; index++) {
      const length = Math.min(remaining, 4000);
      paragraphs[index] = "a".repeat(length);
      remaining -= length;
    }
    rehash(input);
    expect(Buffer.byteLength(canonical(body(input)))).toBe(256 * 1024);
    expect(prepareCmsPublication(input).contentHash).toBe(input.revisionContentHash);
    paragraphs[49] += "a";
    rejected(rehash(input), "input_invalid_or_too_large");
  });
  it("bounds escaped HTML separately from accepted draft bytes", () => {
    const input = fixture();
    input.revision.blocks = Array.from({ length: 2 }, (_, index) => ({
      id: index ? otherId : revisionId,
      type: "text" as const,
      props: { paragraphs: Array(30).fill("&".repeat(4000)) },
    }));
    expect(Buffer.byteLength(canonical(body(input)))).toBeLessThan(256 * 1024);
    rejected(rehash(input), "html_too_large");
  });
  it("bounds input depth, node count and UTF-8 bytes before schema validation", () => {
    const deep = fixture();
    let nested: Record<string, unknown> = {};
    deep.revision.blocks[0].props.unknown = nested;
    for (let index = 0; index < 40; index++) {
      const next = {};
      nested.child = next;
      nested = next;
    }
    rejected(deep, "input_invalid_or_too_large");
    const nodes = fixture();
    nodes.revision.blocks[0].props.unknown = Array(22_000).fill(0);
    rejected(nodes, "input_invalid_or_too_large");
    const bytes = fixture();
    bytes.document.title = "é".repeat(600_000);
    rejected(bytes, "input_invalid_or_too_large");
  });
});

describe("publication preparation own-data isolation", () => {
  it.each(["root", "object", "array"])("rejects %s proxies before any trap executes", (location) => {
    const input = fixture();
    let executions = 0;
    const trap = () => {
      executions++;
      throw new Error("Payload executed");
    };
    const target =
      location === "array" ? input.revision.blocks : location === "object" ? input.revision.seo : input;
    const proxy = new Proxy(target, {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    if (location === "array") input.revision.blocks = proxy as Fixture["revision"]["blocks"];
    if (location === "object") input.revision.seo = proxy as Fixture["revision"]["seo"];
    rejected(location === "root" ? proxy : input, "input_invalid_or_too_large");
    expect(executions).toBe(0);
  });
  it("rejects revoked proxies without reflecting on them", () => {
    const proxy = Proxy.revocable(fixture(), {});
    proxy.revoke();
    rejected(proxy.proxy, "input_invalid_or_too_large");
  });
  it.each([
    "getter",
    "setter",
    "toJSON",
    "symbol",
    "hidden",
    "cycle",
    "function",
    "undefined",
    "bigint",
    "nan",
    "infinity",
    "date",
    "class",
  ])("rejects %s values without executing hooks", (kind) => {
    const input = fixture();
    let executions = 0;
    const props = input.revision.blocks[0].props;
    const hook = () => {
      executions++;
      return "executed";
    };
    switch (kind) {
      case "getter":
        Object.defineProperty(props, "heading", { enumerable: true, get: hook });
        break;
      case "setter":
        Object.defineProperty(props, "heading", { enumerable: true, set: hook });
        break;
      case "toJSON":
        Object.assign(props, { toJSON: hook });
        break;
      case "symbol":
        Object.assign(props, { [Symbol("hidden")]: 1 });
        break;
      case "hidden":
        Object.defineProperty(props, "hidden", { value: 1 });
        break;
      case "cycle":
        props.self = props;
        break;
      case "function":
        props.unknown = hook;
        break;
      case "undefined":
        props.unknown = undefined;
        break;
      case "bigint":
        props.unknown = 1n;
        break;
      case "nan":
        props.unknown = NaN;
        break;
      case "infinity":
        props.unknown = Infinity;
        break;
      case "date":
        props.unknown = new Date();
        break;
      case "class":
        props.unknown = new (class Payload {})();
        break;
    }
    rejected(input, "input_invalid_or_too_large");
    expect(executions).toBe(0);
  });
  it.each(["hole", "property", "symbol", "prototype", "accessor"])(
    "rejects array %s without normalization or hooks",
    (kind) => {
      const input = fixture();
      const blocks = input.revision.blocks;
      let executions = 0;
      if (kind === "hole") delete blocks[0];
      if (kind === "property") Object.assign(blocks, { extra: "hidden" });
      if (kind === "symbol") Object.assign(blocks, { [Symbol("hidden")]: 1 });
      if (kind === "prototype")
        Object.setPrototypeOf(blocks, {
          get toJSON() {
            executions++;
            throw new Error();
          },
        });
      if (kind === "accessor")
        Object.defineProperty(blocks, "0", {
          enumerable: true,
          get() {
            executions++;
            throw new Error();
          },
        });
      rejected(input, "input_invalid_or_too_large");
      expect(executions).toBe(0);
    },
  );
  it("detaches null-prototype own-data objects without interpreting inherited fields", () => {
    const input = fixture();
    Object.setPrototypeOf(input, null);
    Object.setPrototypeOf(input.revision.seo, null);
    expect(prepareCmsPublication(input).contentHash).toBe(input.revisionContentHash);
    const inherited = fixture();
    Object.setPrototypeOf(inherited.command, { revisionId });
    delete (inherited.command as Partial<Fixture["command"]>).revisionId;
    rejected(inherited, "input_invalid_or_too_large");
  });
  it("never executes inherited toJSON or optional field getters during preparation", () => {
    const input = fixture();
    let executions = 0;
    let output: ReturnType<typeof prepareCmsPublication> | undefined;
    let failure: unknown;
    const objectKeys = ["toJSON", "children", "action", "links", "canonicalPath", "ogAssetId"];
    const saved = objectKeys.map(
      (key) => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
    );
    const savedArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      for (const key of objectKeys)
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            executions++;
            throw new Error("Inherited hook executed");
          },
        });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        get() {
          executions++;
          throw new Error("Array hook executed");
        },
      });
      try {
        output = prepareCmsPublication(input);
      } catch (error) {
        failure = error;
      }
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else Reflect.deleteProperty(Object.prototype, key);
      }
      if (savedArray) Object.defineProperty(Array.prototype, "toJSON", savedArray);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(executions).toBe(0);
    expect(failure).toBeUndefined();
    expect(output?.contentHash).toBe(input.revisionContentHash);
  });
});
