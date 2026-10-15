import type { WorkflowIssue } from "../../../packages/marketing/types";
import type { Schema } from "../lib/api";
import type { WorkflowDefinition } from "./campaign-workflow-protocol";

type WorkflowNode = Schema<"WorkflowNode">;
type WorkflowEdge = Schema<"WorkflowEdge">;
export type WorkflowStepKind = "wait" | "task" | "email" | "sms";
export type OutlineItem =
  | Readonly<{ type: "step"; node: WorkflowNode }>
  | Readonly<{ type: "condition"; node: WorkflowNode; whenTrue: Outline; whenFalse: Outline }>;
export type Outline = readonly OutlineItem[];
/** A list inside the outline: the top level, or one branch of a condition. */
export type OutlineTarget = Readonly<{ parent: string | null; branch?: "true" | "false" }>;

export const maxConditionDepth = 3;
const stepKinds: readonly string[] = ["wait", "task", "email", "sms"];

function firstKey(list: Outline, index: number): string | null {
  return list[index]?.node.key ?? null;
}

/** Pre-order: each item's node, then a condition's true branch, then its false branch. */
export function outlineNodes(outline: Outline): readonly WorkflowNode[] {
  const nodes: WorkflowNode[] = [];
  const walk = (list: Outline) => {
    for (const item of list) {
      nodes.push(item.node);
      if (item.type === "condition") {
        walk(item.whenTrue);
        walk(item.whenFalse);
      }
    }
  };
  walk(outline);
  return nodes;
}

function outlineEdges(outline: Outline): readonly WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  const emit = (list: Outline, continuation: string | null) => {
    list.forEach((item, index) => {
      const next = firstKey(list, index + 1) ?? continuation;
      if (item.type === "step") {
        if (next) edges.push({ from: item.node.key, to: next, branch: "always" });
        return;
      }
      const whenTrue = firstKey(item.whenTrue, 0) ?? next;
      const whenFalse = firstKey(item.whenFalse, 0) ?? next;
      if (whenTrue) edges.push({ from: item.node.key, to: whenTrue, branch: "true" });
      if (whenFalse) edges.push({ from: item.node.key, to: whenFalse, branch: "false" });
      emit(item.whenTrue, next);
      emit(item.whenFalse, next);
    });
  };
  emit(outline, null);
  return edges;
}

/** Deterministic serialization; node keys, timezone and quiet hours are preserved. */
export function outlineDefinition(outline: Outline, previous: WorkflowDefinition): WorkflowDefinition {
  const definition: WorkflowDefinition = {
    nodes: outlineNodes(outline).map((node) => ({ ...node })),
    edges: outlineEdges(outline).map((edge) => ({ ...edge })),
    timezone: previous.timezone,
  };
  if (previous.quietHours) definition.quietHours = { ...previous.quietHours };
  return definition;
}

/** Structural issues the shared graph validator would report less specifically. */
export function outlineIssues(outline: Outline): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  let index = 0;
  const walk = (list: Outline, continuation: string | null, depth: number) => {
    list.forEach((item, position) => {
      const nodeIndex = index++;
      if (item.type === "step") return;
      const next = firstKey(list, position + 1) ?? continuation;
      const field = `nodes.${nodeIndex}`;
      if (depth > maxConditionDepth)
        issues.push({ field, message: "Conditions can be nested at most three levels deep." });
      if (!item.whenTrue.length && !item.whenFalse.length)
        issues.push({ field, message: "Add a step to at least one branch of this condition." });
      else if (!next && (!item.whenTrue.length || !item.whenFalse.length))
        issues.push({
          field,
          message: "A condition at the end of the workflow needs a step in both branches.",
        });
      walk(item.whenTrue, next, depth + 1);
      walk(item.whenFalse, next, depth + 1);
    });
  };
  walk(outline, null, 1);
  return issues;
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort())
        result[key] = normalize((item as Record<string, unknown>)[key]);
      return result;
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Parse a saved graph into an outline. The result is accepted only when it serializes back to
 * exactly the same nodes and edges, so an unusual graph stays read-only instead of changing.
 */
export function definitionOutline(definition: WorkflowDefinition): Outline | null {
  if (!definition.nodes.length || definition.nodes.length > 100 || definition.edges.length > 200) return null;
  const nodes = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.key) || (node.kind !== "condition" && !stepKinds.includes(node.kind))) return null;
    nodes.set(node.key, node);
  }
  const outgoing = new Map<string, Partial<Record<WorkflowEdge["branch"], string>>>();
  const incoming = new Set<string>();
  for (const edge of definition.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) return null;
    const branches = outgoing.get(edge.from) ?? {};
    if (branches[edge.branch]) return null;
    branches[edge.branch] = edge.to;
    outgoing.set(edge.from, branches);
    incoming.add(edge.to);
  }
  const entries = definition.nodes.filter((node) => !incoming.has(node.key));
  if (entries.length !== 1) return null;

  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const key = stack.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const to of Object.values(outgoing.get(key) ?? {})) if (to) stack.push(to);
    }
    return seen;
  };
  const visited = new Set<string>();
  let failed = false;
  const parse = (start: string | null, stop: string | null, depth: number): Outline => {
    const items: OutlineItem[] = [];
    let current = start;
    while (current && current !== stop && !failed) {
      const node = nodes.get(current)!;
      if (visited.has(current)) {
        failed = true;
        break;
      }
      visited.add(current);
      const branches = outgoing.get(current) ?? {};
      if (node.kind !== "condition") {
        if (branches.true || branches.false) failed = true;
        items.push({ type: "step", node });
        current = branches.always ?? null;
        continue;
      }
      if (depth > maxConditionDepth || branches.always || !branches.true || !branches.false) {
        failed = true;
        break;
      }
      const fromTrue = reach(branches.true),
        fromFalse = reach(branches.false);
      const shared = [...fromTrue].filter((key) => fromFalse.has(key));
      const reachable = new Map(shared.map((key) => [key, reach(key)]));
      const joins = shared.filter((key) => shared.every((other) => reachable.get(key)!.has(other)));
      if (shared.length && joins.length !== 1) {
        failed = true;
        break;
      }
      const join = joins[0] ?? null;
      const whenTrue = parse(branches.true, join, depth + 1);
      const whenFalse = parse(branches.false, join, depth + 1);
      items.push({ type: "condition", node, whenTrue, whenFalse });
      current = join;
    }
    if (current !== stop && !failed) failed = true;
    return items;
  };
  const outline = parse(entries[0].key, null, 1);
  if (failed || visited.size !== nodes.size) return null;
  const rebuilt = outlineDefinition(outline, definition);
  const nodeSet = (list: readonly WorkflowNode[]) => list.map(canonical).sort();
  const edgeSet = (list: readonly WorkflowEdge[]) => list.map(canonical).sort();
  if (
    canonical(nodeSet(rebuilt.nodes)) !== canonical(nodeSet(definition.nodes)) ||
    canonical(edgeSet(rebuilt.edges)) !== canonical(edgeSet(definition.edges))
  )
    return null;
  return outline;
}

