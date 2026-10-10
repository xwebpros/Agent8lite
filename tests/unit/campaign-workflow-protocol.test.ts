import { describe, expect, it, vi } from "vitest";
import {
  copyWorkflowJson,
  isWorkflowId,
  readWorkflowJsonResponse,
  requireWorkflowPage,
  requireWorkflowVersion,
  workflowLinearDefinition,
  workflowLinearOrder,
  workflowContextBinding,
  workflowDefinitionJson,
  WorkflowResponseError,
} from "../../apps/web/components/campaign-workflow-protocol";
import { ApiError, type Schema } from "../../apps/web/lib/api";
import { requestWorkflowJson } from "../../apps/web/components/campaign-workflow-request";

const campaignId = "c1000000-0000-4000-8000-000000000001";
const versionId = "c1000000-0000-4000-8000-000000000002";
const otherId = "c1000000-0000-4000-8000-000000000003";
const chain = (): Schema<"CampaignVersionWrite"> => ({
  nodes: [
    { key: "first", kind: "wait", delaySeconds: 60 },
    { key: "second", kind: "task", taskTitle: "Private task" },
  ],
  edges: [{ from: "first", to: "second", branch: "always" }],
  timezone: "UTC",
  quietHours: { start: "22:00", end: "07:00" },
});
const version = (sequence = 1): Schema<"CampaignVersion"> => ({
  id: versionId,
  campaignId,
  version: sequence,
  state: "draft",
  definition: chain(),
});
const page = (): Schema<"PageCampaignVersion"> => ({ items: [version()], nextCursor: null, hasMore: false });
const sourceMessage = "This source is unavailable or incompatible with the workflow.";
const problem = (code: string, errors: NonNullable<Schema<"Problem">["errors"]>): Schema<"Problem"> => ({
  type: "about:blank",
  title: "Private internal title",
  detail: "Private internal detail",
  status: 422,
  code,
  traceId: "safe-trace",
  errors,
});

