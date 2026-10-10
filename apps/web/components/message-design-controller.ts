import { ApiError, type Schema } from "../lib/api";
import {
  copyMessageDesign,
  freezeMessageDesign,
  isMessageDesignId,
  messageDesignIssues,
  messageDesignVersion,
  messageDesignWriteFromReceipt,
  nativeTextBlocks,
  requireMessageDesignPage,
  requireMessageDesignReceipt,
  requireMessageDesignWrite,
  sameMessageDesignBody,
  type MessageDesignBody,
  type MessageDesignCommand,
  type MessageDesignIssue,
  type MessageDesignReceipt,
} from "./message-design-protocol";

export interface MessageDesignClient {
  list(cursor?: string | null): Promise<unknown>;
  detail(id: string): Promise<{ data: unknown; etag: string }>;
  submit(command: MessageDesignCommand): Promise<{ data: unknown; etag: string }>;
}
export type MessageDesignState = Readonly<{
  online: boolean;
  canRead: boolean;
  canWrite: boolean;
  page: Schema<"PageMessageDesign"> | null;
  pageStale: boolean;
  listError: string;
  reading: "list" | "detail" | "conflict" | null;
  selected: MessageDesignReceipt | null;
  input: MessageDesignBody | null;
  baseline: MessageDesignBody | null;
  mode: "idle" | "create" | "edit";
  targetId: string | null;
  ifMatch: string | null;
  dirty: boolean;
  pending: MessageDesignCommand | null;
  receipt: MessageDesignReceipt | null;
  conflictCurrent: MessageDesignReceipt | null;
  phase:
    | "idle"
    | "editing"
    | "sending"
    | "uncertain"
    | "rejected"
    | "conflict"
    | "immutable"
    | "acknowledged"
    | "unavailable"
    | "denied";
  issues: readonly MessageDesignIssue[];
  error: string;
  message: string;
}>;

