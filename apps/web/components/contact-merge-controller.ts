import {
  type ContactMergeCommand,
  type ContactMergeProtocol,
  contactMergeRequest,
} from "./contact-merge";
export { contactMergeRequest } from "./contact-merge";

export type ContactMergeOutcome = Readonly<
  | { type: "acknowledged"; command: ContactMergeCommand }
  | { type: "unknown"; command: ContactMergeCommand; sent: boolean }
  | {
      type: "released";
      command: ContactMergeCommand;
      phase: "blocked" | "unavailable" | "rejected" | "phone_only_warning";
    }
  | { type: "denied"; command: ContactMergeCommand }
  | { type: "ignored" }
>;

export type ContactMergeSendHooks = Readonly<{
  /** Live recheck of the verified binding and every mutual-exclusion guard immediately before sending. */
  allowed(): boolean;
  /** Synchronous UI protection after the checks and before the first await. */
  dispatched?(): void;
}>;

/**
 * Orchestrates exactly one in-flight merge request per tab. Every await is followed by a
 * protocol currency check, so callbacks from a replaced binding, a forgotten command or an
 * unmounted workspace are ignored.
 */
export class ContactMergeController {
  private active: ContactMergeCommand | null = null;

  constructor(
    readonly protocol: ContactMergeProtocol,
    private readonly request: typeof contactMergeRequest = contactMergeRequest,
  ) {}

  isActive(command?: ContactMergeCommand): boolean {
    const active = this.active;
    return Boolean(
      active && this.protocol.isCurrent(active) && (command === undefined || active === command),
    );
  }

  begin(
    target: {
      survivorId: string;
      sourceId: string;
      survivorVersion: number;
      sourceVersion: number;
      acknowledgePhoneOnly?: boolean;
    },
    key: string,
  ): ContactMergeCommand {
    if (this.isActive()) throw new Error("A merge command is already being confirmed.");
    return this.protocol.begin(target, key);
  }

  async send(
    command: ContactMergeCommand,
    csrf: string,
    hooks: ContactMergeSendHooks,
  ): Promise<ContactMergeOutcome> {
    if (!this.protocol.isCurrent(command)) return { type: "ignored" };
    let allowed = false;
    try {
      allowed = !this.isActive() && hooks.allowed() && this.protocol.canRetry(command);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      if (!this.protocol.isCurrent(command) || this.isActive()) return { type: "ignored" };
      this.protocol.reject(command, new Error("Merge send unavailable."));
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
      if (phase === "denied") return { type: "denied", command };
      return {
        type: "released",
        command,
        phase:
          phase === "blocked" ||
          phase === "unavailable" ||
          phase === "phone_only_warning"
            ? phase
            : "rejected",
      };
    } finally {
      if (this.active === command) this.active = null;
    }
  }

  async reconcile(
    expected: ContactMergeCommand | null,
    csrf: string,
    hooks: ContactMergeSendHooks,
  ): Promise<ContactMergeOutcome> {
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

  forget(expected: ContactMergeCommand | null): boolean {
    if (!expected || this.protocol.getSnapshot().command !== expected || this.isActive()) return false;
    return this.protocol.forget();
  }
}
