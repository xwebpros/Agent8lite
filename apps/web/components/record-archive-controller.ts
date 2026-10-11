import {
  type RecordArchiveCommand,
  type RecordArchiveKind,
  type RecordArchiveProtocol,
  recordArchiveRequest,
} from "./record-archive";
export { recordArchiveRequest } from "./record-archive";

export type RecordArchiveOutcome = Readonly<
  | { type: "acknowledged"; command: RecordArchiveCommand }
  | { type: "unknown"; command: RecordArchiveCommand; sent: boolean }
  | { type: "released"; command: RecordArchiveCommand; phase: "blocked" | "unavailable" | "rejected" }
  | { type: "denied"; command: RecordArchiveCommand }
  | { type: "ignored" }
>;
export type RecordArchiveSendHooks = Readonly<{
  /** Live recheck of the verified binding and every mutual-exclusion guard immediately before sending. */
  allowed(): boolean;
  /** Synchronous UI protection (busy, cleared private lists) after the checks and before the first await. */
  dispatched?(): void;
}>;

/**
 * Orchestrates exactly one in-flight archive request per tab. Every await is followed by a
 * protocol currency check, so callbacks from a replaced binding, a forgotten command or an
 * unmounted workspace are ignored and cannot acknowledge, release or deny current state.
 */
export class RecordArchiveController {
  private active: RecordArchiveCommand | null = null;
  constructor(
    readonly protocol: RecordArchiveProtocol,
    private readonly request: typeof recordArchiveRequest = recordArchiveRequest,
  ) {}
  /** True only while the current protocol command is on the wire; binding loss releases it. */
  isActive(command?: RecordArchiveCommand): boolean {
    const active = this.active;
    return Boolean(
      active && this.protocol.isCurrent(active) && (command === undefined || active === command),
    );
  }
  begin(
    target: { kind: RecordArchiveKind; resourceId: string; version: number },
    key: string,
  ): RecordArchiveCommand {
    if (this.isActive()) throw new Error("An archive command is already being confirmed.");
    return this.protocol.begin(target, key);
  }
  async send(
    command: RecordArchiveCommand,
    csrf: string,
    hooks: RecordArchiveSendHooks,
  ): Promise<RecordArchiveOutcome> {
    if (!this.protocol.isCurrent(command)) return { type: "ignored" };
    let allowed = false;
    try {
      allowed = !this.isActive() && hooks.allowed() && this.protocol.canRetry(command);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      if (!this.protocol.isCurrent(command) || this.isActive()) return { type: "ignored" };
      // A captured command that cannot be sent stays conservatively unconfirmed, never silently dropped.
      this.protocol.reject(command, new Error("Archive send unavailable."));
      return { type: "unknown", command, sent: false };
    }
    this.active = command;
    try {
      hooks.dispatched?.();
      const receipt = await this.request(command, csrf);
      if (!this.protocol.isCurrent(command)) return { type: "ignored" };
      return this.protocol.acknowledge(command, receipt.data, receipt.etag)
        ? { type: "acknowledged", command }
        : { type: "unknown", command, sent: true };
    } catch (error) {
      const outcome = this.protocol.reject(command, error);
      if (outcome === "ignored") return { type: "ignored" };
      if (outcome === "unknown") return { type: "unknown", command, sent: true };
      const phase = this.protocol.getSnapshot().phase;
      return phase === "denied"
        ? { type: "denied", command }
        : {
            type: "released",
            command,
            phase: phase === "blocked" || phase === "unavailable" ? phase : "rejected",
          };
    } finally {
      if (this.active === command) this.active = null;
    }
  }
  /** Resends only the identical retained command and key; throws when the retry window is unavailable. */
  async reconcile(
    expected: RecordArchiveCommand | null,
    csrf: string,
    hooks: RecordArchiveSendHooks,
  ): Promise<RecordArchiveOutcome> {
    if (
      !expected ||
      this.protocol.getSnapshot().command !== expected ||
      !this.protocol.isCurrent(expected) ||
      this.isActive()
    )
      return { type: "ignored" };
    if (!hooks.allowed()) return { type: "ignored" };
    return this.send(this.protocol.retry(), csrf, hooks);
  }
  forget(expected: RecordArchiveCommand | null): boolean {
    if (!expected || this.protocol.getSnapshot().command !== expected || this.isActive()) return false;
    return this.protocol.forget();
  }
}
