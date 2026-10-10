import type { components } from "../../../../packages/contracts/generated/api";
import { requireRevisionRecovery } from "../../../../packages/cms/recovery";
import {
  browserDocumentVersion,
  BrowserContentError,
  copyBrowserJson,
  inspectBrowserDraft,
  requireBrowserShape,
  type BrowserDraft,
  type BrowserIssue,
  type BrowserLinkPolicy,
  type BrowserRevision,
  type FieldBlockKind,
} from "../../../../packages/cms/browser";

type Document = components["schemas"]["Document"];
export type CmsSaveCommand = {
  documentId: string;
  body: BrowserDraft;
  ifMatch: string;
  idempotencyKey: string;
};
/** Bound by the root client to one verified session/organization; no transport or identity is invented here. */
export interface CmsDraftClient {
  saveDraft(command: CmsSaveCommand): Promise<{ data: BrowserRevision; etag: string }>;
  readDocument(): Promise<{ data: Document; etag: string }>;
}
export type CmsDraftState = {
  document: Document;
  etag: string;
  selectedRevisionId: string | null;
  draft: BrowserDraft | null;
  recovery: { revisionId: string; data: unknown } | null;
  issues: BrowserIssue[];
  dirty: boolean;
  canWrite: boolean;
  canUndo: boolean;
  canRedo: boolean;
  online: boolean;
  phase: "idle" | "editing" | "saving" | "uncertain" | "conflict" | "denied" | "saved";
  message: string;
};

function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function write(revision: BrowserRevision): BrowserDraft {
  return { schemaVersion: revision.schemaVersion, blocks: revision.blocks, seo: revision.seo };
}
type LocalEdit = { json: string; bytes: number };
const historyLimit = 50;
const historyByteLimit = 2 * 1024 * 1024;

/** In-memory only. Create a new controller for each session/org/document binding and revoke the old one. */
export class CmsDraftController {
  private state: CmsDraftState;
  private readonly listeners = new Set<() => void>();
  private baseline: BrowserDraft | null = null;
  private pending: CmsSaveCommand | null = null;
  private inFlight: Promise<void> | null = null;
  private generation = 0;
  private refreshing = false;
  private readonly past: LocalEdit[] = [];
  private readonly future: LocalEdit[] = [];
  private readonly policy: BrowserLinkPolicy;

