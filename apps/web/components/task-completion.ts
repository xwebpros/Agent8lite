import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";
import { requireTaskAgendaTask, taskAgendaSnapshot } from "./task-agenda-time";

export type TaskCompletionCommand = Readonly<{
  context: string;
  taskId: string;
  version: number;
  key: string;
  body: Readonly<Schema<"TaskWrite">>;
}>;
export type TaskCompletionSnapshot = Readonly<{
  command: TaskCompletionCommand | null;
  phase: "idle" | "sending" | "unknown";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validKey = ajv.compile({ type: "string", format: "uuid" });
const validWrite = ajv.compile<Schema<"TaskWrite">>(contract.components.schemas.TaskWrite);

/** One private command lifetime. Receipts acknowledge; they never replace current rows. */
export class TaskCompletionProtocol {
  private context: string | null = null;
  private snapshot: TaskCompletionSnapshot = Object.freeze({ command: null, phase: "idle" });
  private reconciliating = false;

  bind(context: string | null): void {
    if (context !== this.context) {
      this.clear();
      this.context = context;
    }
  }
  getSnapshot(): TaskCompletionSnapshot {
    return this.snapshot;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && context.length > 0 && context === this.context;
  }
  clear(): void {
    this.snapshot = Object.freeze({ command: null, phase: "idle" });
    this.reconciliating = false;
  }
  begin(input: unknown, key: string): TaskCompletionCommand {
    if (!this.context || this.snapshot.command || !validKey(key))
      throw new Error("Task completion requires current access and no unresolved command.");
    const task = requireTaskAgendaTask(input);
    if (task.state !== "open") throw new Error("Only a current open task can be completed.");
    const body: Schema<"TaskWrite"> = {
      title: task.title,
      dueAt: task.dueAt,
      timezone: task.timezone,
      assigneeMemberId: task.assigneeMemberId,
      priority: task.priority,
      state: "done",
      ...(Object.hasOwn(task, "leadId") ? { leadId: task.leadId } : {}),
    };
    if (!validWrite(body)) throw new Error("Task completion input could not be verified.");
    const command = taskAgendaSnapshot({
      context: this.context,
      taskId: task.id,
      version: task.version,
      key,
      body,
    });
    this.reconciliating = false;
    this.snapshot = Object.freeze({ command, phase: "sending" });
    return command;
  }
  retry(): TaskCompletionCommand {
    const command = this.snapshot.command;
    if (!command || command.context !== this.context || this.snapshot.phase !== "unknown")
      throw new Error("There is no unconfirmed completion available to reconcile.");
    this.reconciliating = true;
    this.snapshot = Object.freeze({ command, phase: "sending" });
    return command;
  }
  isCurrent(command: TaskCompletionCommand): boolean {
    return command === this.snapshot.command && command.context === this.context;
  }
  acknowledge(command: TaskCompletionCommand, value: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const task = requireTaskAgendaTask(value);
      if (
        !etag ||
        !/^"[1-9][0-9]*"$/.test(etag) ||
        Number(etag.slice(1, -1)) !== task.version ||
        task.id.toLowerCase() !== command.taskId.toLowerCase() ||
        task.version !== command.version + 1 ||
        task.state !== "done" ||
        task.title !== command.body.title.trim() ||
        task.assigneeMemberId.toLowerCase() !== command.body.assigneeMemberId.toLowerCase() ||
        task.timezone !== command.body.timezone ||
        task.priority !== command.body.priority ||
        new Date(task.dueAt).getTime() !== new Date(command.body.dueAt).getTime() ||
        (Object.hasOwn(command.body, "leadId") &&
          (task.leadId?.toLowerCase() ?? null) !== (command.body.leadId?.toLowerCase() ?? null))
      )
        throw new Error();
      this.clear();
      return true;
    } catch {
      this.snapshot = Object.freeze({ command, phase: "unknown" });
      return false;
    }
  }
  reject(command: TaskCompletionCommand, error: unknown): "cleared" | "unknown" | "ignored" {
    if (!this.isCurrent(command)) return "ignored";
    if (
      error instanceof ApiError &&
      (error.status === 401 ||
        error.status === 403 ||
        (!this.reconciliating && error.status >= 400 && error.status < 500 && error.status !== 408))
    ) {
      this.clear();
      return "cleared";
    }
    this.snapshot = Object.freeze({ command, phase: "unknown" });
    this.reconciliating = true;
    return "unknown";
  }
}
