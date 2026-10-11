import { describe, expect, it, vi } from "vitest";
import { previewWorkflow, validateWorkflowDefinition } from "../../packages/marketing";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
} from "../../apps/web/components/campaign-workflow-controller";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import { WorkflowResponseError } from "../../apps/web/components/campaign-workflow-protocol";
import { requestWorkflowJson } from "../../apps/web/components/campaign-workflow-request";

const campaignId = "c2000000-0000-4000-8000-000000000001",
  versionId = "c2000000-0000-4000-8000-000000000002",
  otherId = "c2000000-0000-4000-8000-000000000003";
const chain = (): Schema<"CampaignVersionWrite"> => ({
  timezone: "UTC",
  quietHours: { start: "22:00", end: "07:00" },
  nodes: [
    { key: "first", kind: "wait", delaySeconds: 60 },
    { key: "second", kind: "task", taskTitle: "Private task" },
  ],
  edges: [{ from: "first", to: "second", branch: "always" }],
});
const version = (sequence = 1): Schema<"CampaignVersion"> => ({
  id: versionId,
  campaignId,
  version: sequence,
  state: "draft",
  definition: chain(),
});
const page = (): Schema<"PageCampaignVersion"> => ({ items: [version()], nextCursor: null, hasMore: false });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(canWrite = true) {
  let keys = 0,
    sequence = 1;
  const client = {
    list: vi.fn<CampaignWorkflowClient["list"]>(async () => page()),
    detail: vi.fn<CampaignWorkflowClient["detail"]>(async () => ({ data: version(), etag: '"1"' })),
    create: vi.fn<CampaignWorkflowClient["create"]>(async (command) => {
      const current = ++sequence;
      return { data: { ...version(current), definition: command.body }, etag: `"${current}"` };
    }),
  };
  const protectedChange = vi.fn(),
    accessRevoked = vi.fn();
  const controller = new CampaignWorkflowController({
    binding: "opaque-workflow-session",
    campaignId,
    client,
    online: true,
    canRead: true,
    canWrite,
    createKey: () => `fixed-workflow-command-${++keys}`,
    validate: validateWorkflowDefinition,
    preview: previewWorkflow,
    onProtectedChange: protectedChange,
    onAccessRevoked: accessRevoked,
  });
  return { controller, client, keys: () => keys, protectedChange, accessRevoked };
}
function draft(controller: CampaignWorkflowController) {
  expect(controller.beginDraft()).toBe(true);
  expect(controller.add("wait")).toBe(true);
  expect(controller.add("task")).toBe(true);
  expect(controller.editNode("step_2", "Reviewed private task")).toBe(true);
}
function branches(): Schema<"CampaignVersionWrite"> {
  return {
    timezone: "UTC",
    nodes: [
      { key: "entry", kind: "condition", condition: { intent: "buyer" } },
      { key: "yes", kind: "task", taskTitle: "True branch private task" },
      { key: "nested", kind: "condition", condition: { intent: "seller" } },
      { key: "no", kind: "wait", delaySeconds: 120 },
      { key: "other", kind: "task", taskTitle: "Other branch" },
    ],
    edges: [
      { from: "entry", to: "yes", branch: "true" },
      { from: "entry", to: "nested", branch: "false" },
      { from: "nested", to: "no", branch: "true" },
      { from: "nested", to: "other", branch: "false" },
    ],
  };
}

