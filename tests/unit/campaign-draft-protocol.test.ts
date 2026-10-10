import { describe, expect, it, vi } from "vitest";
import {
  CampaignDraftController,
  campaignVersion,
  campaignWriteJson,
  readCampaignJsonResponse,
  requireCampaign,
  requireCampaignPage,
  requireCampaignReceipt,
  requireCampaignWrite,
  type CampaignDraftClient,
} from "../../apps/web/components/campaign-draft-protocol";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const campaignId = "b1000000-0000-4000-8000-000000000001";
const secondId = "b1000000-0000-4000-8000-000000000002";
const campaign = (version = 1, name = "Private campaign"): Schema<"Campaign"> => ({
  id: campaignId,
  name,
  category: "Private category",
  state: "draft",
  version,
});
const receipt = (version = 1, name = "Private campaign") => ({
  data: campaign(version, name),
  etag: `"${version}"`,
});
const page = (items = [campaign()], cursor: string | null = null): Schema<"PageCampaign"> => ({
  items,
  nextCursor: cursor,
  hasMore: Boolean(cursor),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(options: { online?: boolean; canRead?: boolean; canWrite?: boolean } = {}) {
  let keys = 0;
  const client = {
    list: vi.fn<CampaignDraftClient["list"]>(async () => page()),
    detail: vi.fn<CampaignDraftClient["detail"]>(async () => receipt()),
    submit: vi.fn<CampaignDraftClient["submit"]>(async (command) => {
      const version = command.kind === "create" ? 1 : campaignVersion(command.ifMatch) + 1;
      return { data: { ...campaign(version), ...command.body }, etag: `"${version}"` };
    }),
  };
  const protectedChange = vi.fn();
  const accessRevoked = vi.fn();
  const controller = new CampaignDraftController({
    binding: "private-opaque-session-context",
    client,
    online: options.online ?? true,
    canRead: options.canRead ?? true,
    canWrite: options.canWrite ?? true,
    createKey: () => `fixed-campaign-command-${++keys}`,
    onProtectedChange: protectedChange,
    onAccessRevoked: accessRevoked,
  });
  return { controller, client, protectedChange, accessRevoked, keys: () => keys };
}
function createFields(controller: CampaignDraftController) {
  expect(controller.beginCreate()).toBe(true);
  controller.edit("name", "  New private campaign  ");
  controller.edit("category", "  Reviewed category  ");
}

describe("closed browser campaign metadata", () => {
  it("derives closed request fields and trims only after enforcing published limits", () => {
    expect(requireCampaignWrite({ name: "  Name  ", category: "  Category  " })).toEqual({
      name: "Name",
      category: "Category",
    });
    expect(Object.isFrozen(requireCampaignWrite({ name: "Name", category: "Category" }))).toBe(true);
    for (const value of [
      { name: " ", category: "Category" },
      { name: "Name", category: "\n" },
      { name: "x".repeat(121), category: "Category" },
      { name: "Name", category: "x".repeat(81) },
      { name: "Name", category: "Category", state: "active" },
      { name: "Name" },
    ])
      expect(() => requireCampaignWrite(value)).toThrow();
    expect(requireCampaignWrite({ name: "🏡".repeat(120), category: "🏡".repeat(80) }).name).toHaveLength(
      240,
    );
  });
  it.each([null, "1", 'W/"1"', '"01"', '"0"', '"-1"', '"1.0"', '"9007199254740992"', '"1", "2"'])(
    "rejects a missing, weak or unsafe revision %s",
    (etag) => {
      expect(() => campaignVersion(etag)).toThrow();
    },
  );
  it("checks exact identity, body version, draft state and closed entity shape", () => {
    expect(requireCampaignReceipt(campaign(2), '"2"', campaignId).data.version).toBe(2);
    expect(() => requireCampaignReceipt(campaign(2), '"1"')).toThrow();
    expect(() => requireCampaignReceipt(campaign(), '"1"', secondId)).toThrow();
    for (const value of [
      { ...campaign(), state: "active" },
      { ...campaign(), version: 1.5 },
      { ...campaign(), organizationId: secondId },
    ])
      expect(() => requireCampaign(value)).toThrow();
  });
  it("rejects malformed cursors, duplicate identities and unsupported rows without filtering them", () => {
    expect(requireCampaignPage(page([], null)).items).toEqual([]);
    expect(requireCampaignPage(page([campaign()], "opaque-cursor")).nextCursor).toBe("opaque-cursor");
    for (const value of [
      page([], "cursor"),
      { ...page(), nextCursor: "cursor" },
      { ...page(), hasMore: true },
      page([campaign(), { ...campaign(), id: campaignId.toUpperCase() }]),
      page([{ ...campaign(), state: "active" } as Schema<"Campaign">]),
      { ...page(), privateTotal: 3 },
      page(
        Array.from({ length: 101 }, (_, index) => ({
          ...campaign(),
          id: `b1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      ),
    ])
      expect(() => requireCampaignPage(value)).toThrow();
  });
  it("rejects cycles, sparse arrays, accessors and excessive private bytes without executing getters", () => {
    const getter = vi.fn(() => "private");
    const accessor = Object.defineProperty({ category: "Category" }, "name", {
      enumerable: true,
      get: getter,
    });
    expect(() => requireCampaignWrite(accessor)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = campaign();
    for (const value of [
      cycle,
      { ...page(), items: sparse },
      { ...campaign(), name: "x".repeat(65537) },
      Object.create({ name: "Name", category: "Category" }),
    ])
      expect(() => requireCampaign(value)).toThrow();
  });
  it("ignores inherited object and array serialization hooks for validation and submitted bodies", () => {
    const hook = vi.fn(() => ({ name: "injected", category: "injected" }));
    const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", { value: hook, configurable: true });
      Object.defineProperty(Array.prototype, "toJSON", { value: hook, configurable: true });
      const input = requireCampaignWrite({ name: "Original", category: "Reviewed" });
      const list = requireCampaignPage(page());
      const json = campaignWriteJson(input);
      expect(hook).not.toHaveBeenCalled();
      expect(input.name).toBe("Original");
      expect(list.items[0].name).toBe("Private campaign");
      expect(json).toBe('{"name":"Original","category":"Reviewed"}');
    } finally {
      if (objectHook) Object.defineProperty(Object.prototype, "toJSON", objectHook);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (arrayHook) Object.defineProperty(Array.prototype, "toJSON", arrayHook);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });
});

describe("bounded private campaign transport", () => {
  it("accepts exact-cap JSON despite misleading Content-Length and cancels a larger actual stream", async () => {
    const body = `${" ".repeat(65534)}{}`;
    expect(
      await readCampaignJsonResponse(new Response(body, { headers: { "Content-Length": "1" } })),
    ).toEqual({});
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65536));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(readCampaignJsonResponse(new Response(stream))).rejects.toThrow("64 KiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects malformed UTF-8 and successful empty or non-JSON bodies", async () => {
    for (const response of [
      new Response(new Uint8Array([0xc3, 0x28])),
      new Response(""),
      new Response("not JSON"),
      new Response(null),
    ])
      await expect(readCampaignJsonResponse(response)).rejects.toThrow();
  });
  it("preserves safe HTTP status and code without returning private problem text", async () => {
    const failure = await readCampaignJsonResponse(
      new Response(JSON.stringify({ code: "entitlement_disabled", detail: "private subscriber detail" }), {
        status: 403,
      }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 403, code: "entitlement_disabled" });
    expect((failure as ApiError).message).not.toContain("private subscriber");
    for (const body of [" ".repeat(65537), "malformed", new Uint8Array([0xff])]) {
      await expect(readCampaignJsonResponse(new Response(body, { status: 401 }))).rejects.toMatchObject({
        status: 401,
      });
    }
    await expect(
      readCampaignJsonResponse(new Response(JSON.stringify({ code: "x".repeat(81) }), { status: 412 })),
    ).rejects.toMatchObject({ status: 412, code: undefined });
  });
});

describe("draft selection and bounded memory", () => {
  it("does not turn an invalid campaign reference into a request path", async () => {
    const { controller, client } = setup();
    await controller.select("../../another-resource");
    expect(client.detail).not.toHaveBeenCalled();
    expect(controller.getSnapshot().selected).toBeNull();
  });
  it("starts unread, replaces bounded pages and never selects a campaign implicitly", async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot().page).toBeNull();
    client.list
      .mockResolvedValueOnce(page([campaign()], "next"))
      .mockResolvedValueOnce(page([{ ...campaign(), id: secondId }]));
    await controller.loadPage();
    expect(controller.getSnapshot().selected).toBeNull();
    await controller.loadPage("unreviewed-cursor");
    expect(client.list).toHaveBeenCalledTimes(1);
    await controller.loadPage("next");
    expect(controller.getSnapshot().page!.items.map((item) => item.id)).toEqual([secondId]);
    expect(controller.getSnapshot().selected).toBeNull();
  });
  it("keeps stale index data honestly on a transient failure but does not invent empty success", async () => {
    const { controller, client } = setup();
    client.list.mockRejectedValueOnce(new Error("transport"));
    await controller.loadPage();
    expect(controller.getSnapshot()).toMatchObject({ page: null, pageStale: false });
    await controller.loadPage();
    client.list.mockRejectedValueOnce(new Error("transport"));
    await controller.loadPage();
    expect(controller.getSnapshot()).toMatchObject({ page: page(), pageStale: true });
    expect(controller.getSnapshot().listError).toContain("stale");
  });
  it("protects dirty drafts from selection, refresh and invalid over-limit paste", async () => {
    const { controller, client, protectedChange } = setup();
    await controller.select(campaignId);
    controller.edit("name", "Edited name");
    expect(protectedChange).toHaveBeenLastCalledWith(true);
    await controller.select(secondId);
    await controller.loadPage();
    expect(client.detail).toHaveBeenCalledTimes(1);
    expect(client.list).not.toHaveBeenCalled();
    expect(controller.edit("name", "x".repeat(121))).toBe(false);
    expect(controller.getSnapshot().input!.name).toBe("Edited name");
    expect(controller.getSnapshot().error).toContain("120 character");
    expect(controller.discard()).toBe(true);
    expect(controller.getSnapshot().input!.name).toBe("Private campaign");
    expect(controller.isProtected()).toBe(false);
  });
  it("allows read-only detail but sends no mutation without current write permission", async () => {
    const { controller, client } = setup({ canWrite: false });
    await controller.select(campaignId);
    expect(controller.getSnapshot().selected!.data.id).toBe(campaignId);
    expect(controller.beginCreate()).toBe(false);
    expect(controller.edit("name", "Edit")).toBe(false);
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
    const missing = setup({ canRead: false });
    await missing.controller.loadPage();
    expect(missing.client.list).not.toHaveBeenCalled();
    expect(missing.controller.beginCreate()).toBe(false);
  });
});

describe("immutable native draft commands and historical acknowledgments", () => {
  it("acknowledges a created draft without populating a current editor or overwriting its index", async () => {
    const { controller, client, protectedChange } = setup();
    await controller.loadPage();
    createFields(controller);
    await controller.save();
    expect(client.submit.mock.calls[0][0]).toMatchObject({
      kind: "create",
      campaignId: null,
      ifMatch: null,
      body: { name: "New private campaign", category: "Reviewed category" },
    });
    expect(controller.getSnapshot()).toMatchObject({
      phase: "acknowledged",
      selected: null,
      input: null,
      pending: null,
      dirty: false,
      pageStale: true,
    });
    expect(controller.getSnapshot().page!.items[0].name).toBe("Private campaign");
    expect(controller.getSnapshot().receipt!.data.version).toBe(1);
    expect(protectedChange).toHaveBeenLastCalledWith(false);
    client.detail.mockResolvedValueOnce(receipt(7, "Later edit"));
    await controller.select(campaignId);
    expect(controller.getSnapshot().selected!.data.version).toBe(7);
    expect(controller.getSnapshot().input!.name).toBe("Later edit");
  });
  it("retains exactly the original key/body/revision through ambiguity, refusing edits or discard", async () => {
    const { controller, client, keys } = setup();
    await controller.select(campaignId);
    controller.edit("name", "Changed");
    client.submit.mockRejectedValueOnce(new Error("acceptance unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    expect(original).toMatchObject({
      kind: "update",
      campaignId,
      ifMatch: '"1"',
      body: { name: "Changed", category: "Private category" },
    });
    expect(Object.isFrozen(original!.body)).toBe(true);
    expect(controller.edit("name", "Replacement")).toBe(false);
    expect(controller.discard()).toBe(false);
    expect(controller.editRejected()).toBe(false);
    await controller.save();
    expect(client.submit.mock.calls[1][0]).toEqual(original);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: "acknowledged", selected: null, input: null });
    expect(controller.getSnapshot().receipt!.data.version).toBe(2);
  });
  it.each([400, 422, 429])(
    "does not release an earlier unknown command after a rejected retry (%s)",
    async (status) => {
      const { controller, client, keys } = setup();
      createFields(controller);
      client.submit
        .mockRejectedValueOnce(new Error("unknown"))
        .mockRejectedValueOnce(new ApiError(status, "rejected"));
      await controller.save();
      const original = controller.getSnapshot().pending;
      await controller.save();
      expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: original });
      expect(controller.editRejected()).toBe(false);
      expect(keys()).toBe(1);
    },
  );
  it("detaches a transport copy so accidental client mutation cannot change the original command", async () => {
    const { controller, client } = setup();
    createFields(controller);
    client.submit.mockImplementationOnce(async (command) => {
      command.body.name = "Mutation in transport";
      throw new Error("unknown");
    });
    await controller.save();
    expect(controller.getSnapshot().pending!.body.name).toBe("New private campaign");
    await controller.save();
    expect(controller.getSnapshot().receipt!.data.name).toBe("New private campaign");
  });
  it.each(["changed input", "wrong version", "wrong identity", "weak etag"])(
    "keeps a malformed %s acknowledgment uncertain",
    async (variant) => {
      const { controller, client } = setup();
      await controller.select(campaignId);
      controller.edit("name", "Changed");
      const result = { data: { ...campaign(2, "Changed") }, etag: '"2"' };
      if (variant === "changed input") result.data.name = "Other";
      if (variant === "wrong version") {
        result.data.version = 4;
        result.etag = '"4"';
      }
      if (variant === "wrong identity") result.data.id = secondId;
      if (variant === "weak etag") result.etag = 'W/"2"';
      client.submit.mockResolvedValueOnce(result);
      await controller.save();
      expect(controller.getSnapshot().phase).toBe("uncertain");
      expect(controller.getSnapshot().pending!.ifMatch).toBe('"1"');
    },
  );
  it("prevents overlapping saves and does not allocate another key for a historical replay", async () => {
    const { controller, client, keys } = setup();
    createFields(controller);
    const response = deferred<{ data: unknown; etag: string }>();
    client.submit.mockReturnValueOnce(response.promise);
    const first = controller.save();
    await controller.save();
    expect(client.submit).toHaveBeenCalledOnce();
    expect(controller.isProtected()).toBe(true);
    expect(keys()).toBe(1);
    response.resolve({
      data: { ...campaign(), name: "New private campaign", category: "Reviewed category" },
      etag: '"1"',
    });
    await first;
    expect(controller.isProtected()).toBe(false);
    await controller.save();
    expect(client.submit).toHaveBeenCalledOnce();
  });
  it("treats a changed-input idempotency conflict as unresolved, never an editable rejection", async () => {
    const { controller, client } = setup();
    createFields(controller);
    client.submit.mockRejectedValueOnce(new ApiError(409, "private diagnostic", "idempotency_conflict"));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("uncertain");
    expect(controller.editRejected()).toBe(false);
    expect(controller.getSnapshot().error).not.toContain("private diagnostic");
  });
  it("allows explicit editing of a definitively rejected first command and allocates a new key only on save", async () => {
    const { controller, client, keys } = setup();
    createFields(controller);
    client.submit.mockRejectedValueOnce(new ApiError(422, "rejected", "campaign_text_required"));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("rejected");
    expect(controller.editRejected()).toBe(true);
    expect(keys()).toBe(1);
    controller.edit("name", "Reviewed replacement");
    await controller.save();
    expect(keys()).toBe(2);
    expect(client.submit.mock.calls[1][0].idempotencyKey).not.toBe(
      client.submit.mock.calls[0][0].idempotencyKey,
    );
  });
  it("does not send blank or normalization-only metadata", async () => {
    const { controller, client, keys } = setup();
    controller.beginCreate();
    controller.edit("name", " ");
    controller.edit("category", "Category");
    await controller.save();
    expect(client.submit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().error).toContain("nonblank");
    controller.discard();
    await controller.select(campaignId);
    controller.edit("name", "  Private campaign  ");
    await controller.save();
    expect(controller.getSnapshot().dirty).toBe(false);
    expect(client.submit).not.toHaveBeenCalled();
    expect(keys()).toBe(0);
  });
});

describe("explicit revision conflict decisions", () => {
  it.each([true, false])(
    "requires a fresh reviewed revision before resolving (keep original fields %s)",
    async (keep) => {
      const { controller, client, keys } = setup();
      await controller.select(campaignId);
      controller.edit("name", "Original unsaved");
      client.submit.mockRejectedValueOnce(new ApiError(412, "stale", "revision_stale"));
      await controller.save();
      const original = controller.getSnapshot().pending;
      expect(controller.resolveConflict(keep)).toBe(false);
      await controller.save();
      expect(client.submit).toHaveBeenCalledOnce();
      client.detail.mockResolvedValueOnce(receipt(4, "Current reviewed"));
      await controller.readConflict();
      expect(controller.getSnapshot().pending).toBe(original);
      expect(controller.getSnapshot().input!.name).toBe("Original unsaved");
      expect(controller.resolveConflict(keep)).toBe(true);
      expect(keys()).toBe(1);
      expect(client.submit).toHaveBeenCalledOnce();
      expect(controller.getSnapshot().selected!.etag).toBe('"4"');
      expect(controller.getSnapshot().input!.name).toBe(keep ? "Original unsaved" : "Current reviewed");
      await controller.save();
      if (keep) {
        expect(keys()).toBe(2);
        expect(client.submit.mock.calls[1][0]).toMatchObject({
          ifMatch: '"4"',
          body: { name: "Original unsaved" },
        });
      } else {
        expect(controller.isProtected()).toBe(false);
        expect(client.submit).toHaveBeenCalledOnce();
      }
    },
  );
  it("keeps the exact stale command if conflict read is unavailable or its identity is mismatched", async () => {
    const { controller, client } = setup();
    await controller.select(campaignId);
    controller.edit("name", "Original");
    client.submit.mockRejectedValueOnce(new ApiError(412, "stale"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    client.detail.mockResolvedValueOnce({ data: { ...campaign(3), id: secondId }, etag: '"3"' });
    await controller.readConflict();
    expect(controller.getSnapshot().pending).toBe(original);
    expect(controller.getSnapshot().conflictCurrent).toBeNull();
    expect(controller.resolveConflict(true)).toBe(false);
  });
});

describe("offline, access and component lifetimes", () => {
  it("treats HTTP401 as definitive identity loss even when an error code alleges an entitlement failure", async () => {
    const { controller, client, accessRevoked } = setup();
    client.list.mockRejectedValueOnce(new ApiError(401, "private", "entitlement_disabled"));
    await controller.loadPage();
    expect(controller.getSnapshot().phase).toBe("denied");
    expect(accessRevoked).toHaveBeenCalledOnce();
    controller.detach();
    controller.attach();
    await controller.loadPage();
    expect(client.list).toHaveBeenCalledOnce();
  });
  it("clears fetched projections offline while retaining a protected draft and original unknown key", async () => {
    const { controller, client } = setup();
    await controller.loadPage();
    await controller.select(campaignId);
    controller.edit("name", "Protected");
    client.submit.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    controller.setOnline(false);
    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      receipt: null,
      pending: original,
      input: { name: "Protected" },
    });
    await controller.save();
    await controller.loadPage();
    expect(client.submit).toHaveBeenCalledOnce();
    controller.setOnline(true);
    expect(controller.getSnapshot().pending).toBe(original);
    await controller.save();
    expect(client.submit.mock.calls[1][0]).toEqual(original);
  });
  it("clears clean detail offline and ignores an older read after reconnection", async () => {
    const { controller, client } = setup();
    await controller.select(campaignId);
    controller.setOnline(false);
    expect(controller.getSnapshot()).toMatchObject({ selected: null, input: null });
    controller.setOnline(true);
    const response = deferred<unknown>();
    client.list.mockReturnValueOnce(response.promise);
    const old = controller.loadPage();
    controller.setOnline(false);
    controller.setOnline(true);
    client.list.mockResolvedValueOnce(page([]));
    await controller.loadPage();
    response.resolve(page());
    await old;
    expect(controller.getSnapshot().page!.items).toEqual([]);
  });
  it("shows capability unavailable and clears private memory without invalidating unrelated member access", async () => {
    const { controller, client, accessRevoked } = setup();
    await controller.loadPage();
    await controller.select(campaignId);
    controller.edit("name", "Private unsaved");
    client.submit.mockRejectedValueOnce(new ApiError(403, "private entitlement", "entitlement_disabled"));
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      page: null,
      input: null,
      selected: null,
      pending: null,
      receipt: null,
    });
    expect(accessRevoked).not.toHaveBeenCalled();
    expect(controller.beginCreate()).toBe(false);
    await controller.loadPage();
    expect(controller.getSnapshot().phase).toBe("idle");
    expect(controller.getSnapshot().input).toBeNull();
  });
  it.each([401, 403])("clears private data and reports definite current access denial %s", async (status) => {
    const { controller, client, accessRevoked } = setup();
    createFields(controller);
    client.submit.mockRejectedValueOnce(new ApiError(status, "private", "permission_denied"));
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ phase: "denied", pending: null, input: null });
    expect(accessRevoked).toHaveBeenCalledOnce();
    await controller.loadPage();
    expect(client.list).not.toHaveBeenCalled();
  });
  it("treats an unavailable resource as private-data loss without claiming global membership loss", async () => {
    const { controller, client, accessRevoked } = setup();
    client.detail.mockRejectedValueOnce(new ApiError(404, "private", "resource_unavailable"));
    await controller.select(campaignId);
    expect(controller.getSnapshot().phase).toBe("unavailable");
    expect(accessRevoked).not.toHaveBeenCalled();
  });
  it("survives setup-cleanup-setup with cleared memory while old read errors cannot revoke the attached lifetime", async () => {
    const { controller, client, accessRevoked } = setup();
    controller.attach();
    const response = deferred<unknown>();
    client.list.mockReturnValueOnce(response.promise);
    const old = controller.loadPage();
    controller.detach();
    expect(controller.getSnapshot().page).toBeNull();
    controller.attach();
    await controller.loadPage();
    response.reject(new ApiError(401, "old session"));
    await old;
    expect(controller.getSnapshot().page).toEqual(page());
    expect(controller.getSnapshot().phase).not.toBe("denied");
    expect(accessRevoked).not.toHaveBeenCalled();
    expect(controller.beginCreate()).toBe(true);
    controller.revoke();
    controller.attach();
    await controller.loadPage();
    expect(controller.getSnapshot().phase).toBe("denied");
  });
  it("invalidates old writes immediately on context teardown and never imports them into a replacement controller", async () => {
    const old = setup(),
      current = setup();
    createFields(old.controller);
    const response = deferred<{ data: unknown; etag: string }>();
    old.client.submit.mockReturnValueOnce(response.promise);
    const save = old.controller.save();
    old.controller.detach();
    await current.controller.loadPage();
    response.resolve({
      data: { ...campaign(), name: "New private campaign", category: "Reviewed category" },
      etag: '"1"',
    });
    await save;
    expect(old.controller.getSnapshot()).toMatchObject({ pending: null, receipt: null, input: null });
    expect(current.controller.getSnapshot()).toMatchObject({ page: page(), pending: null, receipt: null });
    expect(old.controller.beginCreate()).toBe(false);
  });
  it("retains a command when the connection disappears during submission and accepts only its verified acknowledgment", async () => {
    const { controller, client } = setup();
    createFields(controller);
    const response = deferred<{ data: unknown; etag: string }>();
    client.submit.mockReturnValueOnce(response.promise);
    const save = controller.save();
    controller.setOnline(false);
    expect(controller.isProtected()).toBe(true);
    expect(controller.getSnapshot().pending).not.toBeNull();
    response.resolve({
      data: { ...campaign(), name: "New private campaign", category: "Reviewed category" },
      etag: '"1"',
    });
    await save;
    expect(controller.getSnapshot()).toMatchObject({
      online: false,
      phase: "acknowledged",
      pending: null,
      input: null,
    });
    expect(controller.isProtected()).toBe(false);
  });
});
