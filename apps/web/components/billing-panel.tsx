"use client";

import { CreditCard, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  session: Schema<"Session">;
  syntheticEnabled: boolean;
  online: boolean;
  working: boolean;
  runCommand: <T>(
    path: string,
    body: unknown,
    method?: string,
    version?: number,
    receiveHeaders?: (headers: Headers) => void,
  ) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
export default function BillingPanel({
  session,
  syntheticEnabled,
  online,
  working,
  runCommand,
  onDirty,
  setWorking,
}: Props) {
  const [overview, setOverview] = useState<Schema<"BillingOverview"> | null>(null);
  const [preview, setPreview] = useState<Schema<"BillingPreview"> | null>(null);
  const [termsVersion, setTermsVersion] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [action, setAction] = useState<Schema<"BillingPreviewRequest">["action"]>("change_plan");
  const [planCode, setPlanCode] = useState("synthetic-starter");
  const [interval, setIntervalValue] = useState<"month" | "year">("month");
  const [requestDirty, setRequestDirty] = useState(false);
  const [job, setJob] = useState<Schema<"Job"> | null>(null);
  const [jobPreviewId, setJobPreviewId] = useState("");
  const [error, setError] = useState("");
  const [jobError, setJobError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const epoch = useRef(0);
  const jobEpoch = useRef(0);
  const checkingRef = useRef(false);
  const canRead = session.permissions.includes("billing.read");
  const canManage = session.permissions.includes("billing.manage");
  const canReadJobs = session.permissions.includes("jobs.read");
  const base = `/v1/orgs/${session.activeOrgId}/billing`;
  const pending = Boolean(job && ["queued", "running", "unknown"].includes(job.state));
  const expired = Boolean(preview && new Date(preview.expiresAt).getTime() <= now);

  const loadOverview = useCallback(async () => {
    if (!session.activeOrgId || !canRead || !online) return;
    const generation = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const response = await api<Schema<"BillingOverview">>(`/v1/orgs/${session.activeOrgId}/billing`);
      if (generation === epoch.current) setOverview(response.data);
    } catch (err) {
      if (generation !== epoch.current) return;
      setOverview(null);
      setError(err instanceof Error ? err.message : "Billing overview unavailable.");
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }, [session.activeOrgId, canRead, online]);
  useEffect(() => {
    void loadOverview();
    return () => {
      ++epoch.current;
    };
  }, [loadOverview]);
  useEffect(() => {
    onDirty(requestDirty || Boolean(preview));
  }, [requestDirty, preview, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const checkJob = useCallback(async () => {
    if (!job?.id || !session.activeOrgId || !canReadJobs || !online || checkingRef.current) return;
    checkingRef.current = true;
    const generation = ++jobEpoch.current;
    setChecking(true);
    setJobError("");
    try {
      const result = await api<Schema<"Job">>(`/v1/orgs/${session.activeOrgId}/jobs/${job.id}`);
      if (generation !== jobEpoch.current) return;
      setJob(result.data);
      if (["succeeded", "failed", "cancelled"].includes(result.data.state)) await loadOverview();
    } catch (err) {
      if (generation === jobEpoch.current)
        setJobError(
          err instanceof Error
            ? err.message
            : "Current job status unavailable. The last reported state is shown.",
        );
    } finally {
      checkingRef.current = false;
      if (generation === jobEpoch.current) setChecking(false);
    }
  }, [job?.id, session.activeOrgId, canReadJobs, online, loadOverview]);
  useEffect(() => {
    if (!pending || !online || !canReadJobs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkJob();
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, [pending, online, canReadJobs, checkJob]);

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorking(true);
    setError("");
    setNotice("");
    setPreview(null);
    setReviewed(false);
    setTermsVersion("");
    try {
      const input: Schema<"BillingPreviewRequest"> =
        action === "change_plan" ? { action, planCode, billingInterval: interval } : { action };
      let version = "";
      const result = await runCommand<Schema<"BillingPreview">>(
        `${base}/change-previews`,
        input,
        "POST",
        undefined,
        (headers) => {
          version = headers.get("X-Billing-Terms-Version") || "";
        },
      );
      setPreview(result);
      setTermsVersion(version);
      setRequestDirty(false);
      setJob(null);
      setJobError("");
      if (!version)
        setError(
          "This preview did not include verifiable terms metadata. Confirmation is unavailable; request a new preview after the service is ready.",
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview unavailable. No billing command was confirmed.");
    } finally {
      setWorking(false);
    }
  }
  async function confirm() {
    if (!preview || !reviewed || expired || !termsVersion) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const input: Schema<"PreviewConfirm"> = { previewId: preview.id, acceptedTermsVersion: termsVersion };
      const result = await runCommand<Schema<"Job">>(`${base}/change-confirmations`, input);
      setJob(result);
      setJobPreviewId(preview.id);
      setPreview(null);
      setReviewed(false);
      setRequestDirty(false);
      setNotice(
        "The synthetic change was accepted as a durable job. Capabilities stay as reported until provider reconciliation completes.",
      );
      await loadOverview();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Confirmation could not be reconciled. Keep this preview and retry with the same input.",
      );
    } finally {
      setWorking(false);
    }
  }
  async function reconcileSynthetic() {
    if (!syntheticEnabled || !jobPreviewId || !pending) return;
    setWorking(true);
    setJobError("");
    setNotice("");
    try {
      const result = await runCommand<Schema<"Job">>("/dev/billing/reconcile", { previewId: jobPreviewId });
      setJob(result);
      await loadOverview();
      setNotice(
        "The local mock provider state was read for reconciliation. The operation and capability states shown are fresh server responses; no real charge was made.",
      );
    } catch (err) {
      setJobError(
        err instanceof Error
          ? err.message
          : "Synthetic reconciliation unavailable. The pending operation has not been marked complete.",
      );
    } finally {
      setWorking(false);
    }
  }
  function discard() {
    if (working) return;
    setPreview(null);
    setReviewed(false);
    setTermsVersion("");
    setRequestDirty(false);
    setError("");
  }
  const money = (minor: number | null, currency: string) =>
    minor === null
      ? "Unavailable"
      : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  const when = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: session.profile.timezone,
    }).format(new Date(value));
  return (
    <section className="billing-section" aria-label="Billing and capabilities">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">BILLING</span>
          <h2>A clear view of your account.</h2>
          <p className="section-description">
            Prices, operation state and enabled capabilities are separate server records.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={working || loading || !online || !canRead}
          onClick={() => void loadOverview()}
        >
          <RefreshCw size={16} />
          Refresh billing
        </Button>
      </div>
      <div className="synthetic-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Synthetic billing · No real charges</strong>
          <span>
            This workspace uses the no-charge mock provider. Previews are demonstration prices; confirmation
            does not enable capabilities or charge a card by itself. No hosted payment portal is connected.
          </span>
        </div>
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
      <section className="panel billing-overview">
        <div className="panel-heading">
          <h2>
            <CreditCard size={19} />
            Subscription overview
          </h2>
          <Badge>{loading ? "Refreshing…" : overview?.status || "Unavailable"}</Badge>
        </div>
        {overview ? (
          <>
            <div className="billing-totals">
              <article>
                <span>Current plan</span>
                <strong>{overview.planCode}</strong>
                <p>Currency: {overview.currency}</p>
              </article>
              <article>
                <span>Annual invoice total</span>
                <strong>{money(overview.annualTotalMinor, overview.currency)}</strong>
                <p>Annual amount reported by the billing service</p>
              </article>
              <article>
                <span>Monthly equivalent</span>
                <strong>{money(overview.monthlyEquivalentMinor, overview.currency)}</strong>
                <p>Shown separately from the annual invoice</p>
              </article>
            </div>
            <p className="billing-period">
              Period end:{" "}
              {overview.periodEnd
                ? when(overview.periodEnd)
                : "Unavailable — the mock provider has no authoritative period end"}{" "}
              · {session.profile.timezone}
            </p>
            <div className="entitlements">
              <h3>Capabilities as currently reported</h3>
              {overview.entitlements.length ? (
                <div>
                  {overview.entitlements.map((entitlement) => (
                    <article key={entitlement.feature}>
                      <div>
                        <strong>{entitlement.feature}</strong>
                        <span>
                          {entitlement.limit == null ? "Limit not specified" : `Limit: ${entitlement.limit}`}
                          {entitlement.expiresAt ? ` · Expires ${when(entitlement.expiresAt)}` : ""}
                        </span>
                      </div>
                      <Badge
                        tone={
                          entitlement.state === "enabled"
                            ? "positive"
                            : entitlement.state === "pending"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {entitlement.state}
                      </Badge>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted">No capability records returned. No enabled capability is inferred.</p>
              )}
            </div>
          </>
        ) : (
          <Empty
            icon={<CreditCard size={30} />}
            title={loading ? "Loading billing records" : "Billing unavailable"}
          >
            Only a successful server response supplies prices and capability states.
          </Empty>
        )}
      </section>
      {job && (
        <section className="panel billing-job">
          <div className="panel-heading">
            <h2>Change operation</h2>
            <Badge tone={job.state === "succeeded" ? "positive" : pending ? "warning" : "neutral"}>
              {jobError ? `Last reported: ${job.state}` : job.state}
            </Badge>
          </div>
          <div className="billing-job-body">
            <p>
              {job.state === "queued" || job.state === "running"
                ? "Your command is durable and awaiting provider reconciliation. Pending work does not mean billing or capabilities have changed."
                : job.state === "unknown"
                  ? "Provider acceptance is unknown. Reconciliation is required; the application will not submit the change again automatically."
                  : job.state === "succeeded"
                    ? "The provider job reports success. Capability states above come from a fresh billing overview response."
                    : job.state === "failed"
                      ? "The operation failed. Review its safe error and current billing records before requesting another preview."
                      : "The operation was cancelled. Current billing records remain authoritative."}
            </p>
            {job.error && (
              <div className="error">
                {job.error.title}
                {job.error.detail ? ` — ${job.error.detail}` : ""}
              </div>
            )}
            {jobError && (
              <div className="error" role="alert">
                {jobError}
              </div>
            )}
            <p className="muted">
              {job.kind} · Created {when(job.createdAt)} · Operation {job.id}
            </p>
            <Button
              variant="secondary"
              disabled={checking || working || !online || !canReadJobs}
              onClick={() => void checkJob()}
            >
              {checking ? "Checking…" : "Check operation status"}
            </Button>
            {!canReadJobs && (
              <p className="muted">
                Your role cannot read operation details. The returned acceptance state is shown.
              </p>
            )}
            <p className="muted">
              Synthetic provider reconciliation is a separate local operation. No job or capability is marked
              complete by this page.
            </p>
            {syntheticEnabled && pending && jobPreviewId && (
              <div className="synthetic-reconciliation">
                <strong>Local synthetic demonstration</strong>
                <p>
                  This explicit action asks the mock provider for its authoritative state and reconciles the
                  saved operation. It makes no real charge and never resubmits the financial confirmation.
                </p>
                <Button
                  variant="secondary"
                  disabled={working || !online || !canManage}
                  onClick={() => void reconcileSynthetic()}
                >
                  {working ? "Reconciling…" : "Reconcile synthetic provider state"}
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
      {canManage && syntheticEnabled && (
        <section className="panel settings-card billing-change">
          <h3>Preview a subscription change</h3>
          <p className="muted">
            Choose a mock plan change, cancellation or resumption. The next step displays the server’s
            currency, amounts, timing and terms.
          </p>
          <form
            className="settings-form"
            onSubmit={makePreview}
            onChange={() => {
              setRequestDirty(true);
              setPreview(null);
              setReviewed(false);
            }}
          >
            <fieldset disabled={working || !online || pending}>
              <label>
                Subscription action
                <select
                  value={action}
                  onChange={(event) =>
                    setAction(event.target.value as Schema<"BillingPreviewRequest">["action"])
                  }
                >
                  <option value="change_plan">Change plan</option>
                  <option value="cancel">Cancel subscription</option>
                  <option value="resume">Resume subscription</option>
                </select>
              </label>
              {action === "change_plan" && (
                <div className="form-columns">
                  <label>
                    Synthetic plan
                    <select value={planCode} onChange={(event) => setPlanCode(event.target.value)}>
                      <option value="synthetic-starter">Synthetic Starter</option>
                      <option value="synthetic-team">Synthetic Team</option>
                    </select>
                  </label>
                  <label>
                    Billing interval
                    <select
                      value={interval}
                      onChange={(event) => setIntervalValue(event.target.value as "month" | "year")}
                    >
                      <option value="month">Monthly</option>
                      <option value="year">Annual</option>
                    </select>
                  </label>
                </div>
              )}
              <Button type="submit" disabled={working || !online || pending}>
                {working ? "Requesting…" : "Preview change"}
              </Button>
            </fieldset>
          </form>
          {pending && (
            <p className="muted">Resolve the existing operation before requesting another billing change.</p>
          )}
          {preview && (
            <div className="billing-preview">
              <div className="preview-heading">
                <h3>Review before confirming</h3>
                <Badge tone={expired ? "warning" : "neutral"}>
                  {expired ? "Expired" : "Unconfirmed preview"}
                </Badge>
              </div>
              <dl>
                <div>
                  <dt>Due now</dt>
                  <dd>{money(preview.dueNowMinor, preview.currency)}</dd>
                </div>
                <div>
                  <dt>Recurring total</dt>
                  <dd>
                    {money(preview.recurringTotalMinor, preview.currency)} / {preview.interval}
                  </dd>
                </div>
                <div>
                  <dt>Effective at</dt>
                  <dd>{when(preview.effectiveAt)}</dd>
                </div>
                <div>
                  <dt>Preview expires</dt>
                  <dd>{when(preview.expiresAt)}</dd>
                </div>
              </dl>
              <h4>Terms supplied by the mock provider</h4>
              <ul>
                {preview.terms.map((term, index) => (
                  <li key={`${index}:${term}`}>{term}</li>
                ))}
              </ul>
              <label className="accept-terms">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                  disabled={working || !online || expired}
                />
                <span>I reviewed the prices, timing and terms above and accept this synthetic change.</span>
              </label>
              <p className="muted">
                No confirmation occurs until you use the button below. The server rechecks preview expiry,
                account versions and the accepted terms.
              </p>
              <div className="form-actions">
                <Button variant="secondary" disabled={working} onClick={discard}>
                  Discard preview
                </Button>
                <Button
                  disabled={!reviewed || expired || !termsVersion || working || !online}
                  onClick={() => void confirm()}
                >
                  {working ? "Confirming…" : "Confirm synthetic change"}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
