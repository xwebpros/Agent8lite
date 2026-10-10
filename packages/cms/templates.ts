import type { components } from "../contracts/generated/api";
import { instantiateTemplate, listTemplateDefinitions } from "../templates/catalog";
import type { PublishPolicy } from "../templates/registry";
import { prepareDraft } from "./drafts";

type Template = components["schemas"]["Template"];

export class TemplateUnavailableError extends Error {
  readonly status = 422;
  readonly code = "template_unavailable";
  constructor() {
    super("The selected template version is unavailable.");
  }
}

/** Frozen SiteWrite has only templateCode. Resolve exactly one repository-owned current definition. */
export function resolveSiteTemplate(code: string): Template {
  const matches = listTemplateDefinitions().filter((template) => template.code === code);
  if (matches.length !== 1) throw new TemplateUnavailableError();
  return matches[0];
}

/** Pin the code and version in the existing site.theme_version column; no new schema is implied. */
export function templateThemeVersion(template: Template): string {
  const resolved = resolveSiteTemplate(template.code);
  if (resolved.version !== template.version) throw new TemplateUnavailableError();
  const encoded = `${resolved.code}@${resolved.version}`;
  if (encoded.length > 80) throw new TemplateUnavailableError();
  return encoded;
}

/** Explicit draft starter only. Unknown versions never fall back to a different template. */
export function prepareTemplateDraft(code: string, version: string, trustedPolicy: PublishPolicy) {
  const document = instantiateTemplate(code, version);
  if (!document) throw new TemplateUnavailableError();
  return prepareDraft(document, trustedPolicy);
}
