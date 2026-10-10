"use client";

import { FilePenLine, FlaskConical, FolderOpen, Megaphone, RefreshCw, WifiOff } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  CampaignDraftController,
  campaignWriteJson,
  readCampaignJsonResponse,
  type CampaignDraftClient,
  type CampaignDraftState,
} from "./campaign-draft-protocol";
import styles from "./campaign-workspace.module.css";

export type CampaignWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  onDirty(value: boolean): void;
  onAccessRevoked?(): void;
};
type CampaignWorkspaceViewProps = {
  state: CampaignDraftState;
  active: boolean;
  online: boolean;
  onCreate(): boolean;
  onRefresh(): void;
  onNext(cursor: string): void;
  onSelect(id: string): void;
  onEdit(field: "name" | "category", value: string): void;
  onSave(): void;
  onDiscard(): void;
  onEditRejected(): void;
  onReadConflict(): void;
  onResolveConflict(keep: boolean): void;
};

/** Pure presentation is exported for source/static checks; it never serializes private command keys. */
export function CampaignWorkspaceView({
  state,
  active,
  online,
  onCreate,
  onRefresh,
  onNext,
  onSelect,
  onEdit,
  onSave,
  onDiscard,
  onEditRejected,
  onReadConflict,
  onResolveConflict,
}: CampaignWorkspaceViewProps) {
  const nameId = useId();
  const categoryId = useId();
  const errorId = useId();
  const nameHintId = useId();
  const categoryHintId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const protectedDraft = state.dirty || Boolean(state.pending) || state.phase === "sending";
  const reading = Boolean(state.reading);
  const locked = !online || reading || Boolean(state.pending) || !state.canWrite;
  useEffect(() => {
    if (state.mode === "edit" && state.selected) nameInput.current?.focus();
  }, [state.mode, state.selected]);
  if (!active)
    return (
      <Empty icon={<Megaphone size={30} />} title="Synthetic campaign drafts unavailable">
        Choose an organization in an explicitly enabled synthetic session.
      </Empty>
    );
  if (!state.canRead)
    return (
      <Empty icon={<Megaphone size={30} />} title="Campaign read access unavailable">
        This workspace requires current campaign read access. Server checks also require organization scope
        and marketing capability.
      </Empty>
    );
  if (state.phase === "unavailable")
    return (
      <Empty
        icon={<Megaphone size={30} />}
        title="Campaign capability or resource unavailable"
        action={
          <Button variant="secondary" disabled={!online || reading} onClick={onRefresh}>
            <RefreshCw size={16} aria-hidden="true" /> Verify current campaign access
          </Button>
        }
      >
        {state.message} Earlier commands may have committed; read current drafts after access is restored
        before starting another request.
      </Empty>
    );
  if (state.phase === "denied")
    return (
      <Empty icon={<Megaphone size={30} />} title="Campaign access changed">
        {state.message} Return to the workspace to verify current authorization.
      </Empty>
    );
  return (
    <section className={styles.workspace} aria-label="Synthetic campaign draft metadata">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Campaign library</p>
          <h2>Campaign drafts</h2>
          <p>Create and revise the name and category of a private draft.</p>
        </div>
        <Badge tone="warning">Synthetic · draft metadata</Badge>
      </header>
      <div className={styles.notice}>
        <FlaskConical size={22} aria-hidden="true" />
        <p>
          This workspace saves draft metadata only. Workflow editing, publication, enrollment, schedules and
          delivery are unavailable.
        </p>
      </div>
      {!online && (
        <div className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" />
          <p>
            Offline. Private index and acknowledgment displays are cleared. Unsaved fields and original
            uncertain commands remain only in this tab; mutations are disabled.
          </p>
        </div>
      )}
      <div className={styles.layout}>
        <section className={styles.card} aria-label="Authorized campaign draft index">
          <div className={styles.heading}>
            <h3>
              <FolderOpen size={19} aria-hidden="true" /> Draft index
            </h3>
            <Button variant="secondary" disabled={!online || reading || protectedDraft} onClick={onRefresh}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh index
            </Button>
          </div>
          <p className={styles.help}>
            The draft list changes as records change. Select a draft to read its current version.
          </p>
          {reading && (
            <p role="status">
              {state.reading === "list"
                ? "Reading authorized campaign draft metadata…"
                : "Reading the explicitly selected current revision…"}
            </p>
          )}
          {online && state.listError && (
            <p role="alert" className={styles.error}>
              {state.listError}
            </p>
          )}
          {online && state.pageStale && (
            <p role="status" className={styles.warning}>
              This previously read page may be stale. Refresh the index before relying on its metadata.
            </p>
          )}
          {online && !state.page && !reading && (
            <p role="status">The draft index has not been read successfully.</p>
          )}
          {online && state.page && (
            <>
              <p className={styles.help}>{state.page.items.length} drafts in this page read.</p>
              {state.page.items.length === 0 ? (
                <p>No draft metadata is present in this authorized page read.</p>
              ) : (
                <ul className={styles.records}>
                  {state.page.items.map((item) => (
                    <li key={item.id}>
                      <Button
                        variant="quiet"
                        disabled={reading || protectedDraft}
                        onClick={() => onSelect(item.id)}
                        className={`button button-quiet ${styles.record}`}
                      >
                        <span className={styles.recordText}>
                          <strong>{item.name}</strong>
                          <span>{item.category}</span>
                          <span>Read version {item.version}</span>
                        </span>
                        <Badge>Draft</Badge>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {state.page.hasMore && state.page.nextCursor && (
                <Button
                  variant="secondary"
                  disabled={reading || protectedDraft}
                  onClick={() => onNext(state.page!.nextCursor!)}
                >
                  Read next draft page
                </Button>
              )}
            </>
          )}
          {state.canWrite && (
            <Button
              disabled={!online || reading || protectedDraft}
              onClick={() => {
                if (onCreate()) requestAnimationFrame(() => nameInput.current?.focus());
              }}
            >
              <FilePenLine size={17} aria-hidden="true" /> New draft metadata
            </Button>
          )}
        </section>
        <section className={styles.card} aria-label="Campaign metadata editor">
          <div className={styles.heading}>
            <h3>
              <FilePenLine size={19} aria-hidden="true" />{" "}
              {state.mode === "create" ? "New campaign draft" : "Draft metadata"}
            </h3>
            {state.selected && <Badge>Version {state.selected.data.version}</Badge>}
          </div>
          <p role="status" aria-live="polite" className={styles.help}>
            {state.message}
          </p>
          {state.error && (
            <p id={errorId} role="alert" className={styles.error}>
              {state.error}
            </p>
          )}
          {state.input ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (online) onSave();
              }}
            >
              {!state.canWrite && (
                <p>You have read access. Current campaign write permission is required to change metadata.</p>
              )}
              <fieldset disabled={locked}>
                <legend className={styles.srOnly}>Private campaign draft fields</legend>
                <label htmlFor={nameId}>Campaign name</label>
                <input
                  ref={nameInput}
                  id={nameId}
                  value={state.input.name}
                  required
                  maxLength={240}
                  autoComplete="off"
                  aria-describedby={`${nameHintId}${state.error ? ` ${errorId}` : ""}`}
                  aria-invalid={
                    (state.phase === "editing" && Boolean(state.error) && !state.input.name.trim()) ||
                    undefined
                  }
                  onChange={(event) => onEdit("name", event.target.value)}
                />
                <p id={nameHintId} className={styles.caption}>
                  Up to 120 characters · {Array.from(state.input.name).length} entered
                </p>
                <label htmlFor={categoryId}>Campaign category</label>
                <input
                  id={categoryId}
                  value={state.input.category}
                  required
                  maxLength={160}
                  autoComplete="off"
                  aria-describedby={`${categoryHintId}${state.error ? ` ${errorId}` : ""}`}
                  aria-invalid={
                    (state.phase === "editing" && Boolean(state.error) && !state.input.category.trim()) ||
                    undefined
                  }
                  onChange={(event) => onEdit("category", event.target.value)}
                />
                <p id={categoryHintId} className={styles.caption}>
                  Up to 80 characters · {Array.from(state.input.category).length} entered
                </p>
              </fieldset>
              {state.canWrite && (
                <div className={styles.actions}>
                  <Button
                    type="submit"
                    disabled={
                      !online ||
                      reading ||
                      state.phase === "sending" ||
                      state.phase === "conflict" ||
                      (!state.dirty && !state.pending)
                    }
                  >
                    {state.phase === "sending"
                      ? "Saving metadata…"
                      : state.pending
                        ? "Retry original metadata command"
                        : state.mode === "create"
                          ? "Create campaign draft"
                          : "Save draft metadata"}
                  </Button>
                  {state.phase === "rejected" && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!online || reading}
                      onClick={onEditRejected}
                    >
                      Edit rejected metadata
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={Boolean(state.pending) || state.phase === "sending" || reading}
                    onClick={onDiscard}
                  >
                    Discard unsaved metadata
                  </Button>
                </div>
              )}
            </form>
          ) : (
            <div className={styles.empty}>
              <FilePenLine size={28} aria-hidden="true" />
              <p>
                Select a draft to read its current version, or start new metadata. The draft list changes as
                records change.
              </p>
            </div>
          )}
          {state.phase === "uncertain" && (
            <p className={styles.warning}>
              The original request is protected. Its exact fields, command key and original revision cannot be
              replaced or discarded while the result is unknown.
            </p>
          )}
          {state.phase === "conflict" && (
            <section className={styles.conflict} aria-label="Explicit campaign revision conflict review">
              <h4>Review the current revision</h4>
              <Button variant="secondary" disabled={!online || reading} onClick={onReadConflict}>
                Read current conflict revision
              </Button>
              {online && state.conflictCurrent && (
                <>
                  <dl>
                    <dt>Reviewed version</dt>
                    <dd>{state.conflictCurrent.data.version}</dd>
                    <dt>Current name</dt>
                    <dd>{state.conflictCurrent.data.name}</dd>
                    <dt>Current category</dt>
                    <dd>{state.conflictCurrent.data.category}</dd>
                  </dl>
                  <p className={styles.help}>
                    Your original fields remain above. Choosing a reviewed version does not send an update.
                  </p>
                  <div className={styles.actions}>
                    <Button variant="secondary" disabled={reading} onClick={() => onResolveConflict(true)}>
                      Keep my fields with reviewed revision
                    </Button>
                    <Button variant="quiet" disabled={reading} onClick={() => onResolveConflict(false)}>
                      Use reviewed current fields
                    </Button>
                  </div>
                </>
              )}
            </section>
          )}
          {online && state.receipt && (
            <section className={styles.acknowledgment} aria-label="Historical native command acknowledgment">
              <h4>Metadata command acknowledged</h4>
              <p>
                Receipt version {state.receipt.data.version} may be historical. It does not prove the current
                draft version or any publication, enrollment or delivery.
              </p>
              <dl>
                <dt>Campaign reference</dt>
                <dd>{state.receipt.data.id}</dd>
                <dt>Acknowledged name</dt>
                <dd>{state.receipt.data.name}</dd>
                <dt>Acknowledged category</dt>
                <dd>{state.receipt.data.category}</dd>
              </dl>
              <Button
                variant="secondary"
                disabled={reading || protectedDraft}
                onClick={() => onSelect(state.receipt!.data.id)}
              >
                Read current acknowledged draft
              </Button>
            </section>
          )}
        </section>
      </div>
    </section>
  );
}

/** Unregistered until root integration; only the four frozen metadata routes are called here. */
export default function CampaignWorkspace({
  session,
  csrf,
  online,
  syntheticFeaturesEnabled,
  accessRevision,
  onDirty,
  onAccessRevoked,
}: CampaignWorkspaceProps) {
  const canRead = session.permissions.includes("campaigns.read");
  const canWrite = session.permissions.includes("campaigns.write");
  const active = syntheticFeaturesEnabled && Boolean(session.activeOrgId);
  const binding = JSON.stringify([
    session.userId,
    session.activeOrgId,
    accessRevision,
    csrf,
    active,
    canRead,
    canWrite,
  ]);
  const callbacks = useRef({ onDirty, onAccessRevoked });
  callbacks.current = { onDirty, onAccessRevoked };
  const live = useRef({ binding, online, active });
  live.current = { binding, online, active };
  const controller = useMemo(() => {
    const base = `/api/v1/orgs/${session.activeOrgId}/campaigns`;
    const request = async (path: string, expected: number, options: RequestInit = {}) => {
      if (live.current.binding !== binding || !live.current.online || !live.current.active)
        throw new Error("The original campaign context is unavailable.");
      const response = await fetch(path, {
        ...options,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      const data = await readCampaignJsonResponse(response);
      if (response.status !== expected)
        throw new Error("The frozen campaign response status could not be verified.");
      return { data, etag: response.headers.get("ETag") || "" };
    };
    const client: CampaignDraftClient = {
      async list(cursor) {
        const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
        return (await request(`${base}?${query}`, 200)).data;
      },
      detail: (id) => request(`${base}/${id}`, 200),
      submit(command) {
        if (command.binding !== binding)
          throw new Error("The original command belongs to another campaign context.");
        return request(
          command.kind === "create" ? base : `${base}/${command.campaignId}`,
          command.kind === "create" ? 201 : 200,
          {
            method: command.kind === "create" ? "POST" : "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
              "Idempotency-Key": command.idempotencyKey,
              ...(command.ifMatch ? { "If-Match": command.ifMatch } : {}),
            },
            body: campaignWriteJson(command.body),
          },
        );
      },
    };
    return new CampaignDraftController({
      binding,
      client,
      online: live.current.online,
      canRead,
      canWrite,
      createKey: () => crypto.randomUUID(),
      onProtectedChange: (value) => {
        if (live.current.binding === binding) callbacks.current.onDirty(value);
      },
      onAccessRevoked: () => {
        if (live.current.binding === binding) callbacks.current.onAccessRevoked?.();
      },
    });
  }, [binding, session.activeOrgId, csrf, canRead, canWrite]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    callbacks.current.onDirty(controller.isProtected());
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    controller.setOnline(online);
  }, [controller, online]);
  useEffect(() => {
    if (active && online && canRead && !controller.isProtected()) void controller.loadPage();
  }, [controller, active, online, canRead]);
  useEffect(() => {
    const preventExit = (event: BeforeUnloadEvent) => {
      if (!controller.isProtected()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventExit);
    return () => window.removeEventListener("beforeunload", preventExit);
  }, [controller]);
  return (
    <CampaignWorkspaceView
      state={state}
      active={active}
      online={online}
      onCreate={() => controller.beginCreate()}
      onRefresh={() => {
        if (live.current.online) void controller.loadPage();
      }}
      onNext={(cursor) => {
        if (live.current.online) void controller.loadPage(cursor);
      }}
      onSelect={(id) => {
        if (live.current.online) void controller.select(id);
      }}
      onEdit={(field, value) => {
        if (live.current.online) controller.edit(field, value);
      }}
      onSave={() => {
        if (live.current.online) void controller.save();
      }}
      onDiscard={() => {
        if (controller.isProtected() && !window.confirm("Discard these unsaved campaign metadata fields?"))
          return;
        controller.discard();
      }}
      onEditRejected={() => {
        if (live.current.online) controller.editRejected();
      }}
      onReadConflict={() => {
        if (live.current.online) void controller.readConflict();
      }}
      onResolveConflict={(keep) => {
        if (
          !live.current.online ||
          !window.confirm(
            keep
              ? "Prepare your fields against the reviewed current revision? Saving remains a separate action."
              : "Discard your fields and use the reviewed current metadata?",
          )
        )
          return;
        controller.resolveConflict(keep);
      }}
    />
  );
}
