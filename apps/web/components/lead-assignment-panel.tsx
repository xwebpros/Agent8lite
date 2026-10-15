"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Schema } from "../lib/api";
import { ApiError } from "../lib/api";
import { localRecoveryForgottenWarning, localRecoveryForgettingExplanation } from "./contact-edit";
import { leadAssignmentMemberLimit, readLeadAssignmentMembers } from "./lead-assignment-controller";
import type { LeadAssignmentSnapshot } from "./lead-assignment";
import styles from "./lead-assignment-panel.module.css";

export type LeadAssignmentViewProps = {
  snapshot: LeadAssignmentSnapshot;
  currentLead: Schema<"Lead"> | null;
  members: readonly Schema<"Member">[];
  memberId: string;
  targetMemberId: string | null;
  draftChanged: boolean;
  canUnassign: boolean;
  catalogueState: "loading" | "ready" | "unavailable";
  hasMore: boolean;
  online: boolean;
  visible: boolean;
  busy: boolean;
  canAssign: boolean;
  canRetry: boolean;
  onTargetChange(value: string | null): void;
  onSave(): void;
  onReconcile(): void;
  onForget?(): void;
  onRefreshMembers(): void;
  onMoreMembers(): void;
  onReview?(): void;
};

/** Generic recovery and inactive states never render Lead or member data. */
export function LeadAssignmentView(props: LeadAssignmentViewProps) {
  const { phase, command } = props.snapshot;
  if (phase === "forgotten")
    return (
      <div className={styles.panel} role="status">
        {localRecoveryForgottenWarning}
      </div>
    );
  if (phase === "denied" || !props.canAssign)
    return (
      <div className={styles.panel} role="status">
        Assignment access is unavailable. Refresh workspace access before continuing. No interrupted outcome
        is inferred.
      </div>
    );
  const inactive = !props.online || !props.visible;
  if (command)
    return (
      <section className={styles.panel} aria-label="Lead assignment recovery">
        <h3>{phase === "sending" ? "Confirming assignment…" : "Assignment unconfirmed"}</h3>
        <p role="status">
          {inactive
            ? "Lead and member details are hidden while offline or this view is inactive. The original assignment command remains in this tab."
            : "The assignment may have completed. Reconcile only the original input and record version before another command, leaving this view or signing out."}
        </p>
        <button
          type="button"
          className="button button-secondary"
          onClick={props.onReconcile}
          disabled={inactive || props.busy || !props.canRetry || phase !== "unknown"}
        >
          Reconcile assignment
        </button>
        {phase === "unknown" && !props.canRetry && props.onForget && (
          <div>
            <p>{localRecoveryForgettingExplanation}</p>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => props.onForget?.()}
              disabled={props.busy || !props.visible}
            >
              Clear this tab’s recovery data
            </button>
          </div>
        )}
      </section>
    );
  if (inactive)
    return (
      <div className={styles.panel} role="status">
        Assignment details are hidden while offline or this view is inactive. Mutations are unavailable.
      </div>
    );
  if (!props.currentLead)
    return (
      <div className={styles.panel} role="status">
        Current lead assignment is unavailable. Refresh the current record before editing.
        {props.onReview && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => props.onReview?.()}
            disabled={props.busy}
          >
            Read current lead
          </button>
        )}
      </div>
    );
  const active = props.members.filter(
    (member) => member.status === "active" && member.id.toLowerCase() !== props.memberId.toLowerCase(),
  );
  const selectedAvailable =
    props.targetMemberId === null
      ? props.canUnassign
      : props.targetMemberId.toLowerCase() === props.memberId.toLowerCase() ||
        (props.catalogueState === "ready" &&
          active.some((member) => member.id.toLowerCase() === props.targetMemberId?.toLowerCase()));
  return (
    <section className={styles.panel} aria-label="Lead assignment">
      <h3>Assign lead</h3>
      {phase === "acknowledged" && (
        <p role="status">Assignment acknowledged. Current lead details are read separately.</p>
      )}
      {phase === "conflict" && (
        <p role="status">
          The first assignment was rejected because the lead changed. Read its current version before another
          assignment.
        </p>
      )}
      {phase === "rejected" && (
        <p role="status">
          The first assignment was rejected. Review the current lead and member choice before continuing.
        </p>
      )}
      <label>
        Assigned member
        <select
          value={props.targetMemberId ?? ""}
          disabled={props.busy || props.catalogueState === "loading"}
          onChange={(event) => {
            event.stopPropagation();
            props.onTargetChange(event.target.value || null);
          }}
        >
          {!selectedAvailable && (
            <option value={props.targetMemberId ?? ""} disabled>
              Current selection unavailable
            </option>
          )}
          <option value={props.memberId}>Assign to me</option>
          {active.map((member) => (
            <option key={member.id} value={member.id}>
              {member.displayName}
            </option>
          ))}
          {props.canUnassign && <option value="">Unassigned queue</option>}
        </select>
      </label>
      <p className={styles.muted}>
        The server checks current assignment access when you save.{" "}
        {props.canUnassign
          ? "You can choose the unassigned queue."
          : "Unassignment is unavailable because organization-wide assignment scope has not been verified."}
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className="button button-secondary"
          onClick={props.onSave}
          disabled={
            props.busy || !props.draftChanged || !selectedAvailable || props.catalogueState === "loading"
          }
        >
          Save assignment
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={props.onRefreshMembers}
          disabled={props.busy || props.catalogueState === "loading"}
        >
          Refresh member choices
        </button>
        {props.hasMore && (
          <button
            type="button"
            className="button button-secondary"
            onClick={props.onMoreMembers}
            disabled={props.busy || props.catalogueState !== "ready"}
          >
            Load more members
          </button>
        )}
      </div>
      <p className={styles.muted} role="status">
        {props.catalogueState === "loading"
          ? "Loading current member choices…"
          : props.catalogueState === "unavailable"
            ? "Additional member choices are unavailable. Assign to me remains available when current lead access permits it."
            : `Loaded ${active.length} other active member choices${props.hasMore ? "; more are available" : ""}.`}
      </p>
      {props.members.length >= leadAssignmentMemberLimit && (
        <p className={styles.muted}>
          This tab displays at most 200 loaded member records. Refresh to reload current choices.
        </p>
      )}
    </section>
  );
}

