import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  applyCmsRevisionResponse,
  CmsRevisionHistoryControls,
  mergeCmsRevisionMetadata,
  readCmsRevisionHistoryResponse,
  readCmsRevisionRecoveryResponse,
  readCmsSelectedRevision,
  requireCmsRevisionHistory,
  type CmsRevisionHistory,
  type CmsRevisionMetadata,
} from "../../apps/web/components/cms-workspace";
import { CmsDraftController, type CmsSaveCommand } from "../../apps/web/features/cms/draft-controller";
import { CmsDraftEditor } from "../../apps/web/features/cms/draft-editor";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import { revisionRecovery } from "../../packages/cms/recovery";

const document: Schema<"Document"> = {
  id: "a2000000-0000-4000-8000-000000000010",
  siteId: "a2000000-0000-4000-8000-000000000011",
  kind: "page",
  title: "Private draft",
  slug: "private",
  version: 1,
  publishedRevisionId: null,
};
const futureId = "a2000000-0000-4000-8000-000000000003";
const supportedId = "a2000000-0000-4000-8000-000000000099";
const otherId = "a2000000-0000-4000-8000-000000000066";
const createdAt = "2026-10-10T00:00:00.000Z";
const metadata = (id = futureId, schemaVersion = 2): CmsRevisionMetadata => ({
  id,
  documentId: document.id,
  schemaVersion,
  createdAt,
});
const index = (): CmsRevisionHistory => ({
  items: [metadata(supportedId, 1), metadata()],
  hasMore: false,
  nextCursor: null,
});
const revision = (): Schema<"Revision"> => ({
  id: supportedId,
  documentId: document.id,
  schemaVersion: 1,
  createdAt,
  blocks: [{ id: otherId, type: "hero", props: { heading: "Original heading" } }],
  seo: { title: "Private draft", description: "", noindex: true },
});
const original = () => ({
  schemaVersion: 2,
  blocks: [{ futureKind: "<script>preserve()</script>", nested: { unknown: [1, null, true] } }],
  seo: { futureSeo: "preserve exactly" },
});
const recovery = () =>
  revisionRecovery(futureId, document.id, original(), [
    { path: "/schemaVersion", code: "schema_version_unsupported" },
  ]);
function setup(save?: (command: CmsSaveCommand) => Promise<{ data: Schema<"Revision">; etag: string }>) {
  let keys = 0;
  const client = {
    saveDraft: vi.fn(
      save ??
        (async (command: CmsSaveCommand) => ({
          data: { ...command.body, id: otherId, documentId: command.documentId, createdAt },
          etag: '"2"',
        })),
    ),
    readDocument: vi.fn(async () => ({ data: document, etag: '"1"' })),
  };
  const controller = new CmsDraftController({
    document,
    etag: '"1"',
    client,
    policy: { approvedLinkOrigins: new Set() },
    canWrite: true,
    online: true,
    createKey: () => `fixed-draft-key-${++keys}`,
  });
  return { controller, client, keys: () => keys };
}

