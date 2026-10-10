import { createHash } from "node:crypto";
import { types } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import type { components } from "../contracts/generated/api";
import nativeSchema from "../contracts/internal/native-message-text-design-v1.schema.json";
import openApi from "../contracts/openapi.json";

export type NativeMessageDesignWrite = components["schemas"]["MessageDesignWrite"];
export type NativeMessageDesign = components["schemas"]["MessageDesign"];
export type NativeDesignIssue = Readonly<{ field: string; message: string }>;
export type PreparedNativeMessageDesign = Readonly<{
  body: Readonly<NativeMessageDesignWrite>;
  canonicalBody: string;
  canonicalDesign: string;
  renderedContent: string;
  contentHash: string;
}>;

/** Pure server preparation only; no database, editor, renderer or provider runs. */
export class NativeMessageDesignError extends Error {
  readonly issues: readonly NativeDesignIssue[];
  constructor(
    readonly code: "native_design_invalid" | "native_editor_unavailable",
    issues: readonly NativeDesignIssue[],
  ) {
    super(code === "native_editor_unavailable" ? "This editor is unavailable." : "Native design is invalid.");
    this.name = "NativeMessageDesignError";
    this.issues = Object.freeze(issues.slice(0, 100).map((issue) => Object.freeze({ ...issue })));
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true, ownProperties: true });
const validWrite = ajv.compile(openApi.components.schemas.MessageDesignWrite);
const validNative = ajv.compile(nativeSchema);
const invalid = (field: string, message: string): never => {
  throw new NativeMessageDesignError("native_design_invalid", [{ field, message }]);
};

/** Descriptor-only JSON snapshot and canonical text; never invoke a toJSON hook. */
function ownJson(input: unknown): { value: unknown; text: string } {
  let remaining = 262144;
  const active = new WeakSet<object>();
  const fail = (): never =>
    invalid("design", "Use bounded plain JSON without accessors, sparse arrays or custom prototypes.");
  const charge = (size: number) => {
    remaining -= size;
    if (remaining < 0) fail();
  };
  const read = (value: unknown, depth: number): { value: unknown; text: string } => {
    if (
      depth > 20 ||
      (typeof value === "string" && (value.length > 262144 || /[\uD800-\uDFFF]/u.test(value)))
    )
      return fail();
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      const text = JSON.stringify(value);
      charge(Buffer.byteLength(text, "utf8"));
      return { value, text };
    }
    if (value === null || typeof value !== "object") return fail();
    if (types.isProxy(value) || active.has(value)) return fail();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return fail();
    if (Object.getOwnPropertySymbols(value).length) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 10001) return fail();
    active.add(value);
    charge(2);
    let result: unknown;
    let text: string;
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isInteger(length) || length < 0 || length > 10000 || keys.length !== length + 1)
        return fail();
      const values: unknown[] = [];
      const texts: string[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) return fail();
        if (index) charge(1);
        const child = read(descriptor.value, depth + 1);
        values.push(child.value);
        texts.push(child.text);
      }
      result = Object.freeze(values);
      text = `[${texts.join(",")}]`;
    } else {
      const values: Record<string, unknown> = Object.create(null);
      const texts: string[] = [];
      for (const [index, key] of keys.sort().entries()) {
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable || key === "toJSON") return fail();
        const keyText = JSON.stringify(key);
        charge(Buffer.byteLength(keyText, "utf8") + 1 + (index ? 1 : 0));
        const child = read(descriptor.value, depth + 1);
        values[key] = child.value;
        texts.push(`${keyText}:${child.text}`);
      }
      result = Object.freeze(values);
      text = `{${texts.join(",")}}`;
    }
    active.delete(value);
    return { value: result, text };
  };
  return read(input, 0);
}

// Match ADR-023's current workflow source predicate; this is static text,
// never HTML sanitization, template execution, URL resolution or sender proof.
const staticText = (value: string) =>
  !!value.trim() &&
  !/[<>]|\{\{|\$\{|[\x00-\x08\x0b-\x1f\x7f]|(?:javascript|data|https?|ftp):|www\./i.test(value);

/** Prepare the exact frozen write shape; preserve input text without normalization. */
export function prepareNativeMessageDesign(input: NativeMessageDesignWrite): PreparedNativeMessageDesign {
  const snapshot = ownJson(input);
  if (!validWrite(snapshot.value)) invalid("design", "Use the closed message-design write contract.");
  const body = snapshot.value as NativeMessageDesignWrite;
  if (body.editor !== "native")
    throw new NativeMessageDesignError("native_editor_unavailable", [
      { field: "editor", message: "Only the approved native static-text format is available." },
    ]);
  if (!body.name.trim() || /[\x00-\x1f\x7f]/.test(body.name))
    invalid("name", "Use a nonblank name without control characters.");
  if (!validNative(body.design)) invalid("design", "Use the approved closed native static-text format.");
  if (body.subject !== undefined && (!staticText(body.subject) || /[\x00-\x1f\x7f]/.test(body.subject)))
    invalid("subject", "Use nonblank single-line static subject text without control characters or markup.");
  const native = body.design as { schemaVersion: 1; blocks: { type: "text"; text: string }[] };
  for (const [index, block] of native.blocks.entries())
    if (!staticText(block.text))
      invalid(
        `design.blocks.${index}.text`,
        "Use nonblank static text without markup, URLs or template syntax.",
      );
  if (!staticText(body.content))
    invalid("content", "Use nonblank static content without markup, URLs or template syntax.");
  const renderedContent = native.blocks.map((block) => block.text).join("\n");
  if (renderedContent !== body.content)
    invalid("content", "Content must exactly match native block text joined with newlines.");
  return Object.freeze({
    body,
    canonicalBody: snapshot.text,
    canonicalDesign: ownJson(body.design).text,
    renderedContent,
    contentHash: createHash("sha256").update(renderedContent, "utf8").digest("hex"),
  });
}
