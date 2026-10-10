import { types } from "node:util";

export class TemplateJsonError extends Error {}

/** Bounded own-data serialization; payload/prototype hooks and Proxy traps never run. */
export function serializeTemplateJson(input: unknown): string {
  let bytes = 262144;
  let nodes = 0;
  const active = new WeakSet<object>();
  const fail = (): never => {
    throw new TemplateJsonError();
  };
  const charge = (size: number) => {
    bytes -= size;
    if (bytes < 0) fail();
  };
  const read = (value: unknown, depth: number): string => {
    if (++nodes > 20000 || depth > 32 || (typeof value === "string" && value.length > 262144)) return fail();
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const text = JSON.stringify(value);
      charge(Buffer.byteLength(text, "utf8"));
      return text;
    }
    if (!value || typeof value !== "object" || types.isProxy(value) || active.has(value)) return fail();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return fail();
    if (Object.getOwnPropertySymbols(value).length) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 20001) return fail();
    active.add(value);
    charge(2);
    const parts: string[] = [];
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isInteger(length) || length < 0 || length > 20000 || keys.length !== length + 1)
        return fail();
      for (let index = 0; index < length; index++) {
        const item = descriptors[String(index)];
        if (!item || !Object.hasOwn(item, "value") || !item.enumerable) return fail();
        if (index) charge(1);
        parts.push(read(item.value, depth + 1));
      }
    } else {
      for (const [index, key] of keys.entries()) {
        const item = descriptors[key];
        if (!Object.hasOwn(item, "value") || !item.enumerable || key.length > 262144) return fail();
        const keyText = JSON.stringify(key);
        charge(Buffer.byteLength(keyText, "utf8") + 1 + (index ? 1 : 0));
        parts.push(`${keyText}:${read(item.value, depth + 1)}`);
      }
    }
    active.delete(value);
    return array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
  };
  return read(input, 0);
}
