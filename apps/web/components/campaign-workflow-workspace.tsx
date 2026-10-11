"use client";

import {
  ArrowDown,
  ArrowUp,
  Clock3,
  Copy,
  GitBranch,
  ListOrdered,
  Plus,
  RefreshCw,
  Trash2,
  WifiOff,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { previewWorkflow, validateWorkflowDefinition } from "../../../packages/marketing";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
  type CampaignWorkflowState,
  type ConditionField,
} from "./campaign-workflow-controller";
import {
  WorkflowConditionCatalogue,
  type ConditionChoice,
  type WorkflowConditionCatalogueState,
} from "./campaign-workflow-condition-catalogue";
import {
  definitionOutline,
  outlineNodes,
  type Outline,
  type OutlineItem,
  type OutlineTarget,
} from "./campaign-workflow-outline";
import {
  workflowContextBinding,
  workflowDefinitionJson,
  type WorkflowDefinition,
} from "./campaign-workflow-protocol";
import { requestWorkflowJson } from "./campaign-workflow-request";
import {
  CampaignWorkflowDesignCatalogue,
  workflowDesignChoices,
  type WorkflowDesignCatalogueState,
  type WorkflowDesignChannel,
} from "./campaign-workflow-design-catalogue";
import { requestMessageDesign } from "./message-design-request";
import styles from "./campaign-workflow-workspace.module.css";

export type CampaignWorkflowWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  campaignId: string;
  /** Verified current member, when known; enables the "assigned to me" predicate only. */
  memberId?: string;
  onProtectedChange(value: boolean): void;
  onAccessRevoked?(): void;
};
type WorkflowActions = {
  refresh(): void;
  next(cursor: string): void;
  select(id: string): void;
  begin(): void;
  copy(): void;
  add(kind: "wait" | "task" | "email" | "sms" | "condition", target?: OutlineTarget): void;
  condition?(key: string, field: ConditionField, value: string | readonly string[] | null): void;
  moreTags?(): void;
  refreshDesigns(): void;
  nextDesigns(cursor: string): void;
  chooseDesign(key: string, id: string, channel: WorkflowDesignChannel): void;
  move(key: string, direction: -1 | 1): void;
  remove(key: string): void;
  editNode(key: string, value: string): void;
  timezone(value: string): void;
  quiet(value: WorkflowDefinition["quietHours"]): void;
  save(): void;
  discard(): void;
  editRejected(): void;
  start(value: string): void;
  choice(key: string, value: boolean): void;
  preview(): void;
};
const emptyConditionCatalogue: WorkflowConditionCatalogueState = Object.freeze({
  online: false,
  reading: false,
  phase: "unread",
  stages: null,
  sources: null,
  tags: null,
  tagCursor: null,
  error: "",
});
const prerequisiteLabels: Readonly<Record<string, string>> = {
  current_member_scope: "Current member scope",
  marketing_entitlement: "Marketing capability",
  current_campaign_version: "Current campaign version",
  active_recipient: "Active recipient",
  crm_tasks_write: "CRM task write permission",
  crm_entitlement: "CRM capability",
  scoped_lead_filter_references: "Scoped lead-filter references",
  crm_leads_read: "CRM lead read permission",
  campaigns_send: "Separate send permission",
  email_channel: "Email channel",
  current_email_design: "Current authorized email design",
  current_consent: "Current consent",
  suppression_clear: "No suppression",
  verified_sender: "Verified sender",
  provider_ready: "Provider readiness",
  quiet_hours_check: "Execution-time quiet-hour policy",
  sms_entitlement: "SMS capability",
  sms_channel: "SMS channel",
  current_sms_design: "Current authorized SMS design",
};

export function WorkflowDesignCheckButton({
  node,
  step,
  disabled,
  onCheck,
}: {
  node: Schema<"WorkflowNode">;
  step: number;
  disabled: boolean;
  onCheck: WorkflowActions["chooseDesign"];
}) {
  if ((node.kind !== "email" && node.kind !== "sms") || !node.messageDesignId) return null;
  const { key, kind, messageDesignId } = node;
  return (
    <Button
      type="button"
      variant="secondary"
      className={`button button-secondary ${styles.designCheck}`}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onCheck(key, messageDesignId, kind);
      }}
    >
      <RefreshCw size={16} aria-hidden="true" /> Check current design for step {step}
    </Button>
  );
}

