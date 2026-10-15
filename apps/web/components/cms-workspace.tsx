"use client";

import { FileText, FlaskConical, Layers3, RefreshCw, WifiOff } from "lucide-react";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { browserDocumentVersion, copyBrowserJson, requireBrowserShape } from "../../../packages/cms/browser";
import { requireRevisionRecovery } from "../../../packages/cms/recovery";
import contract from "../../../packages/contracts/openapi.json";
import revisionHistorySchema from "../../../packages/contracts/internal/native-cms-revision-history-v1.schema.json";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { CmsDraftController } from "../features/cms/draft-controller";
import type { CmsDraftClient } from "../features/cms/draft-controller";
import { CmsDraftEditor } from "../features/cms/draft-editor";
import { CmsSiteManagement } from "../features/cms/site-management";
import { CmsDocumentPublication } from "../features/cms/document-publication";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import styles from "./cms-workspace.module.css";

export type CmsWorkspaceProps = {
  session: Schema<"Session">;
  csrf: string;
  online: boolean;
  syntheticFeaturesEnabled: boolean;
  accessRevision: number;
  onDirty(value: boolean): void;
  onAccessRevoked?(): void;
};
type Collection = "sites" | "templates" | "profiles";
type CreateAttempt = { context: string; key: string } & (
  | { kind: "site"; body: Schema<"SiteWrite"> }
  | { kind: "document"; siteId: string; body: Schema<"DocumentWrite"> }
);
const emptyHistory: Schema<"PageRevision"> = { items: [], nextCursor: null, hasMore: false };
export type CmsRevisionMetadata = Pick<
  Schema<"Revision">,
  "id" | "documentId" | "schemaVersion" | "createdAt"
>;
export type CmsRevisionHistory = Pick<Schema<"PageRevision">, "hasMore" | "nextCursor"> & {
  items: CmsRevisionMetadata[];
};
const emptyRevisionIndex: CmsRevisionHistory = { items: [], nextCursor: null, hasMore: false };
const historyByteLimit = 64 * 1024;
const recoveryByteLimit = 1024 * 1024;
const emptyFlags = { sites: false, templates: false, profiles: false };
const emptyMessages = { sites: "", templates: "", profiles: "" };
const emptyCursors = { sites: null, templates: null, profiles: null } as Record<Collection, string | null>;
const documentKinds = [
  "page",
  "landing",
  "blog",
  "community",
  "agent",
  "testimonial",
] as const satisfies readonly Schema<"DocumentWrite">["kind"][];
const idleSnapshot = () => null;
const idleSubscribe = () => () => {};
const uncertain = (error: unknown) =>
  !(error instanceof ApiError) || error.status >= 500 || error.status === 408;
type PageName = "PageSite" | "PageTemplate" | "PageBusinessProfile" | "PageDocument" | "PageRevision";
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
ajv.addSchema({ $id: "estate:cms-workspace", components: contract.components });
const pageValidators = new Map(
  (["PageSite", "PageTemplate", "PageBusinessProfile", "PageDocument", "PageRevision"] as const).map(
    (name) => [name, ajv.compile({ $ref: `estate:cms-workspace#/components/schemas/${name}` })],
  ),
);
const historyValidator = ajv.compile(revisionHistorySchema);
const problemCodeValidator = ajv.compile(contract.components.schemas.Problem.properties.code);

/** The approved metadata index is separate from the frozen content-bearing PageRevision. */
export function requireCmsRevisionHistory(value: unknown, documentId: string): CmsRevisionHistory {
  const detached = copyBrowserJson(value);
  if (
    new TextEncoder().encode(JSON.stringify(detached)).byteLength > historyByteLimit ||
    !historyValidator(detached)
  )
    throw new Error(
      "The revision index exceeds its limits or could not be verified. No metadata was changed.",
    );
  const response = detached as CmsRevisionHistory;
  const ids = new Set<string>();
  for (const item of response.items) {
    const identity = item.id.toLowerCase();
    if (item.documentId !== documentId || ids.has(identity))
      throw new Error("The revision index contains a mismatched document or repeated revision identity.");
    ids.add(identity);
  }
  return response;
}

/** Immutable revision IDs may repeat across pages; their metadata must not change. */
export function mergeCmsRevisionMetadata(
  previous: CmsRevisionMetadata[],
  next: CmsRevisionMetadata[],
): CmsRevisionMetadata[] {
  const byId = new Map(previous.map((item) => [item.id.toLowerCase(), item]));
  for (const item of next) {
    const identity = item.id.toLowerCase();
    const old = byId.get(identity);
    if (
      old &&
      (old.id !== item.id ||
        old.documentId !== item.documentId ||
        old.schemaVersion !== item.schemaVersion ||
        old.createdAt !== item.createdAt)
    )
      throw new Error("An immutable revision's metadata changed. Refresh the index before continuing.");
    if (!old) byId.set(identity, item);
  }
  return [...byId.values()];
}

/** Bound the actual UTF-8 transport before parsing, including whitespace and malformed UTF-8. */
async function readBoundedCmsJsonResponse(
  response: Response,
  maxBytes: number,
  label: string,
  limitDescription: string,
): Promise<unknown> {
  // Problem responses contain no original content and need no larger recovery allowance.
  const byteLimit = response.ok ? maxBytes : Math.min(maxBytes, historyByteLimit);
  const reader = response.body?.getReader();
  if (!reader) {
    if (!response.ok) throw new ApiError(response.status, `The ${label} could not be read.`);
    throw new Error(`The ${label} response is unavailable.`);
  }
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > byteLimit) {
        await reader.cancel();
        throw new Error(`The ${label} exceeds its ${limitDescription} transport limit.`);
      }
      chunks.push(result.value);
    }
  } catch (failure) {
    if (!response.ok) throw new ApiError(response.status, `The ${label} could not be read.`);
    throw failure;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    if (!response.ok) throw new ApiError(response.status, `The ${label} could not be read.`);
    throw new Error(`The ${label} is not valid UTF-8 JSON.`);
  }
  if (!response.ok) {
    const code =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "code") &&
      "code" in value &&
      typeof value.code === "string" &&
      problemCodeValidator(value.code)
        ? value.code
        : undefined;
    throw new ApiError(response.status, `The ${label} could not be read. Verify access or try again.`, code);
  }
  return value;
}