describe("closed immutable workflow transport", () => {
  it("checks the exact parent, version identity and strong sequence ETag", () => {
    expect(requireWorkflowVersion(version(2), campaignId, '"2"', versionId).data.version).toBe(2);
    for (const etag of ['"1"', 'W/"2"', "2", '"02"', '"9007199254740992"'])
      expect(() => requireWorkflowVersion(version(2), campaignId, etag)).toThrow();
    expect(() => requireWorkflowVersion(version(), otherId, '"1"')).toThrow();
    expect(() => requireWorkflowVersion(version(), campaignId, '"1"', otherId)).toThrow();
    expect(() => requireWorkflowVersion({ ...version(), extra: "private" }, campaignId, '"1"')).toThrow();
    expect(() =>
      requireWorkflowVersion(
        { ...version(), definition: { ...chain(), code: "executable" } },
        campaignId,
        '"1"',
      ),
    ).toThrow();
  });
  it("rejects duplicate IDs/sequences, foreign parents and contradictory cursors without truncating pages", () => {
    expect(requireWorkflowPage(page(), campaignId).items[0].id).toBe(versionId);
    for (const value of [
      { ...page(), items: [version(), { ...version(), id: otherId }] },
      { ...page(), items: [version(), version(2)] },
      { ...page(), items: [{ ...version(), campaignId: otherId }] },
      { ...page(), hasMore: true },
      { ...page(), nextCursor: "opaque" },
      { items: [], nextCursor: "opaque", hasMore: true },
      { ...page(), total: 4 },
    ])
      expect(() => requireWorkflowPage(value, campaignId)).toThrow();
  });
  it("rejects unsafe private object graphs without executing accessors or inherited toJSON", () => {
    const getter = vi.fn(() => "secret");
    const object = Object.defineProperty({}, "definition", { get: getter, enumerable: true });
    expect(() => copyWorkflowJson(object)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = null;
    for (const value of [cycle, sparse, Object.create({ privateValue: true }), { value: "x".repeat(262145) }])
      expect(() => copyWorkflowJson(value)).toThrow();
    const hook = vi.fn(() => ({ nodes: [] }));
    const objectHook = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
      arrayHook = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      Object.defineProperty(Object.prototype, "toJSON", { value: hook, configurable: true });
      Object.defineProperty(Array.prototype, "toJSON", { value: hook, configurable: true });
      const cloned = copyWorkflowJson(chain());
      expect(cloned.nodes[1].taskTitle).toBe("Private task");
      expect(workflowDefinitionJson(chain())).toContain('"taskTitle":"Private task"');
      expect(workflowContextBinding([campaignId, "csrf", true, 2])).toBe(`["${campaignId}","csrf",true,2]`);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      if (objectHook) Object.defineProperty(Object.prototype, "toJSON", objectHook);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (arrayHook) Object.defineProperty(Array.prototype, "toJSON", arrayHook);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });
  it("uses actual streamed UTF-8 bytes rather than Content-Length and cancels oversize chunks", async () => {
    expect(
      await readWorkflowJsonResponse(
        new Response(`${" ".repeat(1048574)}{}`, { headers: { "Content-Length": "1" } }),
      ),
    ).toEqual({});
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1048576));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(readWorkflowJsonResponse(new Response(stream))).rejects.toThrow("1 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("preserves status and bounded platform code on failures without displaying problem detail", async () => {
    await expect(
      readWorkflowJsonResponse(
        new Response('{"code":"entitlement_disabled","detail":"private recipient"}', { status: 403 }),
      ),
    ).rejects.toMatchObject({ status: 403, code: "entitlement_disabled" });
    const error = await readWorkflowJsonResponse(new Response("malformed", { status: 401 })).catch(
      (reason: Error) => reason,
    );
    expect(error).toMatchObject({ status: 401 });
    expect((error as Error).message).not.toContain("recipient");
    await expect(readWorkflowJsonResponse(new Response(new Uint8Array([0xc3, 0x28])))).rejects.toThrow(
      "UTF-8",
    );
    await expect(
      readWorkflowJsonResponse(new Response(" ".repeat(1048577), { status: 403 })),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("accepts only a frozen UUID as a workflow request path reference", () => {
    expect(isWorkflowId(versionId)).toBe(true);
    expect(isWorkflowId("../another-route")).toBe(false);
  });
  it("projects only recognized source codes, exact platform messages and bounded closed node paths", async () => {
    const body = problem("design_unavailable", [
      { field: "nodes.0.messageDesignId", message: sourceMessage },
    ]);
    const error = await readWorkflowJsonResponse(new Response(JSON.stringify(body), { status: 422 })).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(WorkflowResponseError);
    expect(error).toMatchObject({ status: 422, issues: body.errors });
    expect((error as ApiError).message).not.toContain("Private");
    expect(Object.isFrozen((error as WorkflowResponseError).issues)).toBe(true);
    const mismatched = await readWorkflowJsonResponse(
      new Response(JSON.stringify(body), { status: 422 }),
      chain(),
    ).catch((reason: unknown) => reason);
    expect(mismatched).not.toBeInstanceOf(WorkflowResponseError);
    const messageDefinition: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      nodes: [{ key: "email", kind: "email", messageDesignId: otherId }],
      edges: [],
    };
    await expect(
      readWorkflowJsonResponse(new Response(JSON.stringify(body), { status: 422 }), messageDefinition),
    ).rejects.toMatchObject({ issues: body.errors });
    for (const value of [
      { ...body, code: "unknown_provider_error" },
      { ...body, status: 409 },
      { ...body, undocumented: true },
      problem("design_unavailable", [{ field: "nodes.0.messageDesignId", message: "Private customer text" }]),
      problem("design_unavailable", [{ field: "nodes.100.messageDesignId", message: sourceMessage }]),
      problem("design_unavailable", [{ field: "customer.privateField", message: sourceMessage }]),
      problem("design_unavailable", [{ field: "nodes.0.condition.sourceId", message: sourceMessage }]),
      problem(
        "design_unavailable",
        Array.from({ length: 101 }, () => ({ field: "nodes.0.messageDesignId", message: sourceMessage })),
      ),
      problem("design_unavailable", [{ field: "nodes.0.messageDesignId", message: "x".repeat(301) }]),
    ]) {
      const failure = await readWorkflowJsonResponse(
        new Response(JSON.stringify(value), { status: 422 }),
      ).catch((reason: unknown) => reason);
      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).not.toBeInstanceOf(WorkflowResponseError);
      expect((failure as ApiError).message).not.toContain("Private");
    }
  });
  it("accepts shared-validator errors only when they match the exact original definition", async () => {
    const invalid = {
      ...chain(),
      nodes: [{ key: "wait", kind: "wait" }],
    } satisfies Schema<"CampaignVersionWrite">;
    const errors = [
      {
        field: "nodes.0.delaySeconds",
        message: "Wait delay must be an integer between 0 and 31536000 seconds.",
      },
    ];
    const response = () => new Response(JSON.stringify(problem("workflow_invalid", errors)), { status: 422 });
    await expect(readWorkflowJsonResponse(response(), invalid)).rejects.toMatchObject({ issues: errors });
    const unmatched = await readWorkflowJsonResponse(response(), chain()).catch((reason: unknown) => reason);
    expect(unmatched).not.toBeInstanceOf(WorkflowResponseError);
    const extra = problem("workflow_reference_unavailable", [
      { field: "nodes.0.condition.tagIds.19", message: sourceMessage },
    ]);
    await expect(
      readWorkflowJsonResponse(new Response(JSON.stringify(extra), { status: 422 })),
    ).rejects.toMatchObject({ issues: extra.errors });
  });
  it("aborts requests after20seconds without assuming a precommit failure and always releases its timer", async () => {
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
      const result = requestWorkflowJson("/api/v1/workflow-test", 201, {
        method: "POST",
        body: workflowDefinitionJson(chain()),
      }).catch((reason: unknown) => reason);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20000);
      expect(await result).toMatchObject({ name: "AbortError" });
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchSpy.mock.calls[0][1]).toMatchObject({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        method: "POST",
      });
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(version()), { headers: { ETag: '"1"' } }));
      await expect(requestWorkflowJson("/api/v1/workflow-test", 200)).resolves.toMatchObject({ etag: '"1"' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("lossless initial ordered-list adapter", () => {
  it("uses graph links, not node array or UUID order, to recover a linear execution order", () => {
    const graph = chain();
    graph.nodes.reverse();
    expect(workflowLinearOrder(graph)).toEqual(["first", "second"]);
    expect(graph.nodes[0].key).toBe("second");
  });
  it("rewrites only an explicitly edited chain, preserving timezone and quiet-hour metadata", () => {
    const original = chain();
    const edited = workflowLinearDefinition([original.nodes[1], original.nodes[0]], original);
    expect(edited.edges).toEqual([{ from: "second", to: "first", branch: "always" }]);
    expect(edited.quietHours).toEqual(original.quietHours);
    expect(edited.timezone).toBe("UTC");
    expect(original.edges).toEqual([{ from: "first", to: "second", branch: "always" }]);
    expect(Object.isFrozen(edited.nodes)).toBe(true);
  });
  it("keeps unsupported condition/message graphs read-only rather than flattening them", () => {
    for (const graph of [
      {
        ...chain(),
        nodes: [{ key: "condition", kind: "condition", condition: { intent: "buyer" } }],
      } as Schema<"CampaignVersionWrite">,
      {
        ...chain(),
        nodes: [{ key: "email", kind: "email", messageDesignId: otherId }],
      } as Schema<"CampaignVersionWrite">,
      {
        ...chain(),
        edges: [{ from: "first", to: "second", branch: "true" }],
      } as Schema<"CampaignVersionWrite">,
      { ...chain(), edges: [] },
    ])
      expect(workflowLinearOrder(graph)).toBeNull();
    expect(() =>
      workflowLinearDefinition([{ key: "message", kind: "sms", messageDesignId: otherId }], chain()),
    ).toThrow();
    const unsupported: Schema<"CampaignVersionWrite"> = {
      timezone: "UTC",
      nodes: [{ key: "message", kind: "email", messageDesignId: otherId }],
      edges: [],
    };
    expect(() => workflowLinearDefinition(chain().nodes, unsupported)).toThrow();
  });
});
