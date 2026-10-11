import type { Schema } from "../lib/api";
import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import type { TaskEditSnapshot } from "./task-edit";
import styles from "./task-edit-panel.module.css";

export type TaskEditDraft = Readonly<{
  title: string;
  dueLocal: string;
  description: string;
  priority: Schema<"Task">["priority"];
  state: Schema<"Task">["state"];
}>;
export type TaskEditViewProps = {
  snapshot: TaskEditSnapshot;
  task: Schema<"Task"> | null;
  draft: TaskEditDraft | null;
  online: boolean;
  visible: boolean;
  busy: boolean;
  reading: boolean;
  canEdit: boolean;
  canRead: boolean;
  canRetry: boolean;
  deviceTimezone?: string | null;
  onDraftChange(value: TaskEditDraft): void;
  onSave?(): void;
  onReconcile(): void;
  onReview(): void;
  onForget?(): void;
};

/** Historical receipts and recovery state never render private command values. */
export function TaskEditView(props: TaskEditViewProps) {
  const phase = props.snapshot.phase,
    pending = Boolean(props.snapshot.command);
  if (phase === "forgotten") return <p role="status">{localRecoveryForgottenWarning}</p>;
  const forgetting =
    phase === "unknown" && !props.canRetry && props.onForget ? (
      <div className={styles.notice}>
        <p>{localRecoveryForgettingExplanation}</p>
        <button
          type="button"
          className="button button-secondary"
          disabled={props.busy || props.reading || !props.visible || !props.canEdit}
          onClick={props.onForget}
        >
          Clear this tab’s recovery data
        </button>
      </div>
    ) : null;
  if (!props.online || !props.visible)
    return (
      <section className={styles.root} aria-label="Task update recovery" role="status">
        <p>
          {pending
            ? "A task update is unconfirmed. Its original command remains in this tab; return online to reconcile it."
            : "Task details and unsaved edits are hidden while offline or this page is not visible."}
        </p>
        {forgetting}
      </section>
    );
  if (phase === "denied")
    return (
      <p role="alert">
        Task access is unavailable. Private task details and edits have been cleared. Refresh workspace access
        before continuing.
      </p>
    );
  const disabled = props.busy || props.reading || pending || !props.canEdit;
  const fields =
    !pending && props.canRead && !props.reading && props.task && props.draft ? props.draft : null;
  return (
    <section className={styles.root} aria-label="Task update recovery">
      {pending && (
        <div className={styles.notice} role="status" aria-live="polite">
          <strong>
            {phase === "sending" ? "Saving the original task update…" : "Task update unconfirmed"}
          </strong>
          <p>
            {props.canRetry
              ? "The update may have completed. Reconcile its original command before editing, leaving this view, switching organizations or signing out."
              : "The conservative retry window is unavailable or has expired. The task update remains unconfirmed. No new update or automatic retry will be started."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-secondary"
              disabled={
                (disabled && (props.busy || props.reading || !props.canEdit)) ||
                phase !== "unknown" ||
                !props.canRetry
              }
              onClick={props.onReconcile}
            >
              Reconcile task update
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy || props.reading || !props.canRead}
              onClick={props.onReview}
            >
              Review current task
            </button>
          </div>
          <p>Reading the current task cannot prove whether the earlier update completed.</p>
          {forgetting}
        </div>
      )}
      {phase === "acknowledged" && (
        <p role="status">
          Task update acknowledged.{" "}
          {props.reading
            ? "Reading current details…"
            : props.task && props.canRead
              ? "Current task details were read separately."
              : "Current task details are unavailable; assignment or source access may have changed."}
        </p>
      )}
      {phase === "conflict" && (
        <p role="alert">
          This task changed. Read the current task and review your draft before a new update.
        </p>
      )}
      {phase === "rejected" && (
        <p role="alert">
          The task update was rejected. Your draft remains in this tab. Review it before trying again.
        </p>
      )}
      {!pending && !props.canRead && (
        <p role="status">
          Current task details are unavailable. Task read access is required to display this editor.
        </p>
      )}
      {props.reading && <p role="status">Reading current task details…</p>}
      {fields && (
        <div className={styles.fields}>
          <label>
            Title
            <input
              name="title"
              value={fields.title}
              required
              disabled={disabled}
              onChange={(e) => props.onDraftChange({ ...fields, title: e.target.value })}
            />
          </label>
          <label>
            Due date and time
            <input
              name="dueAt"
              type="datetime-local"
              value={fields.dueLocal}
              required
              disabled={disabled}
              onChange={(e) => props.onDraftChange({ ...fields, dueLocal: e.target.value })}
            />
            <span className="field-help">
              Unchanged time preserves the stored instant and timezone. Changed wall times use your device
              timezone: {props.deviceTimezone || "Unavailable"}. Ambiguous or skipped times follow your
              device’s daylight-saving resolution.
            </span>
          </label>
          <label>
            Description
            <textarea
              name="description"
              value={fields.description}
              disabled={disabled}
              onChange={(e) => props.onDraftChange({ ...fields, description: e.target.value })}
            />
          </label>
          <label>
            Priority
            <select
              name="priority"
              value={fields.priority}
              disabled={disabled}
              onChange={(e) =>
                props.onDraftChange({ ...fields, priority: e.target.value as TaskEditDraft["priority"] })
              }
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
          <label>
            Status
            <select
              name="state"
              value={fields.state}
              disabled={disabled}
              onChange={(e) =>
                props.onDraftChange({ ...fields, state: e.target.value as TaskEditDraft["state"] })
              }
            >
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          {props.onSave && (
            <button
              type="button"
              className="button button-primary"
              disabled={disabled}
              onClick={props.onSave}
            >
              Save task changes
            </button>
          )}
        </div>
      )}
      {!pending && props.canRead && !props.reading && !props.task && (
        <button
          type="button"
          className="button button-secondary"
          disabled={props.busy}
          onClick={props.onReview}
        >
          Read current task
        </button>
      )}
    </section>
  );
}
export default TaskEditView;
