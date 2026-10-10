import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import nativeSchema from "../../../packages/contracts/internal/native-message-text-design-v1.schema.json";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export type MessageDesignBody = Schema<"MessageDesignWrite">;
export type MessageDesignReceipt = Readonly<{ data: Schema<"MessageDesign">; etag: string }>;
export type MessageDesignIssue = Readonly<{ field: string; message: string }>;
// Editor projection of the approved internal schema; frozen public bodies remain generated.
export type NativeTextDesign = { schemaVersion: 1; blocks: { type: "text"; text: string }[] };
export type MessageDesignCommand = Readonly<{
  binding: string;
  kind: "create" | "update";
  designId: string | null;
  ifMatch: string | null;
  idempotencyKey: string;
  body: MessageDesignBody;
}>;
export const messageDesignBodyLimit = 256 * 1024;
export const messageDesignResponseLimit = 1024 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:message-design-browser",
  components: {
    schemas: {
      MessageDesign: contract.components.schemas.MessageDesign,
      PageMessageDesign: contract.components.schemas.PageMessageDesign,
    },
  },
});
const validWrite = ajv.compile<MessageDesignBody>(contract.components.schemas.MessageDesignWrite);
const validNative = ajv.compile<NativeTextDesign>(nativeSchema);
// Incomplete editor text is permitted only in memory; submitted bodies use the unchanged closed schema.
const validEditorBlocks = ajv.compile<NativeTextDesign>({
  ...nativeSchema,
  $id: "estate:message-design-incomplete-local-editor",
  properties: {
    ...nativeSchema.properties,
    blocks: {
      ...nativeSchema.properties.blocks,
      items: {
        ...nativeSchema.properties.blocks.items,
        properties: {
          ...nativeSchema.properties.blocks.items.properties,
          text: { ...nativeSchema.properties.blocks.items.properties.text, minLength: 0 },
        },
      },
    },
  },
});
const validDesign = ajv.compile<Schema<"MessageDesign">>({
  $ref: "estate:message-design-browser#/components/schemas/MessageDesign",
});
const validPage = ajv.compile<Schema<"PageMessageDesign">>({
  $ref: "estate:message-design-browser#/components/schemas/PageMessageDesign",
});
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);
const validId = ajv.compile(contract.components.schemas.MessageDesign.properties.id);