describe("closed CMS revision metadata index", () => {
  it("keeps supported and future versions in returned order without selecting any revision", () => {
    const { controller } = setup();
    const value = index();
    const verified = requireCmsRevisionHistory(value, document.id);
    expect(verified).toEqual(value);
    expect(verified.items.map((item) => item.id)).toEqual([supportedId, futureId]);
    expect(controller.getSnapshot()).toMatchObject({ selectedRevisionId: null, draft: null, recovery: null });
    value.items[1].schemaVersion = 999;
    expect(verified.items[1].schemaVersion).toBe(2);
  });

  it.each([
    { ...index(), version: 1 },
    { ...index(), items: [{ ...metadata(), blocks: [] }] },
    { ...index(), items: [metadata(), metadata()] },
    { ...index(), items: [metadata(), { ...metadata(), id: futureId.toUpperCase() }] },
    { ...index(), items: [{ ...metadata(), documentId: otherId }] },
    { ...index(), items: [{ ...metadata(), id: "not-a-uuid" }] },
    { ...index(), items: [{ ...metadata(), schemaVersion: 0 }] },
    { ...index(), items: [{ ...metadata(), schemaVersion: 2_147_483_648 }] },
    { ...index(), items: [{ ...metadata(), schemaVersion: 1.5 }] },
    { ...index(), items: [{ ...metadata(), createdAt: "not-a-date" }] },
    { ...index(), hasMore: true, nextCursor: null },
    { ...index(), hasMore: false, nextCursor: "unexpected" },
    { items: [], hasMore: true, nextCursor: "cursor" },
    { ...index(), nextCursor: "x".repeat(4097), hasMore: true },
    { items: Array.from({ length: 101 }, () => metadata()), hasMore: false, nextCursor: null },
  ])("rejects invalid shape, provenance and cursor state %#", (value) => {
    expect(() => requireCmsRevisionHistory(value, document.id)).toThrow();
  });

  it("rejects cycles, accessors and sparse items before unsafe JSON can be used", () => {
    let reads = 0;
    const accessor = {
      ...index(),
      get unexpected() {
        ++reads;
        return "private";
      },
    };
    expect(() => requireCmsRevisionHistory(accessor, document.id)).toThrow();
    expect(reads).toBe(0);
    const cycle: Record<string, unknown> = { ...index() };
    cycle.cycle = cycle;
    expect(() => requireCmsRevisionHistory(cycle, document.id)).toThrow();
    expect(() => requireCmsRevisionHistory({ ...index(), items: new Array(2) }, document.id)).toThrow();
  });

  it("deduplicates an unchanged immutable ID across pages without sorting or dropping future rows", () => {
    const previous = index().items;
    const next = [metadata(), metadata(otherId, 3)];
    const combined = mergeCmsRevisionMetadata(previous, next);
    expect(combined.map((item) => item.id)).toEqual([supportedId, futureId, otherId]);
    expect(combined.map((item) => item.schemaVersion)).toEqual([1, 2, 3]);
    expect(previous).toHaveLength(2);
    expect(next).toHaveLength(2);
  });

  it.each([
    { ...metadata(), id: futureId.toUpperCase() },
    { ...metadata(), schemaVersion: 3 },
    { ...metadata(), documentId: otherId },
    { ...metadata(), createdAt: "2026-10-10T00:01:00.000Z" },
  ])("rejects changed metadata for a previously read immutable ID %#", (changed) => {
    const previous = index().items;
    expect(() => mergeCmsRevisionMetadata(previous, [changed])).toThrow("immutable revision");
    expect(previous).toEqual(index().items);
  });
});

describe("CMS index byte and error boundaries", () => {
  it("accepts exactly 64 KiB but rejects larger transport including JSON whitespace", async () => {
    const json = JSON.stringify(index());
    const exact = `${json}${" ".repeat(64 * 1024 - new TextEncoder().encode(json).byteLength)}`;
    await expect(readCmsRevisionHistoryResponse(new Response(exact), document.id)).resolves.toEqual(index());
    await expect(readCmsRevisionHistoryResponse(new Response(`${exact} `), document.id)).rejects.toThrow(
      "64 KiB",
    );
  });

  it("cancels oversized streamed content rather than reading the remaining private bytes", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel,
    });
    await expect(readCmsRevisionHistoryResponse(new Response(stream), document.id)).rejects.toThrow("64 KiB");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("denies malformed UTF-8 and JSON without displaying a partial response", async () => {
    await expect(
      readCmsRevisionHistoryResponse(new Response(new Uint8Array([0xff])), document.id),
    ).rejects.toThrow("UTF-8 JSON");
    await expect(readCmsRevisionHistoryResponse(new Response("{truncated"), document.id)).rejects.toThrow(
      "UTF-8 JSON",
    );
  });

  it.each([401, 403])(
    "preserves definite access status %i for malformed or oversized error bodies",
    async (status) => {
      await expect(
        readCmsRevisionHistoryResponse(new Response("{bad", { status }), document.id),
      ).rejects.toMatchObject({ status });
      await expect(
        readCmsRevisionHistoryResponse(new Response(" ".repeat(64 * 1024 + 1), { status }), document.id),
      ).rejects.toMatchObject({ status });
    },
  );

  it("retains the server recovery/error code without copying unrestricted details", async () => {
    try {
      await readCmsRevisionHistoryResponse(
        new Response(JSON.stringify({ code: "membership_required", detail: "private detail" }), {
          status: 403,
        }),
        document.id,
      );
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 403, code: "membership_required" });
      expect((error as Error).message).not.toContain("private detail");
    }
  });
});

