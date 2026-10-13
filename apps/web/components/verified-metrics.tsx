"use client";

import { BarChart3, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge, Button } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  DashboardReportController,
  dashboardMetricPresentation,
  dashboardReportContextBinding,
  dashboardReportExpired,
  dashboardReportRequest,
  formatDashboardInstant,
  requireDashboardReport,
  validDashboardTimezone,
  type DashboardReportState,
} from "./verified-metrics-controller";
import styles from "./verified-metrics.module.css";

export type VerifiedMetricsProps = {
  session: Schema<"Session">;
  memberId: string;
  accessRevision: number;
  online: boolean;
  changingOrganization?: boolean;
  refreshMarker: string | null;
  onAccessRevoked?(): void;
};
const stateLabels = {
  available: "Available measurement",
  loading: "Measurement loading",
  empty: "Empty · no measurement",
  unavailable: "Measurement unavailable",
  unsupported: "Unsupported definition",
  stale: "Stale · refresh required",
};

/** Reporting metrics are independent of loaded-list inventory and the workspace scope selector. */
export function VerifiedMetricsView({
  state,
  userTimezone,
  nowInstant,
  actions,
}: {
  state: DashboardReportState;
  userTimezone: unknown;
  nowInstant: unknown;
  actions: { refresh(): void };
}) {
  const heading = useId();
  const readable = state.online && state.visible && state.canRead;
  let report: Schema<"Dashboard"> | null = null,
    invalid = false;
  if (readable && state.snapshot) {
    try {
      report = requireDashboardReport(state.snapshot);
    } catch {
      invalid = true;
    }
  }
  const stale = state.stale || Boolean(report && dashboardReportExpired(report, nowInstant));
  if (stale) report = null;
  const message = !state.online
    ? "Offline. Private reporting values are hidden until you reconnect."
    : !state.visible
      ? "Private reporting values are hidden while this view is inactive."
      : !state.canRead
        ? "Reporting access is unavailable. Use Refresh workspace to verify current report access before reopening this report."
        : state.reading
          ? "Loading your current-member report…"
          : stale
            ? "Reporting snapshot is stale. Values are withheld until a new measurement is read."
            : invalid
              ? "Reporting metadata is unavailable. Refresh to read a verified response."
              : !report
                ? state.phase === "unavailable"
                  ? "Reporting is unavailable. Retry the current report when connected."
                  : "Refresh reporting to read your current measurement."
                : null;
  return (
    <section className={styles.panel} aria-labelledby={heading}>
      <header className={styles.header}>
        <div>
          <h2 id={heading}>
            <BarChart3 size={21} aria-hidden="true" />
            Measured reporting
          </h2>
          <p>
            Current member only · Current lead-read permission applies. The workspace list selector does not
            widen this report.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!readable || state.reading}
          onClick={actions.refresh}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {state.reading ? "Refreshing reporting…" : "Refresh reporting"}
        </Button>
      </header>
      <p className={styles.caption}>
        Reporting values measure the returned period. Loaded-list summary cards below describe their own
        loaded records.
      </p>
      {message && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
      {report && !state.reading && (
        <>
          <p className={styles.scope}>
            Closed reporting period · UTC timezone (GMT+0):{" "}
            <time dateTime={report.period.from}>{report.period.from}</time> through{" "}
            <time dateTime={report.period.to}>{report.period.to}</time>, including both bounds.
          </p>
          {validDashboardTimezone(userTimezone) ? (
            userTimezone !== "UTC" && (
              <p className={styles.scope}>
                Your time ({userTimezone}): {formatDashboardInstant(report.period.from, userTimezone)} through{" "}
                {formatDashboardInstant(report.period.to, userTimezone)}. This does not change the UTC-month
                definition.
              </p>
            )
          ) : (
            <p className={styles.scope}>
              Your timezone is unavailable. Use the explicitly labeled UTC references.
            </p>
          )}
          {report.metrics.length === 0 ? (
            <p className={styles.message}>
              No measured metrics were returned. No engagement or revenue is inferred.
            </p>
          ) : (
            <div className={styles.metrics}>
              {report.metrics.map((metric) => {
                const presentation = dashboardMetricPresentation(metric, nowInstant);
                const validMeasurement = presentation.state === "available";
                return (
                  <article key={metric.key} className={styles.card}>
                    <h3>{presentation.definition?.title || "Unsupported metric definition"}</h3>
                    <strong className={styles.value}>
                      {validMeasurement && presentation.value !== null
                        ? presentation.value.toLocaleString("en-US")
                        : "—"}
                    </strong>
                    <Badge tone={validMeasurement ? "positive" : "neutral"}>
                      {stateLabels[presentation.state]}
                    </Badge>
                    <p>
                      {presentation.definition?.description ||
                        "This metric definition is not supported by the current reporting view. Its numeric value is withheld."}
                    </p>
                    <dl>
                      <div>
                        <dt>Definition</dt>
                        <dd>
                          {metric.key} · version {metric.definitionVersion}
                        </dd>
                      </div>
                      <div>
                        <dt>Unit</dt>
                        <dd>{metric.unit}</dd>
                      </div>
                      <div>
                        <dt>Numerator</dt>
                        <dd>
                          {validMeasurement && presentation.value !== null
                            ? "Measured count: " + presentation.value.toLocaleString("en-US")
                            : "No verified measured value"}
                        </dd>
                      </div>
                      <div>
                        <dt>Denominator</dt>
                        <dd>
                          {presentation.definition?.denominator ||
                            "Relevance unavailable for this unsupported definition."}
                        </dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>{metric.source}</dd>
                      </div>
                      <div>
                        <dt>Period · UTC (GMT+0)</dt>
                        <dd>
                          <time dateTime={report.period.from}>{report.period.from}</time> through{" "}
                          <time dateTime={report.period.to}>{report.period.to}</time>
                        </dd>
                      </div>
                      <div>
                        <dt>Measured refresh · UTC</dt>
                        <dd>
                          {validMeasurement && metric.refreshedAt ? (
                            <time dateTime={metric.refreshedAt}>{metric.refreshedAt}</time>
                          ) : (
                            "No verified measured refresh available"
                          )}
                        </dd>
                      </div>
                      {validMeasurement &&
                        metric.refreshedAt &&
                        validDashboardTimezone(userTimezone) &&
                        userTimezone !== "UTC" && (
                          <div>
                            <dt>Measured refresh · your time ({userTimezone})</dt>
                            <dd>{formatDashboardInstant(metric.refreshedAt, userTimezone)}</dd>
                          </div>
                        )}
                    </dl>
                  </article>
                );
              })}
            </div>
          )}
          {report.integrationHealth.length > 0 && (
            <div className={styles.integrations}>
              <h3>Connected services</h3>
              {report.integrationHealth.map((integration) => (
                <div key={integration.id} className={styles.integrationRow}>
                  <strong>{integration.provider}</strong>
                  <Badge
                    tone={
                      integration.state === "ready"
                        ? "positive"
                        : integration.state === "degraded"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {integration.state}
                  </Badge>
                  <span className={styles.integrationMode}>{integration.mode}</span>
                </div>
              ))}
            </div>
          )}
          {state.receivedAt && (
            <p className={styles.caption}>
              Report read at <time dateTime={state.receivedAt}>{state.receivedAt}</time> (UTC). This is
              distinct from each source’s measured refresh.
            </p>
          )}
        </>
      )}
      <p className={styles.caption}>
        Values expire from this view after five minutes without a new successful measurement. This
        presentation limit is not a provider service guarantee. No calendar synchronization, delivery,
        engagement or revenue connection is inferred. Private reporting data stays only in this tab’s memory.
      </p>
    </section>
  );
}

export default function VerifiedMetrics(props: VerifiedMetricsProps) {
  const live = useRef(props);
  live.current = props;
  const binding = dashboardReportContextBinding(props);
  const verifiedRefresh = useRef({ binding, marker: props.refreshMarker });
  if (
    verifiedRefresh.current.binding !== binding ||
    (props.refreshMarker !== null && verifiedRefresh.current.marker !== props.refreshMarker)
  )
    verifiedRefresh.current = { binding, marker: props.refreshMarker };
  // A cleared list marker is not renewed authority; only a successful verified read can revive a denied controller.
  const refreshMarker = verifiedRefresh.current.marker;
  const canRead =
    props.session.permissions.includes("dashboard.read") &&
    props.session.permissions.includes("crm.leads.read") &&
    Boolean(props.session.activeOrgId && props.memberId);
  const [clock, setClock] = useState<string | null>(null);
  const controller = useMemo(
    () =>
      new DashboardReportController({
        binding,
        online: props.online && !props.changingOrganization,
        canRead,
        isCurrent: () =>
          dashboardReportContextBinding(live.current) === binding &&
          live.current.refreshMarker === refreshMarker &&
          live.current.online &&
          !live.current.changingOrganization &&
          live.current.session.permissions.includes("dashboard.read") &&
          live.current.session.permissions.includes("crm.leads.read") &&
          document.visibilityState === "visible",
        client: {
          read: (signal) => {
            if (
              dashboardReportContextBinding(live.current) !== binding ||
              live.current.refreshMarker !== refreshMarker ||
              !live.current.online ||
              live.current.changingOrganization ||
              !live.current.session.permissions.includes("dashboard.read") ||
              !live.current.session.permissions.includes("crm.leads.read") ||
              document.visibilityState !== "visible"
            )
              return Promise.reject(new Error("Reporting context is unavailable."));
            return dashboardReportRequest(live.current.session.activeOrgId || "", signal);
          },
        },
        onAccessRevoked: () => live.current.onAccessRevoked?.(),
      }),
    [binding, refreshMarker],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    const flags = () => {
      controller.setOnline(live.current.online && !live.current.changingOrganization);
      controller.setPermissions(canRead);
      controller.setVisible(document.visibilityState === "visible");
    };
    const tick = () => {
      flags();
      setClock(
        document.visibilityState === "visible" && live.current.online && !live.current.changingOrganization
          ? new Date().toISOString()
          : null,
      );
      controller.tick();
    };
    const focus = () => {
      controller.invalidate();
      tick();
      if (document.visibilityState === "visible") void controller.refresh();
    };
    focus();
    const interval = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", focus);
    window.addEventListener("focus", focus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", focus);
      window.removeEventListener("focus", focus);
      controller.detach();
    };
  }, [controller, props.online, props.changingOrganization, props.refreshMarker, canRead]);
  const visible =
    typeof document !== "undefined" && document.visibilityState === "visible" && !props.changingOrganization;
  const current =
    dashboardReportContextBinding(live.current) === binding &&
    live.current.refreshMarker === refreshMarker &&
    props.online &&
    canRead &&
    visible;
  const safeState: DashboardReportState = {
    ...state,
    online: props.online,
    visible,
    canRead: canRead && state.canRead,
    snapshot: current ? state.snapshot : null,
  };
  return (
    <VerifiedMetricsView
      state={safeState}
      userTimezone={props.session.profile.timezone}
      nowInstant={clock ? new Date().toISOString() : null}
      actions={{
        refresh: () => {
          if (
            dashboardReportContextBinding(live.current) === binding &&
            live.current.refreshMarker === refreshMarker &&
            live.current.online &&
            !live.current.changingOrganization &&
            live.current.session.permissions.includes("dashboard.read") &&
            live.current.session.permissions.includes("crm.leads.read") &&
            document.visibilityState === "visible" &&
            controller.getSnapshot().canRead &&
            !controller.getSnapshot().reading
          ) {
            setClock(new Date().toISOString());
            void controller.refresh();
          }
        },
      }}
    />
  );
}
