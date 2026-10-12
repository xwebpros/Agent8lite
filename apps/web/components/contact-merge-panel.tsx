"use client";

import { type Ref, useEffect, useRef, useState } from "react";
import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import type { ContactMergeSnapshot } from "./contact-merge";
import styles from "./record-archive-panel.module.css";

export type ContactMergeViewProps = {
  survivorId: string;
  sourceId: string;
  survivorName: string;
  sourceName: string;
  snapshot: ContactMergeSnapshot;
  available: boolean;
  online: boolean;
  visible: boolean;
  busy: boolean;
  canMerge: boolean;
  canRetry: boolean;
  confirming: boolean;
  phoneOnlyMatch: boolean;
  onRequest(): void;
  onCancel(): void;
  onConfirm(): void;
  onConfirmPhoneOnly(): void;
  onDismissPhoneOnly(): void;
  onReconcile(): void;
  onForget?(): void;
  /** Receives focus when the confirmation step opens. */
  confirmRef?: Ref<HTMLDivElement>;
  /** Receives focus back when cancelled. */
  requestRef?: Ref<HTMLButtonElement>;
};

/** Merge controls never render channel values, consent ledger details or destination addresses. */
export function ContactMergeView(props: ContactMergeViewProps) {
  const { phase, command, subject } = props.snapshot;

  if (phase === "forgotten")
    return (
      <div className={styles.panel} role="status">
        {localRecoveryForgottenWarning}
      </div>
    );

  if (phase === "denied")
    return (
      <div className={styles.panel} role="status">
        Merge access is unavailable. Private record details were cleared. Refresh workspace access before
        continuing. No interrupted outcome is inferred.
      </div>
    );

  const inactive = !props.online || !props.visible;

  // Phone-only acknowledgement warning
  if (phase === "phone_only_warning" && !command)
    return (
      <section className={styles.panel} aria-label="Phone-only match warning">
        <h3>These contacts share only a phone number</h3>
        <p>
          Merging contacts that share only a phone number may combine records from different people in the
          same household. Confirm you have reviewed both records and they belong to the same person.
        </p>
        <p>
          <strong>Survivor (kept):</strong> {props.survivorName}
          <br />
          <strong>Source (merged in):</strong> {props.sourceName}
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button type="button" onClick={props.onDismissPhoneOnly}>
            Cancel
          </button>
          <button type="button" onClick={props.onConfirmPhoneOnly}>
            Confirm — merge anyway
          </button>
        </div>
      </section>
    );

  if (command)
    return (
      <section className={styles.panel} aria-label="Merge recovery">
        <h3>{phase === "sending" ? "Confirming merge…" : "Merge unconfirmed"}</h3>
        <p role="status">
          {inactive
            ? "Record details are hidden while offline or this view is inactive. The original merge command remains in this tab."
            : props.canRetry || phase === "sending"
              ? "The merge may have completed. Reconcile the original command before another command, closing this record, switching organizations or signing out."
              : localRecoveryForgettingExplanation}
        </p>
        {!inactive && props.canRetry && (
          <button type="button" onClick={props.onReconcile}>
            Reconcile merge
          </button>
        )}
        {!inactive && !props.canRetry && props.onForget && (
          <button type="button" onClick={props.onForget}>
            Accept unresolved
          </button>
        )}
      </section>
    );

  if (phase === "acknowledged")
    return (
      <div className={styles.panel} role="status">
        Contacts merged successfully. {props.survivorName} is now the single record.
      </div>
    );

  if (phase === "blocked")
    return (
      <div className={styles.panel} role="status">
        Merge unavailable: one or more source leads are outside your current scope. Reassign those leads
        before merging.
      </div>
    );

  if (phase === "unavailable")
    return (
      <div className={styles.panel} role="status">
        One or both contacts are no longer available.
      </div>
    );

  if (phase === "rejected")
    return (
      <div className={styles.panel} role="status">
        The merge could not be completed. Review both records and try again.
      </div>
    );

  // idle — confirming or initial request
  if (props.confirming)
    return (
      <section
        className={styles.panel}
        aria-label="Confirm merge"
        ref={props.confirmRef as Ref<HTMLElement>}
        tabIndex={-1}
      >
        <h3 id="merge-confirm-heading">Confirm merge</h3>
        <p>
          <strong>Survivor (kept):</strong> {props.survivorName}
          <br />
          <strong>Source (archived):</strong> {props.sourceName}
        </p>
        <p>
          Channels, leads and consent history will be combined. Withdrawal wins where records conflict unless
          a later verified grant exists. This cannot be undone.
        </p>
        {props.phoneOnlyMatch && (
          <p>
            <strong>Note:</strong> These contacts share only a phone number.
          </p>
        )}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button type="button" ref={props.requestRef} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" onClick={props.onConfirm} disabled={props.busy || !props.canMerge}>
            Merge into {props.survivorName}
          </button>
        </div>
      </section>
    );

  return (
    <div className={styles.panel}>
      <button
        type="button"
        ref={props.requestRef}
        onClick={props.onRequest}
        disabled={props.busy || !props.canMerge || !props.available}
      >
        Merge into this contact
      </button>
    </div>
  );
}

/** Stateful wrapper that manages confirming state and focus management. */
export function ContactMergePanel(
  props: Omit<ContactMergeViewProps, "confirming" | "confirmRef" | "requestRef">,
) {
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<HTMLButtonElement>(null);
  const { phase } = props.snapshot;

  useEffect(() => {
    if (phase !== "idle" && phase !== "phone_only_warning") setConfirming(false);
  }, [phase]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  return (
    <ContactMergeView
      {...props}
      confirming={confirming}
      confirmRef={confirmRef}
      requestRef={requestRef}
      onRequest={() => setConfirming(true)}
      onCancel={() => {
        setConfirming(false);
        requestRef.current?.focus();
      }}
    />
  );
}
