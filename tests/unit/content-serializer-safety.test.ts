import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContentValidationError,
  inspectDraft,
  renderRegisteredBlocks,
  validateForPublication,
} from "../../packages/templates/registry";

const policy = { approvedLinkOrigins: new Set(["https://approved.example.test"]) };
const revision = () => ({
  schemaVersion: 1,
  blocks: [
    {
      id: randomUUID(),
      type: "hero",
      props: {
        heading: 'Safe & "exact" content',
        action: { label: "Contact's page", href: "/contact?buyer=1&source=test" },
      },
    },
    {
      id: randomUUID(),
      type: "text",
      props: { paragraphs: ["First paragraph.", "A second paragraph with emoji 😀."] },
    },
    {
      id: randomUUID(),
      type: "footer",
      props: { text: "Synthetic brokerage", links: [{ label: "Privacy", href: "/privacy" }] },
    },
  ],
  seo: {
    title: "Synthetic site",
    description: "Exact plain data",
    canonicalPath: "/synthetic",
    noindex: true,
  },
});

const operations = [
  { name: "draft inspection", run: (value: unknown) => inspectDraft(value, policy) },
  { name: "publication validation", run: (value: unknown) => validateForPublication(value, policy) },
  { name: "registered rendering", run: (value: unknown) => renderRegisteredBlocks(value, policy) },
];

function capture(operation: () => unknown) {
  try {
    return { value: operation(), error: undefined };
  } catch (error) {
    return { value: undefined, error };
  }
}

function rejectData(run: (value: unknown) => unknown, value: unknown) {
  const result = capture(() => run(value));
  expect(result.error).toBeInstanceOf(ContentValidationError);
  expect((result.error as ContentValidationError).issues).toEqual([
    { path: "", code: "document_invalid_or_too_large" },
  ]);
}

function temporaryHook(prototype: object, descriptor: PropertyDescriptor, operation: () => unknown) {
  const original = Object.getOwnPropertyDescriptor(prototype, "toJSON");
  Object.defineProperty(prototype, "toJSON", { configurable: true, ...descriptor });
  try {
    return capture(operation);
  } finally {
    if (original) Object.defineProperty(prototype, "toJSON", original);
    else Reflect.deleteProperty(prototype, "toJSON");
  }
}

