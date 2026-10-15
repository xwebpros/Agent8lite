"use client";

import { ArrowRight, Bell, Check, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { ApiError, type Schema } from "../lib/api";
import {
  NotificationController,
  notificationContextBinding,
  notificationRequest,
  notificationRowLimit,
  safeNotificationHref,
  type NotificationState,
} from "./notification-controller";
import styles from "./notification-center.module.css";

export type NotificationCenterProps = {
  session: Schema<"Session">;
  memberId: string;
  csrf: string;
  online: boolean;
  accessRevision: number;
  onNavigate(href: string): void;
  onProtectedChange?(value: boolean): void;
  onAccessRevoked?(): void;
};
export type NotificationActions = {
  refresh(): void;
  more(): void;
  markRead(id: string): void;
  reconcile(): void;
  open(href: string): void;
};
function readTime(value: string, timezone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(value));
  } catch {
    return "Read timestamp unavailable";
  }
}

/** Source-testable presentation; private data comes exclusively from the current controller. */
export function NotificationCenterView({
  state,
  actions,
  timezone,
}: {
  state: NotificationState;
  actions: NotificationActions;
  timezone: string;
}) {
  const heading = useId();
  const pending = Boolean(state.pending);
  const canAct = state.online && state.canRead && state.canWrite && !state.reading && !pending;
  const page = state.online && state.canRead ? state.page : null;
  return (
    <section className={styles.center} aria-labelledby={heading}>
      <div className={styles.heading}>
        <div>
          <span className={styles.eyebrow}>YOUR MEMBERSHIP</span>
          <h2 id={heading}>
            <Bell size={22} aria-hidden="true" /> Notifications
          </h2>
          <p>Mark a notice read without changing its linked lead, task or other record.</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={!state.online || !state.canRead || state.reading || state.phase === "sending"}
          onClick={actions.refresh}
        >
          <RefreshCw size={16} aria-hidden="true" />
          {state.reading ? "Refreshing notifications…" : "Refresh notifications"}
        </Button>
      </div>
      {!state.online && (
        <div className={styles.warning} role="status">
          <WifiOff size={18} aria-hidden="true" /> Offline. Private notices are hidden and read commands are
          disabled.
        </div>
      )}
      {!state.canRead && (
        <div className={styles.warning} role="status">
          Notification access is unavailable. Refresh workspace access before reopening this view.
        </div>
      )}
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {pending && (
        <div className={styles.recovery} role="status">
          <strong>{state.phase === "sending" ? "Read command pending" : "Read result unconfirmed"}</strong>
          <p>
            {state.phase === "sending"
              ? "Waiting for a verified receipt."
              : "Reconcile the original command to confirm the result. Its key remains in this tab; another command is blocked."}
          </p>
          <Button
            type="button"
            variant="secondary"
            disabled={
              !state.online || !state.canWrite || !state.canRead || state.reading || state.phase === "sending"
            }
            onClick={actions.reconcile}
          >
            Reconcile read command
          </Button>
        </div>
      )}
      {!pending && state.message && (
        <p className={styles.message} role="status">
          {state.message}
        </p>
      )}
      {state.online && state.canRead && !page && state.reading && (
        <p className={styles.loading} role="status">
          Loading your notifications…
        </p>
      )}
      {page && (
        <>
          <div className={styles.summary}>
            <span>
              {page.items.length} loaded · {page.items.filter((item) => !item.readAt).length} unread in this
              list
            </span>
            {state.pageStale && <Badge tone="warning">Refreshing · previous list</Badge>}
          </div>
          {!page.items.length ? (
            <Empty icon={<Bell size={26} />} title="No notifications">
              Your current membership has no notices. Activity will appear when a supported workflow creates
              it.
            </Empty>
          ) : (
            <ul className={styles.list} aria-label="Member notifications" aria-busy={state.reading}>
              {page.items.map((item) => {
                const href = safeNotificationHref(item.href);
                return (
                  <li key={item.id} className={styles.card}>
                    <div className={styles.cardTitle}>
                      <strong>{item.title}</strong>
                      <Badge tone={item.readAt ? "neutral" : "warning"}>
                        {item.readAt ? "Read" : "Unread"}
                      </Badge>
                    </div>
                    <div className={styles.metadata}>
                      <span>{item.kind}</span>
                      {item.readAt && (
                        <time dateTime={item.readAt}>
                          Read {readTime(item.readAt, timezone)} · {timezone}
                        </time>
                      )}
                    </div>
                    <div className={styles.actions}>
                      {!item.readAt && (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={!canAct}
                          onClick={() => actions.markRead(item.id)}
                          aria-label={"Mark read: " + item.title}
                        >
                          <Check size={16} aria-hidden="true" /> Mark read
                        </Button>
                      )}
                      {href && (
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={!state.online || pending || state.reading}
                          onClick={() => actions.open(href)}
                          aria-label={"Open notice: " + item.title}
                        >
                          Open record <ArrowRight size={16} aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {page.hasMore && page.items.length < notificationRowLimit && (
            <Button
              type="button"
              variant="secondary"
              disabled={!state.online || state.reading || state.phase === "sending"}
              onClick={actions.more}
            >
              Load more notifications
            </Button>
          )}
          {page.hasMore && page.items.length >= notificationRowLimit && (
            <p className={styles.message}>
              Showing the limit of 200 notices. Refresh to reload the current list.
            </p>
          )}
        </>
      )}
      {state.online && state.canRead && !page && !state.reading && !state.error && (
        <p className={styles.message}>Refresh notifications to read the current list.</p>
      )}
      <p className={styles.privacy}>
        <ShieldCheck size={16} aria-hidden="true" /> Notices stay in this tab. Links use the linked record’s
        current permissions; push delivery is not enabled here.
      </p>
    </section>
  );
}

export default function NotificationCenter(props: NotificationCenterProps) {
  const live = useRef(props);
  live.current = props;
  const binding = notificationContextBinding(props);
  const canRead = Boolean(
    props.session.activeOrgId &&
      props.memberId &&
      props.session.permissions.includes("self.notifications.read"),
  );
  const canWrite =
    canRead && Boolean(props.csrf) && props.session.permissions.includes("self.notifications.write");
  const controller = useMemo(() => {
    const current = () => notificationContextBinding(live.current) === binding && live.current.online;
    const base = "/v1/orgs/" + encodeURIComponent(props.session.activeOrgId || "") + "/notifications";
    const ready = () => {
      if (!current()) throw new ApiError(403, "Notification context changed.", "context_changed");
    };
    return new NotificationController({
      binding,
      online: props.online,
      canRead,
      canWrite,
      createKey: () => crypto.randomUUID(),
      isCurrent: current,
      onProtectedChange: (value) => live.current.onProtectedChange?.(value),
      onAccessRevoked: () => live.current.onAccessRevoked?.(),
      client: {
        list: async (cursor) => {
          ready();
          return notificationRequest(
            base + "?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
          );
        },
        markRead: async (command) => {
          ready();
          if (command.binding !== binding)
            throw new ApiError(403, "Notification context changed.", "context_changed");
          return notificationRequest(
            base + "/" + encodeURIComponent(command.notificationId) + "/read",
            {
              method: "POST",
              headers: { "Idempotency-Key": command.idempotencyKey, "X-CSRF-Token": live.current.csrf },
            },
            201,
          );
        },
      },
    });
  }, [binding, canRead, canWrite]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    return () => {
      controller.detach();
      live.current.onProtectedChange?.(false);
    };
  }, [controller]);
  useEffect(() => {
    controller.setOnline(props.online);
    if (props.online) void controller.loadPage();
  }, [controller, props.online]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") {
        controller.invalidate();
        return;
      }
      if (controller.getSnapshot().phase === "sending") return;
      controller.invalidate();
      if (live.current.online) void controller.loadPage();
    };
    const poll = setInterval(() => {
      if (document.visibilityState !== "hidden" && live.current.online && !controller.isProtected())
        void controller.loadPage();
    }, 60000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [controller]);
  return (
    <NotificationCenterView
      state={props.online ? state : { ...state, online: false, page: null }}
      timezone={props.session.profile.timezone || "UTC"}
      actions={{
        refresh: () => void controller.loadPage(),
        more: () => void controller.loadPage(true),
        markRead: (id) => void controller.markRead(id),
        reconcile: () => void controller.reconcile(),
        open: (href) => {
          const safe = safeNotificationHref(href);
          if (safe && live.current.online && !controller.isProtected()) live.current.onNavigate(safe);
        },
      }}
    />
  );
}
