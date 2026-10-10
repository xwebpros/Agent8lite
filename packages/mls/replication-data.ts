import { types } from "node:util";

/** Private JSON boundary: never invoke hooks or proxy traps while detaching port/caller data. */
export function snapshotMockReplicationData<T>(value: T): T {
  let nodes = 0;
  let bytes = 0;
  function reject(): never {
    throw new Error("invalid_replication_data");
  }
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 40000 || depth > 12) return reject();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      return item.length <= 25000 && bytes <= 3000000 ? item : reject();
    }
    if (typeof item === "number") return Number.isFinite(item) && !Object.is(item, -0) ? item : reject();
    if (typeof item !== "object" || types.isProxy(item)) return reject();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return reject();
    const keys = Reflect.ownKeys(item);
    if (keys.some((key) => typeof key !== "string")) return reject();
    if (array) {
      const length = Object.getOwnPropertyDescriptor(item, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 500 || keys.length !== length + 1)
        return reject();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return reject();
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    if (keys.length > 64) return reject();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return reject();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  return copy(value, 0) as T;
}
