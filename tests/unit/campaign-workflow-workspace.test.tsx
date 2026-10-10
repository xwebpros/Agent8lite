import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { previewWorkflow, validateWorkflowDefinition } from "../../packages/marketing";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
  type CampaignWorkflowState,
} from "../../apps/web/components/campaign-workflow-controller";
import CampaignWorkflowWorkspace, {
  CampaignWorkflowView,
} from "../../apps/web/components/campaign-workflow-workspace";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const campaignId = "c3000000-0000-4000-8000-000000000001",
  versionId = "c3000000-0000-4000-8000-000000000002",
  designId = "c3000000-0000-4000-8000-000000000003";
const definition = (): Schema<"CampaignVersionWrite"> => ({
  timezone: "UTC",
  nodes: [
    { key: "wait", kind: "wait", delaySeconds: 30 },
    { key: "task", kind: "task", taskTitle: "<script>privateTask()</script>" },
  ],
  edges: [{ from: "wait", to: "task", branch: "always" }],
});
const version = (): Schema<"CampaignVersion"> => ({
  id: versionId,
  campaignId,
  version: 3,
  state: "draft",
  definition: definition(),
});
function setup(canWrite = true) {
  const client = {
    list: vi.fn<CampaignWorkflowClient["list"]>(async () => ({
      items: [version()],
      nextCursor: "private-cursor",
      hasMore: true,
    })),
    detail: vi.fn<CampaignWorkflowClient["detail"]>(async () => ({ data: version(), etag: '"3"' })),
    create: vi.fn<CampaignWorkflowClient["create"]>(async (command) => ({
      data: { ...version(), version: 4, definition: command.body },
      etag: '"4"',
    })),
  };
  const controller = new CampaignWorkflowController({
    binding: "private-binding-never-render",
    campaignId,
    client,
    canRead: true,
    canWrite,
    online: true,
    createKey: () => "private-key-never-render",
    validate: validateWorkflowDefinition,
    preview: previewWorkflow,
  });
  return { controller, client };
}
function render(state: CampaignWorkflowState, active = true, online = state.online) {
  const actions = {
    refresh: vi.fn(),
    next: vi.fn(),
    select: vi.fn(),
    begin: vi.fn(),
    copy: vi.fn(),
    add: vi.fn(),
    move: vi.fn(),
    remove: vi.fn(),
    editNode: vi.fn(),
    timezone: vi.fn(),
    quiet: vi.fn(),
    save: vi.fn(),
    discard: vi.fn(),
    editRejected: vi.fn(),
    start: vi.fn(),
    choice: vi.fn(),
    preview: vi.fn(),
  };
  return {
    markup: renderToStaticMarkup(
      <CampaignWorkflowView state={state} active={active} online={online} actions={actions} />,
    ),
    actions,
  };
}
function buttons(markup: string) {
  return Array.from(markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), (match) => ({
    html: match[0],
    text: match[0].replace(/<[^>]*>/g, "").trim(),
  }));
}
function disabled(markup: string, text: string) {
  const item = buttons(markup).find((button) => button.text === text);
  expect(item).toBeDefined();
  expect(item!.html).toContain('disabled=""');
}

