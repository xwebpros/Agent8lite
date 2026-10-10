import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CmsDraftController,
  type CmsDraftClient,
  type CmsSaveCommand,
} from "../../apps/web/features/cms/draft-controller";
import { CmsDraftEditor } from "../../apps/web/features/cms/draft-editor";
import { CmsDraftPreview } from "../../apps/web/features/cms/draft-preview";
import { describeDraftIssues, focusDraftFeedback } from "../../apps/web/features/cms/draft-validation";
import type { components } from "../../packages/contracts/generated/api";
import type { BrowserRevision } from "../../packages/cms/browser";

const document: components["schemas"]["Document"] = {
  id: "a2000000-0000-4000-8000-000000000010",
  siteId: "a2000000-0000-4000-8000-000000000011",
  kind: "page",
  title: "Private draft",
  slug: "private",
  version: 1,
  publishedRevisionId: null,
};
function revision(id = "a2000000-0000-4000-8000-000000000099"): BrowserRevision {
  return {
    id,
    documentId: document.id,
    createdAt: "2026-10-10T00:00:00.000Z",
    schemaVersion: 1,
    blocks: [
      { id: "a2000000-0000-4000-8000-000000000001", type: "hero", props: { heading: "Original heading" } },
      {
        id: "a2000000-0000-4000-8000-000000000002",
        type: "text",
        props: { paragraphs: ["Original paragraph"] },
      },
    ],
    seo: { title: "Private draft", description: "", noindex: true },
  };
}
function receipt(command: CmsSaveCommand) {
  return {
    data: {
      ...command.body,
      id: "a2000000-0000-4000-8000-000000000088",
      documentId: command.documentId,
      createdAt: "2026-10-10T00:01:00.000Z",
    },
    etag: `"${Number(command.ifMatch.replaceAll('"', "")) + 1}"`,
  };
}
function setup(overrides: Partial<CmsDraftClient> = {}) {
  let keys = 0;
  const client = {
    saveDraft: vi.fn(async (command: CmsSaveCommand) => receipt(command)),
    readDocument: vi.fn(async () => ({ data: { ...document, version: 3 }, etag: '"3"' })),
    ...overrides,
  };
  const controller = new CmsDraftController({
    document,
    etag: '"1"',
    client,
    policy: { approvedLinkOrigins: new Set() },
    online: true,
    canWrite: true,
    createKey: () => `draft-command-${++keys}`,
  });
  return { controller, client, keys: () => keys };
}
function edited(controller: CmsDraftController) {
  expect(controller.selectRevision(revision())).toBe(true);
  expect(
    controller.edit((draft) => {
      draft.blocks[0].props.heading = "My unsaved heading";
    }),
  ).toBe(true);
}

