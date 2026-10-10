import type {
  WorkflowIssue,
  WorkflowPreviewOptions,
  WorkflowPreviewStep,
} from "../../../packages/marketing/types";
import { WorkflowValidationError } from "../../../packages/marketing";
import { ApiError, type Schema } from "../lib/api";
import {
  copyWorkflowJson,
  isWorkflowId,
  requireWorkflowPage,
  requireWorkflowVersion,
  sameWorkflowDefinition,
  workflowLinearDefinition,
  workflowLinearOrder,
  WorkflowResponseError,
  type WorkflowDefinition,
  type WorkflowDraftCommand,
  type WorkflowVersionReceipt,
} from "./campaign-workflow-protocol";

export interface CampaignWorkflowClient {
  list(cursor?: string | null): Promise<unknown>;
  detail(id: string): Promise<{ data: unknown; etag: string }>;
  create(command: WorkflowDraftCommand): Promise<{ data: unknown; etag: string }>;
}
export type CampaignWorkflowState = Readonly<{
  online: boolean;
  canRead: boolean;
  canWrite: boolean;
  page: Schema<"PageCampaignVersion"> | null;
  pageStale: boolean;
  listError: string;
  reading: boolean;
  selected: WorkflowVersionReceipt | null;
  draft: WorkflowDefinition | null;
  dirty: boolean;
  pending: WorkflowDraftCommand | null;
  receipt: WorkflowVersionReceipt | null;
  phase:
    | "idle"
    | "editing"
    | "sending"
    | "uncertain"
    | "rejected"
    | "acknowledged"
    | "unavailable"
    | "denied";
  issues: readonly WorkflowIssue[];
  error: string;
  message: string;
  startInstant: string;
  conditionChoices: Readonly<Record<string, boolean>>;
  preview: readonly WorkflowPreviewStep[] | null;
  previewIssues: readonly WorkflowIssue[];
}>;
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Private memory protocol; validated saved versions are never changed in place. */
export class CampaignWorkflowController {
  private state: CampaignWorkflowState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readEpoch = 0;
  private writing = false;
  private revoked = false;
  private detached = false;
  private nodeSequence = 0;
  constructor(
    private readonly options: {
      binding: string;
      campaignId: string;
      client: CampaignWorkflowClient;
      online: boolean;
      canRead: boolean;
      canWrite: boolean;
      createKey(): string;
      validate(definition: WorkflowDefinition): readonly WorkflowIssue[];
      preview(
        definition: WorkflowDefinition,
        options: WorkflowPreviewOptions,
      ): readonly WorkflowPreviewStep[];
      onProtectedChange?(value: boolean): void;
      onAccessRevoked?(): void;
    },
  ) {
    this.state = freeze({
      online: options.online,
      canRead: options.canRead,
      canWrite: options.canWrite,
      page: null,
      pageStale: false,
      listError: "",
      reading: false,
      selected: null,
      draft: null,
      dirty: false,
      pending: null,
      receipt: null,
      phase: "idle",
      issues: [],
      error: "",
      message: "Choose an immutable workflow version explicitly, or start a new draft.",
      startInstant: "2026-10-10T12:00:00.000Z",
      conditionChoices: {},
      preview: null,
      previewIssues: [],
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
  private update(patch: Partial<CampaignWorkflowState>) {
    this.state = freeze({ ...this.state, ...patch });
    this.options.onProtectedChange?.(this.isProtected());
    for (const listener of this.listeners) listener();
  }
  private clear(phase: CampaignWorkflowState["phase"], message: string) {
    ++this.generation;
    ++this.readEpoch;
    this.writing = false;
    this.update({
      page: null,
      pageStale: false,
      listError: "",
      reading: false,
      selected: null,
      draft: null,
      dirty: false,
      pending: null,
      receipt: null,
      phase,
      issues: [],
      error: "",
      message,
      conditionChoices: {},
      preview: null,
      previewIssues: [],
      startInstant: "2026-10-10T12:00:00.000Z",
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.clear("idle", "Private workflow memory cleared when leaving the editor.");
  }
  revoke() {
    this.revoked = true;
    this.clear("denied", "Current workflow access changed. Private memory was cleared.");
  }
  private available() {
    return !this.revoked && !this.detached && this.state.online && !this.state.reading && !this.writing;
  }
  private mayReplace() {
    return (
      this.available() &&
      this.state.canRead &&
      !this.isProtected() &&
      !["unavailable", "denied"].includes(this.state.phase)
    );
  }
  private mayEdit() {
    return (
      this.available() &&
      this.state.canWrite &&
      this.state.phase === "editing" &&
      Boolean(this.state.draft) &&
      !this.state.pending
    );
  }
  private fail(error: unknown) {
    if (
      this.state.reading &&
      error instanceof WorkflowResponseError &&
      ["workflow_reference_unavailable", "design_unavailable", "editor_unavailable"].includes(
        error.code ?? "",
      )
    ) {
      this.clear(
        "unavailable",
        "A currently authorized workflow source is unavailable. Cached versions and private definitions were cleared.",
      );
      return true;
    }
    if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return false;
    const entitlement = error.status === 403 && error.code === "entitlement_disabled";
    const unavailable = entitlement || error.status === 404;
    if (!unavailable) this.revoked = true;
    this.clear(
      unavailable ? "unavailable" : "denied",
      entitlement
        ? "Marketing capability is unavailable or expired. Private workflow data and drafts were cleared."
        : unavailable
          ? "This workflow or its currently authorized source references are unavailable. Private memory was cleared."
          : "Current workflow access could not be verified. Private memory was cleared.",
    );
    if (!unavailable) this.options.onAccessRevoked?.();
    return true;
  }
  private verifiedDefinition(definition: WorkflowDefinition) {
    const copy = copyWorkflowJson(definition);
    if (this.options.validate(copy).length)
      throw new Error("The saved workflow definition could not be verified.");
    return copy;
  }
  setOnline(online: boolean) {
    if (online === this.state.online) return;
    if (online) {
      this.update({ online });
      return;
    }
    ++this.readEpoch;
    const protectedDraft = this.isProtected();
    this.update({
      online,
      page: null,
      pageStale: false,
      listError: "",
      selected: null,
      reading: false,
      receipt: null,
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      ...(protectedDraft
        ? {}
        : {
            draft: null,
            issues: [],
            phase: ["unavailable", "denied"].includes(this.state.phase) ? this.state.phase : "idle",
          }),
      message: protectedDraft
        ? "Offline. The original draft or command stays only in this tab. Mutations require a connection."
        : "Offline. Read workflow versions again after reconnecting.",
    });
  }
  async loadPage(cursor?: string | null): Promise<void> {
    if (!this.available() || !this.state.canRead || this.revoked || this.isProtected()) return;
    if (cursor && cursor !== this.state.page?.nextCursor) return;
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: true, listError: "" });
    try {
      const value = await this.options.client.list(cursor);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const page = requireWorkflowPage(value, this.options.campaignId);
      for (const item of page.items) this.verifiedDefinition(item.definition);
      this.update({
        page,
        pageStale: false,
        ...(this.state.phase === "unavailable"
          ? { phase: "idle" as const, message: "Current workflow read access verified by a fresh index." }
          : {}),
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          pageStale: Boolean(this.state.page),
          listError: "Workflow versions could not be refreshed. Any retained index may be stale.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: false });
    }
  }
  async select(id: string): Promise<void> {
    if (!this.mayReplace()) return;
    if (!isWorkflowId(id)) {
      this.update({ error: "Choose a verified immutable version reference." });
      return;
    }
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: true, error: "" });
    try {
      const result = await this.options.client.detail(id);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const selected = requireWorkflowVersion(result.data, this.options.campaignId, result.etag, id);
      this.verifiedDefinition(selected.data.definition);
      this.update({
        selected,
        draft: null,
        dirty: false,
        phase: "idle",
        issues: [],
        pending: null,
        preview: null,
        previewIssues: [],
        conditionChoices: {},
        error: "",
        message: `Immutable version ${selected.data.version} selected explicitly. Copy to a new draft before editing.`,
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          error: "The selected immutable workflow could not be verified. No fields were replaced.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: false });
    }
  }
  beginDraft(): boolean {
    if (!this.mayReplace() || !this.state.canWrite) return false;
    const draft: WorkflowDefinition = { nodes: [], edges: [], timezone: "UTC" };
    this.update({
      draft,
      dirty: true,
      phase: "editing",
      selected: null,
      issues: this.options.validate(draft),
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      error: "",
      message: "New local workflow draft. Add a wait or task before saving an immutable version.",
    });
    return true;
  }
  copySelected(): boolean {
    if (!this.mayReplace() || !this.state.canWrite || !this.state.selected) return false;
    const definition = this.state.selected.data.definition;
    if (!workflowLinearOrder(definition)) {
      this.update({
        message:
          "This graph remains read-only. Its condition branches or message references cannot be authored in the initial linear editor.",
      });
      return false;
    }
    const draft = copyWorkflowJson(definition);
    this.update({
      draft,
      dirty: true,
      phase: "editing",
      issues: this.options.validate(draft),
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      error: "",
      message:
        "Exact saved definition copied into a new local draft. Saving appends a version; the original stays unchanged.",
    });
    return true;
  }
  private replaceDraft(draft: WorkflowDefinition) {
    this.update({
      draft: copyWorkflowJson(draft),
      dirty: true,
      issues: this.options.validate(draft),
      error: "",
      preview: null,
      previewIssues: [],
      conditionChoices: {},
    });
  }
  add(kind: "wait" | "task"): boolean {
    if (!this.mayEdit() || !this.state.draft || this.state.draft.nodes.length >= 100) return false;
    const order = this.state.draft.nodes.length ? workflowLinearOrder(this.state.draft) : [];
    if (!order) return false;
    let key: string;
    do {
      key = `step_${++this.nodeSequence}`;
    } while (this.state.draft.nodes.some((node) => node.key === key));
    const node: Schema<"WorkflowNode"> =
      kind === "wait" ? { key, kind, delaySeconds: 0 } : { key, kind, taskTitle: "" };
    const nodes = order.map((item) => this.state.draft!.nodes.find((current) => current.key === item)!);
    this.replaceDraft(workflowLinearDefinition([...nodes, node], this.state.draft));
    return true;
  }
  move(key: string, direction: -1 | 1): boolean {
    if (!this.mayEdit() || !this.state.draft) return false;
    const order = workflowLinearOrder(this.state.draft);
    if (!order) return false;
    const index = order.indexOf(key),
      target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return false;
    const nodes = order.map((item) => this.state.draft!.nodes.find((current) => current.key === item)!);
    [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
    this.replaceDraft(workflowLinearDefinition(nodes, this.state.draft));
    return true;
  }
  remove(key: string): boolean {
    if (!this.mayEdit() || !this.state.draft) return false;
    const order = workflowLinearOrder(this.state.draft);
    if (!order || !order.includes(key)) return false;
    const nodes = order
      .filter((item) => item !== key)
      .map((item) => this.state.draft!.nodes.find((current) => current.key === item)!);
    this.replaceDraft(workflowLinearDefinition(nodes, this.state.draft));
    return true;
  }
  editNode(key: string, value: string): boolean {
    if (!this.mayEdit() || !this.state.draft) return false;
    const node = this.state.draft.nodes.find((item) => item.key === key);
    if (!node || !["wait", "task"].includes(node.kind)) return false;
    const replacement = { ...node };
    if (node.kind === "task") {
      if (Array.from(value).length > 200) {
        this.update({ error: "Task title exceeds 200 characters. Earlier fields are retained." });
        return false;
      }
      replacement.taskTitle = value;
    } else if (!value) delete replacement.delaySeconds;
    else {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        this.update({ error: "Enter a finite wait delay in seconds." });
        return false;
      }
      replacement.delaySeconds = number;
    }
    this.replaceDraft({
      ...this.state.draft,
      nodes: this.state.draft.nodes.map((item) => (item.key === key ? replacement : item)),
    });
    return true;
  }
  editTimezone(value: string): boolean {
    if (!this.mayEdit() || !this.state.draft || value.length > 80) return false;
    this.replaceDraft({ ...this.state.draft, timezone: value });
    return true;
  }
  editQuietHours(value: WorkflowDefinition["quietHours"]): boolean {
    if (!this.mayEdit() || !this.state.draft) return false;
    const draft = { ...this.state.draft };
    if (value) draft.quietHours = copyWorkflowJson(value);
    else delete draft.quietHours;
    this.replaceDraft(draft);
    return true;
  }
  discard(): boolean {
    if (this.revoked || this.detached || this.writing || this.state.pending || this.state.reading)
      return false;
    this.update({
      draft: null,
      dirty: false,
      phase: "idle",
      issues: [],
      error: "",
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      message: "Local workflow draft discarded explicitly. Saved versions stay unchanged.",
    });
    return true;
  }
  editRejected(): boolean {
    if (!this.available() || this.state.phase !== "rejected" || !this.state.pending) return false;
    this.update({
      pending: null,
      phase: "editing",
      error: "",
      message:
        "A definitively rejected first command was released explicitly. Review before creating a new key.",
    });
    return true;
  }
  setPreviewStart(value: string): boolean {
    if (!this.available() || this.state.pending || value.length > 40) return false;
    this.update({ startInstant: value, preview: null, previewIssues: [] });
    return true;
  }
  setChoice(key: string, value: boolean): boolean {
    const definition = this.state.draft ?? this.state.selected?.data.definition;
    if (
      !this.available() ||
      this.state.pending ||
      !definition?.nodes.some((node) => node.key === key && node.kind === "condition")
    )
      return false;
    this.update({
      conditionChoices: { ...this.state.conditionChoices, [key]: value },
      preview: null,
      previewIssues: [],
    });
    return true;
  }
  preview(): boolean {
    const definition = this.state.draft ?? this.state.selected?.data.definition;
    if (!this.available() || this.state.pending || !definition) return false;
    try {
      const preview = this.options.preview(
        copyWorkflowJson(definition),
        copyWorkflowJson({
          startInstant: this.state.startInstant,
          conditionChoices: this.state.conditionChoices,
        }),
      );
      this.update({ preview, previewIssues: [], error: "" });
      return true;
    } catch (error) {
      this.update({
        preview: null,
        previewIssues:
          error instanceof WorkflowValidationError
            ? error.issues
            : [
                {
                  field: "preview",
                  message:
                    "Use a valid definition, an explicit UTC ISO instant, and an explicit choice for every condition.",
                },
              ],
      });
      return false;
    }
  }
  async save(): Promise<void> {
    if (!this.available() || !this.state.canWrite || !this.state.draft) return;
    const previouslyUncertain = this.state.phase === "uncertain";
    let command = this.state.pending;
    if (!command) {
      if (this.state.phase !== "editing" || !this.state.dirty) return;
      const issues = this.options.validate(this.state.draft);
      this.update({ issues });
      if (issues.length) return;
      let key: string;
      try {
        key = this.options.createKey();
      } catch {
        this.update({ error: "An original workflow command reference could not be created." });
        return;
      }
      if (typeof key !== "string" || !key || key.length > 100) {
        this.update({ error: "An original workflow command reference could not be created." });
        return;
      }
      command = freeze({
        binding: this.options.binding,
        campaignId: this.options.campaignId,
        idempotencyKey: key,
        body: copyWorkflowJson(this.state.draft),
      });
    }
    if (command.binding !== this.options.binding || command.campaignId !== this.options.campaignId) return;
    const generation = this.generation;
    this.writing = true;
    this.update({
      pending: command,
      phase: "sending",
      error: "",
      message: "Saving an immutable draft version with the original command reference…",
    });
    try {
      const result = await this.options.client.create(copyWorkflowJson(command, 1024 * 1024));
      if (generation !== this.generation || this.revoked) return;
      const receipt = requireWorkflowVersion(result.data, command.campaignId, result.etag);
      this.verifiedDefinition(receipt.data.definition);
      if (receipt.data.state !== "draft" || !sameWorkflowDefinition(receipt.data.definition, command.body))
        throw new Error("Workflow acknowledgment does not match its immutable original definition.");
      this.writing = false;
      this.update({
        receipt,
        pending: null,
        draft: null,
        selected: null,
        dirty: false,
        phase: "acknowledged",
        issues: [],
        preview: null,
        previewIssues: [],
        conditionChoices: {},
        pageStale: Boolean(this.state.page),
        message: `Immutable draft version ${receipt.data.version} acknowledged. This may be a historical receipt; read its exact version explicitly before copying.`,
      });
    } catch (error) {
      if (generation !== this.generation || this.revoked) return;
      if (this.fail(error)) return;
      const issues = error instanceof WorkflowResponseError ? error.issues : this.state.issues;
      if (!previouslyUncertain && error instanceof ApiError && [400, 422, 429].includes(error.status))
        this.update({
          phase: "rejected",
          issues,
          error:
            "Workflow command rejected. Review prerequisites and fields, or retry the exact original request.",
        });
      else
        this.update({
          phase: "uncertain",
          issues,
          error:
            "The workflow command outcome is unknown. Its exact definition and original key stay protected; retry only that command.",
        });
    } finally {
      if (generation === this.generation) {
        this.writing = false;
        this.update({});
      }
    }
  }
}
