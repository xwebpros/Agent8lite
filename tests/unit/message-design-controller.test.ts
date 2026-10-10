import { describe, expect, it, vi } from "vitest";
import {
  MessageDesignController,
  type MessageDesignClient,
} from "../../apps/web/components/message-design-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "e3000000-0000-4000-8000-000000000001",
  otherId = "e3000000-0000-4000-8000-000000000002";
const body = (): Schema<"MessageDesignWrite"> => ({
  name: "Private native message",
  channel: "email",
  editor: "native",
  design: {
    schemaVersion: 1,
    blocks: [
      { type: "text", text: "First text" },
      { type: "text", text: "Second text" },
    ],
  },
  content: "First text\nSecond text",
});
const entity = (version = 1): Schema<"MessageDesign"> => ({ ...body(), id, version, subject: null });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(canWrite = true) {
  let keys = 0;
  const protectedChange = vi.fn(),
    accessRevoked = vi.fn();
  const client = {
    list: vi.fn<MessageDesignClient["list"]>(async () => ({
      items: [entity()],
      hasMore: false,
      nextCursor: null,
    })),
    detail: vi.fn<MessageDesignClient["detail"]>(async () => ({ data: entity(), etag: '"1"' })),
    submit: vi.fn<MessageDesignClient["submit"]>(async (command) => ({
      data: {
        ...entity(command.kind === "create" ? 1 : Number(command.ifMatch!.replaceAll('"', "")) + 1),
        ...command.body,
      },
      etag: command.kind === "create" ? '"1"' : `"${Number(command.ifMatch!.replaceAll('"', "")) + 1}"`,
    })),
  };
  const controller = new MessageDesignController({
    binding: "opaque-message-context",
    client,
    online: true,
    canRead: true,
    canWrite,
    createKey: () => `original-message-key-${++keys}`,
    onProtectedChange: protectedChange,
    onAccessRevoked: accessRevoked,
  });
  return { controller, client, protectedChange, accessRevoked, keys: () => keys };
}
function newDraft(controller: MessageDesignController) {
  expect(controller.beginCreate()).toBe(true);
  expect(controller.edit("name", "Reviewed new message")).toBe(true);
  expect(controller.editBlock(0, "Static first paragraph")).toBe(true);
}