describe("version selection and lossless draft authoring", () => {
  it("requires explicit immutable selection and retains only the requested bounded page", async () => {
    const { controller, client } = setup();
    expect(controller.getSnapshot().page).toBeNull();
    client.list.mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: "current-cursor" });
    await controller.loadPage();
    expect(controller.getSnapshot().selected).toBeNull();
    await controller.loadPage("invented-cursor");
    expect(client.list).toHaveBeenCalledOnce();
    client.list.mockResolvedValueOnce({
      items: [{ ...version(2), id: otherId }],
      nextCursor: null,
      hasMore: false,
    });
    await controller.loadPage("current-cursor");
    expect(controller.getSnapshot().page!.items.map((item) => item.id)).toEqual([otherId]);
    expect(controller.getSnapshot().selected).toBeNull();
  });
  it("validates closed response and full graph semantics before displaying any version", async () => {
    const { controller, client } = setup();
    client.detail.mockResolvedValueOnce({
      data: { ...version(), definition: { ...chain(), edges: [] } },
      etag: '"1"',
    });
    await controller.select(versionId);
    expect(controller.getSnapshot().selected).toBeNull();
    client.list.mockResolvedValueOnce({
      ...page(),
      items: [{ ...version(), definition: { ...chain(), edges: [] } }],
    });
    await controller.loadPage();
    expect(controller.getSnapshot().page).toBeNull();
    await controller.select("../another-route");
    expect(client.detail).toHaveBeenCalledOnce();
  });
  it("copies exact node/edge ordering into a new draft without changing the saved version", async () => {
    const { controller, client, protectedChange } = setup();
    const definition = chain();
    definition.nodes.reverse();
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition }, etag: '"1"' });
    await controller.select(versionId);
    expect(controller.copySelected()).toBe(true);
    expect(controller.getSnapshot().draft).toEqual(definition);
    expect(protectedChange).toHaveBeenLastCalledWith(true);
    const saved = controller.getSnapshot().selected!.data.definition;
    expect(controller.move("second", -1)).toBe(true);
    expect(controller.getSnapshot().draft!.edges).toEqual([
      { from: "second", to: "first", branch: "always" },
    ]);
    expect(controller.getSnapshot().draft!.quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(saved).toEqual(definition);
    expect(Object.isFrozen(saved.nodes)).toBe(true);
  });
  // ADR-050 deliberately changed this retained case: structured branched graphs are now copyable.
  it("copies a structured branched definition losslessly into a draft", async () => {
    const { controller, client } = setup();
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition: branches() }, etag: '"1"' });
    await controller.select(versionId);
    expect(controller.copySelected()).toBe(true);
    const draft = controller.getSnapshot().draft!;
    expect(new Set(draft.nodes.map((node) => JSON.stringify(node)))).toEqual(
      new Set(branches().nodes.map((node) => JSON.stringify(node))),
    );
    expect(new Set(draft.edges.map((edge) => JSON.stringify(edge)))).toEqual(
      new Set(branches().edges.map((edge) => JSON.stringify(edge))),
    );
    expect(controller.getSnapshot().issues).toEqual([]);
    expect(controller.getSnapshot().selected!.data.definition).toEqual(branches());
  });
  it("keeps unstructured definitions untouched and explicitly read-only", async () => {
    const unstructured: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      nodes: [
        { key: "c", kind: "condition", condition: { intent: "buyer" } },
        { key: "a", kind: "wait", delaySeconds: 1 },
        { key: "d", kind: "condition", condition: { intent: "seller" } },
        { key: "b", kind: "task", taskTitle: "Synthetic b" },
        { key: "e", kind: "task", taskTitle: "Synthetic e" },
        { key: "f", kind: "task", taskTitle: "Synthetic f" },
      ],
      edges: [
        { from: "c", to: "a", branch: "true" },
        { from: "c", to: "b", branch: "false" },
        { from: "a", to: "d", branch: "always" },
        { from: "d", to: "b", branch: "true" },
        { from: "d", to: "e", branch: "false" },
        { from: "b", to: "f", branch: "always" },
        { from: "e", to: "f", branch: "always" },
      ],
    };
    for (const definition of [unstructured]) {
      const { controller, client } = setup();
      client.detail.mockResolvedValueOnce({ data: { ...version(), definition }, etag: '"1"' });
      await controller.select(versionId);
      expect(controller.copySelected()).toBe(false);
      expect(controller.getSnapshot().draft).toBeNull();
      expect(controller.getSnapshot().selected!.data.definition).toEqual(definition);
      expect(controller.getSnapshot().message).toContain("read-only");
      expect(controller.add("wait")).toBe(false);
      await controller.save();
      expect(client.create).not.toHaveBeenCalled();
    }
  });
  it("requires current native/channel/strong-revision proof and stores only the explicit aggregate ID", async () => {
    const { controller, client } = setup();
    controller.beginDraft();
    controller.add("email");
    controller.add("sms");
    const email: Schema<"MessageDesign"> = {
      id: otherId,
      name: "Observed email",
      channel: "email",
      editor: "native",
      design: { schemaVersion: 1, blocks: [{ type: "text", text: "Private observed text" }] },
      content: "Private observed text",
      subject: "Observed subject",
      version: 2,
    };
    expect(controller.chooseDesign("step_1", { data: email, etag: 'W/"2"' })).toBe(false);
    expect(controller.chooseDesign("step_2", { data: email, etag: '"2"' })).toBe(false);
    expect(controller.chooseDesign("step_1", { data: { ...email, editor: "unlayer" }, etag: '"2"' })).toBe(
      false,
    );
    expect(controller.chooseDesign("step_1", { data: email, etag: '"2"' })).toBe(true);
    expect(
      controller.chooseDesign("step_2", { data: { ...email, id: versionId, channel: "sms" }, etag: '"2"' }),
    ).toBe(true);
    expect(controller.getSnapshot().draft!.nodes).toEqual([
      { key: "step_1", kind: "email", messageDesignId: otherId },
      { key: "step_2", kind: "sms", messageDesignId: versionId },
    ]);
    controller.move("step_2", -1);
    controller.designUnavailable("step_1", otherId);
    controller.add("wait");
    expect(controller.getSnapshot().issues).toContainEqual({
      field: "nodes.1.messageDesignId",
      message: "This current native design is unavailable. Choose an authorized design explicitly.",
    });
    await controller.save();
    expect(client.create).not.toHaveBeenCalled();
    expect(controller.chooseDesign("step_1", { data: email, etag: '"2"' })).toBe(true);
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    expect(JSON.stringify(original!.body)).not.toContain("Private observed text");
    expect(JSON.stringify(original!.body)).not.toContain("subject");
    expect(controller.chooseDesign("step_1", { data: { ...email, id: campaignId }, etag: '"2"' })).toBe(
      false,
    );
    controller.designUnavailable("step_1", otherId);
    expect(controller.getSnapshot().pending).toEqual(original);
    await controller.save();
    expect(client.create.mock.calls[1][0]).toEqual(original);
  });
  it("losslessly copies an authorized immutable mixed message chain before any explicit edit", async () => {
    const { controller, client } = setup();
    const definition: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      quietHours: { start: "23:00", end: "06:00" },
      nodes: [
        { key: "email", kind: "email", messageDesignId: otherId },
        { key: "wait", kind: "wait", delaySeconds: 12 },
        { key: "sms", kind: "sms", messageDesignId: versionId },
      ],
      edges: [
        { from: "email", to: "wait", branch: "always" },
        { from: "wait", to: "sms", branch: "always" },
      ],
    };
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition }, etag: '"1"' });
    await controller.select(versionId);
    expect(controller.copySelected()).toBe(true);
    expect(controller.getSnapshot().draft).toEqual(definition);
    controller.move("sms", -1);
    expect(controller.getSnapshot().selected!.data.definition).toEqual(definition);
    expect(controller.getSnapshot().draft!.quietHours).toEqual(definition.quietHours);
  });
  it("uses explicit move/remove controls and relinks only the edited linear chain", () => {
    const { controller } = setup();
    draft(controller);
    expect(controller.move("step_1", -1)).toBe(false);
    expect(controller.move("step_2", 1)).toBe(false);
    expect(controller.move("step_1", 1)).toBe(true);
    expect(controller.getSnapshot().draft!.edges).toEqual([
      { from: "step_2", to: "step_1", branch: "always" },
    ]);
    expect(controller.remove("step_1")).toBe(true);
    expect(controller.getSnapshot().draft!.edges).toEqual([]);
    expect(controller.remove("step_2")).toBe(true);
    expect(controller.getSnapshot().issues.some((issue) => issue.field === "nodes")).toBe(true);
    expect(controller.add("wait")).toBe(true);
    expect(controller.getSnapshot().draft!.nodes[0].key).toBe("step_3");
  });
  it("exposes node-specific field errors without creating invalid definitions", async () => {
    const { controller, client, keys } = setup();
    draft(controller);
    controller.editNode("step_1", "-1");
    controller.editNode("step_2", " ");
    controller.editTimezone("EST");
    controller.editQuietHours({ start: "12:00", end: "12:00" });
    expect(controller.getSnapshot().issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(["nodes.0.delaySeconds", "nodes.1.taskTitle", "timezone", "quietHours"]),
    );
    await controller.save();
    expect(client.create).not.toHaveBeenCalled();
    expect(keys()).toBe(0);
    controller.editNode("step_1", "60");
    controller.editNode("step_2", "🏡".repeat(200));
    controller.editTimezone("UTC");
    controller.editQuietHours(undefined);
    expect(controller.getSnapshot().issues).toEqual([]);
    expect(controller.editNode("step_2", "x".repeat(201))).toBe(false);
    expect(controller.getSnapshot().draft!.nodes[1].taskTitle).toBe("🏡".repeat(200));
    await controller.save();
    expect(client.create).toHaveBeenCalledOnce();
  });
  it("blocks new reads while a draft is protected and allows explicit discard of only an unsent draft", async () => {
    const { controller, client, protectedChange } = setup();
    draft(controller);
    await controller.loadPage();
    await controller.select(versionId);
    expect(client.list).not.toHaveBeenCalled();
    expect(client.detail).not.toHaveBeenCalled();
    expect(controller.isProtected()).toBe(true);
    expect(controller.discard()).toBe(true);
    expect(protectedChange).toHaveBeenLastCalledWith(false);
    await controller.loadPage();
    expect(client.list).toHaveBeenCalledOnce();
  });
  it("permits read-only history and preview while denying local write controls", async () => {
    const { controller, client } = setup(false);
    await controller.select(versionId);
    expect(controller.beginDraft()).toBe(false);
    expect(controller.copySelected()).toBe(false);
    expect(controller.add("wait")).toBe(false);
    expect(controller.preview()).toBe(true);
    await controller.save();
    expect(client.create).not.toHaveBeenCalled();
  });
});

