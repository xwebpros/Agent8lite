import { describe, expect, it, vi } from "vitest";
import {
  copyMessageDesign,
  messageDesignIssues,
  messageDesignJson,
  messageDesignResponseLimit,
  messageDesignVersion,
  messageDesignWriteFromReceipt,
  nativeTextBlocks,
  readMessageDesignResponse,
  requireMessageDesignPage,
  requireMessageDesignReceipt,
  requireMessageDesignWrite,
  sameMessageDesignBody,
} from "../../apps/web/components/message-design-protocol";
import { requestMessageDesign } from "../../apps/web/components/message-design-request";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "e2000000-0000-4000-8000-000000000001";
const body = (): Schema<"MessageDesignWrite"> => ({
  name: "Private native design",
  channel: "email",
  editor: "native",
  subject: "Optional subject",
  design: {
    schemaVersion: 1,
    blocks: [
      { type: "text", text: "  Hello\t😀\nworld  " },
      { type: "text", text: "Second paragraph" },
    ],
  },
  content: "  Hello\t😀\nworld  \nSecond paragraph",
});
const entity = (version = 1): Schema<"MessageDesign"> => ({ ...body(), id, version });
const problem = (status: number, code: string): Schema<"Problem"> => ({
  type: "about:blank",
  title: "Private title",
  detail: "Private body",
  status,
  code,
  traceId: "safe-trace",
});

