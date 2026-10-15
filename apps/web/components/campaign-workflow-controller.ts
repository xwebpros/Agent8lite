import type {
  WorkflowIssue,
  WorkflowPreviewOptions,
  WorkflowPreviewStep,
} from "../../../packages/marketing/types";
import { WorkflowValidationError } from "../../../packages/marketing";
import { ApiError, type Schema } from "../lib/api";
import { requireWorkflowDesign } from "./campaign-workflow-design-catalogue";
import type { MessageDesignReceipt } from "./message-design-protocol";
import {
  copyWorkflowJson,
  isWorkflowId,
  requireWorkflowPage,
  requireWorkflowVersion,
  sameWorkflowDefinition,
  WorkflowResponseError,
  type WorkflowDefinition,
  type WorkflowDraftCommand,
  type WorkflowVersionReceipt,
} from "./campaign-workflow-protocol";
import {
  definitionOutline,
  findItem,
  maxConditionDepth,
  outlineDefinition,
  outlineInsert,
  outlineIssues,
  outlineMove,
  outlineNodes,
  outlineRemove,
  outlineReplaceNode,
  outlineTargetDepth,
  type Outline,
  type OutlineTarget,
} from "./campaign-workflow-outline";

type LeadFilter = Schema<"LeadFilter">;
export type ConditionField = keyof LeadFilter;

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
  /** Structured source of the draft; the draft is always its serialization. */
  outline: Outline | null;
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
  private readonly unavailableDesigns = new Map<string, string>();
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
      outline: null,
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
    this.unavailableDesigns.clear();
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
      outline: null,
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
  sourceAccessLost(error: ApiError) {
    this.fail(error);
  }
  private draftIssues(
    definition: WorkflowDefinition,
    outline: Outline | null = this.state.outline,
  ): readonly WorkflowIssue[] {
    return [
      ...(outline ? outlineIssues(outline) : []),
      ...this.options.validate(definition),
      ...definition.nodes.flatMap((node, index) =>
        node.messageDesignId && this.unavailableDesigns.get(node.key) === node.messageDesignId
          ? [
              {
                field: `nodes.${index}.messageDesignId`,
                message: "This current native design is unavailable. Choose an authorized design explicitly.",
              },
            ]
          : [],
      ),
    ];
  }
  designUnavailable(nodeKey: string, id: string) {
    const node = this.state.draft?.nodes.find((item) => item.key === nodeKey);
    if (!node || node.messageDesignId !== id || this.revoked || this.detached) return;
    this.unavailableDesigns.set(nodeKey, id);
    this.update({ issues: this.draftIssues(this.state.draft!) });
  }
  chooseDesign(nodeKey: string, receipt: MessageDesignReceipt): boolean {
    if (!this.mayEdit() || !this.state.outline) return false;
    const node = findItem(this.state.outline, nodeKey)?.node;
    if (!node || (node.kind !== "email" && node.kind !== "sms")) return false;
    try {
      const verified = requireWorkflowDesign(receipt.data, receipt.etag, receipt.data.id, node.kind);
      this.unavailableDesigns.delete(nodeKey);
      const outline = outlineReplaceNode(this.state.outline, {
        key: node.key,
        kind: node.kind,
        messageDesignId: verified.data.id,
      });
      if (!outline) return false;
      this.replaceOutline(outline);
      return true;
    } catch {
      this.update({ error: "Choose a current authorized native design for this step's channel." });
      return false;
    }
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
            outline: null,
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
        outline: null,
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
    this.unavailableDesigns.clear();
    this.update({
      draft,
      outline: [],
      dirty: true,
      phase: "editing",
      selected: null,
      issues: this.options.validate(draft),
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      error: "",
      message:
        "New local workflow draft. Add a wait, task, condition, or authorized message reference before saving.",
    });
    return true;
  }
  copySelected(): boolean {
    if (!this.mayReplace() || !this.state.canWrite || !this.state.selected) return false;
    const definition = copyWorkflowJson(this.state.selected.data.definition);
    const outline = definitionOutline(definition);
    if (!outline) {
      this.update({
        message:
          "This graph remains read-only. Its branches or joins cannot be represented in the structured editor without changing it.",
      });
      return false;
    }
    this.unavailableDesigns.clear();
    this.update({
      draft: definition,
      outline,
      dirty: true,
      phase: "editing",
      issues: this.draftIssues(definition, outline),
      preview: null,
      previewIssues: [],
      conditionChoices: {},
      error: "",
      message:
        "Exact saved definition copied into a new local draft. Saving appends a version; the original stays unchanged.",
    });
    return true;
  }
  private replaceOutline(outline: Outline) {
    const draft = copyWorkflowJson(outlineDefinition(outline, this.state.draft!));
    this.update({
      draft,
      outline,
      dirty: true,
      issues: this.draftIssues(draft, outline),
      error: "",
      preview: null,
      previewIssues: [],
      conditionChoices: {},
    });
  }
  private replaceDefinitionMetadata(draft: WorkflowDefinition) {
    this.update({
      draft: copyWorkflowJson(draft),
      dirty: true,
      issues: this.draftIssues(draft),
      error: "",
      preview: null,
      previewIssues: [],
      conditionChoices: {},
    });
  }
  add(
    kind: "wait" | "task" | "email" | "sms" | "condition",
    target: OutlineTarget = { parent: null },
  ): boolean {
    if (!["wait", "task", "email", "sms", "condition"].includes(kind)) return false;
    const outline = this.state.outline;
    if (!this.mayEdit() || !outline || outlineNodes(outline).length >= 100) return false;
    const depth = outlineTargetDepth(outline, target);
    if (depth === null) return false;
    if (kind === "condition" && depth + 1 > maxConditionDepth) {
      this.update({ error: "Conditions can be nested at most three levels deep." });
      return false;
    }
    let key: string;
    do {
      key = `step_${++this.nodeSequence}`;
    } while (findItem(outline, key));
    const node: Schema<"WorkflowNode"> =
      kind === "wait"
        ? { key, kind, delaySeconds: 0 }
        : kind === "task"
          ? { key, kind, taskTitle: "" }
          : kind === "condition"
            ? { key, kind, condition: {} }
            : { key, kind };
    const next = outlineInsert(outline, target, node);
    if (!next) return false;
    this.replaceOutline(next);
    return true;
  }
  move(key: string, direction: -1 | 1): boolean {
    if (!this.mayEdit() || !this.state.outline) return false;
    const next = outlineMove(this.state.outline, key, direction);
    if (!next) return false;
    this.replaceOutline(next);
    return true;
  }
  remove(key: string): boolean {
    if (!this.mayEdit() || !this.state.outline) return false;
    const item = findItem(this.state.outline, key);
    if (item?.type === "condition" && (item.whenTrue.length || item.whenFalse.length)) {
      this.update({ error: "Remove or move the steps in both branches before removing this condition." });
      return false;
    }
    const next = outlineRemove(this.state.outline, key);
    if (!next) return false;
    this.unavailableDesigns.delete(key);
    this.replaceOutline(next);
    return true;
  }
  editNode(key: string, value: string): boolean {
    if (!this.mayEdit() || !this.state.outline) return false;
    const node = findItem(this.state.outline, key)?.node;
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
    const next = outlineReplaceNode(this.state.outline, replacement);
    if (!next) return false;
    this.replaceOutline(next);
    return true;
  }
  /** Set or clear one allowlisted lead-filter predicate; an empty value removes it. */
  editCondition(key: string, field: ConditionField, value: string | readonly string[] | null): boolean {
    if (!this.mayEdit() || !this.state.outline) return false;
    const node = findItem(this.state.outline, key)?.node;
    if (!node || node.kind !== "condition") return false;
    const condition: LeadFilter = { ...(node.condition ?? {}) };
    const empty = value === null || value === "" || (Array.isArray(value) && !value.length);
    if (field === "tagIds") {
      if (!empty && (!Array.isArray(value) || value.length > 20)) {
        this.update({ error: "Choose at most 20 tags for one condition." });
        return false;
      }
      if (empty) delete condition.tagIds;
      else condition.tagIds = [...(value as readonly string[])];
    } else if (field === "q") {
      if (typeof value === "string" && Array.from(value).length > 200) {
        this.update({ error: "Name text exceeds 200 characters. Earlier fields are retained." });
        return false;
      }
      if (empty) delete condition.q;
      else if (typeof value === "string") condition.q = value;
      else return false;
    } else if (field === "intent") {
      if (empty) delete condition.intent;
      else if (value === "buyer" || value === "seller" || value === "both" || value === "unknown")
        condition.intent = value;
      else return false;
    } else if (field === "stageId" || field === "sourceId" || field === "ownerMemberId") {
      if (empty) delete condition[field];
      else if (typeof value === "string") condition[field] = value;
      else return false;
    } else return false;
    const next = outlineReplaceNode(this.state.outline, { key: node.key, kind: "condition", condition });
    if (!next) return false;
    this.replaceOutline(next);
    return true;
  }
  editTimezone(value: string): boolean {
    if (!this.mayEdit() || !this.state.draft || value.length > 80) return false;
    this.replaceDefinitionMetadata({ ...this.state.draft, timezone: value });
    return true;
  }
  editQuietHours(value: WorkflowDefinition["quietHours"]): boolean {
    if (!this.mayEdit() || !this.state.draft) return false;
    const draft = { ...this.state.draft };
    if (value) draft.quietHours = copyWorkflowJson(value);
    else delete draft.quietHours;
    this.replaceDefinitionMetadata(draft);
    return true;
  }
  discard(): boolean {
    if (this.revoked || this.detached || this.writing || this.state.pending || this.state.reading)
      return false;
    this.unavailableDesigns.clear();
    this.update({
      draft: null,
      outline: null,
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
      const issues = this.draftIssues(this.state.draft);
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
        outline: null,
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
