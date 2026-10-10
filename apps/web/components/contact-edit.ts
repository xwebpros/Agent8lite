import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";

export const contactEditRetryWindowMs = 23 * 60 * 60 * 1000;
export const contactEditBodyLimit = 64 * 1024;
export const localRecoveryForgettingExplanation =
  "The earlier command may or may not have completed. Clearing this tab’s recovery data does not cancel or undo it. Review current records before attempting related work.";
export const localRecoveryForgottenWarning =
  "An earlier command outcome is unconfirmed and its local recovery data was cleared. Clearing did not cancel or undo it. Review current records before related work. Another command is blocked in this verified context. Reloading or changing context may allow a new attempt and cannot prevent a possible duplicate.";
export type ContactEditCommand = Readonly<{
  context: string;
  contactId: string;
  version: number;
  key: string;
  body: Readonly<Schema<"ContactWrite">>;
  serializedBody: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type ContactEditSnapshot = Readonly<{
  command: ContactEditCommand | null;
  phase: "idle" | "sending" | "unknown" | "acknowledged" | "conflict" | "denied" | "rejected" | "forgotten";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Contact.properties.id);
const validWrite = ajv.compile<Schema<"ContactWrite">>(contract.components.schemas.ContactWrite);
const validContact = ajv.compile<Schema<"Contact">>(contract.components.schemas.Contact);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Never serialize an original object: inherited hooks and accessor properties are not data. */
function jsonSnapshot<T>(input: T): { value: T; json: string } {
  const ancestors = new Set<object>();
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 4000 || depth > 12) throw new Error();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string" && !/[\uD800-\uDFFF]/u.test(value)) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error();
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype && prototype !== null
        : prototype !== Object.prototype && prototype !== null
    )
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
    if (!json || new TextEncoder().encode(json).byteLength > contactEditBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Contact edit data could not be verified.");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function normalizedChannels(values: readonly string[], kind: "emails" | "phones"): string[] {
  return [
    ...new Set(
      values.map((value) =>
        kind === "emails" ? value.trim().toLowerCase() : value.trim().replace(/[\s().-]/g, ""),
      ),
    ),
  ].sort();
}
export function requireContactEditWrite(input: unknown): Schema<"ContactWrite"> {
  const value = jsonSnapshot(input).value;
  if (
    !validWrite(value) ||
    !value.displayName.trim() ||
    (value.phones &&
      normalizedChannels(value.phones, "phones").some((phone) => !/^\+?[0-9]{7,15}$/.test(phone)))
  )
    throw new Error("Enter a name and valid contact channels before saving.");
  return freeze(value);
}
export function requireContactEditContact(input: unknown): Schema<"Contact"> {
  const value = jsonSnapshot(input).value;
  if (!validContact(value) || !Number.isSafeInteger(value.version) || !value.displayName.trim())
    throw new Error("Current contact details could not be verified.");
  return freeze(value);
}
export function contactEditContext(input: {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
  requireWrite?: boolean;
}): string | null {
  try {
    // This is a detached command authority projection, not another Session wire contract.
    const data = jsonSnapshot(input).value;
    const session = data.session;
    if (
      !session ||
      !validId(session.userId) ||
      !validId(session.activeOrgId) ||
      !validId(data.memberId) ||
      typeof data.csrf !== "string" ||
      !/^[\x21-\x7e]{1,512}$/.test(data.csrf) ||
      !Number.isSafeInteger(data.accessRevision) ||
      data.accessRevision < 0 ||
      !Array.isArray(session.permissions) ||
      session.permissions.length > 100 ||
      session.permissions.some(
        (permission) => typeof permission !== "string" || !permission || permission.length > 100,
      ) ||
      !session.permissions.includes("crm.contacts.read") ||
      (data.requireWrite !== false && !session.permissions.includes("crm.contacts.write"))
    )
      return null;
    return jsonSnapshot([
      session.userId,
      session.activeOrgId,
      data.memberId,
      data.csrf,
      data.accessRevision,
      [...session.permissions].sort(),
    ]).json;
  } catch {
    return null;
  }
}

export type ContactEditReadTicket = Readonly<{
  binding: string | null;
  contactId: string | null;
  generation: number;
}>;
export type ContactEditReadCurrent = ContactEditReadTicket &
  Readonly<{
    kind: string | null;
    active: boolean;
    online: boolean;
    visible: boolean;
    changingOrganization: boolean;
  }>;
