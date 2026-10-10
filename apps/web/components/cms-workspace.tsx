"use client";

import { FileText, FlaskConical, Layers3, RefreshCw, WifiOff } from "lucide-react";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { browserDocumentVersion, requireBrowserShape } from "../../../packages/cms/browser";
import contract from "../../../packages/contracts/openapi.json";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { CmsDraftController } from "../features/cms/draft-controller";
import type { CmsDraftClient } from "../features/cms/draft-controller";
import { CmsDraftEditor } from "../features/cms/draft-editor";
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
  const [history, setHistory] = useState(emptyHistory);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
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
  const epochs = useRef({ sites: 0, templates: 0, profiles: 0, documents: 0, editor: 0, history: 0 });
  const controllerRef = useRef<CmsDraftController | null>(null);
  const createSnapshot = useRef<CreateAttempt | null>(null);
  const inFlight = useRef(false);
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
    Boolean(state?.dirty) ||
    ["saving", "uncertain"].includes(state?.phase ?? "");
  const currentData = dataContext === context && available;
  const currentController =
    currentData && editorBinding === `${context}:${siteId}:${documentId}` ? controller : null;

  const clearPrivate = useCallback(() => {
    ++lifetime.current;
    for (const key of Object.keys(epochs.current) as (keyof typeof epochs.current)[]) ++epochs.current[key];
    const previousController = controllerRef.current;
    controllerRef.current = null;
    previousController?.revoke();
    createSnapshot.current = null;
    formDirtyRef.current = false;
    inFlight.current = false;
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
    setHistory(emptyHistory);
    setHistoryLoading(false);
    setHistoryError("");
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
        live.current.documentId !== selectedDocument
      )
        return;
      const epoch = ++epochs.current.history;
      setHistoryLoading(true);
      setHistoryError("");
      try {
        const query = new URLSearchParams({ limit: "25", ...(cursor ? { cursor } : {}) });
        const response = page(
          "PageRevision",
          (await api<Schema<"PageRevision">>(`${base}/documents/${selectedDocument}/revisions?${query}`))
            .data,
          (item) => {
            const revision = requireBrowserShape("Revision", item);
            if (revision.documentId !== selectedDocument)
              throw new Error("Revision history belongs to a different document.");
            return revision;
          },
        );
        if (
          live.current.context !== context ||
          live.current.documentId !== selectedDocument ||
          epochs.current.history !== epoch ||
          !live.current.available
        )
          return;
        setHistory((old) => ({
          ...response,
          items: cursor ? merge(old.items, response.items, (item) => item.id) : response.items,
        }));
      } catch (failure) {
        if (
          live.current.context === context &&
          live.current.documentId === selectedDocument &&
          epochs.current.history === epoch
        ) {
          setHistoryError(
            failure instanceof ApiError && failure.code === "revision_recovery_required"
              ? "Stored content requires an authorized recovery reader, which is unavailable. Existing history and draft fields are retained; no revision was dropped or truncated."
              : fail(failure),
          );
        }
      } finally {
        if (live.current.context === context && epochs.current.history === epoch) setHistoryLoading(false);
      }
    },
    [context, base, fail],
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
    setHistory(emptyHistory);
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
    setHistory(emptyHistory);
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
          This editor saves immutable private draft revisions. Publication, public preview, Puck, media,
          domains and forms are unavailable in this slice. Links use local paths only.
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
          <div className={styles.heading}>
            <p>
              <FileText size={18} aria-hidden="true" /> Explicit revision history
            </p>
            <Button
              variant="secondary"
              disabled={!online || historyLoading || working}
              onClick={() => void loadHistory(documentId)}
            >
              Refresh history
            </Button>
          </div>
          {historyError && (
            <p className={styles.error} role="alert">
              {historyError}
            </p>
          )}
          <CmsDraftEditor
            controller={currentController}
            history={history}
            historyLoading={historyLoading}
            historyError={historyError}
            onLoadMore={(cursor) => {
              if (!online)
                setHistoryError(
                  "Connect before reading additional history. Existing revisions stay only in this tab.",
                );
              else void loadHistory(documentId, cursor);
            }}
            onDirty={reportDirty}
          />
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