export async function readCmsRevisionHistoryResponse(
  response: Response,
  documentId: string,
): Promise<CmsRevisionHistory> {
  return requireCmsRevisionHistory(
    await readBoundedCmsJsonResponse(response, historyByteLimit, "revision index", "64 KiB"),
    documentId,
  );
}

/** Recovery preserves original JSON only after both transport bounds and the shared closed reader pass. */
export async function readCmsRevisionRecoveryResponse(
  response: Response,
  metadata: CmsRevisionMetadata,
): Promise<ReturnType<typeof requireRevisionRecovery>> {
  const value = requireRevisionRecovery(
    await readBoundedCmsJsonResponse(response, recoveryByteLimit, "original recovery", "1 MiB"),
  );
  if (
    value.id !== metadata.id ||
    value.documentId !== metadata.documentId ||
    value.data.schemaVersion !== metadata.schemaVersion
  )
    throw new Error("Original recovery does not match the explicitly selected revision metadata.");
  return value;
}

/** Metadata does not turn future content into an editable Revision or bypass the controller's draft lock. */
export function applyCmsRevisionResponse(
  controller: CmsDraftController,
  metadata: CmsRevisionMetadata,
  value: unknown,
  recovery: boolean,
): void {
  if (!controller.getSnapshot().online || controller.getSnapshot().phase === "denied")
    throw new Error("Connect and verify the original document context before reading its revision.");
  if (metadata.documentId !== controller.getSnapshot().document.id)
    throw new Error("Revision metadata does not match the selected document.");
  if (recovery) {
    const response = requireRevisionRecovery(value);
    if (
      response.id !== metadata.id ||
      response.documentId !== metadata.documentId ||
      response.data.schemaVersion !== metadata.schemaVersion
    )
      throw new Error("Original recovery does not match the explicitly selected revision metadata.");
    if (!controller.openRecoveryResponse(metadata.id, response))
      throw new Error("The editor is protected. Original recovery did not replace its current work.");
    return;
  }
  const revision = requireBrowserShape<Schema<"Revision">>("Revision", value as Schema<"Revision">);
  if (
    revision.id !== metadata.id ||
    revision.documentId !== metadata.documentId ||
    revision.schemaVersion !== metadata.schemaVersion
  )
    throw new Error("Content does not match the explicitly selected revision metadata.");
  if (!controller.selectRevision(revision))
    throw new Error("The editor is protected. The revision did not replace its current work.");
}

/** Superseded success and failure both belong to the old request, including definite access denials. */
export async function readCmsSelectedRevision(options: {
  controller: CmsDraftController;
  metadata: CmsRevisionMetadata;
  recovery: boolean;
  read(): Promise<unknown>;
  isCurrent(): boolean;
}): Promise<"loaded" | "recovery_required" | "superseded"> {
  if (!options.isCurrent()) return "superseded";
  try {
    const value = await options.read();
    if (!options.isCurrent()) return "superseded";
    applyCmsRevisionResponse(options.controller, options.metadata, value, options.recovery);
    return "loaded";
  } catch (failure) {
    if (!options.isCurrent()) return "superseded";
    if (
      !options.recovery &&
      failure instanceof ApiError &&
      failure.status === 409 &&
      failure.code === "revision_recovery_required"
    )
      return "recovery_required";
    throw failure;
  }
}