describe("CMS editor command lifecycle", () => {
  it("requires explicit revision selection and refuses to replace a dirty draft", () => {
    const { controller } = setup();
    expect(controller.getSnapshot().selectedRevisionId).toBeNull();
    edited(controller);
    expect(controller.selectRevision(revision("a2000000-0000-4000-8000-000000000000"))).toBe(false);
    expect(controller.startBlank()).toBe(false);
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("My unsaved heading");
    expect(controller.discardChanges()).toBe(true);
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("Original heading");
  });
  it("reconciles an uncertain save with the same original key/body/precondition and prevents edits/discard", async () => {
    const seen: CmsSaveCommand[] = [];
    const saveDraft = vi.fn(async (command: CmsSaveCommand) => {
      seen.push(structuredClone(command));
      if (seen.length === 1) {
        command.body.blocks[0].props.heading = "transport mutated its detached copy";
        throw new TypeError("lost response");
      }
      return receipt(command);
    });
    const { controller, keys } = setup({ saveDraft });
    edited(controller);
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(
      controller.edit((draft) => {
        draft.seo.title = "overwrite";
      }),
    ).toBe(false);
    expect(controller.discardChanges()).toBe(false);
    await controller.refreshVersion();
    await controller.save();
    expect(seen[1]).toEqual(seen[0]);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "saved",
      dirty: false,
      etag: '"2"',
      selectedRevisionId: "a2000000-0000-4000-8000-000000000088",
    });
    expect(controller.getSnapshot().document.publishedRevisionId).toBeNull();
  });
  it("allows one in-flight command even when a subscription reenters save", async () => {
    let release!: () => void;
    const saveDraft = vi.fn(
      (command: CmsSaveCommand) =>
        new Promise<ReturnType<typeof receipt>>((done) => {
          release = () => done(receipt(command));
        }),
    );
    const { controller, keys } = setup({ saveDraft });
    edited(controller);
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().phase === "saving") void controller.save();
    });
    const first = controller.save();
    const second = controller.save();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(keys()).toBe(1);
    unsubscribe();
  });
  it("retains a command after a malformed success receipt instead of risking another revision", async () => {
    const saveDraft = vi.fn(async (command: CmsSaveCommand) => ({ ...receipt(command), etag: 'W/"2"' }));
    const { controller, keys } = setup({ saveDraft });
    edited(controller);
    await controller.save();
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(keys()).toBe(1);
    expect(saveDraft.mock.calls[0][0]).toEqual(saveDraft.mock.calls[1][0]);
  });
  it("preserves conflicting content and explicitly refreshes the document version before a fresh command", async () => {
    const saveDraft = vi.fn(async (command: CmsSaveCommand) => {
      if (command.ifMatch === '"1"') throw { status: 412 };
      return receipt(command);
    });
    const { controller, keys } = setup({ saveDraft });
    edited(controller);
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("conflict");
    await controller.save();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(controller.edit(() => {})).toBe(false);
    const selected = controller.getSnapshot().selectedRevisionId;
    await controller.refreshVersion();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "editing",
      dirty: true,
      selectedRevisionId: selected,
      etag: '"3"',
    });
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("My unsaved heading");
    await controller.save();
    expect(saveDraft.mock.calls[1][0].ifMatch).toBe('"3"');
    expect(keys()).toBe(2);
    expect(controller.getSnapshot().phase).toBe("saved");
  });
  it("keeps the conflict after a foreign or mismatched version read", async () => {
    const { controller } = setup({
      saveDraft: async () => {
        throw { status: 412 };
      },
      readDocument: async () => ({
        data: { ...document, siteId: "a2000000-0000-4000-8000-000000000012", version: 3 },
        etag: '"3"',
      }),
    });
    edited(controller);
    await controller.save();
    await controller.refreshVersion();
    expect(controller.getSnapshot()).toMatchObject({ phase: "conflict", etag: '"1"', dirty: true });
  });
  it.each([401, 403, 404])(
    "clears private content and disables retries on access denial %s",
    async (status) => {
      const { controller, keys } = setup({
        saveDraft: async () => {
          throw { status };
        },
      });
      edited(controller);
      await controller.save();
      await controller.save();
      expect(controller.getSnapshot()).toMatchObject({
        phase: "denied",
        draft: null,
        recovery: null,
        dirty: false,
      });
      expect(keys()).toBe(1);
    },
  );
  it("does not repopulate content when a late response arrives after the root revokes the session binding", async () => {
    let release!: () => void;
    const { controller } = setup({
      saveDraft: (command) =>
        new Promise((resolve) => {
          release = () => resolve(receipt(command));
        }),
    });
    edited(controller);
    const saving = controller.save();
    await Promise.resolve();
    controller.revoke();
    release();
    await saving;
    expect(controller.getSnapshot()).toMatchObject({ phase: "denied", draft: null, dirty: false });
  });
  it("cancels a queued command before transport when its session binding is revoked", async () => {
    const { controller, client } = setup();
    edited(controller);
    const saving = controller.save();
    controller.revoke();
    await saving;
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(controller.getSnapshot().phase).toBe("denied");
  });
  it("rejects foreign revision and recovery bindings without displaying their private content", () => {
    const { controller } = setup();
    const foreign = { ...revision(), documentId: "a2000000-0000-4000-8000-000000000022" };
    expect(() => controller.selectRevision(foreign)).toThrow("another document");
    expect(() => controller.openRecovery(foreign.id, foreign.documentId, { private: "foreign" })).toThrow(
      "another document",
    );
    expect(controller.getSnapshot()).toMatchObject({ draft: null, recovery: null, selectedRevisionId: null });
  });
  it("keeps unsupported original JSON read-only and refuses to edit, save or replace it with a blank draft", async () => {
    const { controller, client } = setup();
    const raw = {
      schemaVersion: 2,
      blocks: [{ type: "future_kind", props: { original: ["keep", { extra: true }] } }],
      seo: { custom: "keep" },
    };
    expect(controller.openRecovery(revision().id, document.id, raw)).toBe(true);
    expect(controller.getSnapshot().recovery?.data).toEqual(raw);
    expect(controller.edit(() => {})).toBe(false);
    expect(controller.startBlank()).toBe(false);
    await controller.save();
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(controller.selectRevision(revision())).toBe(true);
  });
  it("preserves full known-kind unsupported content when normal reader data requires recovery", () => {
    const { controller } = setup();
    const unknown = revision();
    unknown.blocks[0].props.future = { keep: [1, 2] };
    controller.selectRevision(unknown);
    expect(controller.getSnapshot().draft).toBeNull();
    expect(controller.getSnapshot().recovery?.data).toMatchObject({
      blocks: [{ props: { future: { keep: [1, 2] } } }, {}],
    });
  });
  it("blocks offline writes and validation failures without creating a command key", async () => {
    const { controller, client, keys } = setup();
    edited(controller);
    controller.setOnline(false);
    await controller.save();
    expect(keys()).toBe(0);
    controller.setOnline(true);
    controller.edit((draft) => {
      draft.blocks[0].props.action = { label: "Unsafe", href: "javascript:bad" };
    });
    await controller.save();
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(keys()).toBe(0);
    expect(controller.getSnapshot().issues).toContainEqual({
      path: "/blocks/0/links/0",
      code: "link_origin_denied",
    });
  });
  it("reorders with stable block identities, preserves content and rejects boundary moves", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    const first = revision().blocks[0].id;
    expect(controller.moveBlock(first, -1)).toBe(false);
    expect(controller.moveBlock(first, 1)).toBe(true);
    expect(controller.getSnapshot().draft?.blocks.map((block) => block.id)).toEqual([
      revision().blocks[1].id,
      first,
    ]);
    expect(controller.getSnapshot().draft?.blocks[1].props.heading).toBe("Original heading");
    expect(controller.moveBlock(first, 1)).toBe(false);
    expect(Object.isFrozen(controller.getSnapshot().draft?.blocks[1].props)).toBe(true);
  });
  it("allows explicit revision reading but gates editing when root supplies read-only permission", async () => {
    const client = {
      saveDraft: vi.fn(async (command: CmsSaveCommand) => receipt(command)),
      readDocument: vi.fn(),
    };
    const controller = new CmsDraftController({
      document,
      etag: '"1"',
      client,
      policy: { approvedLinkOrigins: new Set() },
      online: true,
      canWrite: false,
      createKey: () => "never-used-key",
    });
    expect(controller.selectRevision(revision())).toBe(true);
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("Original heading");
    expect(controller.canEdit()).toBe(false);
    expect(controller.edit(() => {})).toBe(false);
    expect(controller.startBlank()).toBe(false);
    await controller.save();
    expect(client.saveDraft).not.toHaveBeenCalled();
  });
});

