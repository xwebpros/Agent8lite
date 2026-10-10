import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import proofSchema from "../../packages/contracts/internal/mock-replication-source-proof-v1.schema.json";
import type { OrderedMockSourceInput } from "../../packages/contracts/internal/ordered-mock-source-port";
import {
  createOrderedMockSource,
  isOrderedMockSourceResult,
  ORDERED_MOCK_SOURCE_GENERATION,
  ORDERED_MOCK_SOURCE_PROFILE,
  ORDERED_MOCK_SOURCE_WATERMARK,
  OrderedMockSourceError,
} from "../../packages/mls/ordered-source";
import { isSyntheticCanonical } from "../../packages/mls/replication-validation";
import type { FeedContext } from "../../packages/providers/mls/port";

const context: FeedContext = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  feedId: "20000000-0000-4000-8000-000000000001",
  policyVersion: "ordered-fixture-policy-v1",
};
const options: OrderedMockSourceInput = { cursor: null, watermark: null, overlapSeconds: 30, limit: 2 };
type Result = Awaited<ReturnType<ReturnType<typeof createOrderedMockSource>["readOrderedChanges"]>>;
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
const ajv = new Ajv2020({ strict: true });
addFormats(ajv);
const schemaValid = ajv.compile(proofSchema);
const read = (input: unknown = options) =>
  createOrderedMockSource(context).readOrderedChanges(context, input as OrderedMockSourceInput);
const copy = (value: Result) => structuredClone(value) as Mutable<Result>;

// Independent canonical digest calculation; primitives alone reach JSON.stringify.
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const pageDigest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
async function cycle(input: OrderedMockSourceInput = options) {
  const results: Result[] = [];
  let cursor = input.cursor;
  do {
    const current = { ...input, cursor };
    // Each page uses a fresh factory, so continuations cannot depend on local mutable state.
    const result = await read(current);
    expect(schemaValid(result.proof)).toBe(true);
    expect(isOrderedMockSourceResult(context, current, result)).toBe(true);
    expect(result.proof.pageDigest).toBe(pageDigest(result.page));
    results.push(result);
    cursor = result.page.nextOpaqueCursor;
    expect(results.length).toBeLessThanOrEqual(7);
  } while (cursor !== null);
  return results;
}

