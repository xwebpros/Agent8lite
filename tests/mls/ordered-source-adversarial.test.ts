import { describe, expect, it } from "vitest";
import type { OrderedMockSourceInput } from "../../packages/contracts/internal/ordered-mock-source-port";
import {
  createOrderedMockSource,
  isOrderedMockSourceResult,
  OrderedMockSourceError,
} from "../../packages/mls/ordered-source";
import type { FeedContext } from "../../packages/providers/mls/port";

const context: FeedContext = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  feedId: "20000000-0000-4000-8000-000000000001",
  policyVersion: "ordered-adversarial-policy-v1",
};
const options: OrderedMockSourceInput = { cursor: null, watermark: null, overlapSeconds: 0, limit: 2 };
type Result = Awaited<ReturnType<ReturnType<typeof createOrderedMockSource>["readOrderedChanges"]>>;
const read = (input: OrderedMockSourceInput = options) =>
  createOrderedMockSource(context).readOrderedChanges(context, input);

function captured<T>(operation: () => T) {
  try {
    return { value: operation(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function withInherited<T>(
  prototype: object,
  key: string,
  descriptor: PropertyDescriptor,
  operation: () => T,
) {
  const original = Object.getOwnPropertyDescriptor(prototype, key);
  Object.defineProperty(prototype, key, { configurable: true, ...descriptor });
  try {
    return captured(operation);
  } finally {
    if (original) Object.defineProperty(prototype, key, original);
    else Reflect.deleteProperty(prototype, key);
  }
}

function exercise(expected: Result) {
  const source = createOrderedMockSource(context);
  return {
    pending: source.readOrderedChanges(context, options),
    accepted: isOrderedMockSourceResult(context, options, expected),
    generation: source.generation,
  };
}

describe("ordered source inherited-hook and closed-authority boundaries", () => {
  const hooks = (["Object", "Array"] as const).flatMap((prototype) =>
    (["function", "getter"] as const).flatMap((kind) =>
      [false, true].map((enumerable) => ({ prototype, kind, enumerable })),
    ),
  );
  it.each(hooks)(
    "ignores inherited $prototype $kind serialization hooks (enumerable=$enumerable) on read and verification",
    async ({ prototype, kind, enumerable }) => {
      const expected = await read();
      let reads = 0,
        calls = 0;
      const hook = () => {
        calls++;
        return "PRIVATE_SOURCE_SERIALIZATION_REPLACEMENT";
      };
      const descriptor: PropertyDescriptor =
        kind === "function"
          ? { value: hook, writable: true, enumerable }
          : {
              get: () => {
                reads++;
                return hook;
              },
              enumerable,
            };
      const result = withInherited(
        prototype === "Object" ? Object.prototype : Array.prototype,
        "toJSON",
        descriptor,
        () => exercise(expected),
      );
      // The read runs synchronously before returning its promise. Await/assert only after cleanup.
      const pending = await result.value?.pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      expect(reads).toBe(0);
      expect(calls).toBe(0);
      expect(result.error).toBeUndefined();
      expect(pending?.error).toBeUndefined();
      expect(pending?.value).toEqual(expected);
      expect(result.value?.accepted).toBe(true);
      expect(result.value?.generation).toBe(expected.proof.generation);
    },
  );

  const pollution = (["Object", "Array"] as const).flatMap((prototype) =>
    (["data", "getter"] as const).map((kind) => ({ prototype, kind })),
  );
  it.each(pollution)(
    "uses only own schema data despite inherited $prototype $kind validator pollution",
    async ({ prototype, kind }) => {
      const expected = await read();
      let reads = 0;
      const descriptor: PropertyDescriptor =
        kind === "data"
          ? { value: "PRIVATE_SOURCE_INHERITED_FIELD", enumerable: true }
          : {
              get: () => {
                reads++;
                throw new Error("PRIVATE_SOURCE_INHERITED_GETTER");
              },
              enumerable: true,
            };
      const result = withInherited(
        prototype === "Object" ? Object.prototype : Array.prototype,
        "unregisteredSourceAuthority",
        descriptor,
        () => exercise(expected),
      );
      const pending = await result.value?.pending.then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      expect(reads).toBe(0);
      expect(result.error).toBeUndefined();
      expect(pending?.error).toBeUndefined();
      expect(pending?.value).toEqual(expected);
      expect(result.value?.accepted).toBe(true);
      expect(JSON.stringify(pending?.value)).not.toContain("PRIVATE_SOURCE");
    },
  );

  it.each(["context", "input", "proof"] as const)(
    "never treats an inherited required %s field as source evidence",
    async (boundary) => {
      const expected = await read();
      const missingContext = { ...context } as Partial<FeedContext>;
      Reflect.deleteProperty(missingContext, "policyVersion");
      const missingInput = { ...options } as Partial<OrderedMockSourceInput>;
      Reflect.deleteProperty(missingInput, "limit");
      const missingProof = structuredClone(expected) as {
        page: Result["page"];
        proof: Partial<Result["proof"]>;
      };
      Reflect.deleteProperty(missingProof.proof, "schemaVersion");
      let reads = 0;
      const key = boundary === "context" ? "policyVersion" : boundary === "input" ? "limit" : "schemaVersion";
      const result = withInherited(
        Object.prototype,
        key,
        {
          get: () => {
            reads++;
            throw new Error("PRIVATE_SOURCE_REQUIRED_FIELD_GETTER");
          },
        },
        () =>
          boundary === "context"
            ? createOrderedMockSource(missingContext)
            : boundary === "input"
              ? read(missingInput as OrderedMockSourceInput)
              : isOrderedMockSourceResult(context, options, missingProof),
      );
      const failure =
        boundary === "input"
          ? await (result.value as Promise<Result>).then(
              () => undefined,
              (error: unknown) => error,
            )
          : result.error;
      expect(reads).toBe(0);
      if (boundary === "proof") expect(result.value).toBe(false);
      else {
        expect(failure).toBeInstanceOf(OrderedMockSourceError);
        expect(failure).toHaveProperty(
          "code",
          boundary === "context" ? "ordered_context_invalid" : "ordered_input_invalid",
        );
        expect(String(failure)).not.toContain("PRIVATE_SOURCE");
      }
    },
  );

  it.each(["context", "input", "proof"] as const)(
    "rejects a revoked %s proxy with safe closed behavior",
    async (boundary) => {
      const expected = await read();
      const revoked = Proxy.revocable(
        boundary === "context" ? context : boundary === "input" ? options : expected,
        {},
      );
      revoked.revoke();
      if (boundary === "context") {
        expect(() => createOrderedMockSource(revoked.proxy)).toThrow("ordered_context_invalid");
      } else if (boundary === "input") {
        await expect(read(revoked.proxy as OrderedMockSourceInput)).rejects.toHaveProperty(
          "message",
          "ordered_input_invalid",
        );
      } else expect(isOrderedMockSourceResult(context, options, revoked.proxy)).toBe(false);
    },
  );

  it("denies page/proof splicing and valid pages replayed at another registered boundary", async () => {
    const initial = await read();
    const continuation = { ...options, cursor: initial.page.nextOpaqueCursor };
    const next = await read(continuation);
    expect(isOrderedMockSourceResult(context, options, initial)).toBe(true);
    expect(isOrderedMockSourceResult(context, continuation, next)).toBe(true);
    expect(isOrderedMockSourceResult(context, continuation, initial)).toBe(false);
    expect(isOrderedMockSourceResult(context, options, next)).toBe(false);
    expect(isOrderedMockSourceResult(context, options, { page: initial.page, proof: next.proof })).toBe(
      false,
    );
    expect(isOrderedMockSourceResult(context, continuation, { page: next.page, proof: initial.proof })).toBe(
      false,
    );
  });

  it("rejects cyclic own data without leaking object contents or errors", async () => {
    const cyclic: Record<string, unknown> = { private: "PRIVATE_SOURCE_CYCLE" };
    cyclic.self = cyclic;
    expect(() => createOrderedMockSource(cyclic)).toThrow("ordered_context_invalid");
    await expect(read(cyclic as unknown as OrderedMockSourceInput)).rejects.toHaveProperty(
      "message",
      "ordered_input_invalid",
    );
    expect(isOrderedMockSourceResult(context, options, cyclic)).toBe(false);
  });
});
