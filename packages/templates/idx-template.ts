import type { components } from "../contracts/generated/api";
import { validateForPublication } from "./registry";

type Schemas = components["schemas"];
type Revision = Schemas["RevisionWrite"];
export const IDX_TEMPLATE_VERSION = "1.0.0";
export const IDX_TEMPLATE_BLOCK_IDS = {
  hero: "a8000000-0000-4000-8000-000000000101",
  quickSearch: "a8000000-0000-4000-8000-000000000102",
  explore: "a8000000-0000-4000-8000-000000000103",
  footer: "a8000000-0000-4000-8000-000000000104",
} as const;

export const idxTemplateDefaultText: Schemas["IdxTemplateText"] = {
  heroEyebrow: "Live Las Vegas Valley listings",
  heroTitle: "Find Your Las Vegas Home",
  heroDescription:
    "Search live Las Vegas Valley real estate listings with current property details, photos, and brokerage attribution.",
  quickSearchEyebrow: "Start with a real filter",
  quickSearchTitle: "Quick searches",
  quickSearchDescription: "Each shortcut maps directly to a verified listing-field filter.",
  exploreEyebrow: "Explore Las Vegas real estate",
  exploreTitle: "A clearer way to search the Valley",
  exploreDescription:
    "Start with a city, ZIP code, price range, or property feature. Every result comes from the live IDX connection and can be reviewed in a list, split map, or map-only view.",
  footerDescription:
    "Live Las Vegas property search powered by CoreLogic Trestle. Brokerage attribution and MLS remarks are shown on each listing where supplied by the feed.",
};

export function createIdxTemplateDefinition(family: "agent" | "brokerage") {
  const code = `las-vegas-idx-${family}` as "las-vegas-idx-agent" | "las-vegas-idx-brokerage";
  const brand: Schemas["IdxTemplateBrand"] = {
    displayName: "LAS VEGAS LIVE IDX",
    initial: "L",
    agentDisplayName: family === "agent" ? "Your agent" : "Our team",
  };
  const text = idxTemplateDefaultText;
  const document: Revision = {
    schemaVersion: 1,
    blocks: [
      {
        id: IDX_TEMPLATE_BLOCK_IDS.hero,
        type: "hero",
        props: { heading: text.heroTitle, summary: text.heroDescription, eyebrow: text.heroEyebrow, brand },
      },
      {
        id: IDX_TEMPLATE_BLOCK_IDS.quickSearch,
        type: "hero",
        props: {
          heading: text.quickSearchTitle,
          summary: text.quickSearchDescription,
          eyebrow: text.quickSearchEyebrow,
        },
      },
      {
        id: IDX_TEMPLATE_BLOCK_IDS.explore,
        type: "hero",
        props: { heading: text.exploreTitle, summary: text.exploreDescription, eyebrow: text.exploreEyebrow },
      },
      { id: IDX_TEMPLATE_BLOCK_IDS.footer, type: "footer", props: { text: text.footerDescription } },
    ],
    seo: { title: "Las Vegas property search", description: text.heroDescription, noindex: true },
  };
  return {
    metadata: {
      code,
      version: IDX_TEMPLATE_VERSION,
      name: family === "agent" ? "Las Vegas IDX — Agent" : "Las Vegas IDX — Brokerage",
      family,
      blockSchemaVersion: 1,
    } satisfies Schemas["Template"],
    document,
  };
}

/** Native revisions hold controlled content. Fixed source presentation has no tenant code. */
export function projectIdxTemplateContent(revision: Revision): {
  content: Schemas["IdxTemplateText"];
  brand: Schemas["IdxTemplateBrand"];
} {
  const checked = validateForPublication(revision, { approvedLinkOrigins: new Set() });
  const find = (id: string, type: string) => {
    const block = checked.blocks.find((item) => item.id === id && item.type === type);
    if (!block) throw new Error("The published IDX template is missing a required content slot.");
    return block.props;
  };
  const hero = find(IDX_TEMPLATE_BLOCK_IDS.hero, "hero");
  const quick = find(IDX_TEMPLATE_BLOCK_IDS.quickSearch, "hero");
  const explore = find(IDX_TEMPLATE_BLOCK_IDS.explore, "hero");
  const footer = find(IDX_TEMPLATE_BLOCK_IDS.footer, "footer");
  const field = (props: Record<string, unknown>, key: string, fallback = "") =>
    typeof props[key] === "string" ? (props[key] as string) : fallback;
  const rawBrand = hero.brand as Schemas["IdxTemplateBrand"] | undefined;
  return {
    content: {
      heroEyebrow: field(hero, "eyebrow"),
      heroTitle: field(hero, "heading"),
      heroDescription: field(hero, "summary"),
      quickSearchEyebrow: field(quick, "eyebrow"),
      quickSearchTitle: field(quick, "heading"),
      quickSearchDescription: field(quick, "summary"),
      exploreEyebrow: field(explore, "eyebrow"),
      exploreTitle: field(explore, "heading"),
      exploreDescription: field(explore, "summary"),
      footerDescription: field(footer, "text"),
    },
    brand: rawBrand
      ? structuredClone(rawBrand)
      : { displayName: "LAS VEGAS LIVE IDX", initial: "L", agentDisplayName: "Your agent" },
  };
}
