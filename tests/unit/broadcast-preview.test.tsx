import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  BroadcastPreviewController,
  type BroadcastPreviewClient,
  type BroadcastPreviewState,
} from "../../apps/web/components/broadcast-preview-controller";
import { BroadcastPreviewView } from "../../apps/web/components/broadcast-preview-panel";
import {
  BroadcastResponseError,
  broadcastIssues,
  readBroadcastResponse,
  requireBroadcastPreview,
  requireBroadcastRequest,
  validBroadcastTimezone,
} from "../../apps/web/components/broadcast-preview-protocol";
import type { WorkflowConditionCatalogueState } from "../../apps/web/components/campaign-workflow-condition-catalogue";
import type { WorkflowDesignCatalogueState } from "../../apps/web/components/campaign-workflow-design-catalogue";
import { ApiError } from "../../apps/web/lib/api";

const designId = "b6000000-0000-4000-8000-000000000001",
  tagId = "b6000000-0000-4000-8000-000000000002",
  previewId = "b6000000-0000-4000-8000-000000000003",
  memberId = "b6000000-0000-4000-8000-000000000004";
const now = Date.parse("2026-10-11T12:00:00.000Z");
const preview = (patch: Record<string, unknown> = {}) => ({
  id: previewId,
  eligible: 4,
  ineligible: 4,
  estimatedRecipients: 2,
  expiresAt: "2026-10-11T12:15:00.000Z",
  ...patch,
});

function setup(client?: Partial<BroadcastPreviewClient>, clock = () => now) {
  let keys = 0;
  const calls: unknown[] = [];
  const revoked = vi.fn();
  const controller = new BroadcastPreviewController({
    binding: "broadcast-binding",
    online: true,
    canPreview: true,
    createKey: () => `broadcast-key-${++keys}`,
    now: clock,
    onAccessRevoked: revoked,
    client: {
      preview:
        client?.preview ??
        (async (command) => {
          calls.push(command);
          return preview();
        }),
    },
  });
  return { controller, calls, revoked, keys: () => keys };
}
function ready(controller: BroadcastPreviewController) {
  controller.chooseDesign(designId);
  controller.editFilter("tagIds", [tagId]);
}

describe("broadcast protocol", () => {
  it("mirrors the server's local validation", () => {
    expect(broadcastIssues({ filter: {}, timezone: "UTC" }).map((issue) => issue.field)).toEqual([
      "messageDesignId",
      "filter",
    ]);
    expect(
      broadcastIssues({ messageDesignId: designId, filter: { q: " " }, timezone: "PST" }).map((i) => i.field),
    ).toEqual(["filter.q", "timezone"]);
    expect(
      broadcastIssues({
        messageDesignId: designId,
        filter: { tagIds: [tagId, tagId.toUpperCase()] },
        timezone: "UTC",
      }).length,
    ).toBe(1);
    expect(validBroadcastTimezone("America/Los_Angeles")).toBe(true);
    expect(validBroadcastTimezone("1America/Los_Angeles")).toBe(false);
    expect(() =>
      requireBroadcastRequest({
        messageDesignId: designId,
        filter: { intent: "buyer" },
        timezone: "UTC",
        x: 1,
      }),
    ).toThrow();
  });

  it("requires a closed, consistent preview receipt", () => {
    expect(requireBroadcastPreview(preview())).toEqual(preview());
    for (const patch of [
      { estimatedRecipients: 5 },
      { eligible: -1 },
      { expiresAt: "not-a-date" },
      { extra: true },
    ])
      expect(() => requireBroadcastPreview(preview(patch))).toThrow();
  });

  it("keeps only known field paths from a problem and never its server text", async () => {
    const problem = {
      type: "https://estate.example/problems/broadcast_invalid",
      title: "PRIVATE server title",
      status: 422,
      code: "broadcast_invalid",
      traceId: "t",
      errors: [
        { field: "filter.q", message: "PRIVATE detail" },
        { field: "nodes.0.condition", message: "ignored" },
      ],
    };
    const error = (await readBroadcastResponse(new Response(JSON.stringify(problem), { status: 422 })).catch(
      (failure: unknown) => failure,
    )) as BroadcastResponseError;
    expect(error).toBeInstanceOf(BroadcastResponseError);
    expect(error.issues).toEqual([{ field: "filter.q", message: "This field could not be accepted." }]);
    expect(JSON.stringify(error.issues)).not.toContain("PRIVATE");
  });
});