describe("CMS field editor semantic markup (no browser acceptance claim)", () => {
  function markup(controller: CmsDraftController) {
    return renderToStaticMarkup(
      createElement(CmsDraftEditor, {
        controller,
        history: { items: [revision()], hasMore: false, nextCursor: null },
        onLoadMore: () => {},
        onDirty: () => {},
      }),
    );
  }
  it("renders an explicit picker and labelled plain fields with button reorder controls", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    const html = markup(controller);
    expect(html).toContain("Choose an explicit revision");
    expect(html).toContain("Original heading");
    expect(html).toContain('aria-label="Move block 1 down"');
    expect(html).toContain('aria-label="Move block 2 up"');
    expect(html).toContain("Search description");
    expect(html).toContain("Save draft revision");
    expect(html).toContain("History order does not identify the latest draft");
    expect(html).toContain("Undo local edit");
    expect(html).toContain("Redo local edit");
    expect(html).toContain("Show local preview");
    expect(html).toContain('aria-expanded="false"');
  });
  it("escapes unknown recovery JSON and exposes no save/content editing controls", () => {
    const { controller } = setup();
    controller.openRecovery(revision().id, document.id, {
      schemaVersion: 9,
      malicious: "<script>alert('x')</script>",
    });
    const html = markup(controller);
    expect(html).toContain("Read-only recovery");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Save draft revision");
    expect(html).not.toContain("Start a blank draft");
    expect(html).toContain('aria-label="Preserved original revision JSON"');
  });
});

