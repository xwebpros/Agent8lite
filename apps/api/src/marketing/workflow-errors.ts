import { AccessError } from "../../../../packages/db/tenant-transaction";
import type { WorkflowIssue } from "../../../../packages/marketing";

/** Curated platform-owned issues only; arbitrary provider/SQL error properties are never projected. */
export class WorkflowCommandError extends AccessError {
  readonly errors: readonly WorkflowIssue[];
  constructor(status: number, code: string, message: string, issues: readonly WorkflowIssue[]) {
    super(status, code, message);
    this.errors = Object.freeze(issues.slice(0, 100).map((issue) => Object.freeze({ ...issue })));
  }
}

export function workflowReference(field: string, code = "workflow_reference_unavailable"): never {
  throw new WorkflowCommandError(422, code, "A workflow source prerequisite is unavailable.", [
    { field, message: "This source is unavailable or incompatible with the workflow." },
  ]);
}
