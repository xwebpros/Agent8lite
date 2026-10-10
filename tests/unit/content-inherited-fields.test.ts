import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContentValidationError,
  inspectDraft,
  renderRegisteredBlocks,
  validateForPublication,
} from "../../packages/templates/registry";

const policy = { approvedLinkOrigins: new Set<string>() };
const revision = () => ({
  schemaVersion: 1,
  blocks: [
    { id: randomUUID(), type: "hero", props: { heading: "Own heading" } },
    { id: randomUUID(), type: "text", props: { paragraphs: ["Own paragraph"] } },
    { id: randomUUID(), type: "footer", props: { text: "Own footer" } },
  ],
  seo: { title: "Own title", description: "Own description", noindex: true },
});

const operations = [
  { name: "inspection", run: (value: unknown) => inspectDraft(value, policy) },
  { name: "validation", run: (value: unknown) => validateForPublication(value, policy) },
  { name: "rendering", run: (value: unknown) => renderRegisteredBlocks(value, policy) },
];

function capture<T>(operation: () => T) {
  try {
    return { value: operation(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function withInherited<T>(key: string, descriptor: PropertyDescriptor, operation: () => T) {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, { configurable: true, ...descriptor });
  try {
    return capture(operation);
  } finally {
    if (original) Object.defineProperty(Object.prototype, key, original);
    else Reflect.deleteProperty(Object.prototype, key);
  }
}

const optionalFields = ["children", "summary", "action", "links", "canonicalPath", "ogAssetId"] as const;
const inheritedData: Record<(typeof optionalFields)[number], unknown> = {
  children: [{ id: randomUUID(), type: "text", props: { paragraphs: ["INHERITED_PRIVATE_CHILD"] } }],
  summary: "INHERITED_PRIVATE_SUMMARY",
  action: { label: "INHERITED_PRIVATE_ACTION", href: "/inherited-action" },
  links: [{ label: "INHERITED_PRIVATE_LINK", href: "/inherited-footer" }],
  canonicalPath: "javascript:INHERITED_PRIVATE_CANONICAL",
  ogAssetId: randomUUID(),
};

describe("content registry own-field semantics after JSON detachment", () => {
  const getters = operations.flatMap((operation) => optionalFields.map((field) => ({ ...operation, field })));
  it.each(getters)("$name never evaluates an inherited optional $field getter", ({ run, field }) => {
    const input = revision(),
      expected = run(input);
    let reads = 0;
    const result = withInherited(
      field,
      {
        get: () => {
          reads++;
          throw new Error("INHERITED_PRIVATE_OPTIONAL_GETTER");
        },
      },
      () => run(input),
    );
    // Restore first: assertions and runner formatting must not evaluate the hostile prototype.
    expect(reads).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(expected);
  });

  it.each(optionalFields)("ignores inherited optional %s data on every public path", (field) => {
    const input = revision(),
      expected = operations.map(({ run }) => run(input));
    const result = withInherited(field, { value: inheritedData[field], enumerable: true }, () =>
      operations.map(({ run }) => run(input)),
    );
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(expected);
    expect(JSON.stringify(result.value)).not.toContain("INHERITED_PRIVATE");
  });

  const required = [
    {
      field: "schemaVersion",
      value: 1,
      remove: (input: ReturnType<typeof revision>) => Reflect.deleteProperty(input, "schemaVersion"),
    },
    {
      field: "blocks",
      value: revision().blocks,
      remove: (input: ReturnType<typeof revision>) => Reflect.deleteProperty(input, "blocks"),
    },
    {
      field: "id",
      value: randomUUID(),
      remove: (input: ReturnType<typeof revision>) => Reflect.deleteProperty(input.blocks[0], "id"),
    },
    {
      field: "type",
      value: "hero",
      remove: (input: ReturnType<typeof revision>) => Reflect.deleteProperty(input.blocks[0], "type"),
    },
    {
      field: "heading",
      value: "INHERITED_PRIVATE_REQUIRED_HEADING",
      remove: (input: ReturnType<typeof revision>) =>
        Reflect.deleteProperty(input.blocks[0].props, "heading"),
    },
  ];
  it.each(required)(
    "cannot fill missing own required $field with inherited data or a getter",
    ({ field, value, remove }) => {
      const input = revision();
      remove(input);
      let reads = 0;
      for (const descriptor of [
        { value, enumerable: true },
        {
          get: () => {
            reads++;
            return value;
          },
        },
      ]) {
        const result = withInherited(field, descriptor, () => ({
          inspected: capture(() => inspectDraft(input, policy)),
          validated: capture(() => validateForPublication(input, policy)),
          rendered: capture(() => renderRegisteredBlocks(input, policy)),
        }));
        expect(reads).toBe(0);
        expect(result.error).toBeUndefined();
        expect(result.value?.inspected.error).toBeUndefined();
        expect(result.value?.inspected.value?.issues.length).toBeGreaterThan(0);
        expect(result.value?.validated.error).toBeInstanceOf(ContentValidationError);
        expect(result.value?.rendered.error).toBeInstanceOf(ContentValidationError);
      }
    },
  );

  it("retains and renders the same optional fields when they are valid own data", () => {
    const input = {
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: "hero",
          children: [],
          props: {
            heading: "Own heading",
            summary: "Own summary",
            action: { label: "Own action", href: "/own-action" },
          },
        },
        {
          id: randomUUID(),
          type: "footer",
          props: { text: "Own footer", links: [{ label: "Own link", href: "/own-footer" }] },
        },
      ],
      seo: {
        title: "Own title",
        description: "Own description",
        noindex: true,
        canonicalPath: "/own-page",
      },
    };
    const inspected = inspectDraft(input, policy);
    expect(inspected.issues).toEqual([]);
    expect(inspected.data).toEqual(input);
    const html = renderRegisteredBlocks(validateForPublication(input, policy), policy);
    expect(html).toContain("Own summary");
    expect(html).toContain('href="/own-action"');
    expect(html).toContain('href="/own-footer"');
    expect(html).not.toContain("INHERITED_PRIVATE");
    const media = { ...input, seo: { ...input.seo, ogAssetId: randomUUID() } };
    expect(inspectDraft(media, policy).issues).toContainEqual({
      path: "/seo/ogAssetId",
      code: "media_publication_unavailable",
    });
  });
});
