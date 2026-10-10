"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { components } from "../../../../packages/contracts/generated/api";
import { fieldBlockKinds, type BrowserDraft, type FieldBlockKind } from "../../../../packages/cms/browser";
import { Button } from "../../../../packages/ui/components";
import { CmsDraftController } from "./draft-controller";
import { CmsDraftPreview } from "./draft-preview";
import { describeDraftIssues, focusDraftFeedback, type DraftFeedback } from "./draft-validation";
import styles from "./draft-editor.module.css";

type Block = BrowserDraft["blocks"][number];
type Link = { label: string; href: string };
type Props = {
  controller: CmsDraftController;
  history: components["schemas"]["PageRevision"];
  historyLoading?: boolean;
  historyError?: string;
  onLoadMore(cursor: string): void;
  onDirty(dirty: boolean): void;
};
const labels: Record<FieldBlockKind, string> = {
  hero: "Hero",
  text: "Text",
  cta: "Call to action",
  footer: "Footer",
};
function TextField({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
  path,
  feedback,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength: number;
  multiline?: boolean;
  path: string;
  feedback: DraftFeedback[];
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const errors = [
    ...new Set(
      feedback
        .filter((item) => item.target.kind === "field" && item.target.path === path)
        .map((item) => item.description),
    ),
  ];
  const validation = {
    "data-cms-field": path,
    "aria-invalid": errors.length ? true : undefined,
    "aria-describedby": errors.length ? errorId : undefined,
  } as const;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          maxLength={maxLength}
          {...validation}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={maxLength}
          {...validation}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {errors.length > 0 && (
        <span id={errorId} className={styles.fieldError}>
          {errors.join(" ")}
        </span>
      )}
    </div>
  );
}
function LinkFields({
  value,
  onChange,
  label,
  path,
  feedback,
}: {
  value: Link;
  onChange(value: Link): void;
  label: string;
  path: string;
  feedback: DraftFeedback[];
}) {
  return (
    <div className={styles.link}>
      <TextField
        label={`${label} label`}
        path={`${path}/label`}
        feedback={feedback}
        value={value.label}
        maxLength={200}
        onChange={(text) => onChange({ ...value, label: text })}
      />
      <TextField
        label={`${label} path or approved HTTPS link`}
        path={`${path}/href`}
        feedback={feedback}
        value={value.href}
        maxLength={500}
        onChange={(text) => onChange({ ...value, href: text })}
      />
    </div>
  );
}
function BlockFields({
  block,
  change,
  path,
  feedback,
}: {
  block: Block;
  change(change: (block: Block) => void): void;
  path: string;
  feedback: DraftFeedback[];
}) {
  const props = block.props;
  switch (block.type) {
    case "hero": {
      const action = props.action as Link | undefined;
      return (
        <>
          <TextField
            label="Heading"
            path={`${path}/heading`}
            feedback={feedback}
            value={props.heading as string}
            maxLength={200}
            onChange={(value) =>
              change((block) => {
                block.props.heading = value;
              })
            }
          />
          <TextField
            label="Summary"
            path={`${path}/summary`}
            feedback={feedback}
            multiline
            value={(props.summary as string | undefined) ?? ""}
            maxLength={4000}
            onChange={(value) =>
              change((block) => {
                block.props.summary = value;
              })
            }
          />
          {action ? (
            <>
              <LinkFields
                value={action}
                label="Hero action"
                path={`${path}/action`}
                feedback={feedback}
                onChange={(value) =>
                  change((block) => {
                    block.props.action = value;
                  })
                }
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() =>
                  change((block) => {
                    delete block.props.action;
                  })
                }
              >
                Remove hero action
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              type="button"
              onClick={() =>
                change((block) => {
                  block.props.action = { label: "Contact us", href: "/contact" };
                })
              }
            >
              Add hero action
            </Button>
          )}
        </>
      );
    }
    case "text": {
      const paragraphs = props.paragraphs as string[];
      return (
        <>
          {paragraphs.map((paragraph, index) => (
            <div key={index} className={styles.stack}>
              <TextField
                label={`Paragraph ${index + 1}`}
                path={`${path}/paragraphs/${index}`}
                feedback={feedback}
                multiline
                value={paragraph}
                maxLength={4000}
                onChange={(value) =>
                  change((block) => {
                    (block.props.paragraphs as string[])[index] = value;
                  })
                }
              />
              <Button
                variant="secondary"
                type="button"
                disabled={paragraphs.length === 1}
                onClick={() =>
                  change((block) => {
                    (block.props.paragraphs as string[]).splice(index, 1);
                  })
                }
              >
                Remove paragraph {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            type="button"
            disabled={paragraphs.length >= 50}
            onClick={() =>
              change((block) => {
                (block.props.paragraphs as string[]).push("");
              })
            }
          >
            Add paragraph
          </Button>
        </>
      );
    }
    case "cta":
      return (
        <LinkFields
          label="Action"
          path={path}
          feedback={feedback}
          value={props as unknown as Link}
          onChange={(value) =>
            change((block) => {
              block.props = { ...value };
            })
          }
        />
      );
    case "footer": {
      const links = (props.links as Link[] | undefined) ?? [];
      return (
        <>
          <TextField
            label="Footer text"
            path={`${path}/text`}
            feedback={feedback}
            multiline
            value={props.text as string}
            maxLength={4000}
            onChange={(value) =>
              change((block) => {
                block.props.text = value;
              })
            }
          />
          {links.map((link, index) => (
            <div key={index} className={styles.stack}>
              <LinkFields
                label={`Footer link ${index + 1}`}
                path={`${path}/links/${index}`}
                feedback={feedback}
                value={link}
                onChange={(value) =>
                  change((block) => {
                    (block.props.links as Link[])[index] = value;
                  })
                }
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() =>
                  change((block) => {
                    (block.props.links as Link[]).splice(index, 1);
                  })
                }
              >
                Remove footer link {index + 1}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            type="button"
            disabled={links.length >= 12}
            onClick={() =>
              change((block) => {
                block.props.links = [
                  ...((block.props.links as Link[] | undefined) ?? []),
                  { label: "Privacy", href: "/privacy" },
                ];
              })
            }
          >
            Add footer link
          </Button>
        </>
      );
    }
    default:
      return null;
  }
}

/** Mount beneath a client workspace that supplies a session-bound controller and authorized history. */
export function CmsDraftEditor({
  controller,
  history,
  historyLoading = false,
  historyError = "",
  onLoadMore,
  onDirty,
}: Props) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [newKind, setNewKind] = useState<FieldBlockKind>("text");
  const [reorderMessage, setReorderMessage] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const pickerId = useId();
  const kindId = useId();
  const previewId = useId();
  const issuesHeadingId = useId();
  const editor = useRef<HTMLElement>(null);
  const blockList = useRef<HTMLOListElement>(null);
  const editable = controller.canEdit();
  const feedback = describeDraftIssues(state.draft, state.issues);
  const locked = state.dirty || ["saving", "uncertain", "denied"].includes(state.phase);
  useEffect(() => {
    onDirty(state.dirty);
  }, [state.dirty, onDirty]);
  useEffect(() => {
    if (!state.dirty) return;
    const preventExit = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventExit);
    return () => window.removeEventListener("beforeunload", preventExit);
  }, [state.dirty]);

  function move(id: string, direction: -1 | 1) {
    if (!controller.moveBlock(id, direction)) return;
    const blocks = controller.getSnapshot().draft!.blocks;
    const position = blocks.findIndex((block) => block.id === id) + 1;
    setReorderMessage(`Block moved to position ${position} of ${blocks.length}.`);
    // Focus the stable block legend after moving, including when the pressed button becomes disabled.
    requestAnimationFrame(() => {
      const target = blockList.current?.querySelector<HTMLElement>(`[data-focus-block="${id}"]`);
      target?.focus();
    });
  }

  return (
    <section ref={editor} className={styles.editor} aria-label="Private CMS draft editor">
      <div className={styles.heading}>
        <div>
          <h2>{state.document.title}</h2>
          <p>Private draft · document version {state.document.version}</p>
        </div>
      </div>
      <p role="status" aria-live="polite" className={styles.notice}>
        {state.message}
      </p>
      {!state.online && (
        <p role="status">
          You are offline. Editing remains in memory; saving and reconciliation require a connection.
        </p>
      )}
      {state.phase !== "denied" && (
        <>
          {!state.canWrite && <p>You have read access. Draft editing requires content write permission.</p>}
          <div className={styles.stack}>
            <label htmlFor={pickerId}>Choose an explicit revision</label>
            <select
              id={pickerId}
              value={state.selectedRevisionId ?? ""}
              disabled={locked || historyLoading}
              onChange={(event) => {
                const revision = history.items.find((item) => item.id === event.target.value);
                if (revision) controller.selectRevision(revision);
              }}
            >
              <option value="" disabled>
                Select a revision
              </option>
              {state.selectedRevisionId &&
                !history.items.some((item) => item.id === state.selectedRevisionId) && (
                  <option value={state.selectedRevisionId}>
                    Selected revision {state.selectedRevisionId}
                  </option>
                )}
              {history.items.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {revision.createdAt} · {revision.id}
                </option>
              ))}
            </select>
            <p className={styles.help}>
              History order does not identify the latest draft. Selecting a revision never publishes it.
            </p>
            {historyError && (
              <p role="alert">Revision history could not be loaded. Refresh access or try again.</p>
            )}
            {historyLoading && <p role="status">Loading revision history…</p>}
            {history.hasMore && history.nextCursor && (
              <Button
                variant="secondary"
                type="button"
                disabled={historyLoading}
                onClick={() => onLoadMore(history.nextCursor!)}
              >
                Load more revisions
              </Button>
            )}
            {!state.recovery && (
              <Button
                variant="secondary"
                type="button"
                disabled={locked || !state.canWrite}
                onClick={() => controller.startBlank()}
              >
                Start a blank draft
              </Button>
            )}
          </div>
          {feedback.length > 0 && (
            <section aria-labelledby={issuesHeadingId} className={styles.issues}>
              <h3 id={issuesHeadingId} tabIndex={-1} data-cms-issue-summary>
                Content needs review
              </h3>
              <p role="status" aria-live="polite">
                {feedback.length} {feedback.length === 1 ? "issue needs" : "issues need"} review before
                saving.
              </p>
              <ul>
                {feedback.map((item, index) => (
                  <li key={`${item.issue.path}:${item.issue.code}:${index}`}>
                    {editable && item.target.kind !== "summary" ? (
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => {
                          if (editor.current) focusDraftFeedback(editor.current, item);
                        }}
                      >
                        {item.message}
                      </Button>
                    ) : (
                      item.message
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {state.recovery ? (
            <section className={styles.recovery} aria-label="Read-only revision recovery">
              <h3>Original revision JSON</h3>
              <p>Unsupported content is preserved for recovery. It cannot be edited or saved here.</p>
              <pre tabIndex={0} aria-label="Preserved original revision JSON">
                {JSON.stringify(state.recovery.data, null, 2)}
              </pre>
            </section>
          ) : (
            state.draft && (
              <>
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={!state.canUndo}
                    onClick={() => controller.undo()}
                  >
                    Undo local edit
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={!state.canRedo}
                    onClick={() => controller.redo()}
                  >
                    Redo local edit
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    aria-expanded={showPreview}
                    aria-controls={previewId}
                    onClick={() => setShowPreview((shown) => !shown)}
                  >
                    {showPreview ? "Hide local preview" : "Show local preview"}
                  </Button>
                </div>
                <p className={styles.help}>
                  Undo and redo cover recent local edits in this tab. Saved revisions remain in the history
                  picker.
                </p>
                <div id={previewId} hidden={!showPreview}>
                  {showPreview && <CmsDraftPreview controller={controller} />}
                </div>
                <fieldset disabled={!editable} className={styles.fields}>
                  <legend>Draft content</legend>
                  <ol ref={blockList} className={styles.blocks}>
                    {state.draft.blocks.map((block, index) => (
                      <li key={block.id} className={styles.block}>
                        <div className={styles.blockHeading}>
                          <h3 tabIndex={-1} data-focus-block={block.id} data-cms-block={`/blocks/${index}`}>
                            {index + 1}. {labels[block.type as FieldBlockKind]}
                          </h3>
                          <div className={styles.actions}>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={index === 0}
                              aria-label={`Move block ${index + 1} up`}
                              onClick={() => move(block.id, -1)}
                            >
                              Move up
                            </Button>
                            <Button
                              variant="secondary"
                              type="button"
                              disabled={index === state.draft!.blocks.length - 1}
                              aria-label={`Move block ${index + 1} down`}
                              onClick={() => move(block.id, 1)}
                            >
                              Move down
                            </Button>
                            <Button
                              variant="secondary"
                              type="button"
                              aria-label={`Remove block ${index + 1}`}
                              onClick={() =>
                                controller.edit((draft) => {
                                  draft.blocks = draft.blocks.filter((item) => item.id !== block.id);
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                        <BlockFields
                          block={block}
                          path={`/blocks/${index}/props`}
                          feedback={feedback}
                          change={(change) =>
                            controller.edit((draft) => {
                              const target = draft.blocks.find((item) => item.id === block.id);
                              if (target) change(target);
                            })
                          }
                        />
                      </li>
                    ))}
                  </ol>
                  <div className={styles.actions}>
                    <label htmlFor={kindId}>New block</label>
                    <select
                      id={kindId}
                      value={newKind}
                      onChange={(event) => setNewKind(event.target.value as FieldBlockKind)}
                    >
                      {fieldBlockKinds.map((kind) => (
                        <option key={kind} value={kind}>
                          {labels[kind]}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={state.draft.blocks.length >= 200}
                      onClick={() => controller.addBlock(newKind, crypto.randomUUID())}
                    >
                      Add block
                    </Button>
                  </div>
                  <h3>Search metadata</h3>
                  <TextField
                    label="Search title"
                    path="/seo/title"
                    feedback={feedback}
                    value={state.draft.seo.title}
                    maxLength={70}
                    onChange={(value) =>
                      controller.edit((draft) => {
                        draft.seo.title = value;
                      })
                    }
                  />
                  <TextField
                    label="Search description"
                    path="/seo/description"
                    feedback={feedback}
                    multiline
                    value={state.draft.seo.description}
                    maxLength={170}
                    onChange={(value) =>
                      controller.edit((draft) => {
                        draft.seo.description = value;
                      })
                    }
                  />
                  <TextField
                    label="Canonical local path (optional)"
                    path="/seo/canonicalPath"
                    feedback={feedback}
                    value={state.draft.seo.canonicalPath ?? ""}
                    maxLength={200}
                    onChange={(value) =>
                      controller.edit((draft) => {
                        if (value) draft.seo.canonicalPath = value;
                        else delete draft.seo.canonicalPath;
                      })
                    }
                  />
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={state.draft.seo.noindex}
                      onChange={(event) =>
                        controller.edit((draft) => {
                          draft.seo.noindex = event.target.checked;
                        })
                      }
                    />
                    Request noindex when publication is available
                  </label>
                </fieldset>
                <p role="status" aria-live="polite">
                  {reorderMessage}
                </p>
                <div className={styles.actions}>
                  {editable && feedback.length > 0 && (
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => {
                        if (editor.current) focusDraftFeedback(editor.current, feedback[0]);
                      }}
                    >
                      Review invalid fields
                    </Button>
                  )}
                  {state.phase === "conflict" ? (
                    <Button
                      type="button"
                      disabled={!state.online}
                      onClick={() => void controller.refreshVersion()}
                    >
                      Read current version and keep draft
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={
                        !state.online ||
                        state.phase === "saving" ||
                        (!editable && state.phase !== "uncertain") ||
                        !state.dirty ||
                        state.issues.length > 0
                      }
                      onClick={() => void controller.save()}
                    >
                      {state.phase === "uncertain"
                        ? "Retry the same save"
                        : state.phase === "saving"
                          ? "Saving…"
                          : "Save draft revision"}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={!state.dirty || ["saving", "uncertain"].includes(state.phase)}
                    onClick={() => controller.discardChanges()}
                  >
                    Discard unsaved changes
                  </Button>
                </div>
              </>
            )
          )}
        </>
      )}
    </section>
  );
}
