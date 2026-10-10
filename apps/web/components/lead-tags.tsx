"use client";

import { Tags } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Props = {
  lead: Schema<"Lead">;
  organizationId: string;
  online: boolean;
  working: boolean;
  editInProgress: boolean;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
  onSaved(lead: Schema<"Lead">): Promise<void>;
};
export default function LeadTags({
  lead,
  organizationId,
  online,
  working,
  editInProgress,
  runCommand,
  onDirty,
  setWorking,
  onSaved,
}: Props) {
  const [tags, setTags] = useState<Schema<"Tag">[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(lead.version);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const base = `/v1/orgs/${organizationId}`;
  const load = useCallback(
    async (next?: string) => {
      if (!online) return;
      const generation = ++epoch.current;
      setLoading(true);
      try {
        const result = await api<Schema<"PageTag">>(
          `${base}/tags?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setTags((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setCursor(result.data.nextCursor);
        setLoaded(true);
        setError("");
      } catch (err) {
        if (generation !== epoch.current) return;
        setError(err instanceof Error ? err.message : "Tag catalog unavailable.");
        setLoaded(false);
        setTags([]);
        setCursor(null);
        if (err instanceof ApiError && [401, 403].includes(err.status)) {
          setSelection([]);
          setConfirmed(false);
          setDirty(false);
        }
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [online, base],
  );
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
  useEffect(() => {
    if (!dirty) setVersion(lead.version);
  }, [dirty, lead.version]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(
    () => () => {
      ++lifetime.current;
      onDirty(false);
    },
    [onDirty],
  );
  function reset() {
    setSelection([]);
    setConfirmed(false);
    setDirty(false);
    setVersion(lead.version);
    setError("");
    setNotice("");
  }
  function failure(err: unknown) {
    setError(
      err instanceof ApiError && err.status === 412
        ? "The lead changed. Your replacement proposal is preserved. Discard it and reload the lead version before submitting again."
        : err instanceof Error
          ? err.message
          : "Replacement status unavailable. Retry the same proposal to reconcile its result.",
    );
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      setTags([]);
      setLoaded(false);
      setSelection([]);
      setConfirmed(false);
      setDirty(false);
    }
  }
  async function reload() {
    if (
      !online ||
      working ||
      editInProgress ||
      (dirty && !window.confirm("Discard the tag replacement proposal and reload the latest lead version?"))
    )
      return;
    const generation = lifetime.current;
    setWorking(true);
    try {
      const result = await api<Schema<"Lead">>(`${base}/leads/${lead.id}`);
      if (generation !== lifetime.current) return;
      reset();
      setVersion(result.data.version);
      await onSaved(result.data);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function replace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || working || editInProgress || !loaded || !confirmed || !dirty) return;
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    try {
      const body: Schema<"LeadTagsWrite"> = { tagIds: [...selection].sort() };
      const result = await runCommand<Schema<"Lead">>(`${base}/leads/${lead.id}/tags`, body, "PUT", version);
      if (generation !== lifetime.current) return;
      setDirty(false);
      setConfirmed(false);
      setSelection([]);
      setVersion(result.version);
      setNotice("Tag replacement was acknowledged by the server. Current tag readback remains unavailable.");
      await onSaved(result);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="lead-tags-section" aria-label="Explicit lead tag replacement">
      <div className="panel-heading">
        <h2>
          <Tags size={20} />
          Replace lead tags
        </h2>
        <Badge>
          {loading ? "Loading catalog…" : loaded ? `${tags.length} catalog tags loaded` : "Unavailable"}
        </Badge>
      </div>
      <div className="lead-tags-body">
        <p className="muted">
          The current API does not return this lead’s assigned tags. Choices below describe a new replacement
          set; unchecked boxes do not mean the lead has no tags. Saving replaces every existing tag, including
          tags outside this loaded catalog page.
        </p>
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
        <form onSubmit={replace}>
          <fieldset disabled={working || !online || editInProgress}>
            <fieldset className="office-options">
              <legend>Proposed replacement tags</legend>
              {tags.map((tag) => (
                <label key={tag.id}>
                  <input
                    type="checkbox"
                    checked={selection.includes(tag.id)}
                    onChange={(event) => {
                      setSelection((current) =>
                        event.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id),
                      );
                      setConfirmed(false);
                      setDirty(true);
                      setNotice("");
                    }}
                  />
                  <span>{tag.name}</span>
                </label>
              ))}
              {!tags.length && (
                <p className="muted">
                  {loaded
                    ? "No catalog tags are available. Removing all tags still requires explicit confirmation."
                    : "The server has not returned a tag catalog."}
                </p>
              )}
              {cursor && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={loading}
                  onClick={() => void load(cursor)}
                >
                  Load more replacement tags
                </Button>
              )}
            </fieldset>
            <div className="tag-replacement-review">
              <strong>
                {selection.length
                  ? `Replace all existing tags with ${selection.length} selected ${selection.length === 1 ? "tag" : "tags"}.`
                  : "Remove all existing tags from this lead."}
              </strong>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                    setDirty(true);
                  }}
                />
                <span>
                  I reviewed this complete replacement and authorize removing any existing tags outside my
                  selection.
                </span>
              </label>
            </div>
            <p className="muted">
              Lead version {version}. Save other lead or note drafts before submitting a tag replacement.
            </p>
            <div className="form-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  if (!dirty || window.confirm("Discard this unsaved tag replacement?")) reset();
                }}
              >
                Discard tag proposal
              </Button>
              <Button type="button" variant="secondary" onClick={() => void reload()}>
                Discard and reload lead version
              </Button>
              <Button type="submit" disabled={!confirmed || !dirty || !loaded}>
                Confirm tag replacement
              </Button>
            </div>
          </fieldset>
        </form>
      </div>
    </section>
  );
}
