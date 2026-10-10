"use client";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  SupportResource,
  SupportResourceEntity,
  SupportResourcePage,
} from "../../../packages/contracts/internal/control-plane-port";
import openapi from "../../../packages/contracts/openapi.json";
import { Badge, Button } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import { validStaffJobId } from "./staff-console-protocol";
import styles from "./staff-console.module.css";
import {
  type StaffSupportCommand,
  type StaffSupportLifetime,
  type StaffSupportSessionView,
  type SupportGrantReceipt,
  type SupportJobKind,
  canReconcileSupportCommand,
  parseStrongSupportEtag,
  pendingSupportJob,
  selectionMatchesCurrent,
  snapshotSupportClear,
  snapshotSupportGrant,
  snapshotSupportRevoke,
  snapshotSupportSelection,
  supportAccessIdentity,
  supportCommandFailure,
  supportContextUnexpired,
  supportReadPermissions,
  verifySupportGrantReceipt,
} from "./staff-support-protocol";

export type StaffSupportPanelProps = {
  lifetime: StaffSupportLifetime;
  view: StaffSupportSessionView | null;
  online: boolean;
  verified: boolean;
  locked: boolean;
  onSession(view: StaffSupportSessionView): void;
  onUnverified(error: unknown): void;
  onAccessLost(error: unknown): void;
  onVerifySession(): Promise<void>;
  onRecoveryRequired(value: boolean): void;
};
type Attempt = { command: StaffSupportCommand; state: "pending" | "unknown" | "review" | "rejected" };
type Receipt = { receipt: SupportGrantReceipt; organizationId?: string; checkedAt: string };
const resources = {
  contacts: { label: "Contacts", permission: "crm.contacts.read", entity: "Contact", page: "PageContact" },
  leads: { label: "Leads", permission: "crm.leads.read", entity: "Lead", page: "PageLead" },
  tasks: { label: "Tasks", permission: "crm.tasks.read", entity: "Task", page: "PageTask" },
  deals: { label: "Deals", permission: "crm.deals.read", entity: "Deal", page: "PageDeal" },
  "pipeline-stages": {
    label: "Pipeline stages",
    permission: "crm.pipeline.read",
    entity: "PipelineStage",
    page: "PagePipelineStage",
  },
  "lead-sources": {
    label: "Lead sources",
    permission: "crm.sources.read",
    entity: "LeadSource",
    page: "PageLeadSource",
  },
  tags: { label: "Tags", permission: "crm.tags.read", entity: "Tag", page: "PageTag" },
} as const satisfies Record<
  SupportResource,
  {
    label: string;
    permission: string;
    entity: keyof typeof openapi.components.schemas;
    page: keyof typeof openapi.components.schemas;
  }
