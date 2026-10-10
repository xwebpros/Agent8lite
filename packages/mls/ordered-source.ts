import { createHash } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import proofSchema from "../contracts/internal/mock-replication-source-proof-v1.schema.json";
import type {
  OrderedMockSourceInput,
  OrderedMockSourcePort,
  OrderedMockSourceProofV1,
} from "../contracts/internal/ordered-mock-source-port";
import type { ChangePage, FeedContext, SourceChange } from "../providers/mls/port";
import { isUuid } from "./contracts";
import fixtureAsset from "./fixtures/ordered-synthetic-v1.json";
import {
  closed,
  integer,
  isReplicationContext,
  isSyntheticCanonical,
  record,
  text,
  timestamp,
} from "./replication-validation";

type SourceResult = Readonly<{ page: ChangePage; proof: OrderedMockSourceProofV1 }>;
type ManifestEntry = Readonly<{
  changeId: string;
  sequence: number;
  observedAt: string;
  change: SourceChange;
}>;
type Manifest = Readonly<{
  schemaVersion: 1;
  profile: "ordered-synthetic-v1";
  generation: string;
  completedWatermark: string;
  pricingCurrency: "USD";
  changes: readonly ManifestEntry[];
}>;

export class OrderedMockSourceError extends Error {
  constructor(
    readonly code:
      | "ordered_context_invalid"
      | "ordered_input_invalid"
      | "ordered_cursor_invalid"
      | "ordered_source_invalid",
  ) {
    super(code);
  }
}

/** Reject hooks/proxies before reading values; only detached bounded own data reaches validators. */
function detached<T>(value: T): T {
  let nodes = 0;
  let bytes = 0;
  const reject = () => {
    throw new OrderedMockSourceError("ordered_source_invalid");
  };
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 40000 || depth > 12) return reject();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      if (item.length > 25000 || bytes > 3000000) return reject();
      return item;
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
      if (!integer(length, 0, 500) || keys.length !== length + 1) return reject();
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

function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** JSON.stringify is used on primitives only, never on a caller's object or toJSON hook. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const changeId = (value: unknown) => text(value, 200) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const numeric = (value: number | null, maximum: number, precision: number) =>
  value === null ||
  (value >= 0 &&
    value <= maximum &&
    new RegExp("^\\d+(?:\\.\\d{1," + precision + "})?$").test(String(value)));

function validChange(value: unknown): value is SourceChange {
  if (!record(value) || !text(value.sourceListingKey, 200)) return false;
  if (!value.sourceListingKey.startsWith("SYNTHETIC-")) return false;
  if (value.kind === "delete") return closed(value, ["kind", "sourceListingKey"]);
  if (value.kind !== "upsert" || !closed(value, ["kind", "sourceListingKey", "listing"])) return false;
  const listing = value.listing;
  return (
    isSyntheticCanonical(listing) &&
    listing.sourceListingKey === value.sourceListingKey &&
    (listing.bedrooms === null || integer(listing.bedrooms, 0, 2147483647)) &&
    numeric(listing.listPrice, 999999999999.99, 2) &&
    numeric(listing.bathrooms, 999.9, 1) &&
    (listing.area === null ||
      (listing.area.unit === "sqft" && numeric(listing.area.value, 9999999999.99, 2))) &&
    Date.parse(listing.expiresAt) > Date.parse(listing.ingestedAt)
  );
}

function registeredManifest(value: unknown): Manifest {
  const fail = () => {
    throw new OrderedMockSourceError("ordered_source_invalid");
  };
  if (
    !record(value) ||
    !closed(value, [
      "schemaVersion",
      "profile",
      "generation",
      "completedWatermark",
      "pricingCurrency",
      "changes",
    ]) ||
    value.schemaVersion !== 1 ||
    value.profile !== "ordered-synthetic-v1" ||
    !isUuid(value.generation) ||
    !timestamp(value.completedWatermark) ||
    value.pricingCurrency !== "USD" ||
    !Array.isArray(value.changes) ||
    !integer(value.changes.length, 1, 500)
  )
    return fail();
  const ids = new Set<string>();
  let sequence = 0;
  let observed = -Infinity;
  for (const entry of value.changes) {
    if (
      !record(entry) ||
      !closed(entry, ["changeId", "sequence", "observedAt", "change"]) ||
      !changeId(entry.changeId) ||
      !integer(entry.sequence, 1, Number.MAX_SAFE_INTEGER) ||
      entry.sequence <= sequence ||
      ids.has(entry.changeId as string) ||
      !timestamp(entry.observedAt) ||
      Date.parse(entry.observedAt) < observed ||
      Date.parse(entry.observedAt) > Date.parse(value.completedWatermark) ||
      !validChange(entry.change) ||
      (entry.change.kind === "upsert" &&
        Date.parse(entry.change.listing!.ingestedAt) > Date.parse(entry.observedAt))
    )
      return fail();
    ids.add(entry.changeId as string);
    sequence = entry.sequence;
    observed = Date.parse(entry.observedAt);
  }
  return frozen(value as unknown as Manifest);
}

