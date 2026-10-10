"use client";

import { useSyncExternalStore } from "react";
import type { BrowserDraft } from "../../../../packages/cms/browser";
import type { CmsDraftController } from "./draft-controller";
import styles from "./draft-preview.module.css";

type Link = { label: string; href: string };
function InactiveLink({ value }: { value: Link }) {
  // No href, form, image or network request: all actions remain inside the local field editor.
  return (
    <span className={styles.action}>
      <strong>{value.label}</strong>
      <span className={styles.path}>{value.href}</span>
    </span>
  );
}
function PreviewBlock({ block }: { block: BrowserDraft["blocks"][number] }) {
  const props = block.props;
  switch (block.type) {
    case "hero":
      return (
        <section className={styles.hero}>
          <h4>{props.heading as string}</h4>
          {props.summary ? <p>{props.summary as string}</p> : null}
          {props.action ? <InactiveLink value={props.action as Link} /> : null}
        </section>
      );
    case "text":
      return (
        <section className={styles.text}>
          {(props.paragraphs as string[]).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </section>
      );
    case "cta":
      return (
        <section className={styles.cta}>
          <InactiveLink value={props as unknown as Link} />
        </section>
      );
    case "footer":
      return (
        <footer className={styles.footer}>
          <p>{props.text as string}</p>
          {(props.links as Link[] | undefined)?.length ? (
            <ul aria-label="Preview footer links">
              {(props.links as Link[]).map((link, index) => (
                <li key={index}>
                  <InactiveLink value={link} />
                </li>
              ))}
            </ul>
          ) : null}
        </footer>
      );
    default:
      return null; // Strict controller validation prevents unsupported kinds from reaching this renderer.
  }
}

/** A projection of validated in-memory fields. This supplies no public/signed preview or publication. */
export function CmsDraftPreview({ controller }: { controller: CmsDraftController }) {
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const draft = controller.previewDraft();
  if (!draft)
    return (
      <section className={`${styles.preview} ${styles.unavailable}`} aria-label="Local draft preview">
        <h3>Local draft preview unavailable</h3>
        <p>Choose supported content and resolve the listed fields to preview the complete draft.</p>
      </section>
    );
  return (
    <section className={styles.preview} aria-label="Local draft preview">
      <header className={styles.caption}>
        <h3>Local draft preview</h3>
        <p>Links are inactive. Saving a draft keeps it private.</p>
      </header>
      <article className={styles.page} aria-label="Preview content">
        {draft.blocks.length ? (
          draft.blocks.map((block) => <PreviewBlock key={block.id} block={block} />)
        ) : (
          <p className={styles.empty}>This draft has no content blocks yet.</p>
        )}
      </article>
      <section className={styles.metadata} aria-label="Preview search metadata">
        <h4>Search metadata</h4>
        <dl>
          <div>
            <dt>Title</dt>
            <dd>{draft.seo.title || "No title added"}</dd>
          </div>
          <div>
            <dt>Description</dt>
            <dd>{draft.seo.description || "No description added"}</dd>
          </div>
          {draft.seo.canonicalPath && (
            <div>
              <dt>Canonical path</dt>
              <dd>{draft.seo.canonicalPath}</dd>
            </div>
          )}
          <div>
            <dt>Indexing preference</dt>
            <dd>{draft.seo.noindex ? "Request noindex" : "Allow indexing when published"}</dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
