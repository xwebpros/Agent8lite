import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { validateSchema } from "./contract-validation";

type LeadFilter = components["schemas"]["LeadFilter"];
export type ContactListQuery = Readonly<{
  limit: number;
  cursor: string | undefined;
  filter: Readonly<LeadFilter>;
}>;
export const contactFilterJsonLimit = 16 * 1024;

function invalid(code: string, message: string): never {
  throw new AccessError(422, code, message);
}

/** Project scalars before any await or coercion; the filter contract remains the generated LeadFilter. */
export function parseContactQuery(input: unknown): ContactListQuery {
  if (!input || typeof input !== "object" || types.isProxy(input))
    return invalid("query_invalid", "Only contact pagination and JSON filter parameters are supported.");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype)
    return invalid("query_invalid", "Only contact pagination and JSON filter parameters are supported.");
  const query: Record<string, unknown> = Object.create(null);
  const keys = Reflect.ownKeys(input);
  if (keys.length > 3)
    return invalid("query_invalid", "Only contact pagination and JSON filter parameters are supported.");
  for (const key of keys) {
    if (typeof key !== "string" || !["limit", "cursor", "filter"].includes(key))
      return invalid("query_invalid", "Only contact pagination and JSON filter parameters are supported.");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      return invalid("query_invalid", "Contact query parameters must be own scalar values.");
    query[key] = descriptor.value;
  }
  let limit = 25;
  if (Object.hasOwn(query, "limit")) {
    const value = query.limit;
    if (typeof value === "number" && Number.isInteger(value)) limit = value;
    else if (typeof value === "string" && /^[1-9][0-9]{0,2}$/.test(value)) limit = Number(value);
    else return invalid("limit_invalid", "Limit must be an integer between 1 and 100.");
    if (limit < 1 || limit > 100)
      return invalid("limit_invalid", "Limit must be an integer between 1 and 100.");
  }
  let cursor: string | undefined;
  if (Object.hasOwn(query, "cursor")) {
    if (typeof query.cursor !== "string" || !query.cursor || query.cursor.length > 4096)
      return invalid("cursor_invalid", "Pagination cursor is invalid.");
    cursor = query.cursor;
  }
  let parsed: unknown = Object.create(null);
  if (Object.hasOwn(query, "filter")) {
    if (typeof query.filter !== "string" || Buffer.byteLength(query.filter, "utf8") > contactFilterJsonLimit)
      return invalid("filter_invalid", "Filter must be bounded valid LeadFilter JSON.");
    try {
      parsed = JSON.parse(query.filter);
    } catch {
      return invalid("filter_invalid", "Filter must be bounded valid LeadFilter JSON.");
    }
  }
  // JSON parsing does not execute hooks; null object prototypes keep inherited fields out of schema reads.
  let nodes = 0;
  const detach = (value: unknown, depth: number): unknown => {
    if (++nodes > 200 || depth > 4)
      return invalid("filter_invalid", "Filter must be bounded valid LeadFilter JSON.");
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") {
      if (/[\uD800-\uDFFF]/u.test(value))
        return invalid("filter_invalid", "Filter must contain valid Unicode text.");
      return value;
    }
    if (!value || typeof value !== "object")
      return invalid("filter_invalid", "Filter must be bounded valid LeadFilter JSON.");
    if (Array.isArray(value)) {
      const array = new Array(value.length);
      for (let index = 0; index < value.length; index++)
        Object.defineProperty(array, String(index), {
          value: detach(value[index], depth + 1),
          enumerable: true,
        });
      return Object.freeze(array);
    }
    const object: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value))
      Object.defineProperty(object, key, {
        value: detach((value as Record<string, unknown>)[key], depth + 1),
        enumerable: true,
      });
    return Object.freeze(object);
  };
  const filter = detach(parsed, 0);
  validateSchema("LeadFilter", filter);
  if (Object.keys(filter as LeadFilter).some((key) => !["q", "ownerMemberId", "tagIds"].includes(key)))
    return invalid("filter_not_available", "This filter is not implemented for contacts.");
  return Object.freeze({ limit, cursor, filter: filter as Readonly<LeadFilter> });
}