const manifest = registeredManifest(detached(fixtureAsset));
export const ORDERED_MOCK_SOURCE_PROFILE = manifest.profile;
export const ORDERED_MOCK_SOURCE_GENERATION = manifest.generation;
export const ORDERED_MOCK_SOURCE_WATERMARK = manifest.completedWatermark;
const ajv = new Ajv2020({ strict: true, allErrors: false, ownProperties: true });
addFormats(ajv);
const validProof = ajv.compile<OrderedMockSourceProofV1>(proofSchema);

function boundContext(value: unknown): FeedContext {
  try {
    const context = detached(value);
    if (isReplicationContext(context)) return frozen(context);
  } catch {
    // Keep hook/private exception text out of the port's safe failure.
  }
  throw new OrderedMockSourceError("ordered_context_invalid");
}

function readInput(value: unknown): OrderedMockSourceInput {
  try {
    const input = detached(value);
    if (
      record(input) &&
      closed(input, ["cursor", "watermark", "overlapSeconds", "limit"]) &&
      (input.cursor === null ||
        (text(input.cursor, 8192) && Buffer.byteLength(input.cursor, "utf8") <= 8192)) &&
      (input.watermark === null ||
        (timestamp(input.watermark) &&
          Date.parse(input.watermark) <= Date.parse(manifest.completedWatermark))) &&
      integer(input.overlapSeconds, 0, 86400) &&
      integer(input.limit, 1, 100)
    )
      return frozen(input as unknown as OrderedMockSourceInput);
  } catch {
    // Caller hooks are rejected without running them.
  }
  throw new OrderedMockSourceError("ordered_input_invalid");
}

function resultFor(context: FeedContext, input: OrderedMockSourceInput): SourceResult {
  const cutoff =
    input.watermark === null ? -Infinity : Date.parse(input.watermark) - input.overlapSeconds * 1000;
  const selected = manifest.changes.filter((entry) => Date.parse(entry.observedAt) > cutoff);
  const boundaries = new Map<string, number>();
  for (let start = input.limit; start < selected.length; start += input.limit) {
    const token =
      manifest.profile +
      "." +
      digest({
        context,
        generation: manifest.generation,
        watermark: input.watermark,
        overlapSeconds: input.overlapSeconds,
        limit: input.limit,
        previousChangeId: selected[start - 1].changeId,
        nextChangeId: selected[start].changeId,
      });
    boundaries.set(token, start);
  }
  const start = input.cursor === null ? 0 : boundaries.get(input.cursor);
  if (start === undefined) throw new OrderedMockSourceError("ordered_cursor_invalid");
  const entries = selected.slice(start, start + input.limit);
  const nextStart = start + entries.length;
  const nextCursor = [...boundaries].find(([, position]) => position === nextStart)?.[0] ?? null;
  const page: ChangePage = {
    changes: entries.map((entry) => detached(entry.change)),
    nextOpaqueCursor: nextCursor,
    completedWatermark: nextCursor === null ? manifest.completedWatermark : null,
  };
  const proof: OrderedMockSourceProofV1 = {
    schemaVersion: 1,
    profile: manifest.profile,
    context: detached(context),
    generation: manifest.generation,
    pageDigest: digest(page),
    entries: entries.map((entry, index) => ({
      index,
      changeId: entry.changeId,
      sequence: entry.sequence,
    })),
  };
  if (!validProof(proof)) throw new OrderedMockSourceError("ordered_source_invalid");
  return frozen({ page, proof });
}

/** Fixed repository manifest only; no custom source, append, generation or clock option exists. */
export function createOrderedMockSource(context: unknown): OrderedMockSourcePort {
  const bound = boundContext(context);
  return Object.freeze({
    profile: manifest.profile,
    generation: manifest.generation,
    async readOrderedChanges(current: FeedContext, input: OrderedMockSourceInput): Promise<SourceResult> {
      if (canonical(boundContext(current)) !== canonical(bound))
        throw new OrderedMockSourceError("ordered_context_invalid");
      return resultFor(bound, readInput(input));
    },
  });
}

/** Content evidence only. Callers must independently verify actor, feed rights and SQL receipts. */
export function isOrderedMockSourceResult(
  context: unknown,
  input: unknown,
  value: unknown,
): value is SourceResult {
  try {
    const bound = boundContext(context);
    const options = readInput(input);
    const result = detached(value);
    if (
      !record(result) ||
      !closed(result, ["page", "proof"]) ||
      !validProof(result.proof) ||
      !record(result.page) ||
      !closed(result.page, ["changes", "nextOpaqueCursor", "completedWatermark"]) ||
      !Array.isArray(result.page.changes) ||
      result.page.changes.length > options.limit ||
      !result.page.changes.every(validChange) ||
      result.proof.pageDigest !== digest(result.page)
    )
      return false;
    // The schema cannot prove identity uniqueness, indices, or correspondence to the registered source.
    // Exact reconstruction also binds context/options, generation, final watermark and opaque boundary.
    return canonical(result) === canonical(resultFor(bound, options));
  } catch {
    return false;
  }
}