describe("original immutable version command recovery", () => {
  it("adds safe node issues on a rejected retry without releasing the earlier unknown command", async () => {
    const { controller, client, keys } = setup();
    draft(controller);
    const issues = [
      {
        field: "nodes.1.taskTitle",
        message: "A nonblank task title with at most 200 characters is required.",
      },
    ];
    client.create
      .mockRejectedValueOnce(new Error("unknown"))
      .mockRejectedValueOnce(new WorkflowResponseError(422, "workflow_invalid", issues));
    await controller.save();
    const original = controller.getSnapshot().pending;
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: original, issues });
    expect(controller.editRejected()).toBe(false);
    expect(keys()).toBe(1);
  });
  it("keeps a timed-out POST unknown with its exact key and never automatically appends another version", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (_path, options) =>
          new Promise<Response>((_resolve, reject) =>
            options!.signal!.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          ),
      );
    try {
      const { controller, client, keys } = setup();
      draft(controller);
      client.create.mockImplementationOnce((command) =>
        requestWorkflowJson(
          "/api/v1/workflow-test",
          201,
          { method: "POST", body: JSON.stringify(command.body) },
          command.body,
        ),
      );
      const saving = controller.save();
      const original = controller.getSnapshot().pending;
      await vi.advanceTimersByTimeAsync(20000);
      await saving;
      expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: original });
      expect(client.create).toHaveBeenCalledOnce();
      expect(keys()).toBe(1);
      await controller.save();
      expect(client.create.mock.calls[1][0]).toEqual(original);
      expect(keys()).toBe(1);
      expect(controller.getSnapshot().phase).toBe("acknowledged");
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
  it("keeps exact original key and graph after ambiguity, and acknowledges without restoring a historical editor", async () => {
    const { controller, client, keys } = setup();
    draft(controller);
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    expect(original!.body.nodes[1].taskTitle).toBe("Reviewed private task");
    expect(Object.isFrozen(original!.body.nodes)).toBe(true);
    expect(controller.editNode("step_2", "Replacement")).toBe(false);
    expect(controller.remove("step_1")).toBe(false);
    expect(controller.discard()).toBe(false);
    expect(controller.editRejected()).toBe(false);
    client.create.mockResolvedValueOnce({ data: { ...version(8), definition: original!.body }, etag: '"8"' });
    await controller.save();
    expect(client.create.mock.calls[1][0]).toEqual(original);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "acknowledged",
      pending: null,
      draft: null,
      selected: null,
      dirty: false,
    });
    expect(controller.getSnapshot().receipt!.data.version).toBe(8);
    client.detail.mockResolvedValueOnce({ data: { ...version(8), definition: original!.body }, etag: '"8"' });
    await controller.select(versionId);
    expect(controller.getSnapshot().draft).toBeNull();
    expect(controller.copySelected()).toBe(true);
  });
  it.each([400, 422, 429])(
    "does not release an earlier ambiguous key after a later rejected retry%s",
    async (status) => {
      const { controller, client, keys } = setup();
      draft(controller);
      client.create
        .mockRejectedValueOnce(new Error("unknown"))
        .mockRejectedValueOnce(new ApiError(status, "later rejection"));
      await controller.save();
      const original = controller.getSnapshot().pending;
      await controller.save();
      expect(controller.getSnapshot()).toMatchObject({ phase: "uncertain", pending: original });
      expect(controller.editRejected()).toBe(false);
      expect(keys()).toBe(1);
    },
  );
  it("releases a definitively rejected first command only through an explicit review action", async () => {
    const { controller, client, keys } = setup();
    draft(controller);
    client.create.mockRejectedValueOnce(new ApiError(422, "references unavailable"));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("rejected");
    expect(controller.editRejected()).toBe(true);
    expect(keys()).toBe(1);
    controller.editNode("step_2", "Reviewed replacement");
    await controller.save();
    expect(keys()).toBe(2);
    expect(client.create.mock.calls[1][0].idempotencyKey).not.toBe(
      client.create.mock.calls[0][0].idempotencyKey,
    );
  });
  it.each(["parent", "graph", "etag", "published"])(
    "keeps a mismatched %s acknowledgment unknown",
    async (variant) => {
      const { controller, client } = setup();
      draft(controller);
      const data = { ...version(2), definition: controller.getSnapshot().draft! },
        etag = '"2"';
      if (variant === "parent") data.campaignId = otherId;
      if (variant === "graph") data.definition = chain();
      if (variant === "published") data.state = "published";
      client.create.mockResolvedValueOnce({ data, etag: variant === "etag" ? 'W/"2"' : etag });
      await controller.save();
      expect(controller.getSnapshot().phase).toBe("uncertain");
      expect(controller.getSnapshot().pending).not.toBeNull();
    },
  );
  it("detaches transport input and prevents duplicate concurrent saves", async () => {
    const { controller, client, keys } = setup();
    draft(controller);
    const response = deferred<{ data: unknown; etag: string }>();
    client.create.mockImplementationOnce((command) => {
      command.body.nodes[1].taskTitle = "Transport mutation";
      return response.promise;
    });
    const first = controller.save();
    await controller.save();
    expect(client.create).toHaveBeenCalledOnce();
    expect(keys()).toBe(1);
    expect(controller.getSnapshot().pending!.body.nodes[1].taskTitle).toBe("Reviewed private task");
    response.reject(new Error("unknown"));
    await first;
    await controller.save();
    expect(client.create.mock.calls[1][0].body.nodes[1].taskTitle).toBe("Reviewed private task");
  });
  it("compares object keys canonically without changing graph array order", async () => {
    const { controller, client } = setup();
    draft(controller);
    client.create.mockImplementationOnce(async (command) => ({
      data: {
        ...version(3),
        definition: {
          timezone: command.body.timezone,
          edges: command.body.edges.map((edge) => ({ branch: edge.branch, to: edge.to, from: edge.from })),
          nodes: command.body.nodes,
        },
      },
      etag: '"3"',
    }));
    await controller.save();
    expect(controller.getSnapshot().phase).toBe("acknowledged");
  });
});