describe("bounded local CMS edit recovery", () => {
  it("undoes block removal and reordering without changing revision identity or document version", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    const initial = controller.getSnapshot();
    const first = revision().blocks[0].id;
    controller.moveBlock(first, 1);
    controller.edit((draft) => {
      draft.blocks = draft.blocks.filter((block) => block.id !== first);
    });
    expect(controller.getSnapshot().canUndo).toBe(true);
    expect(controller.undo()).toBe(true);
    expect(controller.getSnapshot().draft?.blocks.map((block) => block.id)).toEqual([
      revision().blocks[1].id,
      first,
    ]);
    expect(controller.undo()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      draft: initial.draft,
      dirty: false,
      etag: initial.etag,
      selectedRevisionId: initial.selectedRevisionId,
      canUndo: false,
      canRedo: true,
    });
    expect(controller.redo()).toBe(true);
    expect(controller.getSnapshot().dirty).toBe(true);
    expect(controller.redo()).toBe(true);
    expect(controller.getSnapshot().draft?.blocks.map((block) => block.id)).toEqual([
      revision().blocks[1].id,
    ]);
    expect(controller.redo()).toBe(false);
  });
  it("invalidates the redo branch after another edit, and no-op changes create no history", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    expect(controller.edit(() => {})).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, canUndo: false });
    controller.edit((draft) => {
      draft.seo.title = "First edit";
    });
    controller.undo();
    expect(controller.getSnapshot().canRedo).toBe(true);
    controller.edit((draft) => {
      draft.seo.description = "Different branch";
    });
    expect(controller.redo()).toBe(false);
    expect(controller.getSnapshot().draft?.seo).toMatchObject({
      title: "Private draft",
      description: "Different branch",
    });
  });
  it("keeps unsaved blank drafts dirty when all field edits are undone", () => {
    const { controller } = setup();
    controller.startBlank();
    controller.addBlock("text", revision().blocks[0].id);
    controller.undo();
    expect(controller.getSnapshot()).toMatchObject({
      draft: { blocks: [] },
      dirty: true,
      selectedRevisionId: null,
    });
    expect(controller.discardChanges()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      draft: null,
      dirty: false,
      canUndo: false,
      canRedo: false,
    });
  });
  it("locks local history during unknown saves and clears it after the original save resolves", async () => {
    const seen: CmsSaveCommand[] = [];
    const { controller } = setup({
      saveDraft: async (command) => {
        seen.push(structuredClone(command));
        if (seen.length === 1) throw new TypeError("unknown outcome");
        return receipt(command);
      },
    });
    edited(controller);
    expect(controller.getSnapshot().canUndo).toBe(true);
    const saving = controller.save();
    expect(controller.undo()).toBe(false);
    await saving;
    expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", canUndo: false, canRedo: false });
    expect(controller.redo()).toBe(false);
    await controller.save();
    expect(seen[1]).toEqual(seen[0]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "saved",
      dirty: false,
      canUndo: false,
      canRedo: false,
    });
    expect(controller.undo()).toBe(false);
  });
  it("preserves local undo through explicit conflict version recovery", async () => {
    const { controller } = setup({
      saveDraft: async () => {
        throw { status: 412 };
      },
    });
    edited(controller);
    await controller.save();
    expect(controller.undo()).toBe(false);
    await controller.refreshVersion();
    expect(controller.undo()).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      etag: '"3"',
      selectedRevisionId: revision().id,
    });
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("Original heading");
  });
  it("clears edit history on explicit revision replacement, recovery and binding revocation", () => {
    const { controller } = setup();
    edited(controller);
    controller.undo();
    expect(controller.getSnapshot().canRedo).toBe(true);
    controller.selectRevision(revision("a2000000-0000-4000-8000-000000000077"));
    expect(controller.redo()).toBe(false);
    controller.edit((draft) => {
      draft.seo.title = "Change";
    });
    controller.undo();
    controller.openRecovery(revision().id, document.id, { schemaVersion: 3, original: "keep" });
    expect(controller.getSnapshot()).toMatchObject({ canUndo: false, canRedo: false, draft: null });
    controller.selectRevision(revision());
    controller.edit((draft) => {
      draft.seo.title = "Another edit";
    });
    controller.revoke();
    expect(controller.undo()).toBe(false);
    expect(controller.redo()).toBe(false);
    expect(controller.previewDraft()).toBeNull();
  });
  it("caps small edit history at 50 steps instead of retaining an unbounded typing session", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    for (let index = 0; index < 60; index++)
      controller.edit((draft) => {
        draft.blocks[0].props.heading = `Edit ${index}`;
      });
    let count = 0;
    while (controller.undo()) count++;
    expect(count).toBe(50);
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("Edit 9");
    expect(controller.getSnapshot().dirty).toBe(true);
  });
  it("also bounds large Unicode snapshots by UTF-8 bytes while retaining the nearest redo steps", () => {
    const { controller } = setup();
    const large = revision();
    large.blocks = [
      {
        id: large.blocks[0].id,
        type: "text",
        props: { paragraphs: Array.from({ length: 20 }, () => "界".repeat(4000)) },
      },
    ];
    controller.selectRevision(large);
    for (let index = 0; index < 12; index++)
      controller.edit((draft) => {
        draft.seo.title = `Large edit ${index}`;
      });
    let count = 0;
    while (controller.undo()) count++;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(12);
    while (controller.redo()) {}
    expect(controller.getSnapshot().draft?.seo.title).toBe("Large edit 11");
    expect(controller.getSnapshot().draft?.blocks[0].props.paragraphs).toEqual(
      large.blocks[0].props.paragraphs,
    );
  });
  it("rejects an oversized edit with visible feedback and preserves the prior fields/history", () => {
    const { controller } = setup();
    edited(controller);
    const previous = controller.getSnapshot().draft;
    expect(
      controller.edit((draft) => {
        draft.blocks[0].props.heading = "界".repeat(90_000);
      }),
    ).toBe(false);
    expect(controller.getSnapshot().draft).toBe(previous);
    expect(controller.getSnapshot().message).toContain("Your previous draft is retained");
    expect(controller.undo()).toBe(true);
    expect(controller.getSnapshot().dirty).toBe(false);
  });
});

