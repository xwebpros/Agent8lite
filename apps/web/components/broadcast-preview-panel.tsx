"use client";

import { Megaphone, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import { BroadcastPreviewController, type BroadcastPreviewState } from "./broadcast-preview-controller";
import { readBroadcastResponse, type LeadFilter } from "./broadcast-preview-protocol";
import {
  WorkflowConditionCatalogue,
  type ConditionChoice,
  type WorkflowConditionCatalogueState,
} from "./campaign-workflow-condition-catalogue";
import {
  CampaignWorkflowDesignCatalogue,
  workflowDesignChoices,
  type WorkflowDesignCatalogueState,
} from "./campaign-workflow-design-catalogue";
import { requestWorkflowJson } from "./campaign-workflow-request";
import { workflowContextBinding } from "./campaign-workflow-protocol";
import { requestMessageDesign } from "./message-design-request";
import styles from "./campaign-workflow-workspace.module.css";

export type BroadcastPreviewActions = {
  design(id: string): void;
  filter(field: keyof LeadFilter, value: string | readonly string[] | null): void;
  timezone(value: string): void;
  scheduledAt(value: string | null): void;
  preview(): void;
  discardUnknown(): void;
  refreshChoices(): void;
  nextDesigns?(cursor: string): void;
  moreTags(): void;
};

const unknownReference = "Saved reference (not in the current list)";
const fieldLabels: Readonly<Record<string, string>> = {
  messageDesignId: "Message design",
  filter: "Segment",
  "filter.q": "Lead name contains",
  "filter.tagIds": "Tags",
  "filter.stageId": "Pipeline stage",
  "filter.sourceId": "Lead source",
  "filter.ownerMemberId": "Assigned to me",
  "filter.intent": "Lead intent",
  timezone: "Timezone",
  scheduledAt: "Scheduled time",
};
const issueLabel = (field: string) => fieldLabels[field.replace(/\.\d+$/, "")] ?? "Segment";

/** Static presentation; it renders no command key and offers no send or confirm control. */
export function BroadcastPreviewView({
  state,
  designs,
  conditions,
  memberId,
  actions,
}: {
  state: BroadcastPreviewState;
  designs: WorkflowDesignCatalogueState;
  conditions: WorkflowConditionCatalogueState;
  memberId?: string;
  actions: BroadcastPreviewActions;
}) {
  const prefix = useId();
  const choices = useMemo(
    () => [
      ...workflowDesignChoices(state.online ? designs.page : null, "email"),
      ...workflowDesignChoices(state.online ? designs.page : null, "sms"),
    ],
    [designs.page, state.online],
  );
  if (!state.canPreview)
    return (
      <Empty icon={<Megaphone size={30} />} title="Broadcast preview unavailable">
        Organization-wide broadcast permission is required to preview an audience.
      </Empty>
    );
  if (state.phase === "denied" || state.phase === "unavailable")
    return (
      <Empty icon={<Megaphone size={30} />} title="Broadcast preview unavailable">
        {state.error}
      </Empty>
    );
  const filter = state.draft.filter;
  const locked = !state.online || Boolean(state.pending) || state.phase === "sending";
  const issuesId = state.issues.length ? `${prefix}-issues` : undefined;
  const invalid = (field: string) => state.issues.some((issue) => issue.field.startsWith(field)) || undefined;
  const select = (field: "stageId" | "sourceId", label: string, list: readonly ConditionChoice[] | null) => {
    const value = filter[field] ?? "";
    const known = !value || Boolean(list?.some((choice) => choice.id === value));
    return (
      <div>
        <label htmlFor={`${prefix}-${field}`}>{label}</label>
        <select
          id={`${prefix}-${field}`}
          value={value}
          disabled={locked || (!list && !value)}
          aria-invalid={invalid(`filter.${field}`)}
          aria-describedby={issuesId}
          onChange={(event) => actions.filter(field, event.target.value || null)}
        >
          <option value="">Any</option>
          {!known && <option value={value}>{unknownReference}</option>}
          {(list ?? []).map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
    );
  };
  const tags = filter.tagIds ?? [];
  const savedTags = tags.filter((id) => !conditions.tags?.some((choice) => choice.id === id));
  const toggleTag = (id: string, checked: boolean) =>
    actions.filter("tagIds", checked ? [...tags, id] : tags.filter((tag) => tag !== id));
  return (
    <section className={styles.workspace} aria-label="Broadcast audience preview">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Broadcast audience</p>
          <h2>Preview a segment</h2>
          <p>Count who a broadcast could reach right now. Nothing is sent or scheduled.</p>
        </div>
        <Badge tone="warning">Synthetic · preview only</Badge>
      </header>
      {!state.online && (
        <p className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" /> Offline. Previews are hidden until you reconnect.
        </p>
      )}
      <div className={styles.card}>
        <fieldset disabled={locked} className={styles.policy}>
          <legend>Message</legend>
          <label htmlFor={`${prefix}-design`}>Message design</label>
          <select
            id={`${prefix}-design`}
            value={state.draft.messageDesignId ?? ""}
            aria-invalid={invalid("messageDesignId")}
            aria-describedby={issuesId}
            onChange={(event) => actions.design(event.target.value)}
          >
            <option value="">Choose a current native design</option>
            {state.draft.messageDesignId &&
              !choices.some((choice) => choice.id === state.draft.messageDesignId) && (
                <option value={state.draft.messageDesignId}>Chosen design (not on this page)</option>
              )}
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name} · {choice.channel === "email" ? "Email" : "SMS"}
              </option>
            ))}
          </select>
          <p className={styles.help}>The design's channel decides which consent and addresses are counted.</p>
          {designs.reading && <p role="status">Reading current design choices…</p>}
          {designs.error && (
            <p role="alert" className={styles.error}>
              {designs.error}
            </p>
          )}
          <Button type="button" variant="secondary" onClick={actions.refreshChoices}>
            <RefreshCw size={16} aria-hidden="true" /> Refresh choices
          </Button>
          {state.online && designs.page?.hasMore && designs.page.nextCursor && (
            <Button
              type="button"
              variant="secondary"
              disabled={designs.reading}
              onClick={() => actions.nextDesigns?.(designs.page!.nextCursor!)}
            >
              Read next design page
            </Button>
          )}
        </fieldset>
        <fieldset disabled={locked} className={styles.policy}>
          <legend>Segment (leads must match every chosen field)</legend>
          <div>
            <label htmlFor={`${prefix}-intent`}>Lead intent</label>
            <select
              id={`${prefix}-intent`}
              value={filter.intent ?? ""}
              aria-invalid={invalid("filter.intent")}
              aria-describedby={issuesId}
              onChange={(event) => actions.filter("intent", event.target.value || null)}
            >
              <option value="">Any</option>
              <option value="buyer">Buyer</option>
              <option value="seller">Seller</option>
              <option value="both">Buyer and seller</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          {select("stageId", "Pipeline stage", conditions.stages)}
          {select("sourceId", "Lead source", conditions.sources)}
          <fieldset className={styles.policy}>
            <legend>Tags (all chosen tags must be present)</legend>
            {savedTags.map((id) => (
              <label key={id} className={styles.checkbox}>
                <input type="checkbox" checked onChange={() => toggleTag(id, false)} /> {unknownReference}
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
                onClick={actions.moreTags}
              >
                Read more tag choices
              </Button>
            )}
            {!conditions.tags && !savedTags.length && (
              <p className={styles.help}>Tag choices are not verified.</p>
            )}
          </fieldset>
          {memberId && (
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={filter.ownerMemberId === memberId}
                onChange={(event) => actions.filter("ownerMemberId", event.target.checked ? memberId : null)}
              />{" "}
              Only leads assigned to me
            </label>
          )}
          <div>
            <label htmlFor={`${prefix}-q`}>Lead name contains</label>
            <input
              id={`${prefix}-q`}
              value={filter.q ?? ""}
              maxLength={400}
              autoComplete="off"
              aria-invalid={invalid("filter.q")}
              aria-describedby={issuesId}
              onChange={(event) => actions.filter("q", event.target.value || null)}
            />
          </div>
          {conditions.error && (
            <p role="alert" className={styles.error}>
              {conditions.error}
            </p>
          )}
        </fieldset>
        <fieldset disabled={locked} className={styles.policy}>
          <legend>Timing metadata</legend>
          <label htmlFor={`${prefix}-timezone`}>Timezone</label>
          <input
            id={`${prefix}-timezone`}
            value={state.draft.timezone}
            maxLength={80}
            autoComplete="off"
            aria-invalid={invalid("timezone")}
            aria-describedby={issuesId}
            onChange={(event) => actions.timezone(event.target.value)}
          />
          <p className={styles.help}>Use UTC or an IANA zone, for example America/Los_Angeles.</p>
          <label htmlFor={`${prefix}-scheduled`}>Intended send time (optional, UTC ISO)</label>
          <input
            id={`${prefix}-scheduled`}
            value={state.draft.scheduledAt ?? ""}
            maxLength={40}
            autoComplete="off"
            aria-invalid={invalid("scheduledAt")}
            aria-describedby={issuesId}
            onChange={(event) => actions.scheduledAt(event.target.value || null)}
          />
          <p className={styles.help}>Recorded with the preview only. Nothing is scheduled.</p>
        </fieldset>
        {state.issues.length > 0 && (
          <div id={issuesId} className={styles.error} role="alert">
            <h4>Review the segment</h4>
            <ul>
              {state.issues.map((issue, index) => (
                <li key={`${issue.field}-${index}`}>
                  <strong>{issueLabel(issue.field)}</strong>: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {state.error && state.issues.length === 0 && (
          <p role="alert" className={styles.error}>
            {state.error}
          </p>
        )}
        <div className={styles.actions}>
          <Button disabled={!state.online || state.phase === "sending"} onClick={actions.preview}>
            {state.phase === "sending"
              ? "Counting audience…"
              : state.pending
                ? "Retry this preview"
                : "Preview audience"}
          </Button>
          {state.phase === "unknown" && (
            <Button variant="quiet" onClick={actions.discardUnknown}>
              Edit the segment instead
            </Button>
          )}
        </div>
        {state.online && state.visible && state.result && (
          <section className={styles.receipt} aria-label="Broadcast audience estimate" aria-live="polite">
            <h3>Audience estimate</h3>
            <dl className={styles.references}>
              <dt>Eligible leads</dt>
              <dd>{state.result.eligible}</dd>
              <dt>Ineligible leads</dt>
              <dd>{state.result.ineligible}</dd>
              <dt>Estimated recipients</dt>
              <dd>{state.result.estimatedRecipients}</dd>
              <dt>Valid until</dt>
              <dd>
                <time dateTime={state.result.expiresAt}>{state.result.expiresAt}</time>
              </dd>
            </dl>
            <p className={styles.notice}>
              This is a point-in-time estimate. Consent, suppression and archive status are checked again
              before any future send. No message was sent or scheduled.
            </p>
          </section>
        )}
      </div>
    </section>
  );
}

export type BroadcastPreviewPanelProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  accessRevision: number;
  memberId?: string;
  onAccessRevoked?(): void;
};

export default function BroadcastPreviewPanel(props: BroadcastPreviewPanelProps) {
  const { session, csrf, online, accessRevision } = props;
  const canPreview =
    session.permissions.includes("campaigns.send") && session.permissions.includes("campaigns.read");
  const binding = workflowContextBinding([
    session.userId,
    session.activeOrgId,
    accessRevision,
    csrf,
    canPreview,
  ]);
  const live = useRef({ binding, online, props });
  live.current = { binding, online, props };
  const base = `/api/v1/orgs/${session.activeOrgId}`;
  const controller = useMemo(
    () =>
      new BroadcastPreviewController({
        binding,
        online: live.current.online,
        canPreview,
        createKey: () => crypto.randomUUID(),
        onAccessRevoked: () => {
          if (live.current.binding === binding) live.current.props.onAccessRevoked?.();
        },
        client: {
          async preview(command) {
            if (command.binding !== binding || live.current.binding !== binding || !live.current.online)
              throw new Error("The original broadcast context is unavailable.");
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), 20000);
            try {
              const response = await fetch(`${base}/broadcast-previews`, {
                method: "POST",
                credentials: "same-origin",
                cache: "no-store",
                redirect: "error",
                signal: abort.signal,
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": csrf,
                  "Idempotency-Key": command.idempotencyKey,
                },
                body: JSON.stringify(command.body),
              });
              const value = await readBroadcastResponse(response);
              if (response.status !== 201)
                throw new Error("The frozen preview status could not be verified.");
              return value;
            } finally {
              clearTimeout(timer);
            }
          },
        },
      }),
    [binding, base, csrf, canPreview],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = () => live.current.binding === binding && live.current.online;
  const designs = useMemo(() => {
    const read = (path: string) => {
      if (!current()) throw new Error("The current design context is unavailable.");
      return requestMessageDesign(path, 200);
    };
    return new CampaignWorkflowDesignCatalogue({
      online: live.current.online,
      client: {
        async list(cursor) {
          return (
            await read(
              `${base}/message-designs?${new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) })}`,
            )
          ).data;
        },
        detail: (id) => read(`${base}/message-designs/${id}`),
      },
      isCurrent: current,
      applySelection: () => false,
      onAuthorityLost: () => controller.revoke(),
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: binding identifies the context.
  }, [binding, base, controller]);
  const designState = useSyncExternalStore(designs.subscribe, designs.getSnapshot, designs.getSnapshot);
  const conditions = useMemo(() => {
    const read = async (path: string) => {
      if (!current()) throw new Error("The current condition context is unavailable.");
      return (await requestWorkflowJson(path, 200)).data;
    };
    return new WorkflowConditionCatalogue({
      online: live.current.online,
      permitted: {
        stages: session.permissions.includes("crm.pipeline.read"),
        sources: session.permissions.includes("crm.sources.read"),
        tags: session.permissions.includes("crm.tags.read"),
      },
      client: {
        stages: () => read(`${base}/pipeline-stages?limit=100`),
        sources: () => read(`${base}/lead-sources?limit=100`),
        tags: (cursor) =>
          read(`${base}/tags?${new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) })}`),
      },
      isCurrent: current,
      onAuthorityLost: () => {
        controller.revoke();
        live.current.props.onAccessRevoked?.();
      },
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: binding identifies the context.
  }, [binding, base, controller]);
  const conditionState = useSyncExternalStore(
    conditions.subscribe,
    conditions.getSnapshot,
    conditions.getSnapshot,
  );
  useEffect(() => {
    designs.attach();
    conditions.attach();
    return () => {
      designs.detach();
      conditions.detach();
    };
  }, [designs, conditions]);
  useEffect(() => {
    controller.setOnline(online);
    designs.setOnline(online);
    conditions.setOnline(online);
    if (online && canPreview) {
      void designs.loadPage();
      void conditions.load();
    }
  }, [controller, designs, conditions, online, canPreview]);
  useEffect(() => {
    const visibility = () => controller.setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", visibility);
    const timer = setInterval(() => controller.expire(), 15000);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      clearInterval(timer);
    };
  }, [controller]);
  const actions: BroadcastPreviewActions = {
    design: (id) => controller.chooseDesign(id),
    filter: (field, value) => controller.editFilter(field, value),
    timezone: (value) => controller.setTimezone(value),
    scheduledAt: (value) => controller.setScheduledAt(value),
    preview: () => {
      if (live.current.online) void controller.preview();
    },
    discardUnknown: () => controller.discardUnknown(),
    nextDesigns: (cursor) => {
      if (live.current.online) void designs.loadPage(cursor);
    },
    refreshChoices: () => {
      if (!live.current.online) return;
      void designs.refresh();
      conditions.invalidate();
      void conditions.load();
    },
    moreTags: () => {
      if (live.current.online) void conditions.loadMoreTags();
    },
  };
  return (
    <BroadcastPreviewView
      state={state}
      designs={designState}
      conditions={conditionState}
      memberId={props.memberId}
      actions={actions}
    />
  );
}
