import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";
import { copyTaskEditData, requireTaskEditTask, taskEditBodyLimit } from "./task-edit";
export { taskEditRequest } from "./task-edit";

const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Task.properties.id);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

export type TaskEditReadTicket = Readonly<{ binding: string | null; taskId: string; generation: number }>;
export type TaskEditReadCurrent = Readonly<{
  binding: string | null;
  taskId: string | null;
  generation: number;
  active: boolean;
  online: boolean;
  visible: boolean;
  changingOrganization: boolean;
}>;
export function taskEditReadGuard(
  ticket: TaskEditReadTicket,
  current: TaskEditReadCurrent,
): Readonly<{ authorityCurrent: boolean; displayCurrent: boolean }> {
  try {
    const data = copyTaskEditData({ ticket, current }).value;
    const authorityCurrent =
      typeof data.ticket.binding === "string" &&
      Boolean(data.ticket.binding) &&
      data.ticket.binding === data.current.binding &&
      validId(data.ticket.taskId) &&
      validId(data.current.taskId) &&
      data.ticket.taskId.toLowerCase() === data.current.taskId!.toLowerCase() &&
      Number.isSafeInteger(data.ticket.generation) &&
      data.ticket.generation >= 0 &&
      data.ticket.generation === data.current.generation &&
      data.current.active === true;
    return Object.freeze({
      authorityCurrent,
      displayCurrent:
        authorityCurrent &&
        data.current.online === true &&
        data.current.visible === true &&
        data.current.changingOrganization === false,
    });
  } catch {
    return Object.freeze({ authorityCurrent: false, displayCurrent: false });
  }
}
export function taskEditReadFailureDisposition(
  ticket: TaskEditReadTicket,
  current: TaskEditReadCurrent,
  status?: number,
): "ignore" | "access-denied" | "source-unavailable" | "unavailable" {
  if (!taskEditReadGuard(ticket, current).authorityCurrent) return "ignore";
  return status === 401 || status === 403
    ? "access-denied"
    : status === 404
      ? "source-unavailable"
      : "unavailable";
}

export async function readTaskEditTask(
  organizationId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<{ data: Readonly<Schema<"Task">>; etag: string }> {
  if (!validId(organizationId) || !validId(taskId)) throw new Error("Current task identity is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" + encodeURIComponent(organizationId) + "/tasks/" + encodeURIComponent(taskId),
      { credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal },
    );
    if (!response.ok) {
      let code = "task_edit_read_failed";
      try {
        const problem = copyTaskEditData(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Never expose unknown/private response text. */
      }
      throw new ApiError(response.status, "Current task details are unavailable.", code);
    }
    if (response.status !== 200) throw new Error("Task response status is unexpected.");
    const task = requireTaskEditTask(await boundedJson(response, abort.signal)),
      etag = response.headers.get("ETag");
    if (task.id.toLowerCase() !== taskId.toLowerCase() || etag !== `"${task.version}"`)
      throw new Error("The current task revision could not be verified.");
    return { data: task, etag };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Task response unavailable.");
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
      if (bytes > taskEditBodyLimit) {
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
