import { ApiError } from "../lib/api";
import {
  BroadcastResponseError,
  broadcastIssues,
  copyBroadcastJson,
  requireBroadcastPreview,
  requireBroadcastRequest,
  type BroadcastCommand,
  type BroadcastIssue,
  type BroadcastPreview,
  type BroadcastRequest,
  type LeadFilter,
} from "./broadcast-preview-protocol";

export type BroadcastDraft = Readonly<{
  messageDesignId?: string;
  filter: LeadFilter;
  timezone: string;
  scheduledAt?: string;
}>;
export type BroadcastPreviewState = Readonly<{
  online: boolean;
  visible: boolean;
  canPreview: boolean;
  draft: BroadcastDraft;
  pending: BroadcastCommand | null;
  result: BroadcastPreview | null;
  phase: "editing" | "sending" | "unknown" | "rejected" | "ready" | "denied" | "unavailable";
  issues: readonly BroadcastIssue[];
  error: string;
}>;
export interface BroadcastPreviewClient {
  preview(command: BroadcastCommand): Promise<unknown>;
}
type FilterField = keyof LeadFilter;

const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * A preview has no business effect (receipt and audit only), so it is not a protected command.
 * An unknown outcome keeps the immutable request and key for an explicit retry while open.
 */
export class BroadcastPreviewController {
  private state: BroadcastPreviewState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private revoked = false;
  constructor(
    private readonly options: {
      binding: string;
      client: BroadcastPreviewClient;
      online: boolean;
      canPreview: boolean;
      createKey(): string;
      now?(): number;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = freeze({
      online: options.online,
      visible: true,
      canPreview: options.canPreview,
      draft: { filter: {}, timezone: "UTC" },
      pending: null,
      result: null,
      phase: "editing",
      issues: [],
      error: "",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<BroadcastPreviewState>) {
    this.state = freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private editable() {
    return !this.revoked && this.state.canPreview && !this.state.pending && this.state.phase !== "sending";
  }
  private replaceDraft(draft: BroadcastDraft) {
    this.update({ draft: copyBroadcastJson(draft), result: null, issues: [], error: "", phase: "editing" });
  }
  chooseDesign(id: string): boolean {
    if (!this.editable()) return false;
    this.replaceDraft({ ...this.state.draft, messageDesignId: id || undefined });
    return true;
  }
  /** Set or clear one allowlisted segment predicate; an empty value removes it. */
  editFilter(field: FilterField, value: string | readonly string[] | null): boolean {
    if (!this.editable()) return false;
    const filter: LeadFilter = { ...this.state.draft.filter };
    const empty = value === null || value === "" || (Array.isArray(value) && !value.length);
    if (field === "tagIds") {
      if (!empty && (!Array.isArray(value) || value.length > 20)) return false;
      if (empty) delete filter.tagIds;
      else filter.tagIds = [...(value as readonly string[])];
    } else if (field === "intent") {
      if (empty) delete filter.intent;
      else if (value === "buyer" || value === "seller" || value === "both" || value === "unknown")
        filter.intent = value;
      else return false;
    } else if (["stageId", "sourceId", "ownerMemberId", "q"].includes(field)) {
      if (typeof value !== "string" && !empty) return false;
      if (field === "q" && typeof value === "string" && [...value].length > 200) return false;
      if (empty) delete filter[field as "stageId"];
      else filter[field as "stageId"] = value as string;
    } else return false;
    this.replaceDraft({ ...this.state.draft, filter });
    return true;
  }
  setTimezone(value: string): boolean {
    if (!this.editable() || value.length > 80) return false;
    this.replaceDraft({ ...this.state.draft, timezone: value });
    return true;
  }
  setScheduledAt(value: string | null): boolean {
    if (!this.editable()) return false;
    const draft = { ...this.state.draft };
    if (value) draft.scheduledAt = value;
    else delete draft.scheduledAt;
    this.replaceDraft(draft);
    return true;
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    // Offline hides results; an unknown request stays in this tab for an explicit retry.
    this.update({ online, result: null, phase: this.state.phase === "ready" ? "editing" : this.state.phase });
  }
  setVisible(visible: boolean) {
    if (visible === this.state.visible) return;
    this.update({
      visible,
      result: null,
      phase: this.state.phase === "ready" ? "editing" : this.state.phase,
    });
  }
  /** Results disappear at their expiry instead of being shown as current. */
  expire(): boolean {
    const result = this.state.result;
    const now = this.options.now?.() ?? Date.now();
    if (!result || now < Date.parse(result.expiresAt)) return false;
    this.update({
      result: null,
      phase: "editing",
      error: "That preview expired. Preview the audience again.",
    });
    return true;
  }
  revoke() {
    this.revoked = true;
    ++this.generation;
    this.update({
      draft: { filter: {}, timezone: "UTC" },
      pending: null,
      result: null,
      phase: "denied",
      issues: [],
      error: "Current broadcast access could not be verified. Private segment data was cleared.",
    });
  }
  discardUnknown(): boolean {
    if (this.state.phase !== "unknown" || !this.state.pending) return false;
    this.update({ pending: null, phase: "editing", error: "" });
    return true;
  }
  async preview(): Promise<void> {
    if (this.revoked || !this.state.online || !this.state.visible || !this.state.canPreview) return;
    if (this.state.phase === "sending") return;
    let command = this.state.pending;
    if (!command) {
      const issues = broadcastIssues(this.state.draft);
      if (issues.length) {
        this.update({ issues });
        return;
      }
      let key: string;
      try {
        key = this.options.createKey();
        if (typeof key !== "string" || !key || key.length > 100) throw new Error();
      } catch {
        this.update({ error: "A preview reference could not be created." });
        return;
      }
      let body: BroadcastRequest;
      try {
        body = requireBroadcastRequest(this.state.draft);
      } catch {
        this.update({ issues: broadcastIssues(this.state.draft), error: "Review the segment fields." });
        return;
      }
      command = freeze({ binding: this.options.binding, idempotencyKey: key, body });
    }
    if (command.binding !== this.options.binding) return;
    const generation = ++this.generation;
    this.update({ pending: command, phase: "sending", error: "", issues: [] });
    try {
      const value = await this.options.client.preview(copyBroadcastJson(command));
      if (generation !== this.generation || this.revoked) return;
      const result = requireBroadcastPreview(value);
      this.update({ pending: null, result, phase: "ready" });
      this.expire();
    } catch (error) {
      if (generation !== this.generation || this.revoked) return;
      if (error instanceof ApiError && error.status === 401) {
        this.revoke();
        this.options.onAccessRevoked?.();
        return;
      }
      if (error instanceof ApiError && error.status === 403) {
        const entitlement = error.code === "entitlement_disabled";
        this.update({
          pending: null,
          result: null,
          phase: entitlement ? "unavailable" : "denied",
          error: entitlement
            ? "Marketing capability is unavailable or expired."
            : "Organization-wide broadcast and CRM read access are required to preview an audience.",
        });
        return;
      }
      if (error instanceof ApiError && [400, 404, 409, 422, 429].includes(error.status)) {
        this.update({
          pending: null,
          phase: "rejected",
          issues: error instanceof BroadcastResponseError ? error.issues : [],
          error:
            error.code === "broadcast_audience_too_large"
              ? "This segment matches more than 5,000 leads. Narrow it and preview again."
              : error.code === "workflow_reference_unavailable" || error.code === "design_unavailable"
                ? "A chosen design or segment reference is unavailable. Choose current references."
                : "The preview was not accepted. Review the segment and try again.",
        });
        return;
      }
      this.update({
        phase: "unknown",
        error: "The preview result is unknown. Retry this preview to read it with the same reference.",
      });
    }
  }
}