describe("registered immutable ordered synthetic source", () => {
  it("uses explicit noncontiguous source identities, fixed generation, and canonical USD fixtures", async () => {
    const pages = await cycle();
    expect(ORDERED_MOCK_SOURCE_PROFILE).toBe("ordered-synthetic-v1");
    expect(ORDERED_MOCK_SOURCE_GENERATION).toBe("5d753531-7ad1-4bc4-87a2-036cf442f527");
    expect(ORDERED_MOCK_SOURCE_WATERMARK).toBe("2026-10-10T00:10:00Z");
    expect(pages.map((page) => page.page.changes.length)).toEqual([2, 2, 2, 1]);
    expect(pages.flatMap((page) => page.proof.entries.map((entry) => entry.sequence))).toEqual([
      10, 25, 60, 90, 130, 210, 300,
    ]);
    expect(new Set(pages.flatMap((page) => page.proof.entries.map((entry) => entry.changeId))).size).toBe(7);
    expect(pages.slice(0, -1).every((page) => page.page.completedWatermark === null)).toBe(true);
    expect(pages.at(-1)!.page.completedWatermark).toBe(ORDERED_MOCK_SOURCE_WATERMARK);
    for (const change of pages.flatMap((page) => page.page.changes)) {
      if (change.kind === "upsert") {
        expect(isSyntheticCanonical(change.listing)).toBe(true);
        expect(change.listing!.area!.unit).toBe("sqft");
        expect(Number.isInteger(change.listing!.bedrooms)).toBe(true);
        expect(change.listing!.attribution.disclaimer).toContain("SYNTHETIC");
      } else expect(Object.keys(change).sort()).toEqual(["kind", "sourceListingKey"]);
    }
  });

  it("keeps tied and null source timestamps independent of availability/deletion identity", async () => {
    const all = await read({ ...options, limit: 100 });
    const changes = all.page.changes;
    expect(changes[0].listing!.status).toBe("active");
    expect(changes[2].listing!.status).toBe("pending");
    expect(changes[0].listing!.sourceModifiedAt).toBe(changes[2].listing!.sourceModifiedAt);
    expect(all.proof.entries[0].changeId).not.toBe(all.proof.entries[2].changeId);
    expect(changes[1].listing!.sourceModifiedAt).toBeNull();
    expect(changes[3]).toEqual({ kind: "delete", sourceListingKey: changes[0].sourceListingKey });
    expect(changes[4]).toEqual({ kind: "delete", sourceListingKey: "SYNTHETIC-ORDERED-NEVER-SEEN" });
    expect(
      changes.some(
        (change) => change.kind === "upsert" && change.sourceListingKey === changes[4].sourceListingKey,
      ),
    ).toBe(false);
    expect(changes[5].listing!.status).toBe("off_market");
    expect(changes[6].listing!.status).toBe("closed");
    expect(changes[0].listing!.attribution.contact!.kind).toBe("email");
    expect(changes[1].listing!.attribution.contact!.kind).toBe("phone");
  });

  it.each([1, 3, 7, 100])(
    "reconstructs complete cycles and exact continuation replay at limit %s",
    async (limit) => {
      const input = { ...options, limit };
      const first = await cycle(input);
      expect(await cycle(input)).toEqual(first);
      expect(first.flatMap((result) => result.page.changes)).toHaveLength(7);
      if (first[0].page.nextOpaqueCursor) {
        const next = { ...input, cursor: first[0].page.nextOpaqueCursor };
        expect(await read(next)).toEqual(await read(next));
      }
    },
  );

  it("reproduces a continuation exactly in two separate Node processes", async () => {
    const initial = await read();
    const input = { ...options, cursor: initial.page.nextOpaqueCursor };
    const program =
      'const {createOrderedMockSource}=require("./packages/mls/ordered-source.ts");' +
      "const context=" +
      JSON.stringify(context) +
      ";" +
      "createOrderedMockSource(context).readOrderedChanges(context," +
      JSON.stringify(input) +
      ").then(result=>process.stdout.write(JSON.stringify(result))).catch(()=>process.exit(1));";
    const restart = () =>
      JSON.parse(
        execFileSync(process.execPath, ["--import", "tsx", "--eval", program], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        }),
      );
    expect(restart()).toEqual(await read(input));
    expect(restart()).toEqual(await read(input));
  });

  it("preserves fixed ingestion, expiry, generation, and proof after wall clock changes", async () => {
    const first = await read({ ...options, limit: 100 });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
      const later = await read({ ...options, limit: 100 });
      expect(later).toEqual(first);
      expect(later.page.changes[0].listing!.ingestedAt).toBe("2026-10-10T00:01:00Z");
      expect(later.page.changes[0].listing!.expiresAt).toBe("2026-10-11T00:01:00Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns detached frozen data and keeps factory bindings after caller mutation", async () => {
    const caller = { ...context };
    const source = createOrderedMockSource(caller);
    caller.policyVersion = "changed-after-bind";
    const input = { ...options };
    const pending = source.readOrderedChanges(context, input);
    input.limit = 100;
    const first = await pending;
    const second = await source.readOrderedChanges(context, options);
    expect(first).toEqual(second);
    expect(first.page).not.toBe(second.page);
    expect(first.proof.context).not.toBe(context);
    expect(first.page.changes[0].listing).not.toBe(second.page.changes[0].listing);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(first.page.changes[0].listing!.attribution.contact)).toBe(true);
    expect(Object.isFrozen(first.proof.entries[0])).toBe(true);
    expect(Reflect.set(first.proof, "generation", context.feedId)).toBe(false);
    expect(Reflect.set(first.page.changes[0].listing!, "expiresAt", "2040-01-01T00:00:00Z")).toBe(false);
    expect(Reflect.set(source, "generation", context.feedId)).toBe(false);
    expect(await source.readOrderedChanges(context, options)).toEqual(first);
    await expect(source.readOrderedChanges(caller, options)).rejects.toHaveProperty(
      "code",
      "ordered_context_invalid",
    );
  });
});

