import { describe, expect, it, vi } from "vitest";
import { previewWorkflow, validateWorkflowDefinition } from "../../packages/marketing";
import { ApiError, type Schema } from "../../apps/web/lib/api";
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

const campaignId = "c4000000-0000-4000-8000-000000000001";
const emailId = "c4000000-0000-4000-8000-000000000002";
const smsId = "c4000000-0000-4000-8000-000000000003";
const versionId = "c4000000-0000-4000-8000-000000000004";
const email = (): Schema<"MessageDesign"> => ({
  id: emailId,
  name: "Reusable email",
  channel: "email",
  editor: "native",
  version: 3,
  design: { schemaVersion: 1, blocks: [{ type: "text", text: "Private source text" }] },
  content: "Private source text",
  subject: "Current subject",
});
const sms = (): Schema<"MessageDesign"> => ({
  ...email(),
  id: smsId,
  channel: "sms",
  name: "Reusable SMS",
  subject: null,
});
const page = (): Schema<"PageMessageDesign"> => ({
  items: [email(), sms()],
  hasMore: false,
  nextCursor: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  let current = true,
    keys = 0;
  const workflowClient = {
    list: vi.fn<CampaignWorkflowClient["list"]>(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
    })),
    detail: vi.fn<CampaignWorkflowClient["detail"]>(async () => {
      throw new Error("unused");
    }),
    create: vi.fn<CampaignWorkflowClient["create"]>(async () => {
      throw new Error("unknown");
    }),
  };
  const workflow = new CampaignWorkflowController({
    binding: "current-opaque-context",
    campaignId,
    canRead: true,
    canWrite: true,
    online: true,
    client: workflowClient,
    validate: validateWorkflowDefinition,
    preview: previewWorkflow,
    createKey: () => `original-key-${++keys}`,
  });
  const client = {
    list: vi.fn<WorkflowDesignCatalogueClient["list"]>(async () => page()),
    detail: vi.fn<WorkflowDesignCatalogueClient["detail"]>(async (id) => ({
      data: id === smsId ? sms() : email(),
      etag: '"3"',
    })),
  };
  const apply = vi.fn((key: string, receipt: Parameters<CampaignWorkflowController["chooseDesign"]>[1]) =>
    workflow.chooseDesign(key, receipt),
  );
  const lost = vi.fn((error: ApiError) => workflow.sourceAccessLost(error));
  const unavailable = vi.fn((key: string, id: string) => workflow.designUnavailable(key, id));
  const catalogue = new CampaignWorkflowDesignCatalogue({
    online: true,
    client,
    isCurrent: () => current,
    applySelection: apply,
    onAuthorityLost: lost,
    onSourceUnavailable: unavailable,
  });
  return {
    catalogue,
    workflow,
    client,
    workflowClient,
    apply,
    lost,
    unavailable,
    keys: () => keys,
    current: (value: boolean) => {
      current = value;
    },
  };
}