describe("CMS recovery transport and exact response boundary", () => {
  it("accepts an exact 1 MiB recovery envelope including whitespace and rejects an extra byte before parsing", async () => {
    const json = JSON.stringify(recovery());
    const exact = `${json}${" ".repeat(1024 * 1024 - new TextEncoder().encode(json).byteLength)}`;
    await expect(readCmsRevisionRecoveryResponse(new Response(exact), metadata())).resolves.toEqual(
      recovery(),
    );
    await expect(readCmsRevisionRecoveryResponse(new Response(`${exact} `), metadata())).rejects.toThrow(
      "1 MiB",
    );
    // The metadata index retains its smaller bound even though recovery has a larger allowance.
    await expect(readCmsRevisionHistoryResponse(new Response(exact), document.id)).rejects.toThrow("64 KiB");
  });

  it("counts UTF-8 bytes rather than JavaScript code units", async () => {
    const value = revisionRecovery(
      futureId,
      document.id,
      {
        ...original(),
        seo: { futureSeo: "🙂".repeat(60_000) },
      },
      [],
    );
    const json = JSON.stringify(value);
    expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(json.length);
    const exact = `${json}${" ".repeat(1024 * 1024 - new TextEncoder().encode(json).byteLength)}`;
    expect(exact.length).toBeLessThan(1024 * 1024);
    await expect(readCmsRevisionRecoveryResponse(new Response(exact), metadata())).resolves.toEqual(value);
    await expect(readCmsRevisionRecoveryResponse(new Response(`${exact} `), metadata())).rejects.toThrow(
      "1 MiB",
    );
  });

  it("cancels an oversized recovery stream without committing any partial original content", async () => {
    const { controller } = setup();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new Uint8Array(1024 * 1024));
        source.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(
      readCmsSelectedRevision({
        controller,
        metadata: metadata(),
        recovery: true,
        read: () => readCmsRevisionRecoveryResponse(new Response(stream), metadata()),
        isCurrent: () => true,
      }),
    ).rejects.toThrow("1 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ recovery: null, draft: null, selectedRevisionId: null });
  });

  it("rejects malformed UTF-8 and truncated JSON before invoking the recovery controller", async () => {
    await expect(
      readCmsRevisionRecoveryResponse(new Response(new Uint8Array([0xff])), metadata()),
    ).rejects.toThrow("UTF-8 JSON");
    await expect(readCmsRevisionRecoveryResponse(new Response("{truncated"), metadata())).rejects.toThrow(
      "UTF-8 JSON",
    );
  });

  it("retains the shared 256 KiB original JSON bound inside a transport smaller than 1 MiB", async () => {
    const value = { ...recovery(), data: { ...original(), seo: { futureSeo: "x".repeat(256 * 1024) } } };
    const json = JSON.stringify(value);
    expect(new TextEncoder().encode(json).byteLength).toBeLessThan(1024 * 1024);
    await expect(readCmsRevisionRecoveryResponse(new Response(json), metadata())).rejects.toThrow(
      "supported limits",
    );
  });

  it.each([
    { ...recovery(), id: otherId },
    { ...recovery(), documentId: otherId },
    { ...recovery(), data: { ...original(), schemaVersion: 3 } },
    { ...recovery(), canSave: true },
    { ...recovery(), canPublish: true },
  ])("rejects mismatched IDs/schema and writable flags before returning raw JSON %#", async (value) => {
    await expect(
      readCmsRevisionRecoveryResponse(new Response(JSON.stringify(value)), metadata()),
    ).rejects.toThrow();
  });

  it.each([401, 403, 409, 503])(
    "keeps safe typed status/code %i without copying private Problem details",
    async (status) => {
      const value = { code: "revision_recovery_required", detail: "Private original contact or credentials" };
      await expect(
        readCmsRevisionRecoveryResponse(new Response(JSON.stringify(value), { status }), metadata()),
      ).rejects.toMatchObject({
        status,
        code: "revision_recovery_required",
      });
      try {
        await readCmsRevisionRecoveryResponse(new Response(JSON.stringify(value), { status }), metadata());
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as Error).message).not.toContain(value.detail);
      }
    },
  );

  it.each([401, 403])(
    "preserves definite access status %i even with empty, malformed or oversized error streams",
    async (status) => {
      await expect(
        readCmsRevisionRecoveryResponse(new Response(null, { status }), metadata()),
      ).rejects.toMatchObject({ status });
      await expect(
        readCmsRevisionRecoveryResponse(new Response(new Uint8Array([0xff]), { status }), metadata()),
      ).rejects.toMatchObject({ status });
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(source) {
          source.enqueue(new Uint8Array(64 * 1024 + 1));
        },
        cancel,
      });
      await expect(
        readCmsRevisionRecoveryResponse(new Response(stream, { status }), metadata()),
      ).rejects.toMatchObject({ status });
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it.each([42, "x".repeat(81), { private: "object" }])(
    "drops malformed Problem codes using the frozen code shape %#",
    async (code) => {
      await expect(
        readCmsRevisionRecoveryResponse(
          new Response(JSON.stringify({ code, detail: "private" }), { status: 403 }),
          metadata(),
        ),
      ).rejects.toMatchObject({
        status: 403,
        code: undefined,
      });
    },
  );

  it("ignores a bounded recovery error from a superseded context without replacing current editor data", async () => {
    const { controller } = setup();
    let current = true;
    let resolve!: (value: Response) => void;
    const pending = readCmsSelectedRevision({
      controller,
      metadata: metadata(),
      recovery: true,
      read: async () =>
        readCmsRevisionRecoveryResponse(
          await new Promise<Response>((done) => {
            resolve = done;
          }),
          metadata(),
        ),
      isCurrent: () => current,
    });
    current = false;
    applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false);
    resolve(new Response("{bad", { status: 403 }));
    await expect(pending).resolves.toBe("superseded");
    expect(controller.getSnapshot()).toMatchObject({
      selectedRevisionId: supportedId,
      recovery: null,
      phase: "editing",
    });
  });
});