describe("broadcast controller", () => {
  it("sends one immutable request with a key and shows a verified result", async () => {
    const { controller, calls } = setup();
    ready(controller);
    await controller.preview();
    expect(calls).toEqual([
      {
        binding: "broadcast-binding",
        idempotencyKey: "broadcast-key-1",
        body: { messageDesignId: designId, filter: { tagIds: [tagId] }, timezone: "UTC" },
      },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ phase: "ready", pending: null, result: preview() });
  });

  it("blocks invalid drafts locally without a request", async () => {
    const { controller, calls } = setup();
    await controller.preview();
    expect(calls).toHaveLength(0);
    expect(controller.getSnapshot().issues.map((issue) => issue.field)).toEqual([
      "messageDesignId",
      "filter",
    ]);
  });

  it("keeps the exact request and key after an unknown outcome and retries them unchanged", async () => {
    const sent: unknown[] = [];
    let fail = true;
    const { controller, keys } = setup({
      preview: async (command) => {
        sent.push(command);
        if (fail) throw new TypeError("network");
        return preview();
      },
    });
    ready(controller);
    await controller.preview();
    expect(controller.getSnapshot().phase).toBe("unknown");
    expect(controller.editFilter("intent", "seller")).toBe(false);
    fail = false;
    await controller.preview();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(keys()).toBe(1);
    expect(controller.getSnapshot().phase).toBe("ready");
  });

  it("lets the person abandon an unknown preview and edit, because nothing was sent", async () => {
    const { controller } = setup({ preview: async () => Promise.reject(new TypeError("network")) });
    ready(controller);
    await controller.preview();
    expect(controller.discardUnknown()).toBe(true);
    expect(controller.editFilter("intent", "buyer")).toBe(true);
  });

  it.each([
    [new ApiError(422, "x", "broadcast_audience_too_large"), "rejected", "more than 5,000 leads"],
    [
      new BroadcastResponseError(422, "workflow_reference_unavailable", [
        { field: "filter.tagIds.0", message: "m" },
      ]),
      "rejected",
      "unavailable",
    ],
    [new ApiError(403, "x", "permission_denied"), "denied", "Organization-wide"],
    [new ApiError(403, "x", "entitlement_disabled"), "unavailable", "Marketing capability"],
  ] as const)("maps a definitive %s", async (error, phase, text) => {
    const { controller } = setup({ preview: async () => Promise.reject(error) });
    ready(controller);
    await controller.preview();
    expect(controller.getSnapshot()).toMatchObject({ phase, pending: null, result: null });
    expect(controller.getSnapshot().error).toContain(text);
  });

  it("clears private segment data and notifies on 401", async () => {
    const { controller, revoked } = setup({ preview: async () => Promise.reject(new ApiError(401, "x")) });
    ready(controller);
    await controller.preview();
    expect(revoked).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({ phase: "denied", draft: { filter: {} }, pending: null });
  });

  it("hides results offline, when hidden and at expiry, and drops late responses after revoke", async () => {
    let clock = now;
    const { controller } = setup(undefined, () => clock);
    ready(controller);
    await controller.preview();
    controller.setOnline(false);
    expect(controller.getSnapshot().result).toBeNull();
    controller.setOnline(true);
    await controller.preview();
    controller.setVisible(false);
    expect(controller.getSnapshot().result).toBeNull();
    controller.setVisible(true);
    await controller.preview();
    clock = Date.parse("2026-10-11T12:15:00.000Z");
    expect(controller.expire()).toBe(true);
    expect(controller.getSnapshot().result).toBeNull();
    let release!: (value: unknown) => void;
    const late = setup({ preview: () => new Promise((resolve) => (release = resolve)) });
    ready(late.controller);
    const pending = late.controller.preview();
    late.controller.revoke();
    release(preview());
    await pending;
    expect(late.controller.getSnapshot()).toMatchObject({ phase: "denied", result: null });
  });

  it("rejects an already-expired receipt instead of showing it", async () => {
    const { controller } = setup(undefined, () => Date.parse("2026-10-11T13:00:00.000Z"));
    ready(controller);
    await controller.preview();
    expect(controller.getSnapshot().result).toBeNull();
    expect(controller.getSnapshot().error).toContain("expired");
  });
});