/** Detached descriptor snapshot: getters, sparse arrays and prototype serialization hooks never execute. */
export function messageDesignJson(value: unknown, limit = messageDesignBodyLimit): string {
  let nodes = 0;
  const active = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 20) throw new Error();
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || active.has(item)) throw new Error();
    const array = Array.isArray(item),
      prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 10001 || (array && (item.length > 10000 || keys.length !== item.length + 1)))
      throw new Error();
    const result = array ? Object.setPrototypeOf(new Array(item.length), null) : Object.create(null);
    active.add(item);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      Object.defineProperty(result, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    active.delete(item);
    return result;
  };
  try {
    const text = JSON.stringify(copy(value, 0));
    if (!text || new TextEncoder().encode(text).byteLength > limit) throw new Error();
    return text;
  } catch {
    throw new Error("Message design data exceeds its safe private memory format or limits.");
  }
}
export function copyMessageDesign<T>(value: T, limit = messageDesignBodyLimit): T {
  return JSON.parse(messageDesignJson(value, limit)) as T;
}
export function freezeMessageDesign<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeMessageDesign(child);
    Object.freeze(value);
  }
  return value;
}
export function messageDesignVersion(etag: string | null): number {
  const match = etag && etag.length <= 100 ? /^"([1-9][0-9]*)"$/.exec(etag) : null;
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("A strong message-design revision is required.");
  return version;
}
export const isMessageDesignId = (id: string) => validId(id);
const staticText = (value: string) =>
  !!value.trim() &&
  !/[<>]|\{\{|\$\{|[\x00-\x08\x0b-\x1f\x7f]|(?:javascript|data|https?|ftp):|www\./i.test(value);
export function messageDesignIssues(value: unknown): readonly MessageDesignIssue[] {
  let body: unknown;
  try {
    body = copyMessageDesign(value);
  } catch {
    return [{ field: "design", message: "Use plain message data within the 256 KiB draft limit." }];
  }
  if (!validWrite(body))
    return [{ field: "design", message: "Use the closed message draft fields and text limits." }];
  const issues: MessageDesignIssue[] = [];
  const malformedUnicode = (text: string) => /[\uD800-\uDFFF]/u.test(text);
  if (malformedUnicode(body.name))
    issues.push({ field: "name", message: "Use complete Unicode characters in the design name." });
  if (body.subject !== undefined && malformedUnicode(body.subject))
    issues.push({ field: "subject", message: "Use complete Unicode characters in the subject." });
  if (malformedUnicode(body.content))
    issues.push({ field: "content", message: "Use complete Unicode characters in the message content." });
  if (body.editor !== "native")
    issues.push({
      field: "editor",
      message: "Only the approved native static-text format can be authored here.",
    });
  if (!body.name.trim() || /[\x00-\x1f\x7f]/.test(body.name))
    issues.push({ field: "name", message: "Use a nonblank name without control characters." });
  if (body.subject !== undefined && (!staticText(body.subject) || /[\x00-\x1f\x7f]/.test(body.subject)))
    issues.push({
      field: "subject",
      message:
        "Use nonblank single-line static subject text without controls, markup, URLs or template syntax.",
    });
  if (!validNative(body.design))
    issues.push({ field: "design", message: "Use 1–100 approved native text blocks." });
  if (validEditorBlocks(body.design)) {
    for (const [index, block] of body.design.blocks.entries()) {
      if (malformedUnicode(block.text))
        issues.push({
          field: `design.blocks.${index}.text`,
          message: "Use complete Unicode characters in this text block.",
        });
      if (!staticText(block.text))
        issues.push({
          field: `design.blocks.${index}.text`,
          message: "Use nonblank static text without markup, URLs or template syntax.",
        });
    }
    if (body.content !== body.design.blocks.map((block) => block.text).join("\n"))
      issues.push({
        field: "content",
        message: "Content must exactly match text blocks joined by one newline.",
      });
  }
  if (!staticText(body.content))
    issues.push({
      field: "content",
      message: "Use nonblank static content without markup, URLs or template syntax.",
    });
  return freezeMessageDesign(issues);
}
export function requireMessageDesignWrite(value: unknown): MessageDesignBody {
  if (messageDesignIssues(value).length)
    throw new Error("Review the native static message fields before saving.");
  return freezeMessageDesign(copyMessageDesign(value)) as MessageDesignBody;
}
export function nativeTextBlocks(value: MessageDesignBody): NativeTextDesign | null {
  const design = copyMessageDesign(value.design);
  return validEditorBlocks(design) ? design : null;
}
export function messageDesignWriteFromReceipt(value: Schema<"MessageDesign">): MessageDesignBody | null {
  const body: MessageDesignBody = {
    name: value.name,
    channel: value.channel,
    editor: value.editor,
    design: value.design,
    content: value.content,
    ...(value.subject == null ? {} : { subject: value.subject }),
  };
  return messageDesignIssues(body).length ? null : requireMessageDesignWrite(body);
}
export function requireMessageDesignReceipt(
  value: unknown,
  etag: string,
  expectedId?: string,
): MessageDesignReceipt {
  const data = copyMessageDesign(value, messageDesignResponseLimit);
  if (
    !validDesign(data) ||
    !Number.isSafeInteger(data.version) ||
    messageDesignVersion(etag) !== data.version ||
    (expectedId && data.id !== expectedId)
  )
    throw new Error("The message design identity or revision could not be verified.");
  return freezeMessageDesign({ data, etag });
}
export function requireMessageDesignPage(value: unknown): Schema<"PageMessageDesign"> {
  const page = copyMessageDesign(value, messageDesignResponseLimit);
  if (
    !validPage(page) ||
    page.items.length > 5 ||
    (page.hasMore ? !page.nextCursor || !page.items.length : page.nextCursor !== null)
  )
    throw new Error("The bounded message design page or cursor could not be verified.");
  const ids = new Set<string>();
  for (const design of page.items) {
    requireMessageDesignReceipt(design, `"${design.version}"`);
    if (ids.has(design.id.toLowerCase())) throw new Error("The message design index repeats an identity.");
    ids.add(design.id.toLowerCase());
  }
  return freezeMessageDesign(page);
}
export function sameMessageDesignBody(left: MessageDesignBody, right: MessageDesignBody): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return Object.setPrototypeOf(value.map(canonical), null);
    if (value && typeof value === "object") {
      const result = Object.create(null);
      for (const key of Object.keys(value).sort())
        result[key] = canonical((value as Record<string, unknown>)[key]);
      return result;
    }
    return value;
  };
  return (
    JSON.stringify(canonical(copyMessageDesign(left))) === JSON.stringify(canonical(copyMessageDesign(right)))
  );
}
export async function readMessageDesignResponse(response: Response): Promise<unknown> {
  const failure = () =>
    new ApiError(response.status, "Message design access or request could not be verified.");
  const reader = response.body?.getReader();
  if (!reader) {
    if (!response.ok) throw failure();
    throw new Error("Message response unavailable.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > messageDesignResponseLimit) {
        await reader.cancel();
        throw new Error("Message transport exceeds 1 MiB.");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (!response.ok) throw failure();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    if (!response.ok) throw failure();
    throw new Error("Message transport is not valid UTF-8 JSON.");
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      failure().message,
      validProblem(value) && value.status === response.status ? value.code : undefined,
    );
  return value;
}
