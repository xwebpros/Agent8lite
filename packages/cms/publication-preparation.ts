import { createHash } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../contracts/openapi.json";
import type {
  CmsPublicationPreparationInputV1,
  PreparedCmsPublicationV1,
} from "../contracts/internal/cms-publication-preparation";
import propertySchemas from "../templates/block-schema-v1.json";
import { listTemplateDefinitions } from "../templates/catalog";
import { isApprovedLink } from "../templates/registry";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Limits = { maxBytes: number; maxNodes: number; maxDepth: number };
type Link = { label: string; href: string };
type Failure =
  | "input_invalid_or_too_large"
  | "snapshot_mismatch"
  | "document_version_invalid"
  | "site_unavailable"
  | "theme_unsupported"
  | "origin_invalid"
  | "route_invalid"
  | "content_unsupported"
  | "link_denied"
  | "content_hash_mismatch"
  | "html_too_large";

const envelopeLimits: Limits = { maxBytes: 1024 * 1024, maxNodes: 22_000, maxDepth: 35 };
const bodyLimits: Limits = { maxBytes: 256 * 1024, maxNodes: 20_000, maxDepth: 32 };
const maxHtmlBytes = 1024 * 1024;
const kinds = ["hero", "text", "cta", "footer"] as const;
const reservedRoutes = new Set(["api", "v1", "dev", "staff", "preview"]);
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** Safe error codes only: never retain or expose the supplied private snapshot. */
export class CmsPublicationPreparationError extends Error {
  constructor(readonly code: Failure) {
    super("The supplied content cannot be prepared for synthetic publication.");
    this.name = "CmsPublicationPreparationError";
  }
}
function deny(code: Failure): never {
  throw new CmsPublicationPreparationError(code);
}
function meter(limits: Limits) {
  let nodes = 0;
  let bytes = 0;
  return {
    node(depth: number) {
      if (++nodes > limits.maxNodes || depth > limits.maxDepth) deny("input_invalid_or_too_large");
    },
    bytes(value: string) {
      bytes += Buffer.byteLength(value, "utf8");
      if (bytes > limits.maxBytes) deny("input_invalid_or_too_large");
    },
  };
}

/** Native proxy detection precedes reflection; descriptors are read without running payload hooks. */
function detach(value: unknown): Json {
  const budget = meter(envelopeLimits);
  const ancestors = new Set<object>();
  function copy(item: unknown, depth: number): Json {
    budget.node(depth);
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      budget.bytes(JSON.stringify(item));
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      budget.bytes(JSON.stringify(item));
      return item;
    }
    if (!item || typeof item !== "object" || types.isProxy(item) || ancestors.has(item))
      deny("input_invalid_or_too_large");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      deny("input_invalid_or_too_large");
    const keys = Reflect.ownKeys(item);
    const length = array ? (Object.getOwnPropertyDescriptor(item, "length")!.value as number) : 0;
    if (
      keys.length > envelopeLimits.maxNodes ||
      (array && (length > envelopeLimits.maxNodes || keys.length !== length + 1))
    )
      deny("input_invalid_or_too_large");
    ancestors.add(item);
    const detached = (array ? [] : Object.create(null)) as { [key: string]: Json };
    Object.setPrototypeOf(detached, null);
    budget.bytes(array ? "[]" : "{}");
    let entries = 0;
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        deny("input_invalid_or_too_large");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
        deny("input_invalid_or_too_large");
      if (entries++) budget.bytes(",");
      if (!array) budget.bytes(`${JSON.stringify(key)}:`);
      detached[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return detached;
  }
  return copy(value, 0);
}

/** Only detached/platform-owned data reaches this serializer. Objects/arrays never go to JSON.stringify. */
function canonicalJson(value: Json, limits: Limits = envelopeLimits): string {
  const budget = meter(limits);
  function serialize(item: Json, depth: number): string {
    budget.node(depth);
    if (item === null || typeof item !== "object") {
      const scalar = JSON.stringify(item);
      budget.bytes(scalar);
      return scalar;
    }
    const entries: string[] = [];
    const array = Array.isArray(item);
    budget.bytes(array ? "[]" : "{}");
    const keys = array ? Object.keys(item) : Object.keys(item).sort();
    for (const key of keys) {
      if (entries.length) budget.bytes(",");
      const prefix = array ? "" : `${JSON.stringify(key)}:`;
      budget.bytes(prefix);
      entries.push(`${prefix}${serialize((item as Record<string, Json>)[key], depth + 1)}`);
    }
    return array ? `[${entries.join(",")}]` : `{${entries.join(",")}}`;
  }
  return serialize(value, 0);
}

