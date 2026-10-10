import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../contracts/openapi.json";
import type { components } from "../contracts/generated/api";
import propertySchemas from "./block-schema-v1.json";
import { serializeTemplateJson } from "./json";

type Revision = components["schemas"]["RevisionWrite"];
type Block = components["schemas"]["Block"];
type Link = { label: string; href: string };
export type ContentIssue = { path: string; code: string };
export type PublishPolicy = { approvedLinkOrigins: ReadonlySet<string> };
export const BLOCK_SCHEMA_VERSION = 1;
export const registeredBlocks = ["hero", "text", "cta", "footer"] as const;
type Registered = (typeof registeredBlocks)[number];

const ajv = new Ajv2020({ allErrors: true, strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({ $id: "estate:content-contract", components: contract.components });
ajv.addSchema(propertySchemas);
const revisionValidator = ajv.compile({
  $ref: "estate:content-contract#/components/schemas/RevisionWrite",
});
const validators = new Map<string, ValidateFunction>(
  registeredBlocks.map((type) => [type, ajv.compile({ $ref: `estate:block-props:v1#/properties/${type}` })]),
);

export class ContentValidationError extends Error {
  constructor(readonly issues: ContentIssue[]) {
    super("Content cannot publish until its validation issues are resolved.");
  }
}
function copyJson(value: unknown): unknown {
  try {
    return JSON.parse(serializeTemplateJson(value));
  } catch {
    throw new ContentValidationError([{ path: "", code: "document_invalid_or_too_large" }]);
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function links(block: Block): Link[] {
  if (block.type === "hero" && block.props.action) return [block.props.action as Link];
  if (block.type === "cta") return [block.props as unknown as Link];
  if (block.type === "footer") return (block.props.links as Link[] | undefined) ?? [];
  return [];
}
function decodedSafe(value: string) {
  if (/[\s\\<>"'\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    // Deny encoded separators/control characters and nested encoding before link parsing.
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
export function isLocalPath(value: string): boolean {
  if (!decodedSafe(value) || !value.startsWith("/") || value.startsWith("//")) return false;
  const url = new URL(value, "https://verified-site.invalid");
  return url.origin === "https://verified-site.invalid" && !url.username && !url.password;
}
export function isApprovedLink(value: string, policy: PublishPolicy): boolean {
  if (isLocalPath(value)) return true;
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

/** Retains bounded original JSON, including future kinds/versions, for editor recovery only. */
export function inspectDraft(value: unknown, policy: PublishPolicy) {
  const data = copyJson(value);
  const issues: ContentIssue[] = [];
  if (!object(data) || data.schemaVersion !== BLOCK_SCHEMA_VERSION) {
    issues.push({ path: "/schemaVersion", code: "schema_version_unsupported" });
    return { data, issues };
  }
  if (!revisionValidator(data)) {
    for (const error of revisionValidator.errors ?? [])
      issues.push({ path: error.instancePath, code: "document_schema_invalid" });
  }
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
    for (const [linkIndex, link] of links(raw as Block).entries())
      if (!isApprovedLink(link.href, policy))
        issues.push({ path: `${base}/links/${linkIndex}`, code: "link_origin_denied" });
  }
  if (object(data.seo)) {
    if (typeof data.seo.canonicalPath === "string" && !isLocalPath(data.seo.canonicalPath))
      issues.push({ path: "/seo/canonicalPath", code: "canonical_path_invalid" });
    if (data.seo.ogAssetId) issues.push({ path: "/seo/ogAssetId", code: "media_publication_unavailable" });
  }
  return { data, issues };
}

/** Validates a detached copy at each render. Publication authorization is a separate service command. */
export function validateForPublication(value: unknown, policy: PublishPolicy): Revision {
  const inspected = inspectDraft(value, policy);
  if (inspected.issues.length) throw new ContentValidationError(inspected.issues);
  return inspected.data as Revision;
}
function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!;
  });
}
function renderLink(link: Link) {
  return `<a href="${escape(link.href)}" rel="noopener noreferrer">${escape(link.label)}</a>`;
}
function renderBlock(block: Block) {
  const props = block.props;
  const attributes = `id="block-${escape(block.id)}" data-block="${escape(block.type)}"`;
  switch (block.type as Registered) {
    case "hero":
      return `<section ${attributes}><h1>${escape(props.heading as string)}</h1>${props.summary ? `<p>${escape(props.summary as string)}</p>` : ""}${props.action ? renderLink(props.action as Link) : ""}</section>`;
    case "text":
      return `<section ${attributes}>${(props.paragraphs as string[]).map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</section>`;
    case "cta":
      return `<section ${attributes}>${renderLink(props as unknown as Link)}</section>`;
    case "footer":
      return `<footer ${attributes}><p>${escape(props.text as string)}</p>${(props.links as Link[] | undefined)?.length ? `<nav aria-label="Footer">${(props.links as Link[]).map(renderLink).join("")}</nav>` : ""}</footer>`;
  }
}

/** A semantic HTML fragment only; no script, network fetch, public routing or implicit publication. */
export function renderRegisteredBlocks(value: unknown, policy: PublishPolicy): string {
  const revision = validateForPublication(value, policy);
  return revision.blocks.map(renderBlock).join("\n");
}
