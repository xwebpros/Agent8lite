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
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { previewWorkflow, validateWorkflowDefinition } from "../../../packages/marketing";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  CampaignWorkflowController,
  type CampaignWorkflowClient,
  type CampaignWorkflowState,
} from "./campaign-workflow-controller";
import {
  workflowContextBinding,
  workflowDefinitionJson,
  workflowLinearOrder,
  type WorkflowDefinition,
} from "./campaign-workflow-protocol";
import { requestWorkflowJson } from "./campaign-workflow-request";
import styles from "./campaign-workflow-workspace.module.css";

export type CampaignWorkflowWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  campaignId: string;
  onProtectedChange(value: boolean): void;
  onAccessRevoked?(): void;
};
type WorkflowActions = {
  refresh(): void;
  next(cursor: string): void;
  select(id: string): void;
  begin(): void;
  copy(): void;
  add(kind: "wait" | "task"): void;
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

/** Static presentation is testable without a browser; it exposes no command key or session context. */
export function CampaignWorkflowView({
  state,
  active,
  online,
  actions,
}: {
  state: CampaignWorkflowState;
  active: boolean;
  online: boolean;
  actions: WorkflowActions;
}) {
  const prefix = useId(),
    timezoneInput = useRef<HTMLInputElement>(null);
  const hasDraft = Boolean(state.draft);
  useEffect(() => {
    if (hasDraft) timezoneInput.current?.focus();
  }, [hasDraft]);
  const protectedDraft = state.dirty || Boolean(state.pending) || state.phase === "sending";
  const locked = !online || state.reading || Boolean(state.pending) || state.phase === "sending";
  const definition = state.draft ?? (online ? state.selected?.data.definition : null);
  const linearOrder = definition ? workflowLinearOrder(definition) : null;
  const rows = definition
    ? linearOrder
      ? linearOrder.map((key) => definition.nodes.find((node) => node.key === key)!)
      : definition.nodes
    : [];
  const canEdit = hasDraft && state.canWrite && !locked;
  const definitionError = state.issues.length ? `${prefix}-issues` : undefined;
  const nodeInvalid = (key: string, field: string) => {
    const index = definition?.nodes.findIndex((node) => node.key === key);
    return (
      state.issues.some(
        (issue) => issue.field === `nodes.${index}.${field}` || issue.field === `nodes.${index}`,
      ) || undefined
    );
  };
  const issueLabel = (field: string) => {
    const node = /^nodes\.(\d+)(?:\.(\w+))?/.exec(field);
    if (node) {
      const key = definition?.nodes[Number(node[1])]?.key;
      const index = rows.findIndex((item) => item.key === key);
      const label =
        node[2] === "taskTitle" ? "task title" : node[2] === "delaySeconds" ? "wait delay" : "definition";
      return `Step ${index + 1} ${label}`;
    }
    if (field === "timezone") return "Workflow timezone";
    if (field.startsWith("quietHours")) return "Quiet-hour metadata";
    if (field.startsWith("conditionChoices."))
      return `Preview branch for ${field.slice("conditionChoices.".length)}`;
    if (field === "startInstant") return "Virtual start instant";
    return "Workflow definition";
  };
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
                <Button variant="secondary" disabled={locked || !linearOrder} onClick={actions.copy}>
                  <Copy size={17} aria-hidden="true" /> Copy to new workflow draft
                </Button>
              )}
              {!linearOrder && (
                <p className={styles.notice}>
                  This saved graph stays read-only. Condition branches and message references require a future
                  branch editor or authorized design picker. Its nodes and edges are preserved intact.
                </p>
              )}
            </>
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
              <h4>{linearOrder || hasDraft ? "Execution order" : "Stored graph nodes"}</h4>
              {rows.length ? (
                <ol className={styles.steps}>
                  {rows.map((node, index) => (
                    <li key={node.key} className={styles.step}>
                      <div className={styles.heading}>
                        <h4>
                          {index + 1}.{" "}
                          {node.kind === "wait"
                            ? "Wait"
                            : node.kind === "task"
                              ? "Task"
                              : node.kind === "condition"
                                ? "Condition"
                                : node.kind === "email"
                                  ? "Email reference"
                                  : "SMS reference"}
                        </h4>
                        <Badge>{node.key}</Badge>
                      </div>
                      {hasDraft && node.kind === "wait" ? (
                        <div>
                          <label htmlFor={`${prefix}-${node.key}`}>
                            Wait delay in seconds for step {index + 1}
                          </label>
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
                          <label htmlFor={`${prefix}-${node.key}`}>Task title for step {index + 1}</label>
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
                      {node.kind === "condition" && (
                        <>
                          <p>Allowlisted lead-filter predicates:</p>
                          <dl className={styles.references}>
                            {Object.entries(node.condition!).map(([field, value]) => (
                              <div key={field}>
                                <dt>{field}</dt>
                                <dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}
                      {(node.kind === "email" || node.kind === "sms") && (
                        <>
                          <p>Stored design reference: {node.messageDesignId}</p>
                          <p className={styles.notice}>
                            No authorized design picker is available here. Sender, consent, entitlement and
                            provider checks remain required; no message is sent.
                          </p>
                        </>
                      )}
                      {!hasDraft && (
                        <ul className={styles.links}>
                          {definition.edges
                            .filter((edge) => edge.from === node.key)
                            .map((edge) => (
                              <li key={`${edge.to}-${edge.branch}`}>
                                {edge.branch} → {edge.to}
                              </li>
                            ))}
                        </ul>
                      )}
                      {hasDraft && (
                        <div className={styles.actions}>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={!canEdit || index === 0}
                            aria-label={`Move step ${index + 1} up`}
                            onClick={() => actions.move(node.key, -1)}
                          >
                            <ArrowUp size={16} aria-hidden="true" /> Move up
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            disabled={!canEdit || index === rows.length - 1}
                            aria-label={`Move step ${index + 1} down`}
                            onClick={() => actions.move(node.key, 1)}
                          >
                            <ArrowDown size={16} aria-hidden="true" /> Move down
                          </Button>
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={!canEdit}
                            aria-label={`Remove step ${index + 1}`}
                            onClick={() => actions.remove(node.key)}
                          >
                            <Trash2 size={16} aria-hidden="true" /> Remove
                          </Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p>Add at least one wait or task. An empty definition cannot be saved.</p>
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
              </div>
              <p className={styles.help}>
                Condition authoring requires two distinct branches. Email and SMS authoring requires an
                authorized design picker. Those authoring controls are unavailable in this initial editor.
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
  useEffect(() => {
    controller.attach();
    live.current.props.onProtectedChange(controller.isProtected());
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    controller.setOnline(online);
  }, [controller, online]);
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
    add: (kind) => {
      if (live.current.online) controller.add(kind);
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
  return <CampaignWorkflowView state={state} active={active} online={online} actions={actions} />;
}