describe("native message closed format and transport", () => {
  it("denies lone Unicode surrogates in semantic text while preserving valid pairs without normalization", () => {
    for (const lone of ["\uD800", "\uDC00", "before\uDFFFafter"]) {
      for (const input of [
        { ...body(), name: lone },
        { ...body(), subject: lone },
        { ...body(), content: lone, design: { schemaVersion: 1, blocks: [{ type: "text", text: lone }] } },
      ])
        expect(() => requireMessageDesignWrite(input)).toThrow();
    }
    const paired = "\uD83D\uDE00 cafe\u0301";
    const input = {
      ...body(),
      name: paired,
      subject: paired,
      content: paired,
      design: { schemaVersion: 1, blocks: [{ type: "text", text: paired }] },
    };
    const prepared = requireMessageDesignWrite(input);
    expect(prepared).toEqual(input);
    expect(prepared.content).toBe("😀 cafe\u0301");
    expect(prepared.content).not.toBe("😀 café");
  });
  it("preserves exact Unicode, spaces, tabs and joined newlines with optional subject semantics", () => {
    const original = body(),
      prepared = requireMessageDesignWrite(original);
    expect(prepared).toEqual(original);
    expect(prepared).not.toBe(original);
    expect(Object.isFrozen(prepared.design)).toBe(true);
    const withoutSubject = messageDesignWriteFromReceipt({ ...entity(), subject: null });
    expect(withoutSubject).not.toHaveProperty("subject");
    expect(prepared.content).toBe("  Hello\t😀\nworld  \nSecond paragraph");
    expect(
      sameMessageDesignBody(original, {
        content: original.content,
        design: original.design,
        editor: original.editor,
        channel: original.channel,
        name: original.name,
        subject: original.subject,
      }),
    ).toBe(true);
  });
  it("accepts an incomplete text block only as a local editor projection", () => {
    const draft = {
      ...body(),
      design: { schemaVersion: 1, blocks: [{ type: "text", text: "" }] },
      content: "",
    };
    expect(nativeTextBlocks(draft)?.blocks[0].text).toBe("");
    expect(messageDesignIssues(draft).length).toBeGreaterThan(0);
    expect(() => requireMessageDesignWrite(draft)).toThrow();
  });
  it("denies alternate editors, unknown fields, mismatched content and executable/link syntax", () => {
    for (const value of [
      { ...body(), editor: "unlayer" },
      { ...body(), subject: "Two\nlines" },
      { ...body(), subject: "" },
      { ...body(), name: "\tName" },
      { ...body(), content: "Changed separately" },
      { ...body(), extra: true },
      { ...body(), design: { schemaVersion: 2, blocks: [{ type: "text", text: "Hello" }] } },
      {
        ...body(),
        design: { schemaVersion: 1, blocks: [{ type: "text", text: "Hello", script: "secret" }] },
      },
    ])
      expect(() => requireMessageDesignWrite(value)).toThrow();
    for (const text of [
      "<b>Hello</b>",
      "{{name}}",
      "${value}",
      "https:link",
      "www.example.test",
      "data:text",
      "javascript:secret",
      "\rText",
    ])
      expect(() =>
        requireMessageDesignWrite({
          ...body(),
          design: { schemaVersion: 1, blocks: [{ type: "text", text }] },
          content: text,
        }),
      ).toThrow();
  });
  it("checks code points and escaped UTF-8 independently without normalization", () => {
    expect(messageDesignIssues({ ...body(), name: "😀".repeat(120) })).toEqual([]);
    expect(messageDesignIssues({ ...body(), name: "😀".repeat(121) }).length).toBeGreaterThan(0);
    const text = "😀".repeat(40000);
    expect(() =>
      requireMessageDesignWrite({
        ...body(),
        design: { schemaVersion: 1, blocks: [{ type: "text", text }] },
        content: text,
      }),
    ).toThrow(/Review/);
    expect(() => messageDesignJson("x".repeat(256 * 1024))).toThrow();
  });
  it("denies accessors, cycles, sparse arrays, hidden keys and excessive depth without invoking getters", () => {
    const getter = vi.fn(() => "private");
    const accessor = Object.defineProperty({}, "text", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: unknown = "x";
    for (let index = 0; index < 22; index++) deep = { child: deep };
    for (const input of [
      accessor,
      cycle,
      [, "text"],
      Object.defineProperty({}, "text", { value: "hidden" }),
      deep,
      new Date(),
      { text: undefined },
    ])
      expect(() => copyMessageDesign(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("ignores inherited object and array toJSON hooks in body, binding and equality snapshots", () => {
    const oldObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
      oldArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON"),
      hook = vi.fn(() => "polluted");
    try {
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true, value: hook });
      Object.defineProperty(Array.prototype, "toJSON", { configurable: true, value: hook });
      const value = body();
      const json = messageDesignJson(value);
      const binding = messageDesignJson([id, "csrf", true]);
      expect(JSON.parse(json).content).toBe(value.content);
      expect(binding).toContain(id);
      expect(sameMessageDesignBody(value, value)).toBe(true);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      if (oldObject) Object.defineProperty(Object.prototype, "toJSON", oldObject);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (oldArray) Object.defineProperty(Array.prototype, "toJSON", oldArray);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });
  it("binds exact ID and strong positive safe integer revision while preserving old designs read-only", () => {
    expect(requireMessageDesignReceipt(entity(4), '"4"', id).data.version).toBe(4);
    for (const tag of ['W/"4"', "4", '"04"', '"3"', '"9007199254740992"'])
      expect(() => requireMessageDesignReceipt(entity(4), tag, id)).toThrow();
    expect(() => messageDesignVersion('"0"')).toThrow();
    expect(() =>
      requireMessageDesignReceipt(entity(), '"1"', "e2000000-0000-4000-8000-000000000002"),
    ).toThrow();
    const older = requireMessageDesignReceipt(
      { ...entity(), editor: "unlayer", design: { html: "<script>stored only</script>" } },
      '"1"',
    );
    expect(messageDesignWriteFromReceipt(older.data)).toBeNull();
    expect(() => requireMessageDesignReceipt({ ...entity(), token: "private" }, '"1"')).toThrow();
  });
  it("rejects duplicate/case-equivalent IDs, oversized pages and inconsistent cursors without truncating", () => {
    const page = { items: [entity()], hasMore: false, nextCursor: null };
    expect(requireMessageDesignPage(page).items).toHaveLength(1);
    for (const value of [
      { ...page, items: [entity(), { ...entity(), id: id.toUpperCase() }] },
      { ...page, hasMore: true },
      { ...page, nextCursor: "opaque" },
      {
        ...page,
        items: Array.from({ length: 6 }, (_, i) => ({
          ...entity(),
          id: `e2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        })),
      },
    ])
      expect(() => requireMessageDesignPage(value)).toThrow();
  });
  it("bounds actual whitespace bytes, cancels oversized streams and rejects malformed UTF-8", async () => {
    expect(
      await readMessageDesignResponse(new Response(`{}${" ".repeat(messageDesignResponseLimit - 2)}`)),
    ).toEqual({});
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(messageDesignResponseLimit));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    await expect(readMessageDesignResponse(new Response(stream))).rejects.toThrow(/1 MiB/);
    expect(cancel).toHaveBeenCalledOnce();
    await expect(readMessageDesignResponse(new Response(new Uint8Array([0xff])))).rejects.toThrow(/UTF-8/);
  });
  it("preserves only verified problem status/code and never surfaces private title/detail", async () => {
    const error = await readMessageDesignResponse(
      new Response(JSON.stringify(problem(409, "design_referenced_immutable")), { status: 409 }),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "design_referenced_immutable" });
    expect((error as Error).message).not.toContain("Private");
    for (const value of [
      { ...problem(409, "design_referenced_immutable"), status: 422 },
      { code: "design_referenced_immutable" },
    ]) {
      const rejected = await readMessageDesignResponse(
        new Response(JSON.stringify(value), { status: 409 }),
      ).catch((result: unknown) => result);
      expect(rejected).toMatchObject({ status: 409, code: undefined });
    }
  });
  it("times out no-store same-origin transport, aborts and clears its timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (_path, options) =>
          new Promise((_resolve, reject) =>
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            ),
          ),
      );
    try {
      const outcome = requestMessageDesign("/api/v1/orgs/local/message-designs", 201, {
        method: "POST",
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20000);
      expect(await outcome).toMatchObject({ name: "AbortError" });
      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        method: "POST",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });
});
