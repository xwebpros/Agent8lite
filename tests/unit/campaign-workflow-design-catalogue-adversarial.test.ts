import { describe, expect, it, vi } from "vitest";
import { previewWorkflow, validateWorkflowDefinition } from "../../packages/marketing";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
} from "../../apps/web/components/campaign-workflow-controller";
import {
  CampaignWorkflowDesignCatalogue,
  requireWorkflowDesign,
  workflowDesignChoices,
  type WorkflowDesignCatalogueClient,
} from "../../apps/web/components/campaign-workflow-design-catalogue";
import {
  messageDesignWriteFromReceipt,
  type MessageDesignReceipt,
} from "../../apps/web/components/message-design-protocol";
import {
  MessageDesignController,
  type MessageDesignClient,
} from "../../apps/web/components/message-design-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const emailId = "d4000000-0000-4000-8000-000000000001";
const smsId = "d4000000-0000-4000-8000-000000000002";
const otherId = "d4000000-0000-4000-8000-000000000003";
const campaignId = "d4000000-0000-4000-8000-000000000004";
const versionId = "d4000000-0000-4000-8000-000000000005";
function design(channel: "email" | "sms" = "email", id = emailId, version = 1): Schema<"MessageDesign"> {
  return {
    id,
    name: `Reviewed ${channel} design`,
    channel,
    editor: "native",
    subject: channel === "email" ? "Reviewed subject" : null,
    design: { schemaVersion: 1, blocks: [{ type: "text", text: "Private static message text" }] },
    content: "Private static message text",
    version,
  };
}
const page = (...items: Schema<"MessageDesign">[]): Schema<"PageMessageDesign"> => ({
  items: items.length ? items : [design()],
  nextCursor: null,
  hasMore: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let current = true;
  const client = {
    list: vi.fn<WorkflowDesignCatalogueClient["list"]>(async () => page()),
    detail: vi.fn<WorkflowDesignCatalogueClient["detail"]>(async () => ({ data: design(), etag: '"1"' })),
  };
  const applied = vi.fn<(key: string, receipt: MessageDesignReceipt) => boolean>(() => true);
  const unavailable = vi.fn(),
    authorityLost = vi.fn();
  const catalogue = new CampaignWorkflowDesignCatalogue({
    online: true,
    client,
    isCurrent: () => current,
    applySelection: applied,
    onSourceUnavailable: unavailable,
    onAuthorityLost: authorityLost,
  });
  return {
    catalogue,
    client,
    applied,
    unavailable,
    authorityLost,
    setCurrent: (value: boolean) => {
      current = value;
    },
  };
}

describe("explicit channel-compatible native workflow references", () => {
  it("exposes detached closed metadata only and never selects the first returned design implicitly", async () => {
    const { catalogue, client, applied } = setup();
    const original = page(design(), design("sms", smsId), { ...design("email", otherId), editor: "unlayer" });
    client.list.mockResolvedValueOnce(original);
    await catalogue.loadPage();
    const choices = workflowDesignChoices(catalogue.getSnapshot().page, "email");
    expect(choices).toEqual([{ id: emailId, name: "Reviewed email design", channel: "email", version: 1 }]);
    expect(Object.keys(choices[0])).toEqual(["id", "name", "channel", "version"]);
    expect(Object.isFrozen(choices)).toBe(true);
    original.items[0].name = "Changed after response";
    expect(choices[0].name).toBe("Reviewed email design");
    expect(workflowDesignChoices(catalogue.getSnapshot().page, "sms").map((item) => item.id)).toEqual([
      smsId,
    ]);
    expect(applied).not.toHaveBeenCalled();
    expect(catalogue.getSnapshot().preview).toBeNull();
  });
  it("rejects undisplayed IDs, incompatible channels, licensed-editor rows and invented cursors before transport", async () => {
    const { catalogue, client, applied } = setup();
    client.list.mockResolvedValueOnce(
      page(design(), design("sms", smsId), { ...design("email", otherId), editor: "unlayer" }),
    );
    await catalogue.loadPage();
    for (const [id, channel] of [
      [smsId, "email"],
      [otherId, "email"],
      [versionId, "email"],
      ["../message-designs", "email"],
    ] as const)
      await catalogue.choose("step_1", id, channel);
    await catalogue.loadPage("invented-private-cursor");
    expect(client.detail).not.toHaveBeenCalled();
    expect(client.list).toHaveBeenCalledOnce();
    expect(applied).not.toHaveBeenCalled();
  });
  it("requires a fresh detail even for a verified page row and keeps only its explicit requested preview", async () => {
    const { catalogue, client, applied } = setup();
    await catalogue.loadPage();
    client.detail.mockResolvedValueOnce({ data: design("email", emailId, 2), etag: '"2"' });
    await catalogue.choose("step_7", emailId, "email");
    expect(client.detail).toHaveBeenCalledExactlyOnceWith(emailId);
    expect(applied).toHaveBeenCalledWith("step_7", { data: design("email", emailId, 2), etag: '"2"' });
    expect(catalogue.getSnapshot().previewNodeKey).toBe("step_7");
    expect(catalogue.getSnapshot().preview?.data.version).toBe(2);
    expect(catalogue.getSnapshot().page?.items[0].version).toBe(1);
  });
  it("does not retain a private preview when the workflow refuses a replacement", async () => {
    const { catalogue, applied } = setup();
    await catalogue.loadPage();
    applied.mockReturnValueOnce(false);
    await catalogue.choose("missing_or_locked_node", emailId, "email");
    expect(applied).toHaveBeenCalledOnce();
    expect(catalogue.getSnapshot().preview).toBeNull();
    expect(catalogue.getSnapshot().previewNodeKey).toBeNull();
  });
  it("replaces the bounded page without retaining choices from previous pages", async () => {
    const { catalogue, client } = setup();
    client.list.mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: "registered-page-two" });
    await catalogue.loadPage();
    client.list.mockResolvedValueOnce(page(design("email", otherId)));
    await catalogue.loadPage("registered-page-two");
    await catalogue.choose("step_1", emailId, "email");
    expect(client.detail).not.toHaveBeenCalled();
    expect(catalogue.getSnapshot().page?.items.map((item) => item.id)).toEqual([otherId]);
  });
  it.each([
    ["wrong channel", { ...design(), channel: "sms" }, '"1"'],
    ["wrong editor", { ...design(), editor: "unlayer" }, '"1"'],
    ["wrong identity", { ...design(), id: otherId }, '"1"'],
    ["invalid UUID", { ...design(), id: "not-a-uuid" }, '"1"'],
    ["unknown private fields", { ...design(), tenantId: campaignId }, '"1"'],
    ["incompatible text", { ...design(), content: "Changed independently from the design" }, '"1"'],
    [
      "executable content",
      {
        ...design(),
        design: { schemaVersion: 1, blocks: [{ type: "text", text: "<script>bad</script>" }] },
        content: "<script>bad</script>",
      },
      '"1"',
    ],
    ["weak ETag", design(), 'W/"1"'],
    ["different revision", design(), '"2"'],
    ["unsafe revision", { ...design(), version: Number.MAX_SAFE_INTEGER + 1 }, '"9007199254740992"'],
  ])("never applies a detail with %s", async (_reason, data, etag) => {
    const { catalogue, client, applied, unavailable, authorityLost } = setup();
    await catalogue.loadPage();
    client.detail.mockResolvedValueOnce({ data, etag: etag as string });
    await catalogue.choose("step_1", emailId, "email");
    expect(applied).not.toHaveBeenCalled();
    expect(catalogue.getSnapshot().preview).toBeNull();
    expect(catalogue.getSnapshot().nodeError?.nodeKey).toBe("step_1");
    expect(unavailable).toHaveBeenCalledWith("step_1", emailId);
    expect(authorityLost).not.toHaveBeenCalled();
  });
  it.each(["1", '"01"', '"0"', '"-1"', '"1.0"', '"1", "2"', '"9007199254740992"', `"${"1".repeat(101)}"`])(
    "rejects malformed strong design revision %s",
    (etag) => {
      expect(() => requireWorkflowDesign(design(), etag, emailId, "email")).toThrow();
    },
  );
  it("retains exact own data, denies accessors without invocation and enforces native body bounds", () => {
    const value = design();
    const receipt = requireWorkflowDesign(value, '"1"', emailId, "email");
    value.content = "Changed source object";
    expect(receipt.data.content).toBe("Private static message text");
    let invoked = 0;
    const getter = { ...design() };
    Object.defineProperty(getter, "content", {
      enumerable: true,
      get() {
        invoked++;
        return "Private static message text";
      },
    });
    expect(() => requireWorkflowDesign(getter, '"1"', emailId, "email")).toThrow();
    expect(invoked).toBe(0);
    const text = "A".repeat(270000);
    expect(() =>
      requireWorkflowDesign(
        { ...design(), content: text, design: { schemaVersion: 1, blocks: [{ type: "text", text }] } },
        '"1"',
        emailId,
        "email",
      ),
    ).toThrow();
  });
  it("does not execute an inherited optional subject getter while validating a catalogue design", () => {
    const value = design();
    delete value.subject;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "subject");
    let calls = 0;
    try {
      Object.defineProperty(Object.prototype, "subject", {
        configurable: true,
        get() {
          calls++;
          return undefined;
        },
      });
      const receipt = requireWorkflowDesign(value, '"1"', emailId, "email");
      expect(Object.hasOwn(receipt.data, "subject")).toBe(false);
      expect(calls).toBe(0);
    } finally {
      if (original) Object.defineProperty(Object.prototype, "subject", original);
      else delete (Object.prototype as Record<string, unknown>).subject;
    }
  });
  it("does not fill an absent own subject from inherited prototype data in a design preview", () => {
    const value = design();
    delete value.subject;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "subject");
    try {
      Object.defineProperty(Object.prototype, "subject", {
        configurable: true,
        value: "Unprovided prototype subject",
      });
      const receipt = requireWorkflowDesign(value, '"1"', emailId, "email");
      expect(Object.hasOwn(receipt.data, "subject")).toBe(false);
      expect(receipt.data.subject).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(Object.prototype, "subject", original);
      else delete (Object.prototype as Record<string, unknown>).subject;
    }
  });
});

