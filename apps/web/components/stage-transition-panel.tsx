import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import type { StageTransitionSnapshot } from "./stage-transition";

export type StageTransitionViewProps = {
  snapshot: StageTransitionSnapshot;
  online: boolean;
  visible: boolean;
  busy: boolean;
  canWrite: boolean;
  canRetry: boolean;
  onReconcile(): void;
  onForget?(): void;
};
/** Recovery never renders lead IDs, target identifiers, reasons or other private fields. */
export function StageTransitionView(props: StageTransitionViewProps) {
  const { phase, command } = props.snapshot;
  if (phase === "forgotten")
    return (
      <div className="connection-banner" role="status">
        <span>{localRecoveryForgottenWarning}</span>
      </div>
    );
  if (phase === "denied")
    return (
      <div className="error" role="status">
        Stage access is unavailable. Private recovery data was cleared; no interrupted outcome is inferred.
        Refresh workspace access before continuing.
      </div>
    );
  if (!command) return null;
  const unavailable = !props.online || !props.visible;
  return (
    <section className="panel" aria-label="Stage transition recovery" style={{ padding: 16 }}>
      <h2>{phase === "sending" ? "Confirming stage transition…" : "Stage transition unconfirmed"}</h2>
      <p role="status">
        {unavailable
          ? "Lead details are hidden while offline or this view is inactive. The original stage command remains in this tab."
          : "The transition may have completed. Reconcile only the original input and record version before another command, leaving this view or signing out."}
      </p>
      <button
        type="button"
        className="button button-secondary"
        onClick={props.onReconcile}
        disabled={unavailable || props.busy || !props.canWrite || !props.canRetry || phase !== "unknown"}
      >
        Reconcile stage transition
      </button>
      {phase === "unknown" && !props.canRetry && props.onForget && (
        <div>
          <p>{localRecoveryForgettingExplanation}</p>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => props.onForget?.()}
            disabled={props.busy || !props.visible || !props.canWrite}
          >
            Clear this tab’s recovery data
          </button>
        </div>
      )}
      <p className="muted">
        An acknowledged historical transition is followed by a separate current-record read. No historical
        lead replaces a newer record.
      </p>
    </section>
  );
}
export default StageTransitionView;
