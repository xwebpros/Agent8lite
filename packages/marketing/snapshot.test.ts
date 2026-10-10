import { describe, expect, it } from "vitest";
import { workflowJson, workflowSnapshot } from "../../apps/api/src/marketing/workflow-json";
import { WorkflowCommandError } from "../../apps/api/src/marketing/workflow-errors";

const value = () => ({
  nodes: [{ key: "first", kind: "task", taskTitle: "Original" }],
  edges: [],
  timezone: "UTC",
});
describe("owned workflow command JSON snapshot", () => {
  it("detaches and freezes the entire definition before any caller mutation", () => {
    const input = value();
    const cloned = workflowSnapshot(input);
    input.nodes[0].taskTitle = "Changed";
    input.nodes.push({ key: "other", kind: "task", taskTitle: "Other" });
    expect(cloned.nodes).toHaveLength(1);
    expect(cloned.nodes[0].taskTitle).toBe("Original");
    expect(Object.isFrozen(cloned)).toBe(true);
    expect(Object.isFrozen(cloned.nodes)).toBe(true);
    expect(Object.isFrozen(cloned.nodes[0])).toBe(true);
  });
  it("never invokes getters or own/prototype toJSON methods", () => {
    let calls = 0;
    const getter = Object.defineProperty(value(), "timezone", {
      get() {
        calls += 1;
        return "UTC";
      },
      enumerable: true,
    });
    const own = {
      ...value(),
      toJSON() {
        calls += 1;
        return value();
      },
    };
    const inherited = Object.assign(
      Object.create({
        toJSON() {
          calls += 1;
          return value();
        },
      }),
      value(),
    );
    for (const input of [getter, own, inherited])
      expect(() => workflowSnapshot(input)).toThrowError(WorkflowCommandError);
    expect(calls).toBe(0);
  });
  it("rejects proxies without invoking their traps", () => {
    let calls = 0;
    const proxy = new Proxy(value(), {
      get() {
        calls += 1;
        return undefined;
      },
      ownKeys() {
        calls += 1;
        return [];
      },
      getPrototypeOf() {
        calls += 1;
        return Object.prototype;
      },
    });
    expect(() => workflowSnapshot(proxy)).toThrowError(WorkflowCommandError);
    expect(calls).toBe(0);
  });
  it("serializes canonical own data without invoking polluted built-in toJSON hooks", () => {
    let calls = 0;
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let text: string;
    let same: string;
    try {
      const hook = () => {
        calls += 1;
        return { changed: true };
      };
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      const snapshot = workflowSnapshot(value());
      text = workflowJson(snapshot);
      same = workflowJson({ timezone: "UTC", edges: [], nodes: value().nodes });
    } finally {
      if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(calls).toBe(0);
    expect(text!).toBe(same!);
    expect(JSON.parse(text!).nodes[0].taskTitle).toBe("Original");
    expect(text!).not.toContain("changed");
  });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => "data", Symbol("data")])(
    "rejects non-JSON scalar %#",
    (bad) => {
      expect(() => workflowSnapshot({ ...value(), bad })).toThrowError(WorkflowCommandError);
    },
  );
  it("rejects cycles, sparse arrays, extra array properties, accessors and nonenumerable object properties", () => {
    const cycle: Record<string, unknown> = value();
    cycle.self = cycle;
    const sparse = value();
    delete sparse.nodes[0];
    const extra = value();
    Object.defineProperty(extra.nodes, "private", { value: "ignored" });
    const arrayGetter = value();
    Object.defineProperty(arrayGetter.nodes, "0", {
      get() {
        throw new Error("accessor executed");
      },
      enumerable: true,
    });
    const hidden = Object.defineProperty(value(), "ignored", { value: "private" });
    for (const input of [cycle, sparse, extra, arrayGetter, hidden])
      expect(() => workflowSnapshot(input)).toThrowError(WorkflowCommandError);
  });
  it("bounds escaped UTF8 bytes and recursion depth, with safe fixed errors", () => {
    const huge = { ...value(), timezone: "DO_NOT_REFLECT" + "😀".repeat(65536) };
    expect(() => workflowSnapshot(huge)).toThrowError(WorkflowCommandError);
    let deep: unknown = 0;
    for (let index = 0; index < 22; index += 1) deep = { nested: deep };
    expect(() => workflowSnapshot(deep)).toThrowError(WorkflowCommandError);
    try {
      workflowSnapshot(huge);
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("DO_NOT_REFLECT");
    }
  });
});