describe("CMS field validation feedback (source and semantic checks)", () => {
  const markup = (controller: CmsDraftController) =>
    renderToStaticMarkup(
      createElement(CmsDraftEditor, {
        controller,
        history: { items: [revision()], hasMore: false, nextCursor: null },
        onLoadMore: () => {},
        onDirty: () => {},
      }),
    );
  it("connects actual heading, paragraph and SEO validation errors to their labelled inputs", async () => {
    const { controller, client, keys } = setup();
    controller.selectRevision(revision());
    controller.edit((draft) => {
      draft.blocks[0].props.heading = "";
      (draft.blocks[1].props.paragraphs as string[])[0] = "<script>unsafe()</script>";
      draft.seo.title = "Long title ".repeat(10);
      draft.seo.canonicalPath = "//unapproved.example";
    });
    const state = controller.getSnapshot();
    const feedback = describeDraftIssues(state.draft, state.issues);
    expect(feedback.map((item) => item.target)).toEqual(
      expect.arrayContaining([
        { kind: "field", path: "/blocks/0/props/heading" },
        { kind: "field", path: "/blocks/1/props/paragraphs/0" },
        { kind: "field", path: "/seo/title" },
        { kind: "field", path: "/seo/canonicalPath" },
      ]),
    );
    const html = markup(controller);
    for (const path of [
      "/blocks/0/props/heading",
      "/blocks/1/props/paragraphs/0",
      "/seo/title",
      "/seo/canonicalPath",
    ]) {
      const tag = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)]
        .map((match) => match[0])
        .find((tag) => tag.includes(`data-cms-field="${path}"`))!;
      expect(tag).toContain('aria-invalid="true"');
      const errorId = /aria-describedby="([^"]+)"/.exec(tag)![1];
      expect(html).toContain(`<span id="${errorId}"`);
      const fieldId = /\bid="([^"]+)"/.exec(tag)![1];
      expect(html).toContain(`<label for="${fieldId}">`);
    }
    expect(html).toContain("Block 1 · Heading");
    expect(html).toContain("Block 2 · Paragraph 1");
    expect(html).toContain("Review invalid fields");
    expect(html).not.toContain("<script>");
    await controller.save();
    expect(keys()).toBe(0);
    expect(client.saveDraft).not.toHaveBeenCalled();
  });
  it("maps denied hero, CTA and footer link targets to the href field, without marking their labels", () => {
    const { controller } = setup();
    const full = revision();
    full.blocks[0].props.action = { label: "Hero action", href: "/contact" };
    full.blocks.push(
      {
        id: "a2000000-0000-4000-8000-000000000003",
        type: "cta",
        props: { label: "Action", href: "/contact" },
      },
      {
        id: "a2000000-0000-4000-8000-000000000004",
        type: "footer",
        props: {
          text: "Footer",
          links: [
            { label: "Good", href: "/privacy" },
            { label: "Bad", href: "/contact" },
          ],
        },
      },
    );
    controller.selectRevision(full);
    controller.edit((draft) => {
      (draft.blocks[0].props.action as { href: string }).href = "javascript:unsafe";
      draft.blocks[2].props.href = "https://unapproved.example";
      (draft.blocks[3].props.links as { href: string }[])[1].href = "//unapproved.example";
    });
    const state = controller.getSnapshot();
    const feedback = describeDraftIssues(state.draft, state.issues);
    expect(feedback.map((item) => item.target)).toEqual([
      { kind: "field", path: "/blocks/0/props/action/href" },
      { kind: "field", path: "/blocks/2/props/href" },
      { kind: "field", path: "/blocks/3/props/links/1/href" },
    ]);
    const html = markup(controller);
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(3);
    expect(html).toContain("Block 4 · Footer link 2 path or approved HTTPS link");
  });
  it("removes stale inline errors after correction and rebuilds field targets after reordering", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    controller.edit((draft) => {
      draft.blocks[0].props.heading = "";
    });
    controller.moveBlock(revision().blocks[0].id, 1);
    const state = controller.getSnapshot();
    expect(describeDraftIssues(state.draft, state.issues)[0]).toMatchObject({
      target: { kind: "field", path: "/blocks/1/props/heading" },
      message: "Block 2 · Heading: Check the required text, format and length.",
    });
    controller.edit((draft) => {
      draft.blocks[1].props.heading = "Fixed heading";
    });
    expect(controller.getSnapshot().issues).toEqual([]);
    const html = markup(controller);
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain("Review invalid fields");
    expect(html).not.toContain("Content needs review");
    expect(html).toContain("Fixed heading");
  });
  it("targets the affected block even for duplicate IDs and deduplicates repeated validator findings", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    controller.edit((draft) => {
      draft.blocks[1].id = draft.blocks[0].id;
    });
    const state = controller.getSnapshot();
    const issue = state.issues.find((issue) => issue.code === "block_id_duplicate")!;
    const feedback = describeDraftIssues(state.draft, [issue, issue]);
    expect(feedback).toHaveLength(1);
    expect(feedback[0].target).toEqual({ kind: "block", path: "/blocks/1" });
    expect(
      describeDraftIssues(state.draft, [{ path: "/unfamiliar", code: "future_error" }])[0].target,
    ).toEqual({ kind: "summary" });
  });
  it("describes preserved recovery issues without pretending there are editable targets", () => {
    const { controller } = setup();
    controller.openRecovery(revision().id, document.id, { schemaVersion: 5, original: "Preserve" });
    const state = controller.getSnapshot();
    expect(describeDraftIssues(state.draft, state.issues)[0].target).toEqual({ kind: "summary" });
    const html = markup(controller);
    expect(html).toContain("Content needs review");
    expect(html).toContain("Read-only recovery");
    expect(html).not.toContain("Review invalid fields");
    expect(html).not.toContain("data-cms-field=");
  });
  it("focuses an exact field attribute and falls back to the summary if the target is disabled or missing", () => {
    const field = {
      getAttribute: vi.fn(() => "/seo/canonicalPath"),
      matches: vi.fn(() => false),
      focus: vi.fn(),
    };
    const summary = { focus: vi.fn() };
    const root = {
      querySelectorAll: vi.fn(() => [field]),
      querySelector: vi.fn(() => summary),
    } as unknown as HTMLElement;
    const feedback = describeDraftIssues(revision(), [
      { path: "/seo/canonicalPath", code: "canonical_path_invalid" },
    ])[0];
    focusDraftFeedback(root, feedback);
    expect(field.focus).toHaveBeenCalledOnce();
    expect(summary.focus).not.toHaveBeenCalled();
    field.matches.mockReturnValue(true);
    focusDraftFeedback(root, feedback);
    expect(summary.focus).toHaveBeenCalledOnce();
    field.matches.mockReturnValue(false);
    field.getAttribute.mockReturnValue("/different");
    focusDraftFeedback(root, feedback);
    expect(summary.focus).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll).toHaveBeenCalledWith("[data-cms-field]");
    expect(field.matches).toHaveBeenCalledWith(":disabled");
  });
});

