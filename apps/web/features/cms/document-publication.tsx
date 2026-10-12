"use client";

import { BookOpen, RefreshCw, UploadCloud } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button } from "../../../../packages/ui/components";
import { api, ApiError } from "../../lib/api";
import type { Schema } from "../../lib/api";
import styles from "../../components/cms-workspace.module.css";

function uncertain(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
}
function fail(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

export function CmsDocumentPublication({
  documentId,
  base,
  csrf,
  online,
}: {
  documentId: string;
  base: string;
  csrf: string;
  online: boolean;
}) {
  const [document, setDocument] = useState<Schema<"Document"> | null>(null);
  const [revisions, setRevisions] = useState<Schema<"Revision">[]>([]);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [docError, setDocError] = useState("");
  const [revisionsError, setRevisionsError] = useState("");

  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [action, setAction] = useState<"publish" | "rollback">("publish");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [commandError, setCommandError] = useState("");
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const keyRef = useRef<string>("");

  const loadDocument = useCallback(async () => {
    setLoadingDoc(true);
    setDocError("");
    try {
      const result = await api<Schema<"Document">>(`${base}/documents/${documentId}`);
      setDocument(result.data);
    } catch (e) {
      setDocError(fail(e));
    } finally {
      setLoadingDoc(false);
    }
  }, [base, documentId]);

  const loadRevisions = useCallback(async () => {
    setLoadingRevisions(true);
    setRevisionsError("");
    try {
      const result = await api<Schema<"PageRevision">>(`${base}/documents/${documentId}/revisions?limit=20`);
      setRevisions(result.data.items);
    } catch (e) {
      setRevisionsError(fail(e));
    } finally {
      setLoadingRevisions(false);
    }
  }, [base, documentId]);

  useEffect(() => {
    void loadDocument();
    void loadRevisions();
  }, [loadDocument, loadRevisions]);

  async function executeCommand(e: React.FormEvent) {
    e.preventDefault();
    if (!document || !selectedRevisionId) return;
    if (!keyRef.current || unknownOutcome) keyRef.current = crypto.randomUUID();
    setWorking(true);
    setCommandError("");
    setUnknownOutcome(false);
    setNotice("");
    const route = action === "publish" ? "publish" : "rollback";
    try {
      await api<Schema<"Job">>(`${base}/documents/${documentId}/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": keyRef.current,
        },
        body: JSON.stringify({
          revisionId: selectedRevisionId,
          expectedDocumentVersion: document.version,
        } satisfies Schema<"PublishRequest">),
      });
      const verb = action === "publish" ? "Published" : "Rolled back";
      setNotice(`${verb} successfully. Refreshing document state…`);
      keyRef.current = "";
      await loadDocument();
      setNotice(`${verb} successfully.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 412) {
        setCommandError("The document version changed since you loaded it. Refresh to see the latest state.");
        void loadDocument();
      } else if (uncertain(e)) {
        setUnknownOutcome(true);
        setCommandError(
          "Outcome is unknown. Input and command key are retained. Refresh the document and retry exactly to reconcile.",
        );
      } else {
        keyRef.current = "";
        setCommandError(fail(e));
      }
    } finally {
      setWorking(false);
    }
  }

  const publishedRevision = revisions.find((r) => r.id === document?.publishedRevisionId);
  const canSubmit = Boolean(document && selectedRevisionId && online && !working);

  return (
    <section className={styles.card} aria-labelledby="cms-publication-title">
      <div className={styles.heading}>
        <h3 id="cms-publication-title">
          <UploadCloud size={16} aria-hidden="true" /> Document publication
        </h3>
        <Button
          variant="secondary"
          disabled={!online || loadingDoc || loadingRevisions}
          onClick={() => {
            void loadDocument();
            void loadRevisions();
          }}
          aria-label="Refresh document and revision list"
        >
          <RefreshCw size={14} aria-hidden="true" />
        </Button>
      </div>

      {loadingDoc && <p role="status">Reading document state…</p>}
      {docError && (
        <p className={styles.error} role="alert">
          {docError}
        </p>
      )}

      {document && (
        <dl className={styles.fields} style={{ marginBottom: 8 }}>
          <div>
            <dt>Version</dt>
            <dd>
              <Badge>{document.version}</Badge>
            </dd>
          </div>
          <div>
            <dt>Published revision</dt>
            <dd>
              {document.publishedRevisionId ? (
                <code style={{ fontSize: "0.75rem" }}>{document.publishedRevisionId.slice(0, 8)}…</code>
              ) : (
                <Badge>unpublished</Badge>
              )}
            </dd>
          </div>
          {publishedRevision && (
            <div>
              <dt>Published at</dt>
              <dd>
                <time dateTime={publishedRevision.createdAt}>
                  {new Date(publishedRevision.createdAt).toLocaleString()}
                </time>
              </dd>
            </div>
          )}
        </dl>
      )}

      {loadingRevisions && <p role="status">Reading revision list…</p>}
      {revisionsError && (
        <p className={styles.error} role="alert">
          {revisionsError}
        </p>
      )}

      {revisions.length === 0 && !loadingRevisions && !revisionsError && (
        <p>No revisions exist yet. Save a draft first.</p>
      )}

      {revisions.length > 0 && document && (
        <form onSubmit={(event) => void executeCommand(event)}>
          <fieldset disabled={!online || working}>
            <legend className={styles.srOnly}>Publication controls</legend>

            <label>
              Revision to set as published
              <select
                required
                value={selectedRevisionId}
                onChange={(e) => {
                  setSelectedRevisionId(e.target.value);
                  setCommandError("");
                  setUnknownOutcome(false);
                }}
              >
                <option value="">Choose a revision</option>
                {revisions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id.slice(0, 8)}… · schema v{r.schemaVersion} · {new Date(r.createdAt).toLocaleString()}
                    {r.id === document.publishedRevisionId ? " (current)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.fields} style={{ marginTop: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="pub-action"
                  value="publish"
                  checked={action === "publish"}
                  onChange={() => setAction("publish")}
                />
                Publish (set as current public revision)
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input
                  type="radio"
                  name="pub-action"
                  value="rollback"
                  checked={action === "rollback"}
                  onChange={() => setAction("rollback")}
                />
                Rollback (revert to a prior revision)
              </label>
            </div>
          </fieldset>

          {unknownOutcome && (
            <p className={styles.warning} role="status">
              Outcome unknown — retain inputs and retry to reconcile.
            </p>
          )}
          {commandError && (
            <p className={styles.error} role="alert">
              {commandError}
            </p>
          )}
          {notice && (
            <p className={styles.notice} role="status">
              {notice}
            </p>
          )}

          <div className={styles.actions}>
            <Button type="submit" disabled={!canSubmit}>
              {working
                ? action === "publish"
                  ? "Publishing…"
                  : "Rolling back…"
                : unknownOutcome
                  ? `Retry ${action}`
                  : action === "publish"
                    ? "Publish revision"
                    : "Rollback to revision"}
            </Button>
            {unknownOutcome && (
              <Button
                type="button"
                variant="secondary"
                disabled={!online || working}
                onClick={() => {
                  keyRef.current = "";
                  setUnknownOutcome(false);
                  setCommandError("");
                  setSelectedRevisionId("");
                }}
              >
                Discard and start over
              </Button>
            )}
          </div>
        </form>
      )}

      <p className={styles.help} style={{ marginTop: 8 }}>
        <BookOpen size={12} aria-hidden="true" /> Publishing sets the public pointer for this document.
        Revisions are immutable; rollback simply moves the pointer back.
      </p>
    </section>
  );
}