type ListEdit = (list: Outline) => Outline | null;

/** Apply an edit to the list that `target` names; null when the target does not exist. */
function editList(outline: Outline, target: OutlineTarget, edit: ListEdit): Outline | null {
  if (target.parent === null) return edit(outline);
  let found = false;
  const walk = (list: Outline): Outline | null => {
    const result: OutlineItem[] = [];
    for (const item of list) {
      if (item.type === "step") {
        result.push(item);
        continue;
      }
      if (item.node.key === target.parent && target.branch) {
        found = true;
        const branch = edit(target.branch === "true" ? item.whenTrue : item.whenFalse);
        if (!branch) return null;
        result.push(
          target.branch === "true" ? { ...item, whenTrue: branch } : { ...item, whenFalse: branch },
        );
        continue;
      }
      const whenTrue = walk(item.whenTrue);
      const whenFalse = whenTrue && walk(item.whenFalse);
      if (!whenTrue || !whenFalse) return null;
      result.push({ ...item, whenTrue, whenFalse });
    }
    return result;
  };
  const result = walk(outline);
  return found ? result : null;
}

/** Locate the list holding `key` and that key's position in it. */
export function outlineLocate(
  outline: Outline,
  key: string,
): Readonly<{ target: OutlineTarget; index: number; length: number; depth: number }> | null {
  const walk = (list: Outline, target: OutlineTarget, depth: number): ReturnType<typeof outlineLocate> => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      if (item.node.key === key) return { target, index, length: list.length, depth };
      if (item.type === "condition")
        for (const branch of ["true", "false"] as const) {
          const found = walk(
            branch === "true" ? item.whenTrue : item.whenFalse,
            { parent: item.node.key, branch },
            depth + 1,
          );
          if (found) return found;
        }
    }
    return null;
  };
  return walk(outline, { parent: null }, 0);
}

/** Number of conditions enclosing items placed into `target`. */
export function outlineTargetDepth(outline: Outline, target: OutlineTarget): number | null {
  if (target.parent === null) return 0;
  const located = outlineLocate(outline, target.parent);
  const item = located && findItem(outline, target.parent);
  return located && item?.type === "condition" && target.branch ? located.depth + 1 : null;
}

export function findItem(outline: Outline, key: string): OutlineItem | null {
  for (const item of outline) {
    if (item.node.key === key) return item;
    if (item.type === "condition") {
      const found = findItem(item.whenTrue, key) ?? findItem(item.whenFalse, key);
      if (found) return found;
    }
  }
  return null;
}

export function outlineInsert(outline: Outline, target: OutlineTarget, node: WorkflowNode): Outline | null {
  if (findItem(outline, node.key)) return null;
  const item: OutlineItem =
    node.kind === "condition"
      ? { type: "condition", node, whenTrue: [], whenFalse: [] }
      : { type: "step", node };
  return editList(outline, target, (list) => [...list, item]);
}

export function outlineMove(outline: Outline, key: string, direction: -1 | 1): Outline | null {
  const located = outlineLocate(outline, key);
  if (!located) return null;
  const target = located.index + direction;
  if (target < 0 || target >= located.length) return null;
  return editList(outline, located.target, (list) => {
    const copy = [...list];
    [copy[located.index], copy[target]] = [copy[target], copy[located.index]];
    return copy;
  });
}

/** A condition is removable only once both branches are empty; steps are never removed implicitly. */
export function outlineRemove(outline: Outline, key: string): Outline | null {
  const located = outlineLocate(outline, key);
  const item = findItem(outline, key);
  if (!located || !item) return null;
  if (item.type === "condition" && (item.whenTrue.length || item.whenFalse.length)) return null;
  return editList(outline, located.target, (list) => list.filter((entry) => entry.node.key !== key));
}

export function outlineReplaceNode(outline: Outline, node: WorkflowNode): Outline | null {
  const existing = findItem(outline, node.key);
  if (!existing || existing.node.kind !== node.kind) return null;
  const walk = (list: Outline): Outline =>
    list.map((item) =>
      item.node.key === node.key
        ? { ...item, node }
        : item.type === "condition"
          ? { ...item, whenTrue: walk(item.whenTrue), whenFalse: walk(item.whenFalse) }
          : item,
    );
  return walk(outline);
}
