import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import contract from "../../../packages/contracts/openapi.json";
import { ApiError, type Schema } from "../lib/api";
import { requireContactEditContact, requireContactEditWrite } from "./contact-edit";

export const leadCaptureBodyLimit = 64 * 1024;
export const leadCaptureRetryWindowMs = 23 * 60 * 60 * 1000;
export type LeadCaptureTemplate = Omit<Schema<"LeadCreate">, "contactId">;
export type LeadCaptureInput = Readonly<{
  contact: Schema<"ContactWrite">;
  lead: LeadCaptureTemplate;
}>;
type CommandBase = Readonly<{
  context: string;
  key: string;
  serializedBody: string;
  firstWall: number;
  firstMonotonic: number;
}>;
export type LeadCaptureCommand = CommandBase &
  (
    | Readonly<{ step: "contact"; body: Readonly<Schema<"ContactWrite">> }>
    | Readonly<{ step: "lead"; body: Readonly<Schema<"LeadCreate">> }>
  );
export type LeadCaptureSequence = Readonly<{
  context: string;
  input: LeadCaptureInput;
  contactKey: string;
  leadKey: string;
  contactId: string | null;
}>;
export type LeadCaptureSnapshot = Readonly<{
  sequence: LeadCaptureSequence | null;
  command: LeadCaptureCommand | null;
  phase:
    | "idle"
    | "contact-sending"
    | "contact-unknown"
    | "contact-rejected"
    | "lead-ready"
    | "lead-sending"
    | "lead-unknown"
    | "lead-rejected"
    | "acknowledged"
    | "denied";
}>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const validId = ajv.compile(contract.components.schemas.Contact.properties.id);
const validLead = ajv.compile<Schema<"Lead">>(contract.components.schemas.Lead);
const validLeadCreate = ajv.compile<Schema<"LeadCreate">>(contract.components.schemas.LeadCreate);
const validProblem = ajv.compile<Schema<"Problem">>(contract.components.schemas.Problem);

