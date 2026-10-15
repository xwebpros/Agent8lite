"use client";

import { Activity, Download, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api } from "../lib/api";
import type { Schema } from "../lib/api";

type Job = {
  id: string;
  state: "queued" | "pending" | "succeeded" | "failed" | "unknown";
  kind: string;
  createdAt: string;
  resultUrl?: string | null;
  error?: { title?: string; detail?: string } | null;
};
type PageJob = { items: Job[]; nextCursor?: string | null };

type Props = {
  session: Schema<"Session">;
  online: boolean;
};

function stateTone(state: Job["state"]): "positive" | "warning" | "neutral" {
  if (state === "succeeded") return "positive";
  if (state === "failed") return "warning";
  return "neutral";
}

function formatKind(kind: string): string {
  return kind.replace(/\./g, " · ");
}

export default function JobsPanel({ session, online }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const epoch = useRef(0);

  const canRead = session.permissions.includes("jobs.read");
  const base = `/v1/orgs/${session.activeOrgId}/jobs`;

  const load = useCallback(
    async (next?: string) => {
      if (!canRead || !session.activeOrgId) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<PageJob>(
          `${base}?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setJobs((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setCursor(result.data.nextCursor ?? null);
        setRefreshed(new Date().toISOString());
      } catch (err) {
        if (generation !== epoch.current) return;
        setJobs([]);
        setCursor(null);
        setRefreshed(null);
        setError(err instanceof Error ? err.message : "Integration jobs unavailable.");
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [session.activeOrgId, canRead, base],
  );

  useEffect(() => {
    if (online) void load();
    return () => {
      ++epoch.current;
    };
  }, [load, online]);

  return (
    <section className="support-section" aria-label="Integration jobs">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">JOBS</span>
          <h2>Integration jobs</h2>
          <p className="section-description">
            Background jobs for broadcasts, exports and member invitations scoped to this organization.
          </p>
        </div>
        <div className="heading-actions">
          <Button
            variant="secondary"
            disabled={loading || !online || !canRead}
            onClick={() => void load()}
          >
            <RefreshCw size={16} />
            Refresh jobs
          </Button>
        </div>
      </div>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      <section className="panel ticket-panel">
        <div className="panel-heading">
          <h2>
            <Activity size={19} />
            Recent jobs
          </h2>
          <Badge>{loading ? "Loading…" : `${jobs.length} loaded`}</Badge>
        </div>
        {jobs.length ? (
          <div className="ticket-list">
            {jobs.map((job) => (
              <div className="ticket-row" key={job.id}>
                <div>
                  <strong>{formatKind(job.kind)}</strong>
                  <span>
                    {new Date(job.createdAt).toLocaleString()}
                  </span>
                  {job.state === "failed" && job.error && (
                    <span className="muted" style={{ display: "block", marginTop: 4 }}>
                      {job.error.detail || job.error.title || "Job failed"}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {job.resultUrl && job.state === "succeeded" && (
                    <a
                      href={job.resultUrl}
                      download
                      className="icon-button"
                      aria-label="Download export result"
                    >
                      <Download size={16} />
                    </a>
                  )}
                  <Badge tone={stateTone(job.state)}>{job.state}</Badge>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Activity size={30} />}
            title={
              loading
                ? "Loading jobs"
                : refreshed
                  ? "No jobs yet"
                  : "Jobs unavailable"
            }
          >
            {refreshed
              ? "Jobs will appear here when broadcasts, exports or invitations run."
              : "Connect and refresh to read jobs permitted for your membership."}
          </Empty>
        )}
        {cursor && (
          <div className="pagination">
            <Button
              variant="secondary"
              disabled={loading || !online}
              onClick={() => void load(cursor)}
            >
              Load more jobs
            </Button>
          </div>
        )}
        <p className="panel-footer muted">
          {refreshed
            ? "List read from the jobs API. Only jobs scoped to your organization are shown."
            : "No measured list refresh available."}
        </p>
      </section>
    </section>
  );
}
