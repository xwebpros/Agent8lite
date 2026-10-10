"use client";

import { Kanban, Plus, RefreshCw, Tags } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";

type Resource = "pipeline-stages" | "lead-sources" | "tags";
type RecordItem = Schema<"PipelineStage"> | Schema<"LeadSource"> | Schema<"Tag">;
type Page = Schema<"PagePipelineStage"> | Schema<"PageLeadSource"> | Schema<"PageTag">;
const resources = [
  { id: "pipeline-stages", label: "Pipeline stages", singular: "stage", permission: "crm.pipeline" },
  { id: "lead-sources", label: "Lead sources", singular: "source", permission: "crm.sources" },
  { id: "tags", label: "Tags", singular: "tag", permission: "crm.tags" },
] as const;
type Props = {
  session: Schema<"Session">;
  online: boolean;
  working: boolean;
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
  onSaved(): Promise<void>;
};
export default function CrmConfiguration(props: Props) {
  const allowed = resources.filter((item) => props.session.permissions.includes(`${item.permission}.read`));
  const [resource, setResource] = useState<Resource>(allowed[0]?.id || "pipeline-stages");
  const [dirty, setDirty] = useState(false);
  const reportDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      props.onDirty(value);
    },
    [props.onDirty],
  );
  return (
    <section className="crm-configuration" aria-label="CRM configuration">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">WORKSPACE CONFIGURATION</span>
          <h2>A pipeline that fits your practice.</h2>
          <p className="section-description">
            Configure immutable stage identities, source attribution and a shared tag catalog. Updates require
            the displayed record version.
          </p>
        </div>
      </div>
      <div className="tabs configuration-tabs" role="group" aria-label="CRM configuration categories">
        {allowed.map((item) => (
          <button
            key={item.id}
            className={resource === item.id ? "selected" : ""}
            aria-pressed={resource === item.id}
            disabled={props.working}
            onClick={() => {
              if (
                resource === item.id ||
                (dirty && !window.confirm("Discard this unsaved CRM configuration?"))
              )
                return;
              reportDirty(false);
              setResource(item.id);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {allowed.some((item) => item.id === resource) ? (
        <ConfigurationRecords
          key={`${props.session.activeOrgId}:${resource}`}
          {...props}
          resource={resource}
          onDirty={reportDirty}
        />
      ) : (
        <Empty icon={<Tags size={28} />} title="Configuration unavailable">
          Your current role cannot read these workspace settings.
        </Empty>
      )}
    </section>
  );
}
function ConfigurationRecords({
  session,
  online,
  working,
  runCommand,
  onDirty,
  setWorking,
  onSaved,
  resource,
}: Props & { resource: Resource }) {
  const descriptor = resources.find((item) => item.id === resource)!;
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<RecordItem | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [position, setPosition] = useState("0");
  const [terminal, setTerminal] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const epoch = useRef(0);
  const lifetime = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const base = `/v1/orgs/${session.activeOrgId}/${resource}`;
  const canWrite = session.permissions.includes(`${descriptor.permission}.write`);
  const clearPrivate = useCallback(() => {
    setRecords([]);
    setCursor(null);
    setLoaded(false);
    setSelected(null);
    setEditing(false);
    setName("");
    setCode("");
    setDirty(false);
  }, []);
  const load = useCallback(
    async (next?: string) => {
      if (!online || !session.activeOrgId) return;
      const generation = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const result = await api<Page>(
          `${base}?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`,
        );
        if (generation !== epoch.current) return;
        setRecords((current) => (next ? [...current, ...result.data.items] : result.data.items));
        setCursor(result.data.nextCursor);
        setLoaded(true);
      } catch (err) {
        if (generation !== epoch.current) return;
        setRecords([]);
        setCursor(null);
        setLoaded(false);
        setError(err instanceof Error ? err.message : "CRM configuration unavailable.");
        if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
      } finally {
        if (generation === epoch.current) setLoading(false);
      }
    },
    [online, session.activeOrgId, base, clearPrivate],
  );
  useEffect(() => {
    void load();
    return () => {
      ++epoch.current;
    };
  }, [load]);
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
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing, selected]);
  function applyEditor(record: RecordItem | null) {
    setSelected(record);
    setEditing(true);
    setName(record && "label" in record ? record.label : record?.name || "");
    setCode(record && "code" in record ? record.code : "");
    setPosition(record && "position" in record ? String(record.position) : "0");
    setTerminal(Boolean(record && "terminal" in record && record.terminal));
    setDirty(false);
    setError("");
    setNotice("");
  }
  function openEditor(record: RecordItem | null) {
    if (working || (dirty && !window.confirm("Discard this unsaved CRM configuration?"))) return;
    applyEditor(record);
  }
  function failure(err: unknown) {
    setError(
      err instanceof ApiError && err.status === 412
        ? "This record changed. Your draft is preserved; discard and reload the server version before saving again."
        : err instanceof Error
          ? err.message
          : "Command status unavailable. Retry with the same input to reconcile its result.",
    );
    if (err instanceof ApiError && [401, 403].includes(err.status)) clearPrivate();
    if (err instanceof ApiError && err.status === 404) {
      setEditing(false);
      setSelected(null);
      setDirty(false);
    }
  }
  async function reload() {
    if (
      !selected ||
      !online ||
      working ||
      (dirty && !window.confirm("Discard this draft and reload the latest configuration version?"))
    )
      return;
    const generation = lifetime.current;
    setWorking(true);
    try {
      const result = await api<RecordItem>(`${base}/${selected.id}`);
      if (generation === lifetime.current) applyEditor(result.data);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || working || !canWrite) return;
    const generation = lifetime.current;
    setWorking(true);
    setError("");
    try {
      const body: Schema<"StageWrite"> | Schema<"LeadSourceWrite"> | Schema<"TagWrite"> =
        resource === "pipeline-stages"
          ? { name: name.trim(), position: Number(position), terminal }
          : resource === "lead-sources"
            ? { code: code.trim(), label: name.trim() }
            : { name: name.trim() };
      await runCommand<RecordItem>(
        `${base}${selected ? `/${selected.id}` : ""}`,
        body,
        selected ? "PATCH" : "POST",
        selected?.version,
      );
      if (generation !== lifetime.current) return;
      setEditing(false);
      setSelected(null);
      setDirty(false);
      setNotice(`${descriptor.label} saved with server acknowledgement.`);
      await Promise.all([load(), onSaved()]);
    } catch (err) {
      if (generation === lifetime.current) failure(err);
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
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
      {editing && (
        <section className="panel settings-card workspace-record-editor">
          <h3>
            {selected ? "Edit" : "Create"} {descriptor.singular}
          </h3>
          <form className="settings-form" onSubmit={save} onChange={() => setDirty(true)}>
            <fieldset disabled={working || !online}>
              <label>
                {resource === "lead-sources"
                  ? "Source label"
                  : resource === "tags"
                    ? "Tag name"
                    : "Stage name"}
                <input
                  ref={input}
                  required
                  maxLength={resource === "lead-sources" ? 120 : 80}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              {resource === "lead-sources" && (
                <label>
                  Source code
                  <input
                    required
                    readOnly={Boolean(selected)}
                    maxLength={80}
                    pattern="[a-z0-9][a-z0-9._\-]{0,79}"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <span className="field-help">
                    Lowercase letters, numbers, dots, underscores and hyphens. Existing attribution codes
                    cannot change.
                  </span>
                </label>
              )}
              {resource === "pipeline-stages" && (
                <>
                  <label>
                    Stage position
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      required
                      value={position}
                      onChange={(event) => setPosition(event.target.value)}
                    />
                    <span className="field-help">
                      Positions must be unique. Changing order can invalidate an older list cursor.
                    </span>
                  </label>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={terminal}
                      onChange={(event) => setTerminal(event.target.checked)}
                    />
                    <span>Terminal pipeline stage</span>
                  </label>
                  <p className="muted">
                    Stage identity stays immutable. A terminal stage does not automatically create a won deal.
                  </p>
                </>
              )}
              {selected && (
                <p className="muted">
                  Version {selected.version} · ID {selected.id}
                </p>
              )}
              <div className="form-actions">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    if (!dirty || window.confirm("Discard this unsaved CRM configuration?")) {
                      setEditing(false);
                      setSelected(null);
                      setDirty(false);
                    }
                  }}
                >
                  Cancel configuration edit
                </Button>
                {selected && (
                  <Button variant="secondary" type="button" onClick={() => void reload()}>
                    Discard and reload configuration
                  </Button>
                )}
                <Button type="submit" disabled={!dirty || working || !online}>
                  Save {descriptor.singular}
                </Button>
              </div>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel configuration-list">
        <div className="panel-heading">
          <h2>
            {resource === "pipeline-stages" ? <Kanban size={20} /> : <Tags size={20} />}
            {descriptor.label}
            <Badge>{loading ? "Loading…" : loaded ? `${records.length} loaded` : "Unavailable"}</Badge>
          </h2>
          <div className="heading-actions">
            <Button
              variant="secondary"
              disabled={working || loading || dirty || !online}
              onClick={() => void load()}
            >
              <RefreshCw size={16} />
              Refresh {descriptor.label.toLowerCase()}
            </Button>
            {canWrite && (
              <Button disabled={working || !online} onClick={() => openEditor(null)}>
                <Plus size={16} />
                Add {descriptor.singular}
              </Button>
            )}
          </div>
        </div>
        {records.length ? (
          <div className="workspace-record-rows">
            {records.map((record) => (
              <article key={record.id}>
                <div>
                  <h3>{"label" in record ? record.label : record.name}</h3>
                  <p>
                    {"position" in record
                      ? `Position ${record.position} · ${record.terminal ? "Terminal" : "Active"} stage`
                      : "code" in record
                        ? `Attribution code: ${record.code}`
                        : "Shared workspace tag"}
                  </p>
                  <span>
                    Version {record.version} · {record.id}
                  </span>
                </div>
                {canWrite && (
                  <Button
                    variant="secondary"
                    disabled={working || !online}
                    onClick={() => openEditor(record)}
                  >
                    Edit {descriptor.singular}
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Tags size={28} />}
            title={
              loading
                ? "Loading configuration"
                : loaded
                  ? `No ${descriptor.label.toLowerCase()} yet`
                  : "Configuration unavailable"
            }
          >
            The catalog reflects only authorized server records.
          </Empty>
        )}
        {cursor && (
          <div className="panel-footer">
            <Button
              variant="secondary"
              disabled={working || loading || dirty || !online}
              onClick={() => void load(cursor)}
            >
              Load more {descriptor.label.toLowerCase()}
            </Button>
          </div>
        )}
      </section>
    </>
  );
}
