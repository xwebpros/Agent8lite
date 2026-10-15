import { describe, expect, it, vi } from "vitest";
import { previewWorkflow, validateWorkflowDefinition } from "../../packages/marketing";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
} from "../../apps/web/components/campaign-workflow-controller";
import {
  conditionTagLimit,
  requireSourceChoices,
  requireStageChoices,
  requireTagPage,
  WorkflowConditionCatalogue,
  type WorkflowConditionCatalogueClient,
} from "../../apps/web/components/campaign-workflow-condition-catalogue";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const campaignId = "c4000000-0000-4000-8000-000000000001";
const id = (n: number) => `c4000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function setup() {
  let keys = 0;
  const client = {
    list: vi.fn<CampaignWorkflowClient["list"]>(),
    detail: vi.fn<CampaignWorkflowClient["detail"]>(),
    create: vi.fn<CampaignWorkflowClient["create"]>(async (command) => ({
      data: { id: id(900), campaignId, version: 2, state: "draft", definition: command.body },
      etag: '"2"',
    })),
  };
  const controller = new CampaignWorkflowController({
    binding: "condition-binding",
    campaignId,
    client,
    online: true,
    canRead: true,
    canWrite: true,
    createKey: () => `condition-key-${++keys}`,
    validate: validateWorkflowDefinition,
    preview: previewWorkflow,
  });
  controller.beginDraft();
  return { controller, client };
}

describe("controller condition authoring", () => {
  it("authors a branched draft, previews either branch and saves the exact serialized graph", async () => {
    const { controller, client } = setup();
    expect(controller.add("wait")).toBe(true);
    expect(controller.add("condition")).toBe(true);
    expect(controller.add("task", { parent: "step_2", branch: "true" })).toBe(true);
    expect(controller.editNode("step_3", "Synthetic follow-up")).toBe(true);
    expect(controller.add("wait", { parent: "step_2", branch: "false" })).toBe(true);
    expect(controller.add("task")).toBe(true);
    expect(controller.editNode("step_5", "Synthetic after")).toBe(true);
    expect(controller.editCondition("step_2", "intent", "seller")).toBe(true);
    expect(controller.getSnapshot().issues).toEqual([]);
    const draft = controller.getSnapshot().draft!;
    expect(draft.edges).toEqual([
      { from: "step_1", to: "step_2", branch: "always" },
      { from: "step_2", to: "step_3", branch: "true" },
      { from: "step_2", to: "step_4", branch: "false" },
      { from: "step_3", to: "step_5", branch: "always" },
      { from: "step_4", to: "step_5", branch: "always" },
    ]);
    expect(controller.setChoice("step_2", false)).toBe(true);
    expect(controller.preview()).toBe(true);
    expect(controller.getSnapshot().preview!.map((step) => step.nodeKey)).toEqual([
      "step_1",
      "step_2",
      "step_4",
      "step_5",
    ]);
    await controller.save();
    expect(client.create).toHaveBeenCalledOnce();
    expect(client.create.mock.calls[0][0].body).toEqual(draft);
    expect(controller.getSnapshot().phase).toBe("acknowledged");
    expect(controller.getSnapshot().outline).toBeNull();
  });

  it("sets and clears each allowlisted predicate and rejects invalid values without changing the draft", () => {
    const { controller } = setup();
    controller.add("condition");
    const condition = () => controller.getSnapshot().draft!.nodes[0].condition;
    expect(condition()).toEqual({});
    expect(controller.getSnapshot().issues.map((issue) => issue.field)).toContain("nodes.0.condition");
    controller.editCondition("step_1", "stageId", id(1));
    controller.editCondition("step_1", "sourceId", id(2));
    controller.editCondition("step_1", "ownerMemberId", id(3));
    controller.editCondition("step_1", "tagIds", [id(4), id(5)]);
    controller.editCondition("step_1", "q", "Synthetic");
    controller.editCondition("step_1", "intent", "both");
    expect(condition()).toEqual({
      stageId: id(1),
      sourceId: id(2),
      ownerMemberId: id(3),
      tagIds: [id(4), id(5)],
      q: "Synthetic",
      intent: "both",
    });
    const before = controller.getSnapshot().draft;
    expect(controller.editCondition("step_1", "intent", "investor")).toBe(false);
    expect(
      controller.editCondition(
        "step_1",
        "tagIds",
        Array.from({ length: 21 }, (_, n) => id(10 + n)),
      ),
    ).toBe(false);
    expect(controller.editCondition("step_1", "q", "x".repeat(201))).toBe(false);
    expect(controller.editCondition("step_1", "unknown" as never, "x")).toBe(false);
    expect(controller.editCondition("missing", "q", "x")).toBe(false);
    expect(controller.getSnapshot().draft).toBe(before);
    for (const field of ["stageId", "sourceId", "ownerMemberId", "tagIds", "q", "intent"] as const)
      controller.editCondition("step_1", field, field === "tagIds" ? [] : "");
    expect(condition()).toEqual({});
  });

  it("refuses predicate edits on other node kinds and while not editing", async () => {
    const { controller } = setup();
    controller.add("wait");
    expect(controller.editCondition("step_1", "q", "x")).toBe(false);
    controller.discard();
    expect(controller.editCondition("step_1", "q", "x")).toBe(false);
  });

  it("limits nesting depth and rejects unknown branch targets", () => {
    const { controller } = setup();
    expect(controller.add("condition")).toBe(true);
    expect(controller.add("condition", { parent: "step_1", branch: "true" })).toBe(true);
    expect(controller.add("condition", { parent: "step_2", branch: "false" })).toBe(true);
    expect(controller.add("condition", { parent: "step_3", branch: "true" })).toBe(false);
    expect(controller.getSnapshot().error).toContain("three levels");
    expect(controller.add("wait", { parent: "step_3", branch: "true" })).toBe(true);
    expect(controller.add("wait", { parent: "step_4", branch: "true" })).toBe(false);
    expect(controller.add("wait", { parent: "missing", branch: "true" })).toBe(false);
  });

  it("removes a condition only after its branches are emptied and moves within one list", () => {
    const { controller } = setup();
    controller.add("condition");
    controller.add("task", { parent: "step_1", branch: "true" });
    controller.add("wait", { parent: "step_1", branch: "true" });
    controller.add("task");
    expect(controller.remove("step_1")).toBe(false);
    expect(controller.getSnapshot().error).toContain("before removing this condition");
    expect(controller.move("step_3", -1)).toBe(true);
    expect(controller.move("step_3", -1)).toBe(false);
    expect(controller.move("step_1", 1)).toBe(true);
    expect(controller.getSnapshot().draft!.nodes.map((node) => node.key)).toEqual([
      "step_4",
      "step_1",
      "step_3",
      "step_2",
    ]);
    expect(controller.remove("step_3")).toBe(true);
    expect(controller.remove("step_2")).toBe(true);
    expect(controller.remove("step_1")).toBe(true);
    expect(controller.getSnapshot().draft!.nodes.map((node) => node.key)).toEqual(["step_4"]);
  });

  it("clears the outline with private memory on revoke and on leaving the editor", () => {
    const { controller } = setup();
    controller.add("condition");
    controller.detach();
    expect(controller.getSnapshot().outline).toBeNull();
    const second = setup().controller;
    second.add("condition");
    second.revoke();
    expect(second.getSnapshot().outline).toBeNull();
    expect(second.getSnapshot().draft).toBeNull();
  });
});

describe("condition reference catalogue", () => {
  const stagePage = (): Schema<"PagePipelineStage"> => ({
    items: [
      { id: id(21), name: "Later", position: 2, terminal: false, version: 1 },
      { id: id(20), name: "First", position: 0, terminal: false, version: 1 },
    ],
    nextCursor: null,
    hasMore: false,
  });
  const sourcePage = (): Schema<"PageLeadSource"> => ({
    items: [{ id: id(30), code: "web", label: "Synthetic web", version: 1 }],
    nextCursor: null,
    hasMore: false,
  });
  const tagPage = (start: number, count: number, next: string | null): Schema<"PageTag"> => ({
    items: Array.from({ length: count }, (_, n) => ({
      id: id(start + n),
      name: `Tag ${start + n}`,
      version: 1,
    })),
    nextCursor: next,
    hasMore: Boolean(next),
  });
  function catalogue(
    client: Partial<WorkflowConditionCatalogueClient>,
    permitted = { stages: true, sources: true, tags: true },
  ) {
    const lost = vi.fn();
    let current = true;
    const value = new WorkflowConditionCatalogue({
      online: true,
      permitted,
      client: {
        stages: client.stages ?? (async () => stagePage()),
        sources: client.sources ?? (async () => sourcePage()),
        tags: client.tags ?? (async () => tagPage(100, 2, null)),
      },
      isCurrent: () => current,
      onAuthorityLost: lost,
    });
    value.attach();
    return { value, lost, setCurrent: (next: boolean) => (current = next) };
  }

  it("verifies closed pages, orders stages by position and rejects repeated identities", () => {
    expect(requireStageChoices(stagePage()).map((choice) => choice.label)).toEqual(["First", "Later"]);
    expect(requireSourceChoices(sourcePage())).toEqual([{ id: id(30), label: "Synthetic web" }]);
    expect(() => requireStageChoices({ ...stagePage(), extra: true })).toThrow();
    expect(() => requireSourceChoices({ ...sourcePage(), hasMore: true, nextCursor: null })).toThrow();
    const repeated = tagPage(100, 1, null);
    repeated.items.push({ ...repeated.items[0], id: repeated.items[0].id.toUpperCase() });
    expect(() => requireTagPage(repeated)).toThrow();
  });

  it("reads only permitted lists and leaves other lists unavailable", async () => {
    const stages = vi.fn(async () => stagePage());
    const { value } = catalogue({ stages }, { stages: false, sources: true, tags: true });
    await value.load();
    expect(stages).not.toHaveBeenCalled();
    expect(value.getSnapshot().stages).toBeNull();
    expect(value.getSnapshot().sources).toHaveLength(1);
    expect(value.getSnapshot().phase).toBe("ready");
  });

  it("treats 403 on one list as unavailable but 401 as lost workflow access", async () => {
    const partial = catalogue({
      tags: async () => Promise.reject(new ApiError(403, "private", "forbidden")),
    });
    await partial.value.load();
    expect(partial.value.getSnapshot().tags).toBeNull();
    expect(partial.value.getSnapshot().stages).toHaveLength(2);
    expect(partial.value.getSnapshot().error).toContain("could not be verified");
    expect(partial.lost).not.toHaveBeenCalled();
    const denied = catalogue({ sources: async () => Promise.reject(new ApiError(401, "private")) });
    await denied.value.load();
    expect(denied.lost).toHaveBeenCalledOnce();
    expect(denied.value.getSnapshot()).toMatchObject({ phase: "denied", stages: null, tags: null });
    await denied.value.load();
    expect(denied.value.getSnapshot().stages).toBeNull();
  });

  it("drops late results after the context changes or the editor closes", async () => {
    let release!: (value: unknown) => void;
    const { value, setCurrent } = catalogue({ stages: () => new Promise((resolve) => (release = resolve)) });
    const pending = value.load();
    setCurrent(false);
    release(stagePage());
    await pending;
    expect(value.getSnapshot().stages).toBeNull();
    setCurrent(true);
    const second = catalogue({ stages: () => new Promise((resolve) => (release = resolve)) });
    const late = second.value.load();
    second.value.detach();
    release(stagePage());
    await late;
    expect(second.value.getSnapshot()).toMatchObject({ phase: "unread", stages: null, reading: false });
  });

  it("clears every list when going offline", async () => {
    const { value } = catalogue({});
    await value.load();
    value.setOnline(false);
    expect(value.getSnapshot()).toMatchObject({ online: false, stages: null, sources: null, tags: null });
  });

  it("pages tags only through the server cursor and stops at the bounded total", async () => {
    let page = 0;
    const tags = vi.fn(async (cursor?: string | null) => {
      if (!cursor) return tagPage(1000, 100, "cursor-1");
      page++;
      return tagPage(1000 + page * 100, 100, `cursor-${page + 1}`);
    });
    const { value } = catalogue({ tags });
    await value.load();
    expect(value.getSnapshot().tagCursor).toBe("cursor-1");
    await value.loadMoreTags();
    expect(tags).toHaveBeenLastCalledWith("cursor-1");
    expect(value.getSnapshot().tags).toHaveLength(conditionTagLimit);
    expect(value.getSnapshot().tagCursor).toBeNull();
    await value.loadMoreTags();
    expect(tags).toHaveBeenCalledTimes(2);
  });
});