/** Current reads and protected command snapshots live only in this component's memory. */
export class MessageDesignController {
  private state: MessageDesignState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private readEpoch = 0;
  private writing = false;
  private detached = false;
  private revoked = false;
  constructor(
    private readonly options: {
      binding: string;
      client: MessageDesignClient;
      online: boolean;
      canRead: boolean;
      canWrite: boolean;
      createKey(): string;
      onProtectedChange?(value: boolean): void;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = freezeMessageDesign({
      online: options.online,
      canRead: options.canRead,
      canWrite: options.canWrite,
      page: null,
      pageStale: false,
      listError: "",
      reading: null,
      selected: null,
      input: null,
      baseline: null,
      mode: "idle",
      targetId: null,
      ifMatch: null,
      dirty: false,
      pending: null,
      receipt: null,
      conflictCurrent: null,
      phase: "idle",
      issues: [],
      error: "",
      message: "Read a message design explicitly or start a native text draft.",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  isProtected = () => this.state.dirty || Boolean(this.state.pending) || this.writing;
  private update(patch: Partial<MessageDesignState>) {
    this.state = freezeMessageDesign({ ...this.state, ...patch });
    this.options.onProtectedChange?.(this.isProtected());
    for (const listener of this.listeners) listener();
  }
  private clear(phase: MessageDesignState["phase"], message: string) {
    ++this.generation;
    ++this.readEpoch;
    this.writing = false;
    this.update({
      page: null,
      pageStale: false,
      listError: "",
      reading: null,
      selected: null,
      input: null,
      baseline: null,
      mode: "idle",
      targetId: null,
      ifMatch: null,
      dirty: false,
      pending: null,
      receipt: null,
      conflictCurrent: null,
      phase,
      issues: [],
      error: "",
      message,
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.clear("idle", "Private message memory cleared when leaving this workspace.");
  }
  revoke() {
    this.revoked = true;
    this.clear("denied", "Current message access changed. Private memory was cleared.");
  }
  private available() {
    return !this.revoked && !this.detached && this.state.online && !this.state.reading && !this.writing;
  }
  private mayReplace() {
    return (
      this.available() &&
      this.state.canRead &&
      !this.isProtected() &&
      !["denied", "unavailable"].includes(this.state.phase)
    );
  }
  private mayEdit() {
    return (
      this.available() &&
      this.state.canWrite &&
      this.state.phase === "editing" &&
      Boolean(this.state.input) &&
      !this.state.pending
    );
  }
  private fail(error: unknown): boolean {
    if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return false;
    const entitlement = error.status === 403 && error.code === "entitlement_disabled";
    const unavailable = entitlement || error.status === 404;
    if (!unavailable) this.revoked = true;
    this.clear(
      unavailable ? "unavailable" : "denied",
      entitlement
        ? "Marketing capability is unavailable or expired. Private message data and drafts were cleared."
        : unavailable
          ? "This message resource is unavailable. Private memory was cleared."
          : "Current message access could not be verified. Private memory was cleared.",
    );
    if (!unavailable) this.options.onAccessRevoked?.();
    return true;
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    if (online) {
      this.update({ online });
      return;
    }
    ++this.readEpoch;
    const keep = this.isProtected();
    this.update({
      online,
      page: null,
      pageStale: false,
      listError: "",
      reading: null,
      selected: null,
      receipt: null,
      conflictCurrent: null,
      ...(keep
        ? {}
        : {
            input: null,
            baseline: null,
            targetId: null,
            ifMatch: null,
            mode: "idle" as const,
            issues: [],
            phase: ["denied", "unavailable"].includes(this.state.phase)
              ? this.state.phase
              : ("idle" as const),
          }),
      message: keep
        ? "Offline. The original draft or command remains only in this tab; mutations require a connection."
        : "Offline. Read private message designs again after reconnecting.",
    });
  }
  async loadPage(cursor?: string | null) {
    if (!this.available() || !this.state.canRead || this.isProtected()) return;
    if (cursor && cursor !== this.state.page?.nextCursor) return;
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "list", listError: "" });
    try {
      const value = await this.options.client.list(cursor);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      this.update({
        page: requireMessageDesignPage(value),
        pageStale: false,
        ...(this.state.phase === "unavailable"
          ? { phase: "idle" as const, message: "Current message access verified by a fresh page read." }
          : {}),
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          pageStale: Boolean(this.state.page),
          listError: "Message designs could not be refreshed. Any retained page may be stale.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  async select(id: string) {
    if (!this.mayReplace() || !isMessageDesignId(id)) return;
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "detail", error: "" });
    try {
      const result = await this.options.client.detail(id);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const selected = requireMessageDesignReceipt(result.data, result.etag, id);
      const input = messageDesignWriteFromReceipt(selected.data);
      this.update({
        selected,
        input,
        baseline: input,
        targetId: input ? id : null,
        ifMatch: input ? selected.etag : null,
        mode: input ? "edit" : "idle",
        dirty: false,
        phase: input ? "editing" : "idle",
        pending: null,
        conflictCurrent: null,
        receipt: null,
        issues: [],
        error: "",
        message: input
          ? `Current message design read at version ${selected.data.version}. Saving remains a separate action.`
          : "This editor or older design format is read-only here; its content is preserved without conversion.",
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          error: "The current message design could not be verified. No editor fields were replaced.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  beginCreate() {
    if (!this.mayReplace() || !this.state.canWrite) return false;
    const input: MessageDesignBody = {
      name: "",
      channel: "email",
      editor: "native",
      design: { schemaVersion: 1, blocks: [{ type: "text", text: "" }] },
      content: "",
    };
    this.update({
      input: copyMessageDesign(input),
      baseline: null,
      selected: null,
      targetId: null,
      ifMatch: null,
      mode: "create",
      dirty: true,
      phase: "editing",
      pending: null,
      receipt: null,
      conflictCurrent: null,
      issues: [],
      error: "",
      message: "New native static-text draft. Saving does not send a message.",
    });
    return true;
  }
  copySelected() {
    if (!this.mayReplace() || !this.state.canWrite || !this.state.selected) return false;
    const input = messageDesignWriteFromReceipt(this.state.selected.data);
    if (!input) return false;
    this.update({
      input: copyMessageDesign(input),
      baseline: null,
      selected: null,
      targetId: null,
      ifMatch: null,
      mode: "create",
      dirty: true,
      phase: "editing",
      issues: [],
      error: "",
      receipt: null,
      message:
        "Copied to a new unsaved native draft. The original design and its references remain unchanged.",
    });
    return true;
  }
  private replaceInput(input: MessageDesignBody) {
    try {
      input = copyMessageDesign(input);
    } catch {
      this.update({ error: "The escaped draft exceeds 256 KiB; earlier fields were retained." });
      return false;
    }
    this.update({
      input,
      dirty:
        this.state.mode === "create" ||
        !this.state.baseline ||
        !sameMessageDesignBody(input, this.state.baseline),
      issues: messageDesignIssues(input),
      error: "",
      message: "Unsaved native text fields remain only in this tab.",
    });
    return true;
  }
  edit(field: "name" | "subject" | "channel", value: string) {
    if (!this.mayEdit() || !this.state.input) return false;
    const input = copyMessageDesign(this.state.input);
    if (field === "channel") {
      if (this.state.mode !== "create" || (value !== "email" && value !== "sms")) return false;
      input.channel = value;
    } else {
      if (Array.from(value).length > (field === "name" ? 120 : 200)) {
        this.update({ error: "This field exceeds its character limit; earlier text was retained." });
        return false;
      }
      if (field === "subject" && value === "") delete input.subject;
      else input[field] = value;
    }
    return this.replaceInput(input);
  }
  editBlock(index: number, text: string) {
    if (!this.mayEdit() || !this.state.input || !Number.isInteger(index)) return false;
    const input = copyMessageDesign(this.state.input),
      design = nativeTextBlocks(input);
    if (!design || !design.blocks[index]) return false;
    if (Array.from(text).length > 100000) {
      this.update({ error: "This block exceeds 100,000 characters; earlier text was retained." });
      return false;
    }
    design.blocks[index].text = text;
    input.design = design;
    input.content = design.blocks.map((block) => block.text).join("\n");
    return this.replaceInput(input);
  }
  changeBlocks(action: "add" | "remove" | "up" | "down", index = 0) {
    if (!this.mayEdit() || !this.state.input) return false;
    const input = copyMessageDesign(this.state.input),
      design = nativeTextBlocks(input);
    if (!design) return false;
    if (action === "add") {
      if (design.blocks.length >= 100) return false;
      design.blocks.push({ type: "text", text: "" });
    } else {
      if (!Number.isInteger(index) || !design.blocks[index]) return false;
      if (action === "remove") {
        if (design.blocks.length === 1) return false;
        design.blocks.splice(index, 1);
      } else {
        const next = index + (action === "up" ? -1 : 1);
        if (next < 0 || next >= design.blocks.length) return false;
        [design.blocks[index], design.blocks[next]] = [design.blocks[next], design.blocks[index]];
      }
    }
    input.design = design;
    input.content = design.blocks.map((block) => block.text).join("\n");
    return this.replaceInput(input);
  }
  discard() {
    if (this.writing || this.state.pending || this.state.reading || this.revoked || this.detached)
      return false;
    this.update({
      input: null,
      baseline: null,
      selected: null,
      targetId: null,
      ifMatch: null,
      mode: "idle",
      dirty: false,
      phase: "idle",
      issues: [],
      error: "",
      message: "Unsent draft discarded. Read a design again before another edit.",
    });
    return true;
  }
  editRejected() {
    if (!this.available() || this.state.phase !== "rejected") return false;
    this.update({
      pending: null,
      phase: "editing",
      dirty: true,
      error: "",
      message: "The known rejected command was released explicitly. Review fields before a new save.",
    });
    return true;
  }
  copyImmutable() {
    if (!this.available() || !this.state.canWrite || this.state.phase !== "immutable" || !this.state.pending)
      return false;
    this.update({
      input: copyMessageDesign(this.state.pending.body),
      baseline: null,
      pending: null,
      selected: null,
      targetId: null,
      ifMatch: null,
      mode: "create",
      dirty: true,
      phase: "editing",
      issues: [],
      error: "",
      message:
        "Prepared an explicit new-ID copy. Saving creates a new design; old workflow references do not change.",
    });
    return true;
  }
  async save() {
    if (
      !this.available() ||
      !this.state.canWrite ||
      !this.state.input ||
      ["conflict", "immutable", "denied", "unavailable"].includes(this.state.phase)
    )
      return;
    const wasUncertain = this.state.phase === "uncertain";
    let command = this.state.pending;
    if (!command) {
      if (this.state.phase !== "editing" || !this.state.dirty) return;
      const issues = messageDesignIssues(this.state.input);
      if (issues.length) {
        this.update({ issues, error: "Review the marked static-text fields before saving." });
        return;
      }
      let key: string;
      try {
        key = this.options.createKey();
      } catch {
        this.update({ error: "The original command reference could not be created." });
        return;
      }
      if (!key || typeof key !== "string" || key.length > 100) return;
      if (
        this.state.mode === "edit" &&
        (!this.state.targetId ||
          !this.state.ifMatch ||
          messageDesignVersion(this.state.ifMatch) >= Number.MAX_SAFE_INTEGER)
      )
        return;
      command = freezeMessageDesign({
        binding: this.options.binding,
        kind: this.state.mode === "create" ? "create" : "update",
        designId: this.state.targetId,
        ifMatch: this.state.ifMatch,
        idempotencyKey: key,
        body: requireMessageDesignWrite(this.state.input),
      });
    }
    if (command.binding !== this.options.binding) return;
    const generation = this.generation;
    this.writing = true;
    this.update({
      pending: command,
      phase: "sending",
      error: "",
      message: "Saving the original native draft command…",
    });
    try {
      const result = await this.options.client.submit(copyMessageDesign(command, 1024 * 1024));
      if (generation !== this.generation || this.revoked) return;
      const receipt = requireMessageDesignReceipt(result.data, result.etag, command.designId ?? undefined);
      const body = messageDesignWriteFromReceipt(receipt.data);
      if (
        !body ||
        !sameMessageDesignBody(body, command.body) ||
        receipt.data.version !== (command.kind === "create" ? 1 : messageDesignVersion(command.ifMatch) + 1)
      )
        throw new Error("The native acknowledgment differs from the original command.");
      this.writing = false;
      this.update({
        receipt,
        selected: null,
        input: null,
        baseline: null,
        targetId: null,
        ifMatch: null,
        mode: "idle",
        pending: null,
        dirty: false,
        phase: "acknowledged",
        issues: [],
        error: "",
        conflictCurrent: null,
        pageStale: Boolean(this.state.page),
        message:
          "Native draft command acknowledged. Its receipt may be historical; read the current design before another edit.",
      });
    } catch (error) {
      if (generation !== this.generation || this.revoked) return;
      if (this.fail(error)) return;
      if (!wasUncertain && command.kind === "update" && error instanceof ApiError && error.status === 412)
        this.update({
          phase: "conflict",
          conflictCurrent: null,
          error:
            "The revision changed. The original draft is protected until explicit current-version review.",
        });
      else if (
        !wasUncertain &&
        command.kind === "update" &&
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === "design_referenced_immutable"
      )
        this.update({
          phase: "immutable",
          error:
            "This design is preserved by a workflow reference. Its original fields are immutable; explicitly prepare a new-ID copy to continue.",
        });
      else if (!wasUncertain && error instanceof ApiError && [400, 422, 429].includes(error.status))
        this.update({
          phase: "rejected",
          error: "The request was rejected. Explicitly edit the rejected fields or retry the same command.",
        });
      else
        this.update({
          phase: "uncertain",
          error:
            "The command outcome is unknown. The exact design ID, revision, key and body cannot be replaced; retry only the original request.",
        });
    } finally {
      if (generation === this.generation) {
        this.writing = false;
        this.update({});
      }
    }
  }
  async readConflict() {
    if (!this.available() || this.state.phase !== "conflict" || !this.state.pending?.designId) return;
    const id = this.state.pending.designId,
      generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "conflict", conflictCurrent: null });
    try {
      const result = await this.options.client.detail(id);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      this.update({ conflictCurrent: requireMessageDesignReceipt(result.data, result.etag, id) });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          error:
            "The current conflict version could not be verified. Original fields and key remain protected.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  resolveConflict(keepFields: boolean) {
    if (
      !this.available() ||
      this.state.phase !== "conflict" ||
      !this.state.conflictCurrent ||
      !this.state.input
    )
      return false;
    const current = this.state.conflictCurrent,
      body = messageDesignWriteFromReceipt(current.data);
    if (!body || body.channel !== this.state.input.channel || body.editor !== this.state.input.editor)
      return false;
    const input = keepFields ? copyMessageDesign(this.state.input) : body;
    this.update({
      selected: current,
      baseline: body,
      input,
      targetId: current.data.id,
      ifMatch: current.etag,
      pending: null,
      conflictCurrent: null,
      mode: "edit",
      dirty: !sameMessageDesignBody(input, body),
      phase: "editing",
      issues: messageDesignIssues(input),
      error: "",
      message: "Reviewed current revision selected explicitly. Saving remains a separate command.",
    });
    return true;
  }
}