describe("local validated CMS preview (no public route or browser acceptance)", () => {
  const preview = (controller: CmsDraftController) =>
    renderToStaticMarkup(createElement(CmsDraftPreview, { controller }));
  it("renders all registered fields in order with inactive link targets and escaped search metadata", () => {
    const { controller, client } = setup();
    const full = revision();
    full.blocks[0].props.action = { label: "Hero contact", href: "/contact" };
    full.blocks.push(
      {
        id: "a2000000-0000-4000-8000-000000000003",
        type: "cta",
        props: { label: "Call us", href: "/office" },
      },
      {
        id: "a2000000-0000-4000-8000-000000000004",
        type: "footer",
        props: { text: "Brokerage attribution", links: [{ label: "Privacy", href: "/privacy" }] },
      },
    );
    full.seo.title = "<script>unsafe()</script>";
    controller.selectRevision(full);
    const html = preview(controller);
    expect(html).toContain("Links are inactive");
    expect(html).toContain("Hero contact");
    expect(html).toContain("/office");
    expect(html).toContain("Brokerage attribution");
    expect(html.indexOf("Original heading")).toBeLessThan(html.indexOf("Original paragraph"));
    expect(html.indexOf("Original paragraph")).toBeLessThan(html.indexOf("Call us"));
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toMatch(/<a\b|href=|<script\b|<img\b|<iframe\b|<form\b/);
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(client.readDocument).not.toHaveBeenCalled();
  });
  it("withholds the entire preview for invalid links and reflects undo without changing saved history", () => {
    const { controller } = setup();
    controller.selectRevision(revision());
    controller.edit((draft) => {
      draft.blocks[0].props.action = { label: "Unsafe", href: "https://unapproved.example" };
    });
    expect(controller.previewDraft()).toBeNull();
    const html = preview(controller);
    expect(html).toContain("Local draft preview unavailable");
    expect(html).not.toContain("Original heading");
    expect(html).not.toContain("unapproved.example");
    controller.undo();
    expect(preview(controller)).toContain("Original heading");
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      selectedRevisionId: revision().id,
      etag: '"1"',
    });
  });
  it("never projects unsupported recovery JSON or denied content into a partial preview", () => {
    const { controller } = setup();
    const unknown = revision();
    unknown.blocks[0].props.future = { keep: true };
    controller.selectRevision(unknown);
    expect(controller.previewDraft()).toBeNull();
    expect(preview(controller)).not.toContain("Original heading");
    controller.selectRevision(revision());
    controller.revoke();
    expect(preview(controller)).not.toContain("Original heading");
  });
  it("previews a read-only revision offline without creating a command or enabling edits", () => {
    const client = { saveDraft: vi.fn(), readDocument: vi.fn() };
    const controller = new CmsDraftController({
      document,
      etag: '"1"',
      client,
      policy: { approvedLinkOrigins: new Set() },
      online: false,
      canWrite: false,
      createKey: () => {
        throw new Error("No command allowed");
      },
    });
    controller.selectRevision(revision());
    expect(preview(controller)).toContain("Original heading");
    expect(controller.canEdit()).toBe(false);
    expect(controller.undo()).toBe(false);
    expect(client.saveDraft).not.toHaveBeenCalled();
    expect(client.readDocument).not.toHaveBeenCalled();
  });
});
