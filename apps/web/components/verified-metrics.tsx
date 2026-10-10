"use client";

import { useEffect, useRef, useState } from "react";
import { BarChart3 } from "lucide-react";
import { Badge } from "../../../packages/ui/components";
import { api } from "../lib/api";
import type { Schema } from "../lib/api";

export default function VerifiedMetrics({
  organizationId,
  refreshMarker,
  online,
}: {
  organizationId: string;
  refreshMarker: string | null;
  online: boolean;
}) {
  const [snapshot, setSnapshot] = useState<Schema<"Dashboard"> | null>(null);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    setSnapshot(null);
    setError("");
    if (!online) {
      setError("The reporting service is unavailable while offline.");
      return;
    }
    void api<Schema<"Dashboard">>(`/v1/orgs/${organizationId}/dashboard`)
      .then((result) => {
        if (generation === epoch.current) setSnapshot(result.data);
      })
      .catch((err) => {
        if (generation === epoch.current)
          setError(err instanceof Error ? err.message : "Reporting unavailable.");
      });
    return () => {
      ++epoch.current;
    };
  }, [organizationId, refreshMarker, online]);
  const when = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: snapshot?.period.timezone || "UTC",
    }).format(new Date(value));
  return (
    <section className="panel verified-panel">
      <div className="panel-heading">
        <h2>
          <BarChart3 size={18} />
          Verified reporting
        </h2>
        <Badge>API-defined permission scope</Badge>
      </div>
      {snapshot ? (
        <>
          <div className="verified-period">
            Period: {when(snapshot.period.from)} – {when(snapshot.period.to)} · {snapshot.period.timezone}
            <span>
              Reporting uses the server’s permitted scope. The workspace list selector does not change this
              report.
            </span>
          </div>
          <div className="verified-metrics">
            {snapshot.metrics.map((metric) => (
              <article key={metric.key}>
                <span>{metric.key}</span>
                <strong>
                  {metric.state === "available" && metric.value !== null
                    ? metric.value.toLocaleString()
                    : "—"}
                </strong>
                <Badge tone={metric.state === "available" ? "positive" : "neutral"}>{metric.state}</Badge>
                <p>
                  Definition v{metric.definitionVersion} · Unit: {metric.unit}
                </p>
                {metric.denominator != null && <p>Denominator: {metric.denominator}</p>}
                <p>Source: {metric.source}</p>
                <p>
                  {metric.refreshedAt
                    ? `Refreshed ${when(metric.refreshedAt)}`
                    : "No measured refresh available"}
                </p>
              </article>
            ))}
          </div>
        </>
      ) : (
        <p className="verified-unavailable">{error || "Loading verified report…"}</p>
      )}
    </section>
  );
}