type RevisionHistoryControlsProps = {
  history: CmsRevisionHistory;
  loaded: boolean;
  online: boolean;
  locked: boolean;
  loading: boolean;
  reading: boolean;
  selectedId: string;
  recoveryRequired: boolean;
  error: string;
  onSelect(id: string): void;
  onRead(): void;
  onRecover(): void;
  onRefresh(): void;
  onMore(cursor: string): void;
};
/** Metadata alone never authorizes editing, selects the newest revision, or exposes original JSON. */
export function CmsRevisionHistoryControls({
  history,
  loaded,
  online,
  locked,
  loading,
  reading,
  selectedId,
  recoveryRequired,
  error,
  onSelect,
  onRead,
  onRecover,
  onRefresh,
  onMore,
}: RevisionHistoryControlsProps) {
  const disabled = !online || locked || reading;
  const items = online ? history.items : [];
  const selected = items.find((item) => item.id === selectedId);
  return (
    <section aria-label="Authorized revision index" className={styles.revisionIndex}>
      <div className={styles.heading}>
        <p>
          <FileText size={18} aria-hidden="true" /> Explicit revision history
        </p>
        <Button variant="secondary" disabled={!online || loading || reading} onClick={onRefresh}>
          Refresh history
        </Button>
      </div>
      <p className={styles.help}>
        This index includes supported and unsupported revisions. Its ID order does not identify the latest
        draft. Choose an exact revision, then read its content explicitly.
      </p>
      {!online ? (
        <p role="status">
          Revision metadata and original recovery JSON are cleared while offline. Reconnect and refresh
          history before selecting a revision.
        </p>
      ) : (
        <>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {loading && <p role="status">Reading authorized revision metadata…</p>}
          {loaded && !items.length && <p>No revisions are present in this index read.</p>}
          <label>
            Revision from the authorized index
            <select
              value={selected?.id ?? ""}
              disabled={disabled || loading || !items.length}
              onChange={(event) => onSelect(event.target.value)}
            >
              <option value="">Choose an explicit revision</option>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  Schema {item.schemaVersion} · {item.createdAt} · {item.id}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.actions}>
            <Button variant="secondary" disabled={disabled || !selected} onClick={onRead}>
              Read selected revision
            </Button>
            {history.hasMore && history.nextCursor && (
              <Button
                variant="secondary"
                disabled={loading || reading}
                onClick={() => onMore(history.nextCursor!)}
              >
                Load more revision metadata
              </Button>
            )}
          </div>
          {reading && <p role="status">Reading the explicitly selected revision…</p>}
          {recoveryRequired && selected && (
            <div className={styles.warning}>
              <div>
                <p>
                  This revision cannot be read by the supported editor. Its original JSON is available only
                  through a separate authorized, read-only recovery read. Recovery cannot save or publish.
                </p>
                <Button variant="secondary" disabled={disabled} onClick={onRecover}>
                  Read original JSON in recovery
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
function page<T>(
  name: PageName,
  value: { items: T[]; nextCursor: string | null; hasMore: boolean },
  inspect: (item: T) => T,
) {
  if (!pageValidators.get(name)!(value) || (value.hasMore && !value.nextCursor))
    throw new Error("The response could not be verified. Previously read data is retained and may be stale.");
  return { ...value, items: value.items.map(inspect) };
}
function merge<T>(previous: T[], next: T[], identify: (item: T) => string) {
  return [...new Map([...previous, ...next].map((item) => [identify(item), item])).values()];
}

/** Private, synthetic draft work only. The root owns navigation and service-worker draft protection. */
export default function CmsWorkspace({
  session,
  csrf,
  online,
  syntheticFeaturesEnabled,
  accessRevision,
  onDirty,
  onAccessRevoked,
}: CmsWorkspaceProps) {
  const context = JSON.stringify([
    session.userId,
    session.activeOrgId,
    accessRevision,
    [...session.permissions].sort(),
    syntheticFeaturesEnabled,
  ]);
  const has = (permission: string) => session.permissions.includes(permission);
  const enabled = syntheticFeaturesEnabled && Boolean(session.activeOrgId);
  const [deniedContext, setDeniedContext] = useState<string | null>(null);
  const denied = deniedContext === context;
  const available = enabled && !denied;
  const canReadSites = has("sites.read");
  const canReadContent = has("content.read");
  const canWriteContent = has("content.write");
  const canWriteSites = has("sites.write");
  const canReadProfiles = has("profiles.read");
  const canManageDomains = has("domains.manage");
  const canWriteMedia = has("media.write");
  const canWriteForms = has("forms.write");
  const canPublishContent = has("content.publish");
  const base = `/v1/orgs/${session.activeOrgId}`;
  const [dataContext, setDataContext] = useState(context);
  const [sites, setSites] = useState<Schema<"Site">[]>([]);
  const [templates, setTemplates] = useState<Schema<"Template">[]>([]);
  const [profiles, setProfiles] = useState<Schema<"BusinessProfile">[]>([]);
  const [loaded, setLoaded] = useState(emptyFlags);
  const [loading, setLoading] = useState(emptyFlags);
  const [errors, setErrors] = useState(emptyMessages);
  const [cursors, setCursors] = useState(emptyCursors);
  const [siteId, setSiteId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [documents, setDocuments] = useState<Schema<"Document">[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [documentCursor, setDocumentCursor] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [controller, setController] = useState<CmsDraftController | null>(null);
  const [history, setHistory] = useState(emptyRevisionIndex);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [selectedRevisionId, setSelectedRevisionId] = useState("");
  const [recoveryRevisionId, setRecoveryRevisionId] = useState("");
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [historyBinding, setHistoryBinding] = useState("");
  const [contentReadCsrf, setContentReadCsrf] = useState("");
  const [form, setForm] = useState<"site" | "document" | null>(null);
  const [siteName, setSiteName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [templateCode, setTemplateCode] = useState("");
  const [documentTitle, setDocumentTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [kind, setKind] = useState<Schema<"DocumentWrite">["kind"]>("page");
  const [formDirty, setFormDirty] = useState(false);
  const [attempt, setAttempt] = useState<CreateAttempt | null>(null);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [knownRejected, setKnownRejected] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorBinding, setEditorBinding] = useState("");
  const lifetime = useRef(0);
  const epochs = useRef({
    sites: 0,
    templates: 0,
    profiles: 0,
    documents: 0,
    editor: 0,
    history: 0,
    revision: 0,
  });
  const controllerRef = useRef<CmsDraftController | null>(null);
  const createSnapshot = useRef<CreateAttempt | null>(null);
  const inFlight = useRef(false);
  const revisionInFlight = useRef(false);
  const formDirtyRef = useRef(false);
  const callbacks = useRef({ onDirty, onAccessRevoked });
  callbacks.current = { onDirty, onAccessRevoked };
  const live = useRef({ context, csrf, online, available, siteId, documentId });
  live.current = { context, csrf, online, available, siteId, documentId };
  const state = useSyncExternalStore(
    controller?.subscribe ?? idleSubscribe,
    controller?.getSnapshot ?? idleSnapshot,
    controller?.getSnapshot ?? idleSnapshot,
  );
  const isProtected = useCallback(
    () =>
      formDirtyRef.current ||
      Boolean(createSnapshot.current) ||
      inFlight.current ||
      revisionInFlight.current ||
      Boolean(
        controllerRef.current &&
          (controllerRef.current.getSnapshot().dirty ||
            ["saving", "uncertain"].includes(controllerRef.current.getSnapshot().phase)),
      ),
    [],
  );
  const reportDirty = useCallback(() => callbacks.current.onDirty(isProtected()), [isProtected]);
  const protectedState =
    formDirty ||
    Boolean(attempt) ||
    working ||
    revisionLoading ||
    Boolean(state?.dirty) ||
    ["saving", "uncertain"].includes(state?.phase ?? "");
  const currentData = dataContext === context && available;
  const currentController =
    currentData && editorBinding === `${context}:${siteId}:${documentId}` ? controller : null;
  const metadataBinding = `${context}:${siteId}:${documentId}:${csrf}`;
  const currentHistory = online && historyBinding === metadataBinding ? history : emptyRevisionIndex;

  const clearPrivate = useCallback(() => {
    ++lifetime.current;
    for (const key of Object.keys(epochs.current) as (keyof typeof epochs.current)[]) ++epochs.current[key];
    const previousController = controllerRef.current;
    controllerRef.current = null;
    previousController?.revoke();
    createSnapshot.current = null;
    formDirtyRef.current = false;
    inFlight.current = false;
    revisionInFlight.current = false;
    setController(null);
    setEditorBinding("");
    setSites([]);
    setTemplates([]);
    setProfiles([]);
    setLoaded(emptyFlags);
    setLoading(emptyFlags);
    setErrors(emptyMessages);
    setCursors(emptyCursors);
    setSiteId("");
    setDocumentId("");
    setDocuments([]);
    setDocumentCursor(null);
    setDocumentsLoaded(false);
    setDocumentsLoading(false);
    setDocumentError("");
    setEditorLoading(false);
    setHistory(emptyRevisionIndex);
    setHistoryLoaded(false);
    setHistoryLoading(false);
    setHistoryError("");
    setSelectedRevisionId("");
    setRecoveryRevisionId("");
    setRevisionLoading(false);
    setHistoryBinding("");
    setContentReadCsrf("");
    setForm(null);
    setSiteName("");
    setProfileId("");
    setTemplateCode("");
    setDocumentTitle("");
    setSlug("");
    setKind("page");
    setFormDirty(false);
    setAttempt(null);
    setOutcomeUnknown(false);
    setKnownRejected(false);
    setWorking(false);
    setError("");
    setNotice("");
    callbacks.current.onDirty(false);
  }, []);
  const fail = useCallback(
    (failure: unknown) => {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        live.current.available = false;
        clearPrivate();
        setDeniedContext(live.current.context);
        callbacks.current.onAccessRevoked?.();
      }
      return failure instanceof Error
        ? failure.message
        : "CMS is unavailable. Keep the original request for recovery.";
    },
    [clearPrivate],
  );
  useEffect(() => {
    clearPrivate();
    setDataContext(context);
    return () => clearPrivate();
  }, [context, clearPrivate]);
  useEffect(() => {
    if (!controller) return;
    controller.setOnline(online);
  }, [controller, online]);
  useEffect(() => {
    if (online) return;
    ++epochs.current.history;
    ++epochs.current.revision;
    revisionInFlight.current = false;
    setHistory(emptyRevisionIndex);
    setHistoryLoaded(false);
    setHistoryLoading(false);
    setHistoryError("");
    setSelectedRevisionId("");
    setRecoveryRevisionId("");
    setRevisionLoading(false);
    setHistoryBinding("");
    reportDirty();
  }, [online, reportDirty]);
  const previousCsrf = useRef(csrf);
  useEffect(() => {
    if (previousCsrf.current === csrf) return;
    previousCsrf.current = csrf;
    ++epochs.current.history;
    ++epochs.current.revision;
    revisionInFlight.current = false;
    setHistory(emptyRevisionIndex);
    setHistoryBinding("");
    setHistoryLoaded(false);
    setHistoryLoading(false);
    setHistoryError("");
    setSelectedRevisionId("");
    setRecoveryRevisionId("");
    setRevisionLoading(false);
    // Re-verification clears read-only recovery, without replacing a draft or uncertain save command.
    if (controllerRef.current?.getSnapshot().recovery) {
      controllerRef.current.setOnline(false);
      controllerRef.current.setOnline(live.current.online);
    }
    reportDirty();
  }, [csrf, reportDirty]);
  useEffect(() => {
    if (!controller) return;
    const unsubscribe = controller.subscribe(() => {
      if (controllerRef.current !== controller) return;
      reportDirty();
      if (controller.getSnapshot().phase === "denied") {
        // Includes actual missing/ineligible document or capability denial from the editor client.
        live.current.available = false;
        clearPrivate();
        setDeniedContext(live.current.context);
        callbacks.current.onAccessRevoked?.();
      }
    });
    return unsubscribe;
  }, [controller, clearPrivate, reportDirty]);
  useEffect(() => {
    reportDirty();
  }, [protectedState, reportDirty]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (isProtected()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [isProtected]);

  const loadCollection = useCallback(
    async (collection: Collection, cursor?: string | null) => {
      if (!live.current.available || !live.current.online || live.current.context !== context) return;
      if ((collection === "sites" && !canReadSites) || (collection === "profiles" && !canReadProfiles))
        return;
      const epoch = ++epochs.current[collection];
      setLoading((old) => ({ ...old, [collection]: true }));
      setErrors((old) => ({ ...old, [collection]: "" }));
      const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
      try {
        if (collection === "sites") {
          const response = page(
            "PageSite",
            (await api<Schema<"PageSite">>(`${base}/sites?${query}`)).data,
            (item) => requireBrowserShape("Site", item),
          );
          if (
            live.current.context !== context ||
            epochs.current[collection] !== epoch ||
            !live.current.available
          )
            return;
          setSites((old) => (cursor ? merge(old, response.items, (item) => item.id) : response.items));
          setCursors((old) => ({ ...old, sites: response.nextCursor }));
        } else if (collection === "templates") {
          const response = page(
            "PageTemplate",
            (await api<Schema<"PageTemplate">>(`/v1/templates?${query}`)).data,
            (item) => item,
          );
          if (
            live.current.context !== context ||
            epochs.current[collection] !== epoch ||
            !live.current.available
          )
            return;
          setTemplates((old) =>
            cursor ? merge(old, response.items, (item) => `${item.code}@${item.version}`) : response.items,
          );
          setCursors((old) => ({ ...old, templates: response.nextCursor }));
        } else {
          const response = page(
            "PageBusinessProfile",
            (await api<Schema<"PageBusinessProfile">>(`${base}/business-profiles?${query}`)).data,
            (item) => item,
          );
          if (
            live.current.context !== context ||
            epochs.current[collection] !== epoch ||
            !live.current.available
          )
            return;
          setProfiles((old) => (cursor ? merge(old, response.items, (item) => item.id) : response.items));
          setCursors((old) => ({ ...old, profiles: response.nextCursor }));
        }
        setLoaded((old) => ({ ...old, [collection]: true }));
      } catch (failure) {
        if (live.current.context === context && epochs.current[collection] === epoch) {
          const message = fail(failure);
          setErrors((old) => ({ ...old, [collection]: message }));
        }
      } finally {
        if (live.current.context === context && epochs.current[collection] === epoch)
          setLoading((old) => ({ ...old, [collection]: false }));
      }
    },
    [context, base, canReadSites, canReadProfiles, fail],
  );
  useEffect(() => {
    if (!available || !online || isProtected()) return;
    void loadCollection("sites");
    void loadCollection("templates");
    void loadCollection("profiles");
  }, [available, online, context, loadCollection, isProtected]);

  const loadDocuments = useCallback(
    async (selectedSite: string, cursor?: string | null) => {
      if (
        !live.current.available ||
        !live.current.online ||
        live.current.context !== context ||
        live.current.siteId !== selectedSite ||
        !canReadContent
      )
        return;
      const epoch = ++epochs.current.documents;
      setDocumentsLoading(true);
      setDocumentError("");
      try {
        const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
        const response = page(
          "PageDocument",
          (await api<Schema<"PageDocument">>(`${base}/sites/${selectedSite}/documents?${query}`)).data,
          (item) => {
            const document = requireBrowserShape("Document", item);
            if (document.siteId !== selectedSite)
              throw new Error("Document history belongs to a different site.");
            return document;
          },
        );
        if (
          live.current.context !== context ||
          live.current.siteId !== selectedSite ||
          epochs.current.documents !== epoch ||
          !live.current.available
        )
          return;
        setDocuments((old) => (cursor ? merge(old, response.items, (item) => item.id) : response.items));
        setDocumentCursor(response.nextCursor);
        setDocumentsLoaded(true);
      } catch (failure) {
        if (
          live.current.context === context &&
          live.current.siteId === selectedSite &&
          epochs.current.documents === epoch
        )
          setDocumentError(fail(failure));
      } finally {
        if (live.current.context === context && epochs.current.documents === epoch)
          setDocumentsLoading(false);
      }
    },
    [context, base, canReadContent, fail],
  );
  const loadHistory = useCallback(
    async (selectedDocument: string, cursor?: string | null) => {
      if (
        !live.current.available ||
        !live.current.online ||
        live.current.context !== context ||
        live.current.documentId !== selectedDocument ||
        !canReadContent
      )
        return;
      const epoch = ++epochs.current.history;
      const generation = lifetime.current;
      const currentCsrf = live.current.csrf;
      const selectedSite = live.current.siteId;
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
        const response = await readCmsRevisionHistoryResponse(
          await fetch(
            `/api/dev/orgs/${session.activeOrgId}/cms/documents/${selectedDocument}/revision-history?${query}`,
            {
              credentials: "same-origin",
              cache: "no-store",
            },
          ),
          selectedDocument,
        );
        if (
          live.current.context !== context ||
          live.current.documentId !== selectedDocument ||
          live.current.siteId !== selectedSite ||
          live.current.csrf !== currentCsrf ||
          lifetime.current !== generation ||
          epochs.current.history !== epoch ||
          !live.current.available ||
          !live.current.online
        )
          return;
        // Verify the immutable merge before committing any new page or cursor.
        const items = cursor ? mergeCmsRevisionMetadata(history.items, response.items) : response.items;
        setHistory({
          ...response,
          items,
        });
        setHistoryBinding(`${context}:${selectedSite}:${selectedDocument}:${currentCsrf}`);
        setHistoryLoaded(true);
      } catch (failure) {
        if (
          live.current.context === context &&
          live.current.documentId === selectedDocument &&
          live.current.csrf === currentCsrf &&
          lifetime.current === generation &&
          live.current.online &&
          epochs.current.history === epoch
        ) {
          setHistoryError(fail(failure));
        }
      } finally {
        if (live.current.context === context && epochs.current.history === epoch) setHistoryLoading(false);
      }
    },
    [context, session.activeOrgId, canReadContent, history.items, fail],
  );

  function chooseSite(value: string) {
    if (isProtected()) return;
    const previousController = controllerRef.current;
    controllerRef.current = null;
    previousController?.revoke();
    setController(null);
    setEditorBinding("");
    ++epochs.current.editor;
    ++epochs.current.documents;
    ++epochs.current.history;
    live.current.siteId = value;
    live.current.documentId = "";
    setSiteId(value);
    setDocumentId("");
    setDocuments([]);
    setDocumentsLoaded(false);
    setDocumentCursor(null);
    setDocumentError("");
    setHistory(emptyRevisionIndex);
    setHistoryLoaded(false);
    setHistoryBinding("");
    setSelectedRevisionId("");
    setRecoveryRevisionId("");
    setContentReadCsrf("");
    ++epochs.current.revision;
    setHistoryError("");
    setHistoryLoading(false);
    setEditorLoading(false);
    if (value) void loadDocuments(value);
  }
  async function chooseDocument(value: string) {
    if (isProtected() || !live.current.online || !canReadContent) return;
    const previousController = controllerRef.current;
    controllerRef.current = null;
    previousController?.revoke();
    setController(null);
    setEditorBinding("");
    live.current.documentId = value;
    setDocumentId(value);
    setHistory(emptyRevisionIndex);
    setHistoryLoaded(false);
    setHistoryBinding("");
    setSelectedRevisionId("");
    setRecoveryRevisionId("");
    setContentReadCsrf("");
    ++epochs.current.revision;
    setHistoryError("");
    ++epochs.current.history;
    const epoch = ++epochs.current.editor,
      generation = lifetime.current,
      selectedSite = live.current.siteId;
    if (!value) return;
    setEditorLoading(true);
    setError("");
    const assertBinding = () => {
      if (
        !live.current.available ||
        live.current.context !== context ||
        lifetime.current !== generation ||
        live.current.siteId !== selectedSite ||
        live.current.documentId !== value
      )
        throw new ApiError(403, "The original CMS context is no longer available.");
      if (!live.current.online) throw new Error("Connect before saving or reconciling this document.");
    };
    const client: CmsDraftClient = {
      async readDocument() {
        assertBinding();
        const result = await api<Schema<"Document">>(`${base}/documents/${value}`);
        assertBinding();
        return { data: result.data, etag: result.headers.get("ETag") || "" };
      },
      async saveDraft(command) {
        assertBinding();
        if (command.documentId !== value) throw new ApiError(403, "The command belongs to another document.");
        const result = await api<Schema<"Revision">>(
          `/dev/orgs/${session.activeOrgId}/cms/documents/${value}/drafts`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": live.current.csrf,
              "Idempotency-Key": command.idempotencyKey,
              "If-Match": command.ifMatch,
            },
            body: JSON.stringify(command.body),
          },
        );
        assertBinding();
        return { data: result.data, etag: result.headers.get("ETag") || "" };
      },
    };
    try {
      const result = await client.readDocument();
      if (
        live.current.context !== context ||
        lifetime.current !== generation ||
        epochs.current.editor !== epoch
      )
        return;
      const document = requireBrowserShape("Document", result.data);
      if (
        document.id !== value ||
        document.siteId !== selectedSite ||
        browserDocumentVersion(result.etag) !== document.version
      )
        throw new Error("The document identity or version could not be verified.");
      const next = new CmsDraftController({
        document,
        etag: result.etag,
        client,
        policy: { approvedLinkOrigins: new Set() },
        online: live.current.online,
        canWrite: canWriteContent,
        createKey: () => crypto.randomUUID(),
      });
      controllerRef.current = next;
      setController(next);
      setEditorBinding(`${context}:${selectedSite}:${value}`);
      void loadHistory(value);
    } catch (failure) {
      if (
        live.current.context === context &&
        lifetime.current === generation &&
        epochs.current.editor === epoch
      )
        setError(fail(failure));
    } finally {
      if (live.current.context === context && epochs.current.editor === epoch) setEditorLoading(false);
    }
  }
  function chooseRevision(value: string) {
    if (isProtected() || !live.current.online || !live.current.available) return;
    if (value && !currentHistory.items.some((item) => item.id === value)) return;
    setSelectedRevisionId(value);
    setRecoveryRevisionId("");
    setHistoryError("");
  }
  async function readRevision(recovery = false) {
    const activeController = controllerRef.current;
    const metadata = currentHistory.items.find((item) => item.id === selectedRevisionId);
    if (
      !activeController ||
      activeController !== currentController ||
      !metadata ||
      isProtected() ||
      !live.current.available ||
      !live.current.online ||
      !canReadContent ||
      (recovery && recoveryRevisionId !== metadata.id)
    )
      return;
    const selectedDocument = live.current.documentId;
    const selectedSite = live.current.siteId;
    const currentCsrf = live.current.csrf;
    const generation = lifetime.current;
    const epoch = ++epochs.current.revision;
    const stillCurrent = () =>
      live.current.available &&
      live.current.online &&
      live.current.context === context &&
      live.current.documentId === selectedDocument &&
      live.current.siteId === selectedSite &&
      live.current.csrf === currentCsrf &&
      lifetime.current === generation &&
      epochs.current.revision === epoch &&
      controllerRef.current === activeController;
    revisionInFlight.current = true;
    setRevisionLoading(true);
    setHistoryError("");
    reportDirty();
    try {
      const outcome = await readCmsSelectedRevision({
        controller: activeController,
        metadata,
        recovery,
        read: async () => {
          if (!recovery) return (await api<Schema<"Revision">>(`${base}/revisions/${metadata.id}`)).data;
          return readCmsRevisionRecoveryResponse(
            await fetch(
              `/api/dev/orgs/${session.activeOrgId}/cms/documents/${selectedDocument}/revisions/${metadata.id}/recovery`,
              { credentials: "same-origin", cache: "no-store" },
            ),
            metadata,
          );
        },
        isCurrent: stillCurrent,
      });
      if (outcome === "superseded") return;
      if (outcome === "recovery_required") {
        setRecoveryRevisionId(metadata.id);
        setHistoryError(
          "This exact revision requires read-only recovery. No draft was replaced or content discarded.",
        );
      } else {
        if (!recovery) setRecoveryRevisionId("");
        setContentReadCsrf(currentCsrf);
      }
    } catch (failure) {
      if (stillCurrent()) setHistoryError(fail(failure));
    } finally {
      if (epochs.current.revision === epoch && lifetime.current === generation) {
        revisionInFlight.current = false;
        setRevisionLoading(false);
        reportDirty();
      }
    }
  }
  function changeForm(change: () => void) {
    if (createSnapshot.current || inFlight.current || !live.current.online) return;
    change();
    formDirtyRef.current = true;
    setFormDirty(true);
    reportDirty();
  }
  function discardForm() {
    if (outcomeUnknown || inFlight.current) return;
    if (formDirtyRef.current && !window.confirm("Discard this unsaved CMS creation request?")) return;
    createSnapshot.current = null;
    formDirtyRef.current = false;
    setAttempt(null);
    setKnownRejected(false);
    setFormDirty(false);
    setForm(null);
    setSiteName("");
    setProfileId("");
    setTemplateCode("");
    setDocumentTitle("");
    setSlug("");
    setKind("page");
    setError("");
    reportDirty();
  }
  async function create(event?: FormEvent) {
    event?.preventDefault();
    if (!live.current.available || !live.current.online || inFlight.current || !form || !csrf) return;
    let snapshot = createSnapshot.current;
    if (!snapshot) {
      if (form === "site") {
        if (
          !canWriteSites ||
          !siteName.trim() ||
          !profiles.some((item) => item.id === profileId) ||
          !templates.some((item) => item.code === templateCode)
        ) {
          setError("Enter a name and choose an authorized business profile and current catalogue template.");
          return;
        }
        snapshot = {
          kind: "site",
          context,
          key: crypto.randomUUID(),
          body: { name: siteName.trim(), businessProfileId: profileId, templateCode },
        };
      } else {
        if (
          !canWriteContent ||
          !siteId ||
          !documentTitle.trim() ||
          slug.length > 160 ||
          !slug.split("/").every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment))
        ) {
          setError("Enter a title and a lowercase path with nonempty letter/number/hyphen segments.");
          return;
        }
        snapshot = {
          kind: "document",
          context,
          key: crypto.randomUUID(),
          siteId,
          body: { title: documentTitle.trim(), slug, kind },
        };
      }
      Object.freeze(snapshot.body);
      Object.freeze(snapshot);
      createSnapshot.current = snapshot;
      setAttempt(snapshot);
    }
    if (snapshot.context !== live.current.context) return;
    const generation = lifetime.current;
    inFlight.current = true;
    setWorking(true);
    reportDirty();
    setError("");
    setNotice("");
    setKnownRejected(false);
    try {
      const headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": live.current.csrf,
        "Idempotency-Key": snapshot.key,
      };
      if (snapshot.kind === "site") {
        const result = await api<Schema<"Site">>(`${base}/sites`, {
          method: "POST",
          headers,
          body: JSON.stringify(snapshot.body),
        });
        if (live.current.context !== context || lifetime.current !== generation) return;
        const created = requireBrowserShape("Site", result.data);
        if (
          created.name !== snapshot.body.name ||
          created.businessProfileId !== snapshot.body.businessProfileId ||
          browserDocumentVersion(result.headers.get("ETag") || "") !== created.version
        )
          throw new Error("The site creation receipt could not be verified; retain the original request.");
        setNotice(
          `Site ${created.id} creation acknowledged with template ${created.themeVersion}. Select the site explicitly after a current read; this historical receipt does not report its current publication state.`,
        );
      } else {
        const result = await api<Schema<"Document">>(`${base}/sites/${snapshot.siteId}/documents`, {
          method: "POST",
          headers,
          body: JSON.stringify(snapshot.body),
        });
        if (live.current.context !== context || lifetime.current !== generation) return;
        const created = requireBrowserShape("Document", result.data);
        if (
          created.siteId !== snapshot.siteId ||
          created.title !== snapshot.body.title ||
          created.slug !== snapshot.body.slug ||
          created.kind !== snapshot.body.kind ||
          browserDocumentVersion(result.headers.get("ETag") || "") !== created.version
        )
          throw new Error(
            "The document creation receipt could not be verified; retain the original request.",
          );
        setNotice(
          `Document ${created.id} creation acknowledged. Select it explicitly after a current read, then choose a revision or start a blank draft. No content or publication was created implicitly.`,
        );
      }
      createSnapshot.current = null;
      formDirtyRef.current = false;
      setAttempt(null);
      setOutcomeUnknown(false);
      setFormDirty(false);
      setForm(null);
      setSiteName("");
      setProfileId("");
      setTemplateCode("");
      setDocumentTitle("");
      setSlug("");
      setKind("page");
      if (snapshot.kind === "site") await loadCollection("sites");
      else await loadDocuments(snapshot.siteId);
    } catch (failure) {
      if (live.current.context === context && lifetime.current === generation) {
        setOutcomeUnknown(uncertain(failure));
        setKnownRejected(!uncertain(failure));
        setError(fail(failure));
      }
    } finally {
      if (lifetime.current === generation) {
        inFlight.current = false;
        setWorking(false);
        reportDirty();
      }
    }
  }

  if (!enabled)
    return (
      <Empty icon={<Layers3 size={30} />} title="Synthetic CMS unavailable">
        Choose an organization in an explicitly enabled synthetic session.
      </Empty>
    );
  if (denied)
    return (
      <Empty icon={<Layers3 size={30} />} title="CMS access unavailable">
        Private editor memory was cleared after access denial. Return to the workspace to verify access.
      </Empty>
    );
  if (!currentData)
    return (
      <Empty icon={<Layers3 size={30} />} title="Verifying CMS context">
        Previous private editor data is unavailable in this context.
      </Empty>
    );
  return (
    <section className={styles.workspace} aria-label="Synthetic website drafts">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Private content studio</p>
          <h2>Website drafts</h2>
          <p>Choose a site, a document and an explicit revision.</p>
        </div>
        <Badge tone="warning">Synthetic · private drafts</Badge>
      </header>
      <div className={styles.notice}>
        <FlaskConical size={22} aria-hidden="true" />
        <p>
          This editor saves immutable private draft revisions. Publication, public preview and Puck are
          unavailable in this slice. Domain management, media library and form catalogue are available when
          the corresponding permissions are present. Links use local paths only.
        </p>
      </div>
      {!online && (
        <p className={styles.warning} role="status">
          <WifiOff size={20} aria-hidden="true" /> Offline. Existing draft fields remain in memory; server
          writes and reconciliation are disabled.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.success} role="status">
          {notice}
        </p>
      )}
      {protectedState && (
        <p className={styles.warning} role="status">
          Resolve or explicitly discard the current draft before changing site or document. An uncertain
          command must be retried with its original input and key.
        </p>
      )}
      <section className={styles.card} aria-labelledby="cms-selection-title">
        <div className={styles.heading}>
          <h3 id="cms-selection-title">Your site and document</h3>
          <Button
            variant="secondary"
            disabled={!online || protectedState || Object.values(loading).some(Boolean)}
            onClick={() => {
              void loadCollection("sites");
              void loadCollection("templates");
              void loadCollection("profiles");
            }}
          >
            <RefreshCw size={16} /> Refresh catalogue
          </Button>
        </div>
        {!canReadSites && <p>Site read permission is unavailable in this session.</p>}
        {errors.sites && (
          <p className={styles.error} role="alert">
            {errors.sites}
          </p>
        )}
        <div className={styles.fields}>
          <label>
            Site
            <select
              value={currentData ? siteId : ""}
              disabled={!online || !canReadSites || loading.sites || protectedState || !currentData}
              onChange={(event) => chooseSite(event.target.value)}
            >
              <option value="">Choose a site</option>
              {currentData &&
                sites.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!["draft", "published"].includes(item.state)}
                  >
                    {item.name} · {item.themeVersion} · {item.state}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Document
            <select
              value={currentData ? documentId : ""}
              disabled={
                !online ||
                !siteId ||
                !canReadContent ||
                documentsLoading ||
                editorLoading ||
                protectedState ||
                !currentData
              }
              onChange={(event) => void chooseDocument(event.target.value)}
            >
              <option value="">Choose a document</option>
              {currentData &&
                documents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · /{item.slug} · {item.kind}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {loading.sites ? (
          <p role="status">Reading authorized sites…</p>
        ) : loaded.sites && currentData && !sites.length ? (
          <p>No sites were returned by the authorized read.</p>
        ) : (
          !loaded.sites && <p>Site metadata has not been read.</p>
        )}
        {siteId && !canReadContent && <p>Content read permission is required to list documents.</p>}
        {documentsLoading && <p role="status">Reading documents…</p>}
        {documentsLoaded && currentData && !documents.length && (
          <p>No documents were returned for the selected site.</p>
        )}
        {documentError && (
          <p className={styles.error} role="alert">
            {documentError} Previously read documents may be stale.
          </p>
        )}
        <div className={styles.actions}>
          {currentData &&
            sites.some(
              (site) =>
                site.id === siteId &&
                site.state === "published" &&
                /^las-vegas-idx-(agent|brokerage)@1[.]0[.]0$/.test(site.themeVersion),
            ) && (
              <a href={`/templates/las-vegas-idx/${siteId}`} target="_blank" rel="noopener noreferrer">
                View published IDX website
              </a>
            )}
          {cursors.sites && (
            <Button
              variant="secondary"
              disabled={!online || loading.sites || protectedState}
              onClick={() => void loadCollection("sites", cursors.sites)}
            >
              Load more sites
            </Button>
          )}
          {siteId && (
            <Button
              variant="secondary"
              disabled={!online || documentsLoading || protectedState || !canReadContent}
              onClick={() => void loadDocuments(siteId)}
            >
              Refresh documents
            </Button>
          )}
          {documentCursor && (
            <Button
              variant="secondary"
              disabled={!online || documentsLoading || protectedState}
              onClick={() => void loadDocuments(siteId, documentCursor)}
            >
              Load more documents
            </Button>
          )}
          {canWriteSites && (
            <Button
              variant="secondary"
              disabled={!online || protectedState || Boolean(form)}
              onClick={() => setForm("site")}
            >
              Create a site
            </Button>
          )}
          {canWriteContent && siteId && (
            <Button
              variant="secondary"
              disabled={!online || protectedState || Boolean(form)}
              onClick={() => setForm("document")}
            >
              Create a document
            </Button>
          )}
        </div>
      </section>
      {siteId && (canManageDomains || canWriteMedia || canWriteForms) && (
        <CmsSiteManagement
          siteId={siteId}
          base={base}
          csrf={csrf}
          online={online}
          canManageDomains={canManageDomains}
          canWriteMedia={canWriteMedia}
          canWriteForms={canWriteForms}
        />
      )}
      {documentId && canPublishContent && currentData && (
        <CmsDocumentPublication documentId={documentId} base={base} csrf={csrf} online={online} />
      )}
      {form && (
        <section className={styles.card} aria-labelledby="cms-create-title">
          <h3 id="cms-create-title">
            {form === "site" ? "Create a synthetic site" : "Create document metadata"}
          </h3>
          <p className={styles.help}>
            Creating metadata does not select a revision, start content or publish a website.
          </p>
          {outcomeUnknown && (
            <p className={styles.warning} role="status">
              Creation outcome is unknown. Input and the original command key are retained in this tab; retry
              exactly to reconcile.
            </p>
          )}
          <form onSubmit={(event) => void create(event)}>
            <fieldset disabled={!online || working || Boolean(attempt)}>
              <legend className={styles.srOnly}>CMS creation fields</legend>
              {form === "site" ? (
                <>
                  <label>
                    Site name
                    <input
                      required
                      maxLength={120}
                      value={siteName}
                      onChange={(event) => changeForm(() => setSiteName(event.target.value))}
                    />
                  </label>
                  <div className={styles.fields}>
                    <label>
                      Business profile
                      <select
                        required
                        value={profileId}
                        onChange={(event) => changeForm(() => setProfileId(event.target.value))}
                      >
                        <option value="">Choose an authorized profile</option>
                        {currentData &&
                          profiles.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Template
                      <select
                        required
                        value={templateCode}
                        onChange={(event) => changeForm(() => setTemplateCode(event.target.value))}
                      >
                        <option value="">Choose a catalogue template</option>
                        {currentData &&
                          templates.map((item) => (
                            <option key={`${item.code}@${item.version}`} value={item.code}>
                              {item.name} · {item.version} · {item.family}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  {!canReadProfiles && (
                    <p>
                      Business-profile read permission is unavailable. Ask an organization manager to prepare
                      the profile.
                    </p>
                  )}
                  {errors.profiles && <p role="alert">{errors.profiles}</p>}
                  {errors.templates && <p role="alert">{errors.templates}</p>}
                  <p className={styles.help}>
                    The server pins the current repository template version. Its returned theme version is
                    shown after acknowledgement. Catalogue metadata supplies no editable starter content.
                  </p>
                  <div className={styles.actions}>
                    {cursors.profiles && (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={loading.profiles}
                        onClick={() => void loadCollection("profiles", cursors.profiles)}
                      >
                        Load more profiles
                      </Button>
                    )}
                    {cursors.templates && (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={loading.templates}
                        onClick={() => void loadCollection("templates", cursors.templates)}
                      >
                        Load more templates
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <label>
                    Document title
                    <input
                      required
                      maxLength={200}
                      value={documentTitle}
                      onChange={(event) => changeForm(() => setDocumentTitle(event.target.value))}
                    />
                  </label>
                  <div className={styles.fields}>
                    <label>
                      Path without a leading slash
                      <input
                        required
                        maxLength={160}
                        pattern="[a-z0-9][a-z0-9/-]{0,159}"
                        autoCapitalize="none"
                        autoCorrect="off"
                        value={slug}
                        placeholder="about-us"
                        onChange={(event) => changeForm(() => setSlug(event.target.value))}
                      />
                    </label>
                    <label>
                      Document kind
                      <select
                        value={kind}
                        onChange={(event) =>
                          changeForm(() => setKind(event.target.value as Schema<"DocumentWrite">["kind"]))
                        }
                      >
                        {documentKinds.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              )}
            </fieldset>
            <div className={styles.actions}>
              <Button
                type="submit"
                disabled={
                  !online ||
                  working ||
                  knownRejected ||
                  (form === "site" && (!canReadProfiles || !loaded.templates || !loaded.profiles))
                }
              >
                {working
                  ? "Saving metadata…"
                  : attempt
                    ? "Retry original creation request"
                    : form === "site"
                      ? "Create synthetic site"
                      : "Create document"}
              </Button>
              {knownRejected && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!online || working}
                  onClick={() => {
                    createSnapshot.current = null;
                    setAttempt(null);
                    setKnownRejected(false);
                    setOutcomeUnknown(false);
                    reportDirty();
                  }}
                >
                  Edit rejected request
                </Button>
              )}
              <Button
                type="button"
                variant="quiet"
                disabled={working || outcomeUnknown}
                onClick={discardForm}
              >
                Discard creation request
              </Button>
            </div>
          </form>
        </section>
      )}
      {editorLoading && <p role="status">Reading the selected document and its exact version…</p>}
      {currentController && (
        <section className={styles.card}>
          <CmsRevisionHistoryControls
            history={currentHistory}
            loaded={historyLoaded && historyBinding === metadataBinding}
            online={online}
            locked={protectedState}
            loading={historyLoading}
            reading={revisionLoading}
            selectedId={selectedRevisionId}
            recoveryRequired={recoveryRevisionId === selectedRevisionId}
            error={historyError}
            onSelect={chooseRevision}
            onRead={() => void readRevision()}
            onRecover={() => void readRevision(true)}
            onRefresh={() => void loadHistory(documentId)}
            onMore={(cursor) => void loadHistory(documentId, cursor)}
          />
          {!online && state?.recovery ? (
            <p role="status">Original recovery JSON is unavailable offline.</p>
          ) : state?.recovery && contentReadCsrf !== csrf ? (
            <p role="status">Recovery access changed. Refresh history and read the original again.</p>
          ) : (
            <fieldset disabled={revisionLoading} aria-busy={revisionLoading}>
              <CmsDraftEditor
                controller={currentController}
                history={emptyHistory}
                historyLoading={false}
                historyError=""
                onLoadMore={() => {}}
                onDirty={reportDirty}
              />
            </fieldset>
          )}
        </section>
      )}
      {!currentController && !editorLoading && (
        <div className={styles.empty}>
          <Layers3 size={30} aria-hidden="true" />
          <p>Select a document explicitly to open its private revision editor.</p>
        </div>
      )}
    </section>
  );
}