describe("detached optional fields through message receipt and draft entry", () => {
  it.each(["getter", "data"])("direct receipt-to-write conversion ignores inherited subject %s", (kind) => {
    const value = design();
    delete value.subject;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "subject");
    let calls = 0;
    try {
      Object.defineProperty(
        Object.prototype,
        "subject",
        kind === "getter"
          ? {
              configurable: true,
              get() {
                calls++;
                return "Unprovided inherited subject";
              },
            }
          : { configurable: true, value: "Unprovided inherited subject" },
      );
      const projected = messageDesignWriteFromReceipt(value);
      expect(projected).not.toBeNull();
      expect(Object.hasOwn(projected!, "subject")).toBe(false);
      expect(projected!.subject).toBeUndefined();
      expect(projected!.content).toBe(value.content);
      expect(calls).toBe(0);
    } finally {
      if (original) Object.defineProperty(Object.prototype, "subject", original);
      else delete (Object.prototype as Record<string, unknown>).subject;
    }
  });
  it("direct receipt conversion rejects an own subject accessor without executing it", () => {
    const value = design();
    let calls = 0;
    Object.defineProperty(value, "subject", {
      enumerable: true,
      get() {
        calls++;
        return "Accessor subject";
      },
    });
    expect(messageDesignWriteFromReceipt(value)).toBeNull();
    expect(calls).toBe(0);
  });
  it("an inherited required name cannot repair a malformed receipt or execute its getter", () => {
    const value = design() as Partial<Schema<"MessageDesign">>;
    delete value.name;
    const original = Object.getOwnPropertyDescriptor(Object.prototype, "name");
    let calls = 0;
    try {
      Object.defineProperty(Object.prototype, "name", {
        configurable: true,
        get() {
          calls++;
          return "Unprovided required name";
        },
      });
      expect(messageDesignWriteFromReceipt(value as Schema<"MessageDesign">)).toBeNull();
      expect(calls).toBe(0);
    } finally {
      if (original) Object.defineProperty(Object.prototype, "name", original);
      else delete (Object.prototype as Record<string, unknown>).name;
    }
  });
  it.each(["getter", "data"])(
    "blank create and omitted-subject edits never use inherited subject %s",
    async (kind) => {
      const client = {
        list: vi.fn<MessageDesignClient["list"]>(async () => page()),
        detail: vi.fn<MessageDesignClient["detail"]>(async () => ({ data: design(), etag: '"1"' })),
        submit: vi.fn<MessageDesignClient["submit"]>(async (command) => ({
          data: { ...command.body, id: emailId, version: 1 },
          etag: '"1"',
        })),
      };
      const controller = new MessageDesignController({
        binding: "opaque-message-draft-context",
        client,
        online: true,
        canRead: true,
        canWrite: true,
        createKey: () => "original-detached-message-key",
      });
      const original = Object.getOwnPropertyDescriptor(Object.prototype, "subject");
      let calls = 0;
      try {
        Object.defineProperty(
          Object.prototype,
          "subject",
          kind === "getter"
            ? {
                configurable: true,
                get() {
                  calls++;
                  return "Unprovided inherited subject";
                },
              }
            : { configurable: true, value: "Unprovided inherited subject" },
        );
        expect(controller.beginCreate()).toBe(true);
        expect(Object.hasOwn(controller.getSnapshot().input!, "subject")).toBe(false);
        expect(controller.getSnapshot().input!.subject).toBeUndefined();
        expect(controller.edit("name", "Reviewed explicit draft")).toBe(true);
        expect(controller.editBlock(0, "Reviewed static body")).toBe(true);
        expect(controller.edit("subject", "Reviewed explicit subject")).toBe(true);
        expect(controller.getSnapshot().input!.subject).toBe("Reviewed explicit subject");
        expect(controller.edit("subject", "")).toBe(true);
        expect(Object.hasOwn(controller.getSnapshot().input!, "subject")).toBe(false);
        expect(controller.getSnapshot().input!.subject).toBeUndefined();
        expect(controller.getSnapshot().issues).toEqual([]);
        await controller.save();
        expect(client.submit).toHaveBeenCalledOnce();
        expect(Object.hasOwn(client.submit.mock.calls[0][0].body, "subject")).toBe(false);
        expect(controller.getSnapshot().phase).toBe("acknowledged");
        expect(controller.getSnapshot().receipt!.data.subject).toBeUndefined();
        expect(calls).toBe(0);
      } finally {
        if (original) Object.defineProperty(Object.prototype, "subject", original);
        else delete (Object.prototype as Record<string, unknown>).subject;
      }
    },
  );
});