const ajv = new Ajv2020({ strict: false, allErrors: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({ $id: "estate:cms-preparation-contract", components: contract.components });
ajv.addSchema(propertySchemas);
const frozenRef = (name: string) => ({ $ref: `estate:cms-preparation-contract#/components/schemas/${name}` });
const inputValidator = ajv.compile({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "command",
    "site",
    "document",
    "revision",
    "revisionContentHash",
    "target",
    "policy",
  ],
  properties: {
    schemaVersion: { const: 1 },
    command: frozenRef("PublishRequest"),
    site: frozenRef("Site"),
    document: frozenRef("Document"),
    revision: frozenRef("Revision"),
    revisionContentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["mode", "origin", "bindingVersion"],
      properties: {
        mode: { const: "synthetic" },
        origin: { type: "string", maxLength: 261 },
        bindingVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["code", "rendererVersion", "approvedLinkOrigins"],
      properties: {
        code: { const: "native-text-links-v1" },
        rendererVersion: { const: "1.0.0" },
        approvedLinkOrigins: {
          type: "array",
          maxItems: 50,
          items: { type: "string", maxLength: 261 },
        },
      },
    },
  },
});
const blockValidators = new Map(
  kinds.map((kind) => [kind, ajv.compile({ $ref: `estate:block-props:v1#/properties/${kind}` })]),
);

function syntheticOrigin(value: string): string {
  // Requiring the original canonical spelling rejects URL-parser normalization and ambiguous authority.
  if (!/^https:\/\/[a-z0-9.-]+$/.test(value)) deny("origin_invalid");
  const hostname = value.slice("https://".length);
  const labels = hostname.split(".");
  if (
    hostname.length > 253 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    (hostname !== "example.test" && !hostname.endsWith(".example.test"))
  )
    deny("origin_invalid");
  try {
    const url = new URL(value);
    if (url.origin !== value || url.href !== `${value}/`) deny("origin_invalid");
  } catch {
    deny("origin_invalid");
  }
  return value;
}
function routeFor(slug: string): string {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(slug) ||
    reservedRoutes.has(slug.split("/")[0])
  )
    deny("route_invalid");
  return `/${slug}`;
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!;
  });
}
function renderLink(link: Link): string {
  return `<a href="${escape(link.href)}" rel="noopener noreferrer">${escape(link.label)}</a>`;
}
function blockLinks(type: string, props: Record<string, unknown>): Link[] {
  if (type === "hero" && props.action) return [props.action as Link];
  if (type === "cta") return [props as Link];
  if (type === "footer") return (props.links as Link[] | undefined) ?? [];
  return [];
}
function renderBlocks(revision: CmsPublicationPreparationInputV1["revision"], origins: ReadonlySet<string>) {
  const identifiers = new Set<string>();
  const fragments: string[] = [];
  for (let index = 0; index < revision.blocks.length; index++) {
    const block = revision.blocks[index];
    const validator = blockValidators.get(block.type as (typeof kinds)[number]);
    const identifier = block.id.toLowerCase();
    if (!validator || identifiers.has(identifier) || block.children?.length || !validator(block.props))
      deny("content_unsupported");
    identifiers.add(identifier);
    const props = block.props;
    const links = blockLinks(block.type, props);
    for (let linkIndex = 0; linkIndex < links.length; linkIndex++)
      if (!isApprovedLink(links[linkIndex].href, { approvedLinkOrigins: origins })) deny("link_denied");
    const attributes = `id="block-${escape(block.id)}" data-block="${escape(block.type)}"`;
    switch (block.type) {
      case "hero":
        fragments.push(
          `<section ${attributes}><h1>${escape(props.heading as string)}</h1>${props.summary ? `<p>${escape(props.summary as string)}</p>` : ""}${props.action ? renderLink(props.action as Link) : ""}</section>`,
        );
        break;
      case "text": {
        const paragraphs = props.paragraphs as string[];
        const rendered: string[] = [];
        for (let paragraph = 0; paragraph < paragraphs.length; paragraph++)
          rendered.push(`<p>${escape(paragraphs[paragraph])}</p>`);
        fragments.push(`<section ${attributes}>${rendered.join("")}</section>`);
        break;
      }
      case "cta":
        fragments.push(`<section ${attributes}>${renderLink(props as Link)}</section>`);
        break;
      case "footer": {
        const rendered: string[] = [];
        for (let link = 0; link < links.length; link++) rendered.push(renderLink(links[link]));
        fragments.push(
          `<footer ${attributes}><p>${escape(props.text as string)}</p>${links.length ? `<nav aria-label="Footer">${rendered.join("")}</nav>` : ""}</footer>`,
        );
        break;
      }
    }
  }
  return fragments.join("\n");
}