describe("native message authoring and current reads", () => {
  it.each(["name", "subject", "content"] as const)(
    "never starts a command for a malformed Unicode %s field",
    async (field) => {
      const { controller, client, keys } = setup();
      newDraft(controller);
      if (field === "content") controller.editBlock(0, "Malformed \uD800 text");
      else controller.edit(field, "Malformed \uDC00 text");
      await controller.save();
      expect(client.submit).not.toHaveBeenCalled();
      expect(keys()).toBe(0);
      expect(controller.getSnapshot().pending).toBeNull();
      expect(controller.getSnapshot().issues).toContainEqual(expect.objectContaining({ field }));
      const paired = "\uD83D\uDE00 cafe\u0301";
      if (field === "content") controller.editBlock(0, paired);
      else controller.edit(field, paired);
      await controller.save();
      expect(client.submit).toHaveBeenCalledOnce();
      expect(client.submit.mock.calls[0][0].body[field]).toBe(paired);
    },
  );
  it("loads only an explicit bounded page and exact current design; null subject stays omitted", async () => {
    const { controller, client } = setup();
    client.list.mockResolvedValueOnce({ items: [entity()], hasMore: true, nextCursor: "current-cursor" });
    await controller.loadPage();
    expect(controller.getSnapshot().selected).toBeNull();
    await controller.loadPage("invented-cursor");
    expect(client.list).toHaveBeenCalledOnce();
    await controller.select(id);
    expect(controller.getSnapshot().input).not.toHaveProperty("subject");
    expect(controller.getSnapshot().ifMatch).toBe('"1"');
    expect(controller.isProtected()).toBe(false);
  });
  it("preserves unsupported formats read-only and never converts them implicitly", async () => {
    const { controller, client } = setup();
    client.detail.mockResolvedValueOnce({
      data: {
        ...entity(),
        editor: "unlayer",
        design: { html: "<h1>Original</h1>" },
        content: "Stored original",
      },
      etag: '"1"',
    });
    await controller.select(id);
    expect(controller.getSnapshot().selected!.data.design).toEqual({ html: "<h1>Original</h1>" });
    expect(controller.getSnapshot().input).toBeNull();
    expect(controller.copySelected()).toBe(false);
    expect(controller.editBlock(0, "Replacement")).toBe(false);
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
  });
  it("protects new drafts synchronously and builds content from exact ordered blocks", () => {
    const { controller, protectedChange } = setup();
    newDraft(controller);
    expect(protectedChange).toHaveBeenLastCalledWith(true);
    expect(controller.changeBlocks("add")).toBe(true);
    expect(controller.editBlock(1, "  Second\tparagraph\nline  ")).toBe(true);
    expect(controller.getSnapshot().input!.content).toBe(
      "Static first paragraph\n  Second\tparagraph\nline  ",
    );
    controller.changeBlocks("up", 1);
    expect(controller.getSnapshot().input!.content).toBe(
      "  Second\tparagraph\nline  \nStatic first paragraph",
    );
    controller.changeBlocks("remove", 1);
    expect(controller.getSnapshot().input!.content).toBe("  Second\tparagraph\nline  ");
    expect(controller.changeBlocks("remove", 0)).toBe(false);
  });
  it("fixes channel/editor for updates but supports explicit new-ID copy with another channel", async () => {
    const { controller, client } = setup();
    await controller.select(id);
    expect(controller.edit("channel", "sms")).toBe(false);
    const original = controller.getSnapshot().selected;
    expect(controller.copySelected()).toBe(true);
    expect(controller.getSnapshot().targetId).toBeNull();
    expect(controller.edit("channel", "sms")).toBe(true);
    await controller.save();
    expect(client.submit.mock.calls[0][0]).toMatchObject({
      kind: "create",
      designId: null,
      ifMatch: null,
      body: { channel: "sms", editor: "native" },
    });
    expect(original!.data.channel).toBe("email");
    expect(original!.data.content).toBe("First text\nSecond text");
  });
  it("rejects static syntax and Unicode/byte overflow without losing earlier valid fields", async () => {
    const { controller, client } = setup();
    newDraft(controller);
    expect(controller.edit("name", "😀".repeat(121))).toBe(false);
    expect(controller.getSnapshot().input!.name).toBe("Reviewed new message");
    controller.editBlock(0, "{{private}} https:link");
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().issues).toContainEqual(
      expect.objectContaining({ field: "design.blocks.0.text" }),
    );
    controller.editBlock(0, "Safe text");
    expect(controller.editBlock(0, "😀".repeat(50000))).toBe(false);
    expect(controller.getSnapshot().input!.content).toBe("Safe text");
    await controller.save();
    expect(client.submit).toHaveBeenCalledOnce();
  });
  it("cannot author with read-only permission or read a foreign/wrong-revision response", async () => {
    const { controller, client } = setup(false);
    expect(controller.beginCreate()).toBe(false);
    client.detail.mockResolvedValueOnce({ data: { ...entity(), id: otherId }, etag: '"1"' });
    await controller.select(id);
    expect(controller.getSnapshot().selected).toBeNull();
    await controller.select(id);
    expect(controller.copySelected()).toBe(false);
    expect(controller.edit("name", "Forbidden")).toBe(false);
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
  });
});

