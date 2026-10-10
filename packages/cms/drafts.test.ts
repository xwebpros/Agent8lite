import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import contract from "../contracts/openapi.json";
import {
  documentEtag,
  DraftConflictError,
  planDraftAppend,
  prepareDraft,
  prepareTemplateDraft,
  recoverDraft,
  requireDraftVersion,
  resolveSiteTemplate,
  templateThemeVersion,
  TemplateUnavailableError,
} from "./index";
import { listTemplateDefinitions } from "../templates/catalog";
import { ContentValidationError, renderRegisteredBlocks } from "../templates/registry";

const policy = { approvedLinkOrigins: new Set(["https://approved.example.test"]) };
const localPolicy = { approvedLinkOrigins: new Set<string>() };
const draft = () => prepareTemplateDraft("agent-introduction", "1.0.0", policy).document;
const metadata = () => ({ revisionId: randomUUID(), createdAt: "2026-10-10T12:00:00.000Z" });
const ajv = new Ajv({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "cms-test:frozen", components: contract.components });
const revisionSchema = ajv.compile({ $ref: "cms-test:frozen#/components/schemas/Revision" });

function expectConflict(operation: () => unknown, status: number, code: string) {
  try {
    operation();
    expect.fail("Expected a defined revision error.");
  } catch (error) {
    expect(error).toBeInstanceOf(DraftConflictError);
    expect(error).toMatchObject({ status, code });
  }
}

