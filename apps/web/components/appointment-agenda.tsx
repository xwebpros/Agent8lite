"use client";

import { ArrowRight, CalendarDays, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { ApiError, type Schema } from "../lib/api";
import {
  AppointmentController,
  appointmentContextBinding,
  appointmentRequest,
  appointmentRowLimit,
  formatAppointmentInstant,
  validAppointmentTimezone,
  type AppointmentState,
} from "./appointment-controller";
import styles from "./appointment-agenda.module.css";

export type AppointmentAgendaProps = {
  session: Schema<"Session">;
  memberId: string;
  online: boolean;
  accessRevision: number;
  onOpenLead(id: string): void;
  onAccessRevoked?(): void;
};
export type AppointmentActions = { refresh(): void; more(): void; openLead(id: string): void };

function TimeRange({ appointment, timezone }: { appointment: Schema<"Appointment">; timezone: string }) {
  return (
    <span className={styles.range}>
      <time dateTime={appointment.startsAt}>{formatAppointmentInstant(appointment.startsAt, timezone)}</time>
      <span aria-hidden="true"> → </span>
      <span className={styles.screenReader}> until </span>
      <time dateTime={appointment.endsAt}>{formatAppointmentInstant(appointment.endsAt, timezone)}</time>
    </span>
  );
}
function ZoneRow({
  label,
  timezone,
  appointment,
}: {
  label: string;
  timezone: unknown;
  appointment: Schema<"Appointment">;
}) {
  return (
    <div className={styles.zone}>
      <dt>
        {label}
        {validAppointmentTimezone(timezone) ? " · " + timezone : " · timezone unavailable"}
      </dt>
      <dd>
        {validAppointmentTimezone(timezone) ? (
          <TimeRange appointment={appointment} timezone={timezone} />
        ) : (
          "Use the explicitly labeled UTC reference below."
        )}
      </dd>
    </div>
  );
}

/** A stored read-only list, never a complete day, provider sync or booking confirmation. */
export function AppointmentAgendaView({
  state,
  userTimezone,
  organizationTimezone,
  actions,
}: {
  state: AppointmentState;
  userTimezone: unknown;
  organizationTimezone: unknown;
  actions: AppointmentActions;
}) {
  const heading = useId();
  const readable = state.online && state.visible && state.canRead;
  const page = readable ? state.page : null;
  const showOrganizationTimezone =
    organizationTimezone !== userTimezone || !validAppointmentTimezone(organizationTimezone);
  const ordered = page
    ? [...page.items].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id))
    : [];
  return (
    <section className={styles.agenda} aria-labelledby={heading}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>YOUR STORED RECORDS</span>
          <h2 id={heading}>
            <CalendarDays size={22} aria-hidden="true" /> Stored appointments
          </h2>
          <p>Appointments linked to leads assigned to you. Calendar synchronization is not configured.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!readable || state.reading}
          onClick={actions.refresh}
        >
          <RefreshCw size={16} aria-hidden="true" />{" "}
          {state.reading ? "Refreshing appointments…" : "Refresh appointments"}
        </Button>
      </div>
      <div className={styles.scope}>
        <span>Current member only · Changing the workspace scope does not widen this list.</span>
        <span>
          {validAppointmentTimezone(userTimezone)
            ? "Your timezone: " + userTimezone
            : "Your timezone is unavailable; UTC references are provided."}
        </span>
        {showOrganizationTimezone && (
          <span>
            {validAppointmentTimezone(organizationTimezone)
              ? "Organization timezone: " + organizationTimezone
              : "Organization timezone is unavailable; UTC references are provided."}
          </span>
        )}
      </div>
      {!state.online && (
        <p className={styles.warning} role="status">
          <WifiOff size={18} aria-hidden="true" />
          Offline. Private appointments are hidden; reconnect to read the current stored list.
        </p>
      )}
      {state.online && !state.visible && (
        <p className={styles.warning} role="status">
          Private appointments are hidden while this view is inactive.
        </p>
      )}
      {!state.canRead && (
        <p className={styles.warning} role="status">
          Stored appointment access is unavailable. Current appointment and lead read access is required.
        </p>
      )}
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {readable && !page && state.reading && (
        <p className={styles.message} role="status">
          Loading your stored appointments…
        </p>
      )}
      {readable && !page && !state.reading && !state.error && (
        <p className={styles.message}>Refresh appointments to read the current stored list.</p>
      )}
      {page && (
        <>
          <div className={styles.summary}>
            <span>{page.items.length} loaded · Ordered by start time within these loaded records</span>
            {state.pageStale && <Badge tone="warning">Refreshing · previous list</Badge>}
          </div>
          {!ordered.length ? (
            <Empty icon={<CalendarDays size={26} />} title="No stored appointments">
              No appointment records were returned for your current member scope. This does not confirm
              calendar synchronization or booking availability.
            </Empty>
          ) : (
            <ul className={styles.list} aria-label="Loaded appointments" aria-busy={state.reading}>
              {ordered.map((appointment, index) => (
                <li key={appointment.id} className={styles.card}>
                  <div className={styles.cardHeading}>
                    <strong>Stored appointment {index + 1}</strong>
                    <Badge
                      tone={
                        appointment.state === "completed"
                          ? "positive"
                          : appointment.state === "cancelled"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {appointment.state === "scheduled"
                        ? "Scheduled"
                        : appointment.state === "cancelled"
                          ? "Cancelled"
                          : "Completed"}
                    </Badge>
                  </div>
                  <dl className={styles.times}>
                    <ZoneRow label="Your time" timezone={userTimezone} appointment={appointment} />
                    {showOrganizationTimezone && (
                      <ZoneRow
                        label="Organization time"
                        timezone={organizationTimezone}
                        appointment={appointment}
                      />
                    )}
                    {appointment.timezone !== userTimezone &&
                      appointment.timezone !== organizationTimezone && (
                        <ZoneRow
                          label="Stored source time"
                          timezone={appointment.timezone}
                          appointment={appointment}
                        />
                      )}
                    <div className={styles.zone}>
                      <dt>UTC reference</dt>
                      <dd className={styles.utc}>
                        <time dateTime={appointment.startsAt}>{appointment.startsAt}</time>
                        <span aria-hidden="true"> → </span>
                        <span className={styles.screenReader}> until </span>
                        <time dateTime={appointment.endsAt}>{appointment.endsAt}</time>
                      </dd>
                    </div>
                  </dl>
                  <div className={styles.actions}>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={!readable || state.reading}
                      aria-label={"Open lead for stored appointment " + (index + 1)}
                      onClick={() => actions.openLead(appointment.leadId)}
                    >
                      Open lead <ArrowRight size={16} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {page.hasMore && page.items.length < appointmentRowLimit && (
            <Button
              type="button"
              variant="secondary"
              disabled={!readable || state.reading}
              onClick={actions.more}
            >
              Load more appointments
            </Button>
          )}
          {page.hasMore && page.items.length >= appointmentRowLimit && (
            <p className={styles.message}>
              Showing the limit of 200 loaded appointments. Refresh to reload the current list.
            </p>
          )}
          <p className={styles.message}>
            {page.hasMore ? "More stored records exist. " : ""}
            Loaded pages are not a snapshot or a complete daily agenda.
          </p>
          {state.refreshedAt && (
            <p className={styles.freshness}>
              Source: stored appointment API · Read at{" "}
              <time dateTime={state.refreshedAt}>{state.refreshedAt}</time> · UTC
            </p>
          )}
        </>
      )}
      <p className={styles.privacy}>
        <ShieldCheck size={16} aria-hidden="true" /> Read-only records stay in this tab. Lead details require
        current access. Booking and cancellation actions are not available.
      </p>
    </section>
  );
}

export default function AppointmentAgenda(props: AppointmentAgendaProps) {
  const live = useRef(props);
  live.current = props;
  const binding = appointmentContextBinding(props);
  const canRead = Boolean(
    props.session.activeOrgId &&
      props.memberId &&
      ["appointments.read", "crm.leads.read"].every((code) => props.session.permissions.includes(code)),
  );
  const controller = useMemo(() => {
    const current = () =>
      appointmentContextBinding(live.current) === binding &&
      live.current.online &&
      (typeof document === "undefined" || document.visibilityState !== "hidden");
    return new AppointmentController({
      binding,
      online: props.online,
      canRead,
      isCurrent: current,
      onAccessRevoked: () => live.current.onAccessRevoked?.(),
      client: {
        list: async (cursor, signal) => {
          if (!current()) throw new ApiError(403, "Stored appointment context changed.", "context_changed");
          return appointmentRequest(live.current.session.activeOrgId || "", cursor, signal);
        },
      },
    });
  }, [binding, canRead]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    controller.setVisible(document.visibilityState !== "hidden");
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    controller.setOnline(props.online);
    if (props.online) void controller.loadPage();
  }, [controller, props.online]);
  useEffect(() => {
    const refresh = () => {
      const visible = document.visibilityState !== "hidden";
      controller.setVisible(visible);
      controller.invalidate();
      if (visible && live.current.online) void controller.loadPage();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [controller]);
  const organization = props.session.organizations.find((item) => item.id === props.session.activeOrgId);
  return (
    <AppointmentAgendaView
      state={props.online ? state : { ...state, online: false, page: null }}
      userTimezone={props.session.profile.timezone}
      organizationTimezone={organization?.timezone}
      actions={{
        refresh: () => void controller.loadPage(),
        more: () => void controller.loadPage(true),
        openLead: (id) => {
          const current = controller.getSnapshot();
          if (
            appointmentContextBinding(live.current) === binding &&
            live.current.online &&
            (typeof document === "undefined" || document.visibilityState !== "hidden") &&
            current.visible &&
            current.canRead &&
            !current.reading &&
            current.page?.items.some((item) => item.leadId === id)
          )
            live.current.onOpenLead(id);
        },
      }}
    />
  );
}
