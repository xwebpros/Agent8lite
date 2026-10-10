import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { validateWorkflowDefinition, type WorkflowIssue } from "../../../packages/marketing";
import { ApiError, type Schema } from "../lib/api";

export type WorkflowDefinition = Schema<"CampaignVersionWrite">;
export type WorkflowVersionReceipt = Readonly<{ data: Schema<"CampaignVersion">; etag: string }>;
export type WorkflowDraftCommand = Readonly<{
  binding: string;
  campaignId: string;
  idempotencyKey: string;
  body: WorkflowDefinition;
}>;
const definitionBytes = 256 * 1024;
const responseBytes = 1024 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:workflow-browser",
  components: {
    schemas: {
      CampaignVersion: contract.components.schemas.CampaignVersion,
      CampaignVersionWrite: contract.components.schemas.CampaignVersionWrite,
      WorkflowNode: contract.components.schemas.WorkflowNode,
      WorkflowEdge: contract.components.schemas.WorkflowEdge,
      LeadFilter: contract.components.schemas.LeadFilter,
      PageCampaignVersion: contract.components.schemas.PageCampaignVersion,
    },
  },
});
const validateDefinition = ajv.compile<WorkflowDefinition>({
  $ref: "estate:workflow-browser#/components/schemas/CampaignVersionWrite",
});
const validateVersion = ajv.compile<Schema<"CampaignVersion">>({
  $ref: "estate:workflow-browser#/components/schemas/CampaignVersion",
});
const validatePage = ajv.compile<Schema<"PageCampaignVersion">>({
  $ref: "estate:workflow-browser#/components/schemas/PageCampaignVersion",
});
const validateCode = ajv.compile(contract.components.schemas.Problem.properties.code);
const validateProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);
const validateId = ajv.compile(contract.components.schemas.CampaignVersion.properties.id);

export class WorkflowResponseError extends ApiError {
  readonly issues: readonly WorkflowIssue[];
  constructor(status: number, code: string, issues: readonly WorkflowIssue[]) {
    super(status, "Workflow prerequisites or fields could not be verified.", code);
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}
function workflowProblemIssues(
  problem: Schema<"Problem">,
  definition?: WorkflowDefinition,
): readonly WorkflowIssue[] {
  const sourceMessage = "This source is unavailable or incompatible with the workflow.";
  const sourceField =
    /^nodes\.(?:[0-9]|[1-9][0-9])\.(?:messageDesignId|condition\.(?:stageId|sourceId|ownerMemberId|tagIds\.(?:[0-9]|1[0-9])))$/;
  if (["workflow_reference_unavailable", "design_unavailable", "editor_unavailable"].includes(problem.code))
    return (problem.errors ?? []).filter(
      (issue) =>
        issue.message === sourceMessage &&
        sourceField.test(issue.field) &&
        (problem.code === "workflow_reference_unavailable" || issue.field.endsWith(".messageDesignId")) &&
        (!definition ||
          (() => {
            const [, index, property, field, tagIndex] = issue.field.split(".");
            const node = definition.nodes[Number(index)];
            if (!node) return false;
            if (property === "messageDesignId")
              return (node.kind === "email" || node.kind === "sms") && Boolean(node.messageDesignId);
            if (node.kind !== "condition" || !node.condition) return false;
            return field === "tagIds"
              ? Boolean(node.condition.tagIds?.[Number(tagIndex)])
              : Object.hasOwn(node.condition, field);
          })()),
    );
  const fixed =
    problem.code === "workflow_size_exceeded"
      ? "Workflow definition must not exceed 256 KiB."
      : problem.code === "workflow_json_invalid"
        ? "Use bounded plain JSON without accessors, sparse arrays or custom prototypes."
        : null;
  if (fixed)
    return (problem.errors ?? []).filter((issue) => issue.field === "definition" && issue.message === fixed);
  if (problem.code === "workflow_invalid" && definition) {
    const known = validateWorkflowDefinition(copyWorkflowJson(definition));
    return (problem.errors ?? []).filter((issue) =>
      known.some((candidate) => candidate.field === issue.field && candidate.message === issue.message),
    );
  }
  return [];
}

/** Clone own data descriptors before serialization; prototype hooks and getters never execute. */
function workflowJson(value: unknown, byteLimit = definitionBytes): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (item: unknown, depth: number): unknown => {
    if (++nodes > 25000 || depth > 24) throw new Error();
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item),
      prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(item);
    if (array && (item.length > 25000 || keys.length !== item.length + 1)) throw new Error();
    const clone = array ? Object.setPrototypeOf(new Array(item.length), null) : Object.create(null);
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      Object.defineProperty(clone, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(item);
    return clone;
  };
  try {
    const json = JSON.stringify(copy(value, 0));
    if (!json || new TextEncoder().encode(json).byteLength > byteLimit) throw new Error();
    return json;
  } catch {
    throw new Error("Workflow data could not be verified within its private memory limits.");
  }
}
export function copyWorkflowJson<T>(value: T, byteLimit = definitionBytes): T {
  return JSON.parse(workflowJson(value, byteLimit)) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function numericETag(etag: string): number {
  const match = etag.length <= 100 ? /^"([1-9][0-9]*)"$/.exec(etag) : null;
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("A strong workflow version is required.");
  return version;
}
function closedDefinition(value: unknown): WorkflowDefinition {
  const definition = copyWorkflowJson(value);
  if (!validateDefinition(definition))
    throw new Error("The closed workflow definition could not be verified.");
  return definition;
}
export function requireWorkflowVersion(
  value: unknown,
  campaignId: string,
  etag: string,
  expectedId?: string,
): WorkflowVersionReceipt {
  const version = copyWorkflowJson(value, responseBytes);
  if (
    !validateVersion(version) ||
    !Number.isSafeInteger(version.version) ||
    version.campaignId !== campaignId ||
    (expectedId && version.id !== expectedId) ||
    numericETag(etag) !== version.version
  )
    throw new Error("The immutable workflow identity, parent or version could not be verified.");
  closedDefinition(version.definition);
  return freeze({ data: version, etag });
}
export function requireWorkflowPage(value: unknown, campaignId: string): Schema<"PageCampaignVersion"> {
  const page = copyWorkflowJson(value, responseBytes);
  if (
    !validatePage(page) ||
    (page.hasMore ? !page.nextCursor || !page.items.length : page.nextCursor !== null)
  )
    throw new Error("The workflow version index or cursor could not be verified.");
  const ids = new Set<string>(),
    versions = new Set<number>();
  for (const item of page.items) {
    requireWorkflowVersion(item, campaignId, `"${item.version}"`);
    if (ids.has(item.id.toLowerCase()) || versions.has(item.version))
      throw new Error("The workflow version index contains a repeated immutable reference.");
    ids.add(item.id.toLowerCase());
    versions.add(item.version);
  }
  return freeze(page);
}

/** Actual streamed UTF-8 is bounded before JSON parsing; no private problem detail is surfaced. */
export async function readWorkflowJsonResponse(
  response: Response,
  definition?: WorkflowDefinition,
): Promise<unknown> {
  const reader = response.body?.getReader();
  const failure = () =>
    new ApiError(response.status, "Workflow data is unavailable. Verify current access or try again.");
  if (!reader) {
    if (!response.ok) throw failure();
    throw new Error("The workflow response is unavailable.");
  }
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseBytes) {
        await reader.cancel();
        throw new Error("Workflow transport exceeds its 1 MiB limit.");
      }
      if (chunk.value.byteLength) chunks.push(chunk.value);
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
    throw new Error("Workflow transport is not valid UTF-8 JSON.");
  }
  if (!response.ok) {
    const code =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "code") &&
      "code" in value &&
      typeof value.code === "string" &&
      validateCode(value.code)
        ? value.code
        : undefined;
    if (response.status === 422 && validateProblem(value) && value.status === response.status) {
      const issues = workflowProblemIssues(value, definition);
      if (issues.length) throw new WorkflowResponseError(response.status, value.code, issues);
    }
    throw new ApiError(response.status, failure().message, code);
  }
  return value;
}