describe("fixed observation watermark selection and opaque boundaries", () => {
  it.each([
    ["2026-10-10T00:03:00Z", 0, [90, 130, 210, 300]],
    ["2026-10-10T00:03:00Z", 60, [60, 90, 130, 210, 300]],
    ["2026-10-10T00:10:00Z", 180, []],
    ["2026-10-10T00:10:00Z", 181, [300]],
  ] as const)(
    "selects by observedAt after %s minus %s overlap",
    async (watermark, overlapSeconds, expected) => {
      const result = await read({ ...options, limit: 100, watermark, overlapSeconds });
      expect(result.proof.entries.map((entry) => entry.sequence)).toEqual(expected);
      expect(result.page.completedWatermark).toBe(ORDERED_MOCK_SOURCE_WATERMARK);
    },
  );

  it("returns a closed valid empty completed page without minting source identity", async () => {
    const input = { ...options, watermark: ORDERED_MOCK_SOURCE_WATERMARK, overlapSeconds: 0 };
    const result = await read(input);
    expect(result.page).toEqual({
      changes: [],
      nextOpaqueCursor: null,
      completedWatermark: ORDERED_MOCK_SOURCE_WATERMARK,
    });
    expect(result.proof.entries).toEqual([]);
    expect(isOrderedMockSourceResult(context, input, result)).toBe(true);
    expect(await read(input)).toEqual(result);
  });

  it.each(["organizationId", "feedId", "policyVersion"] as const)("binds cursor to %s", async (field) => {
    const first = await read();
    const changed = {
      ...context,
      [field]: field === "policyVersion" ? "other-policy" : "30000000-0000-4000-8000-000000000001",
    };
    await expect(
      createOrderedMockSource(changed).readOrderedChanges(changed, {
        ...options,
        cursor: first.page.nextOpaqueCursor,
      }),
    ).rejects.toHaveProperty("code", "ordered_cursor_invalid");
    await expect(
      createOrderedMockSource(context).readOrderedChanges(changed, options),
    ).rejects.toHaveProperty("code", "ordered_context_invalid");
  });

  it.each([{ limit: 1 }, { overlapSeconds: 31 }, { watermark: "2026-10-10T00:00:00Z" }])(
    "binds continuation to original options %j",
    async (change) => {
      const first = await read();
      await expect(
        read({ ...options, ...change, cursor: first.page.nextOpaqueCursor }),
      ).rejects.toHaveProperty("code", "ordered_cursor_invalid");
    },
  );

  it.each(["0", "2", "offset:2", "ordered-synthetic-v1." + "0".repeat(64), "x".repeat(8192)])(
    "rejects unregistered opaque cursor %s",
    async (cursor) => {
      await expect(read({ ...options, cursor })).rejects.toHaveProperty("code", "ordered_cursor_invalid");
    },
  );

  it.each([
    { cursor: "" },
    { cursor: "x".repeat(8193) },
    { cursor: "😀".repeat(2049) },
    { cursor: 2 },
    { watermark: "2026-10-10T00:10:00.001Z" },
    { watermark: "2026-10-10T00:00:00+00:00" },
    { watermark: "2026-02-30T00:00:00Z" },
    { watermark: "" },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: NaN },
    { overlapSeconds: -1 },
    { overlapSeconds: 86401 },
    { overlapSeconds: 0.1 },
    { overlapSeconds: Infinity },
    { overlapSeconds: -0 },
    { unsupported: true },
  ])("rejects closed input/byte/time bounds %j", async (change) => {
    await expect(read({ ...options, ...change })).rejects.toHaveProperty("code", "ordered_input_invalid");
  });

  it.each([null, [], {}, { ...options, cursor: undefined }])("rejects incomplete input %j", async (input) => {
    await expect(read(input)).rejects.toBeInstanceOf(OrderedMockSourceError);
  });
});