  constructor(
    private readonly options: {
      document: Document;
      etag: string;
      client: CmsDraftClient;
      policy: BrowserLinkPolicy;
      online: boolean;
      canWrite: boolean;
      createKey: () => string;
    },
  ) {
    const document = requireBrowserShape("Document", options.document);
    if (browserDocumentVersion(options.etag) !== document.version || !Number.isSafeInteger(document.version))
      throw new Error("Document response version does not match its ETag.");
    this.policy = { approvedLinkOrigins: new Set(options.policy.approvedLinkOrigins) };
    this.state = frozen({
      document,
      etag: options.etag,
      selectedRevisionId: null,
      draft: null,
      recovery: null,
      issues: [],
      dirty: false,
      canWrite: options.canWrite,
      canUndo: false,
      canRedo: false,
      online: options.online,
      phase: "idle",
      message: "Select a revision or start a new draft.",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<CmsDraftState>) {
    const next = { ...this.state, ...patch };
    this.state = frozen({
      ...next,
      canUndo: this.past.length > 0 && this.canEditState(next),
      canRedo: this.future.length > 0 && this.canEditState(next),
    });
    for (const listener of this.listeners) listener();
  }
  private canReplace() {
    return !this.state.dirty && !this.pending && !this.refreshing && this.state.phase !== "denied";
  }
  private canEditState(state: CmsDraftState) {
    return (
      Boolean(state.draft) &&
      state.canWrite &&
      !this.pending &&
      !this.refreshing &&
      !["conflict", "denied"].includes(state.phase)
    );
  }
  canEdit() {
    return this.canEditState(this.state);
  }
  private clearHistory() {
    this.past.length = 0;
    this.future.length = 0;
  }
  private captureEdit(): LocalEdit {
    const json = JSON.stringify(this.state.draft);
    return { json, bytes: new TextEncoder().encode(json).byteLength };
  }
  private boundHistory() {
    let bytes = [...this.past, ...this.future].reduce((sum, edit) => sum + edit.bytes, 0);
    while (this.past.length + this.future.length > historyLimit || bytes > historyByteLimit) {
      // Retain the nearest undo/redo steps and discard only the oldest/farthest local snapshots.
      const oldest = this.past.length ? this.past.shift()! : this.future.shift()!;
      bytes -= oldest.bytes;
    }
  }
  private isDirty(draft: BrowserDraft) {
    return this.baseline === null || canonical(draft) !== canonical(this.baseline);
  }
  private restoreEdit(from: LocalEdit[], to: LocalEdit[], message: string): boolean {
    if (!this.canEdit() || !from.length) return false;
    const previous = from.pop()!;
    const inspection = inspectBrowserDraft(JSON.parse(previous.json), this.policy);
    to.push(this.captureEdit());
    this.boundHistory();
    const draft = inspection.data as BrowserDraft;
    this.update({ draft, issues: inspection.issues, dirty: this.isDirty(draft), phase: "editing", message });
    return true;
  }
  undo(): boolean {
    return this.restoreEdit(this.past, this.future, "Last local edit undone.");
  }
  redo(): boolean {
    return this.restoreEdit(this.future, this.past, "Local edit restored.");
  }
  /** Strict local projection only; invalid/unknown content never gets a partial preview. */
  previewDraft(): BrowserDraft | null {
    if (!this.state.draft || this.state.recovery || this.state.phase === "denied") return null;
    const inspection = inspectBrowserDraft(this.state.draft, this.policy);
    return inspection.issues.length ? null : (inspection.data as BrowserDraft);
  }
  setOnline(online: boolean) {
    if (!online && this.state.recovery) {
      this.update({
        online,
        recovery: null,
        selectedRevisionId: null,
        issues: [],
        phase: "idle",
        message: "Recovery cleared while offline. Reconnect and read the original revision again.",
      });
      return;
    }
    this.update({ online });
  }

  /** UUID order and document publication pointers never select an editor revision implicitly. */
  selectRevision(value: BrowserRevision): boolean {
    if (!this.canReplace()) return false;
    const revision = requireBrowserShape("Revision", value);
    if (revision.documentId !== this.state.document.id)
      throw new Error("Revision belongs to another document.");
    const inspection = inspectBrowserDraft(write(revision), this.policy);
    if (inspection.issues.length) return this.openRecovery(revision.id, revision.documentId, inspection.data);
    this.baseline = copyBrowserJson(inspection.data as BrowserDraft);
    this.clearHistory();
    this.update({
      selectedRevisionId: revision.id,
      draft: copyBrowserJson(this.baseline),
      recovery: null,
      issues: [],
      dirty: false,
      phase: "editing",
      message: "Selected revision loaded. Saving creates a new draft revision.",
    });
    return true;
  }
  /** Already-authorized original JSON is injected here; no proposed recovery HTTP fetch exists. */
  openRecovery(revisionId: string, documentId: string, value: unknown): boolean {
    if (!this.canReplace() || !this.state.online) return false;
    if (documentId !== this.state.document.id) throw new Error("Recovery belongs to another document.");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(revisionId))
      throw new Error("A valid revision identity is required.");
    const inspection = inspectBrowserDraft(value, this.policy);
    this.baseline = null;
    this.clearHistory();
    this.update({
      selectedRevisionId: revisionId,
      draft: null,
      recovery: { revisionId, data: inspection.data },
      issues: inspection.issues,
      dirty: false,
      phase: "idle",
      message: "Read-only recovery. Original JSON is preserved.",
    });
    return true;
  }
  /** Root injects the response of an authorized explicit-ID read; discovery/transport are separate. */
  openRecoveryResponse(revisionId: string, value: unknown): boolean {
    if (!this.canReplace() || !this.state.online) return false;
    const response = requireRevisionRecovery(value);
    if (response.id !== revisionId)
      throw new Error("Recovery response does not match the requested revision.");
    if (!this.openRecovery(response.id, response.documentId, response.data)) return false;
    this.update({ issues: [...response.issues, ...this.state.issues] });
    return true;
  }
  startBlank(): boolean {
    if (!this.canReplace() || this.state.recovery || !this.state.canWrite) return false;
    this.baseline = null;
    this.clearHistory();
    this.update({
      selectedRevisionId: null,
      draft: { schemaVersion: 1, blocks: [], seo: { title: "", description: "", noindex: true } },
      issues: [],
      dirty: true,
      phase: "editing",
      message: "New unsaved draft.",
    });
    return true;
  }
  edit(change: (draft: BrowserDraft) => void): boolean {
    if (!this.canEdit()) return false;
    const draft = copyBrowserJson(this.state.draft!);
    change(draft);
    let inspection;
    try {
      inspection = inspectBrowserDraft(draft, this.policy);
    } catch (error) {
      if (!(error instanceof BrowserContentError)) throw error;
      this.update({
        message: "That change exceeds the supported content limits. Your previous draft is retained.",
      });
      return false;
    }
    const next = inspection.data as BrowserDraft;
    if (canonical(next) === canonical(this.state.draft)) return false;
    this.past.push(this.captureEdit());
    this.future.length = 0;
    this.boundHistory();
    const dirty = this.isDirty(next);
    this.update({
      draft: next,
      issues: inspection.issues,
      dirty,
      phase: "editing",
      message: dirty ? "Unsaved changes." : "Draft matches the loaded revision.",
    });
    return true;
  }
  addBlock(kind: FieldBlockKind, id: string): boolean {
    if ((this.state.draft?.blocks.length ?? 200) >= 200) return false;
    const defaults = {
      hero: { heading: "New heading" },
      text: { paragraphs: [""] },
      cta: { label: "Contact us", href: "/contact" },
      footer: { text: "", links: [] },
    };
    return this.edit((draft) => {
      draft.blocks.push({ id, type: kind, props: defaults[kind] });
    });
  }
  moveBlock(id: string, direction: -1 | 1): boolean {
    const index = this.state.draft?.blocks.findIndex((block) => block.id === id) ?? -1;
    const target = index + direction;
    if (index < 0 || target < 0 || target >= this.state.draft!.blocks.length) return false;
    return this.edit((draft) => {
      const [block] = draft.blocks.splice(index, 1);
      draft.blocks.splice(target, 0, block);
    });
  }
  discardChanges(): boolean {
    if (this.pending || this.refreshing || this.state.phase === "denied" || this.state.recovery) return false;
    this.clearHistory();
    this.update({
      draft: copyBrowserJson(this.baseline),
      dirty: false,
      issues: [],
      phase: this.baseline ? "editing" : "idle",
      message: "Unsaved changes discarded.",
    });
    return true;
  }

  save(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.state.online || this.state.phase === "denied" || this.refreshing) return Promise.resolve();
    if (!this.pending) {
      if (!this.canEdit() || !this.state.dirty) return Promise.resolve();
      const inspection = inspectBrowserDraft(this.state.draft, this.policy);
      if (inspection.issues.length) {
        this.update({ issues: inspection.issues, message: "Resolve the listed fields before saving." });
        return Promise.resolve();
      }
      if (browserDocumentVersion(this.state.etag) === Number.MAX_SAFE_INTEGER) {
        this.update({ message: "The document version cannot advance. Contact support." });
        return Promise.resolve();
      }
      const key = this.options.createKey();
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) throw new Error("A valid command key is required.");
      this.pending = frozen({
        documentId: this.state.document.id,
        body: inspection.data as BrowserDraft,
        ifMatch: this.state.etag,
        idempotencyKey: key,
      });
    }
    const command = this.pending;
    const generation = this.generation;
    this.inFlight = Promise.resolve()
      .then(() => this.attempt(command, generation))
      .finally(() => {
        this.inFlight = null;
      });
    this.update({ phase: "saving", message: "Saving draft…" });
    return this.inFlight;
  }
  private async attempt(command: CmsSaveCommand, generation: number) {
    try {
      if (generation !== this.generation) return;
      const response = await this.options.client.saveDraft(copyBrowserJson(command));
      if (generation !== this.generation) return;
      const revision = requireBrowserShape("Revision", response.data);
      const version = browserDocumentVersion(response.etag);
      if (
        revision.documentId !== command.documentId ||
        version !== browserDocumentVersion(command.ifMatch) + 1 ||
        canonical(write(revision)) !== canonical(command.body)
      )
        throw new Error("Save receipt is invalid.");
      this.pending = null;
      this.baseline = copyBrowserJson(write(revision));
      this.clearHistory();
      this.update({
        document: { ...this.state.document, version },
        etag: response.etag,
        selectedRevisionId: revision.id,
        draft: copyBrowserJson(this.baseline),
        dirty: false,
        issues: [],
        phase: "saved",
        message: "Draft revision saved.",
      });
    } catch (error) {
      if (generation !== this.generation) return;
      const status = (error as { status?: unknown } | null)?.status;
      if ([401, 403, 404].includes(status as number)) {
        this.revoke();
        return;
      }
      if (status === 412) {
        this.pending = null;
        this.update({
          phase: "conflict",
          message:
            "The document changed. Your unsaved draft is preserved. Read the current version before saving again.",
        });
      } else if ([400, 409, 413, 415, 422, 429].includes(status as number)) {
        this.pending = null;
        this.update({
          phase: "editing",
          message: "The server rejected this save. Your draft is preserved; review it before trying again.",
        });
      } else {
        this.update({
          phase: "uncertain",
          message: "Save outcome is unknown. Retry the same save to reconcile it.",
        });
      }
    }
  }
  /** Explicit conflict recovery preserves local content; it never loads or selects another revision. */
  async refreshVersion(): Promise<void> {
    if (this.pending || this.refreshing || !this.state.online || this.state.phase !== "conflict") return;
    const generation = this.generation;
    this.refreshing = true;
    this.update({ message: "Reading the current document version…" });
    try {
      const response = await this.options.client.readDocument();
      if (generation !== this.generation) return;
      const document = requireBrowserShape("Document", response.data);
      if (
        document.id !== this.state.document.id ||
        document.siteId !== this.state.document.siteId ||
        browserDocumentVersion(response.etag) !== document.version ||
        document.version < this.state.document.version
      )
        throw new Error("Document response is invalid.");
      this.update({
        document,
        etag: response.etag,
        phase: "editing",
        message: "Current version loaded. Review your preserved draft, then save when ready.",
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if ([401, 403, 404].includes((error as { status?: number } | null)?.status ?? 0)) this.revoke();
      else
        this.update({ message: "The current version could not be read. Your unsaved draft is preserved." });
    } finally {
      this.refreshing = false;
      if (generation === this.generation) this.update({});
    }
  }
  /** Root calls this before rebinding tenant/session; late responses cannot repopulate private content. */
  revoke() {
    ++this.generation;
    this.pending = null;
    this.baseline = null;
    this.clearHistory();
    this.update({
      selectedRevisionId: null,
      draft: null,
      recovery: null,
      issues: [],
      dirty: false,
      phase: "denied",
      message: "CMS access is unavailable. Return to the workspace to refresh access.",
    });
  }
}