/** The initial writer supports a complete wait/task chain only; every other graph stays intact. */
export function workflowLinearOrder(definition: WorkflowDefinition): readonly string[] | null {
  if (
    !definition.nodes.length ||
    definition.nodes.some((node) => node.kind !== "wait" && node.kind !== "task")
  )
    return null;
  const nodes = new Map(definition.nodes.map((node) => [node.key, node]));
  if (nodes.size !== definition.nodes.length) return null;
  const incoming = new Map<string, number>(),
    next = new Map<string, string>();
  for (const edge of definition.edges) {
    if (edge.branch !== "always" || !nodes.has(edge.from) || !nodes.has(edge.to) || next.has(edge.from))
      return null;
    next.set(edge.from, edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    if (incoming.get(edge.to)! > 1) return null;
  }
  const entries = definition.nodes.filter((node) => !incoming.has(node.key));
  if (entries.length !== 1) return null;
  const order: string[] = [],
    seen = new Set<string>();
  let key: string | undefined = entries[0].key;
  while (key) {
    if (seen.has(key)) return null;
    seen.add(key);
    order.push(key);
    key = next.get(key);
  }
  return order.length === nodes.size ? freeze(order) : null;
}
export function workflowLinearDefinition(
  nodes: readonly Schema<"WorkflowNode">[],
  previous: WorkflowDefinition,
): WorkflowDefinition {
  if (previous.nodes.length && !workflowLinearOrder(previous))
    throw new Error("Unsupported workflow graphs cannot be rewritten as a linear draft.");
  const copy = copyWorkflowJson({
    ...previous,
    nodes: [...nodes],
    edges: nodes.slice(0, -1).map(
      (node, index): Schema<"WorkflowEdge"> => ({
        from: node.key,
        to: nodes[index + 1].key,
        branch: "always",
      }),
    ),
  });
  if (copy.nodes.some((node) => node.kind !== "wait" && node.kind !== "task"))
    throw new Error("Unsupported workflow graphs cannot be rewritten as a linear draft.");
  return freeze(copy);
}
export function isWorkflowId(value: string): boolean {
  return validateId(value);
}

/** Closed transport serialization is detached and bounded even if global prototypes are polluted. */
export function workflowDefinitionJson(value: WorkflowDefinition): string {
  return workflowJson(closedDefinition(value));
}
export function workflowContextBinding(parts: readonly (string | number | boolean | null)[]): string {
  return workflowJson([...parts]);
}
export function sameWorkflowDefinition(left: WorkflowDefinition, right: WorkflowDefinition): boolean {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      const result = Object.create(null);
      for (const key of Object.keys(value).sort())
        result[key] = normalize((value as Record<string, unknown>)[key]);
      return result;
    }
    return value;
  };
  return workflowJson(normalize(copyWorkflowJson(left))) === workflowJson(normalize(copyWorkflowJson(right)));
}