describe("broadcast panel", () => {
  const designs: WorkflowDesignCatalogueState = {
    online: true,
    reading: false,
    page: null,
    preview: null,
    previewNodeKey: null,
    phase: "unread",
    error: "",
    nodeError: null,
  };
  const conditions: WorkflowConditionCatalogueState = {
    online: true,
    reading: false,
    phase: "ready",
    stages: [{ id: "b6000000-0000-4000-8000-000000000010", label: "<Synthetic stage>" }],
    sources: [],
    tags: [{ id: tagId, label: "Synthetic tag" }],
    tagCursor: null,
    error: "",
  };
  const actions = () => ({
    design: vi.fn(),
    filter: vi.fn(),
    timezone: vi.fn(),
    scheduledAt: vi.fn(),
    preview: vi.fn(),
    discardUnknown: vi.fn(),
    refreshChoices: vi.fn(),
    moreTags: vi.fn(),
  });
  const render = (state: BroadcastPreviewState, member?: string) =>
    renderToStaticMarkup(
      <BroadcastPreviewView
        state={state}
        designs={designs}
        conditions={conditions}
        memberId={member}
        actions={actions()}
      />,
    );

  it("renders labelled segment fields, counts and no send control", async () => {
    const { controller } = setup();
    ready(controller);
    await controller.preview();
    const markup = render(controller.getSnapshot(), memberId);
    for (const label of [
      "Message design",
      "Lead intent",
      "Pipeline stage",
      "Lead source",
      "Lead name contains",
      "Timezone",
    ])
      expect(markup).toContain(label);
    expect(markup).toContain("Only leads assigned to me");
    expect(markup).toContain("&lt;Synthetic stage&gt;");
    expect(markup).toContain("Eligible leads");
    expect(markup).toContain("Estimated recipients");
    expect(markup).toContain("No message was sent or scheduled.");
    expect(markup).not.toContain("broadcast-key");
    expect(markup).not.toMatch(/<button[^>]*>[^<]*(Send|Confirm|Schedule)/i);
    const labels = Array.from(markup.matchAll(/<label for="([^"]+)">/g), (match) => match[1]);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(markup).toContain(`id="${label}"`);
  });

  it("shows retry wording for an unknown outcome and no owner predicate without a member", async () => {
    const { controller } = setup({ preview: async () => Promise.reject(new TypeError("network")) });
    ready(controller);
    await controller.preview();
    const markup = render(controller.getSnapshot());
    expect(markup).toContain("Retry this preview");
    expect(markup).toContain("Edit the segment instead");
    expect(markup).not.toContain("assigned to me");
  });

  it("explains missing permission instead of rendering the form", () => {
    const controller = new BroadcastPreviewController({
      binding: "b",
      online: true,
      canPreview: false,
      createKey: () => "k",
      client: { preview: async () => preview() },
    });
    expect(render(controller.getSnapshot())).toContain("Organization-wide broadcast permission is required");
  });
});
