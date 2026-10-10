import {
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNode,
  type WorkflowPreviewOptions,
  type WorkflowPreviewStep,
  WorkflowValidationError,
} from "./types";
import { validateWorkflowDefinition } from "./validation";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shared = [
  "current_member_scope",
  "marketing_entitlement",
  "current_campaign_version",
  "active_recipient",
];
const channelChecks = [
  "current_consent",
  "suppression_clear",
  "verified_sender",
  "provider_ready",
  "quiet_hours_check",
];
const prerequisites: Record<WorkflowNode["kind"], readonly string[]> = {
  wait: ["current_member_scope", "marketing_entitlement", "current_campaign_version"],
  task: [...shared, "crm_tasks_write", "crm_entitlement"],
  condition: [...shared, "scoped_lead_filter_references", "crm_leads_read", "crm_entitlement"],
  email: [...shared, "campaigns_send", "email_channel", "current_email_design", ...channelChecks],
  sms: [
    ...shared,
    "campaigns_send",
    "sms_entitlement",
    "sms_channel",
    "current_sms_design",
    ...channelChecks,
  ],
};

function startTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    return Number.NaN;
  const time = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, part: string | undefined) => `.${(part ?? "").padEnd(3, "0")}Z`,
  );
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? time : Number.NaN;
}

/**
 * Elapsed-clock preview only. Prerequisites are checks still required at future
 * execution; they assert no grant, channel readiness, consent or delivery state.
 * Timezone/quiet hours are validated metadata, never scheduler adjustments.
 */
export function previewWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowPreviewOptions,
): readonly WorkflowPreviewStep[] {
  const definitionIssues = validateWorkflowDefinition(definition);
  if (definitionIssues.length) throw new WorkflowValidationError("workflow_invalid", definitionIssues);
  const issues: WorkflowIssue[] = [];
  if (!record(options))
    throw new WorkflowValidationError("preview_options_invalid", [
      { field: "options", message: "Explicit preview options are required." },
    ]);
  if (Object.keys(options).some((key) => !["startInstant", "conditionChoices"].includes(key)))
    issues.push({ field: "options", message: "Unexpected preview options are not allowed." });
  let time = startTime(options.startInstant);
  if (!Number.isFinite(time))
    issues.push({ field: "startInstant", message: "Use an explicit valid UTC ISO start instant." });
  const choices = options.conditionChoices;
  const conditionNodes = definition.nodes.filter((node) => node.kind === "condition");
  if (!record(choices))
    issues.push({ field: "conditionChoices", message: "Explicit boolean choices are required." });
  else {
    const keys = new Set(conditionNodes.map((node) => node.key));
    if (Object.keys(choices).some((key) => !keys.has(key)))
      issues.push({ field: "conditionChoices", message: "Choices may name only condition nodes." });
    if (Object.keys(choices).some((key) => typeof choices[key] !== "boolean"))
      issues.push({ field: "conditionChoices", message: "Supplied condition choices must be boolean." });
  }
  if (issues.length) throw new WorkflowValidationError("preview_options_invalid", issues);
  const nodes = new Map(definition.nodes.map((node) => [node.key, node]));
  const destinations = new Set(definition.edges.map((edge) => edge.to));
  const steps: WorkflowPreviewStep[] = [];
  let key: string | undefined = definition.nodes.find((node) => !destinations.has(node.key))!.key;
  while (key !== undefined) {
    const node: WorkflowNode = nodes.get(key)!;
    if (node.kind === "condition" && !Object.hasOwn(choices, node.key))
      throw new WorkflowValidationError("preview_options_invalid", [
        { field: `conditionChoices.${node.key}`, message: "Choose true or false explicitly." },
      ]);
    if (node.kind === "wait") time += node.delaySeconds! * 1000;
    if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000)
      throw new WorkflowValidationError("preview_options_invalid", [
        { field: "startInstant", message: "The preview exceeds the supported instant range." },
      ]);
    steps.push(
      Object.freeze({
        nodeKey: node.key,
        kind: node.kind,
        at: new Date(time).toISOString(),
        prerequisites: Object.freeze([...prerequisites[node.kind]]),
      }),
    );
    const branch = node.kind === "condition" ? String(choices[node.key]) : "always";
    key = definition.edges.find((edge) => edge.from === node.key && edge.branch === branch)?.to;
  }
  return Object.freeze(steps);
}
