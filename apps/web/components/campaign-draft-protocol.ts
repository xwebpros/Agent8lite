import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

type Campaign = Schema<"Campaign">;
type CampaignWrite = Schema<"CampaignWrite">;
type PageCampaign = Schema<"PageCampaign">;
export type CampaignReceipt = Readonly<{ data: Campaign; etag: string }>;
export type CampaignDraftCommand = Readonly<{
  binding: string;
  kind: "create" | "update";
  campaignId: string | null;
  idempotencyKey: string;
  ifMatch: string | null;
  body: CampaignWrite;
}>;
export interface CampaignDraftClient {
  list(cursor?: string | null): Promise<unknown>;
  detail(id: string): Promise<{ data: unknown; etag: string }>;
  submit(command: CampaignDraftCommand): Promise<{ data: unknown; etag: string }>;
}
export type CampaignDraftState = Readonly<{
  online: boolean;
  canRead: boolean;
  canWrite: boolean;
  page: PageCampaign | null;
  pageStale: boolean;
  listError: string;
  reading: "list" | "detail" | "conflict" | null;
  selected: CampaignReceipt | null;
  mode: "idle" | "create" | "edit";
  input: CampaignWrite | null;
  dirty: boolean;
  phase:
    | "idle"
    | "editing"
    | "sending"
    | "uncertain"
    | "rejected"
    | "conflict"
    | "acknowledged"
    | "unavailable"
    | "denied";
  pending: CampaignDraftCommand | null;
  conflictCurrent: CampaignReceipt | null;
  receipt: CampaignReceipt | null;
  error: string;
  message: string;
}>;

const byteLimit = 64 * 1024;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:campaign-draft-browser",
  components: {
    schemas: { Campaign: contract.components.schemas.Campaign },
  },
});
const validateCampaign = ajv.compile<Campaign>(contract.components.schemas.Campaign);
const validateWrite = ajv.compile<CampaignWrite>(contract.components.schemas.CampaignWrite);
const validatePage = ajv.compile<PageCampaign>({
  ...contract.components.schemas.PageCampaign,
  $id: "estate:campaign-draft-page",
  properties: {
    ...contract.components.schemas.PageCampaign.properties,
    items: {
      ...contract.components.schemas.PageCampaign.properties.items,
      items: { $ref: "estate:campaign-draft-browser#/components/schemas/Campaign" },
    },
  },
});
const validateCode = ajv.compile(contract.components.schemas.Problem.properties.code);
const validateId = ajv.compile(contract.components.schemas.Campaign.properties.id);