// Renderer 1.0.0 owns this stylesheet. Author data cannot select styles, scripts, fonts or assets.
const stylesheet =
  "html{font-family:system-ui,sans-serif;color:#172b3a;background:#fff}body{margin:0}header,main{max-width:64rem;margin:auto;padding:1rem}header{background:#fff4ce;font-weight:700}section,footer{margin-block:2rem}h1{font-size:clamp(1.75rem,5vw,3rem)}p{line-height:1.6;overflow-wrap:anywhere}a{color:#075d82;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #075d82;outline-offset:3px}nav{display:flex;flex-wrap:wrap;gap:1rem}";
const csp = `default-src 'none'; script-src 'none'; style-src 'sha256-${createHash("sha256").update(stylesheet).digest("base64")}'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** Pure synthetic fixture preparation. The caller must independently authorize any later atomic release. */
export function prepareCmsPublication(input: unknown): PreparedCmsPublicationV1 {
  const detached = detach(input);
  if (!inputValidator(detached)) deny("input_invalid_or_too_large");
  const data = detached as unknown as CmsPublicationPreparationInputV1;
  const { command, site, document, revision, target, policy } = data;
  if (
    command.revisionId.toLowerCase() !== revision.id.toLowerCase() ||
    revision.documentId.toLowerCase() !== document.id.toLowerCase() ||
    document.siteId.toLowerCase() !== site.id.toLowerCase()
  )
    deny("snapshot_mismatch");
  if (
    !Number.isSafeInteger(document.version) ||
    document.version >= Number.MAX_SAFE_INTEGER ||
    command.expectedDocumentVersion !== document.version ||
    !Number.isSafeInteger(site.version)
  )
    deny("document_version_invalid");
  if (site.state === "suspended" || site.state === "publishing") deny("site_unavailable");
  if (
    !listTemplateDefinitions().some(
      (template) => `${template.code}@${template.version}` === site.themeVersion,
    )
  )
    deny("theme_unsupported");
  const origin = syntheticOrigin(target.origin);
  const approved = new Set<string>();
  for (let index = 0; index < policy.approvedLinkOrigins.length; index++)
    approved.add(syntheticOrigin(policy.approvedLinkOrigins[index]));
  const canonicalPolicy = Object.freeze({
    code: policy.code,
    rendererVersion: policy.rendererVersion,
    approvedLinkOrigins: Object.freeze([...approved].sort()),
  });
  const policyHash = sha256(canonicalJson(canonicalPolicy as unknown as Json));
  const route = routeFor(document.slug);
  if (revision.seo.canonicalPath !== undefined && revision.seo.canonicalPath !== route) deny("route_invalid");
  if (revision.schemaVersion !== 1 || revision.seo.ogAssetId) deny("content_unsupported");
  const body = { schemaVersion: revision.schemaVersion, blocks: revision.blocks, seo: revision.seo };
  const contentHash = sha256(canonicalJson(body as unknown as Json, bodyLimits));
  if (contentHash !== data.revisionContentHash) deny("content_hash_mismatch");
  const fragment = renderBlocks(revision, approved);
  if (
    [document.title, revision.seo.title, revision.seo.description].some((value) =>
      /[\u0000-\u001f\u007f]/.test(value),
    )
  )
    deny("content_unsupported");
  const canonicalUrl = `${origin}${route}`;
  const seo = Object.freeze(revision.seo);
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(seo.title)}</title><meta name="description" content="${escape(seo.description)}"><meta name="robots" content="${seo.noindex ? "noindex, nofollow" : "index, follow"}"><link rel="canonical" href="${escape(canonicalUrl)}"><style>${stylesheet}</style></head><body><header aria-label="Synthetic fixture">Synthetic publication fixture</header><main>${fragment}</main></body></html>`;
  if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) deny("html_too_large");
  return Object.freeze({
    schemaVersion: 1,
    synthetic: true,
    siteId: site.id,
    documentId: document.id,
    revisionId: revision.id,
    expectedDocumentVersion: document.version,
    nextDocumentVersion: document.version + 1,
    bindingVersion: target.bindingVersion,
    origin,
    route,
    canonicalUrl,
    title: document.title,
    kind: document.kind,
    themeVersion: site.themeVersion,
    seo,
    contentHash,
    policyCode: policy.code,
    rendererVersion: policy.rendererVersion,
    policyHash,
    html,
    htmlHash: sha256(html),
    headers: Object.freeze({
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    }),
  });
}
