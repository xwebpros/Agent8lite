import type { components } from "../contracts/generated/api";
import { BLOCK_SCHEMA_VERSION, validateForPublication } from "./registry";

type Template = components["schemas"]["Template"];
type Revision = components["schemas"]["RevisionWrite"];
const policy = { approvedLinkOrigins: new Set<string>() };
const definitions: Array<{ metadata: Template; document: Revision }> = [
  {
    metadata: {
      code: "agent-introduction",
      version: "1.0.0",
      name: "Personal introduction",
      family: "agent",
      blockSchemaVersion: BLOCK_SCHEMA_VERSION,
    },
    document: {
      schemaVersion: BLOCK_SCHEMA_VERSION,
      blocks: [
        {
          id: "a2000000-0000-4000-8000-000000000001",
          type: "hero",
          props: {
            heading: "Your next chapter starts here",
            summary: "Introduce your local expertise and the service you offer.",
            action: { label: "Start a conversation", href: "/contact" },
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000002",
          type: "text",
          props: {
            paragraphs: ["Add your own professional biography and service area. Use facts you can verify."],
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000003",
          type: "footer",
          props: {
            text: "Add your brokerage attribution and contact details.",
            links: [{ label: "Privacy", href: "/privacy" }],
          },
        },
      ],
      seo: {
        title: "Meet your real estate agent",
        description: "Learn about local real estate services.",
        noindex: true,
      },
    },
  },
  {
    metadata: {
      code: "brokerage-overview",
      version: "1.0.0",
      name: "Brokerage overview",
      family: "brokerage",
      blockSchemaVersion: BLOCK_SCHEMA_VERSION,
    },
    document: {
      schemaVersion: BLOCK_SCHEMA_VERSION,
      blocks: [
        {
          id: "a2000000-0000-4000-8000-000000000011",
          type: "hero",
          props: {
            heading: "A team for your next move",
            summary: "Explain your brokerage's approach and local services.",
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000012",
          type: "text",
          props: {
            paragraphs: [
              "Introduce your team, locations and verified professional credentials.",
              "Describe how clients can contact the office and what to expect.",
            ],
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000013",
          type: "cta",
          props: { label: "Contact our office", href: "/contact" },
        },
        {
          id: "a2000000-0000-4000-8000-000000000014",
          type: "footer",
          props: {
            text: "Add your brokerage's required attribution.",
            links: [{ label: "Privacy", href: "/privacy" }],
          },
        },
      ],
      seo: {
        title: "Local brokerage services",
        description: "Meet the brokerage and discover its services.",
        noindex: true,
      },
    },
  },
  {
    metadata: {
      code: "service-landing",
      version: "1.0.0",
      name: "Focused service landing",
      family: "landing",
      blockSchemaVersion: BLOCK_SCHEMA_VERSION,
    },
    document: {
      schemaVersion: BLOCK_SCHEMA_VERSION,
      blocks: [
        {
          id: "a2000000-0000-4000-8000-000000000021",
          type: "hero",
          props: {
            heading: "Plan your next move",
            summary: "Describe the service and the audience's next step.",
            action: { label: "Talk about your goals", href: "/contact" },
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000022",
          type: "text",
          props: {
            paragraphs: [
              "Explain the process with clear, factual information. Add applicable limitations and contact options.",
            ],
          },
        },
        {
          id: "a2000000-0000-4000-8000-000000000023",
          type: "footer",
          props: { text: "Add your business attribution.", links: [{ label: "Privacy", href: "/privacy" }] },
        },
      ],
      seo: {
        title: "Plan your real estate move",
        description: "Learn about a local real estate service.",
        noindex: true,
      },
    },
  },
];

/** Repository-owned catalog metadata, detached so consumers cannot mutate another request's catalog. */
export function listTemplateDefinitions(): Template[] {
  return definitions
    .map(({ metadata }) => structuredClone(metadata))
    .sort((a, b) => a.code.localeCompare(b.code));
}
/** A template is a draft starter. It has no publication pointer, tenant credentials or media rights. */
export function instantiateTemplate(code: string, version: string): Revision | null {
  const definition = definitions.find(
    (item) => item.metadata.code === code && item.metadata.version === version,
  );
  return definition ? validateForPublication(definition.document, policy) : null;
}
