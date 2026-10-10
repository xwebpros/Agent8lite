"use client";

import { Building2, FlaskConical, LogOut, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  SyntheticStaffSessionRequest,
  SyntheticStaffSessionResponse,
} from "../../../packages/contracts/internal/control-plane-port";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import {
  pendingStaffJob,
  staffContextKey,
  validStaffJobId,
  verifyOrganizationPage,
  verifyStaffJob,
  verifyStaffSession,
} from "./staff-console-protocol";
import styles from "./staff-console.module.css";

export type StaffConsoleProps = {
  /** Server-derived explicit development/test enablement; never a public environment flag. */
  syntheticFeaturesEnabled: boolean;
  /** Integration must connect this to its navigation and service-worker draft guard. */
  onRecoveryRequired?(value: boolean): void;
};
type CreateAttempt = { body: Schema<"OrganizationCreate">; key: string; context: string };
type Operation = { job: Schema<"Job">; checkedAt: string; create?: CreateAttempt };
const unknownResult = (err: unknown) => !(err instanceof ApiError) || err.status >= 500 || err.status === 408;

export default function StaffConsole({ syntheticFeaturesEnabled, onRecoveryRequired }: StaffConsoleProps) {
  const [staff, setStaff] = useState<SyntheticStaffSessionResponse | null>(null);
  const [identity, setIdentity] = useState<SyntheticStaffSessionRequest["identity"]>("administrator");
  const [online, setOnline] = useState(true);
  const [booting, setBooting] = useState(true);
  const [working, setWorking] = useState(false);
  const [authUnknown, setAuthUnknown] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [organizations, setOrganizations] = useState<Schema<"Organization">[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataAt, setMetadataAt] = useState("");
  const [metadataError, setMetadataError] = useState("");
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [locale, setLocale] = useState("en-US");
  const [reviewed, setReviewed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [attempt, setAttempt] = useState<CreateAttempt | null>(null);
  const [createUnknown, setCreateUnknown] = useState(false);
  const [createRejected, setCreateRejected] = useState(false);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [unknownRuns, setUnknownRuns] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [recoverId, setRecoverId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const csrf = useRef("");
  const contextKey = useRef("");
  const lifetime = useRef(0);
  const authEpoch = useRef(0);
  const listEpoch = useRef(0);
  const inFlight = useRef(false);
  const checkingRef = useRef(false);
  const createSnapshot = useRef<CreateAttempt | null>(null);
  const runKeys = useRef(new Map<string, string>());
  const logoutKey = useRef("");
  const firstField = useRef<HTMLInputElement>(null);
  const recoveryInput = useRef("");
  recoveryInput.current = recoverId.trim();
  const canRead = staff?.permissions.includes("platform.orgs.read") === true;
  const canProvision = staff?.permissions.includes("platform.orgs.provision") === true;
  const pending = operations.some((item) => pendingStaffJob(item.job));
  const recoveryRequired =
    dirty ||
    Boolean(recoverId.trim()) ||
    createUnknown ||
    authUnknown ||
    unknownRuns.length > 0 ||
    pending ||
    working;
  const recoveryRef = useRef(false);
  recoveryRef.current = recoveryRequired;
  const recoveryCallback = useRef(onRecoveryRequired);
  recoveryCallback.current = onRecoveryRequired;

  const clearPrivate = useCallback(() => {
    ++lifetime.current;
    ++listEpoch.current;
    csrf.current = "";
    contextKey.current = "";
    createSnapshot.current = null;
    runKeys.current.clear();
    logoutKey.current = "";
    setStaff(null);
    setOrganizations([]);
    setCursor(null);
    setLoaded(false);
    setMetadataAt("");
    setName("");
    setTimezone("America/Los_Angeles");
    setLocale("en-US");
    setReviewed(false);
    setDirty(false);
    setAttempt(null);
    setCreateUnknown(false);
    setCreateRejected(false);
    setOperations([]);
    setUnknownRuns([]);
    setRecoverId("");
    setNotice("");
    setMetadataLoading(false);
    setChecking(false);
    checkingRef.current = false;
    setMetadataError("");
    setBooting(false);
  }, []);
  const reportFailure = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        ++authEpoch.current;
        clearPrivate();
        setAuthUnknown(false);
        setSignedOut(false);
      }
      setError(err instanceof Error ? err.message : "Staff service unavailable.");
    },
    [clearPrivate],
  );
  const readSession = useCallback(async () => {
    if (!syntheticFeaturesEnabled || !navigator.onLine) return;
    const generation = ++authEpoch.current;
    try {
      const response = await api<SyntheticStaffSessionResponse>("/dev/staff/session");
      if (generation !== authEpoch.current) return;
      const verified = verifyStaffSession(response.data, response.headers.get("X-CSRF-Token"));
      const next = staffContextKey(verified);
      if (contextKey.current && contextKey.current !== next) clearPrivate();
      contextKey.current = next;
      csrf.current = response.headers.get("X-CSRF-Token")!;
      setStaff(verified);
      setAuthUnknown(false);
      setSignedOut(false);
    } catch (err) {
      if (generation !== authEpoch.current) return;
      if (err instanceof ApiError && err.status === 401) {
        clearPrivate();
        setAuthUnknown(false);
        setSignedOut(true);
      } else {
        reportFailure(err);
        if (!(err instanceof ApiError && err.status === 403)) setAuthUnknown(true);
      }
    } finally {
      if (generation === authEpoch.current) setBooting(false);
    }
  }, [syntheticFeaturesEnabled, clearPrivate, reportFailure]);
  useEffect(() => {
    if (!syntheticFeaturesEnabled) {
      clearPrivate();
      setBooting(false);
      return;
    }
    setOnline(navigator.onLine);
    if (!navigator.onLine) {
      setBooting(false);
      setAuthUnknown(true);
    } else void readSession();
    const reconnect = () => {
      setOnline(true);
      void readSession();
    };
    const disconnect = () => setOnline(false);
    window.addEventListener("online", reconnect);
    window.addEventListener("offline", disconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", disconnect);
    };
  }, [syntheticFeaturesEnabled, readSession, clearPrivate]);
  useEffect(() => {
    onRecoveryRequired?.(recoveryRequired);
    const prevent = (event: BeforeUnloadEvent) => {
      if (recoveryRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [recoveryRequired, onRecoveryRequired]);
  useEffect(
    () => () => {
      ++lifetime.current;
      ++authEpoch.current;
      ++listEpoch.current;
      recoveryCallback.current?.(false);
    },
    [],
  );
  const loadOrganizations = useCallback(
    async (next?: string) => {
      if (!canRead || !online || authUnknown) return;
      const generation = ++listEpoch.current;
      const context = contextKey.current;
      setMetadataLoading(true);
      setMetadataError("");
      try {
        const response = await api<Schema<"PageOrganization">>(
          `/v1/platform/organizations?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== listEpoch.current || context !== contextKey.current) return;
        const page = verifyOrganizationPage(response.data);
        setOrganizations((previous) => (next ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setLoaded(true);
        setMetadataAt(new Date().toISOString());
      } catch (err) {
        if (generation !== listEpoch.current || context !== contextKey.current) return;
        if (err instanceof ApiError && [401, 403].includes(err.status)) reportFailure(err);
        else
          setMetadataError(
            err instanceof Error
              ? err.message
              : "Metadata refresh failed. Previously read data may be stale.",
          );
      } finally {
        if (generation === listEpoch.current) setMetadataLoading(false);
      }
    },
    [canRead, online, authUnknown, reportFailure],
  );
  useEffect(() => {
    if (staff && !recoveryRef.current) void loadOrganizations();
  }, [staff, loadOrganizations, working]);
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!syntheticFeaturesEnabled || !online || inFlight.current || authUnknown) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    setSignedOut(false);
    ++authEpoch.current;
    clearPrivate();
    const generation = lifetime.current;
    try {
      await api<unknown>("/dev/staff/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity } satisfies SyntheticStaffSessionRequest),
      });
      if (generation !== lifetime.current) return;
      await readSession();
    } catch (err) {
      if (generation === lifetime.current) {
        setAuthUnknown(unknownResult(err));
        reportFailure(err);
      }
    } finally {
      inFlight.current = false;
      setWorking(false);
      setBooting(false);
    }
  }
  async function staffCommand<T>(path: string, body: unknown, key: string) {
    if (
      !syntheticFeaturesEnabled ||
      !online ||
      !navigator.onLine ||
      !csrf.current ||
      !contextKey.current ||
      authUnknown
    )
      throw new Error("Reconnect and verify the staff session before reconciling this command.");
    const context = contextKey.current;
    const response = await api<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.current, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    if (context !== contextKey.current)
      throw new Error("Staff context changed. This result cannot be applied to the current console.");
    return response.data;
  }
  async function signOut() {
    if (!online || inFlight.current || authUnknown) return;
    if (
      recoveryRequired &&
      !window.confirm(
        "Sign out and clear this console’s private draft and operation references? Keep any known operation ID for authorized recovery.",
      )
    )
      return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    logoutKey.current ||= crypto.randomUUID();
    try {
      await staffCommand<undefined>("/dev/staff/logout", {}, logoutKey.current);
      ++authEpoch.current;
      clearPrivate();
      setAuthUnknown(false);
      setSignedOut(true);
    } catch (err) {
      setAuthUnknown(unknownResult(err));
      reportFailure(err);
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  function remember(job: Schema<"Job">, create?: CreateAttempt) {
    setOperations((previous) => {
      const existing = previous.find((item) => item.job.id === job.id);
      const next = {
        job,
        checkedAt: new Date().toISOString(),
        ...(create || existing?.create ? { create: create || existing!.create } : {}),
      };
      return existing ? previous.map((item) => (item.job.id === job.id ? next : item)) : [next, ...previous];
    });
    if (!pendingStaffJob(job)) setUnknownRuns((previous) => previous.filter((id) => id !== job.id));
  }
  async function createOrganization(event?: FormEvent, replay?: CreateAttempt) {
    event?.preventDefault();
    if (
      !canProvision ||
      !online ||
      authUnknown ||
      inFlight.current ||
      (!replay && !createSnapshot.current && !reviewed)
    )
      return;
    if (!replay && !createSnapshot.current) {
      try {
        if (!name.trim()) throw new Error("Enter an organization name.");
        new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() });
        if (locale.trim()) new Intl.DateTimeFormat(locale.trim());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Review the timezone and locale.");
        return;
      }
    }
    const snapshot: CreateAttempt = replay ||
      createSnapshot.current || {
        key: crypto.randomUUID(),
        context: contextKey.current,
        body: {
          name: name.trim(),
          timezone: timezone.trim(),
          ...(locale.trim() ? { locale: locale.trim() } : {}),
        },
      };
    if (snapshot.context !== contextKey.current) {
      setError("The original request belongs to a different staff context. It cannot be replayed here.");
      return;
    }
    if (!replay) {
      createSnapshot.current = snapshot;
      setAttempt(snapshot);
      setDirty(true);
    }
    const generation = lifetime.current;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    setCreateRejected(false);
    try {
      const job = verifyStaffJob(
        await staffCommand<Schema<"Job">>("/v1/platform/organizations", snapshot.body, snapshot.key),
      );
      if (generation !== lifetime.current) return;
      remember(job, snapshot);
      setCreateUnknown(false);
      if (!replay) {
        setDirty(false);
        setName("");
        setReviewed(false);
        setAttempt(null);
        createSnapshot.current = null;
      }
      setNotice(
        replay
          ? "The original create result was returned. This historical acknowledgement does not report the organization’s current state."
          : "The server acknowledged a durable provisioning operation. Queue acceptance does not mean the organization is active.",
      );
      if (canRead) await loadOrganizations();
    } catch (err) {
      if (generation !== lifetime.current) return;
      if (!replay) {
        setCreateUnknown(unknownResult(err));
        setCreateRejected(!unknownResult(err));
      }
      reportFailure(err);
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  async function runProvisioning(jobId: string, reviewedRetry = false) {
    if (
      !canProvision ||
      !online ||
      authUnknown ||
      inFlight.current ||
      checkingRef.current ||
      createUnknown ||
      dirty
    )
      return;
    if (
      reviewedRetry &&
      !window.confirm(
        "Retry this failed synthetic provisioning operation with a new execution key? The server will recheck the approved defaults. This does not authorize real charges or provider activation.",
      )
    )
      return;
    const generation = lifetime.current;
    let sent = false;
    inFlight.current = true;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      // A failed historical acknowledgement or transport timeout is not a current-state read.
      const current = verifyStaffJob((await api<Schema<"Job">>(`/dev/staff/jobs/${jobId}`)).data, jobId);
      if (generation !== lifetime.current) return;
      remember(current);
      if (reviewedRetry && current.state !== "failed") {
        setNotice(
          "The current operation is no longer failed. No new execution key was created; review the returned state.",
        );
        return;
      }
      if (!reviewedRetry && !pendingStaffJob(current)) {
        setNotice(
          "The current operation is terminal. No execution was repeated. A failed operation requires a separately reviewed retry.",
        );
        return;
      }
      if (!reviewedRetry && current.state !== "queued" && !runKeys.current.has(jobId)) {
        setNotice(
          "The server still reports pending or unknown execution. No original key exists in this tab, and no lease expiry or safe new attempt is inferred. Keep reading the operation.",
        );
        return;
      }
      const key = reviewedRetry ? crypto.randomUUID() : runKeys.current.get(jobId) || crypto.randomUUID();
      runKeys.current.set(jobId, key);
      sent = true;
      const job = verifyStaffJob(
        await staffCommand<Schema<"Job">>(`/dev/staff/jobs/${jobId}/run`, {}, key),
        jobId,
      );
      if (generation !== lifetime.current) return;
      remember(job);
      setUnknownRuns((previous) => previous.filter((id) => id !== jobId));
      setNotice(
        job.state === "succeeded"
          ? "Approved synthetic defaults committed. Production identity, payments and provider activation remain unavailable."
          : "The server’s actual operation state is shown. No readiness was inferred from accepting the run request.",
      );
      if (canRead) await loadOrganizations();
    } catch (err) {
      if (generation === lifetime.current) {
        if (sent && unknownResult(err)) setUnknownRuns((previous) => [...new Set([...previous, jobId])]);
        reportFailure(err);
      }
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }
  const readOperations = useCallback(
    async (ids: string[]) => {
      if (!canProvision || !online || authUnknown || checkingRef.current || inFlight.current) return;
      const generation = lifetime.current;
      const context = contextKey.current;
      checkingRef.current = true;
      setChecking(true);
      setError("");
      try {
        const results = await Promise.all(
          ids.map(async (id) => verifyStaffJob((await api<Schema<"Job">>(`/dev/staff/jobs/${id}`)).data, id)),
        );
        if (generation !== lifetime.current || context !== contextKey.current) return;
        if (results.some((job) => job.id === recoveryInput.current)) setRecoverId("");
        setOperations((previous) => {
          const next = previous.map((item) => {
            const job = results.find((value) => value.id === item.job.id);
            return job ? { ...item, job, checkedAt: new Date().toISOString() } : item;
          });
          for (const job of results)
            if (!next.some((item) => item.job.id === job.id))
              next.unshift({ job, checkedAt: new Date().toISOString() });
          return next;
        });
        setUnknownRuns((previous) =>
          previous.filter((id) => !results.some((job) => job.id === id && !pendingStaffJob(job))),
        );
      } catch (err) {
        if (generation === lifetime.current && context === contextKey.current) reportFailure(err);
      } finally {
        if (generation === lifetime.current) {
          checkingRef.current = false;
          setChecking(false);
        }
      }
    },
    [canProvision, online, authUnknown, reportFailure],
  );
  useEffect(() => {
    if (!pending || !online || authUnknown) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !inFlight.current)
        void readOperations(
          operations.filter((item) => pendingStaffJob(item.job)).map((item) => item.job.id),
        );
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, online, authUnknown, operations, readOperations]);
  function discardDraft() {
    if (inFlight.current || createUnknown || (attempt && !createRejected)) return;
    if (dirty && !window.confirm("Discard the organization draft?")) return;
    createSnapshot.current = null;
    setAttempt(null);
    setDirty(false);
    setCreateRejected(false);
    setName("");
    setReviewed(false);
    setError("");
    window.requestAnimationFrame(() => firstField.current?.focus());
  }
  const when = (value: string) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  if (!syntheticFeaturesEnabled)
    return (
      <Empty icon={<ShieldCheck size={30} />} title="Synthetic staff console unavailable">
        This console requires explicitly enabled local development or test mode.
      </Empty>
    );
  return (
    <section className={styles.console} aria-label="Synthetic staff control plane">
      <header className={styles.header}>
        <ShieldCheck size={28} aria-hidden="true" />
        <div>
          <p className={styles.eyebrow}>Separate staff control plane</p>
          <h1>Synthetic staff console</h1>
          <p>Organization metadata and explicitly authorized local provisioning.</p>
        </div>
        <Badge tone="warning">Synthetic · no charges</Badge>
      </header>
      <div className={styles.notice}>
        <FlaskConical size={22} aria-hidden="true" />
        <p>
          Staff authority is separate from member sessions. This console creates only approved synthetic
          defaults. Live identity, payments, provider activation and customer CRM access remain unavailable.
        </p>
      </div>
      {!online && (
        <div className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" />
          <p>Offline: mutations are disabled. Drafts and operation references remain only in this tab.</p>
        </div>
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
      {authUnknown && (
        <section className={styles.card}>
          <h2>Staff session needs reconciliation</h2>
          <p>
            The current identity or sign-out result could not be verified. Verify the staff session before
            another command; no customer authority is assumed.
          </p>
          <Button disabled={working || !online} variant="secondary" onClick={() => void readSession()}>
            Reconcile staff session
          </Button>
        </section>
      )}
      {booting ? (
        <p role="status">Verifying the separate staff session…</p>
      ) : !staff ? (
        <section className={styles.card}>
          <h2>Choose a local synthetic identity</h2>
          {signedOut && (
            <p role="status">No active staff session was returned. Private console memory is clear.</p>
          )}
          <form onSubmit={authenticate}>
            <fieldset disabled={working || !online || authUnknown}>
              <label htmlFor="staff-identity">
                Synthetic staff identity
                <select
                  id="staff-identity"
                  value={identity}
                  onChange={(event) =>
                    setIdentity(event.target.value as SyntheticStaffSessionRequest["identity"])
                  }
                >
                  <option value="administrator">Administrator fixture</option>
                  <option value="support">Support fixture</option>
                </select>
              </label>
              <p className={styles.muted}>
                The server verifies the selected fixture and returns its current permissions. Tenant Owner
                membership does not establish staff authority.
              </p>
              <Button type="submit">{working ? "Verifying…" : "Sign in as synthetic staff"}</Button>
            </fieldset>
          </form>
        </section>
      ) : (
        <>
          <section className={`${styles.card} ${styles.identity}`}>
            <div>
              <h2>
                {authUnknown ? "Last verified synthetic staff session" : "Verified synthetic staff session"}
              </h2>
              <p className={styles.muted}>Principal {staff.staffUserId}</p>
              <p>
                {authUnknown ? "Last verified platform permissions" : "Current platform permissions"}:{" "}
                {staff.permissions.length ? staff.permissions.join(", ") : "None returned"}
              </p>
              {staff.supportContext && (
                <p className={styles.warning}>
                  A separate support context is selected until {when(staff.supportContext.expiresAt)}. Reason:{" "}
                  {staff.supportContext.reason}. This console does not expose its customer data.
                </p>
              )}
            </div>
            <div className={styles.actions}>
              <Button variant="secondary" disabled={working || !online} onClick={() => void readSession()}>
                <RefreshCw size={16} />
                Verify staff access
              </Button>
              <Button
                variant="quiet"
                disabled={working || !online || authUnknown}
                onClick={() => void signOut()}
              >
                <LogOut size={16} />
                Sign out staff
              </Button>
            </div>
          </section>
          <section className={styles.card}>
            <div className={styles.heading}>
              <div>
                <p className={styles.eyebrow}>Metadata only</p>
                <h2>Organizations</h2>
                <p className={styles.muted}>
                  {metadataAt ? `Last read ${when(metadataAt)}` : "Metadata has not been read."}
                </p>
              </div>
              {canRead && (
                <Button
                  variant="secondary"
                  disabled={!online || working || metadataLoading || authUnknown}
                  onClick={() => void loadOrganizations()}
                >
                  <RefreshCw size={16} />
                  {metadataLoading ? "Reading…" : "Refresh organizations"}
                </Button>
              )}
            </div>
            {metadataError && (
              <p className={styles.error} role="alert">
                {metadataError} {metadataAt && "Previously read metadata may be stale."}
              </p>
            )}
            {!canRead ? (
              <p className={styles.muted}>
                The current staff session has no organization metadata permission.
              </p>
            ) : metadataLoading && !loaded ? (
              <p role="status">Reading authorized organization metadata…</p>
            ) : !loaded ? (
              <p className={styles.muted}>Organization metadata is unavailable.</p>
            ) : organizations.length === 0 ? (
              <p>No organizations were returned by the authorized metadata read.</p>
            ) : (
              <div className={styles.orgGrid}>
                {organizations.map((org) => (
                  <article className={styles.org} key={org.id}>
                    <Building2 size={22} aria-hidden="true" />
                    <div>
                      <h3>{org.name}</h3>
                      <Badge tone={org.status === "active" ? "positive" : "warning"}>{org.status}</Badge>
                      <p>
                        {org.timezone} · {org.locale}
                      </p>
                      <p className={styles.muted}>
                        Version {org.version} · {org.id}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            )}
            {canRead && cursor && (
              <Button
                variant="secondary"
                disabled={!online || working || metadataLoading || authUnknown}
                onClick={() => void loadOrganizations(cursor)}
              >
                Load more organizations
              </Button>
            )}
          </section>
          {canProvision && (
            <section className={styles.card}>
              <h2>Request synthetic organization provisioning</h2>
              <p>
                The server binds the approved fixture Owner, built-in role presets, business profile, six
                stages, default source/routing and mock billing policy. No client owner or plan claim is
                accepted.
              </p>
              <form onSubmit={(event) => void createOrganization(event)}>
                <fieldset
                  disabled={working || !online || authUnknown || Boolean(attempt) || unknownRuns.length > 0}
                >
                  <legend className={styles.srOnly}>Organization defaults</legend>
                  <label htmlFor="staff-org-name">
                    Organization name
                    <input
                      ref={firstField}
                      id="staff-org-name"
                      autoComplete="organization"
                      maxLength={120}
                      required
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                        setDirty(true);
                        setReviewed(false);
                      }}
                    />
                  </label>
                  <div className={styles.fields}>
                    <label htmlFor="staff-org-timezone">
                      Timezone
                      <input
                        id="staff-org-timezone"
                        list="staff-timezones"
                        maxLength={80}
                        required
                        value={timezone}
                        onChange={(event) => {
                          setTimezone(event.target.value);
                          setDirty(true);
                          setReviewed(false);
                        }}
                      />
                      <datalist id="staff-timezones">
                        <option value="America/Los_Angeles" />
                        <option value="America/New_York" />
                        <option value="Asia/Bangkok" />
                        <option value="UTC" />
                      </datalist>
                    </label>
                    <label htmlFor="staff-org-locale">
                      Locale (optional)
                      <input
                        id="staff-org-locale"
                        autoComplete="off"
                        maxLength={20}
                        value={locale}
                        onChange={(event) => {
                          setLocale(event.target.value);
                          setDirty(true);
                          setReviewed(false);
                        }}
                      />
                    </label>
                  </div>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(event) => {
                        setReviewed(event.target.checked);
                        setDirty(true);
                      }}
                    />
                    <span>
                      I reviewed these settings and explicitly request local synthetic provisioning with no
                      real charges.
                    </span>
                  </label>
                </fieldset>
                {createUnknown && (
                  <p className={styles.warning} role="status">
                    The create result is unknown. Input and key are frozen; reconcile this exact request
                    before starting another organization.
                  </p>
                )}
                {createRejected && (
                  <p className={styles.warning} role="status">
                    The request was rejected. Discard the draft or explicitly edit it before creating a new
                    request key.
                  </p>
                )}
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={working || createUnknown || Boolean(attempt && !createRejected)}
                    onClick={discardDraft}
                  >
                    Discard organization draft
                  </Button>
                  {createRejected && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={working || !online}
                      onClick={() => {
                        createSnapshot.current = null;
                        setAttempt(null);
                        setCreateRejected(false);
                        setReviewed(false);
                        window.requestAnimationFrame(() => firstField.current?.focus());
                      }}
                    >
                      Edit rejected draft
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={
                      working || !online || authUnknown || unknownRuns.length > 0 || (!attempt && !reviewed)
                    }
                  >
                    {working
                      ? "Requesting…"
                      : attempt
                        ? "Reconcile original create request"
                        : "Queue synthetic provisioning"}
                  </Button>
                </div>
              </form>
            </section>
          )}
          {canProvision && (
            <section className={styles.card}>
              <div className={styles.heading}>
                <div>
                  <h2>Provisioning operations</h2>
                  <p className={styles.muted}>
                    Known operation references are held only in memory. Save an ID if you intend to recover it
                    after leaving this tab; every read rechecks requester authority.
                  </p>
                </div>
                {operations.length > 0 && (
                  <Button
                    variant="secondary"
                    disabled={!online || working || checking || authUnknown}
                    onClick={() => void readOperations(operations.map((item) => item.job.id))}
                  >
                    <RefreshCw size={16} />
                    {checking ? "Reading…" : "Check operation states"}
                  </Button>
                )}
              </div>
              <form
                className={styles.recover}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (validStaffJobId(recoverId.trim())) void readOperations([recoverId.trim()]);
                  else setError("Enter a valid known provisioning operation ID.");
                }}
              >
                <label htmlFor="staff-recover-job">
                  Recover a known operation ID
                  <input
                    id="staff-recover-job"
                    maxLength={36}
                    autoComplete="off"
                    value={recoverId}
                    onChange={(event) => setRecoverId(event.target.value)}
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={!online || working || checking || authUnknown || !recoverId.trim()}
                >
                  Read authorized operation
                </Button>
              </form>
              {operations.length === 0 && (
                <p className={styles.muted}>
                  No operation has been acknowledged or recovered in this console.
                </p>
              )}
              {operations.map((item) => (
                <article className={styles.operation} key={item.job.id}>
                  <div>
                    <h3>{item.create?.body.name || "Recovered provisioning operation"}</h3>
                    <Badge tone={item.job.state === "succeeded" ? "positive" : "warning"}>
                      {item.job.state}
                    </Badge>
                    <label>
                      Operation ID
                      <input
                        readOnly
                        value={item.job.id}
                        aria-label={`Provisioning operation ID ${item.job.id}`}
                        onFocus={(event) => event.target.select()}
                      />
                    </label>
                    <p className={styles.muted}>Last server report {when(item.checkedAt)}</p>
                    <p>
                      {item.job.state === "succeeded"
                        ? "Approved synthetic defaults committed. This result does not approve production identity, payments or external providers."
                        : item.job.state === "failed"
                          ? "The server reported a failure. Provisioning is not complete; no activation is inferred."
                          : "Only the returned operation state is shown. Execution is a separate explicit local action."}
                    </p>
                    {item.job.error && (
                      <p className={styles.error} role="status">
                        {item.job.error.detail || item.job.error.title}
                      </p>
                    )}
                    {unknownRuns.includes(item.job.id) && (
                      <p className={styles.warning} role="status">
                        Execution response unknown. Read the current operation or retry its original execution
                        key; no new run key is created.
                      </p>
                    )}
                  </div>
                  <div className={styles.actions}>
                    <Button
                      variant="secondary"
                      disabled={!online || working || checking || authUnknown}
                      onClick={() => void readOperations([item.job.id])}
                    >
                      Read operation
                    </Button>
                    {pendingStaffJob(item.job) && (
                      <Button
                        disabled={
                          !online ||
                          working ||
                          checking ||
                          authUnknown ||
                          dirty ||
                          createUnknown ||
                          unknownRuns.some((id) => id !== item.job.id)
                        }
                        onClick={() => void runProvisioning(item.job.id)}
                      >
                        {unknownRuns.includes(item.job.id)
                          ? "Reconcile original local execution"
                          : item.job.state === "queued"
                            ? "Run local synthetic provisioning"
                            : "Reconcile pending execution"}
                      </Button>
                    )}
                    {item.job.state === "failed" && (
                      <Button
                        variant="secondary"
                        disabled={
                          !online ||
                          working ||
                          checking ||
                          authUnknown ||
                          dirty ||
                          createUnknown ||
                          unknownRuns.length > 0
                        }
                        onClick={() => void runProvisioning(item.job.id, true)}
                      >
                        Review and retry failed operation
                      </Button>
                    )}
                    {item.create && (
                      <Button
                        variant="quiet"
                        disabled={
                          !online ||
                          working ||
                          authUnknown ||
                          dirty ||
                          createUnknown ||
                          unknownRuns.length > 0
                        }
                        onClick={() => void createOrganization(undefined, item.create)}
                      >
                        Replay original create command
                      </Button>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
      )}
    </section>
  );
}
