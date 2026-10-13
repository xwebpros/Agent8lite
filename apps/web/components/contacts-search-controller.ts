import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export type ContactsSearchScope = "own" | "authorized";
export const contactSearchPageSize = 25;
export const contactSearchRowLimit = 200;
export const contactSearchResponseLimit = 1024 * 1024;
export const contactSearchFreshnessMs = 5 * 60 * 1000;
const aggregateLimit = 8 * contactSearchResponseLimit;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
ajv.addSchema({
  $id: "estate:contact-name-search",
  components: {
    schemas: {
      Contact: contract.components.schemas.Contact,
      PageContact: contract.components.schemas.PageContact,
    },
  },
});
const validPage = ajv.compile<Schema<"PageContact">>({
  $ref: "estate:contact-name-search#/components/schemas/PageContact",
});
// This is a local collection of generated fields, not a larger API page.
const validCollection = ajv.compile<Schema<"PageContact">>({
  ...contract.components.schemas.PageContact,
  properties: {
    ...contract.components.schemas.PageContact.properties,
    items: {
      ...contract.components.schemas.PageContact.properties.items,
      items: { $ref: "estate:contact-name-search#/components/schemas/Contact" },
      maxItems: contactSearchRowLimit,
    },
  },
});
const validFilter = ajv.compile<Schema<"LeadFilter">>(contract.components.schemas.LeadFilter);
const validId = ajv.compile(contract.components.schemas.Contact.properties.id);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Bound and detach descriptors before JSON serialization so inherited hooks never run. */
function snapshot<T>(input: T, maximum = contactSearchResponseLimit): T {
  const ancestors = new Set<object>();
  let count = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++count > 20000 || depth > 12) throw new Error();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype)
      throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1001 || (array && (value.length > 1000 || keys.length !== value.length + 1)))
      throw new Error();
    const detached = array ? Object.setPrototypeOf(new Array(value.length), null) : Object.create(null);
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        key === "toJSON" ||
        (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
      )
        throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(detached, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return detached;
  };
  try {
    const json = JSON.stringify(copy(input, 0));
    if (!json || new TextEncoder().encode(json).byteLength > maximum) throw new Error();
    return JSON.parse(json, (_key, value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) Object.setPrototypeOf(value, null);
      return value;
    }) as T;
  } catch {
    throw new Error("Contact search data could not be verified within its private memory limits.");
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function instant(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value),
    epoch = date.getTime();
  return Number.isFinite(epoch) && date.toISOString() === value ? epoch : null;
}
export function contactSearchExpired(refreshedAt: unknown, now: unknown): boolean {
  const refreshed = instant(refreshedAt),
    current = instant(now);
  return (
    refreshed === null ||
    current === null ||
    current < refreshed ||
    current - refreshed >= contactSearchFreshnessMs
  );
}
export function requireContactNameQuery(value: unknown): string {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value) || !validFilter({ q: value }))
    throw new Error("Enter a name query of at most 200 characters.");
  return value;
}
const allowedFilterKeys = new Set(["q", "ownerMemberId", "stageId", "sourceId", "intent", "tagIds"]);
function filterSnapshot(value: unknown): Schema<"LeadFilter"> {
  const filter = snapshot(value, 8 * 1024);
  if (!validFilter(filter) || Object.keys(filter).some((key) => !allowedFilterKeys.has(key)))
    throw new Error("Contact search filter is unavailable.");
  if (Object.hasOwn(filter, "q")) requireContactNameQuery(filter.q);
  if (filter.q === "") delete filter.q;
  return frozen(filter);
}
function verifiedPage(value: unknown, accumulated: boolean): Schema<"PageContact"> {
  const page = snapshot(value, accumulated ? aggregateLimit : contactSearchResponseLimit);
  const validate = accumulated ? validCollection : validPage;
  if (!validate(page)) throw new Error("The contact search results could not be verified.");
  if (
    page.items.length > (accumulated ? contactSearchRowLimit : contactSearchPageSize) ||
    page.hasMore !== Boolean(page.nextCursor) ||
    (page.hasMore && !page.items.length) ||
    (!accumulated && page.hasMore && page.items.length !== contactSearchPageSize) ||
    (page.nextCursor !== null && !/^[\x21-\x7e]+$/.test(page.nextCursor)) ||
    page.items.some(
      (row, index) =>
        !Number.isSafeInteger(row.version) ||
        (index > 0 && row.id.toLowerCase() <= page.items[index - 1].id.toLowerCase()),
    )
  )
    throw new Error("The contact search results could not be verified.");
  return frozen(page);
}
export function requireContactSearchPage(value: unknown): Schema<"PageContact"> {
  return verifiedPage(value, false);
}
export function requireLoadedContactResults(value: unknown): Schema<"PageContact"> {
  return verifiedPage(value, true);
}
export function contactSearchContextBinding(input: {
  session: Schema<"Session">;
  memberId: string;
  accessRevision: number;
  scope: ContactsSearchScope;
}): string {
  return [
    input.session.userId,
    input.session.activeOrgId || "",
    input.memberId,
    String(input.accessRevision),
    input.scope,
    ...[...input.session.permissions].sort(),
  ]
    .map((part) => part.length + ":" + part)
    .join("|");
}
async function boundedJson(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Contact search response body is unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("Contact search was interrupted.");
      const chunk = await reader.read();
      if (signal.aborted) throw new Error("Contact search was interrupted.");
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        void reader.cancel().catch(() => {});
        throw new Error("Contact search response is too large.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
}
export async function contactSearchRequest(
  organizationId: string,
  input: Schema<"LeadFilter">,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  if (
    !validId(organizationId) ||
    (cursor !== undefined &&
      cursor !== null &&
      (typeof cursor !== "string" || !cursor || cursor.length > 4096 || !/^[\x21-\x7e]+$/.test(cursor)))
  )
    throw new Error("Contact search request context is invalid.");
  const filter = filterSnapshot(input),
    parameters = new URLSearchParams({ limit: String(contactSearchPageSize) });
  if (Object.keys(filter).length) parameters.set("filter", JSON.stringify(filter));
  if (cursor) parameters.set("cursor", cursor);
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" + encodeURIComponent(organizationId) + "/contacts?" + parameters,
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: abort.signal,
      },
    );
    if (!response.ok) {
      let code = "contact_search_failed";
      try {
        const problem = snapshot(await boundedJson(response, 64 * 1024, abort.signal), 64 * 1024);
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Retain the real denial, never response content. */
      }
      throw new ApiError(response.status, "Contact search could not be read.", code);
    }
    if (response.status !== 200) throw new Error("Contact search response status is unexpected.");
    return await boundedJson(response, contactSearchResponseLimit, abort.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
export interface ContactsSearchClient {
  list(filter: Schema<"LeadFilter">, cursor?: string | null, signal?: AbortSignal): Promise<unknown>;
}
export type ContactsSearchFilters = Readonly<{
  intent: string;
  stageId: string;
  sourceId: string;
}>;
export type ContactsSearchState = Readonly<{
  online: boolean;
  visible: boolean;
  canRead: boolean;
  reading: boolean;
  query: string;
  appliedQuery: string | null;
  filters: ContactsSearchFilters;
  page: Schema<"PageContact"> | null;
  refreshedAt: string | null;
  phase: "idle" | "ready" | "unavailable" | "denied" | "stale";
  error: string;
}>;
export class ContactsSearchController {
  private state: ContactsSearchState;
  private readonly listeners = new Set<() => void>();
  private epoch = 0;
  private detached = false;
  private revoked = false;
  private request: AbortController | null = null;
  private pageCount = 1;
  private readonly memberId: string;
  private readonly scope: ContactsSearchScope;
  private readonly contextValid: boolean;
  constructor(
    private readonly options: {
      binding: string;
      memberId: string;
      scope: ContactsSearchScope;
      client: ContactsSearchClient;
      online: boolean;
      canRead: boolean;
      isCurrent?(): boolean;
      now?(): string;
      onAccessRevoked?(): void;
    },
  ) {
    this.memberId = options.memberId;
    this.scope = options.scope;
    this.contextValid = validId(this.memberId) && ["own", "authorized"].includes(this.scope);
    const canRead = options.canRead && this.contextValid;
    this.state = frozen({
      online: options.online,
      visible: true,
      canRead,
      reading: false,
      query: "",
      appliedQuery: null,
      filters: { intent: "", stageId: "", sourceId: "" },
      page: null,
      refreshedAt: null,
      phase: canRead ? "idle" : "denied",
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
  private update(patch: Partial<ContactsSearchState>) {
    this.state = frozen({ ...this.state, ...patch });
    for (const listener of this.listeners) listener();
  }
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private active() {
    return (
      !this.detached &&
      !this.revoked &&
      this.state.online &&
      this.state.visible &&
      this.state.canRead &&
      this.options.isCurrent?.() !== false
    );
  }
  private clear(privateQuery = false) {
    ++this.epoch;
    this.request?.abort();
    this.request = null;
    if (privateQuery) this.pageCount = 1;
    this.update({
      page: null,
      appliedQuery: null,
      reading: false,
      refreshedAt: null,
      error: "",
      phase: this.state.canRead ? "idle" : "denied",
      ...(privateQuery ? { query: "", filters: { intent: "", stageId: "", sourceId: "" } } : {}),
    });
  }
  attach() {
    if (!this.revoked) this.detached = false;
  }
  detach() {
    this.detached = true;
    this.clear(true);
  }
  invalidate() {
    this.clear(true);
  }
  revoke() {
    this.revoked = true;
    this.clear(true);
    this.update({
      canRead: false,
      phase: "denied",
      error: "Contact search access changed. Use Refresh workspace to verify current access.",
    });
  }
  setOnline(online: boolean) {
    if (online !== this.state.online) {
      this.clear(true);
      this.update({ online });
    }
  }
  setVisible(visible: boolean) {
    if (visible !== this.state.visible) {
      this.clear(true);
      this.update({ visible });
    }
  }
  setPermissions(value: boolean) {
    const canRead = value && this.contextValid;
    if (!this.revoked && canRead !== this.state.canRead) {
      this.clear(true);
      this.update({ canRead, phase: canRead ? "idle" : "denied" });
    }
  }
  setQuery(value: unknown) {
    if (!this.active()) return;
    try {
      const query = requireContactNameQuery(value);
      if (query === this.state.query) return;
      this.clear();
      this.pageCount = 1;
      this.update({ query });
    } catch {
      this.clear(true);
      this.update({
        phase: "unavailable",
        error: "Enter a name query of at most 200 characters. The previous results are hidden.",
      });
    }
  }
  setFilter(key: keyof ContactsSearchFilters, value: string) {
    if (!this.active()) return;
    if (this.state.filters[key] === value) return;
    this.clear();
    this.pageCount = 1;
    this.update({ filters: { ...this.state.filters, [key]: value } });
  }
  tick() {
    if (!this.active()) {
      if (this.state.page || this.state.query || this.state.reading) this.clear(true);
      return;
    }
    if (this.state.page && contactSearchExpired(this.state.refreshedAt, this.now())) {
      this.clear();
      this.update({ phase: "stale", error: "The contact list is stale. Refresh to verify current results." });
    }
  }
  hasCurrentContact(id: string): boolean {
    return (
      this.active() &&
      !this.state.reading &&
      validId(id) &&
      this.state.appliedQuery === this.state.query &&
      !contactSearchExpired(this.state.refreshedAt, this.now()) &&
      this.state.page?.items.some((row) => row.id.toLowerCase() === id.toLowerCase()) === true
    );
  }
  submit(): Promise<void> {
    return this.readPages(1);
  }
  refresh(): Promise<void> {
    return this.readPages(this.pageCount);
  }
  more(): Promise<void> {
    if (
      !this.active() ||
      this.state.reading ||
      !this.state.page?.hasMore ||
      this.state.page.items.length >= contactSearchRowLimit ||
      contactSearchExpired(this.state.refreshedAt, this.now())
    ) {
      this.tick();
      return Promise.resolve();
    }
    return this.readPages(Math.min(8, this.pageCount + 1));
  }
  private async readPages(target: number): Promise<void> {
    if (!this.active()) return;
    const query = requireContactNameQuery(this.state.query);
    const { intent, stageId, sourceId } = this.state.filters;
    const filter = filterSnapshot({
      ...(query ? { q: query } : {}),
      ...(this.scope === "own" ? { ownerMemberId: this.memberId } : {}),
      ...(intent ? { intent } : {}),
      ...(stageId ? { stageId } : {}),
      ...(sourceId ? { sourceId } : {}),
    });
    this.clear();
    const epoch = this.epoch,
      request = new AbortController();
    this.request = request;
    const current = () => epoch === this.epoch && this.active() && this.state.query === query;
    this.update({ reading: true });
    try {
      const items: Schema<"Contact">[] = [],
        cursors = new Set<string>();
      let cursor: string | null = null,
        page: Schema<"PageContact"> | null = null,
        readCount = 0;
      for (let index = 0; index < target; index++) {
        page = requireContactSearchPage(await this.options.client.list(filter, cursor, request.signal));
        if (!current()) return;
        items.push(...page.items);
        readCount++;
        if (
          items.length > contactSearchRowLimit ||
          items.some((row, at) => at > 0 && row.id.toLowerCase() <= items[at - 1].id.toLowerCase()) ||
          (page.nextCursor && (page.nextCursor === cursor || cursors.has(page.nextCursor)))
        )
          throw new Error("Contact pagination changed.");
        if (!page.hasMore) break;
        if (page.nextCursor) cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      if (!current() || !page) return;
      const refreshedAt = this.now();
      if (instant(refreshedAt) === null) throw new Error("Contact read clock is unavailable.");
      const results = requireLoadedContactResults({ ...page, items });
      this.pageCount = readCount;
      this.update({ page: results, query, appliedQuery: query, refreshedAt, phase: "ready", error: "" });
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.revoke();
        this.options.onAccessRevoked?.();
      } else
        this.update({
          page: null,
          appliedQuery: null,
          refreshedAt: null,
          phase: "unavailable",
          error:
            "Contact search is unavailable. Retry to verify current results; no empty list has been inferred.",
        });
    } finally {
      if (current()) {
        this.request = null;
        this.update({ reading: false });
      }
    }
  }
}