describe("strict draft preparation and recovery", () => {
  it("detaches accepted v1 JSON, hashes content deterministically, and does not publish", () => {
    const original = draft();
    const prepared = prepareDraft(original, policy);
    const reordered = { seo: original.seo, blocks: original.blocks, schemaVersion: original.schemaVersion };
    reordered.blocks[0] = {
      props: reordered.blocks[0].props,
      type: reordered.blocks[0].type,
      id: reordered.blocks[0].id,
    };
    expect(prepareDraft(reordered, policy).contentHash).toBe(prepared.contentHash);
    original.blocks[0].props.heading = "Changed after preparation";
    expect(prepared.document.blocks[0].props.heading).not.toBe("Changed after preparation");
    expect(prepareDraft(original, policy).contentHash).not.toBe(prepared.contentHash);
    expect(prepared.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(recoverDraft(prepared.document, policy)).toMatchObject({ canSave: true, canPublish: false });
  });

  it("keeps block order semantic in the content hash", () => {
    const original = draft();
    const changed = structuredClone(original);
    changed.blocks.reverse();
    expect(prepareDraft(changed, policy).contentHash).not.toBe(prepareDraft(original, policy).contentHash);
  });

  it.each([0, 2, 7])(
    "preserves version %i and all unknown JSON for recovery but refuses a strict save",
    (version) => {
      const unknown = {
        ...draft(),
        schemaVersion: version,
        blocks: [
          ...draft().blocks,
          {
            id: randomUUID(),
            type: "future",
            props: { recover: { raw: ["original", { text: "<script>" }] } },
          },
        ],
      };
      const before = structuredClone(unknown);
      const recovered = recoverDraft(unknown, policy);
      expect(recovered.data).toEqual(before);
      expect(recovered.data).not.toBe(unknown);
      expect(recovered).toMatchObject({ canSave: false, canPublish: false });
      expect(() => prepareDraft(unknown, policy)).toThrow(ContentValidationError);
      expect(() => renderRegisteredBlocks(recovered.data, policy)).toThrow(ContentValidationError);
      expect(unknown).toEqual(before);
    },
  );

  it("preserves a known frozen kind with no renderer instead of silently removing it", () => {
    const value = draft();
    value.blocks.push({ id: randomUUID(), type: "listing_grid", props: { source: "unapproved" } });
    const recovery = recoverDraft(value, policy);
    expect(recovery.data).toEqual(value);
    expect(recovery.issues).toContainEqual({ path: "/blocks/3", code: "block_not_registered" });
    expect(() => prepareDraft(value, policy)).toThrow(ContentValidationError);
  });

  it("exposes safe issue codes, with no executable preview or reflected property payload", () => {
    const value = draft();
    value.blocks[0].props.heading = '<img src=x onerror="sensitive-text">';
    const recovery = recoverDraft(value, policy);
    expect(recovery.canSave).toBe(false);
    expect(JSON.stringify(recovery.issues)).not.toContain("sensitive-text");
    expect(recovery.data).toEqual(value);
    expect(() => prepareDraft(value, policy)).toThrow(ContentValidationError);
  });

  it("requires current trusted origin approval on every new save", () => {
    const value = draft();
    value.blocks[0].props.action = { label: "Learn", href: "https://approved.example.test/about" };
    expect(prepareDraft(value, policy).document).toEqual(value);
    expect(() => prepareDraft(value, localPolicy)).toThrow(ContentValidationError);
    value.blocks[0].props.approvedLinkOrigins = ["https://approved.example.test"];
    expect(() => prepareDraft(value, localPolicy)).toThrow(ContentValidationError);
  });

  it.each(["javascript:alert(1)", "//evil.example.test", "/%252f%252fevil.example.test"])(
    "refuses unsafe draft links (%s), before storage",
    (href) => {
      const value = draft();
      value.blocks[0].props.action = { label: "Unsafe", href };
      expect(() => prepareDraft(value, policy)).toThrow(ContentValidationError);
    },
  );

  it("rejects duplicate IDs, nested relationships and media without approval", () => {
    const value = draft();
    value.blocks[1].id = value.blocks[0].id;
    value.blocks[0].children = [value.blocks[1].id];
    value.seo.ogAssetId = randomUUID();
    expect(recoverDraft(value, policy).issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "block_id_duplicate",
        "nested_blocks_unsupported",
        "media_publication_unavailable",
      ]),
    );
    expect(() => prepareDraft(value, policy)).toThrow(ContentValidationError);
  });

  it("refuses non-JSON values and accessors without invoking tenant code", () => {
    let reads = 0;
    const value = draft();
    Object.defineProperty(value.blocks[0].props, "heading", {
      enumerable: true,
      get() {
        reads++;
        return "Executed";
      },
    });
    expect(() => recoverDraft(value, policy)).toThrow(ContentValidationError);
    expect(() => prepareDraft(value, policy)).toThrow(ContentValidationError);
    expect(reads).toBe(0);
    expect(() => recoverDraft({ blocks: [() => "executed"] }, policy)).toThrow(ContentValidationError);
    expect(() => recoverDraft({ number: Number.POSITIVE_INFINITY }, policy)).toThrow(ContentValidationError);
  });
});