describe("current native workflow design catalogue", () => {
  it("projects exact compatible native channels from complete bounded generated pages", () => {
    expect(workflowDesignChoices(page(), "email")).toEqual([
      { id: emailId, name: "Reusable email", channel: "email", version: 3 },
    ]);
    expect(workflowDesignChoices(page(), "sms")).toEqual([
      { id: smsId, name: "Reusable SMS", channel: "sms", version: 3 },
    ]);
    const legacy = { ...email(), editor: "unlayer" as const };
    expect(workflowDesignChoices({ ...page(), items: [legacy] }, "email")).toEqual([]);
    expect(() => workflowDesignChoices({ ...page(), items: [email(), email()] }, "email")).toThrow();
    expect(() =>
      workflowDesignChoices(
        {
          ...page(),
          items: Array.from({ length: 6 }, (_, index) => ({
            ...email(),
            id: `c4000000-0000-4000-8000-00000000001${index}`,
          })),
        },
        "email",
      ),
    ).toThrow();
    expect(() => requireWorkflowDesign(email(), '"3"', smsId, "email")).toThrow();
    expect(() => requireWorkflowDesign(email(), 'W/"3"', emailId, "email")).toThrow();
    expect(() => requireWorkflowDesign(email(), '"3"', emailId, "sms")).toThrow();
    expect(() => requireWorkflowDesign(legacy, '"3"', emailId, "email")).toThrow();
  });
  it("never selects from an unread page or invents a reference from another channel/page", async () => {
    const { catalogue, workflow, client, apply } = setup();
    workflow.beginDraft();
    workflow.add("email");
    await catalogue.choose("step_1", emailId, "email");
    expect(client.detail).not.toHaveBeenCalled();
    await catalogue.loadPage();
    expect(apply).not.toHaveBeenCalled();
    await catalogue.choose("step_1", versionId, "email");
    await catalogue.choose("step_1", smsId, "email");
    expect(client.detail).not.toHaveBeenCalled();
    await catalogue.choose("step_1", emailId, "email");
    expect(client.detail).toHaveBeenCalledWith(emailId);
    expect(workflow.getSnapshot().draft!.nodes[0]).toEqual({
      key: "step_1",
      kind: "email",
      messageDesignId: emailId,
    });
    expect(catalogue.getSnapshot().preview!.data.content).toBe("Private source text");
    expect(JSON.stringify(workflow.getSnapshot().draft)).not.toContain("Private source text");
  });
  it("replaces one page only through its current cursor and never accumulates private designs", async () => {
    const { catalogue, client } = setup();
    client.list.mockResolvedValueOnce({
      ...page(),
      items: [email()],
      hasMore: true,
      nextCursor: "current-page-cursor",
    });
    await catalogue.loadPage();
    await catalogue.loadPage("invented-page-cursor");
    expect(client.list).toHaveBeenCalledOnce();
    client.list.mockResolvedValueOnce({ ...page(), items: [sms()] });
    await catalogue.loadPage("current-page-cursor");
    expect(catalogue.getSnapshot().page!.items.map((item) => item.id)).toEqual([smsId]);
    expect(catalogue.getSnapshot().preview).toBeNull();
  });
  it("requires a new current-page detail read and refuses changed channel/native/ETag without altering the graph", async () => {
    const { catalogue, workflow, client } = setup();
    workflow.beginDraft();
    workflow.add("email");
    await catalogue.loadPage();
    for (const result of [
      { data: sms(), etag: '"3"' },
      { data: { ...email(), channel: "sms" }, etag: '"3"' },
      { data: { ...email(), editor: "unlayer" }, etag: '"3"' },
      { data: email(), etag: '"2"' },
    ]) {
      client.detail.mockResolvedValueOnce(result);
      await catalogue.choose("step_1", emailId, "email");
      expect(workflow.getSnapshot().draft!.nodes[0].messageDesignId).toBeUndefined();
      expect(catalogue.getSnapshot().preview).toBeNull();
      expect(catalogue.getSnapshot().nodeError!.nodeKey).toBe("step_1");
    }
  });
  it("refreshes on the same focus boundary without changing dirty or unknown original input/key", async () => {
    const { catalogue, workflow, client, workflowClient, keys } = setup();
    workflow.beginDraft();
    workflow.add("email");
    await catalogue.loadPage();
    await catalogue.choose("step_1", emailId, "email");
    await workflow.save();
    const original = workflow.getSnapshot().pending;
    expect(original!.body.nodes[0].messageDesignId).toBe(emailId);
    client.list.mockResolvedValueOnce({ ...page(), items: [sms()] });
    const refreshing = catalogue.refresh();
    expect(catalogue.getSnapshot().preview).toBeNull();
    expect(catalogue.getSnapshot().page).toBeNull();
    await refreshing;
    await catalogue.choose("step_1", smsId, "sms");
    expect(workflow.getSnapshot().pending).toEqual(original);
    expect(workflow.getSnapshot().draft).toEqual(original!.body);
    catalogue.setOnline(false);
    workflow.setOnline(false);
    expect(catalogue.getSnapshot()).toMatchObject({ page: null, preview: null, reading: false });
    expect(workflow.getSnapshot().pending).toEqual(original);
    catalogue.setOnline(true);
    workflow.setOnline(true);
    await catalogue.refresh();
    await workflow.save();
    expect(keys()).toBe(1);
    expect(workflowClient.create.mock.calls[1][0]).toEqual(original);
  });
  it("ignores late source detail failures after a newer catalogue epoch or changed opaque context", async () => {
    const { catalogue, workflow, client, lost, current } = setup();
    workflow.beginDraft();
    workflow.add("email");
    await catalogue.loadPage();
    const old = deferred<{ data: unknown; etag: string }>();
    client.detail.mockReturnValueOnce(old.promise);
    const reading = catalogue.choose("step_1", emailId, "email");
    await catalogue.refresh();
    await catalogue.choose("step_1", emailId, "email");
    old.reject(new ApiError(403, "old denied", "permission_denied"));
    await reading;
    expect(lost).not.toHaveBeenCalled();
    expect(catalogue.getSnapshot().preview!.data.id).toBe(emailId);
    const late = deferred<unknown>();
    client.list.mockReturnValueOnce(late.promise);
    const loading = catalogue.refresh();
    current(false);
    catalogue.invalidate();
    late.resolve(page());
    await loading;
    expect(catalogue.getSnapshot().page).toBeNull();
  });
  it("preserves a failed source reference and step-specific issue until explicitly reverified", async () => {
    const { catalogue, workflow, client, workflowClient } = setup();
    workflow.beginDraft();
    workflow.add("email");
    await catalogue.loadPage();
    await catalogue.choose("step_1", emailId, "email");
    client.detail.mockRejectedValueOnce(
      new ApiError(404, "private source destination", "resource_unavailable"),
    );
    await catalogue.choose("step_1", emailId, "email");
    expect(workflow.getSnapshot().draft!.nodes[0].messageDesignId).toBe(emailId);
    workflow.add("wait");
    expect(workflow.getSnapshot().issues.some((issue) => issue.field === "nodes.0.messageDesignId")).toBe(
      true,
    );
    expect(catalogue.getSnapshot().nodeError!.message).not.toContain("private source destination");
    await workflow.save();
    expect(workflowClient.create).not.toHaveBeenCalled();
    await catalogue.choose("step_1", emailId, "email");
    expect(workflow.getSnapshot().issues).toEqual([]);
  });
  it("clears private source and workflow memory on current authority loss and keeps StrictMode cleanup recoverable", async () => {
    const { catalogue, workflow, client, lost } = setup();
    await catalogue.loadPage();
    catalogue.detach();
    catalogue.attach();
    await catalogue.loadPage();
    expect(catalogue.getSnapshot().page).not.toBeNull();
    workflow.beginDraft();
    workflow.add("email");
    client.detail.mockRejectedValueOnce(new ApiError(403, "private reason", "permission_denied"));
    await catalogue.choose("step_1", emailId, "email");
    expect(lost).toHaveBeenCalledOnce();
    expect(catalogue.getSnapshot()).toMatchObject({ phase: "denied", page: null, preview: null });
    expect(workflow.getSnapshot()).toMatchObject({ phase: "denied", draft: null, pending: null });
    catalogue.attach();
    await catalogue.loadPage();
    expect(catalogue.getSnapshot().page).toBeNull();
  });
});