describe("own data and relational source proof validation", () => {
  it.each([
    null,
    [],
    {},
    { ...context, organizationId: "caller-tenant" },
    { ...context, policyVersion: " " },
    { ...context, policyVersion: "x".repeat(201) },
    { ...context, extra: true },
    Object.create(context),
  ])("rejects malformed or inherited factory context %j", (value) => {
    expect(() => createOrderedMockSource(value)).toThrow("ordered_context_invalid");
  });

  it("never invokes accessor, serialization, inherited, or proxy hooks", async () => {
    const hook = vi.fn(() => {
      throw new Error("private hook text");
    });
    const getter = Object.defineProperty({ ...context }, "feedId", { enumerable: true, get: hook });
    const serialization = { ...context, toJSON: hook };
    const hidden = Object.defineProperty({ ...context }, "private", { value: "hidden" });
    const symbol = { ...context, [Symbol("private")]: "hidden" };
    const proxy = new Proxy(context, { get: hook, getPrototypeOf: hook, ownKeys: hook });
    for (const value of [getter, serialization, hidden, symbol, proxy, new Date()]) {
      expect(() => createOrderedMockSource(value)).toThrow("ordered_context_invalid");
    }
    const input = Object.defineProperty({ ...options }, "cursor", { enumerable: true, get: hook });
    await expect(read(input)).rejects.toHaveProperty("message", "ordered_input_invalid");
    const result = copy(await read());
    Object.defineProperty(result.page.changes[0].listing!, "address", { enumerable: true, get: hook });
    expect(isOrderedMockSourceResult(context, options, result)).toBe(false);
    expect(isOrderedMockSourceResult(context, options, new Proxy(result, { ownKeys: hook }))).toBe(false);
    expect(hook).not.toHaveBeenCalled();
  });

  const alterations: [string, (result: Mutable<Result>) => void][] = [
    ["extra result field", (result) => Object.assign(result, { raw: "private" })],
    ["extra proof field", (result) => Object.assign(result.proof, { credential: "private" })],
    ["extra page field", (result) => Object.assign(result.page, { raw: "private" })],
    ["wrong schema version", (result) => Object.assign(result.proof, { schemaVersion: 2 })],
    ["wrong profile", (result) => Object.assign(result.proof, { profile: "live" })],
    [
      "wrong generation",
      (result) => {
        result.proof.generation = context.feedId;
      },
    ],
    [
      "wrong context",
      (result) => {
        result.proof.context.feedId = context.organizationId;
      },
    ],
    [
      "duplicate index",
      (result) => {
        result.proof.entries[1].index = 0;
      },
    ],
    [
      "duplicate identity",
      (result) => {
        result.proof.entries[1].changeId = result.proof.entries[0].changeId;
      },
    ],
    [
      "duplicate sequence",
      (result) => {
        result.proof.entries[1].sequence = result.proof.entries[0].sequence;
      },
    ],
    [
      "unregistered identity",
      (result) => {
        result.proof.entries[0].changeId = "SYNTHETIC-OTHER";
      },
    ],
    [
      "unregistered sequence",
      (result) => {
        result.proof.entries[0].sequence = 11;
      },
    ],
    [
      "bad identity pattern",
      (result) => {
        result.proof.entries[0].changeId = "private / id";
      },
    ],
    [
      "out of range index",
      (result) => {
        result.proof.entries[0].index = 100;
      },
    ],
    [
      "unsafe sequence",
      (result) => {
        result.proof.entries[0].sequence = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "missing identity",
      (result) => {
        result.proof.entries.pop();
      },
    ],
    [
      "extra identity",
      (result) => {
        result.proof.entries.push({ ...result.proof.entries[0], index: 2 });
      },
    ],
    [
      "reordered source",
      (result) => {
        result.page.changes.reverse();
        result.proof.entries.reverse();
      },
    ],
    [
      "foreign key",
      (result) => {
        result.page.changes[0].sourceListingKey = "SYNTHETIC-OTHER";
      },
    ],
    [
      "nonsynthetic listing",
      (result) => {
        result.page.changes[0].listing!.synthetic = false;
      },
    ],
    [
      "private canonical field",
      (result) => Object.assign(result.page.changes[0].listing!, { ownerEmail: "private" }),
    ],
    ["fixture labels", (result) => Object.assign(result.page.changes[0].listing!, { name: "Synthetic" })],
    [
      "renewed ingestion",
      (result) => {
        result.page.changes[0].listing!.ingestedAt = "2026-10-10T00:02:00Z";
      },
    ],
    [
      "renewed expiry",
      (result) => {
        result.page.changes[0].listing!.expiresAt = "2040-01-01T00:00:00Z";
      },
    ],
    [
      "fractional bedrooms",
      (result) => {
        result.page.changes[0].listing!.bedrooms = 1.5;
      },
    ],
    [
      "unsupported area",
      (result) => {
        result.page.changes[0].listing!.area!.unit = "sqm";
      },
    ],
    [
      "bad contact",
      (result) => {
        result.page.changes[1].listing!.attribution.contact = { kind: "phone", value: "123 x123456" };
      },
    ],
    [
      "changed content",
      (result) => {
        result.page.changes[0].listing!.listPrice = 999;
      },
    ],
    [
      "delete with canonical payload",
      (result) => {
        result.page.changes[0].kind = "delete";
      },
    ],
    [
      "invented final watermark",
      (result) => {
        result.page.completedWatermark = ORDERED_MOCK_SOURCE_WATERMARK;
      },
    ],
    [
      "forged next boundary",
      (result) => {
        result.page.nextOpaqueCursor = "offset:4";
      },
    ],
  ];
  it.each(alterations)("rejects %s even with a recomputed page digest", async (_name, alter) => {
    const result = copy(await read());
    alter(result);
    result.proof.pageDigest = pageDigest(result.page);
    expect(isOrderedMockSourceResult(context, options, result)).toBe(false);
  });

  it("accepts detached own data in another key order without trusting its claimed authority", async () => {
    const result = copy(await read());
    result.proof.context = {
      policyVersion: context.policyVersion,
      feedId: context.feedId,
      organizationId: context.organizationId,
    };
    result.page.changes[0].listing = Object.fromEntries(
      Object.entries(result.page.changes[0].listing!).reverse(),
    ) as NonNullable<Mutable<Result>["page"]["changes"][number]["listing"]>;
    expect(isOrderedMockSourceResult(context, options, result)).toBe(true);
    expect(isOrderedMockSourceResult(context, { ...options, limit: 1 }, result)).toBe(false);
    expect(isOrderedMockSourceResult({ ...context, policyVersion: "other-policy" }, options, result)).toBe(
      false,
    );
  });

  it("rejects sparse/augmented arrays, nonfinite data, excessive entries and digest mismatch", async () => {
    const initial = await read();
    const sparse = copy(initial);
    delete sparse.proof.entries[0];
    const augmented = copy(initial);
    Object.assign(augmented.page.changes, { raw: "private" });
    const nonfinite = copy(initial);
    nonfinite.page.changes[0].listing!.listPrice = Infinity;
    const huge = copy(initial);
    huge.proof.entries = Array.from({ length: 501 }, () => ({ ...huge.proof.entries[0] }));
    const mismatch = copy(initial);
    mismatch.proof.pageDigest = "0".repeat(64);
    for (const result of [sparse, augmented, nonfinite, huge, mismatch])
      expect(isOrderedMockSourceResult(context, options, result)).toBe(false);
  });
});