type PanelProps = Omit<
  LeadAssignmentViewProps,
  "members" | "catalogueState" | "hasMore" | "onRefreshMembers" | "onMoreMembers"
> & {
  session: Schema<"Session">;
  binding: string | null;
  onIdentityLost(): void;
};

export default function LeadAssignmentPanel(props: PanelProps) {
  const live = useRef(props);
  live.current = props;
  const lifetime = useRef(false),
    epoch = useRef(0),
    abort = useRef<AbortController | null>(null);
  const [catalogue, setCatalogue] = useState<{
    binding: string | null;
    members: readonly Schema<"Member">[];
    state: "loading" | "ready" | "unavailable";
    hasMore: boolean;
    pages: number;
    measuredAt: number;
  }>({ binding: null, members: [], state: "unavailable", hasMore: false, pages: 0, measuredAt: 0 });
  const catalogueRef = useRef(catalogue);
  catalogueRef.current = catalogue;
  const clear = useCallback(() => {
    ++epoch.current;
    abort.current?.abort();
    abort.current = null;
    setCatalogue({
      binding: null,
      members: [],
      state: "unavailable",
      hasMore: false,
      pages: 0,
      measuredAt: 0,
    });
  }, []);
  const eligible = (binding: string | null) =>
    lifetime.current &&
    binding !== null &&
    live.current.binding === binding &&
    live.current.canAssign &&
    live.current.online &&
    live.current.visible &&
    !live.current.snapshot.command &&
    !["forgotten", "denied"].includes(live.current.snapshot.phase) &&
    !live.current.busy &&
    document.visibilityState === "visible" &&
    live.current.session.permissions.includes("members.read");
  const load = useCallback(
    async (more = false) => {
      const p = live.current,
        binding = p.binding,
        previous = catalogueRef.current;
      if (!eligible(binding)) return;
      if (
        more &&
        (!previous.hasMore ||
          previous.binding !== binding ||
          previous.members.length >= leadAssignmentMemberLimit)
      )
        return;
      const pages = more ? Math.min(previous.pages + 1, 8) : 1,
        generation = ++epoch.current;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setCatalogue({ binding, members: [], state: "loading", hasMore: false, pages: 0, measuredAt: 0 });
      try {
        const members: Schema<"Member">[] = [],
          ids = new Set<string>(),
          cursors = new Set<string>();
        let cursor: string | null = null,
          hasMore = false,
          loadedPages = 0;
        for (let page = 0; page < pages; page++) {
          const response = await readLeadAssignmentMembers(p.session.activeOrgId!, cursor, controller.signal);
          if (generation !== epoch.current || !eligible(binding)) return;
          for (const member of response.items) {
            if (ids.has(member.id.toLowerCase())) throw new Error();
            ids.add(member.id.toLowerCase());
            members.push(member);
          }
          loadedPages++;
          hasMore = response.hasMore;
          cursor = response.nextCursor;
          if (!hasMore) break;
          if (!cursor || cursors.has(cursor)) throw new Error();
          cursors.add(cursor);
        }
        if (generation !== epoch.current || !eligible(binding)) return;
        setCatalogue({
          binding,
          members,
          state: "ready",
          hasMore: hasMore && members.length < leadAssignmentMemberLimit,
          pages: loadedPages,
          measuredAt: Date.now(),
        });
      } catch (error) {
        if (!lifetime.current || generation !== epoch.current || live.current.binding !== binding) return;
        clear();
        if (error instanceof ApiError && error.status === 401) live.current.onIdentityLost();
      } finally {
        if (abort.current === controller) abort.current = null;
      }
    },
    [clear],
  );
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
      ++epoch.current;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    clear();
    if (eligible(props.binding)) void load();
  }, [
    props.binding,
    props.online,
    props.visible,
    props.canAssign,
    props.busy,
    Boolean(props.snapshot.command),
    clear,
    load,
  ]);
  useEffect(() => {
    const focus = () => {
      clear();
      if (eligible(live.current.binding)) void load();
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") clear();
      else focus();
    };
    const timer = setInterval(() => {
      const current = catalogueRef.current;
      if (
        current.state === "ready" &&
        (Date.now() < current.measuredAt || Date.now() - current.measuredAt >= 5 * 60 * 1000)
      )
        clear();
    }, 30000);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [clear, load]);
  const current =
    props.binding !== null &&
    catalogue.binding === props.binding &&
    props.online &&
    props.visible &&
    !props.snapshot.command &&
    props.canAssign &&
    (catalogue.state === "loading" ||
      (Date.now() >= catalogue.measuredAt && Date.now() - catalogue.measuredAt < 5 * 60 * 1000));
  return (
    <LeadAssignmentView
      {...props}
      members={current ? catalogue.members : []}
      catalogueState={current ? catalogue.state : "unavailable"}
      hasMore={current && catalogue.hasMore}
      onTargetChange={(value) => {
        const p = live.current,
          data = catalogueRef.current;
        if (
          !lifetime.current ||
          !p.canAssign ||
          !p.online ||
          !p.visible ||
          p.busy ||
          p.snapshot.command ||
          document.visibilityState !== "visible"
        )
          return;
        if (
          value === null
            ? !p.canUnassign
            : value.toLowerCase() !== p.memberId.toLowerCase() &&
              !(
                data.binding === p.binding &&
                data.state === "ready" &&
                Date.now() >= data.measuredAt &&
                Date.now() - data.measuredAt < 300000 &&
                data.members.some(
                  (member) => member.status === "active" && member.id.toLowerCase() === value.toLowerCase(),
                )
              )
        )
          return;
        p.onTargetChange(value);
      }}
      onSave={() => {
        const p = live.current,
          data = catalogueRef.current,
          value = p.targetMemberId;
        if (
          !lifetime.current ||
          !p.canAssign ||
          !p.online ||
          !p.visible ||
          p.busy ||
          p.snapshot.command ||
          document.visibilityState !== "visible"
        )
          return;
        if (
          value === null
            ? !p.canUnassign
            : value.toLowerCase() !== p.memberId.toLowerCase() &&
              !(
                data.binding === p.binding &&
                data.state === "ready" &&
                Date.now() >= data.measuredAt &&
                Date.now() - data.measuredAt < 300000 &&
                data.members.some(
                  (member) => member.status === "active" && member.id.toLowerCase() === value.toLowerCase(),
                )
              )
        )
          return;
        p.onSave();
      }}
      onRefreshMembers={() => void load()}
      onMoreMembers={() => void load(true)}
    />
  );
}
