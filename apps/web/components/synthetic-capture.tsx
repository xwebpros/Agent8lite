"use client";

import Link from "next/link";
import { FlaskConical, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  NativeCaptureDecision,
  NativeCaptureV1,
} from "../../../packages/contracts/internal/capture-port";
import { Badge, Button } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  session: Schema<"Session">;
  memberId: string;
  scope: "own" | "authorized";
  online: boolean;
  working: boolean;
  contacts: Schema<"Contact">[];
  sources: Schema<"LeadSource">[];
  runCommand: <T>(
    path: string,
    body: unknown,
    method?: string,
    version?: number,
    receiveHeaders?: (headers: Headers) => void,
  ) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
  onSaved(): Promise<void>;
};
const explanations: Record<string, string> = {
  first_touch_selected: "An eligible existing first-touch owner was selected.",
  first_touch_unavailable: "No eligible first-touch owner was available.",
  listing_attribution_unavailable: "Listing attribution is unavailable in the mock environment.",
  geography_selected: "The postal rule selected an eligible weighted recipient.",
  geography_unmatched: "No submitted postal code matched this rule.",
  round_robin_selected: "Weighted round robin selected an eligible recipient.",
  no_eligible_recipient: "The rule had no recipient eligible in the current scope.",
  unassigned_queue: "The server retained the opportunity in an unassigned queue.",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export default function SyntheticCapture({
  session,
  memberId,
  scope,
  online,
  working,
  contacts,
  sources,
  runCommand,
  onDirty,
  setWorking,
  onSaved,
}: Props) {
  const [contactOptions, setContactOptions] = useState(contacts);
  const [sourceOptions, setSourceOptions] = useState(sources);
  const [contactCursor, setContactCursor] = useState<string | null>(null);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [choicesLoaded, setChoicesLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [contactId, setContactId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [intent, setIntent] = useState<NativeCaptureV1["intent"]>("unknown");
  const [timeline, setTimeline] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [submissionId, setSubmissionId] = useState("");
  const [submitted, setSubmitted] = useState<NativeCaptureV1 | null>(null);
  const [lead, setLead] = useState<Schema<"Lead"> | null>(null);
  const [decision, setDecision] = useState<NativeCaptureDecision | null>(null);
  const [syntheticVerified, setSyntheticVerified] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [choiceError, setChoiceError] = useState("");
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const protectedRef = useRef(false);
  const firstInput = useRef<HTMLSelectElement>(null);
  protectedRef.current = dirty || Boolean(submitted && !lead);
  const base = `/v1/orgs/${session.activeOrgId}`;
  const filter =
    scope === "own" && memberId
      ? `&filter=${encodeURIComponent(JSON.stringify({ ownerMemberId: memberId } satisfies Schema<"LeadFilter">))}`
      : "";
  const canCapture = [
    "crm.contacts.read",
    "crm.contacts.write",
    "crm.leads.read",
    "crm.leads.write",
    "crm.sources.read",
  ].every((code) => session.permissions.includes(code));
  const clearPrivate = useCallback(() => {
    ++epoch.current;
    ++lifetime.current;
    setContactOptions([]);
    setSourceOptions([]);
    setContactCursor(null);
    setSourceCursor(null);
    setContactId("");
    setSourceId("");
    setTimeline("");
    setPostalCode("");
    setSubmitted(null);
    setLead(null);
    setDecision(null);
    setSyntheticVerified(false);
    setDirty(false);
    setUncertain(false);
    setRejected(false);
    setChoicesLoaded(false);
    setLoading(false);
    setNotice("");
  }, []);
  const loadChoices = useCallback(
    async (resource?: "contacts" | "lead-sources", cursor?: string) => {
      if (!online || !session.activeOrgId || !canCapture || (scope === "own" && !memberId)) return;
      const generation = ++epoch.current;
      setLoading(true);
      setChoiceError("");
      const results = await Promise.allSettled([
        !resource || resource === "contacts"
          ? api<Schema<"PageContact">>(
              `${base}/contacts?limit=25${filter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
        !resource || resource === "lead-sources"
          ? api<Schema<"PageLeadSource">>(
              `${base}/lead-sources?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            )
          : Promise.resolve(null),
      ]);
      if (generation !== epoch.current) return;
      const [contactPage, sourcePage] = results;
      if (contactPage.status === "fulfilled" && contactPage.value) {
        setContactOptions((current) =>
          cursor ? [...current, ...contactPage.value!.data.items] : contactPage.value!.data.items,
        );
        setContactCursor(contactPage.value.data.nextCursor);
      }
      if (sourcePage.status === "fulfilled" && sourcePage.value) {
        setSourceOptions((current) =>
          cursor ? [...current, ...sourcePage.value!.data.items] : sourcePage.value!.data.items,
        );
        setSourceCursor(sourcePage.value.data.nextCursor);
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        setChoiceError(
          failed.reason instanceof Error ? failed.reason.message : "Authorized choices unavailable.",
        );
        setChoicesLoaded(false);
        if (failed.reason instanceof ApiError && [401, 403].includes(failed.reason.status)) clearPrivate();
      } else setChoicesLoaded(true);
      setLoading(false);
    },
    [online, session.activeOrgId, canCapture, scope, memberId, base, filter, clearPrivate],
  );
  useEffect(() => {
    if (!protectedRef.current) void loadChoices();
    return () => {
      ++epoch.current;
    };
  }, [loadChoices]);
  useEffect(() => {
    setSubmissionId(crypto.randomUUID());
  }, []);
  useEffect(() => {
    onDirty(dirty || Boolean(submitted && !lead));
  }, [dirty, submitted, lead, onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
      onDirty(false);
    },
    [onDirty],
  );
  useEffect(() => {
    if (!canCapture) clearPrivate();
  }, [canCapture, clearPrivate]);
  function restart() {
    if (working || uncertain || (submitted && !lead && !rejected)) return;
    if (dirty && !window.confirm("Discard this unsaved synthetic submission?")) return;
    setSubmitted(null);
    setLead(null);
    setDecision(null);
    setSyntheticVerified(false);
    setDirty(false);
    setRejected(false);
    setUncertain(false);
    setNotice("");
    setError("");
    setContactId("");
    setSourceId("");
    setIntent("unknown");
    setTimeline("");
    setPostalCode("");
    setSubmissionId(crypto.randomUUID());
    firstInput.current?.focus();
  }
  async function capture(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!online || working || loading || !canCapture || !submissionId || !contactId || !sourceId) return;
    const input: NativeCaptureV1 = submitted || {
      sourceSubmissionId: submissionId,
      contactId,
      sourceId,
      intent,
      ...(timeline.trim() ? { timeline: timeline.trim() } : {}),
      ...(postalCode.trim() ? { postalCode: postalCode.trim().toUpperCase() } : {}),
    };
    const generation = lifetime.current;
    setSubmitted(input);
    setWorking(true);
    setError("");
    setNotice("");
    setRejected(false);
    let metadata = new Headers();
    try {
      const result = await runCommand<Schema<"Lead">>("/dev/capture", input, "POST", undefined, (headers) => {
        metadata = headers;
      });
      if (generation !== lifetime.current) return;
      const decisionId = metadata.get("X-Capture-Decision-Id");
      const ruleId = metadata.get("X-Routing-Rule-Id");
      const reasonCodes = (metadata.get("X-Routing-Reasons") || "")
        .split(",")
        .filter((code) => /^[a-z0-9_]{1,80}$/.test(code))
        .slice(0, 40);
      const verified = metadata.get("X-Synthetic-Capture") === "true";
      setLead(result);
      setSyntheticVerified(verified);
      setDecision(
        verified && decisionId && uuid.test(decisionId)
          ? {
              lead: result,
              decisionId,
              winningRuleId: ruleId && uuid.test(ruleId) ? ruleId : null,
              reasonCodes,
            }
          : null,
      );
      setDirty(false);
      setUncertain(false);
      setNotice(
        "The server acknowledged this synthetic submission. Retrying its unchanged identity reconciles the same recorded decision.",
      );
      try {
        await onSaved();
      } catch (err) {
        if (generation !== lifetime.current) return;
        setChoiceError(
          err instanceof Error
            ? err.message
            : "Workspace refresh unavailable. The capture acknowledgement is retained.",
        );
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
      }
    } catch (err) {
      if (generation !== lifetime.current) return;
      setError(
        err instanceof Error
          ? err.message
          : "Capture status unavailable. Retry the same submission to reconcile its result.",
      );
      if (!(err instanceof ApiError) || err.status >= 500) setUncertain(true);
      else if (![401, 403, 409].includes(err.status)) setRejected(true);
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="synthetic-capture-section" aria-label="Synthetic native capture demonstration">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">LOCAL SYNTHETIC DEMONSTRATION</span>
          <h2>See an inquiry become a routed lead.</h2>
          <p className="section-description">
            Use an existing authorized contact and source to exercise the reviewed native capture service.
            This is separate from manually adding a lead assigned to yourself.
          </p>
        </div>
      </div>
      <div className="synthetic-note">
        <FlaskConical size={22} />
        <p>
          All decisions and scores in this demo are synthetic. No public form, listing attribution, live
          Trestle feed or outbound communication is connected. Consent remains unchanged. Listing-agent
          resolution is unavailable.
        </p>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {choiceError && (
        <div className="error" role="alert">
          {choiceError}
        </div>
      )}
      {!canCapture ? (
        <section className="panel settings-card">
          <h3>Capture unavailable</h3>
          <p className="muted">
            Your verified role needs contact and lead read/write plus source read permission. The server
            rechecks scope and entitlement on every attempt.
          </p>
        </section>
      ) : (
        <section className="panel settings-card capture-editor">
          <h3>Synthetic submission</h3>
          <p className="capture-submission-id">Submission identity: {submissionId || "Preparing…"}</p>
          <form className="settings-form" onSubmit={capture} onChange={() => setDirty(true)}>
            <fieldset disabled={working || !online || Boolean(submitted)}>
              <label>
                Existing contact
                <select
                  ref={firstInput}
                  required
                  value={contactId}
                  onChange={(event) => setContactId(event.target.value)}
                >
                  <option value="" disabled>
                    Select an authorized contact
                  </option>
                  {contactId && !contactOptions.some((contact) => contact.id === contactId) && (
                    <option value={contactId}>
                      Previously selected contact · {contactId.slice(0, 8)} · Access rechecked
                    </option>
                  )}
                  {contactOptions.map((contact) => (
                    <option key={contact.id} value={contact.id}>
                      {contact.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Capture source
                <select required value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                  <option value="" disabled>
                    Select an organization source
                  </option>
                  {sourceId && !sourceOptions.some((source) => source.id === sourceId) && (
                    <option value={sourceId}>Previously selected source · {sourceId.slice(0, 8)}</option>
                  )}
                  {sourceOptions.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label} · {source.code}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-columns">
                <label>
                  Capture intent
                  <select
                    value={intent}
                    onChange={(event) => setIntent(event.target.value as NativeCaptureV1["intent"])}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="buyer">Buyer</option>
                    <option value="seller">Seller</option>
                    <option value="both">Buyer & seller</option>
                  </select>
                </label>
                <label>
                  Postal code (optional)
                  <input
                    maxLength={16}
                    pattern="[A-Za-z0-9 \-]+"
                    value={postalCode}
                    onChange={(event) => setPostalCode(event.target.value)}
                  />
                </label>
              </div>
              <label>
                Capture timeline (optional)
                <input
                  maxLength={80}
                  value={timeline}
                  onChange={(event) => setTimeline(event.target.value)}
                />
              </label>
              <div className="form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  disabled={loading || dirty}
                  onClick={() => void loadChoices()}
                >
                  <RefreshCw size={16} />
                  Refresh capture choices
                </Button>
                {contactCursor && (
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={loading}
                    onClick={() => void loadChoices("contacts", contactCursor)}
                  >
                    Load more capture contacts
                  </Button>
                )}
                {sourceCursor && (
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={loading}
                    onClick={() => void loadChoices("lead-sources", sourceCursor)}
                  >
                    Load more capture sources
                  </Button>
                )}
              </div>
            </fieldset>
            <p className="muted">
              {submitted
                ? "Input is frozen after submission. Retry the same identity and body before starting another inquiry."
                : "The server selects the owner. Your body contains no organization, owner or consent authority."}
            </p>
            <div className="capture-actions">
              {!submitted ? (
                <Button
                  type="submit"
                  disabled={
                    working ||
                    loading ||
                    !online ||
                    !choicesLoaded ||
                    !contactId ||
                    !sourceId ||
                    !submissionId
                  }
                >
                  {working ? "Capturing…" : "Capture synthetic inquiry"}
                </Button>
              ) : (
                <Button type="button" disabled={working || loading || !online} onClick={() => void capture()}>
                  {working
                    ? "Reconciling…"
                    : lead
                      ? "Retry same synthetic submission"
                      : "Reconcile same synthetic submission"}
                </Button>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={working || uncertain || Boolean(submitted && !lead && !rejected)}
                onClick={restart}
              >
                {lead
                  ? "Start another synthetic submission"
                  : rejected
                    ? "Discard rejected submission"
                    : "Discard capture draft"}
              </Button>
            </div>
          </form>
        </section>
      )}
      {lead && (
        <section className="panel settings-card capture-result">
          <div className="panel-heading">
            <h3>Server capture decision</h3>
            <Badge tone="positive">Synthetic lead acknowledged</Badge>
          </div>
          <p className="muted">
            {syntheticVerified
              ? "Synthetic response metadata verified."
              : "Synthetic response metadata unavailable; the lead body was acknowledged."}
          </p>
          <dl>
            <div>
              <dt>Lead</dt>
              <dd>
                <Link href={`/pipeline?lead=${lead.id}`}>Open captured lead</Link>
                <span className="capture-result-id">{lead.id}</span>
              </dd>
            </div>
            <div>
              <dt>Assignment</dt>
              <dd>
                {lead.ownerMemberId === null
                  ? "Unassigned queue"
                  : lead.ownerMemberId === memberId
                    ? "Assigned to you"
                    : lead.ownerMemberId
                      ? `Assigned member · ${lead.ownerMemberId.slice(0, 8)}`
                      : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Synthetic score</dt>
              <dd>
                {lead.score == null
                  ? "Unknown"
                  : `${lead.score} · ${lead.scoreVersion || "Version unavailable"}`}
              </dd>
            </div>
            <div>
              <dt>Scoring event time</dt>
              <dd>Unavailable in the current response</dd>
            </div>
            <div>
              <dt>Decision ID</dt>
              <dd>{decision?.decisionId || "Not returned"}</dd>
            </div>
            <div>
              <dt>Winning rule</dt>
              <dd>{decision?.winningRuleId || "No winning rule returned"}</dd>
            </div>
          </dl>
          <p className="muted">
            Scoring prioritizes sales follow-up. It does not determine housing, credit or mortgage
            eligibility.
          </p>
          <h4>Server reason codes</h4>
          {decision?.reasonCodes.length ? (
            <ul className="capture-reasons">
              {decision.reasonCodes.map((code) => (
                <li key={code}>
                  <code>{code}</code>
                  <span>
                    {Object.hasOwn(explanations, code)
                      ? explanations[code]
                      : "Server reason recorded; no local explanation is available."}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Reason codes were not returned.</p>
          )}
          <p className="form-note">
            <ShieldCheck size={16} />
            Submission identity is kept only in this open tab. No private capture data is persisted in browser
            storage.
          </p>
        </section>
      )}
    </section>
  );
}