describe("native immutable revision plans", () => {
  it("maps the frozen response to native storage and advances only the document version", () => {
    const current = { id: randomUUID(), version: 5, publishedRevisionId: randomUUID() };
    const value = draft();
    const before = structuredClone(current);
    const plan = planDraftAppend(current, '"5"', value, policy, metadata());
    expect(revisionSchema(plan.revision), JSON.stringify(revisionSchema.errors)).toBe(true);
    expect(plan.revision.documentId).toBe(current.id);
    expect(plan.insert).toEqual({
      document_id: current.id,
      schema_version: value.schemaVersion,
      block_data: value.blocks,
      seo: value.seo,
      content_hash: prepareDraft(value, policy).contentHash,
    });
    expect(plan.documentUpdate).toEqual({ id: current.id, expectedVersion: 5, nextVersion: 6 });
    expect(plan.etag).toBe('"6"');
    expect(current).toEqual(before);
    expect(plan.documentUpdate).not.toHaveProperty("publishedRevisionId");
    expect(plan.insert).not.toHaveProperty("published_revision_id");
    value.blocks[0].props.heading = "Changed input";
    plan.revision.blocks[0].props.heading = "Changed response copy";
    expect(plan.insert.block_data[0].props.heading).not.toMatch(/Changed/);
  });

  it("retains the losing editor's body when the document version is stale", () => {
    const value = draft();
    const before = structuredClone(value);
    expectConflict(
      () => planDraftAppend({ id: randomUUID(), version: 3 }, '"2"', value, policy, metadata()),
      412,
      "revision_changed",
    );
    expect(value).toEqual(before);
  });

  it("identical new commands still plan distinct immutable history, not hash-based deduplication", () => {
    const id = randomUUID();
    const first = planDraftAppend({ id, version: 1 }, '"1"', draft(), policy, metadata());
    const second = planDraftAppend({ id, version: 2 }, first.etag, draft(), policy, metadata());
    expect(second.insert.content_hash).toBe(first.insert.content_hash);
    expect(second.revision.id).not.toBe(first.revision.id);
    expect(second.documentUpdate.nextVersion).toBe(3);
  });

  it.each([
    undefined,
    "",
    "*",
    'W/"1"',
    '"1", "2"',
    "1.0",
    "01",
    "-1",
    "0",
    "9007199254740993",
    "x".repeat(101),
  ])("refuses unprotective precondition %s", (ifMatch) => {
    expectConflict(
      () => requireDraftVersion(1, ifMatch),
      400,
      ifMatch ? "revision_invalid" : "revision_required",
    );
  });

  it("accepts the existing numeric/quoted strong convention, with safe numeric boundaries", () => {
    expect(requireDraftVersion(8, "8")).toBe(9);
    expect(requireDraftVersion(8, '"8"')).toBe(9);
    expect(documentEtag(8)).toBe('"8"');
    expectConflict(
      () => requireDraftVersion(Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)),
      409,
      "document_version_exhausted",
    );
    expectConflict(() => documentEtag(Number.MAX_SAFE_INTEGER + 1), 409, "document_version_invalid");
  });

  it.each([
    { revisionId: "invalid", createdAt: "2026-10-10T12:00:00.000Z" },
    { revisionId: randomUUID(), createdAt: "2026-02-31T12:00:00.000Z" },
    { revisionId: randomUUID(), createdAt: "not-a-date" },
  ])("rejects invalid server revision metadata without false successful plans", (identity) => {
    expectConflict(
      () => planDraftAppend({ id: randomUUID(), version: 1 }, "1", draft(), policy, identity),
      409,
      "revision_identity_invalid",
    );
  });
});

describe("repository template integration", () => {
  it("produces independent strict starters from all three pinned template families", () => {
    const definitions = listTemplateDefinitions();
    expect(new Set(definitions.map((item) => item.family))).toEqual(
      new Set(["agent", "brokerage", "landing"]),
    );
    for (const definition of definitions) {
      const resolved = resolveSiteTemplate(definition.code);
      expect(templateThemeVersion(resolved)).toBe(`${definition.code}@${definition.version}`);
      const first = prepareTemplateDraft(definition.code, definition.version, localPolicy);
      const second = prepareTemplateDraft(definition.code, definition.version, localPolicy);
      first.document.blocks[0].props.heading = "Tenant customization";
      expect(second.document.blocks[0].props.heading).not.toBe("Tenant customization");
      expect(second.document.seo.noindex).toBe(true);
      expect(renderRegisteredBlocks(second.document, localPolicy)).toContain("<section");
    }
  });

  it("never falls back from missing template codes/versions", () => {
    expect(() => resolveSiteTemplate("missing")).toThrow(TemplateUnavailableError);
    expect(() => prepareTemplateDraft("agent-introduction", "2.0.0", policy)).toThrow(
      TemplateUnavailableError,
    );
    const template = resolveSiteTemplate("agent-introduction");
    expect(() => templateThemeVersion({ ...template, version: "2.0.0" })).toThrow(TemplateUnavailableError);
  });
});