describe("accessible immutable workflow presentation", () => {
  it("distinguishes unread and capability unavailable from an empty successful list", async () => {
    const { controller, client } = setup();
    expect(render(controller.getSnapshot(), false).markup).toContain("Synthetic workflow drafts unavailable");
    expect(render(controller.getSnapshot()).markup).toContain(
      "The workflow version index has not been read successfully.",
    );
    client.list.mockRejectedValueOnce(
      new ApiError(403, "private entitlement information", "entitlement_disabled"),
    );
    await controller.loadPage();
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Workflow capability or references unavailable");
    expect(markup).toContain("Verify current workflow access");
    expect(markup).not.toContain("No saved workflow versions");
    expect(markup).not.toContain("private entitlement information");
    expect(markup).not.toContain("Start new workflow draft");
  });
  it("renders an exact saved version read-only and escapes content without invoking any action", async () => {
    const { controller } = setup();
    await controller.select(versionId);
    const { markup, actions } = render(controller.getSnapshot());
    expect(markup).toContain("Immutable version reference");
    expect(markup).toContain(versionId);
    expect(markup).toContain("&lt;script&gt;privateTask()&lt;/script&gt;");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("Copy to new workflow draft");
    expect(markup).not.toContain("Task title for step");
    expect(markup).not.toContain("Save immutable workflow draft");
    expect(buttons(markup).some((button) => /publish|enroll|send|activate|schedule/i.test(button.text))).toBe(
      false,
    );
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });
  it("provides native ordered rows, labeled controls and explicit keyboard reorder/remove buttons", () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("wait");
    controller.add("task");
    controller.editNode("step_2", "Review local task");
    const { markup } = render(controller.getSnapshot());
    expect(markup.match(/<ol\b/g)).toHaveLength(1);
    expect(markup).toContain("Wait delay in seconds for step 1");
    expect(markup).toContain("Task title for step 2");
    expect(markup).toContain("Workflow timezone");
    const labels = Array.from(markup.matchAll(/<label for="([^"]+)">/g), (match) => match[1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(markup).toContain(`id="${label}"`);
    expect(markup).toContain('aria-label="Move step 1 up"');
    expect(markup).toContain('aria-label="Move step 1 down"');
    expect(markup).toContain('aria-label="Remove step 2"');
    const firstUp = buttons(markup).find((button) => button.html.includes('aria-label="Move step 1 up"'));
    expect(firstUp!.html).toContain('disabled=""');
    const lastDown = buttons(markup).find((button) => button.html.includes('aria-label="Move step 2 down"'));
    expect(lastDown!.html).toContain('disabled=""');
  });
  it("identifies invalid fields and links native controls to readable definition errors", () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("task");
    controller.editTimezone("EST");
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Review definition fields");
    expect(markup).toContain("Step 1 task title");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="');
    expect(markup).not.toContain("nodes.0.taskTitle");
    disabled(markup, "Save immutable workflow draft");
  });
  it("preserves condition branches as read-only and requires explicit reached branch choices", async () => {
    const { controller, client } = setup();
    const graph: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      nodes: [
        { key: "condition", kind: "condition", condition: { q: "<private search>" } },
        { key: "yes", kind: "task", taskTitle: "True branch" },
        { key: "no", kind: "task", taskTitle: "False branch" },
      ],
      edges: [
        { from: "condition", to: "yes", branch: "true" },
        { from: "condition", to: "no", branch: "false" },
      ],
    };
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition: graph }, etag: '"3"' });
    await controller.select(versionId);
    let markup = render(controller.getSnapshot()).markup;
    expect(markup).toContain("Stored graph nodes");
    expect(markup).toContain("true → yes");
    expect(markup).toContain("false → no");
    expect(markup).toContain("&lt;private search&gt;");
    expect(markup).toContain("This saved graph stays read-only");
    disabled(markup, "Copy to new workflow draft");
    expect(markup).toContain("Choose a branch if this condition is reached");
    expect(markup).not.toContain("Add wait step");
    controller.preview();
    markup = render(controller.getSnapshot()).markup;
    expect(markup).toContain("Preview branch for condition");
    expect(markup).toContain('aria-invalid="true"');
    controller.setChoice("condition", true);
    controller.preview();
    markup = render(controller.getSnapshot()).markup;
    expect(markup).toContain("Checks still required before any future execution");
    expect(markup).toContain("CRM task write permission");
    expect(markup).not.toContain("task created");
  });
  it("shows an existing message reference with unavailable prerequisites and no fabricated design picker", async () => {
    const { controller, client } = setup();
    const graph: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      nodes: [{ key: "email", kind: "email", messageDesignId: designId }],
      edges: [],
    };
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition: graph }, etag: '"3"' });
    await controller.select(versionId);
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain(designId);
    expect(markup).toContain("No authorized design picker is available here");
    expect(markup).not.toContain(`value="${designId}"`);
    disabled(markup, "Copy to new workflow draft");
    expect(buttons(markup).some((button) => /send|publish/i.test(button.text))).toBe(false);
  });
  it("locks unknown graph inputs and destructive actions while keeping an exact original retry available", async () => {
    const { controller, client } = setup();
    controller.beginDraft();
    controller.add("task");
    controller.editNode("step_1", "Protected local task");
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Protected local task");
    expect(markup).toContain("Retry original workflow command");
    disabled(markup, "Discard local workflow draft");
    disabled(markup, "Add wait step");
    disabled(markup, "Refresh versions");
    disabled(markup, "Preview chosen virtual path");
    expect(markup).not.toContain("Edit rejected workflow draft");
    expect(markup).not.toContain("private-key-never-render");
    expect(markup).not.toContain("private-binding-never-render");
    expect(markup).toContain('<fieldset disabled=""');
  });
  it("hides fetched references offline while retaining only visibly locked protected draft fields", async () => {
    const { controller } = setup();
    await controller.loadPage();
    await controller.select(versionId);
    controller.copySelected();
    controller.setOnline(false);
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Offline");
    expect(markup).toContain("&lt;script&gt;privateTask()&lt;/script&gt;");
    expect(markup).not.toContain(versionId);
    expect(markup).not.toContain("private-cursor");
    expect(markup).not.toContain("Read next version page");
    disabled(markup, "Save immutable workflow draft");
    disabled(markup, "Preview chosen virtual path");
    expect(markup).toContain('<fieldset disabled=""');
  });
  it("renders historical acknowledgment separately, without automatically reopening an editor", async () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("wait");
    await controller.save();
    const { markup } = render(controller.getSnapshot());
    expect(markup).toContain("Draft version acknowledged");
    expect(markup).toContain("historical command receipt");
    expect(markup).toContain("Read exact acknowledged version");
    expect(markup).not.toContain("Save immutable workflow draft");
    expect(markup).not.toContain("Workflow timezone");
    controller.setOnline(false);
    expect(render(controller.getSnapshot()).markup).not.toContain(versionId);
  });
  it("never fetches during static rendering and does not serialize Session identity or CSRF", () => {
    const session: Schema<"Session"> = {
      userId: designId,
      profile: { displayName: "Private identity-never-render", timezone: "UTC" },
      organizations: [],
      activeOrgId: campaignId,
      permissions: ["campaigns.read", "campaigns.write"],
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected SSR fetch"));
    try {
      const markup = renderToStaticMarkup(
        <CampaignWorkflowWorkspace
          session={session}
          campaignId={campaignId}
          csrf="private-csrf-never-render"
          online
          syntheticFeaturesEnabled
          accessRevision={3}
          onProtectedChange={vi.fn()}
        />,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(markup).toContain("Build an ordered workflow draft");
      expect(markup).not.toContain("Private identity-never-render");
      expect(markup).not.toContain("private-csrf-never-render");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
