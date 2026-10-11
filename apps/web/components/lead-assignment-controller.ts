import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";
import {
  copyLeadAssignmentData,
  leadAssignmentBodyLimit,
  requireLeadAssignmentLead,
} from "./lead-assignment";
export { leadAssignmentRequest } from "./lead-assignment";

export const leadAssignmentMemberPageSize = 25;
export const leadAssignmentMemberLimit = 200;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:lead-assignment-members",
  components: {
    schemas: {
      Member: contract.components.schemas.Member,
      PageMember: contract.components.schemas.PageMember,
    },
  },
});
const validPage = ajv.compile<Schema<"PageMember">>({
  $ref: "estate:lead-assignment-members#/components/schemas/PageMember",
});
const validId = ajv.compile(contract.components.schemas.Lead.properties.id);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function validCursor(input: unknown): input is string {
  return typeof input === "string" && /^[\x21-\x7e]{1,8192}$/.test(input);
}
export function requireLeadAssignmentMembers(input: unknown): Readonly<Schema<"PageMember">> {
  const data = copyLeadAssignmentData(input).value;
  if (
    !validPage(data) ||
    data.items.length > leadAssignmentMemberPageSize ||
    (data.hasMore
      ? data.items.length !== leadAssignmentMemberPageSize || !validCursor(data.nextCursor)
      : data.nextCursor !== null) ||
    new Set(data.items.map((member) => member.id.toLowerCase())).size !== data.items.length ||
    data.items.some((member) => !Number.isSafeInteger(member.version) || !member.displayName.trim())
  )
    throw new Error("Current member choices are unavailable.");
  return freeze(data);
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Assignment response unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error();
      const chunk = await reader.read();
      if (signal.aborted) throw new Error();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > leadAssignmentBodyLimit) {
        cancel();
        throw new Error();
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
}
async function read(path: string, signal?: AbortSignal): Promise<{ data: unknown; etag: string | null }> {
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch("/api" + path, {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
    });
    if (!response.ok) {
      let code = "lead_assignment_read_failed";
      try {
        const problem = copyLeadAssignmentData(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Never display unverified/private response text. */
      }
      throw new ApiError(response.status, "Current assignment records are unavailable.", code);
    }
    if (response.status !== 200) throw new Error("Assignment response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
export async function readLeadAssignmentLead(
  organizationId: string,
  leadId: string,
  signal?: AbortSignal,
): Promise<{ data: Readonly<Schema<"Lead">>; etag: string }> {
  if (!validId(organizationId) || !validId(leadId)) throw new Error("Current lead identity is unavailable.");
  const response = await read(
    "/v1/orgs/" + encodeURIComponent(organizationId) + "/leads/" + encodeURIComponent(leadId),
    signal,
  );
  const lead = requireLeadAssignmentLead(response.data);
  if (lead.id.toLowerCase() !== leadId.toLowerCase() || response.etag !== `"${lead.version}"`)
    throw new Error("The current lead revision could not be verified.");
  return { data: lead, etag: response.etag };
}
export async function readLeadAssignmentMembers(
  organizationId: string,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<Readonly<Schema<"PageMember">>> {
  if (!validId(organizationId) || (cursor != null && !validCursor(cursor)))
    throw new Error("Current member choices are unavailable.");
  const response = await read(
    "/v1/orgs/" +
      encodeURIComponent(organizationId) +
      "/members?limit=25" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
    signal,
  );
  return requireLeadAssignmentMembers(response.data);
}
