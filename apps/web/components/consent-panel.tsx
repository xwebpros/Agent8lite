"use client";

import { FlaskConical, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConsentPurpose,
  SyntheticConsentChannelsResponse,
  SyntheticEvidenceRequest,
  SyntheticEvidenceResponse,
} from "../../../packages/contracts/internal/consent-port";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  session: Schema<"Session">;
  memberId: string;
  scope: "own" | "authorized";
  online: boolean;
  working: boolean;
  runCommand: <T>(
    path: string,
    body: unknown,
    method?: string,
    version?: number,
    receiveHeaders?: (headers: Headers) => void,
    explicitKey?: string,
  ) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
type EvidenceAttempt = { body: SyntheticEvidenceRequest; key: string };
type LedgerAttempt = { body: Schema<"ConsentWrite">; key: string };
type Recorded = LedgerAttempt & { job: Schema<"Job"> };
const policy = "synthetic-communication-v1" as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const labels: Record<ConsentPurpose, string> = {
  email_marketing: "Email marketing",
  sms_marketing: "SMS marketing",
  listing_alert: "Email listing alerts",
};
const isPending = (job: Schema<"Job">) => ["queued", "running", "unknown"].includes(job.state);
const ambiguous = (err: unknown) => !(err instanceof ApiError) || err.status >= 500 || err.status === 408;