/** A known denial invalidates authority even when current private values must stay hidden. */
export function contactEditReadGuard(
  ticket: ContactEditReadTicket,
  current: ContactEditReadCurrent,
): Readonly<{ authorityCurrent: boolean; displayCurrent: boolean }> {
  try {
    const data = jsonSnapshot({ ticket, current }).value;
    const authorityCurrent =
      data.current.active === true &&
      data.current.kind === "contact" &&
      typeof data.ticket.binding === "string" &&
      Boolean(data.ticket.binding) &&
      data.ticket.binding === data.current.binding &&
      Number.isSafeInteger(data.ticket.generation) &&
      data.ticket.generation >= 1 &&
      data.ticket.generation === data.current.generation &&
      validId(data.ticket.contactId) &&
      validId(data.current.contactId) &&
      data.ticket.contactId!.toLowerCase() === data.current.contactId!.toLowerCase();
    return Object.freeze({
      authorityCurrent,
      displayCurrent:
        authorityCurrent &&
        data.current.online === true &&
        data.current.visible === true &&
        data.current.changingOrganization === false,
    });
  } catch {
    return Object.freeze({ authorityCurrent: false, displayCurrent: false });
  }
}
export function contactEditReadFailureDisposition(
  ticket: ContactEditReadTicket,
  current: ContactEditReadCurrent,
  status?: number,
): "ignore" | "access-denied" | "source-unavailable" | "display-error" | "withhold" {
  const guard = contactEditReadGuard(ticket, current);
  if (!guard.authorityCurrent) return "ignore";
  if (status === 401 || status === 403) return "access-denied";
  if (status === 404) return "source-unavailable";
  return guard.displayCurrent ? "display-error" : "withhold";
}

