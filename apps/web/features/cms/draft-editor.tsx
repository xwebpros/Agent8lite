"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { components } from "../../../../packages/contracts/generated/api";
import {
  fieldBlockKinds,
  type BrowserDraft,
  type BrowserIssue,
  type FieldBlockKind,
} from "../../../../packages/cms/browser";
import { Button } from "../../../../packages/ui/components";
import { CmsDraftController } from "./draft-controller";
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
function issueDescription(issue: BrowserIssue) {
  const messages: Record<string, string> = {
    schema_version_unsupported: "This revision needs an editor that supports its content format.",
    document_schema_invalid: "Check the field format and length.",
    block_properties_invalid: "Check the required fields, format and length.",
    block_id_duplicate: "This draft has repeated block identifiers.",
    block_not_registered: "This block requires a supported editor before it can be changed.",
    nested_blocks_unsupported: "Nested content requires read-only recovery.",
    link_origin_denied: "Use a local path or an approved HTTPS link.",
    canonical_path_invalid: "Use a local canonical path beginning with a single slash.",
    media_publication_unavailable: "Image attachments are unavailable in this editor.",
  };
  const block = /^\/blocks\/(\d+)/.exec(issue.path);
  const location = block
    ? `Block ${Number(block[1]) + 1}`
    : issue.path.startsWith("/seo")
      ? "Search metadata"
      : "Revision content";
  return `${location}: ${messages[issue.code] ?? "This content needs review before it can be edited safely."}`;
}

function TextField({
  label,
  value,
  onChange,
  maxLength,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength: number;
  multiline?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={styles.field}>
      <span>{label}</span>
      {multiline ? (
        <textarea
          id={id}
          rows={3}
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={id}
          value={value}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
function LinkFields({ value, onChange, label }: { value: Link; onChange(value: Link): void; label: string }) {
  return (
    <div className={styles.link}>
      <TextField
        label={`${label} label`}
        value={value.label}
        maxLength={200}
        onChange={(text) => onChange({ ...value, label: text })}
      />
      <TextField
        label={`${label} path or approved HTTPS link`}
        value={value.href}
        maxLength={500}
        onChange={(text) => onChange({ ...value, href: text })}
      />
    </div>
  );
}
function BlockFields({ block, change }: { block: Block; change(change: (block: Block) => void): void }) {
  const props = block.props;
  switch (block.type) {
    case "hero": {
      const action = props.action as Link | undefined;
      return (
        <>
          <TextField
            label="Heading"
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
  const pickerId = useId();
  const kindId = useId();
  const blockList = useRef<HTMLOListElement>(null);
  const editable = controller.canEdit();
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
    <section className={styles.editor} aria-label="Private CMS draft editor">
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
                <fieldset disabled={!editable} className={styles.fields}>
                  <legend>Draft content</legend>
                  <ol ref={blockList} className={styles.blocks}>
                    {state.draft.blocks.map((block, index) => (
                      <li key={block.id} className={styles.block}>
                        <div className={styles.blockHeading}>
                          <h3 tabIndex={-1} data-focus-block={block.id}>
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
          {state.issues.length > 0 && (
            <section role="alert" className={styles.issues}>
              <h3>Content needs review</h3>
              <ul>
                {state.issues.map((issue, index) => (
                  <li key={`${issue.path}:${issue.code}:${index}`}>{issueDescription(issue)}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  );
}
