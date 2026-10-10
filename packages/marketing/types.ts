import type { components } from "../contracts/generated/api";

export type WorkflowDefinition = components["schemas"]["CampaignVersionWrite"];
export type WorkflowNode = components["schemas"]["WorkflowNode"];
export type WorkflowEdge = components["schemas"]["WorkflowEdge"];
export type WorkflowCondition = components["schemas"]["LeadFilter"];
export type WorkflowIssue = Readonly<{ field: string; message: string }>;
export type WorkflowPreviewOptions = Readonly<{
  startInstant: string;
  conditionChoices: Readonly<Record<string, boolean>>;
}>;
export type WorkflowPreviewStep = Readonly<{
  nodeKey: string;
  kind: WorkflowNode["kind"];
  at: string;
  prerequisites: readonly string[];
}>;

/** Safe field issues contain neither definition content nor recipient/provider state. */
export class WorkflowValidationError extends Error {
  readonly issues: readonly WorkflowIssue[];
  constructor(
    readonly code: "workflow_invalid" | "preview_options_invalid",
    issues: readonly WorkflowIssue[],
  ) {
    super(code === "workflow_invalid" ? "Workflow definition is invalid." : "Preview options are invalid.");
    this.name = "WorkflowValidationError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}
