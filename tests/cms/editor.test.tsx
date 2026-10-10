import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CmsDraftController,
  type CmsDraftClient,
  type CmsSaveCommand,
} from "../../apps/web/features/cms/draft-controller";
import { CmsDraftEditor } from "../../apps/web/features/cms/draft-editor";
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