describe("content registry descriptor-only JSON safety", () => {
  const inheritedHooks = operations.flatMap((operation) =>
    (["Object", "Array"] as const).flatMap((prototype) =>
      (["function", "getter"] as const).map((kind) => ({ ...operation, prototype, kind })),
    ),
  );
  it.each(inheritedHooks)(
    "$name ignores inherited $prototype $kind hook and preserves original content",
    ({ run, prototype, kind }) => {
      const input = revision(),
        expected = run(input);
      let reads = 0,
        calls = 0;
      const hook = () => {
        calls++;
        return "UNTRUSTED_SERIALIZATION_REPLACEMENT";
      };
      const descriptor: PropertyDescriptor =
        kind === "getter"
          ? {
              get: () => {
                reads++;
                return hook;
              },
            }
          : { value: hook, writable: true };
      const result = temporaryHook(
        prototype === "Object" ? Object.prototype : Array.prototype,
        descriptor,
        () => run(input),
      );
      // All assertions happen after prototype restoration so the test runner cannot invoke the hook.
      expect(reads).toBe(0);
      expect(calls).toBe(0);
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(expected);
    },
  );

  it.each(operations)(
    "$name rejects root and nested accessors without evaluating getters or setters",
    ({ run }) => {
      let calls = 0;
      const accessor = () => {
        calls++;
        throw new Error("PRIVATE_TENANT_ACCESSOR_EXECUTED");
      };
      const root = Object.defineProperty({}, "schemaVersion", { enumerable: true, get: accessor });
      const nested = revision();
      Object.defineProperty(nested.blocks[0].props, "heading", { enumerable: true, get: accessor });
      const index = revision();
      Object.defineProperty(index.blocks[1].props.paragraphs!, "0", { enumerable: true, get: accessor });
      const setter = Object.defineProperty({}, "schemaVersion", { enumerable: true, set: accessor });
      const ownHook = Object.defineProperty(revision(), "toJSON", { enumerable: false, get: accessor });
      for (const value of [root, nested, index, setter, ownHook]) rejectData(run, value);
      expect(calls).toBe(0);
    },
  );

  it.each(operations)("$name rejects every live proxy without invoking any proxy trap", ({ run }) => {
    let traps = 0;
    const trap = (): never => {
      traps++;
      throw new Error("PRIVATE_TENANT_PROXY_TRAP_EXECUTED");
    };
    const handler: ProxyHandler<object> = {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
      has: trap,
      set: trap,
      defineProperty: trap,
      deleteProperty: trap,
      isExtensible: trap,
    };
    const root = new Proxy(revision(), handler);
    const array = new Proxy(revision().blocks, handler);
    const nested = revision();
    Object.defineProperty(nested.blocks[0], "props", {
      value: new Proxy(nested.blocks[0].props, handler),
      enumerable: true,
    });
    for (const value of [root, array, nested]) rejectData(run, value);
    expect(traps).toBe(0);
  });

  it.each(operations)("$name rejects revoked proxies with the closed data error", ({ run }) => {
    const proxy = Proxy.revocable(revision(), {});
    proxy.revoke();
    rejectData(run, proxy.proxy);
  });

  it.each([
    "hole",
    "trailing holes",
    "enumerable property",
    "noncanonical index",
    "custom prototype",
  ] as const)("rejects a draft array with %s rather than discarding or rewriting data", (kind) => {
    const array: unknown[] = ["preserved"];
    if (kind === "hole") {
      array.length = 3;
      array[2] = "last";
    } else if (kind === "trailing holes") array.length = 30_000;
    else if (kind === "enumerable property")
      Object.defineProperty(array, "privateExtra", { enumerable: true, value: "Must not disappear" });
    else if (kind === "noncanonical index")
      Object.defineProperty(array, "01", { enumerable: true, value: "Must not disappear" });
    else Object.setPrototypeOf(array, Object.create(Array.prototype));
    for (const { run } of operations) rejectData(run, { schemaVersion: 99, recovery: array });
  });

  it("rejects own serialization functions symbols executable values cycles and nonfinite numbers without calling them", () => {
    let calls = 0;
    const executable = () => {
      calls++;
      return "UNTRUSTED_CONTENT";
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      { toJSON: executable },
      { callback: executable },
      { invalid: undefined },
      { invalid: NaN },
      { invalid: Number.POSITIVE_INFINITY },
      { invalid: BigInt(1) },
      { [Symbol("private")]: "hidden" },
      cyclic,
      new Date(0),
    ])
      rejectData((input) => inspectDraft(input, policy), value);
    expect(calls).toBe(0);
  });

  it("preserves detached future-version plain JSON including null-prototype objects and literal prototype keys", () => {
    const fields = Object.create(null) as Record<string, unknown>;
    fields.text = 'Unsupported rich data with emoji 😀 and a quoted "value".';
    fields.boolean = false;
    fields.number = 1.25;
    fields.empty = null;
    fields.values = [null, true, 42, ["nested", "array"]];
    fields.__proto__ = { retainedAsData: true };
    Object.defineProperty(fields, "constructor", {
      value: { prototype: { retainedAsData: true } },
      enumerable: true,
    });
    const future = { schemaVersion: 42, blocks: [{ id: randomUUID(), type: "future", props: fields }] };
    const inspected = inspectDraft(future, policy);
    expect(inspected.data).toEqual(future);
    expect(inspected.data).not.toBe(future);
    const data = inspected.data as typeof future;
    expect(data.blocks[0].props).not.toBe(fields);
    expect(Object.hasOwn(data.blocks[0].props, "__proto__")).toBe(true);
    expect(data.blocks[0].props.__proto__).toEqual({ retainedAsData: true });
    expect(Object.hasOwn(Object.prototype, "retainedAsData")).toBe(false);
    fields.text = "Later edit";
    expect(data.blocks[0].props.text).not.toBe("Later edit");
    expect(inspected.issues).toEqual([{ path: "/schemaVersion", code: "schema_version_unsupported" }]);
    expect(() => validateForPublication(future, policy)).toThrow(ContentValidationError);
    expect(() => renderRegisteredBlocks(future, policy)).toThrow(ContentValidationError);
  });

  it("retains bounded unsupported block kinds and raw recovery strings without rendering them", () => {
    const future = {
      schemaVersion: 1,
      blocks: [
        {
          id: randomUUID(),
          type: { future: "kind" },
          props: { raw: "<script>recover this exact text</script>", payload: "😀".repeat(20_000) },
        },
      ],
      seo: { title: "Unsupported content", description: "Recovery data", noindex: true },
    };
    const inspected = inspectDraft(future, policy);
    expect(inspected.data).toEqual(future);
    expect(inspected.issues).toContainEqual({ path: "/blocks/0", code: "block_not_registered" });
    expect(() => renderRegisteredBlocks(future, policy)).toThrow(ContentValidationError);
    expect(JSON.stringify(inspected.data)).toContain("recover this exact text");
  });

  it("applies encoded UTF8 byte depth and node bounds before retaining recovery data", () => {
    let deep: unknown = {};
    for (let index = 0; index < 40; index++) deep = { nested: deep };
    const many = Object.fromEntries(Array.from({ length: 20_001 }, (_, index) => [String(index), index]));
    for (const value of [
      { schemaVersion: 99, payload: "😀".repeat(70_000) },
      { schemaVersion: 99, payload: "\u0000".repeat(45_000) },
      deep,
      many,
    ])
      rejectData((input) => inspectDraft(input, policy), value);
  });

  it("keeps semantic registered HTML escaping and fresh per-call validation", () => {
    const input = revision(),
      validated = validateForPublication(input, policy);
    const html = renderRegisteredBlocks(validated, policy);
    expect(html).toContain("Safe &amp; &quot;exact&quot; content");
    expect(html).toContain("Contact&#39;s page");
    expect(html).toContain('href="/contact?buyer=1&amp;source=test"');
    expect(html).toContain('<nav aria-label="Footer">');
    expect(html).not.toMatch(/<script|onclick=|style=|<iframe/);
    input.blocks[0].props.heading = "New source edit";
    expect(validated.blocks[0].props.heading).toBe('Safe & "exact" content');
    validated.blocks[0].props.action = { label: "Unsafe later edit", href: "javascript:alert(1)" };
    expect(() => renderRegisteredBlocks(validated, policy)).toThrow(ContentValidationError);
  });
});
