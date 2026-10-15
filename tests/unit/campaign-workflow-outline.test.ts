import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "../../packages/marketing";
import {
  definitionOutline,
  outlineDefinition,
  outlineInsert,
  outlineIssues,
  outlineLocate,
  outlineMove,
  outlineNodes,
  outlineRemove,
  outlineReplaceNode,
  outlineTargetDepth,
  type Outline,
} from "../../apps/web/components/campaign-workflow-outline";
import type { Schema } from "../../apps/web/lib/api";

type Definition = Schema<"CampaignVersionWrite">;
type Node = Schema<"WorkflowNode">;
const base: Definition = {
  nodes: [],
  edges: [],
  timezone: "UTC",
  quietHours: { start: "22:00", end: "07:00" },
};
const wait = (key: string, delaySeconds = 60): Node => ({ key, kind: "wait", delaySeconds });
const task = (key: string): Node => ({ key, kind: "task", taskTitle: `Synthetic ${key}` });
const when = (key: string, intent: "buyer" | "seller" = "buyer"): Node => ({
  key,
  kind: "condition",
  condition: { intent },
});
const step = (node: Node) => ({ type: "step" as const, node });
const branch = (node: Node, whenTrue: Outline, whenFalse: Outline) => ({
  type: "condition" as const,
  node,
  whenTrue,
  whenFalse,
});
const edgeSet = (definition: Definition) =>
  definition.edges.map((edge) => `${edge.from}>${edge.to}:${edge.branch}`).sort();

