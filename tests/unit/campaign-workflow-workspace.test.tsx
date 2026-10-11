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
  WorkflowDesignCheckButton,
} from "../../apps/web/components/campaign-workflow-workspace";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import type { WorkflowDesignCatalogueState } from "../../apps/web/components/campaign-workflow-design-catalogue";

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
const unreadCatalogue = (): WorkflowDesignCatalogueState => ({
  online: true,
  reading: false,
  page: null,
  preview: null,
  previewNodeKey: null,
  phase: "unread",
  error: "",
  nodeError: null,
});
function render(
  state: CampaignWorkflowState,
  active = true,
  online = state.online,
  catalogue = unreadCatalogue(),
) {
  const actions = {
    refresh: vi.fn(),
    next: vi.fn(),
    select: vi.fn(),
    begin: vi.fn(),
    copy: vi.fn(),
    add: vi.fn(),
    refreshDesigns: vi.fn(),
    nextDesigns: vi.fn(),
    chooseDesign: vi.fn(),
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
      <CampaignWorkflowView
        state={state}
        catalogue={catalogue}
        active={active}
        online={online}
        actions={actions}
      />,
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
  // ADR-050 deliberately changed this retained case: a structured branch graph renders as an outline.
  it("renders condition branches as a nested outline and requires explicit reached branch choices", async () => {
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
    expect(markup).toContain("Execution outline");
    expect(markup).toContain("When the lead matches");
    expect(markup).toContain("Otherwise");
    expect(markup.match(/<ol\b/g)).toHaveLength(3);
    expect(markup).toContain("&lt;private search&gt;");
    expect(markup).not.toContain("This saved graph stays read-only");
    expect(
      buttons(markup).find((button) => button.text === "Copy to new workflow draft")!.html,
    ).not.toContain('disabled=""');
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
  it("shows an immutable message reference with unmet sending prerequisites and offers an explicit lossless copy", async () => {
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
    expect(markup).toContain("provider checks remain required");
    expect(markup).not.toContain(`value="${designId}"`);
    expect(
      buttons(markup).find((button) => button.text === "Copy to new workflow draft")!.html,
    ).not.toContain('disabled=""');
    expect(buttons(markup).some((button) => /send|publish/i.test(button.text))).toBe(false);
  });
  it("provides explicit channel-filtered current design controls, bounded pagination and an escaped observed preview", () => {
    const { controller } = setup();
    const design: Schema<"MessageDesign"> = {
      id: designId,
      name: "<Observed & current>",
      channel: "email",
      editor: "native",
      version: 4,
      design: { schemaVersion: 1, blocks: [{ type: "text", text: "Private observed content" }] },
      content: "Private observed content",
      subject: "Observed subject",
    };
    const sms: Schema<"MessageDesign"> = { ...design, id: versionId, channel: "sms", name: "Native SMS" };
    controller.beginDraft();
    controller.add("email");
    controller.add("sms");
    controller.chooseDesign("step_1", { data: design, etag: '"4"' });
    const catalogue: WorkflowDesignCatalogueState = {
      ...unreadCatalogue(),
      phase: "ready",
      page: { items: [design, sms], hasMore: true, nextCursor: "private-design-cursor" },
      preview: { data: design, etag: '"4"' },
      previewNodeKey: "step_1",
    };
    const { markup, actions } = render(controller.getSnapshot(), true, true, catalogue);
    expect(markup).toContain("Email design for step 1");
    expect(markup).toContain("SMS design for step 2");
    expect(markup).toContain("Read next design page");
    expect(markup).toContain("&lt;Observed &amp; current&gt;");
    expect(markup).not.toContain("<Observed");
    expect(markup).toContain("Current design version 4");
    expect(markup).toContain("sending eligibility is not checked");
    expect(markup).toContain("Saving verifies the current design and keeps its revision with the workflow");
    expect(markup).not.toContain("client version");
    expect(markup).not.toContain("private-design-cursor");
    const selects = [...markup.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map((match) => match[0]);
    expect(
      selects.find((select) =>
        select.includes(`id="${Array.from(markup.matchAll(/<label for="([^"]+)">Email design/g))[0][1]}"`),
      ),
    ).not.toContain(`value="${versionId}"`);
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
    const offline = render(controller.getSnapshot(), true, false, catalogue).markup;
    expect(offline).not.toContain("Private observed content");
    expect(offline).not.toContain("<Observed");
    expect(offline).not.toContain("Read next design page");
    expect(offline).toContain("Draft design reference");
    disabled(offline, "Add email step");
    disabled(offline, "Add SMS step");
  });
  it("rechecks the exact existing design through an explicit button and keeps protected/offline verification disabled", async () => {
    const { controller, client } = setup();
    const design: Schema<"MessageDesign"> = {
      id: designId,
      name: "Current email",
      channel: "email",
      editor: "native",
      version: 4,
      design: { schemaVersion: 1, blocks: [{ type: "text", text: "Current text" }] },
      content: "Current text",
    };
    const catalogue: WorkflowDesignCatalogueState = {
      ...unreadCatalogue(),
      phase: "ready",
      page: { items: [design], hasMore: false, nextCursor: null },
      nodeError: { nodeKey: "step_1", message: "Current source could not be verified." },
    };
    controller.beginDraft();
    controller.add("email");
    controller.chooseDesign("step_1", { data: design, etag: '"4"' });
    controller.designUnavailable("step_1", designId);
    const node = controller.getSnapshot().draft!.nodes[0];
    const onCheck = vi.fn();
    const control = WorkflowDesignCheckButton({ node, step: 1, disabled: false, onCheck });
    expect(control).not.toBeNull();
    control!.props.onClick();
    expect(onCheck).toHaveBeenCalledExactlyOnceWith("step_1", designId, "email");
    expect(controller.getSnapshot().draft!.nodes[0].messageDesignId).toBe(designId);
    expect(controller.getSnapshot().issues.some((issue) => issue.field === "nodes.0.messageDesignId")).toBe(
      true,
    );
    const markup = render(controller.getSnapshot(), true, true, catalogue).markup;
    expect(
      buttons(markup).find((button) => button.text === "Check current design for step 1")!.html,
    ).not.toContain('disabled=""');
    expect(markup).toContain("Current source could not be verified");
    disabled(
      render(controller.getSnapshot(), true, true, { ...catalogue, reading: true }).markup,
      "Check current design for step 1",
    );
    expect(render(controller.getSnapshot(), true, false, catalogue).markup).not.toContain(
      "Check current design for step 1",
    );
    expect(render(controller.getSnapshot(), true, true, unreadCatalogue()).markup).not.toContain(
      "Check current design for step 1",
    );
    controller.chooseDesign("step_1", { data: design, etag: '"4"' });
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const original = controller.getSnapshot().pending;
    disabled(
      render(controller.getSnapshot(), true, true, catalogue).markup,
      "Check current design for step 1",
    );
    const locked = WorkflowDesignCheckButton({ node, step: 1, disabled: true, onCheck });
    locked!.props.onClick();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().pending).toEqual(original);
    expect(
      WorkflowDesignCheckButton({
        node: { key: "task", kind: "task", taskTitle: "Task" },
        step: 1,
        disabled: false,
        onCheck,
      }),
    ).toBeNull();
  });
  it("keeps new saves disabled during source verification while allowing an unchanged unknown command retry", async () => {
    const { controller, client } = setup();
    controller.beginDraft();
    controller.add("task");
    controller.editNode("step_1", "Reviewed task");
    const catalogue = { ...unreadCatalogue(), reading: true };
    disabled(render(controller.getSnapshot(), true, true, catalogue).markup, "Save immutable workflow draft");
    client.create.mockRejectedValueOnce(new Error("unknown"));
    await controller.save();
    const markup = render(controller.getSnapshot(), true, true, catalogue).markup;
    expect(
      buttons(markup).find((button) => button.text === "Retry original workflow command")!.html,
    ).not.toContain('disabled=""');
    disabled(markup, "Add email step");
    disabled(markup, "Add SMS step");
    expect(markup).not.toContain("private-key-never-render");
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

describe("ADR-050 condition branch authoring presentation", () => {
  const stageId = "c3000000-0000-4000-8000-0000000000a1",
    savedSourceId = "c3000000-0000-4000-8000-0000000000a2",
    tagId = "c3000000-0000-4000-8000-0000000000a3",
    memberId = "c3000000-0000-4000-8000-0000000000a4";
  const ready = {
    online: true,
    reading: false,
    phase: "ready" as const,
    stages: [{ id: stageId, label: "<Synthetic stage>" }],
    sources: [],
    tags: [{ id: tagId, label: "Synthetic tag" }],
    tagCursor: "private-tag-cursor",
    error: "",
  };
  function view(state: CampaignWorkflowState, options: { member?: string } = {}) {
    const actions = {
      refresh: vi.fn(),
      next: vi.fn(),
      select: vi.fn(),
      begin: vi.fn(),
      copy: vi.fn(),
      add: vi.fn(),
      condition: vi.fn(),
      moreTags: vi.fn(),
      refreshDesigns: vi.fn(),
      nextDesigns: vi.fn(),
      chooseDesign: vi.fn(),
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
    return renderToStaticMarkup(
      <CampaignWorkflowView
        state={state}
        catalogue={unreadCatalogue()}
        active
        online
        actions={actions}
        conditions={ready}
        memberId={options.member}
      />,
    );
  }

  it("renders labelled condition fields, nested branch lists and branch-specific add buttons", () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("condition");
    controller.add("task", { parent: "step_1", branch: "true" });
    controller.add("wait");
    controller.editNode("step_2", "Synthetic follow-up");
    controller.editCondition("step_1", "stageId", stageId);
    controller.editCondition("step_1", "sourceId", savedSourceId);
    controller.editCondition("step_1", "tagIds", [tagId]);
    const markup = view(controller.getSnapshot(), { member: memberId });
    expect(markup.match(/<ol\b/g)).toHaveLength(2);
    expect(markup).toContain("Lead intent for condition step 1");
    expect(markup).toContain("Pipeline stage for condition step 1");
    expect(markup).toContain("Lead source for condition step 1");
    expect(markup).toContain("Tags for condition step 1");
    expect(markup).toContain("Lead name contains (condition step 1)");
    expect(markup).toContain("Only leads assigned to me");
    expect(markup).toContain("&lt;Synthetic stage&gt;");
    expect(markup).toContain("Saved reference (not in the current list)");
    expect(markup).toContain("Read more tag choices");
    expect(markup).not.toContain("private-tag-cursor");
    expect(markup).toContain("Task title for step 2");
    expect(markup).toContain("Wait delay in seconds for step 3");
    expect(markup).toContain('aria-label="Add task step to the matching branch of step 1"');
    expect(markup).toContain('aria-label="Add condition to the otherwise branch of step 1"');
    expect(markup).toContain("No steps in this branch");
    expect(markup).toContain("Add condition");
    const labels = Array.from(markup.matchAll(/<label for="([^"]+)">/g), (match) => match[1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(markup).toContain(`id="${label}"`);
    expect(controller.getSnapshot().issues).toEqual([]);
  });

  it("offers no owner predicate without a verified member and labels a foreign saved owner", () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("condition");
    controller.add("task", { parent: "step_1", branch: "true" });
    controller.add("task", { parent: "step_1", branch: "false" });
    controller.editCondition("step_1", "intent", "buyer");
    expect(view(controller.getSnapshot())).not.toContain("assigned to me");
    controller.editCondition("step_1", "ownerMemberId", "c3000000-0000-4000-8000-0000000000ff");
    const markup = view(controller.getSnapshot(), { member: memberId });
    expect(markup).toContain("Saved owner reference (clear to remove)");
  });

  it("names the condition in readable structural errors", () => {
    const { controller } = setup();
    controller.beginDraft();
    controller.add("condition");
    const markup = view(controller.getSnapshot());
    expect(markup).toContain("Step 1 definition");
    expect(markup).toContain("Add a step to at least one branch of this condition.");
    expect(markup).toContain("Step 1 condition");
    disabled(markup, "Save immutable workflow draft");
  });

  it("keeps an unstructured saved graph read-only with its stored edges", async () => {
    const { controller, client } = setup();
    const graph: Schema<"CampaignVersionWrite"> = {
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
    client.detail.mockResolvedValueOnce({ data: { ...version(), definition: graph }, etag: '"3"' });
    await controller.select(versionId);
    const markup = render(controller.getSnapshot()).markup;
    expect(markup).toContain("Stored graph nodes");
    expect(markup).toContain("true → a");
    expect(markup).toContain("This saved graph stays read-only");
    disabled(markup, "Copy to new workflow draft");
  });
});
