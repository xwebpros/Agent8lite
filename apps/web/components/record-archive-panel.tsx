"use client";

import { type Ref, useEffect, useRef, useState } from "react";
import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import type { RecordArchiveKind, RecordArchiveSnapshot } from "./record-archive";
import styles from "./record-archive-panel.module.css";

export type RecordArchiveViewProps = {
  kind: RecordArchiveKind;
  /** Drawer resource identity; used only to match a resolved outcome, never rendered. */
  resourceId: string;
  snapshot: RecordArchiveSnapshot;
  /** A verified current record version is loaded for this drawer. */
  available: boolean;
  online: boolean;
  visible: boolean;
  busy: boolean;
  canArchive: boolean;
  canRetry: boolean;
  confirming: boolean;
  onRequest(): void;
  onCancel(): void;
  onConfirm(): void;
  onReconcile(): void;
  onForget?(): void;
  /** Receives focus when the confirmation step opens, so its label is announced. */
  confirmRef?: Ref<HTMLDivElement>;
  /** Receives focus back when the confirmation step is cancelled. */
  requestRef?: Ref<HTMLButtonElement>;
};

const noun = (kind: RecordArchiveKind) => (kind === "contact" ? "contact" : "lead");

/** Archive controls never render record or command details; recovery states are generic. */
export function RecordArchiveView(props: RecordArchiveViewProps) {
  const { phase, command, subject } = props.snapshot;
  const thing = noun(props.kind);
  if (phase === "forgotten")
    return (
      <div className={styles.panel} role="status">
        {localRecoveryForgottenWarning}
      </div>
    );
  if (phase === "denied")
    return (
      <div className={styles.panel} role="status">
        Archive access is unavailable. Private record details were cleared. Refresh workspace access before
        continuing. No interrupted outcome is inferred.
      </div>
    );
  const inactive = !props.online || !props.visible;
  if (command)
    return (
      <section className={styles.panel} aria-label="Archive recovery">
        <h3>{phase === "sending" ? "Confirming archive…" : "Archive unconfirmed"}</h3>
        <p role="status">
          {inactive
            ? "Record details are hidden while offline or this view is inactive. The original archive command remains in this tab."
            : props.canRetry || phase === "sending"
              ? "The archive may have completed. Reconcile the original command before another command, closing this record, switching organizations or signing out."
              : "The conservative retry window is unavailable or has expired. The archive remains unconfirmed. No new archive or automatic retry will be started."}
        </p>
        <button
          type="button"
          className="button button-secondary"
          onClick={props.onReconcile}
          disabled={inactive || props.busy || !props.canRetry || phase !== "unknown"}
        >
          Reconcile archive
        </button>
        {phase === "unknown" && !props.canRetry && props.onForget && (
          <div>
            <p>{localRecoveryForgettingExplanation}</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => props.onForget?.()}
              disabled={props.busy || !props.visible}
            >
              Clear this tab’s recovery data
            </button>
          </div>
        )}
      </section>
    );
  if (!props.canArchive) return null;
  if (inactive)
    return (
      <div className={styles.panel} role="status">
        Archive is unavailable while offline or this view is inactive.
      </div>
    );
  const matches =
    subject !== null &&
    subject.kind === props.kind &&
    subject.resourceId.toLowerCase() === props.resourceId.toLowerCase();
  const confirmId = `record-archive-${props.kind}-confirm`;
  return (
    <section
      className={styles.panel}
      aria-label={props.kind === "contact" ? "Archive contact" : "Archive lead"}
    >
      {matches && phase === "blocked" && (
        <p role="alert">Archive this contact’s active leads first. The contact was not archived.</p>
      )}
      {matches && phase === "unavailable" && (
        <p role="alert">
          This {thing} is unavailable or already archived. This request did not archive it. Refresh current
          records.
        </p>
      )}
      {matches && phase === "rejected" && (
        <p role="alert">
          The archive request was rejected. Review current access and the {thing} before trying again.
        </p>
      )}
      {!props.available ? (
        <p className={styles.muted} role="status">
          Archive becomes available after the current {thing} is read.
        </p>
      ) : props.confirming ? (
        <div
          ref={props.confirmRef}
          className={styles.confirm}
          role="group"
          aria-labelledby={confirmId}
          tabIndex={-1}
        >
          <p id={confirmId}>
            <strong>Archive this {thing}?</strong>{" "}
            {props.kind === "contact"
              ? "It leaves active lists and record views. Consent and suppression history stay unchanged."
              : "It leaves active lists and the pipeline. Tasks linked to it become unavailable."}
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-primary"
              onClick={props.onConfirm}
              disabled={props.busy}
            >
              Confirm archive
            </button>
            <button type="button" className="button button-secondary" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            ref={props.requestRef}
            type="button"
            className="button button-secondary"
            onClick={props.onRequest}
            disabled={props.busy}
          >
            {props.kind === "contact" ? "Archive contact" : "Archive lead"}
          </button>
        </div>
      )}
    </section>
  );
}

type PanelProps = Omit<RecordArchiveViewProps, "confirming" | "onRequest" | "onCancel" | "onConfirm"> & {
  onArchive(): void;
};

/** Holds only the in-page confirmation step; the workspace owns and rechecks every command guard. */
export default function RecordArchivePanel(props: PanelProps) {
  const live = useRef(props);
  live.current = props;
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const ready =
    !props.snapshot.command &&
    props.available &&
    props.canArchive &&
    props.online &&
    props.visible &&
    !props.busy;
  useEffect(() => {
    if (!ready) {
      confirmingRef.current = false;
      setConfirming(false);
    }
  }, [ready]);
  const set = (value: boolean) => {
    confirmingRef.current = value;
    setConfirming(value);
  };
  const shown = confirming && ready;
  const confirmBox = useRef<HTMLDivElement>(null);
  const requestButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (shown) {
      confirmBox.current?.focus();
      return;
    }
    // Only an explicit cancel returns focus; an archive or a lost precondition leaves focus alone.
    if (returnFocus.current) {
      returnFocus.current = false;
      requestButton.current?.focus();
    }
  }, [shown]);
  return (
    <RecordArchiveView
      {...props}
      confirmRef={confirmBox}
      requestRef={requestButton}
      confirming={shown}
      onRequest={() => {
        const p = live.current;
        if (p.snapshot.command || !p.available || !p.canArchive || !p.online || !p.visible || p.busy) return;
        set(true);
      }}
      onCancel={() => {
        returnFocus.current = true;
        set(false);
      }}
      onConfirm={() => {
        const p = live.current;
        if (
          !confirmingRef.current ||
          p.snapshot.command ||
          !p.available ||
          !p.canArchive ||
          !p.online ||
          !p.visible ||
          p.busy ||
          document.visibilityState !== "visible"
        )
          return;
        set(false);
        p.onArchive();
      }}
    />
  );
}
