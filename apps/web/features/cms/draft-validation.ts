import type { BrowserDraft, BrowserIssue } from "../../../../packages/cms/browser";

export type DraftFeedback = {
  issue: BrowserIssue;
  description: string;
  message: string;
  target: { kind: "field"; path: string } | { kind: "block"; path: string } | { kind: "summary" };
};

const descriptions: Record<string, string> = {
  schema_version_unsupported: "This revision needs an editor that supports its content format.",
  document_schema_invalid: "Check the field format and length.",
  block_properties_invalid: "Check the required text, format and length.",
  block_id_duplicate: "This draft has repeated block identifiers.",
  block_not_registered: "This block requires a supported editor before it can be changed.",
  nested_blocks_unsupported: "Nested content requires read-only recovery.",
  link_origin_denied: "Use a local path or an approved HTTPS link.",
  canonical_path_invalid: "Use a local canonical path beginning with a single slash.",
  media_publication_unavailable: "Image attachments are unavailable in this editor.",
};

/** Present existing validator paths; this does not add a second schema or change save eligibility. */
export function describeDraftIssues(draft: BrowserDraft | null, issues: BrowserIssue[]): DraftFeedback[] {
  const fields = new Map<string, string>([
    ["/seo/title", "Search title"],
    ["/seo/description", "Search description"],
    ["/seo/canonicalPath", "Canonical local path"],
  ]);
  const linkFields = new Map<string, string>();
  for (const [index, block] of (draft?.blocks ?? []).entries()) {
    const base = `/blocks/${index}`;
    const add = (path: string, label: string) => fields.set(`${base}/props/${path}`, label);
    const link = (path: string, label: string, index: number) => {
      add(`${path ? `${path}/` : ""}label`, `${label} label`);
      const href = `${base}/props/${path ? `${path}/` : ""}href`;
      fields.set(href, `${label} path or approved HTTPS link`);
      linkFields.set(`${base}/links/${index}`, href);
    };
    switch (block.type) {
      case "hero":
        add("heading", "Heading");
        add("summary", "Summary");
        if (block.props.action) link("action", "Hero action", 0);
        break;
      case "text":
        if (Array.isArray(block.props.paragraphs))
          block.props.paragraphs.forEach((_, index) => add(`paragraphs/${index}`, `Paragraph ${index + 1}`));
        break;
      case "cta":
        link("", "Action", 0);
        break;
      case "footer":
        add("text", "Footer text");
        if (Array.isArray(block.props.links))
          block.props.links.forEach((_, index) => link(`links/${index}`, `Footer link ${index + 1}`, index));
        break;
    }
  }

  const seen = new Set<string>();
  return issues.flatMap((issue): DraftFeedback[] => {
    const key = JSON.stringify([issue.path, issue.code]);
    if (seen.has(key)) return [];
    seen.add(key);
    const path =
      issue.code === "link_origin_denied" ? (linkFields.get(issue.path) ?? issue.path) : issue.path;
    const label = fields.get(path);
    const blockIndex = /^\/blocks\/(0|[1-9][0-9]*)(?:\/|$)/.exec(issue.path)?.[1];
    const block = blockIndex === undefined ? undefined : draft?.blocks[Number(blockIndex)];
    const location =
      blockIndex !== undefined
        ? `Block ${Number(blockIndex) + 1}${label ? ` · ${label}` : ""}`
        : (label ?? (issue.path.startsWith("/seo") ? "Search metadata" : "Revision content"));
    const description =
      descriptions[issue.code] ?? "This content needs review before it can be edited safely.";
    return [
      {
        issue,
        description,
        message: `${location}: ${description}`,
        target:
          draft && label
            ? { kind: "field", path }
            : block
              ? { kind: "block", path: `/blocks/${blockIndex}` }
              : { kind: "summary" },
      },
    ];
  });
}

/** Compare attributes as data, so content paths/identifiers never become executable CSS selectors. */
export function focusDraftFeedback(root: HTMLElement, feedback: DraftFeedback): void {
  const target = feedback.target;
  const attribute = target.kind === "field" ? "data-cms-field" : "data-cms-block";
  const value = target.kind === "summary" ? null : target.path;
  const control =
    value === null
      ? undefined
      : Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`)).find(
          (element) => element.getAttribute(attribute) === value && !element.matches(":disabled"),
        );
  (control ?? root.querySelector<HTMLElement>("[data-cms-issue-summary]"))?.focus();
}