describe("deterministic preview and private lifetimes", () => {
  it("clears older private definitions when an authoritative read reports a retired source reference", async () => {
    const { controller, client, accessRevoked } = setup();
    await controller.loadPage();
    await controller.select(versionId);
    client.detail.mockRejectedValueOnce(
      new WorkflowResponseError(422, "workflow_reference_unavailable", [
        {
          field: "nodes.0.condition.sourceId",
          message: "This source is unavailable or incompatible with the workflow.",
        },
      ]),
    );
    await controller.select(versionId);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      selected: null,
      page: null,
      draft: null,
    });
    expect(accessRevoked).not.toHaveBeenCalled();
  });
  it("uses a fixed virtual start and elapsed waits without quiet-hour shifting or executing tasks", async () => {
    const { controller, client } = setup();
    await controller.select(versionId);
    controller.setPreviewStart("2026-10-10T23:00:00.000Z");
    expect(controller.preview()).toBe(true);
    expect(controller.getSnapshot().preview!.map((step) => step.at)).toEqual([
      "2026-10-10T23:01:00.000Z",
      "2026-10-10T23:01:00.000Z",
    ]);
    expect(controller.getSnapshot().preview![1].prerequisites).toContain("crm_tasks_write");
    expect(client.create).not.toHaveBeenCalled();
  });
  it("requires explicit reached-condition choices while leaving unchosen branches intact", async () => {
    const { controller, client } = setup();
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition: branches() }, etag: '"1"' });
    await controller.select(versionId);
    expect(controller.preview()).toBe(false);
    expect(controller.getSnapshot().previewIssues[0].field).toBe("conditionChoices.entry");
    controller.setChoice("entry", true);
    expect(controller.preview()).toBe(true);
    expect(controller.getSnapshot().preview!.map((step) => step.nodeKey)).toEqual(["entry", "yes"]);
    controller.setChoice("entry", false);
    expect(controller.preview()).toBe(false);
    expect(controller.getSnapshot().previewIssues[0].field).toBe("conditionChoices.nested");
    controller.setChoice("nested", true);
    expect(controller.preview()).toBe(true);
    expect(controller.getSnapshot().preview!.map((step) => step.nodeKey)).toEqual(["entry", "nested", "no"]);
    expect(controller.getSnapshot().selected!.data.definition).toEqual(branches());
  });
  it("clears projections offline but keeps original draft/command; reconnection never resends automatically", async () => {
    const { controller, client } = setup();
    await controller.loadPage();
    draft(controller);
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    controller.setOnline(false);
    expect(controller.getSnapshot()).toMatchObject({
      page: null,
      selected: null,
      receipt: null,
      preview: null,
      pending: original,
    });
    await controller.save();
    expect(client.create).toHaveBeenCalledOnce();
    controller.setOnline(true);
    expect(client.create).toHaveBeenCalledOnce();
    await controller.save();
    expect(client.create.mock.calls[1][0]).toEqual(original);
  });
  it("clears private data on a current entitlement denial without invalidating unrelated member access", async () => {
    const { controller, client, accessRevoked } = setup();
    draft(controller);
    client.create.mockRejectedValueOnce(new ApiError(403, "private", "entitlement_disabled"));
    await controller.save();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "unavailable",
      draft: null,
      pending: null,
      page: null,
      selected: null,
      receipt: null,
    });
    expect(accessRevoked).not.toHaveBeenCalled();
    expect(controller.beginDraft()).toBe(false);
    await controller.loadPage();
    expect(controller.beginDraft()).toBe(true);
  });
  it.each([401, 403])(
    "reports definite identity/access loss%s and cannot reactivate it through effect setup",
    async (status) => {
      const { controller, client, accessRevoked } = setup();
      client.list.mockRejectedValueOnce(
        new ApiError(status, "private", status === 401 ? "entitlement_disabled" : "permission_denied"),
      );
      await controller.loadPage();
      expect(controller.getSnapshot().phase).toBe("denied");
      expect(accessRevoked).toHaveBeenCalledOnce();
      controller.detach();
      controller.attach();
      await controller.loadPage();
      expect(client.list).toHaveBeenCalledOnce();
    },
  );
  it("survives Strict Mode attach/detach/attach and ignores an older denial after a fresh read", async () => {
    const { controller, client, accessRevoked } = setup();
    const response = deferred<unknown>();
    client.list.mockReturnValueOnce(response.promise);
    controller.attach();
    const old = controller.loadPage();
    controller.detach();
    controller.attach();
    await controller.loadPage();
    response.reject(new ApiError(401, "old"));
    await old;
    expect(controller.getSnapshot().page).toEqual(page());
    expect(accessRevoked).not.toHaveBeenCalled();
    expect(controller.beginDraft()).toBe(true);
  });
  it("discards late command acknowledgments from an unmounted context", async () => {
    const old = setup(),
      current = setup();
    draft(old.controller);
    const response = deferred<{ data: unknown; etag: string }>();
    old.client.create.mockReturnValueOnce(response.promise);
    const save = old.controller.save(),
      original = old.controller.getSnapshot().pending!;
    old.controller.detach();
    await current.controller.loadPage();
    response.resolve({ data: { ...version(4), definition: original.body }, etag: '"4"' });
    await save;
    expect(old.controller.getSnapshot()).toMatchObject({ draft: null, pending: null, receipt: null });
    expect(current.controller.getSnapshot()).toMatchObject({ page: page(), receipt: null });
  });
});
