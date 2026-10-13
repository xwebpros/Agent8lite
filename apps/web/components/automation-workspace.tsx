"use client";

import {
  FlaskConical,
  FolderOpen,
  Plus,
  RefreshCw,
  WifiOff,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import styles from "./automation-workspace.module.css";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type Automation = {
  id: string;
  version: number;
  definition: {
    name: string;
    trigger: string;
    conditions: unknown;
    campaignVersionId: string;
    restartPolicy: string;
    active: boolean;
    inactivitySeconds?: number;
  };
};

type Enrollment = {
  id: string;
  leadId: string;
  campaignVersionId: string;
  state: string;
  currentStep: string | null;
  version: number;
};

export type AutomationWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  memberId?: string;
  onDirty(value: boolean): void;
  onAccessRevoked?(): void;
};

type CreateFormState = {
  name: string;
  trigger: string;
  campaignVersionId: string;
  restartPolicy: string;
};

const defaultCreate: CreateFormState = {
  name: "",
  trigger: "lead_created",
  campaignVersionId: "",
  restartPolicy: "never",
};

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function AutomationWorkspace({
  session,
  csrf,
  online,
  syntheticFeaturesEnabled,
  accessRevision,
  memberId,
  onDirty,
  onAccessRevoked,
}: AutomationWorkspaceProps) {
  const canRead = session.permissions.includes("automations.read");
  const canWrite = session.permissions.includes("automations.write");
  const active = syntheticFeaturesEnabled && Boolean(session.activeOrgId);
  const orgId = session.activeOrgId;
  const basePath = `/v1/orgs/${orgId}/automations`;
  const enrollPath = `/v1/orgs/${orgId}/enrollments`;

  /* list state */
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* create form */
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateFormState>(defaultCreate);
  const [saving, setSaving] = useState(false);

  const nameId = useId();
  const triggerId = useId();
  const campaignId = useId();
  const restartId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const callbacks = useRef({ onDirty, onAccessRevoked });
  callbacks.current = { onDirty, onAccessRevoked };

  /* dirty tracking */
  const dirty = creating && (form.name.trim() !== "" || form.campaignVersionId.trim() !== "");
  useEffect(() => {
    callbacks.current.onDirty(dirty || saving);
  }, [dirty, saving]);

  /* ---- data fetching ---- */

  const loadAutomations = useCallback(async () => {
    if (!online || !active || !canRead || !orgId) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await api<{ items: Automation[]; hasMore: boolean }>(
        `${basePath}?limit=50`,
        { headers: { "X-CSRF-Token": csrf } },
      );
      setAutomations(data.items);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        callbacks.current.onAccessRevoked?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not load automations.");
    } finally {
      setLoading(false);
    }
  }, [online, active, canRead, orgId, basePath, csrf]);

  const loadEnrollments = useCallback(async () => {
    if (!online || !active || !canRead || !orgId) return;
    try {
      const { data } = await api<{ items: Enrollment[]; hasMore: boolean }>(
        `${enrollPath}?limit=50`,
        { headers: { "X-CSRF-Token": csrf } },
      );
      setEnrollments(data.items);
    } catch {
      /* enrollment list failure is non-fatal */
    }
  }, [online, active, canRead, orgId, enrollPath, csrf]);

  useEffect(() => {
    void loadAutomations();
    void loadEnrollments();
  }, [loadAutomations, loadEnrollments]);

  /* ---- mutations ---- */

  const toggleActive = async (automation: Automation) => {
    if (!online || !canWrite) return;
    setError(null);
    try {
      const { data } = await api<Automation>(`${basePath}/${automation.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "If-Match": `"${automation.version}"`,
        },
        body: JSON.stringify({
          active: !automation.definition.active,
        }),
      });
      setAutomations((prev) => prev.map((a) => (a.id === data.id ? data : a)));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        callbacks.current.onAccessRevoked?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not toggle automation.");
    }
  };

  const createAutomation = async () => {
    if (!online || !canWrite || saving) return;
    const name = form.name.trim();
    const cvId = form.campaignVersionId.trim();
    if (!name || !cvId) {
      setError("Name and campaign version ID are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { data } = await api<Automation>(basePath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          name,
          trigger: form.trigger,
          campaignVersionId: cvId,
          restartPolicy: form.restartPolicy,
        }),
      });
      setAutomations((prev) => [data, ...prev]);
      setCreating(false);
      setForm(defaultCreate);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        callbacks.current.onAccessRevoked?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not create automation.");
    } finally {
      setSaving(false);
    }
  };

  const cancelEnrollment = async (enrollment: Enrollment) => {
    if (!online || !canWrite) return;
    setError(null);
    try {
      const { data } = await api<Enrollment>(`${enrollPath}/${enrollment.id}/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
      });
      setEnrollments((prev) => prev.map((e) => (e.id === data.id ? data : e)));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 401)) {
        callbacks.current.onAccessRevoked?.();
        return;
      }
      setError(err instanceof Error ? err.message : "Could not cancel enrollment.");
    }
  };

  /* ---- rendering ---- */

  if (!active)
    return (
      <Empty icon={<Zap size={30} />} title="Automation workspace unavailable">
        Choose an organization in an explicitly enabled synthetic session.
      </Empty>
    );
  if (!canRead)
    return (
      <Empty icon={<Zap size={30} />} title="Automation read access unavailable">
        This workspace requires current automation read access.
      </Empty>
    );

  return (
    <section className={styles.workspace} aria-label="Automation workspace">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Marketing automation</p>
          <h2>Automations</h2>
          <p>Create trigger-based automations that enroll leads into campaigns.</p>
        </div>
        <Badge tone="warning">Synthetic</Badge>
      </header>

      <div className={styles.notice}>
        <FlaskConical size={22} aria-hidden="true" />
        <p>
          Manage automation rules and view enrollment state. Actual delivery and scheduling are
          unavailable in synthetic mode.
        </p>
      </div>

      {!online && (
        <div className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" />
          <p>Offline. Mutations are disabled until connectivity is restored.</p>
        </div>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <div className={styles.layout}>
        {/* ---- Automations list ---- */}
        <section className={styles.card} aria-label="Automation rules">
          <div className={styles.heading}>
            <h3>
              <FolderOpen size={19} aria-hidden="true" /> Automation rules
            </h3>
            <Button variant="secondary" disabled={!online || loading} onClick={() => void loadAutomations()}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </Button>
          </div>
          <p className={styles.help}>
            Automations trigger campaign enrollments based on lead events.
          </p>
          {loading && <p role="status">Loading automations...</p>}
          {!loading && automations.length === 0 && (
            <div className={styles.empty}>
              <Zap size={28} aria-hidden="true" />
              <p>No automations found. Create one to get started.</p>
            </div>
          )}
          {automations.length > 0 && (
            <ul className={styles.records}>
              {automations.map((a) => (
                <li key={a.id} className={styles.record}>
                  <span className={styles.recordText}>
                    <strong>{a.definition.name}</strong>
                    <span>Trigger: {a.definition.trigger}</span>
                    <span>Campaign: {a.definition.campaignVersionId}</span>
                    <span>Restart: {a.definition.restartPolicy}</span>
                  </span>
                  <div className={styles.actions}>
                    <Badge tone={a.definition.active ? "positive" : "neutral"}>
                      {a.definition.active ? "Active" : "Inactive"}
                    </Badge>
                    {canWrite && (
                      <Button
                        variant="quiet"
                        disabled={!online}
                        onClick={() => void toggleActive(a)}
                      >
                        {a.definition.active ? "Deactivate" : "Activate"}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {canWrite && !creating && (
            <Button
              disabled={!online || loading}
              onClick={() => {
                setCreating(true);
                requestAnimationFrame(() => nameRef.current?.focus());
              }}
            >
              <Plus size={17} aria-hidden="true" /> New automation
            </Button>
          )}

          {/* ---- Create form ---- */}
          {creating && canWrite && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void createAutomation();
              }}
            >
              <fieldset disabled={!online || saving}>
                <legend className={styles.srOnly}>New automation fields</legend>

                <label htmlFor={nameId}>Automation name</label>
                <input
                  ref={nameRef}
                  id={nameId}
                  value={form.name}
                  required
                  maxLength={240}
                  autoComplete="off"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />

                <label htmlFor={triggerId}>Trigger type</label>
                <select
                  id={triggerId}
                  value={form.trigger}
                  onChange={(e) => setForm((f) => ({ ...f, trigger: e.target.value }))}
                >
                  <option value="lead_created">Lead created</option>
                  <option value="lead_updated">Lead updated</option>
                  <option value="tag_added">Tag added</option>
                  <option value="stage_changed">Stage changed</option>
                </select>

                <label htmlFor={campaignId}>Campaign version ID</label>
                <input
                  id={campaignId}
                  value={form.campaignVersionId}
                  required
                  maxLength={240}
                  autoComplete="off"
                  onChange={(e) => setForm((f) => ({ ...f, campaignVersionId: e.target.value }))}
                />

                <label htmlFor={restartId}>Restart policy</label>
                <select
                  id={restartId}
                  value={form.restartPolicy}
                  onChange={(e) => setForm((f) => ({ ...f, restartPolicy: e.target.value }))}
                >
                  <option value="never">Never</option>
                  <option value="always">Always</option>
                  <option value="after_completion">After completion</option>
                </select>
              </fieldset>

              <div className={styles.actions}>
                <Button type="submit" disabled={!online || saving}>
                  {saving ? "Creating..." : "Create automation"}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={saving}
                  onClick={() => {
                    setCreating(false);
                    setForm(defaultCreate);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </section>

        {/* ---- Enrollments list ---- */}
        <section className={styles.card} aria-label="Current enrollments">
          <div className={styles.heading}>
            <h3>
              <FolderOpen size={19} aria-hidden="true" /> Enrollments
            </h3>
            <Button variant="secondary" disabled={!online || loading} onClick={() => void loadEnrollments()}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </Button>
          </div>
          <p className={styles.help}>
            Leads currently enrolled in automation-driven campaigns.
          </p>
          {enrollments.length === 0 && (
            <div className={styles.empty}>
              <Zap size={28} aria-hidden="true" />
              <p>No enrollments found.</p>
            </div>
          )}
          {enrollments.length > 0 && (
            <ul className={styles.records}>
              {enrollments.map((e) => (
                <li key={e.id} className={styles.record}>
                  <span className={styles.recordText}>
                    <strong>Lead: {e.leadId}</strong>
                    <span>Campaign: {e.campaignVersionId}</span>
                    <span>State: {e.state}</span>
                    {e.currentStep && <span>Step: {e.currentStep}</span>}
                  </span>
                  <div className={styles.actions}>
                    <Badge tone={e.state === "active" ? "positive" : "neutral"}>
                      {e.state}
                    </Badge>
                    {canWrite && e.state === "active" && (
                      <Button
                        variant="quiet"
                        disabled={!online}
                        onClick={() => void cancelEnrollment(e)}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
