export class CmsJsonLimitError extends Error {}

/** Clone descriptor values into a bounded JSON tree without invoking payload/prototype hooks. */
export function boundedCmsJson(
  value: unknown,
  limits: { maxDepth: number; maxNodes: number; maxBytes: number },
): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > limits.maxNodes || depth > limits.maxDepth) throw new CmsJsonLimitError();
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new CmsJsonLimitError();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype))
      throw new CmsJsonLimitError();
    const keys = Reflect.ownKeys(item);
    const length = array ? (Object.getOwnPropertyDescriptor(item, "length")!.value as number) : 0;
    // Dense ordinary arrays only. Holes and additional properties would be lost/normalized by JSON.
    if (array && (length > limits.maxNodes || keys.length !== length + 1)) throw new CmsJsonLimitError();
    ancestors.add(item);
    const detached = (array ? [] : Object.create(null)) as Record<string, unknown>;
    Object.setPrototypeOf(detached, null);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || descriptor.get || descriptor.set)
        throw new CmsJsonLimitError();
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) throw new CmsJsonLimitError();
      detached[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
    return detached;
  }
  // Null prototypes on the detached objects/arrays prevent inherited toJSON getters or functions.
  const json = JSON.stringify(copy(value, 0));
  if (!json || new TextEncoder().encode(json).byteLength > limits.maxBytes) throw new CmsJsonLimitError();
  return json;
}
