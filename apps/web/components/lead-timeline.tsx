"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, MessageSquare } from "lucide-react";
import { Badge, Button } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  lead: Schema<"Lead">;
  organizationId: string;
  timezone: string;
  online: boolean;
  working: boolean;
  editInProgress: boolean;
  canWrite: boolean;
  onDirty(value: boolean): void;
  onSaved(): Promise<void>;
  setWorking(value: boolean): void;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
};
export default function LeadTimeline({
  lead,
  organizationId,
  timezone,
  online,
  working,
  editInProgress,
  canWrite,
  onDirty,
  onSaved,
  setWorking,
  runCommand,
}: Props) {
  const [notes, setNotes] = useState<Schema<"Note">[]>([]);
  const [activity, setActivity] = useState<Schema<"Activity">[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [partial, setPartial] = useState(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const generation = ++epoch.current;
    setLoading(true);
    setError("");
    try {
      const base = `/v1/orgs/${organizationId}/leads/${lead.id}`;
      const [notePage, activityPage] = await Promise.all([
        api<Schema<"PageNote">>(`${base}/notes`),
        api<Schema<"PageActivity">>(`${base}/activity`),
      ]);
      if (generation !== epoch.current) return;
      setNotes(notePage.data.items);
      setActivity(activityPage.data.items);
      setPartial(notePage.data.hasMore || activityPage.data.hasMore);
    } catch (err) {
      if (generation !== epoch.current) return;
      setNotes([]);
      setActivity([]);
      setError(err instanceof Error ? err.message : "Timeline unavailable.");
    } finally {
      if (generation === epoch.current) setLoading(false);
    }
  }, [organizationId, lead.id]);
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  useEffect(() => {
    onDirty(Boolean(draft));
  }, [draft, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  async function addNote() {
    if (!draft.trim()) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const input: Schema<"NoteWrite"> = { body: draft.trim() };
      await runCommand<Schema<"Note">>(
        `/v1/orgs/${organizationId}/leads/${lead.id}/notes`,
        input,
        "POST",
        lead.version,
      );
      setDraft("");
      setNotice("Note saved to this lead.");
      await load();
      await onSaved();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 412
          ? "The lead changed. Close and reopen it to review the latest version before saving this note."
          : err instanceof Error
            ? err.message
            : "Note could not be saved.",
      );
    } finally {
      setWorking(false);
    }
  }
  const when = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(new Date(value));
  return (
    <section className="lead-timeline" aria-label="Lead notes and activity">
      <h3>
        <MessageSquare size={18} />
        Notes & activity
      </h3>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="success" role="status">
          {notice}
        </div>
      )}
      {canWrite && (
        <div className="note-editor">
          <label htmlFor="lead-note">Add a note</label>
          <textarea
            id="lead-note"
            maxLength={10000}
            rows={4}
            placeholder="Keep useful context from your conversation…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={working}
          />
          <div>
            <span className="muted">
              {editInProgress
                ? "Save or discard other lead edits before adding a note."
                : "Notes never send a message to this contact."}
            </span>
            <Button
              type="button"
              disabled={!draft.trim() || working || !online || editInProgress}
              onClick={() => void addNote()}
            >
              {working ? "Saving…" : "Save note"}
            </Button>
          </div>
        </div>
      )}
      {loading ? (
        <p className="muted">Loading authorized timeline…</p>
      ) : (
        <>
          {notes.length ? (
            <div className="notes-list">
              {notes.map((note) => (
                <article key={note.id}>
                  <div>
                    <Badge>Note</Badge>
                    <time dateTime={note.createdAt}>{when(note.createdAt)}</time>
                  </div>
                  <p>{note.body}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="timeline-empty">
              {error ? "Notes unavailable." : "No notes returned for this lead."}
            </p>
          )}
          <div className="activity-list">
            {activity.map((event) => (
              <article key={event.id}>
                <Clock3 size={15} />
                <div>
                  <strong>{event.description}</strong>
                  <time dateTime={event.occurredAt}>{when(event.occurredAt)}</time>
                </div>
              </article>
            ))}
          </div>
          {partial && <p className="muted">Additional timeline records exist; pagination is pending.</p>}
        </>
      )}
    </section>
  );
}
