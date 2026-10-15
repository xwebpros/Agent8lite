"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ListTodo, Plus } from "lucide-react";
import type { Schema } from "../lib/api";
import {
  formatTaskAgendaInstant,
  partitionLoadedTasks,
  taskAgendaVisibleLimit,
  validTaskAgendaTimezone,
} from "./task-agenda-time";
import styles from "./task-agenda.module.css";

type Task = Schema<"Task">;
export type TaskAgendaViewProps = {
  tasks: readonly Task[];
  nowInstant: unknown;
  userTimezone: unknown;
  organizationTimezone: unknown;
  scope: "own" | "authorized";
  refreshedAt: string | null;
  hasMore: boolean;
  loading: boolean;
  online: boolean;
  visible: boolean;
  canRead: boolean;
  canComplete: boolean;
  canAddTask?: boolean;
  blocked: boolean;
  completionPending?: boolean;
  onReconcile?(): void;
  actions: {
    openTask(id: string): void;
    completeTask(task: Task): void;
    viewTasks(): void;
    addTask(): void;
  };
};

/** A presentation-only view of the current loaded source, never a complete daily count. */
export function TaskAgendaView(props: TaskAgendaViewProps) {
  const accessible = props.online && props.visible && props.canRead;
  const partition =
    accessible && props.refreshedAt
      ? partitionLoadedTasks(props.tasks, props.nowInstant, props.userTimezone)
      : null;
  const metadataValid = validTaskAgendaTimezone(props.organizationTimezone) && partition?.state === "ready";
  const ready = accessible && Boolean(props.refreshedAt) && metadataValid;
  const canAct = ready && !props.loading && !props.blocked && !props.completionPending;
  const currentUtc = formatTaskAgendaInstant(props.nowInstant, "UTC");
  const message = !props.online
    ? "You’re offline. Loaded task details are hidden until you reconnect."
    : !props.visible
      ? "Loaded task details are hidden while this workspace is inactive."
      : !props.canRead
        ? "Task access is unavailable in the current workspace."
        : props.loading && !props.refreshedAt
          ? "Loading task records…"
          : !props.refreshedAt
            ? "Task records are unavailable. Refresh the workspace to load them."
            : !metadataValid
              ? "Task timing metadata is unavailable. Current user, organization and stored task timezones must be verified before actions are available."
              : null;
  const total =
    partition?.state === "ready"
      ? Object.values(partition.groups).reduce((sum, group) => sum + group.length, 0)
      : 0;
  const groups = [
    { key: "overdue" as const, label: "Loaded overdue tasks" },
    { key: "today" as const, label: "Loaded tasks due today" },
    { key: "upcoming" as const, label: "Loaded upcoming tasks" },
  ];
  return (
    <section className={styles.panel} aria-label="Loaded task agenda">
      <header className={styles.header}>
        <div className={styles.title}>
          <ListTodo size={20} aria-hidden="true" />
          <h2>Loaded task agenda</h2>
        </div>
        <button type="button" disabled={!canAct} onClick={() => props.actions.viewTasks()}>
          View tasks
        </button>
      </header>
      <p className={styles.caption}>
        Source: loaded CRM tasks · {props.scope === "own" ? "My tasks" : "Authorized task scope"}. Calendar
        synchronization is not implied.
      </p>
      {props.completionPending && (
        <div className={styles.recovery} role="status">
          <p>
            A task completion is unconfirmed. Reconcile its original command before navigating or changing
            tasks.
          </p>
          <button
            type="button"
            onClick={props.onReconcile}
            disabled={
              !props.online || !props.visible || !props.canComplete || props.blocked || !props.onReconcile
            }
          >
            Reconcile task completion
          </button>
        </div>
      )}
      {message ? (
        <p className={styles.status} role="status">
          {message}
        </p>
      ) : ready && partition?.state === "ready" ? (
        <>
          {props.loading && (
            <p className={styles.status} role="status">
              Refreshing tasks. These loaded rows belong to the current workspace; actions are paused.
            </p>
          )}
          <p className={styles.caption}>
            User timezone: {partition.userTimezone} · Gregorian day {partition.userDay}. Organization
            timezone: {props.organizationTimezone as string}.
          </p>
          <p className={styles.caption}>
            Classification captured at <time dateTime={partition.capturedAt}>{partition.capturedAt}</time>{" "}
            (UTC). Source refreshed at{" "}
            <time dateTime={props.refreshedAt || undefined}>{props.refreshedAt}</time> (UTC).
          </p>
          <p className={styles.caption}>
            {props.hasMore
              ? "Additional task pages are available. This loaded agenda is partial."
              : "This agenda covers loaded records only."}{" "}
            Completed and cancelled tasks are excluded.
          </p>
          {total === 0 && (
            <p className={styles.status} role="status">
              No open tasks in the loaded records.
            </p>
          )}
          <div className={styles.groups}>
            {groups.map(({ key, label }) => {
              const tasks = partition.groups[key];
              return (
                <section key={key} aria-label={label} className={styles.group}>
                  <h3>
                    {label} <span>{tasks.length} loaded</span>
                  </h3>
                  <p className={styles.caption}>
                    {Math.min(tasks.length, taskAgendaVisibleLimit)} shown of {tasks.length} loaded · Up to{" "}
                    {taskAgendaVisibleLimit} visible per group.
                  </p>
                  {tasks.length === 0 ? (
                    <p className={styles.empty}>No loaded tasks in this group.</p>
                  ) : (
                    <ul className={styles.list}>
                      {tasks.slice(0, taskAgendaVisibleLimit).map((task) => (
                        <li key={task.id} className={styles.task}>
                          <div className={styles.row}>
                            <button
                              type="button"
                              className={styles.taskTitle}
                              disabled={!canAct}
                              onClick={() => props.actions.openTask(task.id)}
                            >
                              {task.title}
                            </button>
                            <button
                              type="button"
                              className={styles.complete}
                              aria-label={`Complete task: ${task.title}`}
                              disabled={!canAct || !props.canComplete}
                              onClick={() => props.actions.completeTask(task)}
                            >
                              <Check size={17} aria-hidden="true" />
                            </button>
                          </div>
                          <p className={styles.timing}>
                            User time ({partition.userTimezone}):{" "}
                            {formatTaskAgendaInstant(task.dueAt, partition.userTimezone)}
                          </p>
                          {props.organizationTimezone !== partition.userTimezone && (
                            <p className={styles.timing}>
                              Organization time ({props.organizationTimezone as string}):{" "}
                              {formatTaskAgendaInstant(task.dueAt, props.organizationTimezone)}
                            </p>
                          )}
                          {task.timezone !== partition.userTimezone &&
                            task.timezone !== props.organizationTimezone && (
                              <p className={styles.timing}>
                                Stored source time ({task.timezone}):{" "}
                                {formatTaskAgendaInstant(task.dueAt, task.timezone)}
                              </p>
                            )}
                          {task.timezone === partition.userTimezone ||
                          task.timezone === props.organizationTimezone ? (
                            <p className={styles.caption}>Stored source timezone: {task.timezone}</p>
                          ) : null}
                          <p className={styles.caption}>
                            UTC reference:{" "}
                            <time dateTime={new Date(task.dueAt).toISOString()}>
                              {new Date(task.dueAt).toISOString()}
                            </time>{" "}
                            · {task.priority} priority
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      ) : null}
      {message && accessible && currentUtc && (
        <p className={styles.caption}>
          Current UTC reference: {currentUtc}.{" "}
          {validTaskAgendaTimezone(props.userTimezone)
            ? `User timezone: ${props.userTimezone}.`
            : "User timezone unavailable."}{" "}
          {validTaskAgendaTimezone(props.organizationTimezone)
            ? `Organization timezone: ${props.organizationTimezone}.`
            : "Organization timezone unavailable."}
        </p>
      )}
      <footer className={styles.footer}>
        <button
          type="button"
          disabled={!canAct || !(props.canAddTask ?? props.canComplete)}
          onClick={() => props.actions.addTask()}
        >
          <Plus size={16} aria-hidden="true" />
          Add a follow-up
        </button>
      </footer>
    </section>
  );
}

export type TaskAgendaProps = Omit<TaskAgendaViewProps, "nowInstant" | "visible" | "actions"> & {
  contextKey: string;
  onOpenTask(id: string): void;
  onCompleteTask(task: Task): void;
  onViewTasks(): void;
  onAddTask(): void;
};

/** The clock runs only in a visible, current context. Source data remains shell-owned. */
export default function TaskAgenda(props: TaskAgendaProps) {
  const live = useRef(props);
  live.current = props;
  const [clock, setClock] = useState<{ context: string; instant: string } | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let attached = true;
    const tick = () => {
      const current =
        attached &&
        document.visibilityState === "visible" &&
        live.current.online &&
        live.current.canRead &&
        live.current.contextKey === props.contextKey;
      setVisible(current);
      setClock(current ? { context: props.contextKey, instant: new Date().toISOString() } : null);
    };
    tick();
    const interval = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      attached = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [props.contextKey, props.online, props.canRead]);
  const current = clock?.context === props.contextKey;
  const allowed = () => {
    const value = live.current;
    return (
      value.contextKey === props.contextKey &&
      value.online &&
      value.canRead &&
      !value.loading &&
      !value.blocked &&
      !value.completionPending &&
      document.visibilityState === "visible" &&
      Boolean(value.refreshedAt) &&
      validTaskAgendaTimezone(value.organizationTimezone) &&
      partitionLoadedTasks(value.tasks, new Date().toISOString(), value.userTimezone).state === "ready"
    );
  };
  return (
    <TaskAgendaView
      {...props}
      nowInstant={current ? clock.instant : null}
      visible={visible && current && props.online}
      onReconcile={() => {
        const value = live.current;
        if (
          value.contextKey === props.contextKey &&
          value.online &&
          value.canComplete &&
          !value.blocked &&
          document.visibilityState === "visible"
        )
          value.onReconcile?.();
      }}
      actions={{
        openTask: (id) => {
          if (allowed() && live.current.tasks.some((task) => task.id === id && task.state === "open"))
            live.current.onOpenTask(id);
        },
        completeTask: (task) => {
          if (
            allowed() &&
            live.current.canComplete &&
            live.current.tasks.some(
              (row) => row.id === task.id && row.version === task.version && row.state === "open",
            )
          )
            live.current.onCompleteTask(task);
        },
        viewTasks: () => {
          if (allowed()) live.current.onViewTasks();
        },
        addTask: () => {
          if (allowed() && (live.current.canAddTask ?? live.current.canComplete)) live.current.onAddTask();
        },
      }}
    />
  );
}