export default function ConsentPanel({
  session,
  memberId,
  scope,
  online,
  working,
  runCommand,
  onDirty,
  setWorking,
}: Props) {
  const [contacts, setContacts] = useState<Schema<"Contact">[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [choicesLoaded, setChoicesLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [contactId, setContactId] = useState("");
  const [channels, setChannels] = useState<SyntheticConsentChannelsResponse["channels"]>([]);
  const [channelId, setChannelId] = useState("");
  const [purpose, setPurpose] = useState<ConsentPurpose>("email_marketing");
  const [action, setAction] = useState<Schema<"ConsentWrite">["action"]>("withdraw");
  const [reviewed, setReviewed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [evidenceAttempt, setEvidenceAttempt] = useState<EvidenceAttempt | null>(null);
  const [proof, setProof] = useState<SyntheticEvidenceResponse | null>(null);
  const [ledgerAttempt, setLedgerAttempt] = useState<LedgerAttempt | null>(null);
  const [currentKey, setCurrentKey] = useState("");
  const [history, setHistory] = useState<Recorded[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const epoch = useRef(0);
  const channelEpoch = useRef(0);
  const lifetime = useRef(0);
  const checkingRef = useRef(false);
  const commandInFlight = useRef(false);
  const evidenceSnapshot = useRef<EvidenceAttempt | null>(null);
  const ledgerSnapshot = useRef<LedgerAttempt | null>(null);
  const protectedRef = useRef(false);
  const firstInput = useRef<HTMLSelectElement>(null);
  const current = history.find((item) => item.key === currentKey);
  const pending = history.some((item) => isPending(item.job));
  const locked = Boolean(evidenceAttempt || ledgerAttempt);
  const expired = Boolean(proof && new Date(proof.expiresAt).getTime() <= now);
  const channel = channels.find((item) => item.id === channelId);
  const canRecord = ["consent.write", "crm.contacts.read", "crm.contacts.write"].every((code) =>
    session.permissions.includes(code),
  );
  const canReadJobs = session.permissions.includes("jobs.read");
  const base = `/v1/orgs/${session.activeOrgId}`;
  protectedRef.current = dirty || uncertain || pending || working;

  const clearPrivate = useCallback(() => {
    ++epoch.current;
    ++channelEpoch.current;
    ++lifetime.current;
    setContacts([]);
    setChannels([]);
    setCursor(null);
    setChoicesLoaded(false);
    setContactId("");
    setChannelId("");
    setEvidenceAttempt(null);
    evidenceSnapshot.current = null;
    setProof(null);
    setLedgerAttempt(null);
    ledgerSnapshot.current = null;
    setHistory([]);
    setCurrentKey("");
    setReviewed(false);
    setDirty(false);
    setUncertain(false);
    setRejected(false);
    setLoading(false);
    setChecking(false);
    checkingRef.current = false;
    setAccessDenied(true);
    setNotice("");
  }, []);
  const failure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
      setError(err instanceof Error ? err.message : "Consent operation unavailable.");
    },
    [clearPrivate],
  );
  const loadContacts = useCallback(
    async (next?: string) => {
      if (!online || !canRecord || !session.activeOrgId || accessDenied) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      const filter =
        scope === "own" && memberId
          ? `&filter=${encodeURIComponent(JSON.stringify({ ownerMemberId: memberId } satisfies Schema<"LeadFilter">))}`
          : "";
      try {
        const response = await api<Schema<"PageContact">>(
          `${base}/contacts?limit=25${filter}${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setContacts((previous) => (next ? [...previous, ...response.data.items] : response.data.items));
        setCursor(response.data.nextCursor);
        setChoicesLoaded(true);
      } catch (err) {
        if (generation === epoch.current) failure(err);
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [online, canRecord, session.activeOrgId, accessDenied, scope, memberId, base, failure],
  );
  useEffect(() => {
    if (!protectedRef.current) void loadContacts();
  }, [loadContacts]);
  useEffect(() => {
    onDirty(dirty || uncertain || pending);
  }, [dirty, uncertain, pending, onDirty]);
  useEffect(
    () => () => {
      ++epoch.current;
      ++channelEpoch.current;
      ++lifetime.current;
      onDirty(false);
    },
    [onDirty],
  );
  useEffect(() => {
    if (!proof) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [proof]);

  async function chooseContact(id: string) {
    if (locked || working || loading || accessDenied || !online || !canRecord) return;
    const generation = ++channelEpoch.current;
    setContactId(id);
    setChannels([]);
    setChannelId("");
    setReviewed(false);
    setDirty(Boolean(id));
    setError("");
    setNotice("");
    if (!id) return;
    setLoading(true);
    try {
      const response = await api<SyntheticConsentChannelsResponse>(`/dev/consent-channels/${id}`);
      if (generation !== channelEpoch.current) return;
      if (
        response.data.contactId !== id ||
        !Array.isArray(response.data.channels) ||
        response.data.channels.some((item) => !uuid.test(item.id) || !["email", "phone"].includes(item.kind))
      )
        throw new Error("Synthetic channel response could not be verified.");
      setChannels(response.data.channels);
    } catch (err) {
      if (generation === channelEpoch.current) failure(err);
    } finally {
      if (generation === channelEpoch.current) setLoading(false);
    }
  }
  async function issueEvidence() {
    if (
      !online ||
      working ||
      loading ||
      commandInFlight.current ||
      accessDenied ||
      !canRecord ||
      !channelId ||
      action !== "grant" ||
      ledgerAttempt
    )
      return;
    const generation = lifetime.current;
    const attempt = evidenceSnapshot.current || {
      body: { contactChannelId: channelId, purpose },
      key: crypto.randomUUID(),
    };
    commandInFlight.current = true;
    evidenceSnapshot.current = attempt;
    setEvidenceAttempt(attempt);
    setDirty(true);
    setWorking(true);
    setError("");
    setNotice("");
    setRejected(false);
    try {
      const response = await runCommand<SyntheticEvidenceResponse>(
        "/dev/consent-evidence",
        attempt.body,
        "POST",
        undefined,
        undefined,
        attempt.key,
      );
      if (generation !== lifetime.current) return;
      if (
        response.synthetic !== true ||
        response.policyVersion !== policy ||
        !response.evidenceRef.startsWith("synthetic-evidence:") ||
        !uuid.test(response.evidenceRef.slice("synthetic-evidence:".length)) ||
        !Number.isFinite(new Date(response.expiresAt).getTime()) ||
        Boolean(
          proof && (response.evidenceRef !== proof.evidenceRef || response.expiresAt !== proof.expiresAt),
        )
      )
        throw new Error("The evidence response could not be verified. Reconcile this exact request.");
      setProof(response);
      setNow(Date.now());
      setUncertain(false);
      setNotice(
        "Synthetic evidence returned. Replaying this request returns the same proof and never extends its consumption deadline.",
      );
    } catch (err) {
      if (generation !== lifetime.current) return;
      setUncertain(ambiguous(err));
      setRejected(!ambiguous(err));
      failure(err);
    } finally {
      commandInFlight.current = false;
      setWorking(false);
    }
  }
  function updateHistory(attempt: LedgerAttempt, job: Schema<"Job">) {
    setHistory((previous) => {
      const found = previous.some((item) => item.key === attempt.key);
      return found
        ? previous.map((item) => (item.key === attempt.key ? { ...attempt, job } : item))
        : [{ ...attempt, job }, ...previous];
    });
  }
  async function recordConsent(replay?: Recorded) {
    if (!online || working || commandInFlight.current || accessDenied || loading || !canRecord) return;
    if (
      !replay &&
      !ledgerAttempt &&
      (!reviewed ||
        !channelId ||
        (action === "grant" && (!proof || new Date(proof.expiresAt).getTime() <= Date.now())))
    )
      return;
    const generation = lifetime.current;
    const attempt: LedgerAttempt = replay ||
      ledgerSnapshot.current || {
        key: crypto.randomUUID(),
        body: {
          contactChannelId: channelId,
          purpose,
          action,
          policyVersion: action === "grant" ? proof!.policyVersion : policy,
          evidenceRef: action === "grant" ? proof!.evidenceRef : `staff-withdrawal:${crypto.randomUUID()}`,
        },
      };
    commandInFlight.current = true;
    if (!replay) {
      ledgerSnapshot.current = attempt;
      setLedgerAttempt(attempt);
      setCurrentKey(attempt.key);
      setDirty(true);
    }
    setWorking(true);
    setError("");
    setNotice("");
    setRejected(false);
    try {
      const job = await runCommand<Schema<"Job">>(
        `${base}/consent-events`,
        attempt.body,
        "POST",
        undefined,
        undefined,
        attempt.key,
      );
      if (generation !== lifetime.current) return;
      if (
        !uuid.test(job.id) ||
        job.kind !== "consent.record" ||
        !["queued", "running", "succeeded", "failed", "cancelled", "unknown"].includes(job.state)
      )
        throw new Error("The ledger result could not be verified. Reconcile this exact command.");
      updateHistory(attempt, job);
      setUncertain(false);
      if (!replay) {
        setDirty(isPending(job));
        setProof(null);
      }
      setNotice(
        job.state === "succeeded"
          ? "The historical ledger command committed. Current consent eligibility and delivery are unavailable here."
          : "The server returned a durable operation. Its reported state is shown below; current eligibility is unavailable.",
      );
    } catch (err) {
      if (generation !== lifetime.current) return;
      if (!replay) {
        setUncertain(ambiguous(err));
        setRejected(!ambiguous(err));
      }
      failure(err);
    } finally {
      commandInFlight.current = false;
      setWorking(false);
    }
  }
  const checkJobs = useCallback(async () => {
    if (!online || !canReadJobs || !session.activeOrgId || checkingRef.current || accessDenied) return;
    const generation = lifetime.current;
    const targets = history.filter((item) => isPending(item.job));
    if (!targets.length) return;
    checkingRef.current = true;
    setChecking(true);
    setError("");
    try {
      const responses = await Promise.all(
        targets.map((item) => api<Schema<"Job">>(`${base}/jobs/${item.job.id}`)),
      );
      if (generation !== lifetime.current) return;
      responses.forEach((response, index) => {
        if (response.data.id !== targets[index].job.id || response.data.kind !== "consent.record")
          throw new Error("Operation identity changed. Current state is unavailable.");
      });
      setHistory((previous) =>
        previous.map((item) => {
          const response = responses.find((value) => value.data.id === item.job.id);
          return response ? { ...item, job: response.data } : item;
        }),
      );
      const active = responses.find((item) => item.data.id === current?.job.id);
      if (active && !isPending(active.data)) setDirty(false);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      if (generation === lifetime.current) {
        checkingRef.current = false;
        setChecking(false);
      }
    }
  }, [online, canReadJobs, session.activeOrgId, accessDenied, history, base, current?.job.id, failure]);
  useEffect(() => {
    if (!pending || !online || !canReadJobs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !working) void checkJobs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, online, canReadJobs, working, checkJobs]);
  function resetWorkflow() {
    if (
      working ||
      loading ||
      commandInFlight.current ||
      uncertain ||
      pending ||
      (ledgerAttempt && !current && !rejected)
    )
      return;
    if (
      dirty &&
      !window.confirm(
        "Discard this synthetic consent draft and its unused proof? Recorded ledger history stays in memory.",
      )
    )
      return;
    ++channelEpoch.current;
    setContactId("");
    setChannelId("");
    setChannels([]);
    setEvidenceAttempt(null);
    evidenceSnapshot.current = null;
    setProof(null);
    setLedgerAttempt(null);
    ledgerSnapshot.current = null;
    setCurrentKey("");
    setReviewed(false);
    setDirty(false);
    setRejected(false);
    setError("");
    setNotice("");
    setAction("withdraw");
    setPurpose("email_marketing");
    window.requestAnimationFrame(() => firstInput.current?.focus());
  }

  if (!canRecord)
    return (
      <Empty icon={<ShieldCheck size={30} />} title="Synthetic consent unavailable">
        Current consent and contact read/write permissions are required. The server checks current source
        scope for every command.
      </Empty>
    );
  return (
    <section className="consent-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">LOCAL SYNTHETIC DEMONSTRATION</p>
          <h2>Consent ledger</h2>
          <p className="muted">
            Review one channel and purpose, then explicitly record a grant or withdrawal.
          </p>
        </div>
        <Badge tone="warning">Synthetic · no delivery</Badge>
      </div>
      <div className="synthetic-note">
        <FlaskConical size={20} aria-hidden="true" />
        <p>
          This demonstration uses a synthetic policy and server-issued proof. No legal policy is approved, no
          message is sent, and a succeeded operation does not show current marketing eligibility.
        </p>
      </div>
      <div className="consent-readback-note">
        <ShieldCheck size={20} aria-hidden="true" />
        <p>
          Current consent and suppression readback is unavailable in the published API. This page shows
          historical command results only. The picker includes active contacts and channels; withdrawal for a
          preserved archived or inactive channel needs an authorized known ID and is not offered by this
          picker.
        </p>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success-message" role="status">
          {notice}
        </p>
      )}
      {!online && (
        <p className="form-error" role="status">
          Offline: drafts remain in this tab. Reconnect to read channels or reconcile commands.
        </p>
      )}
      {accessDenied ? (
        <Empty icon={<ShieldCheck size={30} />} title="Access changed">
          Private drafts, proof references and history were cleared. Refresh account access before reopening
          this workflow.
        </Empty>
      ) : (
        <>
          <section className="panel settings-card consent-editor">
            <h3>Review a synthetic consent command</h3>
            <div className="settings-form">
              <fieldset disabled={working || loading || !online || locked || !choicesLoaded}>
                <legend className="visually-hidden">Synthetic consent source and purpose</legend>
                <label htmlFor="consent-contact">
                  Contact
                  <select
                    ref={firstInput}
                    id="consent-contact"
                    value={contactId}
                    onChange={(event) => void chooseContact(event.target.value)}
                  >
                    <option value="">Select an authorized contact</option>
                    {contacts.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {cursor && (
                  <Button type="button" variant="quiet" onClick={() => void loadContacts(cursor)}>
                    Load more contacts
                  </Button>
                )}
                {!loading && choicesLoaded && !contacts.length && (
                  <p className="muted">No active contacts were returned in the current workspace scope.</p>
                )}
                <label htmlFor="consent-channel">
                  Channel
                  <select
                    id="consent-channel"
                    value={channelId}
                    disabled={!contactId || !channels.length}
                    onChange={(event) => {
                      const id = event.target.value;
                      setChannelId(id);
                      setPurpose(
                        channels.find((item) => item.id === id)?.kind === "phone"
                          ? "sms_marketing"
                          : "email_marketing",
                      );
                      setReviewed(false);
                      setDirty(true);
                    }}
                  >
                    <option value="">Select a generic channel</option>
                    {channels.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {contactId && !loading && !channels.length && (
                  <p className="muted">
                    No active channels are available. This page cannot record consent using contact details
                    alone.
                  </p>
                )}
                <div className="form-two-column">
                  <label htmlFor="consent-action">
                    Action
                    <select
                      id="consent-action"
                      value={action}
                      onChange={(event) => {
                        setAction(event.target.value as Schema<"ConsentWrite">["action"]);
                        setReviewed(false);
                        setDirty(true);
                      }}
                    >
                      <option value="withdraw">Staff withdrawal</option>
                      <option value="grant">Synthetic grant</option>
                    </select>
                  </label>
                  <label htmlFor="consent-purpose">
                    Purpose
                    <select
                      id="consent-purpose"
                      value={purpose}
                      disabled={!channel}
                      onChange={(event) => {
                        setPurpose(event.target.value as ConsentPurpose);
                        setReviewed(false);
                        setDirty(true);
                      }}
                    >
                      {(channel?.kind === "phone"
                        ? ["sms_marketing" as const]
                        : ["email_marketing" as const, "listing_alert" as const]
                      ).map((item) => (
                        <option key={item} value={item}>
                          {labels[item]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
              {loading && (
                <p className="muted" role="status">
                  Reading authorized synthetic choices…
                </p>
              )}
              {action === "grant" && !ledgerAttempt && (
                <div className="consent-proof">
                  <h4>Server-issued synthetic evidence</h4>
                  <p className="muted">
                    The proof is bound to this member, channel, purpose and current revisions. It can be
                    consumed once, within the server’s fifteen-minute deadline. That deadline does not expire
                    an already recorded grant.
                  </p>
                  {proof && (
                    <>
                      <p>
                        <Badge tone={expired ? "warning" : "neutral"}>
                          {expired ? "Consumption deadline passed" : "Synthetic proof returned"}
                        </Badge>
                      </p>
                      <dl>
                        <div>
                          <dt>Policy</dt>
                          <dd>{proof.policyVersion}</dd>
                        </div>
                        <div>
                          <dt>Consumption deadline</dt>
                          <dd>
                            {new Intl.DateTimeFormat("en-US", {
                              dateStyle: "medium",
                              timeStyle: "short",
                              timeZone: session.profile.timezone,
                            }).format(new Date(proof.expiresAt))}
                          </dd>
                        </div>
                      </dl>
                    </>
                  )}
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={
                      working || loading || !online || !channelId || Boolean(uncertain && ledgerAttempt)
                    }
                    onClick={() => void issueEvidence()}
                  >
                    {working
                      ? "Requesting…"
                      : evidenceAttempt
                        ? "Reconcile original evidence request"
                        : "Issue synthetic evidence"}
                  </Button>
                  {evidenceAttempt && (
                    <p className="muted">
                      Inputs are frozen. Reconciliation uses the original request key and never renews an
                      expired or consumed proof.
                    </p>
                  )}
                </div>
              )}
              {action === "withdraw" && (
                <p className="muted">
                  Staff withdrawal needs no grant proof and remains permitted without a commercial capability,
                  subject to current membership, consent permission and contact scope.
                </p>
              )}
              {!ledgerAttempt && (
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={
                      working ||
                      loading ||
                      !online ||
                      !channelId ||
                      (action === "grant" && (!proof || expired)) ||
                      uncertain
                    }
                    onChange={(event) => {
                      setReviewed(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  <span>
                    {action === "grant"
                      ? "I reviewed this channel and purpose and explicitly authorize this synthetic grant demonstration."
                      : "I reviewed this channel and purpose and explicitly request a staff withdrawal."}
                  </span>
                </label>
              )}
              {uncertain && (
                <p className="form-error" role="status">
                  The response is ambiguous. Keep the frozen input and reconcile the original request;
                  starting another command is disabled.
                </p>
              )}
              <div className="consent-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    working ||
                    loading ||
                    uncertain ||
                    pending ||
                    Boolean(ledgerAttempt && !current && !rejected)
                  }
                  onClick={resetWorkflow}
                >
                  {current ? "Start another reviewed command" : "Discard consent draft"}
                </Button>
                <Button
                  type="button"
                  disabled={
                    working ||
                    loading ||
                    !online ||
                    (ledgerAttempt
                      ? Boolean(current && !uncertain)
                      : !reviewed || !channelId || (action === "grant" && (!proof || expired)) || uncertain)
                  }
                  onClick={() => void recordConsent()}
                >
                  {working
                    ? "Recording…"
                    : ledgerAttempt
                      ? "Reconcile original consent command"
                      : action === "grant"
                        ? "Record synthetic grant"
                        : "Record staff withdrawal"}
                </Button>
              </div>
            </div>
          </section>
          {history.length > 0 && (
            <section className="panel consent-history">
              <div className="panel-heading">
                <div>
                  <h3>Historical ledger operations</h3>
                  <p className="muted">
                    These results are held in memory for this session and do not report current eligibility.
                  </p>
                </div>
                {pending && canReadJobs && (
                  <Button
                    variant="secondary"
                    disabled={!online || working || checking}
                    onClick={() => void checkJobs()}
                  >
                    <RefreshCw size={16} />
                    {checking ? "Checking…" : "Check pending operations"}
                  </Button>
                )}
              </div>
              {history.map((item) => (
                <article key={item.key} className="consent-operation">
                  <div>
                    <h4>
                      {item.body.action === "grant" ? "Synthetic grant" : "Staff withdrawal"} ·{" "}
                      {labels[item.body.purpose]}
                    </h4>
                    <p className="muted">Operation {item.job.id}</p>
                    <Badge tone={item.job.state === "succeeded" ? "positive" : "warning"}>
                      {item.job.state}
                    </Badge>
                    <p className="muted">
                      {item.job.state === "succeeded"
                        ? "This ledger command committed. A later withdrawal may supersede it."
                        : "Only the server’s last reported operation state is shown."}
                    </p>
                    {item.job.error && (
                      <p className="form-error" role="status">
                        {item.job.error.detail || item.job.error.title}
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!online || working || dirty || uncertain || pending}
                    onClick={() => void recordConsent(item)}
                  >
                    Replay original ledger command
                  </Button>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