describe("outline serialization", () => {
  it("serializes a linear outline exactly like the existing linear editor", () => {
    const definition = outlineDefinition([step(wait("a")), step(task("b"))], base);
    expect(definition).toEqual({
      ...base,
      nodes: [wait("a"), task("b")],
      edges: [{ from: "a", to: "b", branch: "always" }],
    });
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it("rejoins both branches at the following step and keeps every key", () => {
    const outline = [
      step(wait("start")),
      branch(when("check"), [step(task("yes"))], [step(wait("no")), step(task("no_two"))]),
      step(task("after")),
    ];
    const definition = outlineDefinition(outline, base);
    expect(definition.nodes.map((node) => node.key)).toEqual([
      "start",
      "check",
      "yes",
      "no",
      "no_two",
      "after",
    ]);
    expect(edgeSet(definition)).toEqual(
      [
        "start>check:always",
        "check>yes:true",
        "check>no:false",
        "yes>after:always",
        "no>no_two:always",
        "no_two>after:always",
      ].sort(),
    );
    expect(outlineIssues(outline)).toEqual([]);
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it("points an empty branch at the continuation", () => {
    const outline = [branch(when("check"), [], [step(task("no"))]), step(task("after"))];
    const definition = outlineDefinition(outline, base);
    expect(edgeSet(definition)).toEqual(["check>after:true", "check>no:false", "no>after:always"].sort());
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it("serializes nested conditions whose inner branches rejoin inside the outer branch", () => {
    const outline = [
      branch(
        when("outer"),
        [
          branch(when("inner", "seller"), [step(task("inner_yes"))], [step(task("inner_no"))]),
          step(wait("joined")),
        ],
        [step(task("outer_no"))],
      ),
      step(task("end")),
    ];
    const definition = outlineDefinition(outline, base);
    expect(edgeSet(definition)).toEqual(
      [
        "outer>inner:true",
        "outer>outer_no:false",
        "inner>inner_yes:true",
        "inner>inner_no:false",
        "inner_yes>joined:always",
        "inner_no>joined:always",
        "joined>end:always",
        "outer_no>end:always",
      ].sort(),
    );
    expect(validateWorkflowDefinition(definition)).toEqual([]);
  });

  it("does not copy prototype-bound or extra properties beyond the closed definition", () => {
    const definition = outlineDefinition([step(wait("a"))], {
      nodes: [],
      edges: [],
      timezone: "Asia/Bangkok",
    });
    expect(Object.keys(definition).sort()).toEqual(["edges", "nodes", "timezone"]);
  });
});

describe("outline issues", () => {
  it("requires a step in at least one branch", () => {
    const outline = [branch(when("check"), [], []), step(task("after"))];
    expect(outlineIssues(outline)).toEqual([
      { field: "nodes.0", message: "Add a step to at least one branch of this condition." },
    ]);
    expect(validateWorkflowDefinition(outlineDefinition(outline, base)).length).toBeGreaterThan(0);
  });

  it("requires both branches for a final condition", () => {
    const outline = [step(wait("start")), branch(when("check"), [step(task("yes"))], [])];
    expect(outlineIssues(outline)).toEqual([
      { field: "nodes.1", message: "A condition at the end of the workflow needs a step in both branches." },
    ]);
  });

  it("uses the inherited continuation for a final condition inside a branch", () => {
    const outline = [
      branch(when("outer"), [branch(when("inner"), [step(task("x"))], [])], [step(task("y"))]),
      step(task("after")),
    ];
    expect(outlineIssues(outline)).toEqual([]);
    expect(validateWorkflowDefinition(outlineDefinition(outline, base))).toEqual([]);
  });

  it("limits nesting to three conditions and reports the serialized node index", () => {
    const deepest = branch(when("d4"), [step(task("t4"))], [step(task("f4"))]);
    const outline = [
      branch(
        when("d1"),
        [branch(when("d2"), [branch(when("d3"), [deepest], [step(task("f3"))])], [step(task("f2"))])],
        [step(task("f1"))],
      ),
    ];
    const issues = outlineIssues(outline);
    expect(issues).toEqual([
      { field: "nodes.3", message: "Conditions can be nested at most three levels deep." },
    ]);
    expect(outlineNodes(outline)[3].key).toBe("d4");
  });
});

describe("parsing saved graphs", () => {
  const roundTrip = (outline: Outline) => {
    const definition = outlineDefinition(outline, base);
    const parsed = definitionOutline(definition);
    expect(parsed).not.toBeNull();
    expect(outlineDefinition(parsed!, base)).toEqual(definition);
  };

  it("round-trips linear, single, empty-branch, nested and terminal-branch outlines", () => {
    roundTrip([step(wait("a")), step(task("b"))]);
    roundTrip([step(wait("a")), branch(when("c"), [step(task("y"))], [step(task("n"))]), step(task("z"))]);
    roundTrip([branch(when("c"), [], [step(task("n"))]), step(task("z"))]);
    roundTrip([branch(when("c"), [step(task("y"))], []), step(task("z"))]);
    roundTrip([branch(when("c"), [step(task("y"))], [step(task("n"))])]);
    roundTrip([
      branch(
        when("o"),
        [branch(when("i"), [step(task("iy"))], [step(task("in"))]), step(wait("j"))],
        [branch(when("k"), [], [step(task("kn"))])],
      ),
      step(task("end")),
    ]);
  });

  it("accepts the graph shape that previously stayed read-only", () => {
    const definition: Definition = {
      timezone: "UTC",
      nodes: [when("entry"), task("yes"), when("nested", "seller"), wait("no", 120), task("other")],
      edges: [
        { from: "entry", to: "yes", branch: "true" },
        { from: "entry", to: "nested", branch: "false" },
        { from: "nested", to: "no", branch: "true" },
        { from: "nested", to: "other", branch: "false" },
      ],
    };
    const parsed = definitionOutline(definition)!;
    expect(parsed).toHaveLength(1);
    expect(edgeSet(outlineDefinition(parsed, definition))).toEqual(edgeSet(definition));
  });

  it.each([
    [
      "a nested condition jumping into the other branch",
      [when("c"), wait("a"), when("d"), task("b"), task("e"), task("f")],
      [
        ["c", "a", "true"],
        ["c", "b", "false"],
        ["a", "d", "always"],
        ["d", "b", "true"],
        ["d", "e", "false"],
        ["b", "f", "always"],
        ["e", "f", "always"],
      ],
    ],
    ["two entries", [wait("a"), wait("b")], []],
    [
      "a cycle",
      [wait("a"), wait("b")],
      [
        ["a", "b", "always"],
        ["b", "a", "always"],
      ],
    ],
    ["a step with a true branch", [wait("a"), wait("b")], [["a", "b", "true"]]],
    ["a condition missing its false branch", [when("c"), wait("b")], [["c", "b", "true"]]],
    [
      "a nested branch that escapes past its enclosing rejoin point",
      [when("c"), task("x"), wait("y"), when("d"), task("z"), task("w")],
      [
        ["c", "x", "true"],
        ["c", "y", "false"],
        ["x", "z", "always"],
        ["y", "d", "always"],
        ["d", "z", "true"],
        ["d", "w", "false"],
      ],
    ],
  ] as const)("keeps %s read-only", (_label, nodes, edges) => {
    const definition: Definition = {
      timezone: "UTC",
      nodes: nodes.map((node) => ({ ...node })) as Node[],
      edges: edges.map(([from, to, kind]) => ({ from, to, branch: kind })),
    };
    expect(definitionOutline(definition)).toBeNull();
  });

  it("keeps graphs deeper than three conditions read-only", () => {
    const outline = [
      branch(
        when("d1"),
        [
          branch(
            when("d2"),
            [
              branch(
                when("d3"),
                [branch(when("d4"), [step(task("t"))], [step(task("f"))])],
                [step(task("f3"))],
              ),
            ],
            [step(task("f2"))],
          ),
        ],
        [step(task("f1"))],
      ),
    ];
    expect(definitionOutline(outlineDefinition(outline, base))).toBeNull();
  });

  it("rejects duplicate keys and unknown node kinds", () => {
    expect(definitionOutline({ timezone: "UTC", nodes: [wait("a"), wait("a")], edges: [] })).toBeNull();
    expect(
      definitionOutline({
        timezone: "UTC",
        nodes: [{ key: "a", kind: "unknown" as never }],
        edges: [],
      }),
    ).toBeNull();
  });
});

describe("outline edits", () => {
  const sample = (): Outline => [
    step(wait("a")),
    branch(when("c"), [step(task("y1")), step(task("y2"))], []),
    step(task("z")),
  ];

  it("inserts into the top level or a named branch and rejects unknown targets or duplicate keys", () => {
    const top = outlineInsert(sample(), { parent: null }, task("new"))!;
    expect(top.at(-1)!.node.key).toBe("new");
    const inBranch = outlineInsert(sample(), { parent: "c", branch: "false" }, wait("n"))!;
    expect(outlineLocate(inBranch, "n")).toEqual({
      target: { parent: "c", branch: "false" },
      index: 0,
      length: 1,
      depth: 1,
    });
    expect(outlineInsert(sample(), { parent: "z", branch: "true" }, wait("n"))).toBeNull();
    expect(outlineInsert(sample(), { parent: "missing", branch: "true" }, wait("n"))).toBeNull();
    expect(outlineInsert(sample(), { parent: null }, wait("a"))).toBeNull();
    const condition = outlineInsert(sample(), { parent: "c", branch: "true" }, when("inner"))!;
    expect(outlineTargetDepth(condition, { parent: "inner", branch: "true" })).toBe(2);
    expect(outlineTargetDepth(condition, { parent: null })).toBe(0);
    expect(outlineTargetDepth(condition, { parent: "a", branch: "true" })).toBeNull();
  });

  it("moves only within the item's own list", () => {
    const moved = outlineMove(sample(), "y2", -1)!;
    const item = moved[1];
    expect(item.type === "condition" && item.whenTrue.map((entry) => entry.node.key)).toEqual(["y2", "y1"]);
    expect(outlineMove(sample(), "y1", -1)).toBeNull();
    expect(outlineMove(sample(), "z", 1)).toBeNull();
    expect(outlineMove(sample(), "c", 1)!.map((entry) => entry.node.key)).toEqual(["a", "z", "c"]);
  });

  it("removes a condition only after both branches are empty, and never removes steps implicitly", () => {
    expect(outlineRemove(sample(), "c")).toBeNull();
    let outline = outlineRemove(sample(), "y1")!;
    outline = outlineRemove(outline, "y2")!;
    outline = outlineRemove(outline, "c")!;
    expect(outlineNodes(outline).map((node) => node.key)).toEqual(["a", "z"]);
    expect(outlineRemove(sample(), "missing")).toBeNull();
  });

  it("replaces a node of the same kind and keeps the original outline unchanged", () => {
    const original = sample();
    const replaced = outlineReplaceNode(original, {
      key: "c",
      kind: "condition",
      condition: { q: "Synthetic" },
    })!;
    expect(outlineNodes(replaced)[1].condition).toEqual({ q: "Synthetic" });
    expect(outlineNodes(original)[1].condition).toEqual({ intent: "buyer" });
    expect(outlineReplaceNode(original, { key: "c", kind: "wait", delaySeconds: 1 })).toBeNull();
    expect(outlineReplaceNode(original, task("missing"))).toBeNull();
  });
});