/** No accessors, prototypes, cycles, sparse arrays or unbounded private response objects. */
function campaignJson(value: unknown): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const inspect = (item: unknown, depth: number): unknown => {
    if (++nodes > 5000 || depth > 12) throw new Error();
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error();
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new Error();
    const keys = Reflect.ownKeys(item);
    if (array && (item.length > 5000 || keys.length !== item.length + 1)) throw new Error();
    const clone = array ? Object.setPrototypeOf(new Array(item.length), null) : Object.create(null);
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
      Object.defineProperty(clone, key, {
        value: inspect(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    ancestors.delete(item);
    return clone;
  };
  try {
    const json = JSON.stringify(inspect(value, 0));
    if (!json || new TextEncoder().encode(json).byteLength > byteLimit) throw new Error();
    return json;
  } catch {
    throw new Error("Campaign data could not be verified within its private memory limits.");
  }
}
function copyJson<T>(value: T): T {
  return JSON.parse(campaignJson(value)) as T;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameInput(left: CampaignWrite, right: CampaignWrite): boolean {
  return left.name === right.name && left.category === right.category;
}

export function campaignVersion(etag: string | null): number {
  const match = etag && etag.length <= 100 ? /^"([1-9][0-9]*)"$/.exec(etag) : null;
  const version = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("A strong campaign revision is required.");
  return version;
}
export function requireCampaignWrite(value: unknown): CampaignWrite {
  const input = copyJson(value);
  if (!validateWrite(input) || !input.name.trim() || !input.category.trim())
    throw new Error(
      "Enter a nonblank campaign name (up to 120 characters) and category (up to 80 characters).",
    );
  return freeze({ name: input.name.trim(), category: input.category.trim() });
}
/** Detached descriptors prevent inherited serialization hooks from changing submitted fields. */
export function campaignWriteJson(value: unknown): string {
  return campaignJson(requireCampaignWrite(value));
}
export function requireCampaign(value: unknown): Campaign {
  const campaign = copyJson(value);
  if (!validateCampaign(campaign) || !Number.isSafeInteger(campaign.version) || campaign.state !== "draft")
    throw new Error("Only a verified campaign draft can be read in this workspace.");
  return freeze(campaign);
}
export function requireCampaignReceipt(value: unknown, etag: string, expectedId?: string): CampaignReceipt {
  const data = requireCampaign(value);
  if (campaignVersion(etag) !== data.version || (expectedId && data.id !== expectedId))
    throw new Error("The campaign identity or revision could not be verified.");
  return freeze({ data, etag });
}
export function requireCampaignPage(value: unknown): PageCampaign {
  const page = copyJson(value);
  if (
    !validatePage(page) ||
    (page.hasMore ? !page.nextCursor || page.items.length === 0 : page.nextCursor !== null)
  )
    throw new Error("The campaign draft page or its cursor could not be verified.");
  const ids = new Set<string>();
  for (const item of page.items) {
    requireCampaign(item);
    const identity = item.id.toLowerCase();
    if (ids.has(identity)) throw new Error("The campaign draft page contains a repeated identity.");
    ids.add(identity);
  }
  return freeze(page);
}

/** Limit actual streamed UTF-8, including whitespace, before parsing a private frozen response. */
export async function readCampaignJsonResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const problem = () =>
    new ApiError(response.status, "Campaign drafts could not be read. Verify current access or try again.");
  if (!reader) {
    if (!response.ok) throw problem();
    throw new Error("The campaign response is unavailable.");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > byteLimit) {
        await reader.cancel();
        throw new Error("Campaign transport exceeds its 64 KiB limit.");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (!response.ok) throw problem();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    if (!response.ok) throw problem();
    throw new Error("Campaign transport is not valid UTF-8 JSON.");
  }
  if (!response.ok) {
    const code =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "code") &&
      "code" in value &&
      typeof value.code === "string" &&
      validateCode(value.code)
        ? value.code
        : undefined;
    throw new ApiError(response.status, problem().message, code);
  }
  return value;
}

export class CampaignDraftController {
  private state: CampaignDraftState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private readEpoch = 0;
  private writeInFlight = false;
  private revoked = false;
  private detached = false;
  constructor(
    private readonly options: {
      binding: string;
      client: CampaignDraftClient;
      online: boolean;
      canRead: boolean;
      canWrite: boolean;
      createKey(): string;
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
      reading: null,
      selected: null,
      mode: "idle",
      input: null,
      dirty: false,
      phase: "idle",
      pending: null,
      conflictCurrent: null,
      receipt: null,
      error: "",
      message: "Choose a draft explicitly or create new draft metadata.",
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  isProtected = () => this.state.dirty || Boolean(this.state.pending) || this.writeInFlight;
  private update(patch: Partial<CampaignDraftState>) {
    this.state = freeze({ ...this.state, ...patch });
    this.options.onProtectedChange?.(this.isProtected());
    for (const listener of this.listeners) listener();
  }
  private mayRead() {
    return (
      !this.revoked &&
      !this.detached &&
      this.state.phase !== "denied" &&
      this.state.online &&
      this.state.canRead &&
      !this.state.reading &&
      !this.writeInFlight
    );
  }
  private mayReplace() {
    return (
      !this.isProtected() &&
      !this.state.reading &&
      !this.revoked &&
      !this.detached &&
      this.state.canRead &&
      !["unavailable", "denied"].includes(this.state.phase)
    );
  }
  private clear(phase: "idle" | "unavailable" | "denied", message: string) {
    ++this.generation;
    ++this.readEpoch;
    this.writeInFlight = false;
    this.update({
      page: null,
      pageStale: false,
      listError: "",
      reading: null,
      selected: null,
      mode: "idle",
      input: null,
      dirty: false,
      phase,
      pending: null,
      conflictCurrent: null,
      receipt: null,
      error: "",
      message,
    });
  }
  revoke() {
    this.revoked = true;
    this.clear("denied", "Campaign access changed. Private draft memory was cleared.");
  }
  /** Effect teardown invalidates late responses; Strict Mode setup can attach this cleared lifetime again. */
  detach() {
    this.detached = true;
    this.clear("idle", "Private campaign memory cleared when leaving this workspace.");
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  private fail(error: unknown): boolean {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      const entitlementUnavailable = error.status === 403 && error.code === "entitlement_disabled";
      const unavailable = entitlementUnavailable || error.status === 404;
      if (!unavailable) this.revoked = true;
      this.clear(
        unavailable ? "unavailable" : "denied",
        entitlementUnavailable
          ? "Marketing capability is unavailable or expired. Private campaign data and local drafts were cleared."
          : error.status === 404
            ? "This campaign resource is unavailable. Private draft memory was cleared."
            : "Current campaign access could not be verified. Private draft memory was cleared.",
      );
      if (!unavailable) this.options.onAccessRevoked?.();
      return true;
    }
    return false;
  }
  setOnline(online: boolean) {
    if (this.state.online === online) return;
    if (!online) {
      ++this.readEpoch;
      const keepDraft = this.isProtected();
      this.update({
        online,
        page: null,
        pageStale: false,
        listError: "",
        reading: null,
        ...(keepDraft
          ? {}
          : {
              selected: null,
              input: null,
              mode: "idle" as const,
              ...(["unavailable", "denied"].includes(this.state.phase) ? {} : { phase: "idle" as const }),
            }),
        conflictCurrent: null,
        receipt: null,
        message: keepDraft
          ? "Offline. The original local draft or command stays only in this tab; mutations require a connection."
          : "Offline. Read campaign drafts again after reconnecting.",
      });
    } else this.update({ online });
  }
  async loadPage(cursor?: string | null): Promise<void> {
    if (!this.mayRead() || this.isProtected()) return;
    if (cursor && cursor !== this.state.page?.nextCursor) return;
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "list", listError: "" });
    try {
      const value = await this.options.client.list(cursor);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const page = requireCampaignPage(value);
      // Keep a single bounded page; UUID ordering is a live index, never a latest-version inference.
      this.update({
        page,
        pageStale: false,
        ...(this.state.phase === "unavailable"
          ? {
              phase: "idle" as const,
              message: "Current campaign access verified by a fresh draft page read.",
            }
          : {}),
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          pageStale: Boolean(this.state.page),
          listError: "Campaign drafts could not be refreshed. Any retained page may be stale.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  async select(id: string): Promise<void> {
    if (!this.mayRead() || !this.mayReplace()) return;
    if (!validateId(id)) {
      this.update({ error: "Choose a verified campaign reference before reading its current draft." });
      return;
    }
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "detail", error: "" });
    try {
      const result = await this.options.client.detail(id);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const selected = requireCampaignReceipt(result.data, result.etag, id);
      this.update({
        selected,
        input: { name: selected.data.name, category: selected.data.category },
        dirty: false,
        mode: "edit",
        phase: "editing",
        pending: null,
        conflictCurrent: null,
        error: "",
        message: `Current draft metadata read at version ${selected.data.version}.`,
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({ error: "The current draft could not be verified. No editor fields were replaced." });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  beginCreate(): boolean {
    if (!this.mayReplace() || !this.state.canWrite || !this.state.online) return false;
    this.update({
      mode: "create",
      selected: null,
      input: { name: "", category: "" },
      dirty: false,
      phase: "editing",
      conflictCurrent: null,
      error: "",
      message: "Enter new draft metadata. This creates no workflow or enrollment.",
    });
    return true;
  }
  edit(field: keyof CampaignWrite, value: string): boolean {
    if (
      this.revoked ||
      this.detached ||
      !this.state.canWrite ||
      !this.state.online ||
      this.state.reading ||
      this.state.pending ||
      !this.state.input ||
      this.state.phase !== "editing"
    )
      return false;
    if ((field !== "name" && field !== "category") || typeof value !== "string") return false;
    if (Array.from(value).length > (field === "name" ? 120 : 80)) {
      this.update({
        error: `The campaign ${field} exceeds its ${field === "name" ? 120 : 80} character limit. Your earlier fields are retained.`,
      });
      return false;
    }
    const input = { ...this.state.input, [field]: value };
    const baseline = this.state.selected?.data;
    const dirty =
      this.state.mode === "create"
        ? Boolean(input.name || input.category)
        : Boolean(baseline && !sameInput(input, baseline));
    this.update({ input, dirty, error: "" });
    return true;
  }
  discard(): boolean {
    if (this.writeInFlight || this.state.pending || this.revoked || this.detached) return false;
    this.update({
      input: this.state.selected
        ? { name: this.state.selected.data.name, category: this.state.selected.data.category }
        : null,
      mode: this.state.selected ? "edit" : "idle",
      dirty: false,
      phase: this.state.selected ? "editing" : "idle",
      error: "",
      message: "Unsaved metadata changes discarded explicitly.",
    });
    return true;
  }
  async save(): Promise<void> {
    if (
      this.revoked ||
      this.detached ||
      !this.state.online ||
      !this.state.canWrite ||
      this.state.reading ||
      this.writeInFlight ||
      !this.state.input
    )
      return;
    if (this.state.phase === "conflict") return;
    const previouslyUncertain = this.state.phase === "uncertain";
    let command = this.state.pending;
    if (!command) {
      if (this.state.phase !== "editing" || !this.state.dirty) return;
      let body: CampaignWrite;
      try {
        body = requireCampaignWrite(this.state.input);
      } catch (error) {
        this.update({ error: (error as Error).message });
        return;
      }
      if (this.state.mode === "edit" && this.state.selected && sameInput(body, this.state.selected.data)) {
        this.update({
          input: body,
          dirty: false,
          message: "Metadata is unchanged after trimming. No update was sent.",
        });
        return;
      }
      let idempotencyKey: string;
      try {
        idempotencyKey = this.options.createKey();
      } catch {
        this.update({ error: "An original command reference could not be created." });
        return;
      }
      if (typeof idempotencyKey !== "string" || !idempotencyKey || idempotencyKey.length > 100) {
        this.update({ error: "An original command reference could not be created." });
        return;
      }
      if (
        this.state.mode === "edit" &&
        (!this.state.selected || this.state.selected.data.version >= Number.MAX_SAFE_INTEGER)
      ) {
        this.update({ error: "Read a supported current revision before updating this draft." });
        return;
      }
      command = freeze({
        binding: this.options.binding,
        kind: this.state.mode === "create" ? "create" : "update",
        campaignId: this.state.mode === "edit" ? this.state.selected!.data.id : null,
        ifMatch: this.state.mode === "edit" ? this.state.selected!.etag : null,
        idempotencyKey,
        body,
      });
    }
    if (command.binding !== this.options.binding) return;
    const generation = this.generation;
    this.writeInFlight = true;
    this.update({
      pending: command,
      phase: "sending",
      error: "",
      message: "Saving draft metadata with the original command reference…",
    });
    try {
      const result = await this.options.client.submit(copyJson(command));
      if (generation !== this.generation || this.revoked) return;
      const receipt = requireCampaignReceipt(result.data, result.etag, command.campaignId ?? undefined);
      if (
        !sameInput(receipt.data, command.body) ||
        receipt.data.version !== (command.kind === "create" ? 1 : campaignVersion(command.ifMatch) + 1)
      )
        throw new Error(
          "The metadata command acknowledgment does not match its original input and revision.",
        );
      this.writeInFlight = false;
      this.update({
        receipt,
        pending: null,
        selected: null,
        mode: "idle",
        input: null,
        dirty: false,
        phase: "acknowledged",
        conflictCurrent: null,
        pageStale: Boolean(this.state.page),
        message: `Draft metadata command acknowledged at version ${receipt.data.version}. This may be a historical replay; read the current draft before editing.`,
      });
    } catch (error) {
      if (generation !== this.generation || this.revoked) return;
      if (this.fail(error)) return;
      if (error instanceof ApiError && error.status === 412)
        this.update({
          phase: "conflict",
          error:
            "The draft revision changed. Your original fields and command are protected. Read the current revision before deciding.",
          conflictCurrent: null,
        });
      else if (!previouslyUncertain && error instanceof ApiError && [400, 422, 429].includes(error.status))
        this.update({
          phase: "rejected",
          error:
            "The metadata request was rejected. Review the input or wait before retrying the original request.",
        });
      else
        this.update({
          phase: "uncertain",
          error:
            error instanceof ApiError && error.code === "idempotency_conflict"
              ? "The original command reference conflicts with its recorded input. Do not start a replacement command without resolving the original."
              : "The command outcome could not be verified. Inputs, revision and key are retained; retry only the original command.",
        });
    } finally {
      if (generation === this.generation) {
        this.writeInFlight = false;
        this.update({});
      }
    }
  }
  editRejected(): boolean {
    if (
      this.revoked ||
      this.detached ||
      !this.state.online ||
      this.writeInFlight ||
      this.state.phase !== "rejected" ||
      !this.state.pending
    )
      return false;
    this.update({
      pending: null,
      phase: "editing",
      dirty: true,
      error: "",
      message:
        "The rejected command was released explicitly. Review fields before creating a new command reference.",
    });
    return true;
  }
  async readConflict(): Promise<void> {
    const command = this.state.pending;
    if (
      !this.mayRead() ||
      this.state.phase !== "conflict" ||
      command?.kind !== "update" ||
      !command.campaignId
    )
      return;
    const generation = this.generation,
      epoch = ++this.readEpoch;
    this.update({ reading: "conflict", error: "" });
    try {
      const result = await this.options.client.detail(command.campaignId);
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      const current = requireCampaignReceipt(result.data, result.etag, command.campaignId);
      this.update({
        conflictCurrent: current,
        message: `Current version ${current.data.version} is available for explicit conflict review. Your original fields are unchanged.`,
      });
    } catch (error) {
      if (generation !== this.generation || epoch !== this.readEpoch || !this.state.online) return;
      if (!this.fail(error))
        this.update({
          error:
            "The current conflict revision could not be verified. Your original command and fields are retained.",
        });
    } finally {
      if (generation === this.generation && epoch === this.readEpoch) this.update({ reading: null });
    }
  }
  resolveConflict(keepDraft: boolean): boolean {
    if (
      this.revoked ||
      this.detached ||
      !this.state.online ||
      this.state.reading ||
      this.writeInFlight ||
      this.state.phase !== "conflict" ||
      !this.state.conflictCurrent ||
      !this.state.pending
    )
      return false;
    const selected = this.state.conflictCurrent;
    const input = keepDraft
      ? this.state.pending.body
      : { name: selected.data.name, category: selected.data.category };
    const dirty = !sameInput(input, selected.data);
    this.update({
      selected,
      input,
      dirty,
      pending: null,
      conflictCurrent: null,
      mode: "edit",
      phase: "editing",
      error: "",
      message: keepDraft
        ? "Your fields are prepared against the explicitly reviewed current version. Review and save to create a new update command."
        : "Current metadata adopted; the stale draft was discarded explicitly.",
    });
    return true;
  }
}