describe("bounded catalogue response lifetimes and current access", () => {
  it.each([
    ["duplicate identities", { ...page(), items: [design(), design()] }],
    [
      "too many complete designs",
      page(
        ...Array.from({ length: 6 }, (_, index) =>
          design("email", `d4000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`),
        ),
      ),
    ],
    ["contradictory cursor", { ...page(), nextCursor: "opaque", hasMore: false }],
    ["empty partial page", { items: [], hasMore: true, nextCursor: "opaque" }],
    ["unknown page fields", { ...page(), internalAccount: "unrestricted" }],
    ["invalid entity", page({ ...design(), id: "invalid-identity" })],
  ])("clears previously observed choices after %s", async (_reason, value) => {
    const { catalogue, client } = setup();
    await catalogue.loadPage();
    await catalogue.choose("step_1", emailId, "email");
    client.list.mockResolvedValueOnce(value);
    await catalogue.refresh();
    expect(catalogue.getSnapshot().page).toBeNull();
    expect(catalogue.getSnapshot().preview).toBeNull();
    expect(catalogue.getSnapshot().phase).toBe("unavailable");
  });
  it.each(["focus refresh", "offline", "detach", "revoke", "context changed"])(
    "ignores late detail after %s",
    async (cut) => {
      const { catalogue, client, applied, setCurrent } = setup();
      await catalogue.loadPage();
      const late = deferred<{ data: unknown; etag: string }>();
      client.detail.mockReturnValueOnce(late.promise);
      const choosing = catalogue.choose("step_1", emailId, "email");
      if (cut === "focus refresh") await catalogue.refresh();
      else if (cut === "offline") catalogue.setOnline(false);
      else if (cut === "detach") catalogue.detach();
      else if (cut === "revoke") catalogue.revoke();
      else {
        setCurrent(false);
        catalogue.invalidate();
      }
      late.resolve({ data: design("email", emailId, 2), etag: '"2"' });
      await choosing;
      expect(applied).not.toHaveBeenCalled();
      expect(catalogue.getSnapshot().preview).toBeNull();
      expect(catalogue.getSnapshot().reading).toBe(false);
      if (cut !== "focus refresh") expect(catalogue.getSnapshot().page).toBeNull();
    },
  );
  it("focus refresh discards old choices and late authority failures without revoking the fresh response", async () => {
    const { catalogue, client, authorityLost } = setup();
    const late = deferred<unknown>();
    client.list.mockReturnValueOnce(late.promise);
    const original = catalogue.loadPage();
    client.list.mockResolvedValueOnce(page(design("sms", smsId)));
    await catalogue.refresh();
    late.reject(new ApiError(403, "Old private denial", "permission_denied"));
    await original;
    expect(catalogue.getSnapshot().phase).toBe("ready");
    expect(catalogue.getSnapshot().page?.items[0].id).toBe(smsId);
    expect(authorityLost).not.toHaveBeenCalled();
  });
  it("clears page and preview offline; reconnecting never reuses them or submits an implicit selection", async () => {
    const { catalogue, client, applied } = setup();
    await catalogue.loadPage();
    await catalogue.choose("step_1", emailId, "email");
    applied.mockClear();
    catalogue.setOnline(false);
    await catalogue.loadPage();
    await catalogue.choose("step_1", emailId, "email");
    expect(client.list).toHaveBeenCalledOnce();
    expect(client.detail).toHaveBeenCalledOnce();
    expect(catalogue.getSnapshot().page).toBeNull();
    expect(catalogue.getSnapshot().preview).toBeNull();
    catalogue.setOnline(true);
    await catalogue.choose("step_1", emailId, "email");
    expect(applied).not.toHaveBeenCalled();
    await catalogue.loadPage();
    expect(client.list).toHaveBeenCalledTimes(2);
    expect(catalogue.getSnapshot().preview).toBeNull();
  });
  it.each([401, 403])(
    "current read %s revokes memory and cannot be revived by attach or refresh",
    async (status) => {
      const { catalogue, client, authorityLost } = setup();
      await catalogue.loadPage();
      client.detail.mockRejectedValueOnce(
        new ApiError(status, "Never expose private server detail", "permission_denied"),
      );
      await catalogue.choose("step_1", emailId, "email");
      expect(catalogue.getSnapshot().page).toBeNull();
      expect(catalogue.getSnapshot().phase).toBe("denied");
      expect(catalogue.getSnapshot().error).not.toContain("Never expose");
      expect(authorityLost).toHaveBeenCalledOnce();
      catalogue.attach();
      await catalogue.refresh();
      expect(client.list).toHaveBeenCalledOnce();
    },
  );
  it("entitlement denial is explicit temporary unavailability and requires a new authorized read", async () => {
    const { catalogue, client, authorityLost } = setup();
    await catalogue.loadPage();
    client.detail.mockRejectedValueOnce(new ApiError(403, "Private provider state", "entitlement_disabled"));
    await catalogue.choose("step_1", emailId, "email");
    expect(catalogue.getSnapshot().page).toBeNull();
    expect(catalogue.getSnapshot().phase).toBe("unavailable");
    expect(authorityLost).toHaveBeenCalledOnce();
    await catalogue.loadPage();
    expect(catalogue.getSnapshot().phase).toBe("ready");
    expect(catalogue.getSnapshot().preview).toBeNull();
  });
  it.each([404, 503])(
    "detail %s marks only the requested source unverifiable without treating it as authority revocation",
    async (status) => {
      const { catalogue, client, applied, unavailable, authorityLost } = setup();
      await catalogue.loadPage();
      client.detail.mockRejectedValueOnce(
        new ApiError(status, "Private source payload", "design_source_unavailable"),
      );
      await catalogue.choose("step_1", emailId, "email");
      expect(applied).not.toHaveBeenCalled();
      expect(unavailable).toHaveBeenCalledExactlyOnceWith("step_1", emailId);
      expect(authorityLost).not.toHaveBeenCalled();
      expect(catalogue.getSnapshot().page).not.toBeNull();
      expect(catalogue.getSnapshot().nodeError?.message).not.toContain("Private source");
      expect(catalogue.getSnapshot().preview).toBeNull();
    },
  );
});

