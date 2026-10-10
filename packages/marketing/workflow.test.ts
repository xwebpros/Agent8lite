import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition, type WorkflowDefinition, type WorkflowNode } from "./index";

const design = "a0000000-0000-4000-8000-000000000001";
const task = (key = "first"): WorkflowNode => ({ key, kind: "task", taskTitle: "Synthetic follow-up" });
const valid = (): WorkflowDefinition => ({ nodes: [task()], edges: [], timezone: "UTC" });
const fields = (value: unknown) =>
  validateWorkflowDefinition(value as WorkflowDefinition).map((issue) => issue.field);
const branched = (): WorkflowDefinition => ({
  nodes: [
    { key: "choose", kind: "condition", condition: { intent: "buyer" } },
    task("yes"),
    task("no"),
    { key: "finish", kind: "wait", delaySeconds: 0 },
  ],
  edges: [
    { from: "choose", to: "yes", branch: "true" },
    { from: "choose", to: "no", branch: "false" },
    { from: "yes", to: "finish", branch: "always" },
    { from: "no", to: "finish", branch: "always" },
  ],
  timezone: "America/Los_Angeles",
  quietHours: { start: "21:30", end: "08:00" },
});

describe("bounded v1 workflow graph semantics", () => {
  it("accepts all five kinds and reconverging explicit branches without requiring a live design", () => {
    const value = branched();
    value.nodes[1] = { key: "yes", kind: "email", messageDesignId: design };
    value.nodes[2] = { key: "no", kind: "sms", messageDesignId: design };
    value.nodes.push(task("task"));
    value.edges.push({ from: "finish", to: "task", branch: "always" });
    expect(validateWorkflowDefinition(value)).toEqual([]);
  });
  it("accepts exactly 100 nodes and the largest allowed elapsed wait", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      key: `step_${index}`,
      kind: "wait" as const,
      delaySeconds: 31536000,
    }));
    const edges = nodes
      .slice(1)
      .map((node, index) => ({ from: nodes[index].key, to: node.key, branch: "always" as const }));
    expect(validateWorkflowDefinition({ nodes, edges, timezone: "UTC" })).toEqual([]);
  });
  it.each([null, [], false, "workflow", 7])("rejects non-object definitions safely %#", (value) => {
    expect(fields(value)).toEqual(["definition"]);
  });
  it.each([[], Array.from({ length: 101 }, (_, index) => task(`step_${index}`)), null])(
    "rejects empty, oversized or absent node arrays %#",
    (nodes) => expect(fields({ ...valid(), nodes })).toContain("nodes"),
  );
  it("bounds edge validation before traversing oversized input", () => {
    const edges = Array.from({ length: 201 }, () => ({ from: "first", to: "first", branch: "always" }));
    expect(fields({ ...valid(), edges })).toEqual(["edges"]);
  });
  it("rejects duplicate keys and unknown edge endpoints", () => {
    expect(fields({ ...valid(), nodes: [task(), task()] })).toContain("nodes.1.key");
    expect(fields({ ...valid(), edges: [{ from: "missing", to: "first", branch: "always" }] })).toContain(
      "edges.0.from",
    );
    expect(fields({ ...valid(), edges: [{ from: "first", to: "missing", branch: "always" }] })).toContain(
      "edges.0.to",
    );
  });
  it("rejects multiple entries, no entry, cycles and a disconnected cycle", () => {
    expect(fields({ ...valid(), nodes: [task(), task("other")] })).toContain("nodes");
    const selfCycle = { ...valid(), edges: [{ from: "first", to: "first", branch: "always" }] };
    expect(fields(selfCycle)).toEqual(expect.arrayContaining(["nodes", "edges"]));
    const disconnected = {
      ...valid(),
      nodes: [task(), task("a"), task("b")],
      edges: [
        { from: "a", to: "b", branch: "always" },
        { from: "b", to: "a", branch: "always" },
      ],
    };
    expect(fields(disconnected)).toEqual(expect.arrayContaining(["nodes.1", "nodes.2", "edges"]));
  });
  it("rejects duplicate edges, ordinary fan-out and condition branches on tasks", () => {
    const value = branched();
    value.edges.push({ ...value.edges[0] });
    expect(fields(value)).toContain("edges.4");
    expect(
      fields({
        ...valid(),
        nodes: [task(), task("a"), task("b")],
        edges: [
          { from: "first", to: "a", branch: "always" },
          { from: "first", to: "b", branch: "always" },
        ],
      }),
    ).toContain("nodes.0");
    expect(
      fields({ ...valid(), nodes: [task(), task("a")], edges: [{ from: "first", to: "a", branch: "true" }] }),
    ).toContain("edges.0.branch");
  });
  it.each(["missing_false", "both_true", "same_target", "always", "terminal"])(
    "rejects ambiguous condition graph %s",
    (fault) => {
      const value = branched();
      if (fault === "missing_false") value.edges.splice(1, 1);
      if (fault === "both_true") value.edges[1].branch = "true";
      if (fault === "same_target") value.edges[1].to = "yes";
      if (fault === "always") value.edges[0].branch = "always";
      if (fault === "terminal") value.edges = [];
      expect(fields(value)).toContain("nodes.0");
    },
  );
  it.each([
    { key: "first", kind: "wait" },
    { key: "first", kind: "wait", delaySeconds: -1 },
    { key: "first", kind: "wait", delaySeconds: 1.5 },
    { key: "first", kind: "wait", delaySeconds: 31536001 },
    { key: "first", kind: "email" },
    { key: "first", kind: "sms", messageDesignId: "not-a-design" },
    { key: "first", kind: "task", taskTitle: " " },
    { key: "first", kind: "task", taskTitle: "a".repeat(201) },
    { key: "first", kind: "condition" },
    { key: "first", kind: "condition", condition: {} },
  ])("requires kind-specific values %#", (node) => {
    expect(fields({ ...valid(), nodes: [node] }).some((field) => field.startsWith("nodes.0."))).toBe(true);
  });
  it.each(["wait", "email", "sms", "task", "condition"])("rejects inappropriate fields on %s", (kind) => {
    const node = {
      key: "first",
      kind,
      delaySeconds: 0,
      messageDesignId: design,
      taskTitle: "Safe",
      condition: { intent: "buyer" },
    };
    expect(fields({ ...valid(), nodes: [node] })).toContain("nodes.0");
  });
  it.each([
    { script: "globalThis.send()" },
    { q: " " },
    { tagIds: [] },
    { tagIds: [design, design.toUpperCase()] },
    { stageId: "bad" },
    { sourceId: null },
    { ownerMemberId: [] },
    { intent: ["buyer"] },
    { intent: "investor" },
    { q: "q".repeat(201) },
    { tagIds: Array.from({ length: 21 }, () => design) },
  ])("rejects unrestricted or malformed lead-filter conditions %#", (condition) => {
    const value = branched();
    value.nodes[0].condition = condition as WorkflowNode["condition"];
    expect(fields(value).some((field) => field.startsWith("nodes.0.condition"))).toBe(true);
  });
  it("accepts all frozen lead-filter predicates as data without evaluating them", () => {
    const value = branched();
    value.nodes[0].condition = {
      stageId: design,
      sourceId: design,
      ownerMemberId: design,
      tagIds: [design],
      q: "globalThis.send()",
      intent: "unknown",
    };
    expect(validateWorkflowDefinition(value)).toEqual([]);
  });
  it("uses Unicode code points for frozen string limits", () => {
    const value = valid();
    value.nodes[0].taskTitle = "😀".repeat(200);
    expect(validateWorkflowDefinition(value)).toEqual([]);
    value.nodes[0].taskTitle += "😀";
    expect(fields(value)).toContain("nodes.0.taskTitle");
    const filter = branched();
    filter.nodes[0].condition = { q: "😀".repeat(200) };
    expect(validateWorkflowDefinition(filter)).toEqual([]);
  });
  it.each(["", "Mars/Olympus", "+02:00", "EST", " UTC", "America/Los_Angeles "])(
    "rejects invalid or ambiguous timezone %s",
    (timezone) => {
      expect(fields({ ...valid(), timezone })).toContain("timezone");
    },
  );
  it.each(["UTC", "America/Los_Angeles", "Asia/Bangkok", "Etc/GMT+8"])(
    "accepts verified IANA zone %s",
    (timezone) => {
      expect(validateWorkflowDefinition({ ...valid(), timezone })).toEqual([]);
    },
  );
  it.each([
    { start: "24:00", end: "08:00" },
    { start: "21:60", end: "08:00" },
    { start: "9:00", end: "08:00" },
    { start: "21:00", end: "21:00" },
    { start: "21:00" },
    { start: "21:00", end: "08:00", script: "ignored" },
  ])("requires bounded unambiguous quiet-hour metadata %#", (quietHours) => {
    expect(fields({ ...valid(), quietHours }).some((field) => field.startsWith("quietHours"))).toBe(true);
  });
  it("never coerces a branch array and does not mutate definitions or expose input content in issues", () => {
    const value = {
      ...valid(),
      secret: "DO_NOT_REFLECT",
      nodes: [{ ...task(), script: "DO_NOT_REFLECT" }],
      edges: [{ from: "first", to: "first", branch: ["always"] }],
    };
    const before = JSON.stringify(value);
    const issues = validateWorkflowDefinition(value as unknown as WorkflowDefinition);
    expect(JSON.stringify(value)).toBe(before);
    expect(JSON.stringify(issues)).not.toContain("DO_NOT_REFLECT");
    expect(fields(value)).toContain("edges.0.branch");
    expect(Object.isFrozen(issues)).toBe(true);
    expect(issues.every(Object.isFrozen)).toBe(true);
  });
  it("bundles browser exports without Node, provider, API, database or runtime contract modules", async () => {
    const require = createRequire(`${process.cwd()}/package.json`);
    const vitestRequire = createRequire(require.resolve("vitest/package.json"));
    const { build } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
    const result = await build({
      configFile: false,
      root: process.cwd(),
      logLevel: "error",
      plugins: [
        {
          name: "workflow-browser-boundary",
          buildEnd(this: { getModuleIds(): Iterable<string> }) {
            for (const id of this.getModuleIds())
              expect(id.replaceAll("\\", "/")).not.toMatch(
                /\/packages\/(?:db|auth|providers|contracts)\/|\/apps\/api\/|node:/,
              );
          },
        },
      ],
      build: { write: false, minify: false, lib: { entry: "packages/marketing/index.ts", formats: ["es"] } },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
    for (const output of outputs)
      if (output.type === "chunk")
        expect(output.code).not.toMatch(/node:|PoolClient|appendCampaign|openapi\.json|require\(|\bBuffer\b/);
  });
});