describe("wrapper explicit normal and read-only recovery injection", () => {
  it("offers recovery only for the exact unsupported normal-read response, without automatically reading it", async () => {
    const { controller } = setup();
    const read = vi.fn(async () => {
      throw new ApiError(409, "unsupported", "revision_recovery_required");
    });
    await expect(
      readCmsSelectedRevision({
        controller,
        metadata: metadata(),
        recovery: false,
        read,
        isCurrent: () => true,
      }),
    ).resolves.toBe("recovery_required");
    expect(read).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ recovery: null, draft: null, selectedRevisionId: null });
    await expect(
      readCmsSelectedRevision({
        controller,
        metadata: metadata(),
        recovery: true,
        read,
        isCurrent: () => true,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      readCmsSelectedRevision({
        controller,
        metadata: metadata(),
        recovery: false,
        read: async () => {
          throw new ApiError(409, "other conflict", "revision_conflict");
        },
        isCurrent: () => true,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("does not dispatch a read once the document/member request binding has already changed", async () => {
    const { controller } = setup();
    const read = vi.fn(async () => recovery());
    await expect(
      readCmsSelectedRevision({
        controller,
        metadata: metadata(),
        recovery: true,
        read,
        isCurrent: () => false,
      }),
    ).resolves.toBe("superseded");
    expect(read).not.toHaveBeenCalled();
  });

  it("ignores an original recovery success arriving after a new request/context or offline invalidation", async () => {
    const { controller } = setup();
    let current = true;
    let resolve!: (value: unknown) => void;
    const pending = readCmsSelectedRevision({
      controller,
      metadata: metadata(),
      recovery: true,
      read: () =>
        new Promise((done) => {
          resolve = done;
        }),
      isCurrent: () => current,
    });
    current = false;
    applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false);
    resolve(recovery());
    await expect(pending).resolves.toBe("superseded");
    expect(controller.getSnapshot()).toMatchObject({ selectedRevisionId: supportedId, recovery: null });
  });

  it.each([
    new ApiError(401, "old identity denied"),
    new ApiError(403, "old membership denied"),
    new TypeError("old transport failed"),
  ])("ignores a superseded failure without invalidating the new context %#", async (failure) => {
    const { controller } = setup();
    let current = true;
    let reject!: (value: unknown) => void;
    const pending = readCmsSelectedRevision({
      controller,
      metadata: metadata(),
      recovery: true,
      read: () =>
        new Promise((_done, denied) => {
          reject = denied;
        }),
      isCurrent: () => current,
    });
    current = false;
    applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false);
    reject(failure);
    await expect(pending).resolves.toBe("superseded");
    expect(controller.getSnapshot()).toMatchObject({
      phase: "editing",
      selectedRevisionId: supportedId,
      recovery: null,
    });
  });

  it("requires the exact document/id/schema binding for an editable frozen response", () => {
    const { controller } = setup();
    expect(() =>
      applyCmsRevisionResponse(controller, metadata(supportedId, 1), { ...revision(), id: otherId }, false),
    ).toThrow("metadata");
    expect(() =>
      applyCmsRevisionResponse(
        controller,
        metadata(supportedId, 1),
        { ...revision(), documentId: otherId },
        false,
      ),
    ).toThrow("metadata");
    expect(() => applyCmsRevisionResponse(controller, metadata(supportedId, 2), revision(), false)).toThrow(
      "metadata",
    );
    expect(controller.getSnapshot().selectedRevisionId).toBeNull();
    applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false);
    expect(controller.getSnapshot()).toMatchObject({
      selectedRevisionId: supportedId,
      recovery: null,
      dirty: false,
    });
    expect(controller.canEdit()).toBe(true);
  });

  it("rejects future data as a normal frozen Revision and never converts it into a supported version", () => {
    const { controller } = setup();
    expect(() =>
      applyCmsRevisionResponse(
        controller,
        metadata(),
        { ...original(), id: futureId, documentId: document.id, createdAt },
        false,
      ),
    ).toThrow();
    expect(controller.getSnapshot()).toMatchObject({ draft: null, recovery: null, selectedRevisionId: null });
  });

  it.each([
    { ...recovery(), id: otherId },
    { ...recovery(), documentId: otherId },
    { ...recovery(), data: { ...original(), schemaVersion: 3 } },
    { ...recovery(), canSave: true },
    { ...recovery(), canPublish: true },
  ])("denies mismatched or writable recovery before showing original JSON %#", (response) => {
    const { controller } = setup();
    expect(() => applyCmsRevisionResponse(controller, metadata(), response, true)).toThrow();
    expect(controller.getSnapshot()).toMatchObject({ recovery: null, draft: null, selectedRevisionId: null });
  });

  it("uses the controller recovery reader, preserving escaped raw JSON with no save or publish action", async () => {
    const { controller, client } = setup();
    applyCmsRevisionResponse(controller, metadata(), recovery(), true);
    expect(controller.getSnapshot().recovery?.data).toEqual(original());
    expect(controller.canEdit()).toBe(false);
    expect(controller.previewDraft()).toBeNull();
    await controller.save();
    expect(client.saveDraft).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(
      <CmsDraftEditor
        controller={controller}
        history={{ items: [], hasMore: false, nextCursor: null }}
        onLoadMore={() => {}}
        onDirty={() => {}}
      />,
    );
    expect(html).toContain("&lt;script&gt;preserve()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Save draft revision");
    expect(html).toContain("Read-only revision recovery");
  });

  it("keeps a dirty draft and the original unknown command after attempted recovery, then reconciles the same key", async () => {
    const seen: CmsSaveCommand[] = [];
    const { controller, keys } = setup(async (command) => {
      seen.push(structuredClone(command));
      if (seen.length === 1) throw new TypeError("lost acknowledgement");
      return {
        data: { ...command.body, id: otherId, documentId: command.documentId, createdAt },
        etag: '"2"',
      };
    });
    applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false);
    controller.edit((draft) => {
      draft.blocks[0].props.heading = "Unsaved protected heading";
    });
    expect(() => applyCmsRevisionResponse(controller, metadata(), recovery(), true)).toThrow("protected");
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(() => applyCmsRevisionResponse(controller, metadata(), recovery(), true)).toThrow("protected");
    expect(controller.getSnapshot().draft?.blocks[0].props.heading).toBe("Unsaved protected heading");
    await controller.save();
    expect(seen[1]).toEqual(seen[0]);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot().phase).toBe("saved");
  });

  it("rejects late recovery and normal injections after offline or revoked context", () => {
    const { controller } = setup();
    applyCmsRevisionResponse(controller, metadata(), recovery(), true);
    controller.setOnline(false);
    expect(controller.getSnapshot().recovery).toBeNull();
    expect(() => applyCmsRevisionResponse(controller, metadata(), recovery(), true)).toThrow("verify");
    expect(() => applyCmsRevisionResponse(controller, metadata(supportedId, 1), revision(), false)).toThrow(
      "verify",
    );
    controller.setOnline(true);
    controller.revoke();
    expect(() => applyCmsRevisionResponse(controller, metadata(), recovery(), true)).toThrow("verify");
    expect(controller.getSnapshot().recovery).toBeNull();
  });
});

