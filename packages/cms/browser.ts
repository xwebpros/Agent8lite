// Browser entry point: never import the server CMS index or template renderer here.
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../contracts/openapi.json";
import type { components } from "../contracts/generated/api";
import propertySchemas from "../templates/block-schema-v1.json";

export type BrowserDraft = components["schemas"]["RevisionWrite"];
export type BrowserRevision = components["schemas"]["Revision"];
export type BrowserIssue = { path: string; code: string };
export type BrowserLinkPolicy = { approvedLinkOrigins: ReadonlySet<string> };
// Pin this client adapter to the fields it can preserve/edit/preview completely.
// A future server schema entry must not silently enable a block without a browser renderer.
export const fieldBlockKinds = Object.freeze(["hero", "text", "cta", "footer"] as const);
export type FieldBlockKind = (typeof fieldBlockKinds)[number];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "estate:browser-content", components: contract.components });
ajv.addSchema(propertySchemas);
const validators = new Map<string, ValidateFunction>(
  fieldBlockKinds.map((type) => [type, ajv.compile({ $ref: `estate:block-props:v1#/properties/${type}` })]),
);
const shapes = new Map<string, ValidateFunction>();
for (const name of ["RevisionWrite", "Revision", "Document", "Site"])
  shapes.set(name, ajv.compile({ $ref: `estate:browser-content#/components/schemas/${name}` }));

export class BrowserContentError extends Error {
  constructor(readonly code: string) {
    super("The content cannot be edited safely.");
  }
}

/** Detached bounded JSON; recovery never executes, truncates or removes unfamiliar fields. */
export function copyBrowserJson<T>(value: T): T {
  try {
    const ancestors = new Set<object>();
    let nodes = 0;
    function check(item: unknown, depth: number) {
      if (++nodes > 20_000 || depth > 32) throw new Error();
      if (item === null || typeof item === "string" || typeof item === "boolean") return;
      if (typeof item === "number" && Number.isFinite(item)) return;
      if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error();
      if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new Error();
      ancestors.add(item);
      for (const key of Reflect.ownKeys(item)) {
        if (Array.isArray(item) && key === "length") continue;
        if (typeof key !== "string") throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (!descriptor.enumerable || descriptor.get || descriptor.set) throw new Error();
        check(descriptor.value, depth + 1);
      }
      ancestors.delete(item);
    }
    check(value, 0);
    const serialized = JSON.stringify(value);
    if (!serialized || new TextEncoder().encode(serialized).byteLength > 256 * 1024) throw new Error();
    return JSON.parse(serialized) as T;
  } catch {
    throw new BrowserContentError("document_invalid_or_too_large");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decodedSafe(value: string) {
  if (/[\s\\<>"'\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    return (
      !/[\\<>"'\u0000-\u001f\u007f]/.test(decoded) &&
      !/%[0-9a-f]{2}/i.test(decoded) &&
      !/%(?:2f|5c|3a)/i.test(value)
    );
  } catch {
    return false;
  }
}
function localPath(value: string) {
  if (!decodedSafe(value) || !value.startsWith("/") || value.startsWith("//")) return false;
  const url = new URL(value, "https://verified-site.invalid");
  return url.origin === "https://verified-site.invalid" && !url.username && !url.password;
}
function approvedLink(value: string, policy: BrowserLinkPolicy) {
  if (localPath(value)) return true;
  if (!decodedSafe(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      policy.approvedLinkOrigins.has(url.origin)
    );
  } catch {
    return false;
  }
}

/** Same frozen schemas, block property schemas and policy rules as the server registry. */
export function inspectBrowserDraft(value: unknown, policy: BrowserLinkPolicy) {
  const data = copyBrowserJson(value);
  const issues: BrowserIssue[] = [];
  if (!object(data) || data.schemaVersion !== 1) {
    issues.push({ path: "/schemaVersion", code: "schema_version_unsupported" });
    return { data, issues };
  }
  const shape = shapes.get("RevisionWrite")!;
  if (!shape(data))
    for (const error of shape.errors ?? [])
      issues.push({ path: error.instancePath, code: "document_schema_invalid" });
  if (!Array.isArray(data.blocks)) return { data, issues };
  const identifiers = new Set<unknown>();
  for (const [index, raw] of data.blocks.entries()) {
    const base = `/blocks/${index}`;
    if (!object(raw)) continue;
    if (identifiers.has(raw.id)) issues.push({ path: `${base}/id`, code: "block_id_duplicate" });
    identifiers.add(raw.id);
    const validate = typeof raw.type === "string" ? validators.get(raw.type) : undefined;
    if (!validate) {
      issues.push({ path: base, code: "block_not_registered" });
      continue;
    }
    if (Array.isArray(raw.children) && raw.children.length)
      issues.push({ path: `${base}/children`, code: "nested_blocks_unsupported" });
    if (!validate(raw.props)) {
      for (const error of validate.errors ?? [])
        issues.push({ path: `${base}/props${error.instancePath}`, code: "block_properties_invalid" });
      continue;
    }
    const props = raw.props as Record<string, unknown>;
    const links = (
      raw.type === "hero" && props.action
        ? [props.action]
        : raw.type === "cta"
          ? [props]
          : raw.type === "footer"
            ? (props.links ?? [])
            : []
    ) as { href: string }[];
    for (const [index, link] of links.entries())
      if (!approvedLink(link.href, policy))
        issues.push({ path: `${base}/links/${index}`, code: "link_origin_denied" });
  }
  if (object(data.seo)) {
    if (typeof data.seo.canonicalPath === "string" && !localPath(data.seo.canonicalPath))
      issues.push({ path: "/seo/canonicalPath", code: "canonical_path_invalid" });
    if (data.seo.ogAssetId) issues.push({ path: "/seo/ogAssetId", code: "media_publication_unavailable" });
  }
  return { data, issues };
}

export function requireBrowserShape<T>(name: "Revision" | "Document" | "Site", value: T): T {
  const detached = copyBrowserJson(value);
  if (!shapes.get(name)!(detached)) throw new BrowserContentError("response_invalid");
  return detached;
}

export function browserDocumentVersion(etag: string): number {
  const match = etag.length <= 100 ? /^"([1-9][0-9]*)"$/.exec(etag) : null;
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version)) throw new BrowserContentError("document_version_invalid");
  return version;
}