describe("original native command and explicit revision recovery", () => {
  it.each([
    new ApiError(412, "Unexpected create revision"),
    new ApiError(409, "Unexpected create reference", "design_referenced_immutable"),
  ])("fails closed for update-only statuses on a create command %s", async (error) => {
    const { controller, client } = setup();
    newDraft(controller);
    client.submit.mockRejectedValueOnce(error);
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(controller.copyImmutable()).toBe(false);
    expect(controller.resolveConflict(true)).toBe(false);
    expect(controller.getSnapshot().pending!.kind).toBe("create");
  });
  it("retains exact unknown input/key/revision and recognizes historical replay only as acknowledgment", async () => {
    const { controller, client, keys } = setup();
    await controller.select(id);
    controller.edit("name", "Reviewed change");
    client.submit.mockRejectedValueOnce(new DOMException("Timeout", "AbortError"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    expect(original).toMatchObject({ kind: "update", designId: id, ifMatch: '"1"' });
    expect(Object.isFrozen(original!.body.design)).toBe(true);
    expect(controller.discard()).toBe(false);
    expect(controller.copySelected()).toBe(false);
    expect(controller.editRejected()).toBe(false);
    expect(controller.editBlock(0, "Replacement")).toBe(false);
    await controller.loadPage();
    await controller.select(otherId);
    expect(client.list).not.toHaveBeenCalled();
    expect(client.detail).toHaveBeenCalledOnce();
    await controller.save();
    expect(client.submit.mock.calls[1][0]).toEqual(original);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "acknowledged",
      pending: null,
      input: null,
      selected: null,
    });
    expect(controller.getSnapshot().receipt!.data.version).toBe(2);
  });
  it("uses a detached command and blocks concurrent submits", async () => {
    const { controller, client } = setup();
    newDraft(controller);
    const deferredResult = deferred<Awaited<ReturnType<MessageDesignClient["submit"]>>>();
    client.submit.mockImplementationOnce((command) => {
      command.body.name = "Client-mutated";
      return deferredResult.promise;
    });
    const saving = controller.save();
    const original = controller.getSnapshot().pending;
    expect(original!.body.name).toBe("Reviewed new message");
    await controller.save();
    expect(client.submit).toHaveBeenCalledOnce();
    deferredResult.resolve({ data: { ...entity(), ...original!.body }, etag: '"1"' });
    await saving;
    expect(controller.getSnapshot().phase).toBe("acknowledged");
  });
  it("treats mismatched ID/body/channel/sequence and weak ETag acknowledgments as unknown", async () => {
    for (const result of [
      { data: entity(2), etag: 'W/"2"' },
      { data: { ...entity(2), id: otherId }, etag: '"2"' },
      { data: { ...entity(2), name: "Reviewed change", channel: "sms" }, etag: '"2"' },
      { data: { ...entity(3), name: "Reviewed change" }, etag: '"3"' },
    ]) {
      const { controller, client } = setup();
      await controller.select(id);
      controller.edit("name", "Reviewed change");
      client.submit.mockResolvedValueOnce(result);
      await controller.save();
      expect(controller.getSnapshot().phase).toBe("uncertain");
      expect(controller.isProtected()).toBe(true);
    }
  });
  it("offers copy only after a first known referenced-design rejection, with a new POST key", async () => {
    const { controller, client, keys } = setup();
    await controller.select(id);
    controller.editBlock(0, "Edited text");
    client.submit.mockRejectedValueOnce(new ApiError(409, "private", "design_referenced_immutable"));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("immutable");
    const original = controller.getSnapshot().pending;
    expect(controller.isProtected()).toBe(true);
    expect(client.submit).toHaveBeenCalledOnce();
    expect(controller.copyImmutable()).toBe(true);
    expect(controller.getSnapshot().mode).toBe("create");
    expect(controller.getSnapshot().input).toEqual(original!.body);
    expect(keys()).toBe(1);
    await controller.save();
    const copied = client.submit.mock.calls[1][0];
    expect(copied).toMatchObject({ kind: "create", designId: null, ifMatch: null });
    expect(copied.idempotencyKey).not.toBe(original!.idempotencyKey);
  });
  it.each([
    new ApiError(409, "private", "design_referenced_immutable"),
    new ApiError(412, "private", "revision_stale"),
    new ApiError(422, "private"),
    new ApiError(429, "private"),
  ])("does not release an already unknown command after a later rejection %s", async (error) => {
    const { controller, client } = setup();
    await controller.select(id);
    controller.edit("name", "Unknown change");
    client.submit.mockRejectedValueOnce(new Error("Unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    client.submit.mockRejectedValueOnce(error);
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(controller.getSnapshot().pending).toBe(original);
    expect(controller.copyImmutable()).toBe(false);
    expect(controller.editRejected()).toBe(false);
    expect(controller.resolveConflict(true)).toBe(false);
  });
  it("requires explicit fresh conflict read and review before changing If-Match; no automatic save", async () => {
    const { controller, client } = setup();
    await controller.select(id);
    controller.edit("name", "Original reviewed fields");
    client.submit.mockRejectedValueOnce(new ApiError(412, "private", "revision_stale"));
    await controller.save();
    expect(controller.resolveConflict(true)).toBe(false);
    client.detail.mockResolvedValueOnce({ data: { ...entity(5), name: "Current fields" }, etag: '"5"' });
    await controller.readConflict();
    expect(controller.getSnapshot().pending!.ifMatch).toBe('"1"');
    expect(controller.resolveConflict(true)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      ifMatch: '"5"',
      pending: null,
      input: { name: "Original reviewed fields" },
    });
    expect(client.submit).toHaveBeenCalledOnce();
    await controller.save();
    expect(client.submit.mock.calls[1][0].ifMatch).toBe('"5"');
  });
  it("releases first known invalid input only on explicit edit and omits a deleted optional subject", async () => {
    const { controller, client } = setup();
    newDraft(controller);
    controller.edit("subject", "Subject");
    controller.edit("subject", "");
    client.submit.mockRejectedValueOnce(new ApiError(422, "private"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    expect(original!.body).not.toHaveProperty("subject");
    expect(controller.discard()).toBe(false);
    expect(controller.editRejected()).toBe(true);
    controller.edit("name", "Revised");
    await controller.save();
    expect(client.submit.mock.calls[1][0].idempotencyKey).not.toBe(original!.idempotencyKey);
  });
});

describe("message private lifetime, offline and invalidation", () => {
  it("clears fetched data offline but retains an unsent update target or immutable unknown command", async () => {
    const { controller, client } = setup();
    await controller.loadPage();
    await controller.select(id);
    controller.edit("name", "Offline local fields");
    controller.setOnline(false);
    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      selected: null,
      input: { name: "Offline local fields" },
      targetId: id,
      ifMatch: '"1"',
    });
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
    controller.setOnline(true);
    client.submit.mockRejectedValueOnce(new Error("Unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    controller.setOnline(false);
    controller.setOnline(true);
    expect(controller.getSnapshot().pending).toBe(original);
    expect(client.submit).toHaveBeenCalledOnce();
    expect(controller.isProtected()).toBe(true);
  });
  it("clears all private state on current permission/membership loss and capability denial honestly", async () => {
    for (const error of [
      new ApiError(401, "private", "entitlement_disabled"),
      new ApiError(403, "private", "permission_denied"),
      new ApiError(403, "private", "entitlement_disabled"),
    ]) {
      const { controller, client, accessRevoked } = setup();
      await controller.select(id);
      controller.edit("name", "Protected");
      client.submit.mockRejectedValueOnce(error);
      await controller.save();
      expect(controller.getSnapshot()).toMatchObject({
        input: null,
        pending: null,
        selected: null,
        page: null,
      });
      expect(controller.isProtected()).toBe(false);
      const entitlement = error.status === 403 && error.code === "entitlement_disabled";
      expect(controller.getSnapshot().phase).toBe(entitlement ? "unavailable" : "denied");
      expect(accessRevoked.mock.calls.length).toBe(entitlement ? 0 : 1);
    }
  });
  it("supports StrictMode attach/detach/setup while discarding retired late failures and writes", async () => {
    const { controller, client, accessRevoked } = setup();
    const old = deferred<Awaited<ReturnType<MessageDesignClient["detail"]>>>();
    client.detail.mockReturnValueOnce(old.promise);
    const reading = controller.select(id);
    controller.detach();
    controller.attach();
    await controller.select(id);
    old.reject(new ApiError(403, "retired", "permission_denied"));
    await reading;
    expect(controller.getSnapshot().selected!.data.id).toBe(id);
    expect(accessRevoked).not.toHaveBeenCalled();
    controller.edit("name", "Late write");
    const writing = deferred<Awaited<ReturnType<MessageDesignClient["submit"]>>>();
    client.submit.mockReturnValueOnce(writing.promise);
    const saving = controller.save();
    controller.detach();
    controller.attach();
    writing.resolve({ data: { ...entity(2), name: "Late write" }, etag: '"2"' });
    await saving;
    expect(controller.getSnapshot()).toMatchObject({
      receipt: null,
      pending: null,
      selected: null,
      input: null,
    });
    await controller.select(id);
    expect(controller.getSnapshot().selected!.data.id).toBe(id);
  });
});
