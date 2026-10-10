"use client";

import { ArrowDownToLine, ArrowUpFromLine, FileSpreadsheet, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import { csvHeaders, privateTransferPath, uploadHeaders } from "../lib/private-transfer";

type Field = Schema<"ImportPreviewRequest">["columnMap"][string];
const fields: { value: Field; label: string }[] = [
  { value: "displayName", label: "Full name" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "intent", label: "Intent" },
  { value: "timeline", label: "Timeline" },
  { value: "sourceCode", label: "Source code" },
];
const suggestions: Record<string, Field> = {
  displayname: "displayName",
  fullname: "displayName",
  name: "displayName",
  email: "email",
  emailaddress: "email",
  phone: "phone",
  phonenumber: "phone",
  intent: "intent",
  timeline: "timeline",
  sourcecode: "sourceCode",
};
type Props = {
  session: Schema<"Session">;
  csrf: string;
  memberId: string;
  online: boolean;
  working: boolean;
  workspaceScope: "own" | "authorized";
  runCommand: <T>(path: string, body: unknown, method?: string, version?: number) => Promise<T>;
  onDirty(value: boolean): void;
  setWorking(value: boolean): void;
  onImported(): Promise<void>;
};
type Operation = { job: Schema<"Job">; stale: boolean; error: string };
export default function DataTransfer({
  session,
  csrf,
  memberId,
  online,
  working,
  workspaceScope,
  runCommand,
  onDirty,
  setWorking,
  onImported,
}: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [map, setMap] = useState<Record<string, Field | "">>({});
  const [grant, setGrant] = useState<Schema<"UploadGrant"> | null>(null);
  const [uploaded, setUploaded] = useState(false);
  const [preview, setPreview] = useState<Schema<"ImportPreview"> | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [confirmedCount, setConfirmedCount] = useState("");
  const [reading, setReading] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operations, setOperations] = useState<Operation[]>([]);
  const [exportKind, setExportKind] = useState<"contacts" | "leads">("contacts");
  const [exportScope, setExportScope] = useState<"own" | "authorized">(workspaceScope);
  const [exportQuery, setExportQuery] = useState("");
  const [exportDirty, setExportDirty] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const checkingRef = useRef(false);
  const refreshedImports = useRef(new Set<string>());
  const base = `/v1/orgs/${session.activeOrgId}`;
  const canImport = session.permissions.includes("crm.import");
  const canExport = session.permissions.includes("data.export");
  const canCreateLeads = session.permissions.includes("crm.leads.write");
  const canReadJobs = session.permissions.includes("jobs.read");
  const expired = Boolean(preview && new Date(preview.expiresAt).getTime() <= now);
  const pending = operations.some(({ job }) => ["queued", "running", "unknown"].includes(job.state));

  useEffect(() => {
    onDirty(Boolean(file) || exportDirty || reading);
  }, [file, exportDirty, reading, onDirty]);
  useEffect(
    () => () => {
      ++generation.current;
      onDirty(false);
    },
    [onDirty],
  );
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [preview]);
  const when = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: session.profile.timezone,
    }).format(new Date(value));
  function reportFailure(err: unknown) {
    setError(
      err instanceof Error
        ? err.message
        : "The operation could not be reconciled. Retry with the same input.",
    );
    if (err instanceof ApiError && [401, 403].includes(err.status)) {
      setFile(null);
      setHeaders([]);
      setMap({});
      setGrant(null);
      setUploaded(false);
      setPreview(null);
      setOperations([]);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  function resetFile() {
    if (working) return;
    ++generation.current;
    setFile(null);
    setHeaders([]);
    setMap({});
    setGrant(null);
    setUploaded(false);
    setPreview(null);
    setReviewed(false);
    setConfirmedCount("");
    setError("");
    if (fileInput.current) fileInput.current.value = "";
  }
  async function chooseFile(selected: File | undefined) {
    resetFile();
    if (!selected) return;
    const epoch = ++generation.current;
    setReading(true);
    setNotice("");
    try {
      const columns = await csvHeaders(selected);
      if (epoch !== generation.current) return;
      const choices: Record<string, Field | ""> = Object.create(null);
      const assigned = new Set<Field>();
      for (const column of columns) {
        const normalized = column.toLowerCase().replace(/[\s_-]/g, "");
        const proposed = Object.hasOwn(suggestions, normalized) ? suggestions[normalized] : undefined;
        const allowed = proposed && (canCreateLeads || ["displayName", "email", "phone"].includes(proposed));
        choices[column] = allowed && !assigned.has(proposed) ? proposed : "";
        if (allowed) assigned.add(proposed);
      }
      setFile(selected);
      setHeaders(columns);
      setMap(choices);
    } catch (err) {
      if (epoch === generation.current) reportFailure(err);
    } finally {
      if (epoch === generation.current) setReading(false);
    }
  }
  function rememberJob(job: Schema<"Job">) {
    setOperations((current) => [
      { job, stale: false, error: "" },
      ...current.filter((item) => item.job.id !== job.id),
    ]);
    if (
      job.kind === "contacts.import" &&
      job.state === "succeeded" &&
      !refreshedImports.current.has(job.id)
    ) {
      refreshedImports.current.add(job.id);
      void onImported();
    }
  }
  const checkJobs = useCallback(async () => {
    if (!online || !canReadJobs || checkingRef.current || !operations.length) return;
    checkingRef.current = true;
    setChecking(true);
    const epoch = generation.current;
    const results = await Promise.allSettled(
      operations.map(({ job }) => api<Schema<"Job">>(`${base}/jobs/${job.id}`)),
    );
    if (epoch === generation.current) {
      const denied = results.find(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof ApiError &&
          [401, 403].includes(result.reason.status),
      );
      if (denied?.status === "rejected") {
        reportFailure(denied.reason);
        checkingRef.current = false;
        setChecking(false);
        return;
      }
      setOperations((current) =>
        current.map((item) => {
          const index = operations.findIndex((known) => known.job.id === item.job.id);
          const result = results[index];
          if (!result) return item;
          if (result.status === "fulfilled") return { job: result.value.data, stale: false, error: "" };
          return {
            job: { ...item.job, resultUrl: null },
            stale: true,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Current status unavailable. Download disabled.",
          };
        }),
      );
      for (const result of results) {
        if (
          result.status === "fulfilled" &&
          result.value.data.kind === "contacts.import" &&
          result.value.data.state === "succeeded" &&
          !refreshedImports.current.has(result.value.data.id)
        ) {
          refreshedImports.current.add(result.value.data.id);
          void onImported();
        }
      }
    }
    checkingRef.current = false;
    setChecking(false);
  }, [online, canReadJobs, operations, base, onImported]);
  useEffect(() => {
    if (!pending || !online || !canReadJobs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void checkJobs();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, online, canReadJobs, checkJobs]);

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !online || working) return;
    const columnMap = Object.fromEntries(
      Object.entries(map).filter((entry): entry is [string, Field] => Boolean(entry[1])),
    ) as Schema<"ImportPreviewRequest">["columnMap"];
    if (!Object.values(columnMap).includes("displayName")) {
      setError("Map a full-name column before previewing.");
      return;
    }
    if (new Set(Object.values(columnMap)).size !== Object.values(columnMap).length) {
      setError("Map each contact field only once.");
      return;
    }
    if (
      ["intent", "timeline"].some((field) => Object.values(columnMap).includes(field as Field)) &&
      !Object.values(columnMap).includes("sourceCode")
    ) {
      setError(
        "Map a source-code column when importing lead intent or timeline. Lead rows need a configured source code.",
      );
      return;
    }
    const epoch = generation.current;
    setWorking(true);
    setError("");
    setNotice("");
    setReviewed(false);
    setConfirmedCount("");
    setPreview(null);
    try {
      let accepted = grant;
      if (!accepted) {
        setPhase("Requesting private upload…");
        const input: Schema<"UploadRequest"> = {
          filename: file.name,
          mimeType: "text/csv",
          bytes: file.size,
          purpose: "contact_import",
        };
        accepted = await runCommand<Schema<"UploadGrant">>(`${base}/uploads`, input);
        if (epoch !== generation.current) return;
        setGrant(accepted);
      }
      if (!uploaded) {
        setPhase("Uploading CSV…");
        const path = privateTransferPath(
          accepted.url,
          `/api/dev/storage/uploads/${accepted.assetId}`,
          window.location.origin,
        );
        const response = await fetch(path, {
          method: "PUT",
          headers: uploadHeaders(accepted, csrf),
          body: file,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
        });
        if (!response.ok) {
          const problem = (await response.json()) as Partial<Schema<"Problem">>;
          throw new ApiError(
            response.status,
            problem.detail || problem.title || "Private upload unavailable. Retry the same file.",
            problem.code,
          );
        }
        if (response.status !== 204)
          throw new Error(
            "The private upload was not acknowledged by the expected service response. Retry the same file to reconcile it.",
          );
        if (epoch !== generation.current) return;
        setUploaded(true);
      }
      setPhase("Validating server preview…");
      const input: Schema<"ImportPreviewRequest"> = { assetId: accepted.assetId, columnMap };
      const result = await runCommand<Schema<"ImportPreview">>(`${base}/imports/contact-previews`, input);
      if (epoch !== generation.current) return;
      setPreview(result);
      setNotice("Preview created. No contacts have been imported. Review the counts before committing.");
    } catch (err) {
      if (epoch === generation.current) reportFailure(err);
    } finally {
      setWorking(false);
      setPhase("");
    }
  }
  async function commit() {
    if (
      !preview ||
      !reviewed ||
      expired ||
      confirmedCount !== String(preview.validRows) ||
      working ||
      !online
    )
      return;
    setWorking(true);
    const epoch = generation.current;
    setError("");
    setPhase("Committing reviewed snapshot…");
    try {
      const input: Schema<"ImportCommit"> = {
        previewId: preview.id,
        duplicatePolicy: "skip",
        confirmedRowCount: preview.validRows,
      };
      const result = await runCommand<Schema<"Job">>(`${base}/imports/contact-commits`, input);
      if (epoch !== generation.current) return;
      rememberJob(result);
      setFile(null);
      setHeaders([]);
      setMap({});
      setGrant(null);
      setUploaded(false);
      setPreview(null);
      setReviewed(false);
      setConfirmedCount("");
      if (fileInput.current) fileInput.current.value = "";
      setNotice(
        `Import command accepted. The job reports ${result.state}; only a succeeded job means the reviewed snapshot was committed.`,
      );
    } catch (err) {
      if (epoch === generation.current) reportFailure(err);
    } finally {
      setWorking(false);
      setPhase("");
    }
  }
  async function requestExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || working) return;
    if (exportScope === "own" && !memberId) {
      setError("Verified member context is unavailable. Refresh your session before exporting.");
      return;
    }
    setWorking(true);
    const epoch = generation.current;
    setError("");
    setPhase("Requesting authorized export…");
    try {
      const filter: Schema<"LeadFilter"> = {
        ...(exportScope === "own" ? { ownerMemberId: memberId } : {}),
        ...(exportQuery.trim() ? { q: exportQuery.trim() } : {}),
      };
      const input: Schema<"ExportRequest"> = { kind: exportKind, filter };
      const result = await runCommand<Schema<"Job">>(`${base}/exports`, input);
      if (epoch !== generation.current) return;
      rememberJob(result);
      setExportDirty(false);
      setNotice(
        `Export command accepted. The job reports ${result.state}. Download remains subject to your current access.`,
      );
    } catch (err) {
      if (epoch === generation.current) reportFailure(err);
    } finally {
      setWorking(false);
      setPhase("");
    }
  }
  async function download(job: Schema<"Job">) {
    if (job.state !== "succeeded" || !job.resultUrl || working || !online) return;
    setWorking(true);
    const epoch = generation.current;
    setError("");
    setPhase("Authorizing private download…");
    try {
      const path = privateTransferPath(job.resultUrl, `/api/dev/exports/${job.id}`, window.location.origin);
      const response = await fetch(path, {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) {
        const problem = (await response.json()) as Partial<Schema<"Problem">>;
        throw new ApiError(
          response.status,
          problem.detail || problem.title || "Export unavailable or expired.",
          problem.code,
        );
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/csv"))
        throw new Error("The service did not return a CSV. Download cancelled.");
      const blob = await response.blob();
      if (epoch !== generation.current) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `synthetic-${job.kind}-${job.id}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice(
        "The authorized CSV was handed to your browser for download. This is an explicit file export; the application does not cache it.",
      );
    } catch (err) {
      setOperations((current) =>
        current.map((item) =>
          item.job.id === job.id ? { ...item, stale: true, job: { ...item.job, resultUrl: null } } : item,
        ),
      );
      if (epoch === generation.current) reportFailure(err);
    } finally {
      setWorking(false);
      setPhase("");
    }
  }

  return (
    <section className="transfer-section" aria-label="CSV import and export">
      <div className="admin-heading">
        <div>
          <span className="eyebrow">DATA TRANSFER</span>
          <h2>Bring your relationships with you.</h2>
          <p className="section-description">
            Preview a private CSV before importing. Export only the records your current role can access.
          </p>
        </div>
        <FileSpreadsheet size={30} />
      </div>
      <div className="synthetic-note">
        <ShieldCheck size={20} />
        <div>
          <strong>Synthetic development · Private transfers</strong>
          <span>
            Use fictional contacts here. Files and drafts stay in this tab’s memory; uploads are private
            server assets. Offline transfer is disabled. No messages are sent and consent remains unknown.
          </span>
        </div>
      </div>
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
      {phase && (
        <p className="transfer-progress" role="status">
          {phase}
        </p>
      )}
      {canImport && (
        <section className="panel settings-card transfer-import">
          <div className="transfer-title">
            <ArrowUpFromLine size={21} />
            <h3>Import contacts from CSV</h3>
          </div>
          <p className="section-description">
            UTF-8 .csv · Maximum 20 MiB, 30 columns and 1,000 data rows. Only the header is read locally for
            mapping; the server validates every row.
          </p>
          <form className="settings-form" onSubmit={makePreview}>
            <fieldset disabled={working || reading || !online}>
              <label>
                Contact CSV
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => void chooseFile(event.target.files?.[0])}
                />
              </label>
              {reading && (
                <p className="muted" role="status">
                  Reading CSV header…
                </p>
              )}
              {file && (
                <>
                  <div className="file-summary">
                    <FileSpreadsheet size={23} />
                    <div>
                      <strong>{file.name}</strong>
                      <span>
                        {new Intl.NumberFormat("en-US").format(file.size)} bytes ·{" "}
                        {uploaded ? "Private upload accepted" : "Not uploaded"}
                      </span>
                    </div>
                  </div>
                  <h4 className="mapping-title">Review column mapping</h4>
                  <p className="muted">
                    Suggestions are editable. Unmapped columns are ignored. Each contact field can be mapped
                    once.
                  </p>
                  <div className="column-map">
                    {headers.map((header) => (
                      <label key={header}>
                        <span>{header}</span>
                        <select
                          aria-label={`Map ${header}`}
                          value={Object.hasOwn(map, header) ? map[header] : ""}
                          onChange={(event) => {
                            setMap((current) => ({ ...current, [header]: event.target.value as Field | "" }));
                            setPreview(null);
                            setReviewed(false);
                            setConfirmedCount("");
                          }}
                        >
                          <option value="">Ignore column</option>
                          {fields
                            .filter(
                              (field) =>
                                canCreateLeads || ["displayName", "email", "phone"].includes(field.value),
                            )
                            .map((field) => (
                              <option key={field.value} value={field.value}>
                                {field.label}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>
                  <p className="muted">
                    Name, email and phone create contacts. Nonempty intent, timeline or source code also
                    creates a lead assigned explicitly to you and requires a configured source code and
                    lead-write access. Intent values: buyer, seller, both or unknown. Communication consent
                    remains unknown.
                  </p>
                  <div className="form-actions">
                    <Button type="button" variant="secondary" onClick={resetFile}>
                      <X size={16} />
                      Discard file
                    </Button>
                    <Button type="submit" disabled={!file || working || !online}>
                      {working ? "Preparing…" : preview ? "Refresh import preview" : "Preview CSV"}
                    </Button>
                  </div>
                </>
              )}
            </fieldset>
          </form>
          {preview && (
            <div className="import-preview">
              <div className="preview-heading">
                <h3>Review the accepted snapshot</h3>
                <Badge tone={expired ? "warning" : "neutral"}>
                  {expired ? "Expired" : "Uncommitted preview"}
                </Badge>
              </div>
              <div className="import-counts">
                <article>
                  <span>Valid rows</span>
                  <strong>{preview.validRows}</strong>
                  <p>Includes valid duplicates</p>
                </article>
                <article>
                  <span>Invalid rows</span>
                  <strong>{preview.invalidRows}</strong>
                  <p>Excluded from import</p>
                </article>
                <article>
                  <span>Duplicates</span>
                  <strong>{preview.duplicates}</strong>
                  <p>Subset of valid rows · will skip</p>
                </article>
                <article>
                  <span>New contacts with skip</span>
                  <strong>{preview.validRows - preview.duplicates}</strong>
                  <p>Current accepted snapshot</p>
                </article>
              </div>
              <p className="muted">
                Expires {when(preview.expiresAt)} · {session.profile.timezone}. The server rechecks the
                snapshot and current access on commit.
              </p>
              {preview.sampleErrors.length ? (
                <div className="import-errors">
                  <h4>Sample row errors</h4>
                  <ul>
                    {preview.sampleErrors.map((issue, index) => (
                      <li key={`${issue.row}:${issue.field}:${index}`}>
                        <strong>Row {issue.row}</strong>
                        <span>
                          {issue.field} · {issue.code}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="muted">No sample row errors returned.</p>
              )}
              <div className="duplicate-policy">
                <strong>Duplicate policy: skip</strong>
                <p>
                  Valid duplicate rows are skipped; existing contacts are not merged. Reviewed merging is
                  unavailable until a candidate review contract is implemented. Aggregate duplicate counts are
                  shown by this contract.
                </p>
              </div>
              <label className="accept-terms">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                  disabled={working || !online || expired}
                />
                <span>I reviewed the row counts and errors. Skip duplicates and exclude invalid rows.</span>
              </label>
              <label className="confirmed-rows">
                Type {preview.validRows} to confirm the valid-row count
                <input
                  type="text"
                  inputMode="numeric"
                  value={confirmedCount}
                  onChange={(event) => setConfirmedCount(event.target.value)}
                  disabled={working || !online || expired}
                  aria-label="Confirm valid row count"
                  autoComplete="off"
                />
              </label>
              <Button
                disabled={
                  !reviewed ||
                  confirmedCount !== String(preview.validRows) ||
                  expired ||
                  working ||
                  !online ||
                  preview.validRows === 0
                }
                onClick={() => void commit()}
              >
                Commit import with skip
              </Button>
            </div>
          )}
        </section>
      )}
      {canExport && (
        <section className="panel settings-card transfer-export">
          <div className="transfer-title">
            <ArrowDownToLine size={21} />
            <h3>Export a scoped CSV</h3>
          </div>
          <p className="section-description">
            The server checks record scope at request and download. CSV cells are neutralized for spreadsheet
            formulas. Downloads expire after 15 minutes.
          </p>
          <form className="settings-form" onSubmit={requestExport} onChange={() => setExportDirty(true)}>
            <fieldset disabled={working || !online}>
              <div className="form-columns">
                <label>
                  Export records
                  <select
                    value={exportKind}
                    onChange={(event) => setExportKind(event.target.value as "contacts" | "leads")}
                  >
                    <option value="contacts">Contacts</option>
                    <option value="leads">Leads</option>
                  </select>
                </label>
                <label>
                  Export scope
                  <select
                    value={exportScope}
                    onChange={(event) => setExportScope(event.target.value as "own" | "authorized")}
                  >
                    <option value="own">My assigned records</option>
                    <option value="authorized">All permitted records</option>
                  </select>
                </label>
              </div>
              <label>
                Search export records (optional)
                <input
                  value={exportQuery}
                  maxLength={120}
                  onChange={(event) => setExportQuery(event.target.value)}
                  placeholder="Server-side search"
                />
              </label>
              <p className="muted">
                All permitted records remains constrained by your role. This is a server query across matching
                records, independent of the current loaded page.
              </p>
              <Button type="submit">
                <ArrowDownToLine size={17} />
                Request export
              </Button>
            </fieldset>
          </form>
        </section>
      )}
      <section className="panel transfer-jobs">
        <div className="panel-heading">
          <h2>Operations in this tab</h2>
          <Button
            variant="secondary"
            disabled={working || checking || !online || !canReadJobs || !operations.length}
            onClick={() => void checkJobs()}
          >
            <RefreshCw size={16} />
            {checking ? "Checking…" : "Refresh operations"}
          </Button>
        </div>
        {operations.length ? (
          <div className="operation-list">
            {operations.map(({ job, stale, error: jobError }) => (
              <article key={job.id}>
                <div className="operation-heading">
                  <h3>{job.kind}</h3>
                  <Badge
                    tone={
                      job.state === "succeeded" && !stale
                        ? "positive"
                        : ["queued", "running", "unknown"].includes(job.state)
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {stale ? `Last reported: ${job.state}` : job.state}
                  </Badge>
                </div>
                <p>
                  {job.state === "succeeded"
                    ? "The server reports this operation completed."
                    : job.state === "unknown"
                      ? "Acceptance is unknown. Check operation status; no automatic resubmission occurs."
                      : ["queued", "running"].includes(job.state)
                        ? "The command is durable and pending. Records and files are not assumed ready."
                        : "The operation did not complete successfully. Review the server error before starting new work."}
                </p>
                {job.error && (
                  <div className="error">
                    {job.error.title}
                    {job.error.detail ? ` — ${job.error.detail}` : ""}
                  </div>
                )}
                {jobError && (
                  <div className="error" role="alert">
                    {jobError}
                  </div>
                )}
                <span className="operation-meta">
                  Created {when(job.createdAt)} · {job.id}
                </span>
                {job.resultUrl && job.state === "succeeded" && !stale && (
                  <Button
                    variant="secondary"
                    disabled={working || !online || !canExport}
                    onClick={() => void download(job)}
                  >
                    <ArrowDownToLine size={17} />
                    Download CSV
                  </Button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty icon={<FileSpreadsheet size={30} />} title="No operations in this tab">
            Import commits and export requests appear here after a server acknowledgment. File and job state
            are not persisted on this device.
          </Empty>
        )}
        <p className="operation-footnote">
          {canReadJobs
            ? "Pending jobs refresh while this page is visible and online."
            : "Your role cannot poll jobs; only returned acceptance states are shown."}{" "}
          Returning to this page starts a new in-memory view.
        </p>
      </section>
    </section>
  );
}
