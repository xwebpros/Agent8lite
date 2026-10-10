"use client";

import type { FormEvent } from "react";
import type { Schema } from "../lib/api";
import type { LeadCaptureSnapshot } from "./lead-capture";
import styles from "./lead-capture-panel.module.css";

export type LeadCaptureDraft = Readonly<{
  displayName: string;
  email: string;
  phone: string;
  sourceId: string;
  intent: Schema<"LeadCreate">["intent"];
  timeline: string;
}>;
export const emptyLeadCaptureDraft: LeadCaptureDraft = Object.freeze({
  displayName: "",
  email: "",
  phone: "",
  sourceId: "",
  intent: "unknown",
  timeline: "",
});
export type LeadCaptureViewProps = {
  draft: LeadCaptureDraft | null;
  snapshot: LeadCaptureSnapshot;
  sources: readonly Schema<"LeadSource">[];
  online: boolean;
  visible: boolean;
  busy: boolean;
  canCapture: boolean;
  canRetry: boolean;
  error?: string;
  onDraftChange(value: LeadCaptureDraft): void;
  onSave(): void;
  onReconcile(): void;
  onKeepContact(): void;
  onClose(): void;
};
export function LeadCaptureView(props: LeadCaptureViewProps) {
  const { snapshot, draft } = props;
  const contactSaved = Boolean(snapshot.sequence?.contactId);
  const unknown = snapshot.phase === "contact-unknown" || snapshot.phase === "lead-unknown";
  const sending = snapshot.phase === "contact-sending" || snapshot.phase === "lead-sending";
  const partial =
    contactSaved && !snapshot.command && ["lead-ready", "lead-rejected"].includes(snapshot.phase);
  const disabled = props.busy || sending || unknown;
  const status = sending
    ? snapshot.phase === "contact-sending"
      ? "Confirming contact creation…"
      : "Confirming lead creation…"
    : unknown
      ? snapshot.phase === "contact-unknown"
        ? "Contact creation is unconfirmed. No lead has been sent."
        : "Contact creation is acknowledged. Lead creation is unconfirmed."
      : snapshot.phase === "lead-ready"
        ? "Contact creation is acknowledged. Review the lead details before continuing."
        : snapshot.phase === "lead-rejected"
          ? "The contact is saved. The first lead attempt was rejected; review its details or keep the contact without a lead."
          : snapshot.phase === "contact-rejected"
            ? "The first contact attempt was rejected. Review the form before making a new attempt."
            : snapshot.phase === "acknowledged"
              ? "Lead creation is acknowledged. Current lists are read separately."
              : "Create a contact and a separate lead assigned to you. Communication consent remains unknown.";
  if (!props.online || !props.visible)
    return (
      <div className={styles.root} role="status">
        <p>
          {snapshot.sequence
            ? "An unfinished lead capture remains in this tab. Its private fields are hidden."
            : "Lead capture fields are hidden while offline or this view is inactive."}
        </p>
        <p>Reconnect and return to this view to review the current state. No request is sent offline.</p>
        {unknown && <p>Creation is unconfirmed; do not begin a replacement capture.</p>}
        <button type="button" className={styles.secondary} disabled>
          Reconcile original step
        </button>
      </div>
    );
  if (!props.canCapture || snapshot.phase === "denied")
    return (
      <div className={styles.root} role="status">
        <p>Lead capture is unavailable with current access. Private captured fields are cleared.</p>
        <p>
          No success or failure is inferred for an interrupted request. Refresh workspace access before
          continuing.
        </p>
        <button type="button" className={styles.secondary} onClick={props.onClose} disabled={props.busy}>
          Close editor
        </button>
      </div>
    );
  const editable = draft ?? emptyLeadCaptureDraft;
  const retainedContact = snapshot.sequence?.input.contact;
  const retainedLead = snapshot.sequence?.input.lead;
  const value = snapshot.sequence
    ? {
        ...editable,
        displayName: retainedContact?.displayName ?? "",
        email: retainedContact?.emails?.[0] ?? "",
        phone: retainedContact?.phones?.[0] ?? "",
        ...(snapshot.phase !== "lead-rejected"
          ? {
              sourceId: retainedLead?.sourceId ?? "",
              intent: retainedLead?.intent ?? "unknown",
              timeline: retainedLead?.timeline ?? "",
            }
          : {}),
      }
    : editable;
  const frozenLead = Boolean(snapshot.sequence) && snapshot.phase !== "lead-rejected";
  const update = (key: keyof LeadCaptureDraft, entered: string) => {
    if (!disabled && !frozenLead && !(contactSaved && ["displayName", "email", "phone"].includes(key)))
      props.onDraftChange({ ...value, [key]: entered } as LeadCaptureDraft);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!disabled) props.onSave();
  };
  return (
    <form className={styles.root} onSubmit={submit}>
      <div className={styles.status} role="status" aria-live="polite">
        <p>{status}</p>
      </div>
      {props.error && (
        <p className={styles.error} role="alert">
          {props.error}
        </p>
      )}
      {!props.sources.length && !snapshot.sequence && (
        <p role="status">Lead sources are unavailable. Refresh workspace access and sources before saving.</p>
      )}
      {unknown && (
        <div className={styles.status}>
          <p>
            {props.canRetry
              ? "Reconciliation sends only the original unconfirmed step. The captured input cannot be changed."
              : "The safe retry window has ended or its clock is unavailable. The original outcome remains unconfirmed; no replacement is permitted."}
          </p>
          <button type="button" onClick={props.onReconcile} disabled={props.busy || !props.canRetry}>
            Reconcile original step
          </button>
        </div>
      )}
      <fieldset disabled={disabled || frozenLead}>
        <legend>
          {unknown
            ? "Retained capture fields"
            : contactSaved
              ? "Saved contact and lead details"
              : "Contact and lead details"}
        </legend>
        <label>
          Full name
          <input
            name="displayName"
            autoComplete="name"
            required
            value={contactSaved ? (retainedContact?.displayName ?? "") : value.displayName}
            readOnly={contactSaved}
            onChange={(event) => update("displayName", event.target.value)}
          />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            value={contactSaved ? (retainedContact?.emails?.[0] ?? "") : value.email}
            maxLength={254}
            readOnly={contactSaved}
            onChange={(event) => update("email", event.target.value)}
          />
        </label>
        <label>
          Phone (optional)
          <input
            name="phone"
            type="tel"
            autoComplete="tel"
            value={contactSaved ? (retainedContact?.phones?.[0] ?? "") : value.phone}
            maxLength={32}
            readOnly={contactSaved}
            onChange={(event) => update("phone", event.target.value)}
          />
        </label>
        <label>
          Intent
          <select
            name="intent"
            value={value.intent}
            onChange={(event) => update("intent", event.target.value)}
          >
            <option value="unknown">Unknown</option>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
            <option value="both">Buyer &amp; seller</option>
          </select>
        </label>
        <label>
          Source
          <select
            name="sourceId"
            required
            value={value.sourceId}
            onChange={(event) => update("sourceId", event.target.value)}
          >
            <option value="" disabled>
              Select source
            </option>
            {value.sourceId && !props.sources.some((source) => source.id === value.sourceId) && (
              <option value={value.sourceId}>
                Previously selected source — current availability unverified
              </option>
            )}
            {props.sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Timeline (optional)
          <input
            name="timeline"
            value={value.timeline}
            placeholder="Only what the person has shared"
            onChange={(event) => update("timeline", event.target.value)}
          />
        </label>
      </fieldset>
      <p className={styles.note}>Contact and lead creation are separate saves. No email or SMS is sent.</p>
      <div className={styles.actions}>
        {partial ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={props.onKeepContact}
            disabled={props.busy}
          >
            Keep saved contact and close
          </button>
        ) : (
          <button
            className={styles.secondary}
            type="button"
            onClick={props.onClose}
            disabled={props.busy || Boolean(snapshot.sequence)}
          >
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={
            disabled || (!draft && !snapshot.sequence) || !value.sourceId || !value.displayName.trim()
          }
        >
          {sending
            ? "Saving…"
            : snapshot.phase === "lead-ready"
              ? "Continue original lead"
              : partial
                ? "Save reviewed lead"
                : "Save lead"}
        </button>
      </div>
    </form>
  );
}
export default LeadCaptureView;