describe("explicit index controls (static semantics, not browser acceptance)", () => {
  const controls = (options: Partial<Parameters<typeof CmsRevisionHistoryControls>[0]> = {}) =>
    renderToStaticMarkup(
      <CmsRevisionHistoryControls
        history={index()}
        loaded
        online
        locked={false}
        loading={false}
        reading={false}
        selectedId=""
        recoveryRequired={false}
        error=""
        onSelect={vi.fn()}
        onRead={vi.fn()}
        onRecover={vi.fn()}
        onRefresh={vi.fn()}
        onMore={vi.fn()}
        {...options}
      />,
    );

  it("includes every version but chooses no row and offers no recovery until an explicit unsupported read", () => {
    const html = controls();
    expect(html).toContain("Schema 1");
    expect(html).toContain("Schema 2");
    expect(html).toContain('value="" selected=""');
    expect(html).toContain("Read selected revision");
    expect(html).not.toContain("Read original JSON in recovery");
    expect(html).toContain("does not identify the latest");
  });

  it("offers a separate clearly read-only recovery action for the explicitly selected unsupported row", () => {
    const html = controls({ selectedId: futureId, recoveryRequired: true });
    expect(html).toContain(`value="${futureId}" selected=""`);
    expect(html).toContain("Read original JSON in recovery");
    expect(html).toContain("Recovery cannot save or publish");
    expect(html).not.toContain("Save draft revision");
  });

  it("hides private index/cursor/recovery controls immediately offline", () => {
    const html = controls({
      online: false,
      selectedId: futureId,
      recoveryRequired: true,
      history: { ...index(), hasMore: true, nextCursor: "private-cursor" },
    });
    expect(html).not.toContain(futureId);
    expect(html).not.toContain(supportedId);
    expect(html).not.toContain("private-cursor");
    expect(html).not.toContain("Read original JSON in recovery");
    expect(html).toContain("cleared while offline");
  });

  it("escapes error text and keeps revision reads disabled during protected work", () => {
    const html = controls({
      locked: true,
      selectedId: futureId,
      recoveryRequired: true,
      error: "<img src=x onerror=unsafe()>",
    });
    expect(html).toContain("&lt;img src=x onerror=unsafe()&gt;");
    expect(html).not.toContain("<img");
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
