import type { Schema } from "../lib/api";
import type { ContactEditSnapshot } from "./contact-edit";
import styles from "./contact-edit-panel.module.css";

export type ContactEditDraft = Readonly<{ displayName: string; email: string; phone: string }>;
export type ContactEditViewProps = {
  contact: Schema<"Contact"> | null;
  draft: ContactEditDraft | null;
  snapshot: ContactEditSnapshot;
  online: boolean;
  visible: boolean;
  busy: boolean;
  reading: boolean;
  canEdit: boolean;
  canRead: boolean;
  canRetry: boolean;
  currentReviewed?: boolean;
  onDraftChange(value: ContactEditDraft): void;
  onReconcile(): void;
  onReview(): void;
};

/** Private values stay out of hidden/offline markup; the parent retains the tab-only draft. */
export function ContactEditView(props: ContactEditViewProps) {
  const pending = Boolean(props.snapshot.command);
  if (!props.online || !props.visible)
    return (
      <div className="empty" role="status">
        {pending
          ? "A contact save is unconfirmed. Its original command remains in this tab; reconnect and return to this view to review it."
          : "Contact details and unsaved edits are hidden while offline or this page is not visible."}
      </div>
    );
  if (!props.canRead || props.snapshot.phase === "denied")
    return (
      <div className="empty" role="alert">
        Contact access is unavailable. Contact details and edits are hidden. Refresh workspace access before
        reopening the contact.
      </div>
    );
  const disabled = props.busy || props.reading || pending || !props.canEdit;
  const phase = props.snapshot.phase;
  return (
    <section className={styles.root} aria-label="Contact edit recovery">
      {pending && (
        <div className={`error ${styles.notice}`} role="status" aria-live="polite">
          <strong>
            {phase === "sending" ? "Saving the original contact command…" : "Contact save unconfirmed"}
          </strong>
          <p>
            {props.canRetry
              ? "The save may have completed. Reconcile its retained original input before editing, leaving this view, switching organizations or signing out."
              : "The conservative retry window is unavailable or has expired. The save remains unconfirmed. Review the current contact; no new save or automatic retry will be started."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-secondary"
              disabled={
                props.busy || props.reading || phase !== "unknown" || !props.canRetry || !props.canEdit
              }
              onClick={props.onReconcile}
            >
              Reconcile contact save
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={props.busy || props.reading || !props.canRead}
              onClick={props.onReview}
            >
              Review current contact
            </button>
          </div>
          <p className="muted">
            Reading current details cannot prove whether the earlier save completed. Reconciliation keeps the
            original input and record version.
          </p>
        </div>
      )}
      {phase === "acknowledged" && (
        <p role="status">
          Contact save acknowledged.{" "}
          {props.reading
            ? "Reading current details…"
            : props.contact
              ? "Current details have been read separately."
              : "Current details are unavailable; read them before editing again."}
        </p>
      )}
      {phase === "conflict" && (
        <p role="alert">
          The first save was rejected because this contact changed. Your unsaved edits remain in this tab.
          Review current details before starting another save.
        </p>
      )}
      {phase === "rejected" && (
        <p role="alert">The first save was rejected. Review the contact and its input before trying again.</p>
      )}
      {pending && props.currentReviewed && !props.reading && props.contact && (
        <div className={`detail-summary ${styles.review}`} aria-label="Current contact read-only review">
          <div>
            <strong>Current contact (read-only)</strong>
            <p>{props.contact.displayName}</p>
            <p>{props.contact.emails.length ? props.contact.emails.join(", ") : "No active email channel"}</p>
            <p>{props.contact.phones.length ? props.contact.phones.join(", ") : "No active phone channel"}</p>
            <p>Current record version {props.contact.version}. The original save remains unconfirmed.</p>
          </div>
        </div>
      )}
      {props.reading ? (
        <p role="status">Reading current contact details…</p>
      ) : props.contact && props.draft ? (
        <fieldset disabled={disabled} className={styles.fields}>
          <legend>{pending ? "Retained contact edits" : "Contact details"}</legend>
          <label>
            Full name
            <input
              name="displayName"
              value={props.draft.displayName}
              onChange={(event) =>
                props.onDraftChange({ ...props.draft!, displayName: event.currentTarget.value })
              }
              required
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              value={props.draft.email}
              onChange={(event) => props.onDraftChange({ ...props.draft!, email: event.currentTarget.value })}
              maxLength={254}
            />
          </label>
          <label>
            Phone (optional)
            <input
              name="phone"
              type="tel"
              value={props.draft.phone}
              onChange={(event) => props.onDraftChange({ ...props.draft!, phone: event.currentTarget.value })}
              maxLength={32}
            />
          </label>
          <p className="muted">
            Additional channels are preserved. Communication consent is not changed by editing contact
            details.
          </p>
        </fieldset>
      ) : !pending ? (
        <div className="empty">
          Current contact details are unavailable.
          <button
            type="button"
            className="button button-secondary"
            disabled={props.busy || props.reading || !props.canRead}
            onClick={props.onReview}
          >
            Read current contact
          </button>
        </div>
      ) : null}
      {phase === "conflict" && !pending && (
        <button
          type="button"
          className="button button-secondary"
          disabled={props.busy || props.reading || !props.canRead}
          onClick={props.onReview}
        >
          Review current contact
        </button>
      )}
    </section>
  );
}

export default ContactEditView;
