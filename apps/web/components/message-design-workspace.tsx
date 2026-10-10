"use client";

import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePenLine,
  FlaskConical,
  MessageSquareText,
  Plus,
  RefreshCw,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import type { Schema } from "../lib/api";
import {
  MessageDesignController,
  type MessageDesignClient,
  type MessageDesignState,
} from "./message-design-controller";
import {
  messageDesignJson,
  messageDesignWriteFromReceipt,
  nativeTextBlocks,
  requireMessageDesignWrite,
} from "./message-design-protocol";
import { requestMessageDesign } from "./message-design-request";
import styles from "./message-design-workspace.module.css";

export type MessageDesignWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  onProtectedChange(value: boolean): void;
  onAccessRevoked?(): void;
};
export type MessageDesignActions = {
  refresh(): void;
  next(cursor: string): void;
  select(id: string): void;
  begin(): void;
  copy(): void;
  edit(field: "name" | "subject" | "channel", value: string): void;
  block(index: number, text: string): void;
  blocks(action: "add" | "remove" | "up" | "down", index?: number): void;
  save(): void;
  discard(): void;
  editRejected(): void;
  copyImmutable(): void;
  readConflict(): void;
  resolveConflict(keep: boolean): void;
};
const issueLabel = (field: string) => {
  const match = /^design\.blocks\.(\d+)\.text$/.exec(field);
  return match
    ? `Text block ${Number(match[1]) + 1}`
    : ({
        name: "Design name",
        subject: "Subject",
        content: "Joined content",
        design: "Text blocks",
        editor: "Editor",
      }[field] ?? "Message draft");
};
/** Pure escaped presentation; no command key, CSRF or session profile is serialized. */
export function MessageDesignView({
  state,
  active,
  online,
  actions,
}: {
  state: MessageDesignState;
  active: boolean;
  online: boolean;
  actions: MessageDesignActions;
}) {
  const prefix = useId();
  const protectedDraft = state.dirty || Boolean(state.pending) || state.phase === "sending";
  const reading = Boolean(state.reading);
  const locked = !online || reading || !state.canWrite || Boolean(state.pending);
  const blocks = state.input ? (nativeTextBlocks(state.input)?.blocks ?? []) : [];
  const selected = online ? state.selected : null;
  const editableSelected = selected ? messageDesignWriteFromReceipt(selected.data) : null;
  const errors = `${prefix}-errors`;
  const hasIssue = (field: string) => state.issues.some((issue) => issue.field === field);
  if (!active)
    return (
      <Empty icon={<MessageSquareText size={30} />} title="Synthetic message drafts unavailable">
        Choose an organization in an explicitly enabled synthetic session.
      </Empty>
    );
  if (!state.canRead)
    return (
      <Empty icon={<MessageSquareText size={30} />} title="Message design read access unavailable">
        Current campaign read access and organization scope are required.
      </Empty>
    );
  if (state.phase === "denied")
    return (
      <Empty icon={<MessageSquareText size={30} />} title="Message design access changed">
        {state.message} Verify current workspace authorization before reopening.
      </Empty>
    );
  if (state.phase === "unavailable")
    return (
      <Empty
        icon={<MessageSquareText size={30} />}
        title="Message capability or resource unavailable"
        action={
          <Button variant="secondary" disabled={!online || reading} onClick={actions.refresh}>
            Verify current message access
          </Button>
        }
      >
        {state.message} An earlier uncertain command may have committed; read current authorized designs
        before another request.
      </Empty>
    );
  return (
    <section className={styles.workspace} aria-label="Synthetic native message design drafts">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Message library</p>
          <h2>Native text designs</h2>
          <p>Keep reusable email and SMS text in private drafts.</p>
        </div>
        <Badge tone="warning">Synthetic · static text drafts</Badge>
      </header>
      <div className={styles.notice}>
        <FlaskConical size={22} aria-hidden="true" />
        <p>
          Static text only. Saving a design does not send a message, publish a campaign or prove sender
          readiness. Rich email editing and delivery are unavailable.
        </p>
      </div>
      {!online && (
        <div className={styles.notice} role="status">
          <WifiOff size={20} aria-hidden="true" />
          <p>
            Offline. Fetched designs, indexes and receipts are hidden and cleared. Protected fields and
            original uncertain commands remain only in this tab; mutations are disabled.
          </p>
        </div>
      )}
      <div className={styles.layout}>
        <section className={styles.card} aria-label="Authorized message design index">
          <div className={styles.heading}>
            <h3>Design library</h3>
            <Button
              variant="secondary"
              disabled={!online || reading || protectedDraft}
              onClick={actions.refresh}
            >
              <RefreshCw size={16} aria-hidden="true" /> Refresh designs
            </Button>
          </div>
          <p className={styles.help}>
            Select a design to read its current version. The list can change as records change.
          </p>
          {reading && (
            <p role="status">
              Reading the authorized message {state.reading === "list" ? "index" : "design"}…
            </p>
          )}
          {online && state.listError && (
            <p role="alert" className={styles.error}>
              {state.listError}
            </p>
          )}
          {online && state.pageStale && (
            <p role="status" className={styles.warning}>
              This earlier page may be stale. Refresh before relying on it.
            </p>
          )}
          {online && !state.page && !reading && (
            <p role="status">The message design index has not been read successfully.</p>
          )}
          {online && state.page && (
            <>
              {state.page.items.length ? (
                <ul className={styles.records}>
                  {state.page.items.map((design) => (
                    <li key={design.id}>
                      <Button
                        variant="quiet"
                        className={`button button-quiet ${styles.record}`}
                        disabled={reading || protectedDraft}
                        onClick={() => actions.select(design.id)}
                      >
                        <span>
                          <strong>{design.name}</strong>
                          <small>
                            {design.channel === "email" ? "Email" : "SMS"} · Read version {design.version}
                          </small>
                          <small>
                            {design.editor === "native" ? "Native format" : "Other editor · read-only"}
                          </small>
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No designs are present in this authorized page read.</p>
              )}
              {state.page.hasMore && state.page.nextCursor && (
                <Button
                  variant="secondary"
                  disabled={reading || protectedDraft}
                  onClick={() => actions.next(state.page!.nextCursor!)}
                >
                  Read next design page
                </Button>
              )}
            </>
          )}
          {state.canWrite && (
            <Button disabled={!online || reading || protectedDraft} onClick={actions.begin}>
              <Plus size={17} aria-hidden="true" /> New native design
            </Button>
          )}
        </section>
        <section className={styles.card} aria-label="Native message draft editor">
          <div className={styles.heading}>
            <h3>
              <FilePenLine size={20} aria-hidden="true" />{" "}
              {state.mode === "create" ? "New text draft" : "Message design"}
            </h3>
            {selected && <Badge>Version {selected.data.version}</Badge>}
          </div>
          <p className={styles.help} role="status" aria-live="polite">
            {state.message}
          </p>
          {state.error && (
            <p role="alert" className={styles.error}>
              {state.error}
            </p>
          )}
          {state.issues.length > 0 && (
            <ul id={errors} className={styles.error} role="alert">
              {state.issues.map((issue) => (
                <li key={`${issue.field}:${issue.message}`}>
                  {issueLabel(issue.field)}: {issue.message}
                </li>
              ))}
            </ul>
          )}
          {state.input ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (online) actions.save();
              }}
            >
              {!state.canWrite && (
                <p>Read-only access. Current write permission is required to change designs.</p>
              )}
              <fieldset disabled={locked}>
                <legend className={styles.srOnly}>Private native text fields</legend>
                <label htmlFor={`${prefix}-name`}>Design name</label>
                <input
                  id={`${prefix}-name`}
                  value={state.input.name}
                  required
                  maxLength={240}
                  autoComplete="off"
                  aria-invalid={hasIssue("name") || undefined}
                  aria-describedby={state.issues.length ? errors : undefined}
                  onChange={(event) => actions.edit("name", event.target.value)}
                />
                <p className={styles.caption}>
                  Up to 120 characters · {Array.from(state.input.name).length} entered
                </p>
                <label htmlFor={`${prefix}-channel`}>Message channel</label>
                <select
                  id={`${prefix}-channel`}
                  value={state.input.channel}
                  disabled={locked || state.mode !== "create"}
                  onChange={(event) => actions.edit("channel", event.target.value)}
                >
                  <option value="email">Email</option>
                  <option value="sms">SMS</option>
                </select>
                {state.mode === "edit" && (
                  <p className={styles.help}>
                    The original channel is fixed. Make an explicit copy to choose another channel.
                  </p>
                )}
                <label htmlFor={`${prefix}-subject`}>Subject (optional)</label>
                <input
                  id={`${prefix}-subject`}
                  value={state.input.subject ?? ""}
                  maxLength={400}
                  autoComplete="off"
                  aria-invalid={hasIssue("subject") || undefined}
                  aria-describedby={`${prefix}-subject-help${state.issues.length ? ` ${errors}` : ""}`}
                  onChange={(event) => actions.edit("subject", event.target.value)}
                />
                <p id={`${prefix}-subject-help`} className={styles.caption}>
                  Optional single-line static text, up to 200 characters. A blank field omits the subject. An
                  SMS subject is saved metadata, not a transport feature.
                </p>
                <p className={styles.help}>
                  Text blocks preserve spaces, line breaks and tabs. Markup, URLs and merge/template syntax
                  are unavailable.
                </p>
                <ol className={styles.blocks}>
                  {blocks.map((block, index) => (
                    <li key={`${prefix}-block-${index}`}>
                      <label htmlFor={`${prefix}-block-${index}`}>Text block {index + 1}</label>
                      <textarea
                        id={`${prefix}-block-${index}`}
                        value={block.text}
                        required
                        rows={5}
                        autoComplete="off"
                        aria-invalid={hasIssue(`design.blocks.${index}.text`) || undefined}
                        aria-describedby={state.issues.length ? errors : undefined}
                        onChange={(event) => actions.block(index, event.target.value)}
                      />
                      <p className={styles.caption}>{Array.from(block.text).length} characters</p>
                      <div className={styles.actions}>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={locked || index === 0}
                          aria-label={`Move text block ${index + 1} up`}
                          onClick={() => actions.blocks("up", index)}
                        >
                          <ArrowUp size={16} aria-hidden="true" /> Move up
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={locked || index === blocks.length - 1}
                          aria-label={`Move text block ${index + 1} down`}
                          onClick={() => actions.blocks("down", index)}
                        >
                          <ArrowDown size={16} aria-hidden="true" /> Move down
                        </Button>
                        <Button
                          type="button"
                          variant="quiet"
                          disabled={locked || blocks.length === 1}
                          aria-label={`Remove text block ${index + 1}`}
                          onClick={() => actions.blocks("remove", index)}
                        >
                          <Trash2 size={16} aria-hidden="true" /> Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ol>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked || blocks.length >= 100}
                  onClick={() => actions.blocks("add")}
                >
                  <Plus size={16} aria-hidden="true" /> Add text block
                </Button>
              </fieldset>
              <section aria-label="Escaped native text preview">
                <h4>Joined text preview</h4>
                <p className={styles.help}>
                  Blocks are joined with one newline. This preview does not evaluate recipients, consent or
                  delivery.
                </p>
                <pre className={styles.preview}>{state.input.content}</pre>
                <p className={styles.caption}>
                  {Array.from(state.input.content).length} characters · no SMS segment or price estimate
                </p>
              </section>
              {state.canWrite && (
                <div className={styles.actions}>
                  <Button
                    type="submit"
                    disabled={
                      !online ||
                      reading ||
                      state.phase === "sending" ||
                      ["conflict", "immutable"].includes(state.phase) ||
                      (!state.dirty && !state.pending)
                    }
                  >
                    {state.phase === "sending"
                      ? "Saving native draft…"
                      : state.pending
                        ? "Retry original design command"
                        : state.mode === "create"
                          ? "Create native design"
                          : "Save design changes"}
                  </Button>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={Boolean(state.pending) || state.phase === "sending" || reading}
                    onClick={actions.discard}
                  >
                    Discard unsaved design
                  </Button>
                  {state.phase === "rejected" && (
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!online || reading}
                      onClick={actions.editRejected}
                    >
                      Edit rejected design
                    </Button>
                  )}
                </div>
              )}
            </form>
          ) : selected ? (
            <section aria-label="Read-only original message design">
              <h4>{selected.data.name}</h4>
              <p>
                {selected.data.channel === "email" ? "Email" : "SMS"} ·{" "}
                {selected.data.editor === "native"
                  ? "Unrecognized or older native format"
                  : "Other editor unavailable"}
              </p>
              {selected.data.subject != null && (
                <>
                  <h4>Stored subject</h4>
                  <pre className={styles.preview}>{selected.data.subject}</pre>
                </>
              )}
              <h4>Stored content</h4>
              <pre className={styles.preview}>{selected.data.content}</pre>
              <p className={styles.help}>
                The original design is read-only. This workspace cannot convert it, execute its syntax or
                claim a delivery preview.
              </p>
            </section>
          ) : (
            <p>Read a current design or start a new native text draft.</p>
          )}
          {selected && editableSelected && state.canWrite && (
            <Button
              variant="secondary"
              disabled={!online || reading || protectedDraft}
              onClick={actions.copy}
            >
              <Copy size={17} aria-hidden="true" /> Copy to new design
            </Button>
          )}
          {state.phase === "uncertain" && (
            <p className={styles.warning}>
              The original request remains protected. Its design ID, revision, command key and fields cannot
              be replaced while the outcome is unknown.
            </p>
          )}
          {state.phase === "immutable" && (
            <section className={styles.warning} aria-label="Referenced immutable design review">
              <h4>Referenced design cannot change</h4>
              <p>
                Saved workflow references preserve the original design. Preparing a copy creates no record
                until you separately save with a new ID.
              </p>
              <Button variant="secondary" disabled={!online || reading} onClick={actions.copyImmutable}>
                Prepare new-ID copy
              </Button>
            </section>
          )}
          {state.phase === "conflict" && (
            <section aria-label="Explicit design revision conflict review">
              <h4>Review current revision</h4>
              <Button variant="secondary" disabled={!online || reading} onClick={actions.readConflict}>
                Read current conflict design
              </Button>
              {online && state.conflictCurrent && (
                <>
                  <p>Reviewed version {state.conflictCurrent.data.version}</p>
                  <h4>{state.conflictCurrent.data.name}</h4>
                  <pre className={styles.preview}>{state.conflictCurrent.data.content}</pre>
                  {messageDesignWriteFromReceipt(state.conflictCurrent.data) ? (
                    <div className={styles.actions}>
                      <Button
                        variant="secondary"
                        disabled={reading}
                        onClick={() => actions.resolveConflict(true)}
                      >
                        Keep my fields with reviewed revision
                      </Button>
                      <Button
                        variant="quiet"
                        disabled={reading}
                        onClick={() => actions.resolveConflict(false)}
                      >
                        Use reviewed current fields
                      </Button>
                    </div>
                  ) : (
                    <p>
                      The current design format cannot be edited here. Original fields and command remain
                      protected.
                    </p>
                  )}
                  <p className={styles.help}>Review choices do not save automatically.</p>
                </>
              )}
            </section>
          )}
          {online && state.receipt && (
            <section aria-label="Historical message command acknowledgment">
              <h4>Native draft command acknowledged</h4>
              <p>
                Receipt version {state.receipt.data.version} may be historical. It does not prove current
                content, publication or delivery.
              </p>
              <p>{state.receipt.data.name}</p>
              <Button
                variant="secondary"
                disabled={reading || protectedDraft}
                onClick={() => actions.select(state.receipt!.data.id)}
              >
                Read current acknowledged design
              </Button>
            </section>
          )}
        </section>
      </div>
    </section>
  );
}

/** Standalone workspace. Root navigation must preserve this lifetime while protection is true. */
export default function MessageDesignWorkspace(props: MessageDesignWorkspaceProps) {
  const { session, csrf, online, syntheticFeaturesEnabled, accessRevision } = props;
  const canRead = session.permissions.includes("campaigns.read"),
    canWrite = session.permissions.includes("campaigns.write");
  const active = syntheticFeaturesEnabled && Boolean(session.activeOrgId);
  const binding = messageDesignJson([
    session.userId,
    session.activeOrgId,
    accessRevision,
    csrf,
    active,
    canRead,
    canWrite,
  ]);
  const live = useRef({ binding, online, active, props });
  live.current = { binding, online, active, props };
  const controller = useMemo(() => {
    const base = `/api/v1/orgs/${session.activeOrgId}/message-designs`;
    const request = async (path: string, expected: number, options: RequestInit = {}) => {
      if (live.current.binding !== binding || !live.current.online || !live.current.active)
        throw new Error("The original message context is unavailable.");
      return requestMessageDesign(path, expected, options);
    };
    const client: MessageDesignClient = {
      async list(cursor) {
        return (
          await request(`${base}?${new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) })}`, 200)
        ).data;
      },
      detail: (id) => request(`${base}/${id}`, 200),
      submit(command) {
        if (command.binding !== binding)
          throw new Error("The original design command belongs to another context.");
        return request(
          command.kind === "create" ? base : `${base}/${command.designId}`,
          command.kind === "create" ? 201 : 200,
          {
            method: command.kind === "create" ? "POST" : "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrf,
              "Idempotency-Key": command.idempotencyKey,
              ...(command.ifMatch ? { "If-Match": command.ifMatch } : {}),
            },
            body: messageDesignJson(requireMessageDesignWrite(command.body)),
          },
        );
      },
    };
    return new MessageDesignController({
      binding,
      client,
      online: live.current.online,
      canRead,
      canWrite,
      createKey: () => crypto.randomUUID(),
      onProtectedChange(value) {
        if (live.current.binding === binding) live.current.props.onProtectedChange(value);
      },
      onAccessRevoked() {
        if (live.current.binding === binding) live.current.props.onAccessRevoked?.();
      },
    });
  }, [binding, session.activeOrgId, csrf, canRead, canWrite]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.attach();
    live.current.props.onProtectedChange(controller.isProtected());
    return () => controller.detach();
  }, [controller]);
  useEffect(() => {
    controller.setOnline(online);
  }, [controller, online]);
  useEffect(() => {
    if (active && online && canRead && !controller.isProtected()) void controller.loadPage();
  }, [controller, active, online, canRead]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (!controller.isProtected()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [controller]);
  const actions: MessageDesignActions = {
    refresh: () => {
      if (live.current.online) void controller.loadPage();
    },
    next: (cursor) => {
      if (live.current.online) void controller.loadPage(cursor);
    },
    select: (id) => {
      if (live.current.online) void controller.select(id);
    },
    begin: () => {
      if (live.current.online) controller.beginCreate();
    },
    copy: () => {
      if (live.current.online) controller.copySelected();
    },
    edit: (field, value) => {
      if (live.current.online) controller.edit(field, value);
    },
    block: (index, text) => {
      if (live.current.online) controller.editBlock(index, text);
    },
    blocks: (action, index) => {
      if (live.current.online && (action !== "remove" || window.confirm("Remove this unsaved text block?")))
        controller.changeBlocks(action, index);
    },
    save: () => {
      if (live.current.online) void controller.save();
    },
    discard: () => {
      if (!controller.isProtected() || window.confirm("Discard this unsent native design?"))
        controller.discard();
    },
    editRejected: () => {
      if (live.current.online) controller.editRejected();
    },
    copyImmutable: () => {
      if (
        live.current.online &&
        window.confirm(
          "Prepare a new-ID copy? Existing workflow references remain unchanged; saving is a separate action.",
        )
      )
        controller.copyImmutable();
    },
    readConflict: () => {
      if (live.current.online) void controller.readConflict();
    },
    resolveConflict: (keep) => {
      if (
        live.current.online &&
        window.confirm("Use this reviewed revision? Saving remains a separate action.")
      )
        controller.resolveConflict(keep);
    },
  };
  return <MessageDesignView state={state} active={active} online={online} actions={actions} />;
}