describe("catalogue isolation from the immutable original workflow command", () => {
  function workflow() {
    let keys = 0;
    const client = {
      list: vi.fn<CampaignWorkflowClient["list"]>(async () => ({
        items: [],
        hasMore: false,
        nextCursor: null,
      })),
      detail: vi.fn<CampaignWorkflowClient["detail"]>(async () => {
        throw new Error("Not used");
      }),
      create: vi.fn<CampaignWorkflowClient["create"]>(async (command) => ({
        data: { id: versionId, campaignId, version: 1, state: "draft", definition: command.body },
        etag: '"1"',
      })),
    };
    const controller = new CampaignWorkflowController({
      binding: "opaque-original-workflow-context",
      campaignId,
      client,
      online: true,
      canRead: true,
      canWrite: true,
      createKey: () => `original-workflow-key-${++keys}`,
      validate: validateWorkflowDefinition,
      preview: previewWorkflow,
    });
    expect(controller.beginDraft()).toBe(true);
    expect(controller.add("email")).toBe(true);
    expect(controller.chooseDesign("step_1", requireWorkflowDesign(design(), '"1"', emailId, "email"))).toBe(
      true,
    );
    const source = setup();
    const catalogue = new CampaignWorkflowDesignCatalogue({
      online: true,
      client: source.client,
      isCurrent: () => true,
      applySelection: (key, receipt) => controller.chooseDesign(key, receipt),
      onSourceUnavailable: (key, id) => controller.designUnavailable(key, id),
      onAuthorityLost: (error) => controller.sourceAccessLost(error),
    });
    return { controller, client, catalogue, source, keys: () => keys };
  }
  it("stores only the explicitly verified UUID in a workflow, never the preview name/body or observed ordinal", async () => {
    const { controller, client } = workflow();
    expect(controller.getSnapshot().draft?.nodes).toEqual([
      { key: "step_1", kind: "email", messageDesignId: emailId },
    ]);
    await controller.save();
    const sent = client.create.mock.calls[0][0].body;
    expect(sent.nodes).toEqual([{ key: "step_1", kind: "email", messageDesignId: emailId }]);
    expect(JSON.stringify(sent)).not.toContain("Private static message text");
    expect(JSON.stringify(sent)).not.toContain("Reviewed subject");
  });
  it.each([404, 503])(
    "source read %s, focus refresh and offline cannot change an unknown workflow's body/key or retry",
    async (status) => {
      const { controller, client, catalogue, source, keys } = workflow();
      await catalogue.loadPage();
      client.create.mockRejectedValueOnce(new ApiError(504, "Unknown local acceptance", "request_timeout"));
      await controller.save();
      const original = controller.getSnapshot().pending;
      expect(controller.getSnapshot().phase).toBe("uncertain");
      source.client.detail.mockRejectedValueOnce(
        new ApiError(status, "Private source state", "design_source_unavailable"),
      );
      await catalogue.choose("step_1", emailId, "email");
      expect(controller.getSnapshot().pending).toBe(original);
      expect(controller.getSnapshot().phase).toBe("uncertain");
      await catalogue.refresh();
      catalogue.setOnline(false);
      controller.setOnline(false);
      expect(controller.getSnapshot().pending).toBe(original);
      expect(
        controller.chooseDesign(
          "step_1",
          requireWorkflowDesign(design("email", otherId), '"1"', otherId, "email"),
        ),
      ).toBe(false);
      await controller.save();
      expect(client.create).toHaveBeenCalledOnce();
      controller.setOnline(true);
      catalogue.setOnline(true);
      await controller.save();
      expect(keys()).toBe(1);
      expect(client.create).toHaveBeenCalledTimes(2);
      expect(client.create.mock.calls[1][0]).toEqual(client.create.mock.calls[0][0]);
      expect(controller.getSnapshot().phase).toBe("acknowledged");
    },
  );
  it("a source failure blocks a new draft, but unrelated node edits do not erase the unavailable reference issue", async () => {
    const { controller, client, catalogue, source } = workflow();
    await catalogue.loadPage();
    source.client.detail.mockRejectedValueOnce(
      new ApiError(503, "Private source state", "design_source_unavailable"),
    );
    await catalogue.choose("step_1", emailId, "email");
    expect(controller.getSnapshot().issues.some((issue) => issue.field === "nodes.0.messageDesignId")).toBe(
      true,
    );
    expect(controller.add("task")).toBe(true);
    expect(controller.editNode("step_2", "Independent reviewed task")).toBe(true);
    expect(controller.getSnapshot().issues.some((issue) => issue.field === "nodes.0.messageDesignId")).toBe(
      true,
    );
    await controller.save();
    expect(client.create).not.toHaveBeenCalled();
    await catalogue.choose("step_1", emailId, "email");
    expect(controller.getSnapshot().issues).toEqual([]);
    await controller.save();
    expect(client.create).toHaveBeenCalledOnce();
  });
});
