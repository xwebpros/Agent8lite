"use client";

import type { FormEvent } from "react";
import type { Schema } from "../lib/api";
import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import type { TaskCreateSnapshot } from "./task-create";
import styles from "./task-create-panel.module.css";

export type TaskCreateDraft = Readonly<{
  title: string;
  description: string;
  dueAt: string;
  leadId: string;
  priority: Schema<"Task">["priority"];
}>;
export const emptyTaskCreateDraft: TaskCreateDraft = Object.freeze({
  title: "",
  description: "",
  dueAt: "",
  leadId: "",
  priority: "normal",
});
export type TaskCreateViewProps = {
  draft: TaskCreateDraft | null;
  snapshot: TaskCreateSnapshot;
  leads: readonly Schema<"Lead">[];
  leadLabel(lead: Schema<"Lead">): string;
  online: boolean;
  visible: boolean;
  busy: boolean;
  canCreate: boolean;
  canRetry: boolean;
  deviceTimezone: string | null;
  error?: string;
  onDraftChange(value: TaskCreateDraft): void;
  onSave(): void;
  onReconcile(): void;
  onForget?(): void;
  onClose(): void;
};
export function TaskCreateView(props: TaskCreateViewProps) {
  const { command, phase } = props.snapshot;
  const sending = phase === "sending",
    unknown = phase === "unknown";
  const privateAvailable = props.online && props.visible && props.canCreate && phase !== "denied";
  const forgetting =
    unknown && !props.canRetry && props.onForget ? (
      <div className={styles.status}>
        <p>{localRecoveryForgettingExplanation}</p>
        <button
          type="button"
          className={styles.secondary}
          disabled={props.busy || !props.visible || !props.canCreate}
          onClick={() => props.onForget?.()}
        >
          Clear this tab’s recovery data
        </button>
      </div>
    ) : null;
  if (phase === "forgotten")
    return (
      <section className={styles.root} aria-label="Cleared task recovery data">
        <p role="status">{localRecoveryForgottenWarning}</p>
        <button type="button" className={styles.secondary} onClick={props.onClose} disabled={props.busy}>
          Close editor
        </button>
      </section>
    );
  if (!privateAvailable)
    return (
      <section className={styles.root} aria-label="Task creation unavailable">
        <p role="status">
          {!props.canCreate || phase === "denied"
            ? "Task creation is unavailable with current access. Private captured fields are cleared; no interrupted outcome is inferred. Refresh workspace access before continuing."
            : command
              ? "An unconfirmed task creation remains in this tab. Private fields are hidden while offline or this view is inactive."
              : "Task draft fields are hidden while offline or this view is inactive. No request is sent offline."}
        </p>
        {command && (
          <button type="button" className={styles.secondary} disabled>
            Reconcile task creation
          </button>
        )}
        {forgetting}
        {!command && (
          <button type="button" className={styles.secondary} onClick={props.onClose} disabled={props.busy}>
            Close editor
          </button>
        )}
      </section>
    );
  if (command)
    return (
      <section className={styles.root} aria-label="Task creation recovery">
        <p role="status">
          {sending
            ? "Confirming task creation…"
            : "Task creation is unconfirmed. It may have completed; reconcile only the original input before another command, leaving this view or signing out."}
        </p>
        {props.error && (
          <p className={styles.error} role="alert">
            {props.error}
          </p>
        )}
        <button
          type="button"
          className={styles.secondary}
          onClick={props.onReconcile}
          disabled={props.busy || !unknown || !props.canRetry}
        >
          Reconcile task creation
        </button>
        {forgetting}
        <p className={styles.hint}>
          Acknowledgement confirms the original save. Current tasks are read separately; no reminder or
          calendar synchronization is configured.
        </p>
      </section>
    );
  const draft = props.draft ?? emptyTaskCreateDraft;
  const disabled = props.busy || !props.deviceTimezone;
  const update = (key: keyof TaskCreateDraft, value: string) => {
    if (!disabled) props.onDraftChange({ ...draft, [key]: value } as TaskCreateDraft);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!disabled) props.onSave();
  };
  return (
    <form className={styles.root} onSubmit={submit}>
      {props.error && (
        <p className={styles.error} role="alert">
          {props.error}
        </p>
      )}
      <p role="status">
        {phase === "rejected"
          ? "The first task attempt was rejected. Review the form before making a new attempt."
          : phase === "acknowledged"
            ? "Task creation is acknowledged. Current records are read separately."
            : "This task will be assigned to you. Calendar synchronization and reminders are not configured."}
      </p>
      <fieldset disabled={disabled} className={styles.fields}>
        <label>
          Title
          <input
            name="title"
            required
            value={draft.title}
            onChange={(event) => update("title", event.target.value)}
            placeholder="e.g. Check in about the home search"
          />
        </label>
        <label>
          Description (optional)
          <textarea
            name="description"
            value={draft.description}
            onChange={(event) => update("description", event.target.value)}
            rows={3}
          />
        </label>
        <label>
          Due date and time
          <input
            name="dueAt"
            type="datetime-local"
            required
            value={draft.dueAt}
            onChange={(event) => update("dueAt", event.target.value)}
            aria-describedby="task-create-time-help"
          />
        </label>
        <p id="task-create-time-help" className={styles.hint}>
          {props.deviceTimezone
            ? `Enter your device’s local time: ${props.deviceTimezone}. It is captured once as a UTC instant. Ambiguous or skipped wall times follow your device’s daylight-saving resolution.`
            : "Your device time zone is unavailable. Task creation is disabled."}
        </p>
        <label>
          Lead (optional)
          <select
            name="leadId"
            value={draft.leadId}
            onChange={(event) => update("leadId", event.target.value)}
          >
            <option value="">General follow-up</option>
            {draft.leadId &&
              !props.leads.some((lead) => lead.id.toLowerCase() === draft.leadId.toLowerCase()) && (
                <option value={draft.leadId}>Selected lead unavailable in loaded records</option>
              )}
            {props.leads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {props.leadLabel(lead)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            name="priority"
            value={draft.priority}
            onChange={(event) => update("priority", event.target.value)}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
      </fieldset>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} onClick={props.onClose} disabled={props.busy}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={disabled}>
          Save task
        </button>
      </div>
    </form>
  );
}
export default TaskCreateView;
