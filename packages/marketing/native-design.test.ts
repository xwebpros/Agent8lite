import { describe, expect, it } from "vitest";
import {
  NativeMessageDesignError,
  type NativeMessageDesignWrite,
  prepareNativeMessageDesign,
} from "./native-design";

const input = (text = "hello"): NativeMessageDesignWrite => ({
  name: "Sample design",
  channel: "email",
  editor: "native",
  design: { schemaVersion: 1, blocks: [{ type: "text", text }] },
  content: text,
});
const prepare = (value: unknown) => prepareNativeMessageDesign(value as NativeMessageDesignWrite);

describe("pure native static-text design preparation", () => {
  it("preserves the frozen write shape and hashes exact UTF8 content", () => {
    const result = prepareNativeMessageDesign(input());
    expect(result.body).toEqual(input());
    expect(result.renderedContent).toBe("hello");
    expect(result.contentHash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(JSON.parse(result.canonicalBody)).toEqual(input());
    expect(JSON.parse(result.canonicalDesign)).toEqual(input().design);
  });
  it("joins multiple blocks with exactly one newline without normalization", () => {
    const value = input(" hello \n世界");
    value.design.blocks = [
      { type: "text", text: " hello " },
      { type: "text", text: "世界" },
    ];
    const result = prepareNativeMessageDesign(value);
    expect(result.renderedContent).toBe(" hello \n世界");
    expect(result.body.content).toBe(value.content);
    expect(() => prepare({ ...value, content: "hello\n世界" })).toThrowError(NativeMessageDesignError);
  });
  it("accepts SMS and optional static subject without inventing a required email subject", () => {
    expect(prepareNativeMessageDesign(input()).body).not.toHaveProperty("subject");
    expect(prepare({ ...input(), subject: "A static subject" }).body.subject).toBe("A static subject");
    expect(prepare({ ...input(), channel: "sms" }).body.channel).toBe("sms");
  });
  it.each(["\n", "\r", "\t"])("rejects subject-line control case %#", (separator) => {
    expect(() => prepare({ ...input(), subject: `First${separator}Second` })).toThrowError(
      expect.objectContaining({
        code: "native_design_invalid",
        issues: [expect.objectContaining({ field: "subject" })],
      }),
    );
  });
  it("preserves allowed newlines and tabs in static blocks/content independently of subject rules", () => {
    const text = "First\tpart\nSecond line";
    expect(prepare(input(text)).renderedContent).toBe(text);
  });
  it("uses Unicode code points for the frozen field bounds", () => {
    const value = { ...input(), name: "😀".repeat(120), subject: "😀".repeat(200) };
    expect(prepare(value).body.name).toBe(value.name);
    expect(() => prepare({ ...value, name: "😀".repeat(121) })).toThrowError(NativeMessageDesignError);
    expect(() => prepare({ ...value, subject: "😀".repeat(201) })).toThrowError(NativeMessageDesignError);
    expect(prepare(input("a".repeat(100000))).body.content).toHaveLength(100000);
    expect(() => prepare(input("a".repeat(100001)))).toThrowError(NativeMessageDesignError);
  });
  it.each(["\ud800", "\udc00"])("rejects lone Unicode surrogate case %# before storage", (text) => {
    for (const value of [input(text), { ...input(), name: text }, { ...input(), subject: text }])
      expect(() => prepare(value)).toThrowError(NativeMessageDesignError);
    expect(prepare(input("😀")).renderedContent).toBe("😀");
  });
  it("bounds the complete escaped UTF8 write body, independently of codepoint limits", () => {
    expect(() => prepare(input("😀".repeat(40000)))).toThrowError(NativeMessageDesignError);
    expect(() => prepare(input("a\n".repeat(50000)))).toThrowError(NativeMessageDesignError);
    const result = prepare(input("a".repeat(100000)));
    expect(Buffer.byteLength(result.canonicalBody, "utf8")).toBeLessThanOrEqual(262144);
  });
  it("detaches and freezes data without changing the caller", () => {
    const value = input();
    const result = prepareNativeMessageDesign(value);
    value.name = "Changed";
    (value.design.blocks as { text: string }[])[0].text = "Changed";
    value.content = "Changed";
    expect(result.body).toEqual(input());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.body)).toBe(true);
    expect(Object.isFrozen(result.body.design)).toBe(true);
    expect(Object.isFrozen(result.body.design.blocks)).toBe(true);
    expect(Object.isFrozen((result.body.design.blocks as unknown[])[0])).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
  });
  it("canonicalizes object order while preserving ordered block content", () => {
    const first = prepareNativeMessageDesign(input());
    const second = prepare({
      content: "hello",
      design: { blocks: [{ text: "hello", type: "text" }], schemaVersion: 1 },
      editor: "native",
      channel: "email",
      name: "Sample design",
    });
    expect(second.canonicalBody).toBe(first.canonicalBody);
    expect(second.canonicalDesign).toBe(first.canonicalDesign);
  });
  it.each([
    { ...input(), extra: true },
    { ...input(), subject: null },
    { ...input(), channel: "push" },
    { ...input(), editor: "custom" },
    { ...input(), name: " " },
    { ...input(), name: "A\nB" },
    { ...input(), design: { schemaVersion: 1, blocks: [] } },
    { ...input(), design: { schemaVersion: 2, blocks: [{ type: "text", text: "hello" }] } },
    { ...input(), design: { schemaVersion: 1, blocks: [{ type: "text", text: "hello", extra: true }] } },
    { ...input(), design: { schemaVersion: 1, blocks: [{ type: "html", text: "hello" }] } },
    { ...input(), design: { schemaVersion: 1, blocks: [{ type: "text", text: "hello" }], extra: true } },
    {
      ...input(),
      design: { schemaVersion: 1, blocks: Array.from({ length: 101 }, () => ({ type: "text", text: "a" })) },
    },
  ])("rejects malformed or non-native closed contract case %#", (value) => {
    expect(() => prepare(value)).toThrowError(NativeMessageDesignError);
  });
  it("rejects Unlayer without assuming licensing or readiness", () => {
    expect(() => prepare({ ...input(), editor: "unlayer" })).toThrowError(
      expect.objectContaining({ code: "native_editor_unavailable" }),
    );
  });
  it.each([
    " ",
    "<b>hello</b>",
    "{{ contact }}",
    "${contact}",
    "<% code %>",
    "https://example.test",
    "HTTP://example.test",
    "ftp://example.test",
    "www.example.test",
    "javascript:code",
    "data:text/plain,hello",
    "hello\u0000world",
    "hello\u000bworld",
    "hello\u001fworld",
    "hello\u007fworld",
  ])("rejects unavailable static syntax %# in blocks, content and optional subject", (text) => {
    expect(() => prepare(input(text))).toThrowError(NativeMessageDesignError);
    expect(() => prepare({ ...input(), subject: text })).toThrowError(NativeMessageDesignError);
    expect(() => prepare({ ...input(), content: text })).toThrowError(NativeMessageDesignError);
  });
  it("does not evaluate accessors, proxies or custom toJSON", () => {
    let calls = 0;
    const getter = Object.defineProperty(input(), "content", {
      enumerable: true,
      get() {
        calls += 1;
        return "hello";
      },
    });
    const method = {
      ...input(),
      toJSON() {
        calls += 1;
        return input();
      },
    };
    const custom = Object.assign(
      Object.create({
        toJSON() {
          calls += 1;
          return input();
        },
      }),
      input(),
    );
    const proxy = new Proxy(input(), {
      ownKeys() {
        calls += 1;
        return [];
      },
      getPrototypeOf() {
        calls += 1;
        return Object.prototype;
      },
    });
    for (const value of [getter, method, custom, proxy])
      expect(() => prepare(value)).toThrowError(NativeMessageDesignError);
    expect(calls).toBe(0);
  });
  it("does not invoke inherited Object/Array toJSON during validation, hashing or serialization", () => {
    let calls = 0;
    let result: ReturnType<typeof prepareNativeMessageDesign>;
    const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    try {
      const hook = () => {
        calls += 1;
        return "changed";
      };
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      result = prepareNativeMessageDesign(input());
    } finally {
      if (objectDescriptor) Object.defineProperty(Object.prototype, "toJSON", objectDescriptor);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (arrayDescriptor) Object.defineProperty(Array.prototype, "toJSON", arrayDescriptor);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    expect(calls).toBe(0);
    expect(result!.renderedContent).toBe("hello");
    expect(result!.canonicalBody).not.toContain("changed");
  });
  it("rejects sparse arrays, extra array properties, hidden/symbol properties and cyclic/deep JSON", () => {
    const sparse = input();
    delete (sparse.design.blocks as unknown[])[0];
    const extra = input();
    Object.defineProperty(extra.design.blocks, "extra", { value: true });
    const hidden = Object.defineProperty(input(), "hidden", { value: true });
    const symbol = Object.defineProperty(input(), Symbol("hidden"), { value: true });
    const cycle: Record<string, unknown> = input();
    cycle.self = cycle;
    let deep: unknown = "a";
    for (let index = 0; index < 22; index += 1) deep = { nested: deep };
    for (const value of [sparse, extra, hidden, symbol, cycle, { ...input(), design: deep }])
      expect(() => prepare(value)).toThrowError(NativeMessageDesignError);
  });
  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => "hello", Symbol("hello")])(
    "rejects non-JSON own values %#",
    (value) => {
      expect(() => prepare({ ...input(), content: value })).toThrowError(NativeMessageDesignError);
    },
  );
  it("uses fixed bounded errors without reflecting design text", () => {
    try {
      prepare(input("DO_NOT_REFLECT {{private}}"));
    } catch (error) {
      expect(error).toBeInstanceOf(NativeMessageDesignError);
      const safe = error as NativeMessageDesignError;
      expect(safe.issues.length).toBeLessThanOrEqual(100);
      expect(safe.issues.every((issue) => issue.field.length <= 100 && issue.message.length <= 300)).toBe(
        true,
      );
      expect(Object.isFrozen(safe.issues)).toBe(true);
      expect(JSON.stringify(safe)).not.toContain("DO_NOT_REFLECT");
    }
  });
});
