import { types } from "node:util";
import type { WorkflowDefinition } from "../../../../packages/marketing";
import { WorkflowCommandError } from "./workflow-errors";

/** Read and serialize only own JSON data; inherited toJSON hooks are never consulted. */
function jsonData(input: unknown, maximumBytes: number): { value: unknown; text: string } {
  let remaining = maximumBytes;
  const active = new WeakSet<object>();
  const fail = (): never => {
    throw new WorkflowCommandError(422, "workflow_json_invalid", "Workflow JSON is invalid or too large.", [
      {
        field: "definition",
        message: "Use bounded plain JSON without accessors, sparse arrays or custom prototypes.",
      },
    ]);
  };
  const charge = (size: number) => {
    remaining -= size;
    if (remaining < 0) fail();
  };
  const clone = (value: unknown, depth: number): { value: unknown; text: string } => {
    if (depth > 20) fail();
    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const text = JSON.stringify(value);
      charge(Buffer.byteLength(text, "utf8"));
      return { value, text };
    }
    if (typeof value !== "object" || value === null) return fail();
    if (types.isProxy(value) || active.has(value)) return fail();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail();
    if (Object.getOwnPropertySymbols(value).length) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 10001) fail();
    active.add(value);
    charge(2);
    let result: unknown;
    let text: string;
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isInteger(length) || length < 0 || length > 10000 || keys.length !== length + 1) fail();
      const values: unknown[] = [];
      const texts: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = descriptors[String(index)];
        if (!item || !Object.hasOwn(item, "value") || !item.enumerable) fail();
        if (index) charge(1);
        const child = clone(item.value, depth + 1);
        values.push(child.value);
        texts.push(child.text);
      }
      result = Object.freeze(values);
      text = `[${texts.join(",")}]`;
    } else {
      const values: Record<string, unknown> = Object.create(null);
      const texts: string[] = [];
      for (const [index, key] of keys.sort().entries()) {
        const item = descriptors[key];
        if (!Object.hasOwn(item, "value") || !item.enumerable || key === "toJSON") fail();
        const keyText = JSON.stringify(key);
        charge(Buffer.byteLength(keyText, "utf8") + 1 + (index ? 1 : 0));
        const child = clone(item.value, depth + 1);
        values[key] = child.value;
        texts.push(`${keyText}:${child.text}`);
      }
      result = Object.freeze(values);
      text = `{${texts.join(",")}}`;
    }
    active.delete(value);
    return { value: result, text };
  };
  return clone(input, 0);
}

/** Detach and freeze the definition before validation, hashing or any awaited lock. */
export function workflowSnapshot(input: unknown): WorkflowDefinition {
  return jsonData(input, 262144).value as WorkflowDefinition;
}

/** Canonical own-data JSON for size, hashes, durable bodies and receipt comparisons. */
export function workflowJson(input: unknown): string {
  return jsonData(input, 1048576).text;
}
