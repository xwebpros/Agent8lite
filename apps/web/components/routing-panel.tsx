"use client";

import { GitBranch, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Rule = Schema<"RoutingRule">;
const kinds: { code: Rule["kind"]; label: string }[] = [
  { code: "first_touch", label: "First-touch owner" },
  { code: "listing_agent", label: "Listing-attributed agent" },
  { code: "geography", label: "Postal geography" },
  { code: "round_robin", label: "Weighted round robin" },
];
type Props = {
  session: Schema<"Session">;
  online: boolean;
  working: boolean;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
};
export default function RoutingPanel({ session, online, working, runCommand, onDirty, setWorking }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState<Rule[]>([]);
  const [postalDraft, setPostalDraft] = useState<Record<string, string>>({});
  const [version, setVersion] = useState<number | null>(null);
  const [canReplace, setCanReplace] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState<Schema<"Member">[]>([]);
  const [memberCursor, setMemberCursor] = useState<string | null>(null);
  const [memberError, setMemberError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [job, setJob] = useState<Schema<"Job"> | null>(null);
  const [jobError, setJobError] = useState("");
  const [checking, setChecking] = useState(false);
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const checkingRef = useRef(false);
  const editor = useRef<HTMLHeadingElement>(null);
  const protectedRef = useRef(false);
  const automaticLoadRef = useRef(false);
  protectedRef.current = dirty || uncertain;
  const base = `/v1/orgs/${session.activeOrgId}`;
  const pending = Boolean(job && ["queued", "running", "unknown"].includes(job.state));
  automaticLoadRef.current = dirty || uncertain || pending || working;
  const clearPrivate = useCallback(() => {
    ++epoch.current;
    ++lifetime.current;
    setRules([]);
    setDraft([]);
    setPostalDraft({});
    setMembers([]);
    setMemberCursor(null);
    setVersion(null);
    setCanReplace(false);
    setLoaded(false);
    setEditing(false);
    setDirty(false);
    setUncertain(false);
    setJob(null);
    setLoading(false);
    setChecking(false);
    checkingRef.current = false;
  }, []);
  const load = useCallback(async () => {
    if (!session.activeOrgId || !online) return;
    const generation = ++epoch.current;
    setLoading(true);
    setError("");
    setCanReplace(false);
    try {
      const complete: Rule[] = [];
      let cursor: string | null = null;
      let aggregate: string | null = null;
      let authorized = true;
      for (let page = 0; page < 10; page++) {
        const result: { data: Schema<"PageRoutingRule">; headers: Headers } = await api<
          Schema<"PageRoutingRule">
        >(`${base}/routing?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (generation !== epoch.current) return;
        const currentVersion = result.headers.get("ETag");
        if (!currentVersion || (aggregate !== null && currentVersion !== aggregate))
          throw new Error(
            "Routing changed during pagination. Reload before editing a complete configuration.",
          );
        aggregate = currentVersion;
        authorized = authorized && result.headers.get("X-Routing-Can-Replace") === "true";
        complete.push(...result.data.items);
        if (!result.data.hasMore) {
          cursor = null;
          break;
        }
        cursor = result.data.nextCursor;
        if (!cursor) throw new Error("Routing pagination is incomplete. Replacement is unavailable.");
      }
      if (cursor)
        throw new Error("Routing pagination exceeds the local review bound. Replacement is unavailable.");
      const revision = /^"[1-9]\d*"$/.test(aggregate || "") ? Number(aggregate!.slice(1, -1)) : null;
      const verified = Boolean(
        authorized &&
          revision &&
          Number.isSafeInteger(revision) &&
          complete.length <= 100 &&
          new Set(complete.map((rule) => rule.id)).size === complete.length,
      );
      setRules(complete);
      setDraft(structuredClone(complete));
      setPostalDraft(
        Object.fromEntries(complete.map((rule) => [rule.id, rule.postalCodes?.join(", ") || ""])),
      );
      setVersion(revision);
      setLoaded(true);
      setCanReplace(verified);
      setDirty(false);
      setStale(false);
      setUncertain(false);
      setEditing(false);
    } catch (err) {
      if (generation !== epoch.current) return;
      setRules([]);
      setLoaded(false);
      setVersion(null);
      setCanReplace(false);
      setError(err instanceof Error ? err.message : "Routing configuration unavailable.");
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }, [session.activeOrgId, online, base, clearPrivate]);
  useEffect(() => {
    if (!automaticLoadRef.current) void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  useEffect(() => {
    if (
      !session.permissions.includes("crm.routing.manage") ||
      !session.permissions.includes("crm.routing.read")
    ) {
      setCanReplace(false);
      setEditing(false);
      setDraft([]);
      setDirty(false);
      setUncertain(false);
    }
    if (!session.permissions.includes("members.read")) {
      setMembers([]);
      setMemberCursor(null);
    }
  }, [session.permissions]);
  useEffect(() => {
    onDirty(dirty || uncertain);
  }, [dirty, uncertain, onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
      onDirty(false);
    },
    [onDirty],
  );
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  const loadMembers = useCallback(
    async (next?: string) => {
      if (!online || !session.permissions.includes("members.read")) return;
      const generation = lifetime.current;
      try {
        const result = await api<Schema<"PageMember">>(
          `${base}/members?limit=100${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== lifetime.current) return;
        setMembers((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setMemberCursor(result.data.nextCursor);
        setMemberError("");
      } catch (err) {
        if (generation !== lifetime.current) return;
        setMembers([]);
        setMemberCursor(null);
        setMemberError(err instanceof Error ? err.message : "Member directory unavailable.");
        if (err instanceof ApiError && [401, 403].includes(err.status)) {
          clearPrivate();
        }
      }
    },
    [online, session.permissions, base, clearPrivate],
  );
  useEffect(() => {
    if (canReplace) void loadMembers();
  }, [canReplace, loadMembers]);
  const checkJob = useCallback(async () => {
    if (
      !job ||
      !online ||
      !session.permissions.includes("jobs.read") ||
      checkingRef.current ||
      protectedRef.current
    )
      return;
    const generation = lifetime.current;
    checkingRef.current = true;
    setChecking(true);
    try {
      const result = await api<Schema<"Job">>(`${base}/jobs/${job.id}`);
      if (generation !== lifetime.current) return;
      setJob(result.data);
      setJobError("");
      if (result.data.state === "succeeded") await load();
    } catch (err) {
      if (generation !== lifetime.current) return;
      setJobError(
        err instanceof Error ? err.message : "Current job status unavailable. Last reported state is shown.",
      );
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [job, online, session.permissions, base, load, clearPrivate]);
  useEffect(() => {
    if (!pending || !online) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkJob();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, online, checkJob]);
  function change(id: string, patch: Partial<Rule>) {
    setDraft((current) => current.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
    setDirty(true);
    setNotice("");
  }
  function addRule() {
    const used = new Set(draft.map((rule) => rule.priority));
    const priority = Array.from({ length: 101 }, (_, index) => index).find((value) => !used.has(value));
    if (priority === undefined || draft.length >= 100) return;
    setDraft((current) => [
      ...current,
      { id: crypto.randomUUID(), priority, kind: "first_touch", enabled: true, version: 1 },
    ]);
    setDirty(true);
  }
  async function discard() {
    if (
      working ||
      !online ||
      ((dirty || uncertain) &&
        !window.confirm(
          "Discard this routing proposal and reload? If a previous command has an unknown result, inspect the server configuration before creating another command.",
        ))
    )
      return;
    await load();
  }
  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canReplace || !version || stale || working || !online || pending) return;
    if (new Set(draft.map((rule) => rule.priority)).size !== draft.length) {
      setError("Every routing priority must be unique.");
      return;
    }
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    try {
      const body: Schema<"RoutingWrite"> = { rules: draft };
      const accepted = await runCommand<Schema<"Job">>(`${base}/routing`, body, "PUT", version);
      if (generation !== lifetime.current) return;
      setJob(accepted);
      setJobError("");
      setDirty(false);
      setUncertain(false);
      setEditing(false);
      setCanReplace(false);
      setNotice(
        "Routing replacement was accepted. The job and refreshed server configuration establish its result.",
      );
      if (accepted.state === "succeeded") await load();
    } catch (err) {
      if (generation !== lifetime.current) return;
      setError(
        err instanceof ApiError && err.status === 412
          ? "Routing or a rule version changed. Your proposal is preserved. Discard and reload the complete configuration before saving again."
          : err instanceof Error
            ? err.message
            : "Routing command status unavailable. Retry the unchanged proposal to reconcile its result.",
      );
      if (err instanceof ApiError && err.status === 412) setStale(true);
      if (!(err instanceof ApiError) || err.status >= 500) setUncertain(true);
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
    } finally {
      setWorking(false);
    }
  }
  const activeMembers = members.filter((member) => member.status === "active");
  return (
    <section className="routing-section" aria-label="Routing configuration">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">ASSIGNMENT RULES</span>
          <h2>A deliberate next owner.</h2>
          <p className="section-description">
            Enabled rules run by numeric priority, lowest first. The seeded order is first touch, listing
            attribution, then weighted round robin. No eligible recipient falls back to an unassigned queue
            when the caller’s scope permits it.
          </p>
        </div>
        <Button
          variant="secondary"
          disabled={working || loading || dirty || uncertain || !online || pending}
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
          Refresh routing
        </Button>
      </div>
      <div className="synthetic-note">
        <GitBranch size={20} />
        <p>
          Listing attribution is unavailable in this synthetic environment. No live MLS provider or public
          inquiry endpoint is connected. Members and eligibility are rechecked by the server for every
          assignment.
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
      <section className="panel routing-list">
        <div className="panel-heading">
          <h2>Server routing configuration</h2>
          <Badge>
            {loading
              ? "Loading…"
              : loaded
                ? `${rules.length} rules · aggregate v${version ?? "unavailable"}`
                : "Unavailable"}
          </Badge>
          {canReplace && (
            <Button disabled={working || !online || pending || editing} onClick={() => setEditing(true)}>
              Review routing replacement
            </Button>
          )}
        </div>
        <p className="routing-scope-note">
          {canReplace
            ? "The server verified organization read and management scope, and every configuration page has the same aggregate version. Replacement is reauthorized when submitted."
            : "This may be a scoped projection with recipients or rules omitted. It is read-only; permission names and an aggregate version do not establish complete replacement authority."}
        </p>
        {rules.length ? (
          <div className="workspace-record-rows">
            {rules.map((rule) => (
              <article key={rule.id}>
                <div>
                  <h3>
                    {rule.priority} · {kinds.find((kind) => kind.code === rule.kind)?.label || rule.kind}
                  </h3>
                  <p>
                    {rule.kind === "listing_agent"
                      ? "Resolver unavailable"
                      : rule.kind === "first_touch"
                        ? "Retains an eligible existing first-touch owner"
                        : `${rule.memberWeights?.length || 0} visible recipients${rule.kind === "geography" ? ` · ${rule.postalCodes?.join(", ") || "No postal codes"}` : ""}`}
                  </p>
                  <span>
                    Rule version {rule.version} · {rule.id}
                  </span>
                </div>
                <Badge tone={rule.enabled ? "positive" : "neutral"}>
                  {rule.enabled ? "Enabled" : "Disabled"}
                </Badge>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<GitBranch size={30} />}
            title={
              loading ? "Loading routing rules" : loaded ? "No visible routing rules" : "Routing unavailable"
            }
          >
            A scoped read does not prove that the organization has no configuration.
          </Empty>
        )}
      </section>
      {editing && (
        <section className="panel settings-card routing-editor">
          <h3 ref={editor} tabIndex={-1}>
            Review complete routing replacement
          </h3>
          <p className="muted">
            Removing a rule retires its ID permanently. Priority and enabled state changes do not route
            existing leads again. Save replaces the entire organization configuration.
          </p>
          {memberError && (
            <div className="error" role="alert">
              {memberError}
            </div>
          )}
          {!session.permissions.includes("members.read") && (
            <p className="muted">
              Member directory access is unavailable. Existing configured recipient IDs are preserved; new
              recipients cannot be selected.
            </p>
          )}
          <form onSubmit={replace} className="settings-form">
            <fieldset disabled={working || !online || stale || uncertain || !canReplace || pending}>
              {draft.map((rule, index) => (
                <fieldset className="routing-rule-editor" key={rule.id}>
                  <legend>
                    Rule {index + 1} · version {rule.version}
                  </legend>
                  <div className="form-columns">
                    <label>
                      Routing kind
                      <select
                        value={rule.kind}
                        onChange={(event) => {
                          setPostalDraft((current) => ({ ...current, [rule.id]: "" }));
                          change(rule.id, {
                            kind: event.target.value as Rule["kind"],
                            memberWeights: [],
                            postalCodes: [],
                          });
                        }}
                      >
                        {kinds.map((kind) => (
                          <option key={kind.code} value={kind.code}>
                            {kind.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Routing priority
                      <input
                        required
                        type="number"
                        min="0"
                        max="100"
                        step="1"
                        value={rule.priority}
                        onChange={(event) => change(rule.id, { priority: Number(event.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(event) => change(rule.id, { enabled: event.target.checked })}
                    />
                    <span>Enable this routing rule</span>
                  </label>
                  {rule.kind === "listing_agent" && (
                    <p className="muted">
                      This rule currently records listing_attribution_unavailable and continues to the next
                      eligible rule.
                    </p>
                  )}
                  {rule.kind === "geography" && (
                    <label>
                      Postal routing codes
                      <input
                        required
                        maxLength={8498}
                        value={postalDraft[rule.id] || ""}
                        onChange={(event) => {
                          setPostalDraft((current) => ({ ...current, [rule.id]: event.target.value }));
                          change(rule.id, {
                            postalCodes: event.target.value
                              .split(",")
                              .map((value) => value.trim().toUpperCase())
                              .filter(Boolean),
                          });
                        }}
                      />
                      <span className="field-help">
                        Comma-separated postal codes, up to 16 letters, numbers, spaces or hyphens each. Up to
                        500 unique values.
                      </span>
                    </label>
                  )}
                  {["geography", "round_robin"].includes(rule.kind) && (
                    <fieldset className="routing-recipients">
                      <legend>Weighted recipients</legend>
                      {(rule.memberWeights || []).map((recipient, recipientIndex) => (
                        <div className="routing-recipient" key={`${rule.id}:${recipientIndex}`}>
                          <label>
                            Recipient member
                            <select
                              required
                              value={recipient.memberId}
                              onChange={(event) =>
                                change(rule.id, {
                                  memberWeights: rule.memberWeights!.map((item, i) =>
                                    i === recipientIndex ? { ...item, memberId: event.target.value } : item,
                                  ),
                                })
                              }
                            >
                              <option value="" disabled>
                                Select a member
                              </option>
                              {recipient.memberId &&
                                !activeMembers.some((member) => member.id === recipient.memberId) && (
                                  <option value={recipient.memberId}>
                                    Configured member · {recipient.memberId.slice(0, 8)} · Eligibility
                                    rechecked
                                  </option>
                                )}
                              {activeMembers.map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.displayName}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Recipient weight
                            <input
                              required
                              type="number"
                              min="1"
                              max="1000"
                              step="1"
                              value={recipient.weight}
                              onChange={(event) =>
                                change(rule.id, {
                                  memberWeights: rule.memberWeights!.map((item, i) =>
                                    i === recipientIndex
                                      ? { ...item, weight: Number(event.target.value) }
                                      : item,
                                  ),
                                })
                              }
                            />
                          </label>
                          <Button
                            type="button"
                            variant="secondary"
                            aria-label={`Remove recipient ${recipientIndex + 1} from rule ${index + 1}`}
                            onClick={() =>
                              change(rule.id, {
                                memberWeights: rule.memberWeights!.filter((_, i) => i !== recipientIndex),
                              })
                            }
                          >
                            <Trash2 size={16} />
                            Remove
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!activeMembers.length || (rule.memberWeights?.length || 0) >= 100}
                        onClick={() =>
                          change(rule.id, {
                            memberWeights: [
                              ...(rule.memberWeights || []),
                              {
                                memberId:
                                  activeMembers.find(
                                    (member) =>
                                      !rule.memberWeights?.some((item) => item.memberId === member.id),
                                  )?.id || "",
                                weight: 1,
                              },
                            ],
                          })
                        }
                      >
                        <Plus size={16} />
                        Add weighted recipient
                      </Button>
                      {!rule.memberWeights?.length && (
                        <p className="muted">At least one eligible recipient is required for this kind.</p>
                      )}
                    </fieldset>
                  )}
                  <div className="routing-rule-footer">
                    <span className="muted">Immutable ID {rule.id}</span>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        if (
                          window.confirm(
                            "Retire this rule when the replacement is saved? Its ID cannot be reactivated.",
                          )
                        ) {
                          setDraft((current) => current.filter((item) => item.id !== rule.id));
                          setDirty(true);
                        }
                      }}
                    >
                      <Trash2 size={16} />
                      Retire rule {index + 1}
                    </Button>
                  </div>
                </fieldset>
              ))}
              <div className="form-actions">
                <Button variant="secondary" type="button" disabled={draft.length >= 100} onClick={addRule}>
                  <Plus size={16} />
                  Add routing rule
                </Button>
                {memberCursor && (
                  <Button variant="secondary" type="button" onClick={() => void loadMembers(memberCursor)}>
                    Load more routing members
                  </Button>
                )}
              </div>
            </fieldset>
            <div className="routing-replacement-actions">
              <Button
                type="button"
                variant="secondary"
                disabled={working || !online}
                onClick={() => void discard()}
              >
                Discard and reload routing
              </Button>
              <Button
                type="submit"
                disabled={!dirty || working || !online || stale || !canReplace || pending}
              >
                {uncertain ? "Retry unchanged routing replacement" : "Save complete routing replacement"}
              </Button>
            </div>
          </form>
        </section>
      )}
      {job && (
        <section className="panel settings-card routing-job">
          <div className="panel-heading">
            <h3>Routing operation</h3>
            <Badge tone={job.state === "succeeded" ? "positive" : "neutral"}>
              {jobError ? "Last reported: " : ""}
              {job.state}
            </Badge>
          </div>
          <p className="muted">
            {job.kind} · {job.id}. Configuration and rule versions come from a fresh authorized read.
          </p>
          {jobError && (
            <div className="error" role="alert">
              {jobError}
            </div>
          )}
          <Button
            variant="secondary"
            disabled={
              working ||
              checking ||
              dirty ||
              uncertain ||
              !online ||
              !session.permissions.includes("jobs.read")
            }
            onClick={() => void checkJob()}
          >
            {checking ? "Checking…" : "Refresh routing job"}
          </Button>
        </section>
      )}
    </section>
  );
}