>;
const ajv = new Ajv2020({ strict: false, ownProperties: true });
addFormats(ajv);
const schemaValidators = new Map<string, ReturnType<typeof ajv.compile>>();
function verifyProjection<R extends SupportResource>(resource: R, value: unknown, detail: boolean) {
  const name = detail ? resources[resource].entity : resources[resource].page;
  let validator = schemaValidators.get(name);
  if (!validator) {
    validator = ajv.compile({ components: openapi.components, $ref: `#/components/schemas/${name}` });
    schemaValidators.set(name, validator);
  }
  if (!validator(value)) throw new Error("The authorized CRM response could not be verified.");
  return value as SupportResourceEntity[R] | SupportResourcePage[R];
}
export function supportRecordSummary(item: SupportResourceEntity[SupportResource]): string {
  if ("displayName" in item) return item.displayName;
  if ("title" in item) return item.title;
  if ("name" in item) return item.name;
  if ("label" in item) return item.label;
  if ("intent" in item) return `${item.intent} lead`;
  return "Authorized CRM record";
}
export function SupportRecordDetails({ item }: { item: SupportResourceEntity[SupportResource] }) {
  const fields = [
    "id",
    "displayName",
    "title",
    "name",
    "label",
    "code",
    "contactId",
    "leadId",
    "sourceId",
    "stageId",
    "ownerMemberId",
    "assigneeMemberId",
    "intent",
    "timeline",
    "score",
    "scoreVersion",
    "dueAt",
    "timezone",
    "priority",
    "state",
    "amount",
    "currency",
    "expectedCloseDate",
    "position",
    "terminal",
    "version",
  ] as const;
  return (
    <dl className={styles.muted}>
      {fields.map((field) => {
        if (!Object.hasOwn(item, field)) return null;
        const value = (item as unknown as Record<string, unknown>)[field];
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) return null;
        return (
          <div key={field}>
            <dt>{field}</dt>
            <dd>{value === null ? "Not returned" : String(value)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

export default function StaffSupportPanel({
  lifetime,
  view,
  online,
  verified,
  locked,
  onSession,
  onUnverified,
  onAccessLost,
  onVerifySession,
  onRecoveryRequired,
}: StaffSupportPanelProps) {
  const [organizationId, setOrganizationId] = useState("");
  const [recipient, setRecipient] = useState("");
  const [purpose, setPurpose] = useState("");
  const [minutes, setMinutes] = useState("15");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [grantId, setGrantId] = useState("");
  const [recoverId, setRecoverId] = useState("");
  const [recoverKind, setRecoverKind] = useState<SupportJobKind>("staff.support.grant");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resource, setResource] = useState<SupportResource>("contacts");
  const [rows, setRows] = useState<SupportResourceEntity[SupportResource][] | null>(null);
  const [detail, setDetail] = useState<SupportResourceEntity[SupportResource] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [readAt, setReadAt] = useState("");
  const [projectionIdentity, setProjectionIdentity] = useState("");
  const [reading, setReading] = useState(false);
  const [clock, setClock] = useState(() => Date.now());
  const busyRef = useRef(false);
  const attemptRef = useRef<Attempt | null>(null);
  const epoch = useRef(0);
  const alive = useRef(true);
  const propsRef = useRef({ view, online, verified, locked, onSession, onUnverified, onAccessLost });
  propsRef.current = { view, online, verified, locked, onSession, onUnverified, onAccessLost };
  const guardCallback = useRef(onRecoveryRequired);
  guardCallback.current = onRecoveryRequired;
  const identity = view ? supportAccessIdentity(view) : "";
  const generation = lifetime.generation;
  const selected = Boolean(view && supportContextUnexpired(view, Math.max(clock, Date.now())));
  const canGrant = view?.session.permissions.includes("platform.support.grant") === true;
  const dirty = Boolean(organizationId || recipient || purpose || grantId || recoverId || permissions.length);
  const protectedWork =
    dirty ||
    Boolean(attempt) ||
    busy ||
    reading ||
    receipts.some((item) => pendingSupportJob(item.receipt.job));
  const protectedRef = useRef(false);
  protectedRef.current = protectedWork;
  const publishProtection = (value: boolean) => {
    protectedRef.current = value;
    guardCallback.current(value);
  };
  const clearProjection = useCallback(() => {
    ++epoch.current;
    setRows(null);
    setDetail(null);
    setCursor(null);
    setReadAt("");
    setProjectionIdentity("");
    setReading(false);
  }, []);
  useEffect(() => {
    clearProjection();
  }, [identity, online, verified, selected, clearProjection]);
  useEffect(() => {
    if (!view?.session.supportContext) return;
    const tick = () => {
      const current = Date.now();
      setClock(current);
      if (!supportContextUnexpired(view, current)) clearProjection();
    };
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [view, clearProjection]);
  useEffect(() => {
    onRecoveryRequired(protectedWork);
  }, [protectedWork, onRecoveryRequired]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (protectedRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++epoch.current;
      attemptRef.current = null;
      guardCallback.current(false);
    };
  }, []);
  const previousGeneration = useRef(generation);
  useEffect(() => {
    if (previousGeneration.current === generation) return;
    previousGeneration.current = generation;
    attemptRef.current = null;
    busyRef.current = false;
    setBusy(false);
    setAttempt(null);
    setReceipts([]);
    setOrganizationId("");
    setRecipient("");
    setPurpose("");
    setPermissions([]);
    setGrantId("");
    setRecoverId("");
    setError("");
    setNotice("");
    clearProjection();
  }, [generation, clearProjection]);
  function fail(errorValue: unknown) {
    clearProjection();
    if (errorValue instanceof ApiError && supportCommandFailure(errorValue.status) === "invalidate")
      onAccessLost(errorValue);
    setError(errorValue instanceof Error ? errorValue.message : "Synthetic support service unavailable.");
  }
  function currentView() {
    const current = lifetime.current;
    if (!current || !propsRef.current.online || !navigator.onLine || !propsRef.current.verified)
      throw new Error("Reconnect and verify the same staff session before continuing.");
    return current;
  }
  function remember(receipt: SupportGrantReceipt, org?: string) {
    setReceipts((previous) => {
      const old = previous.find((item) => item.receipt.job.id === receipt.job.id);
      const entry = {
        receipt,
        organizationId: org || old?.organizationId,
        checkedAt: new Date().toISOString(),
      };
      return [entry, ...previous.filter((item) => item.receipt.job.id !== receipt.job.id)];
    });
  }
  async function execute(command: StaffSupportCommand) {
    if (busyRef.current || !canReconcileSupportCommand(lifetime, command)) return;
    let current: StaffSupportSessionView;
    try {
      current = currentView();
    } catch (errorValue) {
      fail(errorValue);
      return;
    }
    if ((command.kind === "grant" || command.kind === "revoke") && current.supportState !== "none") {
      setError("Explicitly clear and verify the support context before a platform grant command.");
      return;
    }
    if (propsRef.current.locked && command.kind !== "clear") return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    clearProjection();
    const snapshot: Attempt = { command, state: "pending" };
    attemptRef.current = snapshot;
    setAttempt(snapshot);
    publishProtection(true);
    const ticket = command.kind === "select" || command.kind === "clear" ? lifetime.beginRequest() : null;
    const commandGeneration = lifetime.generation;
    const path =
      command.kind === "select"
        ? "/dev/staff/support/select"
        : command.kind === "clear"
          ? "/dev/staff/support/clear"
          : command.kind === "grant"
            ? `/v1/platform/organizations/${command.organizationId}/access-grants`
            : `/dev/staff/support/organizations/${command.organizationId}/access-grants/${command.grant.grantId}/revoke`;
    const body = command.kind === "clear" || command.kind === "revoke" ? {} : command.input;
    try {
      const response = await api<unknown>(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": current.csrf,
          "Idempotency-Key": command.idempotencyKey,
          ...(command.kind === "revoke" ? { "If-Match": command.grant.grantEtag } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!alive.current || commandGeneration !== lifetime.generation) return;
      if (ticket) {
        let next: StaffSupportSessionView | null;
        try {
          next = lifetime.acceptSession(ticket, response.data, response.headers);
        } catch (errorValue) {
          onUnverified(errorValue);
          throw errorValue;
        }
        if (!next)
          throw new Error(
            "A newer session read superseded this response. Verify the same session and reconcile the original command.",
          );
        onSession(next);
        const matches = selectionMatchesCurrent(next, command.kind === "select" ? command.input : null);
        setNotice(
          matches
            ? command.kind === "select"
              ? "The server returned this current synthetic read-only selection."
              : "The server returned a current cleared selection."
            : "The command was acknowledged with a different current selection. Its original input was not restored; review the current server context.",
        );
      } else {
        const receipt = verifySupportGrantReceipt(
          response.data,
          response.headers,
          command.kind === "grant" ? "staff.support.grant" : "staff.support.revoke",
        );
        remember(receipt, "organizationId" in command ? command.organizationId : undefined);
        setNotice(
          "Only the returned support operation state is acknowledged. This does not establish current eligibility or select, renew or revoke another grant.",
        );
      }
      attemptRef.current = null;
      setAttempt(null);
      if (command.kind === "grant") {
        setPurpose("");
        setRecipient("");
        setPermissions([]);
      }
    } catch (errorValue) {
      if (!alive.current || commandGeneration !== lifetime.generation) return;
      const disposition = supportCommandFailure(
        errorValue instanceof ApiError ? errorValue.status : undefined,
      );
      const state =
        disposition === "review-current" ? "review" : disposition === "rejected" ? "rejected" : "unknown";
      if (disposition !== "invalidate") {
        const next = { command, state } as Attempt;
        attemptRef.current = next;
        setAttempt(next);
      }
      fail(errorValue);
    } finally {
      if (alive.current && commandGeneration === lifetime.generation) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  function createGrant(event: FormEvent) {
    event.preventDefault();
    if (!canGrant || attemptRef.current || busyRef.current || locked) return;
    try {
      currentView();
      const duration = Number(minutes);
      if (![5, 15, 30, 45].includes(duration)) throw new Error("Review the short synthetic expiry.");
      const command = snapshotSupportGrant(
        lifetime,
        organizationId.trim(),
        {
          staffUserId: recipient.trim(),
          permissions: [...permissions],
          reason: purpose.trim(),
          expiresAt: new Date(Date.now() + duration * 60_000).toISOString(),
        },
        crypto.randomUUID(),
      );
      void execute(command);
    } catch (errorValue) {
      fail(errorValue);
    }
  }
  function selectGrant(event: FormEvent) {
    event.preventDefault();
    if (attemptRef.current || locked) return;
    try {
      currentView();
      void execute(
        snapshotSupportSelection(
          lifetime,
          { organizationId: organizationId.trim(), accessGrantId: grantId.trim() },
          crypto.randomUUID(),
        ),
      );
    } catch (errorValue) {
      fail(errorValue);
    }
  }
  function clearSelection() {
    if (attemptRef.current || busyRef.current) return;
    try {
      currentView();
      void execute(snapshotSupportClear(lifetime, crypto.randomUUID()));
    } catch (errorValue) {
      fail(errorValue);
    }
  }
  async function readReceipt(id: string, kind: SupportJobKind, org?: string) {
    currentView();
    if (!validStaffJobId(id)) throw new Error("Enter a support operation UUID.");
    const commandGeneration = lifetime.generation;
    const response = await api<unknown>(`/dev/staff/support/jobs/${id}`);
    if (!alive.current || commandGeneration !== lifetime.generation) return null;
    const receipt = verifySupportGrantReceipt(response.data, response.headers, kind, id);
    remember(receipt, org);
    return receipt;
  }
  async function recover(event?: FormEvent, entry?: Receipt) {
    event?.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    publishProtection(true);
    setError("");
    const commandGeneration = lifetime.generation;
    try {
      await readReceipt(
        entry?.receipt.job.id || recoverId.trim(),
        (entry?.receipt.job.kind as SupportJobKind) || recoverKind,
        entry?.organizationId,
      );
    } catch (errorValue) {
      if (commandGeneration === lifetime.generation) fail(errorValue);
    } finally {
      if (alive.current && commandGeneration === lifetime.generation) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function revoke(entry: Receipt) {
    if (!canGrant || busyRef.current || attemptRef.current || locked) return;
    const org = entry.organizationId || organizationId.trim();
    if (!validStaffJobId(org)) {
      setError("Enter the reviewed active organization UUID before revocation.");
      return;
    }
    if (
      !window.confirm(
        "Request irreversible revocation of this synthetic grant? The current authorized grant version will be read first. This does not renew or select it.",
      )
    )
      return;
    busyRef.current = true;
    setBusy(true);
    publishProtection(true);
    const commandGeneration = lifetime.generation;
    try {
      const current = await readReceipt(entry.receipt.job.id, entry.receipt.job.kind as SupportJobKind, org);
      if (!current || commandGeneration !== lifetime.generation) return;
      const command = snapshotSupportRevoke(lifetime, org, current.grant, crypto.randomUUID());
      busyRef.current = false;
      await execute(command);
    } catch (errorValue) {
      if (commandGeneration === lifetime.generation) fail(errorValue);
    } finally {
      if (alive.current && commandGeneration === lifetime.generation) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function readCrm(next?: string, id?: string) {
    if (busyRef.current || attemptRef.current) return;
    let current: StaffSupportSessionView;
    try {
      current = currentView();
      if (
        !supportContextUnexpired(current) ||
        !current.session.supportContext?.permissions.includes(resources[resource].permission)
      )
        throw new Error(
          "A current unexpired read permission is required. Verify or clear the selected context.",
        );
    } catch (errorValue) {
      fail(errorValue);
      return;
    }
    const readEpoch = ++epoch.current;
    const access = supportAccessIdentity(current);
    const commandGeneration = lifetime.generation;
    setReading(true);
    publishProtection(true);
    setError("");
    const org = current.session.supportContext!.organizationId;
    try {
      const response = await api<unknown>(
        `/dev/staff/support/organizations/${org}/crm/${resource}${id ? `/${id}` : `?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`}`,
      );
      if (!alive.current || readEpoch !== epoch.current || commandGeneration !== lifetime.generation) return;
      const live = lifetime.current;
      if (
        !live ||
        !propsRef.current.online ||
        !navigator.onLine ||
        !propsRef.current.verified ||
        supportAccessIdentity(live) !== access ||
        !supportContextUnexpired(live)
      ) {
        clearProjection();
        return;
      }
      if (
        response.headers.get("X-Synthetic-Support-Grant-Id") !== live.grant?.grantId ||
        parseStrongSupportEtag(response.headers.get("X-Synthetic-Support-Grant-ETag")) !==
          live.grant.grantEtag
      ) {
        const failure = new Error(
          "The response belongs to a changed support context. Verify staff access before another customer read.",
        );
        clearProjection();
        onUnverified(failure);
        throw failure;
      }
      const projection = verifyProjection(resource, response.data, Boolean(id));
      if (id) {
        const entity = projection as SupportResourceEntity[SupportResource];
        if (entity.id !== id) throw new Error("The record response did not match the requested UUID.");
        setDetail(entity);
      } else {
        const page = projection as SupportResourcePage[SupportResource];
        if (page.hasMore && !page.nextCursor) throw new Error("The authorized cursor could not be verified.");
        setRows((previous) =>
          next
            ? [...new Map([...(previous || []), ...page.items].map((item) => [item.id, item])).values()]
            : page.items,
        );
        setDetail(null);
        setCursor(page.nextCursor);
      }
      setReadAt(new Date().toISOString());
      setProjectionIdentity(access);
    } catch (errorValue) {
      const live = lifetime.current;
      if (
        alive.current &&
        readEpoch === epoch.current &&
        commandGeneration === lifetime.generation &&
        live &&
        propsRef.current.online &&
        propsRef.current.verified &&
        supportAccessIdentity(live) === access &&
        supportContextUnexpired(live)
      )
        fail(errorValue);
    } finally {
      if (alive.current && readEpoch === epoch.current) setReading(false);
    }
  }
  function discardKnown() {
    if (busyRef.current || (attemptRef.current && !["review", "rejected"].includes(attemptRef.current.state)))
      return;
    if (
      !window.confirm(
        "Discard this draft or known rejected request? Unknown commands must keep their original key and input.",
      )
    )
      return;
    attemptRef.current = null;
    setAttempt(null);
    setOrganizationId("");
    setRecipient("");
    setPurpose("");
    setPermissions([]);
    setGrantId("");
    setRecoverId("");
    setError("");
    setNotice("");
  }
  const blocked = busy || !online || !verified || !view;
  const context = view?.session.supportContext;
  const authorizedResources = (Object.keys(resources) as SupportResource[]).filter((name) =>
    context?.permissions.includes(resources[name].permission),
  );
  return (
    <section className={styles.card} aria-label="Synthetic support access">
      <h2>Synthetic support access</h2>
      <p>
        Separate staff authority. Grants permit only the explicitly selected CRM reads; no membership, notes,
        exports, writes or provider effects.
      </p>
      {locked && (
        <p className={styles.warning} role="status">
          Resolve the provisioning draft or operation before selecting support or creating another command.
        </p>
      )}
      {(!verified || !view) && (
        <p className={styles.warning} role="status">
          The current staff session needs verification. Original uncertain commands remain only in this tab.
        </p>
      )}
      {view?.supportState === "stale" && (
        <p className={styles.warning} role="status">
          The server reports a stale selection. Customer projections are clear; verified staff identity
          remains available for explicit clear.
        </p>
      )}
      {context && online && verified && selected ? (
        <div className={styles.notice} role="status">
          <div>
            <Badge tone="warning">Synthetic · read only</Badge>
            <p>Purpose: {context.reason}</p>
            <p>Organization {context.organizationId}</p>
            <p>Fixed expiry {context.expiresAt}. Every read is reauthorized by the server.</p>
          </div>
        </div>
      ) : (
        <p className={styles.muted}>
          No currently usable customer projection is shown. Offline, expired, stale and unverified contexts
          cannot display records.
        </p>
      )}
      {context && !selected && (
        <p className={styles.warning} role="status">
          The selected expiry has elapsed. Verify the current session or explicitly clear; no grant is
          renewed.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!online || busy} onClick={() => void onVerifySession()}>
          Verify current support context
        </Button>
        <Button
          variant="secondary"
          disabled={blocked || Boolean(attempt) || view?.supportState === "none"}
          onClick={clearSelection}
        >
          Clear selected support context
        </Button>
      </div>
      {attempt && (
        <div className={styles.warning} role="status">
          <h3>Original support command: {attempt.command.kind}</h3>
          <p>
            State: {attempt.state}. Its exact key, input, expiry and grant revision stay unchanged in memory.
          </p>
          <label>
            Original support command key
            <input readOnly value={attempt.command.idempotencyKey} />
          </label>
          <div className={styles.actions}>
            <Button
              disabled={blocked || !canReconcileSupportCommand(lifetime, attempt.command)}
              onClick={() => void execute(attempt.command)}
            >
              Reconcile original support command
            </Button>
            {["review", "rejected"].includes(attempt.state) && (
              <Button variant="quiet" disabled={busy} onClick={discardKnown}>
                Discard reviewed rejected command
              </Button>
            )}
          </div>
          {attempt.state === "review" && (
            <p>
              Read the current session before reviewing a new command. No new key or expiry is created
              automatically.
            </p>
          )}
        </div>
      )}
      <form onSubmit={selectGrant}>
        <h3>Explicitly select a known grant</h3>
        <fieldset disabled={blocked || locked || Boolean(attempt)}>
          <div className={styles.fields}>
            <label>
              Active organization UUID
              <input
                required
                value={organizationId}
                maxLength={36}
                autoComplete="off"
                onChange={(event) => {
                  publishProtection(true);
                  setOrganizationId(event.target.value);
                }}
              />
            </label>
            <label>
              Known support grant UUID
              <input
                required
                value={grantId}
                maxLength={36}
                autoComplete="off"
                onChange={(event) => {
                  publishProtection(true);
                  setGrantId(event.target.value);
                }}
              />
            </label>
          </div>
          <p className={styles.muted}>
            The server verifies recipient, organization, permissions and original expiry. Entering a UUID
            establishes no authority.
          </p>
          <Button type="submit">Select synthetic read-only grant</Button>
        </fieldset>
      </form>
      {canGrant ? (
        <form onSubmit={createGrant}>
          <h3>Create a short synthetic support grant</h3>
          <fieldset disabled={blocked || locked || Boolean(attempt) || view?.supportState !== "none"}>
            <label>
              Recipient staff UUID
              <input
                required
                value={recipient}
                maxLength={36}
                autoComplete="off"
                onChange={(event) => {
                  publishProtection(true);
                  setRecipient(event.target.value);
                }}
              />
            </label>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                if (view) {
                  publishProtection(true);
                  setRecipient(view.session.staffUserId);
                }
              }}
            >
              Use current verified staff UUID
            </Button>
            <label>
              Nonblank support purpose
              <input
                required
                value={purpose}
                maxLength={1000}
                onChange={(event) => {
                  publishProtection(true);
                  setPurpose(event.target.value);
                }}
              />
            </label>
            <label>
              Fixed short expiry
              <select
                value={minutes}
                onChange={(event) => {
                  publishProtection(true);
                  setMinutes(event.target.value);
                }}
              >
                <option value="5">5 minutes</option>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="45">45 minutes</option>
              </select>
            </label>
            <fieldset>
              <legend>Choose one to seven read permissions</legend>
              {supportReadPermissions.map((permission) => (
                <label className={styles.checkbox} style={{ minHeight: 44 }} key={permission}>
                  <input
                    type="checkbox"
                    checked={permissions.includes(permission)}
                    onChange={(event) => {
                      publishProtection(true);
                      setPermissions((previous) =>
                        event.target.checked
                          ? [...previous, permission]
                          : previous.filter((item) => item !== permission),
                      );
                    }}
                  />
                  {permission}
                </label>
              ))}
            </fieldset>
            <p className={styles.muted}>
              The database enforces a maximum one-hour lifetime. The original expiry is frozen before sending;
              replay cannot renew it. Customer writes remain unavailable.
            </p>
            <Button
              type="submit"
              disabled={
                !purpose.trim() || !recipient.trim() || permissions.length === 0 || !organizationId.trim()
              }
            >
              Create synthetic support grant
            </Button>
          </fieldset>
        </form>
      ) : (
        <p className={styles.muted}>The current staff identity has no platform support-grant permission.</p>
      )}
      {dirty && !attempt && (
        <Button variant="quiet" disabled={busy} onClick={discardKnown}>
          Discard support draft
        </Button>
      )}
      <form className={styles.recover} onSubmit={(event) => void recover(event)}>
        <label>
          Requester support operation UUID
          <input
            value={recoverId}
            maxLength={36}
            autoComplete="off"
            onChange={(event) => {
              publishProtection(true);
              setRecoverId(event.target.value);
            }}
          />
        </label>
        <label>
          Expected support operation kind
          <select
            value={recoverKind}
            onChange={(event) => setRecoverKind(event.target.value as SupportJobKind)}
          >
            <option value="staff.support.grant">Grant creation</option>
            <option value="staff.support.revoke">Grant revocation</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={blocked || !recoverId.trim()}>
          Read authorized support operation
        </Button>
      </form>
      {receipts.length === 0 && (
        <p className={styles.muted}>No support operation has been acknowledged or recovered.</p>
      )}
      {receipts.map((entry) => (
        <article className={styles.operation} key={entry.receipt.job.id}>
          <div>
            <h3>{entry.receipt.job.kind}</h3>
            <Badge tone={entry.receipt.job.state === "succeeded" ? "positive" : "warning"}>
              {entry.receipt.job.state}
            </Badge>
            <label>
              Support operation ID
              <input readOnly value={entry.receipt.job.id} />
            </label>
            <label>
              Current authorized grant reference
              <input readOnly value={entry.receipt.grant.grantId} />
            </label>
            <p className={styles.muted}>
              Last read {entry.checkedAt}. Grant revision {entry.receipt.grant.grantEtag}; Job transport ETag
              is separate.
            </p>
            <p>
              Historical command acknowledgement does not prove current grant eligibility, selection or
              renewed expiry.
            </p>
            {entry.receipt.job.error && (
              <p className={styles.error}>
                {entry.receipt.job.error.detail || entry.receipt.job.error.title}
              </p>
            )}
          </div>
          <div className={styles.actions}>
            <Button variant="secondary" disabled={blocked} onClick={() => void recover(undefined, entry)}>
              Refresh support operation
            </Button>
            {canGrant && (
              <Button
                variant="quiet"
                disabled={blocked || locked || Boolean(attempt) || view?.supportState !== "none"}
                onClick={() => void revoke(entry)}
              >
                Review irreversible grant revocation
              </Button>
            )}
          </div>
        </article>
      ))}
      <section aria-label="Read-only customer CRM">
        <h3>Authorized CRM reads</h3>
        <p className={styles.muted}>
          Records stay in memory and clear on context change, offline access, expiry or denial. Select a
          resource and explicitly request it.
        </p>
        <label>
          Read-only resource
          <select
            value={resource}
            disabled={!selected || blocked || reading}
            onChange={(event) => {
              clearProjection();
              setResource(event.target.value as SupportResource);
            }}
          >
            {(Object.keys(resources) as SupportResource[]).map((name) => (
              <option key={name} value={name} disabled={!authorizedResources.includes(name)}>
                {resources[name].label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={
            blocked || !selected || reading || Boolean(attempt) || !authorizedResources.includes(resource)
          }
          onClick={() => void readCrm()}
        >
          Read authorized {resources[resource].label.toLowerCase()}
        </Button>
        {reading && <p role="status">Reading the currently authorized synthetic projection…</p>}
        {online && verified && selected && projectionIdentity === identity && rows !== null && (
          <>
            <p className={styles.muted}>
              Last authorized read {readAt}.{" "}
              {rows.length === 0
                ? "The server returned no records on this page."
                : "Only server-returned records are shown."}
            </p>
            <div className={styles.orgGrid}>
              {rows.map((item) => (
                <article className={styles.org} key={item.id}>
                  <div>
                    <h4>{supportRecordSummary(item)}</h4>
                    <p className={styles.muted}>{item.id}</p>
                    <Button
                      variant="quiet"
                      disabled={blocked || reading || Boolean(attempt)}
                      onClick={() => void readCrm(undefined, item.id)}
                    >
                      Read record details
                    </Button>
                  </div>
                </article>
              ))}
            </div>
            {cursor && (
              <Button
                variant="secondary"
                disabled={blocked || reading || Boolean(attempt)}
                onClick={() => void readCrm(cursor)}
              >
                Read next authorized page
              </Button>
            )}
          </>
        )}
        {online && verified && selected && projectionIdentity === identity && detail && (
          <article className={styles.org}>
            <div>
              <h4>{supportRecordSummary(detail)}</h4>
              <SupportRecordDetails item={detail} />
            </div>
          </article>
        )}
      </section>
    </section>
  );
}