/** One context-bound save. A historical receipt acknowledges; it never becomes current detail. */
export class ContactEditProtocol {
  private context: string | null = null;
  private snapshot: ContactEditSnapshot = Object.freeze({ command: null, phase: "idle" });
  private reconciling = false;
  private lastWall = 0;
  private lastMonotonic = 0;
  private clockInvalid = false;
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  constructor(options: { wallNow?: () => number; monotonicNow?: () => number } = {}) {
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }
  bind(context: string | null): void {
    if (context !== this.context) {
      this.reset();
      this.context = context;
    }
  }
  clear(): void {
    // Reading current records cannot remove a forgotten-command warning or unlock a replacement.
    if (this.snapshot.phase === "forgotten") return;
    this.reset();
  }
  private reset(): void {
    this.snapshot = Object.freeze({ command: null, phase: "idle" });
    this.reconciling = false;
    this.clockInvalid = false;
    this.lastWall = 0;
    this.lastMonotonic = 0;
  }
  getSnapshot(): ContactEditSnapshot {
    return this.snapshot;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && context === this.context;
  }
  isCurrent(command: ContactEditCommand): boolean {
    return this.snapshot.command === command && command.context === this.context;
  }
  begin(
    input: { contactId: string; version: number; body: Schema<"ContactWrite"> },
    key: string,
  ): ContactEditCommand {
    if (this.snapshot.phase === "forgotten")
      throw new Error("The earlier outcome is unconfirmed. Another contact save is blocked in this context.");
    const captured = jsonSnapshot(input).value;
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !this.context ||
      this.snapshot.command ||
      !validId(captured.contactId) ||
      !Number.isSafeInteger(captured.version) ||
      captured.version < 1 ||
      captured.version >= Number.MAX_SAFE_INTEGER ||
      !validId(key) ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("Contact saving requires current access and no unresolved command.");
    const body = requireContactEditWrite(captured.body);
    const command = freeze({
      context: this.context,
      contactId: captured.contactId,
      version: captured.version,
      key,
      body,
      serializedBody: jsonSnapshot(body).json,
      firstWall,
      firstMonotonic,
    });
    this.reconciling = false;
    this.lastWall = firstWall;
    this.lastMonotonic = firstMonotonic;
    this.clockInvalid = false;
    this.snapshot = Object.freeze({ command, phase: "sending" });
    return command;
  }
  canRetry(command = this.snapshot.command): boolean {
    if (!command || !this.isCurrent(command) || this.clockInvalid) return false;
    try {
      const wall = this.wallNow(),
        monotonic = this.monotonicNow();
      if (
        !Number.isFinite(wall) ||
        !Number.isFinite(monotonic) ||
        wall < this.lastWall ||
        monotonic < this.lastMonotonic ||
        wall - command.firstWall >= contactEditRetryWindowMs ||
        monotonic - command.firstMonotonic >= contactEditRetryWindowMs
      ) {
        this.clockInvalid = true;
        return false;
      }
      this.lastWall = wall;
      this.lastMonotonic = monotonic;
      return true;
    } catch {
      this.clockInvalid = true;
      return false;
    }
  }
  retry(): ContactEditCommand {
    const command = this.snapshot.command;
    if (!command || this.snapshot.phase !== "unknown" || !this.canRetry(command))
      throw new Error("The original contact save cannot currently be resent. Review the current record.");
    this.reconciling = true;
    this.snapshot = Object.freeze({ command, phase: "sending" });
    return command;
  }
  canForget(): boolean {
    const command = this.snapshot.command;
    return (
      this.snapshot.phase === "unknown" && Boolean(command && this.isCurrent(command)) && !this.canRetry()
    );
  }
  forget(): boolean {
    if (!this.canForget()) return false;
    this.reset();
    this.snapshot = Object.freeze({ command: null, phase: "forgotten" });
    return true;
  }
  acknowledge(command: ContactEditCommand, input: unknown, etag: string | null): boolean {
    if (!this.isCurrent(command)) return false;
    try {
      const receipt = requireContactEditContact(input);
      if (
        receipt.id.toLowerCase() !== command.contactId.toLowerCase() ||
        receipt.version !== command.version + 1 ||
        etag !== `"${receipt.version}"` ||
        receipt.displayName !== command.body.displayName.trim()
      )
        throw new Error();
      for (const field of ["emails", "phones"] as const) {
        if (
          Object.hasOwn(command.body, field) &&
          jsonSnapshot(normalizedChannels(command.body[field] ?? [], field)).json !==
            jsonSnapshot(normalizedChannels(receipt[field], field)).json
        )
          throw new Error();
      }
      if (
        Object.hasOwn(command.body, "birthday") &&
        (!Object.hasOwn(receipt, "birthday") || receipt.birthday !== command.body.birthday)
      )
        throw new Error();
      this.snapshot = Object.freeze({ command: null, phase: "acknowledged" });
      this.reconciling = false;
      return true;
    } catch {
      this.snapshot = Object.freeze({ command, phase: "unknown" });
      this.reconciling = true;
      return false;
    }
  }
  reject(command: ContactEditCommand, error: unknown): "cleared" | "unknown" | "ignored" {
    if (!this.isCurrent(command)) return "ignored";
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      this.bind(null);
      this.snapshot = Object.freeze({ command: null, phase: "denied" });
      return "cleared";
    }
    if (
      !this.reconciling &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      this.snapshot = Object.freeze({ command: null, phase: error.status === 412 ? "conflict" : "rejected" });
      return "cleared";
    }
    this.snapshot = Object.freeze({ command, phase: "unknown" });
    this.reconciling = true;
    return "unknown";
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Contact response is unavailable.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error();
      const chunk = await reader.read();
      if (signal.aborted) throw new Error();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > contactEditBodyLimit) {
        cancel();
        throw new Error();
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
}
async function contactRequest(
  path: string,
  options: RequestInit,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: abort.signal,
    });
    if (!response.ok) {
      let code = "contact_edit_failed";
      try {
        const problem = jsonSnapshot(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Status is authoritative; private provider/body text is never displayed. */
      }
      throw new ApiError(response.status, "The contact command or read could not be verified.", code);
    }
    if (response.status !== 200) throw new Error("Contact response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
export function contactEditRequest(
  organizationId: string,
  command: ContactEditCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = jsonSnapshot(command).value;
  if (
    !validId(organizationId) ||
    !validId(captured.contactId) ||
    !validId(captured.key) ||
    typeof csrf !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(csrf) ||
    !Number.isSafeInteger(captured.version) ||
    captured.version < 1 ||
    jsonSnapshot(requireContactEditWrite(captured.body)).json !== captured.serializedBody
  )
    throw new Error("The original contact command is unavailable.");
  return contactRequest(
    "/api/v1/orgs/" +
      encodeURIComponent(organizationId) +
      "/contacts/" +
      encodeURIComponent(captured.contactId),
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
        "Idempotency-Key": captured.key,
        "If-Match": `"${captured.version}"`,
      },
      body: captured.serializedBody,
    },
    signal,
  );
}
export async function readContactEditContact(
  organizationId: string,
  contactId: string,
  signal?: AbortSignal,
): Promise<{ data: Schema<"Contact">; etag: string | null }> {
  if (!validId(organizationId) || !validId(contactId)) throw new Error("Contact read context is invalid.");
  const result = await contactRequest(
    "/api/v1/orgs/" + encodeURIComponent(organizationId) + "/contacts/" + encodeURIComponent(contactId),
    { method: "GET" },
    signal,
  );
  const data = requireContactEditContact(result.data);
  if (data.id.toLowerCase() !== contactId.toLowerCase() || result.etag !== `"${data.version}"`)
    throw new Error("Current contact details could not be verified.");
  return { data, etag: result.etag };
}