/** Static presentation is testable without a browser; it exposes no command key or session context. */
export function CampaignWorkflowView({
  state,
  catalogue,
  active,
  online,
  actions,
  conditions = emptyConditionCatalogue,
  memberId,
}: {
  state: CampaignWorkflowState;
  catalogue: WorkflowDesignCatalogueState;
  active: boolean;
  online: boolean;
  actions: WorkflowActions;
  conditions?: WorkflowConditionCatalogueState;
  memberId?: string;
}) {
  const prefix = useId(),
    timezoneInput = useRef<HTMLInputElement>(null);
  const hasDraft = Boolean(state.draft);
  const emailChoices = useMemo(
    () => workflowDesignChoices(online ? catalogue.page : null, "email"),
    [catalogue.page, online],
  );
  const smsChoices = useMemo(
    () => workflowDesignChoices(online ? catalogue.page : null, "sms"),
    [catalogue.page, online],
  );
  useEffect(() => {
    if (hasDraft) timezoneInput.current?.focus();
  }, [hasDraft]);
  const protectedDraft = state.dirty || Boolean(state.pending) || state.phase === "sending";
  const locked = !online || state.reading || Boolean(state.pending) || state.phase === "sending";
  const definition = state.draft ?? (online ? state.selected?.data.definition : null);
  const outline: Outline | null = state.draft
    ? state.outline
    : definition
      ? definitionOutline(definition)
      : null;
  const rows = definition ? (outline ? outlineNodes(outline) : definition.nodes) : [];
  const canEdit = hasDraft && state.canWrite && !locked && !catalogue.reading;
  const definitionError = state.issues.length ? `${prefix}-issues` : undefined;
  const nodeInvalid = (key: string, field: string) => {
    const index = definition?.nodes.findIndex((node) => node.key === key);
    return (
      state.issues.some(
        (issue) =>
          issue.field === `nodes.${index}.${field}` ||
          issue.field.startsWith(`nodes.${index}.${field}.`) ||
          issue.field === `nodes.${index}`,
      ) || undefined
    );
  };
  const issueLabel = (field: string) => {
    const node = /^nodes\.(\d+)(?:\.(\w+))?/.exec(field);
    if (node) {
      const key = definition?.nodes[Number(node[1])]?.key;
      const index = rows.findIndex((item) => item.key === key);
      const label =
        node[2] === "taskTitle"
          ? "task title"
          : node[2] === "delaySeconds"
            ? "wait delay"
            : node[2] === "messageDesignId"
              ? "message design"
              : node[2] === "condition"
                ? "condition"
                : "definition";
      return `Step ${index + 1} ${label}`;
    }
    if (field === "timezone") return "Workflow timezone";
    if (field.startsWith("quietHours")) return "Quiet-hour metadata";
    if (field.startsWith("conditionChoices."))
      return `Preview branch for ${field.slice("conditionChoices.".length)}`;
    if (field === "startInstant") return "Virtual start instant";
    return "Workflow definition";
  };
  const renderMessage = (node: Schema<"WorkflowNode">, step: number) => (
    <>
      <p>
        {hasDraft ? "Draft design reference" : "Stored design reference"}:{" "}
        {node.messageDesignId ?? "No design chosen"}
      </p>
      {hasDraft && (
        <div>
          <label htmlFor={`${prefix}-${node.key}-design`}>
            {node.kind === "email" ? "Email" : "SMS"} design for step {step}
          </label>
          <select
            id={`${prefix}-${node.key}-design`}
            disabled={!canEdit || catalogue.reading || !catalogue.page}
            value={
              (node.kind === "email" ? emailChoices : smsChoices).some(
                (choice) => choice.id === node.messageDesignId,
              )
                ? node.messageDesignId
                : ""
            }
            aria-invalid={
              nodeInvalid(node.key, "messageDesignId") ||
              catalogue.nodeError?.nodeKey === node.key ||
              undefined
            }
            aria-describedby={
              [
                definitionError,
                catalogue.nodeError?.nodeKey === node.key ? `${prefix}-${node.key}-source-error` : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            onChange={(event) => {
              if (event.target.value)
                actions.chooseDesign(node.key, event.target.value, node.kind as WorkflowDesignChannel);
            }}
          >
            <option value="">
              {node.messageDesignId
                ? "Choose explicitly to replace or verify the reference"
                : "Choose a current native design"}
            </option>
            {(node.kind === "email" ? emailChoices : smsChoices).map((choice) => (
              <option value={choice.id} key={choice.id}>
                {choice.name} · observed version {choice.version}
              </option>
            ))}
          </select>
          {(node.kind === "email" ? emailChoices : smsChoices).some(
            (choice) => choice.id === node.messageDesignId,
          ) && (
            <WorkflowDesignCheckButton
              node={node}
              step={step}
              disabled={!canEdit || catalogue.reading}
              onCheck={actions.chooseDesign}
            />
          )}
          {catalogue.nodeError?.nodeKey === node.key && (
            <p id={`${prefix}-${node.key}-source-error`} role="alert" className={styles.error}>
              {catalogue.nodeError.message}
            </p>
          )}
          {!catalogue.reading &&
            catalogue.page &&
            !(node.kind === "email" ? emailChoices : smsChoices).length && (
              <p className={styles.help}>
                No compatible design on this page. Read another page or author a native design in the message
                design library.
              </p>
            )}
        </div>
      )}
      {hasDraft &&
        online &&
        catalogue.preview &&
        catalogue.previewNodeKey === node.key &&
        catalogue.preview.data.id === node.messageDesignId && (
          <section className={styles.designPreview} aria-label={`Current observed design for step ${step}`}>
            <h4>{catalogue.preview.data.name}</h4>
            <p>
              Current design version {catalogue.preview.data.version}. Saving verifies it again; sending
              eligibility is not checked.
            </p>
            {catalogue.preview.data.subject != null && <p>Subject: {catalogue.preview.data.subject}</p>}
            <pre>{catalogue.preview.data.content}</pre>
          </section>
        )}
      <p className={styles.notice}>
        Current design access, sender, consent, suppression, channel entitlement and provider checks remain
        required before any future execution. No message is sent.
      </p>
    </>
  );
  const stepNumber = (key: string) => rows.findIndex((item) => item.key === key) + 1;
  const kindLabel = (kind: Schema<"WorkflowNode">["kind"]) =>
    kind === "wait"
      ? "Wait"
      : kind === "task"
        ? "Task"
        : kind === "condition"
          ? "Condition"
          : kind === "email"
            ? "Email reference"
            : "SMS reference";
  const branchAdd = (parent: string, branch: "true" | "false", step: number) => {
    const where = branch === "true" ? "matching" : "otherwise";
    return (
      <div className={styles.actions}>
        {(["wait", "task", "email", "sms", "condition"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="secondary"
            disabled={!canEdit || rows.length >= 100}
            aria-label={`Add ${kind === "sms" ? "SMS" : kind} ${kind === "condition" ? "" : "step "}to the ${where} branch of step ${step}`}
            onClick={() => actions.add(kind, { parent, branch })}
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {kind === "sms" ? "SMS" : kind[0].toUpperCase() + kind.slice(1)}
          </Button>
        ))}
      </div>
    );
  };
  const renderCondition = (node: Schema<"WorkflowNode">, step: number) => {
    const condition = node.condition ?? {};
    const unknown = "Saved reference (not in the current list)";
    const selectFor = (
      field: "stageId" | "sourceId",
      label: string,
      choices: readonly ConditionChoice[] | null,
    ) => {
      const value = condition[field] ?? "";
      const known = !value || Boolean(choices?.some((choice) => choice.id === value));
      return (
        <div>
          <label htmlFor={`${prefix}-${node.key}-${field}`}>
            {label} for condition step {step}
          </label>
          <select
            id={`${prefix}-${node.key}-${field}`}
            value={value}
            disabled={!canEdit || (!choices && !value)}
            aria-invalid={nodeInvalid(node.key, `condition.${field}`)}
            aria-describedby={definitionError}
            onChange={(event) => actions.condition?.(node.key, field, event.target.value || null)}
          >
            <option value="">Any</option>
            {!known && <option value={value}>{unknown}</option>}
            {(choices ?? []).map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      );
    };
    if (!hasDraft)
      return (
        <>
          <p>Allowlisted lead-filter predicates:</p>
          <dl className={styles.references}>
            {Object.entries(condition).map(([field, value]) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
              </div>
            ))}
          </dl>
        </>
      );
    const tags = condition.tagIds ?? [];
    const savedTags = tags.filter((id) => !conditions.tags?.some((choice) => choice.id === id));
    const toggleTag = (id: string, checked: boolean) =>
      actions.condition?.(node.key, "tagIds", checked ? [...tags, id] : tags.filter((tag) => tag !== id));
    return (
      <fieldset disabled={!canEdit} className={styles.policy}>
        <legend>Lead must match every chosen field (condition step {step})</legend>
        <div>
          <label htmlFor={`${prefix}-${node.key}-intent`}>Lead intent for condition step {step}</label>
          <select
            id={`${prefix}-${node.key}-intent`}
            value={condition.intent ?? ""}
            aria-invalid={nodeInvalid(node.key, "condition.intent")}
            aria-describedby={definitionError}
            onChange={(event) => actions.condition?.(node.key, "intent", event.target.value || null)}
          >
            <option value="">Any</option>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
            <option value="both">Buyer and seller</option>
            <option value="unknown">Unknown</option>
          </select>
        </div>
        {selectFor("stageId", "Pipeline stage", conditions.stages)}
        {selectFor("sourceId", "Lead source", conditions.sources)}
        <fieldset className={styles.policy}>
          <legend>Tags for condition step {step} (all chosen tags must be present)</legend>
          {savedTags.map((id) => (
            <label key={id} className={styles.checkbox}>
              <input type="checkbox" checked onChange={() => toggleTag(id, false)} /> {unknown}
            </label>
          ))}
          {(conditions.tags ?? []).map((choice) => (
            <label key={choice.id} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={tags.includes(choice.id)}
                disabled={!tags.includes(choice.id) && tags.length >= 20}
                onChange={(event) => toggleTag(choice.id, event.target.checked)}
              />{" "}
              {choice.label}
            </label>
          ))}
          {conditions.tagCursor && (
            <Button
              type="button"
              variant="secondary"
              disabled={conditions.reading}
              onClick={() => actions.moreTags?.()}
            >
              Read more tag choices
            </Button>
          )}
          {!conditions.tags && !savedTags.length && (
            <p className={styles.help}>Tag choices are not verified.</p>
          )}
        </fieldset>
        {(memberId || condition.ownerMemberId) && (
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={Boolean(condition.ownerMemberId)}
              onChange={(event) =>
                actions.condition?.(
                  node.key,
                  "ownerMemberId",
                  event.target.checked && memberId ? memberId : null,
                )
              }
            />{" "}
            {condition.ownerMemberId && condition.ownerMemberId !== memberId
              ? "Saved owner reference (clear to remove)"
              : "Only leads assigned to me"}
          </label>
        )}
        <div>
          <label htmlFor={`${prefix}-${node.key}-q`}>Lead name contains (condition step {step})</label>
          <input
            id={`${prefix}-${node.key}-q`}
            value={condition.q ?? ""}
            maxLength={400}
            autoComplete="off"
            aria-invalid={nodeInvalid(node.key, "condition.q")}
            aria-describedby={definitionError}
            onChange={(event) => actions.condition?.(node.key, "q", event.target.value || null)}
          />
        </div>
        {conditions.reading && <p role="status">Reading current condition choices…</p>}
        {conditions.error && (
          <p role="alert" className={styles.error}>
            {conditions.error}
          </p>
        )}
      </fieldset>
    );
  };
  const renderStep = (
    node: Schema<"WorkflowNode">,
    position: Readonly<{ index: number; length: number }> | null,
    item?: OutlineItem,
  ) => {
    const step = stepNumber(node.key);
    return (
      <>
        <div className={styles.heading}>
          <h4>
            {step}. {kindLabel(node.kind)}
          </h4>
          <Badge>{node.key}</Badge>
        </div>
        {hasDraft && node.kind === "wait" ? (
          <div>
            <label htmlFor={`${prefix}-${node.key}`}>Wait delay in seconds for step {step}</label>
            <input
              id={`${prefix}-${node.key}`}
              type="number"
              min={0}
              max={31536000}
              step={1}
              required
              disabled={!canEdit}
              value={node.delaySeconds ?? ""}
              aria-invalid={nodeInvalid(node.key, "delaySeconds")}
              aria-describedby={definitionError}
              onChange={(event) => actions.editNode(node.key, event.target.value)}
            />
          </div>
        ) : (
          node.kind === "wait" && <p>Elapsed wait: {node.delaySeconds} seconds.</p>
        )}
        {hasDraft && node.kind === "task" ? (
          <div>
            <label htmlFor={`${prefix}-${node.key}`}>Task title for step {step}</label>
            <input
              id={`${prefix}-${node.key}`}
              required
              disabled={!canEdit}
              value={node.taskTitle ?? ""}
              aria-invalid={nodeInvalid(node.key, "taskTitle")}
              aria-describedby={definitionError}
              maxLength={400}
              autoComplete="off"
              onChange={(event) => actions.editNode(node.key, event.target.value)}
            />
            <p className={styles.caption}>
              Up to 200 characters. Saving this definition does not create a CRM task.
            </p>
          </div>
        ) : (
          node.kind === "task" && <p>{node.taskTitle}</p>
        )}
        {node.kind === "condition" && renderCondition(node, step)}
        {(node.kind === "email" || node.kind === "sms") && renderMessage(node, step)}
        {!hasDraft && !outline && (
          <ul className={styles.links}>
            {definition!.edges
              .filter((edge) => edge.from === node.key)
              .map((edge) => (
                <li key={`${edge.to}-${edge.branch}`}>
                  {edge.branch} → {edge.to}
                </li>
              ))}
          </ul>
        )}
        {item?.type === "condition" &&
          (["true", "false"] as const).map((branch) => {
            const list = branch === "true" ? item.whenTrue : item.whenFalse;
            return (
              <section
                key={branch}
                className={styles.branch}
                aria-label={`${branch === "true" ? "When the lead matches" : "Otherwise"}, step ${step}`}
              >
                <h5>{branch === "true" ? "When the lead matches" : "Otherwise"}</h5>
                {list.length ? (
                  renderList(list)
                ) : (
                  <p className={styles.help}>
                    No steps in this branch. It continues with the step after this condition.
                  </p>
                )}
                {hasDraft && branchAdd(node.key, branch, step)}
              </section>
            );
          })}
        {hasDraft && position && (
          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              disabled={!canEdit || position.index === 0}
              aria-label={`Move step ${step} up`}
              onClick={() => actions.move(node.key, -1)}
            >
              <ArrowUp size={16} aria-hidden="true" /> Move up
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canEdit || position.index === position.length - 1}
              aria-label={`Move step ${step} down`}
              onClick={() => actions.move(node.key, 1)}
            >
              <ArrowDown size={16} aria-hidden="true" /> Move down
            </Button>
            <Button
              type="button"
              variant="quiet"
              disabled={!canEdit}
              aria-label={`Remove step ${step}`}
              onClick={() => actions.remove(node.key)}
            >
              <Trash2 size={16} aria-hidden="true" /> Remove
            </Button>
          </div>
        )}
      </>
    );
  };
  function renderList(list: Outline): ReactNode {
    return (
      <ol className={styles.steps}>
        {list.map((item, index) => (
          <li key={item.node.key} className={styles.step}>
            {renderStep(item.node, { index, length: list.length }, item)}
          </li>
        ))}
      </ol>
    );
  }
  if (!active)
    return (
      <Empty icon={<GitBranch size={30} />} title="Synthetic workflow drafts unavailable">
        Choose an organization in an explicitly enabled synthetic session.
      </Empty>
    );
  if (!state.canRead)
    return (
      <Empty icon={<GitBranch size={30} />} title="Workflow read access unavailable">
        Current organization-scoped campaign read access and marketing capability are required.
      </Empty>
    );
  if (state.phase === "unavailable")
    return (
      <Empty
        icon={<GitBranch size={30} />}
        title="Workflow capability or references unavailable"
        action={
          <Button variant="secondary" disabled={!online || state.reading} onClick={actions.refresh}>
            Verify current workflow access
          </Button>
        }
      >
        {state.message} Earlier commands may have committed; verify current versions after access returns.
      </Empty>
    );
  if (state.phase === "denied")
    return (
      <Empty icon={<GitBranch size={30} />} title="Workflow access changed">
        {state.message}
      </Empty>
    );
  return (
    <section className={styles.workspace} aria-label="Synthetic immutable campaign workflow drafts">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Workflow versions</p>
          <h2>Build an ordered workflow draft</h2>
          <p>Save an immutable definition. Preview follows a fixed virtual clock.</p>
        </div>
        <Badge tone="warning">Synthetic · no execution</Badge>
      </header>
      <p className={styles.notice}>
        Saving appends a draft version. It does not publish, enroll contacts, create CRM tasks, schedule
        actions or send messages. Timezone and quiet hours are preserved metadata; this preview does not
        execute their policy.
      </p>
      {!online && (
        <p className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" /> Offline. Fetched versions and previews are cleared;
          protected local drafts or original commands stay in this tab.
        </p>
      )}
      <div className={styles.layout}>
        <section className={styles.card} aria-label="Immutable workflow version index">
          <div className={styles.heading}>
            <h3>
              <ListOrdered size={20} aria-hidden="true" /> Saved versions
            </h3>
            <Button
              variant="secondary"
              disabled={!online || state.reading || protectedDraft}
              onClick={actions.refresh}
            >
              <RefreshCw size={16} aria-hidden="true" /> Refresh versions
            </Button>
          </div>
          <p className={styles.help}>
            Select an exact version to read it. The list does not automatically choose a latest definition.
          </p>
          {state.reading && <p role="status">Reading authorized workflow versions…</p>}
          {state.listError && (
            <p className={styles.error} role="alert">
              {state.listError}
            </p>
          )}
          {state.pageStale && (
            <p className={styles.notice}>
              This retained index may be stale. Refresh before relying on current availability.
            </p>
          )}
          {online && state.page ? (
            <>
              {!state.page.items.length ? (
                <p>No saved workflow versions on this verified page.</p>
              ) : (
                <ul className={styles.versions}>
                  {state.page.items.map((item) => (
                    <li key={item.id}>
                      <Button
                        variant="quiet"
                        className={`button button-quiet ${styles.version}`}
                        disabled={state.reading || protectedDraft}
                        onClick={() => actions.select(item.id)}
                      >
                        <span>
                          <strong>Version {item.version}</strong>
                          <span>{item.definition.nodes.length} stored steps</span>
                        </span>
                        <Badge>{item.state === "published" ? "Published" : "Draft"}</Badge>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {state.page.hasMore && state.page.nextCursor && (
                <Button
                  variant="secondary"
                  disabled={state.reading || protectedDraft}
                  onClick={() => actions.next(state.page!.nextCursor!)}
                >
                  Read next version page
                </Button>
              )}
            </>
          ) : (
            <p role="status">The workflow version index has not been read successfully.</p>
          )}
          {state.canWrite && (
            <Button disabled={!online || state.reading || protectedDraft} onClick={actions.begin}>
              <Plus size={17} aria-hidden="true" /> Start new workflow draft
            </Button>
          )}
        </section>
        <section className={styles.card} aria-label="Workflow definition editor">
          <div className={styles.heading}>
            <h3>{hasDraft ? "New local workflow draft" : "Selected immutable definition"}</h3>
            {online && state.selected && <Badge>Version {state.selected.data.version}</Badge>}
          </div>
          <p className={styles.help} role="status" aria-live="polite">
            {state.message}
          </p>
          {state.error && (
            <p className={styles.error} role="alert">
              {state.error}
            </p>
          )}
          {online && state.selected && !hasDraft && (
            <>
              <dl className={styles.references}>
                <dt>Immutable version reference</dt>
                <dd>{state.selected.data.id}</dd>
                <dt>Stored timezone</dt>
                <dd>{state.selected.data.definition.timezone}</dd>
                {state.selected.data.definition.quietHours && (
                  <>
                    <dt>Stored quiet hours</dt>
                    <dd>
                      {state.selected.data.definition.quietHours.start}–
                      {state.selected.data.definition.quietHours.end}
                    </dd>
                  </>
                )}
              </dl>
              {state.canWrite && (
                <Button variant="secondary" disabled={locked || !outline} onClick={actions.copy}>
                  <Copy size={17} aria-hidden="true" /> Copy to new workflow draft
                </Button>
              )}
              {!outline && (
                <p className={styles.notice}>
                  This saved graph stays read-only. Its branches or joins cannot be represented in the
                  structured editor without changing it. Its nodes and edges are preserved intact.
                </p>
              )}
            </>
          )}
          {hasDraft && (
            <section className={styles.designCatalogue} aria-label="Current native message design catalogue">
              <div className={styles.heading}>
                <h4>Current native message designs</h4>
                <Button
                  variant="secondary"
                  disabled={!online || catalogue.reading || state.phase === "sending"}
                  onClick={actions.refreshDesigns}
                >
                  <RefreshCw size={16} aria-hidden="true" /> Refresh design choices
                </Button>
              </div>
              <p className={styles.help}>
                Choose a design explicitly for each message step. Saving verifies the current design and keeps
                its revision with the workflow.
              </p>
              {catalogue.reading && <p role="status">Reading current authorized design choices…</p>}
              {catalogue.error && (
                <p role="alert" className={styles.error}>
                  {catalogue.error}
                </p>
              )}
              {online && catalogue.page ? (
                <>
                  <p className={styles.help}>
                    This verified page has {emailChoices.length} native email and {smsChoices.length} native
                    SMS choices. Other formats cannot be selected here.
                  </p>
                  {catalogue.page.hasMore && catalogue.page.nextCursor && (
                    <Button
                      variant="secondary"
                      disabled={catalogue.reading || state.phase === "sending"}
                      onClick={() => actions.nextDesigns(catalogue.page!.nextCursor!)}
                    >
                      Read next design page
                    </Button>
                  )}
                </>
              ) : (
                <p role="status">
                  Current design choices have not been verified. Read the catalogue while online.
                </p>
              )}
            </section>
          )}
          {hasDraft && state.draft && (
            <fieldset disabled={!canEdit} className={styles.policy}>
              <legend>Draft timezone and quiet-hour metadata</legend>
              <label htmlFor={`${prefix}-timezone`}>Workflow timezone</label>
              <input
                ref={timezoneInput}
                id={`${prefix}-timezone`}
                value={state.draft.timezone}
                aria-invalid={state.issues.some((issue) => issue.field === "timezone") || undefined}
                aria-describedby={definitionError}
                required
                maxLength={80}
                autoComplete="off"
                onChange={(event) => actions.timezone(event.target.value)}
              />
              <p className={styles.help}>Use UTC or an IANA zone, for example America/Los_Angeles.</p>
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={Boolean(state.draft.quietHours)}
                  onChange={(event) =>
                    actions.quiet(event.target.checked ? { start: "22:00", end: "07:00" } : undefined)
                  }
                />{" "}
                Preserve quiet-hour metadata
              </label>
              {state.draft.quietHours && (
                <div className={styles.times}>
                  <div>
                    <label htmlFor={`${prefix}-quiet-start`}>Quiet-hour start</label>
                    <input
                      id={`${prefix}-quiet-start`}
                      type="time"
                      step={60}
                      value={state.draft.quietHours.start}
                      aria-invalid={
                        state.issues.some((issue) => issue.field.startsWith("quietHours")) || undefined
                      }
                      aria-describedby={definitionError}
                      required
                      onChange={(event) =>
                        actions.quiet({ ...state.draft!.quietHours!, start: event.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label htmlFor={`${prefix}-quiet-end`}>Quiet-hour end</label>
                    <input
                      id={`${prefix}-quiet-end`}
                      type="time"
                      step={60}
                      value={state.draft.quietHours.end}
                      aria-invalid={
                        state.issues.some((issue) => issue.field.startsWith("quietHours")) || undefined
                      }
                      aria-describedby={definitionError}
                      required
                      onChange={(event) =>
                        actions.quiet({ ...state.draft!.quietHours!, end: event.target.value })
                      }
                    />
                  </div>
                </div>
              )}
            </fieldset>
          )}
          {definition ? (
            <>
              <h4>{outline ? "Execution outline" : "Stored graph nodes"}</h4>
              {rows.length ? (
                outline ? (
                  renderList(outline)
                ) : (
                  <ol className={styles.steps}>
                    {rows.map((node) => (
                      <li key={node.key} className={styles.step}>
                        {renderStep(node, null)}
                      </li>
                    ))}
                  </ol>
                )
              ) : (
                <p>
                  Add at least one wait, task, condition, email or SMS step. An empty definition cannot be
                  saved.
                </p>
              )}
            </>
          ) : (
            <p>Select a saved version explicitly or start a new local workflow draft.</p>
          )}
          {hasDraft && (
            <>
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  disabled={!canEdit || rows.length >= 100}
                  onClick={() => actions.add("wait")}
                >
                  <Clock3 size={17} aria-hidden="true" /> Add wait step
                </Button>
                <Button
                  variant="secondary"
                  disabled={!canEdit || rows.length >= 100}
                  onClick={() => actions.add("task")}
                >
                  <Plus size={17} aria-hidden="true" /> Add task step
                </Button>
                <Button
                  variant="secondary"
                  disabled={!canEdit || rows.length >= 100}
                  onClick={() => actions.add("email")}
                >
                  <Plus size={17} aria-hidden="true" /> Add email step
                </Button>
                <Button
                  variant="secondary"
                  disabled={!canEdit || rows.length >= 100}
                  onClick={() => actions.add("sms")}
                >
                  <Plus size={17} aria-hidden="true" /> Add SMS step
                </Button>
                <Button
                  variant="secondary"
                  disabled={!canEdit || rows.length >= 100}
                  onClick={() => actions.add("condition")}
                >
                  <GitBranch size={17} aria-hidden="true" /> Add condition
                </Button>
              </div>
              <p className={styles.help}>
                A condition checks allowlisted lead fields and has two branches that rejoin at the next step.
                Message references do not verify sending eligibility or activate a channel.
              </p>
              {state.issues.length > 0 && (
                <div id={`${prefix}-issues`} className={styles.error} role="alert">
                  <h4>Review definition fields</h4>
                  <ul>
                    {state.issues.map((issue, index) => (
                      <li key={`${issue.field}-${index}`}>
                        <strong>{issueLabel(issue.field)}</strong>: {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className={styles.actions}>
                <Button
                  disabled={
                    !online ||
                    state.reading ||
                    (!state.pending && catalogue.reading) ||
                    state.phase === "sending" ||
                    (!state.pending && Boolean(state.issues.length))
                  }
                  onClick={actions.save}
                >
                  {state.phase === "sending"
                    ? "Saving workflow version…"
                    : state.pending
                      ? "Retry original workflow command"
                      : "Save immutable workflow draft"}
                </Button>
                {state.phase === "rejected" && (
                  <Button
                    variant="secondary"
                    disabled={!online || state.reading}
                    onClick={actions.editRejected}
                  >
                    Edit rejected workflow draft
                  </Button>
                )}
                <Button
                  variant="quiet"
                  disabled={Boolean(state.pending) || state.phase === "sending" || state.reading}
                  onClick={actions.discard}
                >
                  Discard local workflow draft
                </Button>
              </div>
              {state.phase === "uncertain" && (
                <p className={styles.notice}>
                  The original graph and command key are protected. Do not replace or discard them while the
                  outcome is unknown.
                </p>
              )}
            </>
          )}
          {definition && (
            <section className={styles.preview} aria-label="Deterministic virtual workflow preview">
              <h3>Virtual-clock preview</h3>
              <p className={styles.help}>
                This local preview follows one explicitly chosen path. It does not evaluate a real lead, apply
                quiet hours or DST scheduling, verify eligibility, or execute an action.
              </p>
              <label htmlFor={`${prefix}-start`}>Virtual start instant in UTC ISO format</label>
              <input
                id={`${prefix}-start`}
                value={state.startInstant}
                aria-invalid={
                  state.previewIssues.some((issue) => issue.field === "startInstant") || undefined
                }
                aria-describedby={state.previewIssues.length ? `${prefix}-preview-issues` : undefined}
                maxLength={40}
                autoComplete="off"
                disabled={locked}
                onChange={(event) => actions.start(event.target.value)}
              />
              {definition.nodes
                .filter((node) => node.kind === "condition")
                .map((node) => (
                  <div key={node.key}>
                    <label htmlFor={`${prefix}-choice-${node.key}`}>
                      Explicit preview branch for {node.key}
                    </label>
                    <select
                      id={`${prefix}-choice-${node.key}`}
                      value={
                        Object.hasOwn(state.conditionChoices, node.key)
                          ? String(state.conditionChoices[node.key])
                          : ""
                      }
                      disabled={locked}
                      aria-invalid={
                        state.previewIssues.some((issue) => issue.field === `conditionChoices.${node.key}`) ||
                        undefined
                      }
                      aria-describedby={state.previewIssues.length ? `${prefix}-preview-issues` : undefined}
                      onChange={(event) => {
                        if (event.target.value) actions.choice(node.key, event.target.value === "true");
                      }}
                    >
                      <option value="">Choose a branch if this condition is reached</option>
                      <option value="true">True branch</option>
                      <option value="false">False branch</option>
                    </select>
                  </div>
                ))}
              <Button variant="secondary" disabled={locked} onClick={actions.preview}>
                Preview chosen virtual path
              </Button>
              {state.previewIssues.length > 0 && (
                <ul id={`${prefix}-preview-issues`} className={styles.error} role="alert">
                  {state.previewIssues.map((issue, index) => (
                    <li key={`${issue.field}-${index}`}>
                      {issueLabel(issue.field)}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {online && state.preview && (
                <ol className={styles.timeline}>
                  {state.preview.map((step) => (
                    <li key={step.nodeKey}>
                      <strong>
                        {step.nodeKey} · {step.kind}
                      </strong>
                      <time dateTime={step.at}>{step.at}</time>
                      <p>Checks still required before any future execution:</p>
                      <ul>
                        {step.prerequisites.map((code) => (
                          <li key={code}>{prerequisiteLabels[code] ?? code}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
          {online && state.receipt && (
            <section className={styles.receipt} aria-label="Historical immutable workflow acknowledgment">
              <h3>Draft version acknowledged</h3>
              <p>
                Version {state.receipt.data.version} may be a historical command receipt. It does not prove
                current source eligibility, publication, enrollment or delivery.
              </p>
              <p>Version reference: {state.receipt.data.id}</p>
              <Button
                variant="secondary"
                disabled={state.reading || protectedDraft}
                onClick={() => actions.select(state.receipt!.data.id)}
              >
                Read exact acknowledged version
              </Button>
            </section>
          )}
        </section>
      </div>
    </section>
  );
}

export default function CampaignWorkflowWorkspace(props: CampaignWorkflowWorkspaceProps) {
  const { session, csrf, online, syntheticFeaturesEnabled, accessRevision, campaignId } = props;
  const canRead = session.permissions.includes("campaigns.read"),
    canWrite = session.permissions.includes("campaigns.write");
  const active = syntheticFeaturesEnabled && Boolean(session.activeOrgId);
  const binding = workflowContextBinding([
    session.userId,
    session.activeOrgId,
    campaignId,
    accessRevision,
    csrf,
    active,
    canRead,
    canWrite,
  ]);
  const live = useRef({ binding, online, active, props });
  live.current = { binding, online, active, props };
  const controller = useMemo(() => {
    const versionBase = `/api/v1/orgs/${session.activeOrgId}/campaign-versions`;
    const indexBase = `/api/v1/orgs/${session.activeOrgId}/campaigns/${campaignId}/versions`;
    const request = async (
      path: string,
      expected: number,
      options: RequestInit = {},
      definition?: WorkflowDefinition,
    ) => {
      if (live.current.binding !== binding || !live.current.online || !live.current.active)
        throw new Error("The original workflow context is unavailable.");
      return requestWorkflowJson(path, expected, options, definition);
    };
    const client: CampaignWorkflowClient = {
      async list(cursor) {
        return (
          await request(
            `${indexBase}?${new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) })}`,
            200,
          )
        ).data;
      },
      detail: (id) => request(`${versionBase}/${id}`, 200),
      create(command) {
        if (command.binding !== binding || command.campaignId !== campaignId)
          throw new Error("The original workflow command belongs to another context.");
        return request(
          indexBase,
          201,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
              "Idempotency-Key": command.idempotencyKey,
            },
            body: workflowDefinitionJson(command.body),
          },
          command.body,
        );
      },
    };
    return new CampaignWorkflowController({
      binding,
      campaignId,
      client,
      online: live.current.online,
      canRead,
      canWrite,
      validate: validateWorkflowDefinition,
      preview: previewWorkflow,
      createKey: () => crypto.randomUUID(),
      onProtectedChange(value) {
        if (live.current.binding === binding) live.current.props.onProtectedChange(value);
      },
      onAccessRevoked() {
        if (live.current.binding === binding) live.current.props.onAccessRevoked?.();
      },
    });
  }, [binding, campaignId, session.activeOrgId, csrf, canRead, canWrite]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const catalogueController = useMemo(() => {
    const designBase = `/api/v1/orgs/${session.activeOrgId}/message-designs`;
    const current = () =>
      live.current.binding === binding &&
      live.current.online &&
      live.current.active &&
      canRead &&
      !["unavailable", "denied"].includes(controller.getSnapshot().phase);
    const request = (path: string) => {
      if (!current()) throw new Error("The current design context is unavailable.");
      return requestMessageDesign(path, 200);
    };
    return new CampaignWorkflowDesignCatalogue({
      online: live.current.online,
      client: {
        async list(cursor) {
          return (
            await request(
              `${designBase}?${new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) })}`,
            )
          ).data;
        },
        detail: (id) => request(`${designBase}/${id}`),
      },
      isCurrent: current,
      applySelection: (key, receipt) => controller.chooseDesign(key, receipt),
      onSourceUnavailable: (key, id) => controller.designUnavailable(key, id),
      onAuthorityLost: (error) => controller.sourceAccessLost(error),
    });
  }, [binding, controller, session.activeOrgId, canRead]);
  const catalogue = useSyncExternalStore(
    catalogueController.subscribe,
    catalogueController.getSnapshot,
    catalogueController.getSnapshot,
  );
  const permitted = {
    stages: session.permissions.includes("crm.pipeline.read"),
    sources: session.permissions.includes("crm.sources.read"),
    tags: session.permissions.includes("crm.tags.read"),
  };
  const conditionController = useMemo(() => {
    const base = `/api/v1/orgs/${session.activeOrgId}`;
    const current = () =>
      live.current.binding === binding &&
      live.current.online &&
      live.current.active &&
      !["unavailable", "denied"].includes(controller.getSnapshot().phase);
    const read = async (path: string) => {
      if (!current()) throw new Error("The current condition context is unavailable.");
      return (await requestWorkflowJson(path, 200)).data;
    };
    return new WorkflowConditionCatalogue({
      online: live.current.online,
      permitted: { stages: permitted.stages, sources: permitted.sources, tags: permitted.tags },
      client: {
        stages: () => read(`${base}/pipeline-stages?limit=100`),
        sources: () => read(`${base}/lead-sources?limit=100`),
        tags: (cursor) =>
          read(`${base}/tags?${new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) })}`),
      },
      isCurrent: current,
      onAuthorityLost: (error) => controller.sourceAccessLost(error),
    });
    // The binding already includes the permission set through the controller identity.
  }, [binding, controller, session.activeOrgId, permitted.stages, permitted.sources, permitted.tags]);
  const conditions = useSyncExternalStore(
    conditionController.subscribe,
    conditionController.getSnapshot,
    conditionController.getSnapshot,
  );
  const hasCondition = Boolean(
    state.outline && outlineNodes(state.outline).some((node) => node.kind === "condition"),
  );
  useEffect(() => {
    conditionController.attach();
    return () => conditionController.detach();
  }, [conditionController]);
  useEffect(() => {
    conditionController.setOnline(online);
  }, [conditionController, online]);
  useEffect(() => {
    if (["unavailable", "denied"].includes(state.phase) || !state.draft) conditionController.invalidate();
    else if (hasCondition && online) void conditionController.load();
  }, [conditionController, hasCondition, online, state.phase, Boolean(state.draft)]);
  useEffect(() => {
    controller.attach();
    live.current.props.onProtectedChange(controller.isProtected());
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    controller.setOnline(online);
    catalogueController.setOnline(online);
  }, [controller, catalogueController, online]);
  useEffect(() => {
    catalogueController.attach();
    return () => catalogueController.detach();
  }, [catalogueController]);
  useEffect(() => {
    if (["unavailable", "denied"].includes(state.phase)) catalogueController.invalidate();
    else if (active && online && canRead) void catalogueController.loadPage();
  }, [catalogueController, active, online, canRead, state.phase === "unavailable", state.phase === "denied"]);
  useEffect(() => {
    const fresh = () => {
      if (document.visibilityState === "hidden") catalogueController.invalidate();
      else void catalogueController.refresh();
    };
    window.addEventListener("focus", fresh);
    document.addEventListener("visibilitychange", fresh);
    return () => {
      window.removeEventListener("focus", fresh);
      document.removeEventListener("visibilitychange", fresh);
    };
  }, [catalogueController]);
  useEffect(() => {
    if (active && online && canRead && !controller.isProtected()) void controller.loadPage();
  }, [controller, active, online, canRead]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!controller.isProtected()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [controller]);
  const actions: WorkflowActions = {
    refresh: () => {
      if (live.current.online) void controller.loadPage();
    },
    next: (cursor) => {
      if (live.current.online) void controller.loadPage(cursor);
    },
    select: (id) => {
      if (live.current.online) void controller.select(id);
    },
    begin: () => {
      if (live.current.online) controller.beginDraft();
    },
    copy: () => {
      if (live.current.online) controller.copySelected();
    },
    add: (kind, target) => {
      if (live.current.online) controller.add(kind, target);
    },
    condition: (key, field, value) => {
      if (live.current.online) controller.editCondition(key, field, value);
    },
    moreTags: () => {
      if (live.current.online) void conditionController.loadMoreTags();
    },
    refreshDesigns: () => {
      if (live.current.online) void catalogueController.refresh();
    },
    nextDesigns: (cursor) => {
      if (live.current.online) void catalogueController.loadPage(cursor);
    },
    chooseDesign: (key, id, channel) => {
      if (live.current.online && !controller.getSnapshot().pending)
        void catalogueController.choose(key, id, channel);
    },
    move: (key, direction) => {
      if (live.current.online) controller.move(key, direction);
    },
    remove: (key) => {
      if (live.current.online && window.confirm("Remove this step from the unsaved workflow draft?"))
        controller.remove(key);
    },
    editNode: (key, value) => {
      if (live.current.online) controller.editNode(key, value);
    },
    timezone: (value) => {
      if (live.current.online) controller.editTimezone(value);
    },
    quiet: (value) => {
      if (live.current.online) controller.editQuietHours(value);
    },
    save: () => {
      if (!controller.getSnapshot().pending && catalogueController.getSnapshot().reading) return;
      if (live.current.online) void controller.save();
    },
    discard: () => {
      if (!controller.isProtected() || window.confirm("Discard this unsaved local workflow draft?"))
        controller.discard();
    },
    editRejected: () => {
      if (live.current.online) controller.editRejected();
    },
    start: (value) => {
      if (live.current.online) controller.setPreviewStart(value);
    },
    choice: (key, value) => {
      if (live.current.online) controller.setChoice(key, value);
    },
    preview: () => {
      if (live.current.online) controller.preview();
    },
  };
  return (
    <CampaignWorkflowView
      state={state}
      catalogue={catalogue}
      active={active}
      online={online}
      actions={actions}
      conditions={conditions}
      memberId={props.memberId}
    />
  );
}