/** Clone own data before serialization; neither original nor inherited hooks are executed. */
function snapshot<T>(input: T): { value: T; json: string } {
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
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      Object.defineProperty(detached, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value);
    return detached;
  };
  try {
    const json = JSON.stringify(copy(input, 0));
    if (!json || new TextEncoder().encode(json).byteLength > leadCaptureBodyLimit) throw new Error();
    const value = JSON.parse(json, (_key, child: unknown) => {
      if (child && typeof child === "object" && !Array.isArray(child)) Object.setPrototypeOf(child, null);
      return child;
    }) as T;
    return { value, json };
  } catch {
    throw new Error("Lead capture data could not be verified.");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function sameId(a: unknown, b: unknown): boolean {
  return validId(a) && validId(b) && (a as string).toLowerCase() === (b as string).toLowerCase();
}
function channels(values: readonly string[], kind: "emails" | "phones"): string {
  return snapshot(
    [
      ...new Set(
        values.map((value) =>
          kind === "emails" ? value.trim().toLowerCase() : value.trim().replace(/[\s().-]/g, ""),
        ),
      ),
    ].sort(),
  ).json;
}
export function requireLeadCaptureTemplate(input: unknown): Readonly<LeadCaptureTemplate> {
  const value = snapshot(input).value as LeadCaptureTemplate;
  if (
    !value ||
    typeof value !== "object" ||
    Object.hasOwn(value, "contactId") ||
    !validLeadCreate({ ...value, contactId: "00000000-0000-4000-8000-000000000001" }) ||
    !validId(value.ownerMemberId)
  )
    throw new Error("Review the lead source, intent and current assignee before saving.");
  return freeze(value);
}
export function requireLeadCaptureInput(input: unknown): LeadCaptureInput {
  const value = snapshot(input).value as LeadCaptureInput;
  if (
    !value ||
    typeof value !== "object" ||
    Reflect.ownKeys(value).length !== 2 ||
    !Object.hasOwn(value, "contact") ||
    !Object.hasOwn(value, "lead")
  )
    throw new Error("Review the contact and lead fields before saving.");
  return freeze({
    contact: requireContactEditWrite(value.contact),
    lead: requireLeadCaptureTemplate(value.lead),
  });
}
export function requireLeadCaptureLead(input: unknown): Schema<"Lead"> {
  const value = snapshot(input).value;
  if (!validLead(value) || !Number.isSafeInteger(value.version))
    throw new Error("The lead receipt could not be verified.");
  return freeze(value);
}
export function leadCaptureContext(input: {
  session: Schema<"Session"> | null;
  memberId: string;
  csrf: string;
  accessRevision: number;
}): string | null {
  try {
    const data = snapshot(input).value;
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
      session.permissions.some((code) => typeof code !== "string" || !code || code.length > 100) ||
      !["crm.contacts.write", "crm.leads.write"].every((code) => session.permissions.includes(code))
    )
      return null;
    return snapshot([
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

export type LeadCaptureCurrent = Readonly<{
  binding: string | null;
  active: boolean;
  online: boolean;
  visible: boolean;
  changingOrganization: boolean;
  modal: string | null;
  busy: boolean;
  loading: boolean;
  detailLoading: boolean;
  otherProtected: boolean;
}>;
export function leadCaptureEligible(binding: string | null, current: LeadCaptureCurrent): boolean {
  try {
    const data = snapshot({ binding, current }).value;
    return (
      typeof data.binding === "string" &&
      Boolean(data.binding) &&
      data.current.binding === data.binding &&
      data.current.active === true &&
      data.current.online === true &&
      data.current.visible === true &&
      data.current.changingOrganization === false &&
      data.current.modal === "lead" &&
      data.current.busy === false &&
      data.current.loading === false &&
      data.current.detailLoading === false &&
      data.current.otherProtected === false
    );
  } catch {
    return false;
  }
}

/** The two POSTs are separate durable commands. An acknowledged contact is never posted again. */
export class LeadCaptureProtocol {
  private context: string | null = null;
  private state: LeadCaptureSnapshot = Object.freeze({ sequence: null, command: null, phase: "idle" });
  private reconciling = false;
  private clockInvalid = false;
  private lastWall = 0;
  private lastMonotonic = 0;
  private keys = new Set<string>();
  private readonly wallNow: () => number;
  private readonly monotonicNow: () => number;
  constructor(options: { wallNow?: () => number; monotonicNow?: () => number } = {}) {
    this.wallNow = options.wallNow ?? (() => Date.now());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }
  bind(context: string | null): void {
    const next =
      typeof context === "string" && context.length > 0 && context.length <= leadCaptureBodyLimit
        ? context
        : null;
    if (this.context !== next) {
      this.reset();
      this.context = next;
    }
  }
  private reset(): void {
    this.state = Object.freeze({ sequence: null, command: null, phase: "idle" });
    this.reconciling = false;
    this.clockInvalid = false;
    this.keys.clear();
  }
  getSnapshot(): LeadCaptureSnapshot {
    return this.state;
  }
  isBoundTo(context: string | null): boolean {
    return typeof context === "string" && Boolean(context) && this.context === context;
  }
  isCurrent(command: LeadCaptureCommand): boolean {
    return this.state.command === command && command.context === this.context;
  }
  private makeCommand<T extends LeadCaptureCommand["step"]>(
    step: T,
    body: T extends "contact" ? Schema<"ContactWrite"> : Schema<"LeadCreate">,
    key: string,
  ): LeadCaptureCommand {
    const firstWall = this.wallNow(),
      firstMonotonic = this.monotonicNow();
    if (
      !this.context ||
      !Number.isFinite(firstWall) ||
      firstWall < 0 ||
      !Number.isFinite(firstMonotonic) ||
      firstMonotonic < 0
    )
      throw new Error("The original command clock is unavailable.");
    const detached = snapshot(body);
    this.reconciling = false;
    this.clockInvalid = false;
    this.lastWall = firstWall;
    this.lastMonotonic = firstMonotonic;
    return freeze({
      context: this.context,
      step,
      body: detached.value,
      serializedBody: detached.json,
      key,
      firstWall,
      firstMonotonic,
    }) as LeadCaptureCommand;
  }
  begin(input: LeadCaptureInput, contactKey: string, leadKey: string): LeadCaptureCommand {
    if (
      !this.context ||
      this.state.sequence ||
      !validId(contactKey) ||
      !validId(leadKey) ||
      sameId(contactKey, leadKey)
    )
      throw new Error("Resolve the current lead capture before starting another.");
    const detached = requireLeadCaptureInput(input);
    const command = this.makeCommand("contact", detached.contact, contactKey);
    const sequence = freeze({ context: this.context, input: detached, contactKey, leadKey, contactId: null });
    this.keys = new Set([contactKey.toLowerCase(), leadKey.toLowerCase()]);
    this.state = Object.freeze({ sequence, command, phase: "contact-sending" });
    return command;
  }
  startLead(): LeadCaptureCommand {
    const sequence = this.state.sequence;
    if (
      !sequence ||
      sequence.context !== this.context ||
      !sequence.contactId ||
      this.state.phase !== "lead-ready" ||
      this.state.command
    )
      throw new Error("A contact acknowledgement is required before saving the lead.");
    const body = freeze({ ...sequence.input.lead, contactId: sequence.contactId });
    if (!validLeadCreate(body)) throw new Error("The retained lead command is unavailable.");
    const command = this.makeCommand("lead", body, sequence.leadKey);
    this.state = Object.freeze({ sequence, command, phase: "lead-sending" });
    return command;
  }
  canRetry(command = this.state.command): boolean {
    if (!command || !this.isCurrent(command) || this.clockInvalid) return false;
    try {
      const wall = this.wallNow(),
        mono = this.monotonicNow();
      if (
        !Number.isFinite(wall) ||
        !Number.isFinite(mono) ||
        wall < this.lastWall ||
        mono < this.lastMonotonic ||
        wall < command.firstWall ||
        mono < command.firstMonotonic ||
        wall - command.firstWall >= leadCaptureRetryWindowMs ||
        mono - command.firstMonotonic >= leadCaptureRetryWindowMs
      ) {
        this.clockInvalid = true;
        return false;
      }
      this.lastWall = wall;
      this.lastMonotonic = mono;
      return true;
    } catch {
      this.clockInvalid = true;
      return false;
    }
  }
  retry(): LeadCaptureCommand {
    const command = this.state.command;
    if (
      !command ||
      !["contact-unknown", "lead-unknown"].includes(this.state.phase) ||
      !this.canRetry(command)
    )
      throw new Error("The original step cannot be resent. Its outcome remains unconfirmed.");
    this.reconciling = true;
    this.state = Object.freeze({
      ...this.state,
      phase: command.step === "contact" ? "contact-sending" : "lead-sending",
    });
    return command;
  }
  acknowledge(command: LeadCaptureCommand, input: unknown, etag: string | null): "contact" | "lead" | false {
    if (!this.isCurrent(command)) return false;
    try {
      if (command.step === "contact") {
        const receipt = requireContactEditContact(input);
        if (
          receipt.version !== 1 ||
          etag !== '"1"' ||
          receipt.displayName !== command.body.displayName.trim()
        )
          throw new Error();
        for (const field of ["emails", "phones"] as const)
          if (channels(command.body[field] ?? [], field) !== channels(receipt[field], field))
            throw new Error();
        if ((receipt.birthday ?? null) !== (command.body.birthday ?? null)) throw new Error();
        this.state = Object.freeze({
          sequence: freeze({ ...this.state.sequence!, contactId: receipt.id }),
          command: null,
          phase: "lead-ready",
        });
      } else {
        const receipt = requireLeadCaptureLead(input);
        if (
          receipt.version !== 1 ||
          etag !== '"1"' ||
          !sameId(receipt.contactId, command.body.contactId) ||
          !sameId(receipt.sourceId, command.body.sourceId) ||
          !sameId(receipt.ownerMemberId, command.body.ownerMemberId) ||
          receipt.intent !== command.body.intent ||
          (receipt.timeline ?? null) !== (command.body.timeline ?? null) ||
          (receipt.score ?? null) !== null ||
          (receipt.scoreVersion ?? null) !== null
        )
          throw new Error();
        this.reset();
        this.state = Object.freeze({ sequence: null, command: null, phase: "acknowledged" });
      }
      this.reconciling = false;
      return command.step;
    } catch {
      this.reconciling = true;
      this.state = Object.freeze({
        ...this.state,
        phase: command.step === "contact" ? "contact-unknown" : "lead-unknown",
      });
      return false;
    }
  }
  reject(command: LeadCaptureCommand, error: unknown): "cleared" | "unknown" | "ignored" {
    if (!this.isCurrent(command)) return "ignored";
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      this.bind(null);
      this.state = Object.freeze({ sequence: null, command: null, phase: "denied" });
      return "cleared";
    }
    if (
      !this.reconciling &&
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    ) {
      const sequence = command.step === "contact" ? null : this.state.sequence;
      this.state = Object.freeze({
        sequence,
        command: null,
        phase: command.step === "contact" ? "contact-rejected" : "lead-rejected",
      });
      return "cleared";
    }
    this.reconciling = true;
    this.state = Object.freeze({
      ...this.state,
      phase: command.step === "contact" ? "contact-unknown" : "lead-unknown",
    });
    return "unknown";
  }
  correctLead(template: LeadCaptureTemplate, newKey: string): void {
    const sequence = this.state.sequence;
    const detached = requireLeadCaptureTemplate(template);
    if (
      !sequence ||
      sequence.context !== this.context ||
      !sequence.contactId ||
      this.state.command ||
      this.state.phase !== "lead-rejected" ||
      !validId(newKey) ||
      this.keys.has(newKey.toLowerCase()) ||
      this.keys.size >= 100 ||
      !sameId(detached.ownerMemberId, sequence.input.lead.ownerMemberId)
    )
      throw new Error("Only a known rejected lead can be reviewed as a new attempt.");
    this.keys.add(newKey.toLowerCase());
    this.state = Object.freeze({
      sequence: freeze({
        ...sequence,
        input: { contact: sequence.input.contact, lead: detached },
        leadKey: newKey,
      }),
      command: null,
      phase: "lead-ready",
    });
  }
  keepContactAndClose(): boolean {
    if (
      !this.state.sequence?.contactId ||
      this.state.command ||
      !["lead-ready", "lead-rejected"].includes(this.state.phase)
    )
      return false;
    this.reset();
    return true;
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The capture response is unavailable.");
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
      if (bytes > leadCaptureBodyLimit) {
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
export async function leadCaptureRequest(
  organizationId: string,
  command: LeadCaptureCommand,
  csrf: string,
  signal?: AbortSignal,
): Promise<{ data: unknown; etag: string | null }> {
  const captured = snapshot(command).value;
  if (
    !validId(organizationId) ||
    !validId(captured.key) ||
    !["contact", "lead"].includes(captured.step) ||
    typeof csrf !== "string" ||
    !/^[\x21-\x7e]{1,512}$/.test(csrf) ||
    snapshot(captured.step === "contact" ? requireContactEditWrite(captured.body) : captured.body).json !==
      captured.serializedBody ||
    (captured.step === "lead" && !validLeadCreate(captured.body))
  )
    throw new Error("The original capture command is unavailable.");
  const abort = new AbortController(),
    cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(
      "/api/v1/orgs/" +
        encodeURIComponent(organizationId) +
        (captured.step === "contact" ? "/contacts" : "/leads"),
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": captured.key,
        },
        body: captured.serializedBody,
        signal: abort.signal,
      },
    );
    if (!response.ok) {
      let code = "lead_capture_failed";
      try {
        const problem = snapshot(await boundedJson(response, abort.signal)).value;
        if (validProblem(problem) && problem.status === response.status) code = problem.code;
      } catch {
        /* Keep only safe status, never private response text. */
      }
      throw new ApiError(response.status, "The capture command could not be verified.", code);
    }
    if (response.status !== 201) throw new Error("The capture response status is unexpected.");
    return { data: await boundedJson(response, abort.signal), etag: response.headers.get("ETag") };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
