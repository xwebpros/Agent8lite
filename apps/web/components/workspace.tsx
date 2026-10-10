"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock3,
  Download,
  FileSpreadsheet,
  House,
  Kanban,
  Layers3,
  LayoutDashboard,
  ListTodo,
  LogOut,
  Mail,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import SettingsAdmin from "./settings-admin";
import LeadTimeline from "./lead-timeline";
import VerifiedMetrics from "./verified-metrics";
import SupportPanel from "./support-panel";
import BillingPanel from "./billing-panel";
import DataTransfer from "./data-transfer";
import InvitationsPanel from "./invitations-panel";
import type { InvitationTransfer } from "./invitations-panel";
import WorkspaceRecords from "./workspace-records";
import DealsPanel from "./deals-panel";
import CrmConfiguration from "./crm-configuration";
import LeadTags from "./lead-tags";
import RoutingPanel from "./routing-panel";
import SyntheticCapture from "./synthetic-capture";
import ConsentPanel from "./consent-panel";
import { PropertiesFeature } from "../features/properties";
import CmsWorkspace from "./cms-workspace";
import CampaignWorkspace from "./campaign-workspace";
import NotificationCenter from "./notification-center";
import { safeNotificationHref } from "./notification-controller";
import AppointmentAgenda from "./appointment-agenda";
import TaskAgenda from "./task-agenda";
import { partitionLoadedTasks, resolveTaskDrawerTiming, validTaskAgendaTimezone } from "./task-agenda-time";
import { TaskCompletionProtocol, type TaskCompletionCommand } from "./task-completion";

type Session = Schema<"Session">;
type Contact = Schema<"Contact">;
type Lead = Schema<"Lead">;
type Task = Schema<"Task">;
type Stage = Schema<"PipelineStage">;
type Source = Schema<"LeadSource">;
type View =
  | "dashboard"
  | "contacts"
  | "pipeline"
  | "tasks"
  | "properties"
  | "websites"
  | "campaigns"
  | "notifications"
  | "settings";
type InstallEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
const navigation = [
  { id: "dashboard", name: "Dashboard", icon: LayoutDashboard },
  { id: "contacts", name: "Contacts", icon: Users },
  { id: "pipeline", name: "Pipeline", icon: Kanban },
  { id: "tasks", name: "Tasks", icon: ListTodo },
  { id: "properties", name: "Properties", icon: House },
  { id: "websites", name: "Websites", icon: Layers3 },
  { id: "campaigns", name: "Campaigns", icon: Mail },
  { id: "notifications", name: "Notifications", icon: Bell },
  { id: "settings", name: "Settings", icon: Settings2 },
] as const;
const emptyData = {
  contacts: [] as Contact[],
  leads: [] as Lead[],
  tasks: [] as Task[],
  stages: [] as Stage[],
  sources: [] as Source[],
  more: false,
};

function readableDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));
}
function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
function completionContext(
  active: Session | null,
  memberId: string,
  token: string,
  revision: number,
): string | null {
  return active?.activeOrgId &&
    memberId &&
    token &&
    active.permissions.includes("crm.tasks.read") &&
    active.permissions.includes("crm.tasks.write")
    ? JSON.stringify([
        active.userId,
        active.activeOrgId,
        memberId,
        token,
        revision,
        [...active.permissions].sort(),
      ])
    : null;
}

export default function Workspace({ syntheticFeaturesEnabled }: { syntheticFeaturesEnabled: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const query = useSearchParams();
  const detailKind = query.has("contact")
    ? "contact"
    : query.has("lead")
      ? "lead"
      : query.has("task")
        ? "task"
        : null;
  const detailId = detailKind ? query.get(detailKind) : null;
  const segment = pathname.split("/")[1] || "dashboard";
  const view: View = navigation.some((item) => item.id === segment) ? (segment as View) : "dashboard";
  const [session, setSession] = useState<Session | null>(null);
  const [syntheticIdentity, setSyntheticIdentity] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const [csrf, setCsrf] = useState("");
  const [member, setMember] = useState("");
  const [profileVersion, setProfileVersion] = useState<number | null>(null);
  const [booting, setBooting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [changingOrganization, setChangingOrganization] = useState(false);
  const [online, setOnline] = useState(true);
  const [data, setData] = useState(emptyData);
  const [refreshed, setRefreshed] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"lead" | "task" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [noteDirty, setNoteDirty] = useState(false);
  const [tagDirty, setTagDirty] = useState(false);
  const [cmsDirty, setCmsDirty] = useState(false);
  const cmsProtected = useRef(false);
  const [campaignDirty, setCampaignDirty] = useState(false);
  const campaignProtected = useRef(false);
  const [notificationPending, setNotificationPending] = useState(false);
  const notificationProtected = useRef(false);
  const [invitationTransfer, setInvitationTransfer] = useState<InvitationTransfer | null>(null);
  const taskCompletion = useRef(new TaskCompletionProtocol());
  const activeTaskCompletion = useRef<TaskCompletionCommand | null>(null);
  const [, updateTaskCompletion] = useState(0);
  const taskCompletionBinding = completionContext(session, member, csrf, accessRevision);
  const currentAccessRevision = useRef(accessRevision);
  currentAccessRevision.current = accessRevision;
  taskCompletion.current.bind(taskCompletionBinding);
  const taskPending = Boolean(taskCompletion.current.getSnapshot().command);
  const unsaved =
    dirty ||
    noteDirty ||
    tagDirty ||
    cmsDirty ||
    campaignDirty ||
    notificationPending ||
    taskPending ||
    Boolean(invitationTransfer);
  const [search, setSearch] = useState("");
  const [taskFilter, setTaskFilter] = useState("open");
  const [scope, setScope] = useState<"own" | "authorized">("own");
  const [cursors, setCursors] = useState({
    contacts: null as string | null,
    leads: null as string | null,
    tasks: null as string | null,
  });
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [ios, setIos] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [activatedUpdate, setActivatedUpdate] = useState(false);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const taskDrawerBaseline = useRef<{ task: Task; value: string } | null>(null);
  if (!selectedTask) taskDrawerBaseline.current = null;
  else if (taskDrawerBaseline.current?.task !== selectedTask)
    taskDrawerBaseline.current = { task: selectedTask, value: localDateTime(selectedTask.dueAt) };
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [invitationAcceptance, setInvitationAcceptance] = useState<{
    userId: string;
    job: Schema<"Job">;
  } | null>(null);
  const commandKeys = useRef(new Map<string, string>());
  const commandContext = useRef("");
  commandContext.current = `${session?.userId || ""}:${session?.activeOrgId || ""}:${member}`;
  const capturedContact = useRef<Contact | null>(null);
  const updateAccepted = useRef(false);
  const reloadProtected = useRef(false);
  reloadProtected.current =
    unsaved ||
    busy ||
    cmsProtected.current ||
    campaignProtected.current ||
    notificationProtected.current ||
    Boolean(taskCompletion.current.getSnapshot().command);
  const protectCms = useCallback((value: boolean) => {
    cmsProtected.current = value;
    if (value) reloadProtected.current = true;
    setCmsDirty(value);
  }, []);
  const protectCampaign = useCallback((value: boolean) => {
    campaignProtected.current = value;
    if (value) reloadProtected.current = true;
    setCampaignDirty(value);
  }, []);
  const protectNotification = useCallback((value: boolean) => {
    notificationProtected.current = value;
    if (value) reloadProtected.current = true;
    setNotificationPending(value);
  }, []);
  const dialog = useRef<HTMLDialogElement>(null);
  const detailDialog = useRef<HTMLDialogElement>(null);
  const refreshEpoch = useRef(0);
  const sessionEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const verifiedMember = useRef("");
  const retainedSession = useRef<Session | null>(null);
  const organization = session?.organizations.find((org) => org.id === session.activeOrgId);
  const timezone = session?.profile.timezone || "America/Los_Angeles";
  const permission = (name: string) => session?.permissions.includes(name) === true;
  const syntheticEnabled = syntheticFeaturesEnabled && syntheticIdentity && Boolean(session);
  const canCapture = permission("crm.contacts.write") && permission("crm.leads.write");
  const canTask = permission("crm.tasks.write");
  const taskAgendaContext = JSON.stringify([
    session?.userId,
    session?.activeOrgId,
    member,
    accessRevision,
    scope,
    session?.profile.timezone,
    organization?.timezone,
    Boolean(refreshed),
    session?.permissions,
  ]);
  const currentTaskAgenda = useRef(taskAgendaContext);
  currentTaskAgenda.current = taskAgendaContext;
  const visibleNavigation = navigation.filter((item) => {
    if (item.id === "properties") return syntheticEnabled && permission("mls.read");
    if (item.id === "websites")
      return syntheticEnabled && permission("sites.read") && permission("content.read");
    if (item.id === "campaigns") return syntheticEnabled && permission("campaigns.read");
    if (item.id === "notifications") return permission("self.notifications.read");
    return true;
  });
  const settingsPanel = [
    "device",
    "account",
    "billing",
    "support",
    "data",
    "workspace",
    "invitations",
    "crm",
    "routing",
    "consent",
  ].includes(query.get("panel") || "")
    ? query.get("panel")
    : "device";
  const dealsTab = view === "pipeline" && query.get("tab") === "deals";
  const captureTab = view === "pipeline" && query.get("tab") === "capture";
  const captureAllowed =
    syntheticEnabled &&
    [
      "crm.contacts.read",
      "crm.contacts.write",
      "crm.leads.read",
      "crm.leads.write",
      "crm.sources.read",
    ].every(permission);

  const refresh = useCallback(
    async (active: Session) => {
      if (!active.activeOrgId) return;
      const epoch = ++refreshEpoch.current;
      if (
        cmsProtected.current ||
        campaignProtected.current ||
        notificationProtected.current ||
        taskCompletion.current.getSnapshot().command
      ) {
        setLoading(false);
        return;
      }
      setLoading(true);
      const base = `/v1/orgs/${active.activeOrgId}`;
      const filter =
        scope === "own" && verifiedMember.current
          ? `&filter=${encodeURIComponent(JSON.stringify({ ownerMemberId: verifiedMember.current } satisfies Schema<"LeadFilter">))}`
          : "";
      try {
        const [contacts, leads, tasks, stages, sources] = await Promise.all([
          active.permissions.includes("crm.contacts.read")
            ? api<Schema<"PageContact">>(`${base}/contacts?limit=100${filter}`)
            : Promise.resolve({ data: { items: [] as Contact[], nextCursor: null, hasMore: false } }),
          active.permissions.includes("crm.leads.read")
            ? api<Schema<"PageLead">>(`${base}/leads?limit=100${filter}`)
            : Promise.resolve({ data: { items: [] as Lead[], nextCursor: null, hasMore: false } }),
          active.permissions.includes("crm.tasks.read")
            ? api<Schema<"PageTask">>(`${base}/tasks?limit=100${filter}`)
            : Promise.resolve({ data: { items: [] as Task[], nextCursor: null, hasMore: false } }),
          active.permissions.includes("crm.pipeline.read")
            ? api<Schema<"PagePipelineStage">>(`${base}/pipeline-stages?limit=100`)
            : Promise.resolve({ data: { items: [] as Stage[], nextCursor: null, hasMore: false } }),
          active.permissions.includes("crm.sources.read")
            ? api<Schema<"PageLeadSource">>(`${base}/lead-sources?limit=100`)
            : Promise.resolve({ data: { items: [] as Source[], nextCursor: null, hasMore: false } }),
        ]);
        if (epoch !== refreshEpoch.current) return;
        setCursors({
          contacts: contacts.data.nextCursor,
          leads: leads.data.nextCursor,
          tasks: tasks.data.nextCursor,
        });
        setData({
          contacts: contacts.data.items,
          leads: leads.data.items,
          tasks: tasks.data.items,
          stages: stages.data.items.sort((a, b) => a.position - b.position),
          sources: sources.data.items,
          more: contacts.data.hasMore || leads.data.hasMore || tasks.data.hasMore,
        });
        setRefreshed(
          [
            "crm.contacts.read",
            "crm.leads.read",
            "crm.tasks.read",
            "crm.pipeline.read",
            "crm.sources.read",
          ].some((code) => active.permissions.includes(code))
            ? new Date().toISOString()
            : null,
        );
        setError("");
      } catch (err) {
        if (epoch !== refreshEpoch.current) return;
        setData(emptyData);
        setRefreshed(null);
        setError(err instanceof Error ? err.message : "Workspace could not refresh.");
        const unrelatedCrmDenial =
          (cmsProtected.current || campaignProtected.current || notificationProtected.current) &&
          err instanceof ApiError &&
          err.status === 403 &&
          ["permission_denied", "entitlement_disabled"].includes(err.code ?? "");
        if (err instanceof ApiError && [401, 403].includes(err.status) && !unrelatedCrmDenial) {
          taskCompletion.current.bind(null);
          activeTaskCompletion.current = null;
          setBusy(false);
          updateTaskCompletion((value) => value + 1);
          setAccessRevision((value) => value + 1);
          commandKeys.current.clear();
          ++detailEpoch.current;
          setSelectedContact(null);
          setSelectedLead(null);
          setSelectedTask(null);
          setModal(null);
          setDirty(false);
          setNoteDirty(false);
          setTagDirty(false);
          capturedContact.current = null;
          setDetailError("Access changed. Refresh access before reopening this record.");
        }
        if (
          err instanceof ApiError &&
          (err.status === 401 || err.code === "membership_required" || err.code === "membership_inactive")
        ) {
          setSession(null);
          retainedSession.current = null;
          setSyntheticIdentity(false);
          setCsrf("");
          setMember("");
          setInvitationTransfer(null);
          setInvitationAcceptance(null);
        }
      } finally {
        if (epoch === refreshEpoch.current) setLoading(false);
      }
    },
    [scope],
  );

  const readSession = useCallback(
    async (preserveDraft = true) => {
      const epoch = ++sessionEpoch.current;
      try {
        const result = await api<Session>("/v1/session");
        if (epoch !== sessionEpoch.current) return;
        const binding = completionContext(
          result.data,
          result.headers.get("X-Member-Id") || "",
          result.headers.get("X-CSRF-Token") || "",
          currentAccessRevision.current,
        );
        if (
          taskCompletion.current.getSnapshot().command &&
          taskCompletion.current.getSnapshot().command?.context !== binding
        ) {
          activeTaskCompletion.current = null;
          setBusy(false);
        }
        taskCompletion.current.bind(binding);
        updateTaskCompletion((value) => value + 1);
        setSession(result.data);
        retainedSession.current = result.data;
        setSyntheticIdentity(result.headers.get("X-Synthetic-Identity") === "true");
        setCsrf(result.headers.get("X-CSRF-Token") || "");
        setMember(result.headers.get("X-Member-Id") || "");
        verifiedMember.current = result.headers.get("X-Member-Id") || "";
        const revision = Number(result.headers.get("ETag")?.replaceAll('"', ""));
        setProfileVersion(Number.isInteger(revision) && revision > 0 ? revision : null);
        await refresh(result.data);
        return retainedSession.current === result.data ? result.data : null;
      } catch (err) {
        if (epoch !== sessionEpoch.current) return;
        if (
          preserveDraft &&
          retainedSession.current &&
          !(err instanceof ApiError && [401, 403].includes(err.status))
        ) {
          setError(
            "Session refresh is unavailable. Existing drafts remain in this tab; retry when connected.",
          );
          return null;
        }
        setSession(null);
        taskCompletion.current.bind(null);
        activeTaskCompletion.current = null;
        setBusy(false);
        updateTaskCompletion((value) => value + 1);
        retainedSession.current = null;
        setSyntheticIdentity(false);
        setData(emptyData);
        setRefreshed(null);
        setCsrf("");
        setMember("");
        setInvitationTransfer(null);
        setInvitationAcceptance(null);
        if (!(err instanceof ApiError && err.status === 401))
          setError(err instanceof Error ? err.message : "Sign-in is unavailable.");
        return null;
      } finally {
        if (epoch === sessionEpoch.current) setBooting(false);
      }
    },
    [refresh],
  );

  useEffect(() => {
    void readSession();
  }, [readSession]);
  useEffect(() => {
    taskCompletion.current.bind(taskCompletionBinding);
    return () => taskCompletion.current.bind(null);
  }, [taskCompletionBinding]);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => {
      setOnline(true);
      void readSession();
    };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [readSession]);
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (reloadProtected.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [unsaved, busy]);
  useEffect(() => {
    if (modal) dialog.current?.showModal();
  }, [modal]);
  useEffect(() => {
    if (!detailId || !detailKind || !session?.activeOrgId) {
      setSelectedContact(null);
      setSelectedLead(null);
      setSelectedTask(null);
      return;
    }
    if (detailDialog.current && !detailDialog.current.open) detailDialog.current.showModal();
    let active = true;
    const generation = ++detailEpoch.current;
    const current = () => active && generation === detailEpoch.current;
    setDetailLoading(true);
    setDetailError("");
    setSelectedContact(null);
    setSelectedLead(null);
    setSelectedTask(null);
    const base = `/v1/orgs/${session.activeOrgId}`;
    void (async () => {
      try {
        if (detailKind === "contact") {
          const response = await api<Contact>(`${base}/contacts/${encodeURIComponent(detailId)}`);
          if (current()) setSelectedContact(response.data);
        } else if (detailKind === "lead") {
          const response = await api<Lead>(`${base}/leads/${encodeURIComponent(detailId)}`);
          if (!current()) return;
          setSelectedLead(response.data);
          const contact = await api<Contact>(`${base}/contacts/${response.data.contactId}`);
          if (current()) setSelectedContact(contact.data);
        } else {
          const response = await api<Task>(`${base}/tasks/${encodeURIComponent(detailId)}`);
          if (current()) setSelectedTask(response.data);
        }
      } catch (err) {
        if (current()) setDetailError(err instanceof Error ? err.message : "Record unavailable.");
      } finally {
        if (current()) setDetailLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [detailId, detailKind, session?.activeOrgId]);
  useEffect(() => {
    setStandalone(
      window.matchMedia("(display-mode: standalone)").matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone),
    );
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent));
    const prompt = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    const installed = () => {
      setStandalone(true);
      setInstall(null);
    };
    window.addEventListener("beforeinstallprompt", prompt);
    window.addEventListener("appinstalled", installed);
    const changed = () => {
      if (!updateAccepted.current) return;
      if (reloadProtected.current) {
        setActivatedUpdate(true);
        setNotice(
          taskCompletion.current.getSnapshot().command
            ? "The app update activated. Reconcile the unconfirmed task completion before reloading."
            : notificationProtected.current
              ? "The app update activated. Reconcile the unconfirmed read command in Notifications before reloading."
              : "The app update activated. Finish or discard your current draft before reloading.",
        );
        return;
      }
      window.location.reload();
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((registration) => {
          if (registration.waiting) setWaiting(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const worker = registration.installing;
            worker?.addEventListener("statechange", () => {
              if (worker.state === "installed" && navigator.serviceWorker.controller) setWaiting(worker);
            });
          });
        })
        .catch(() => {});
    }
    return () => {
      window.removeEventListener("beforeinstallprompt", prompt);
      window.removeEventListener("appinstalled", installed);
      navigator.serviceWorker?.removeEventListener("controllerchange", changed);
    };
  }, []);

  async function command<T>(
    path: string,
    body: unknown,
    method = "POST",
    version?: number,
    receiveHeaders?: (headers: Headers) => void,
    explicitKey?: string,
  ) {
    if (!online) throw new Error("You’re offline. Your draft is still in this tab; reconnect before saving.");
    if (taskCompletion.current.getSnapshot().command && /\/tasks(?:\/|$)/.test(path))
      throw new Error("Reconcile the unconfirmed task completion before changing tasks.");
    const context = commandContext.current;
    const fingerprint = `${session?.activeOrgId}:${path}:${method}:${JSON.stringify(body)}:${version ?? ""}`;
    let key = explicitKey || commandKeys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      commandKeys.current.set(fingerprint, key);
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
      "X-CSRF-Token": csrf,
    };
    if (version) headers["If-Match"] = `"${version}"`;
    const result = await api<T>(path, { method, headers, body: JSON.stringify(body) });
    if (context !== commandContext.current)
      throw new ApiError(
        503,
        "Access context changed while this command was in flight. Its response cannot be applied to the current workspace.",
        "command_context_changed",
      );
    receiveHeaders?.(result.headers);
    if (!explicitKey) commandKeys.current.delete(fingerprint);
    return result.data;
  }
  async function loadMore(resource: "contacts" | "leads" | "tasks") {
    const cursor = cursors[resource];
    if (!cursor || !session?.activeOrgId) return;
    const epoch = refreshEpoch.current;
    setLoading(true);
    setError("");
    const filter =
      scope === "own" && member
        ? `&filter=${encodeURIComponent(JSON.stringify({ ownerMemberId: member } satisfies Schema<"LeadFilter">))}`
        : "";
    try {
      const result = await api<Schema<"PageContact"> | Schema<"PageLead"> | Schema<"PageTask">>(
        `/v1/orgs/${session.activeOrgId}/${resource}?limit=100&cursor=${encodeURIComponent(cursor)}${filter}`,
      );
      if (epoch !== refreshEpoch.current) return;
      setData((current) => ({ ...current, [resource]: [...current[resource], ...result.data.items] }));
      setCursors((current) => ({ ...current, [resource]: result.data.nextCursor }));
    } catch (err) {
      if (epoch === refreshEpoch.current)
        setError(
          err instanceof Error
            ? err.message
            : "Next page unavailable. Previously loaded records are unchanged.",
        );
    } finally {
      if (epoch === refreshEpoch.current) setLoading(false);
    }
  }
  async function signIn(identity: "owner" | "agent") {
    setBusy(true);
    setError("");
    try {
      await api("/dev/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identity }),
      });
      await readSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }
  async function continueInvitation(transfer: InvitationTransfer, identity: "owner" | "agent") {
    if (busy || !online) return;
    if (taskCompletion.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task completion before changing identity.");
      return;
    }
    if (
      unsaved &&
      !window.confirm("Discard other invitation drafts and continue as the synthetic recipient?")
    )
      return;
    ++refreshEpoch.current;
    ++sessionEpoch.current;
    ++detailEpoch.current;
    setInvitationTransfer(transfer);
    setInvitationAcceptance(null);
    setData(emptyData);
    setRefreshed(null);
    setSession(null);
    retainedSession.current = null;
    setSyntheticIdentity(false);
    setCsrf("");
    setMember("");
    verifiedMember.current = "";
    setDirty(false);
    setNoteDirty(false);
    setTagDirty(false);
    setModal(null);
    setSelectedContact(null);
    setSelectedLead(null);
    setSelectedTask(null);
    commandKeys.current.clear();
    await signIn(identity);
  }
  function closeModal() {
    if (busy || (dirty && !window.confirm("Discard the unsaved draft?"))) return;
    setModal(null);
    setDirty(false);
    capturedContact.current = null;
  }
  function closeDetail() {
    if (taskCompletion.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task completion before leaving task details.");
      return;
    }
    if (busy || (unsaved && !window.confirm("Discard the unsaved changes?"))) return;
    setDirty(false);
    setDetailError("");
    setNoteDirty(false);
    setTagDirty(false);
    router.push(`/${view}`);
  }
  async function saveDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.activeOrgId || busy || !online || noteDirty || tagDirty) return;
    const fields = new FormData(event.currentTarget);
    const base = `/v1/orgs/${session.activeOrgId}`;
    setBusy(true);
    setDetailError("");
    try {
      if (detailKind === "contact" && selectedContact) {
        const input: Schema<"ContactWrite"> = {
          displayName: String(fields.get("displayName")).trim(),
          emails: String(fields.get("email")).trim()
            ? [String(fields.get("email")).trim(), ...selectedContact.emails.slice(1)]
            : selectedContact.emails.slice(1),
          phones: String(fields.get("phone")).trim()
            ? [String(fields.get("phone")).trim(), ...selectedContact.phones.slice(1)]
            : selectedContact.phones.slice(1),
          birthday: selectedContact.birthday,
        };
        setSelectedContact(
          await command<Contact>(
            `${base}/contacts/${selectedContact.id}`,
            input,
            "PATCH",
            selectedContact.version,
          ),
        );
      } else if (detailKind === "lead" && selectedLead) {
        const input: Schema<"LeadPatch"> = {
          intent: String(fields.get("intent")) as Lead["intent"],
          timeline: String(fields.get("timeline")).trim() || null,
        };
        setSelectedLead(
          await command<Lead>(`${base}/leads/${selectedLead.id}`, input, "PATCH", selectedLead.version),
        );
      } else if (detailKind === "task" && selectedTask) {
        const dueInput = event.currentTarget.elements.namedItem("dueAt");
        if (!(dueInput instanceof HTMLInputElement)) throw new Error("Task timing could not be verified.");
        const timing = resolveTaskDrawerTiming(
          { dueAt: selectedTask.dueAt, timezone: selectedTask.timezone },
          dueInput.defaultValue,
          fields.get("dueAt"),
          (value) => ({
            dueAt: new Date(value).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        );
        const input: Schema<"TaskWrite"> = {
          title: String(fields.get("title")).trim(),
          dueAt: timing.dueAt,
          assigneeMemberId: selectedTask.assigneeMemberId,
          timezone: timing.timezone,
          priority: String(fields.get("priority")) as Task["priority"],
          state: String(fields.get("state")) as Task["state"],
          leadId: selectedTask.leadId,
          description: selectedTask.description || undefined,
        };
        setSelectedTask(
          await command<Task>(`${base}/tasks/${selectedTask.id}`, input, "PATCH", selectedTask.version),
        );
      }
      setDirty(false);
      setNotice("Changes saved with a verified record version.");
      await refresh(session);
    } catch (err) {
      setDetailError(
        err instanceof ApiError && err.status === 412
          ? "Someone changed this record. Close and reopen it to review the latest version. Your changes have not been saved."
          : err instanceof Error
            ? err.message
            : "Changes could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }
  function openModal(next: "lead" | "task") {
    if (next === "task" && taskCompletion.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task completion before changing tasks.");
      return;
    }
    setError("");
    setNotice("");
    setDirty(false);
    capturedContact.current = null;
    setModal(next);
  }
  async function saveLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.activeOrgId) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const base = `/v1/orgs/${session.activeOrgId}`;
      const contactInput: Schema<"ContactWrite"> = {
        displayName: String(fields.get("displayName")).trim(),
        emails: fields.get("email") ? [String(fields.get("email")).trim()] : [],
        phones: fields.get("phone") ? [String(fields.get("phone")).trim()] : [],
      };
      const contact = capturedContact.current || (await command<Contact>(`${base}/contacts`, contactInput));
      capturedContact.current = contact;
      const input: Schema<"LeadCreate"> = {
        contactId: contact.id,
        sourceId: String(fields.get("sourceId")),
        ownerMemberId: member || null,
        intent: String(fields.get("intent")) as Lead["intent"],
        timeline: String(fields.get("timeline")).trim() || null,
      };
      await command<Lead>(`${base}/leads`, input);
      capturedContact.current = null;
      setModal(null);
      setDirty(false);
      setNotice("Lead saved and assigned to you.");
      await refresh(session);
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : "Lead could not be saved."}${capturedContact.current ? " Contact saved. Retry this lead to finish capturing the opportunity." : " Retry with the same input to reconcile an interrupted command."}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function saveTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.activeOrgId) return;
    const fields = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const input: Schema<"TaskWrite"> = {
        title: String(fields.get("title")).trim(),
        dueAt: new Date(String(fields.get("dueAt"))).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        assigneeMemberId: member,
        leadId: String(fields.get("leadId")) || null,
        priority: String(fields.get("priority")) as Task["priority"],
        state: "open",
      };
      await command<Task>(`/v1/orgs/${session.activeOrgId}/tasks`, input);
      setModal(null);
      setDirty(false);
      setNotice("Task saved. Your follow-up is scheduled.");
      await refresh(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Task could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function sendTaskCompletion(snapshot: TaskCompletionCommand) {
    const active = session;
    if (
      !active?.activeOrgId ||
      !taskCompletion.current.isBoundTo(taskCompletionBinding) ||
      !taskCompletion.current.isCurrent(snapshot)
    )
      return;
    reloadProtected.current = true;
    activeTaskCompletion.current = snapshot;
    updateTaskCompletion((value) => value + 1);
    setBusy(true);
    setError("");
    const abort = new AbortController();
    const timeout = window.setTimeout(() => abort.abort(), 20000);
    try {
      const result = await api<Task>(`/v1/orgs/${active.activeOrgId}/tasks/${snapshot.taskId}`, {
        method: "PATCH",
        signal: abort.signal,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          "Idempotency-Key": snapshot.key,
          "If-Match": `"${snapshot.version}"`,
        },
        body: JSON.stringify(snapshot.body),
      });
      if (!taskCompletion.current.isCurrent(snapshot)) return;
      if (!taskCompletion.current.acknowledge(snapshot, result.data, result.headers.get("ETag"))) {
        setError(
          "Task completion could not be verified. Reconcile the original command before changing tasks or leaving this view.",
        );
        return;
      }
      updateTaskCompletion((value) => value + 1);
      setNotice("Task completion acknowledged. Refreshing current task records.");
      await refresh(active);
    } catch (err) {
      const outcome = taskCompletion.current.reject(snapshot, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        taskCompletion.current.bind(null);
        setAccessRevision((value) => value + 1);
        ++refreshEpoch.current;
        setData(emptyData);
        setRefreshed(null);
      }
      setError(
        outcome === "unknown"
          ? "Task completion is unconfirmed. Reconcile the retained original command; its input and key have not changed."
          : err instanceof ApiError && err.status === 412
            ? "This task changed since you opened it. Refresh and review its latest version before retrying."
            : "Task completion was rejected or access is unavailable. Refresh and review current records before trying again.",
      );
    } finally {
      window.clearTimeout(timeout);
      updateTaskCompletion((value) => value + 1);
      if (activeTaskCompletion.current === snapshot) {
        activeTaskCompletion.current = null;
        setBusy(false);
      }
    }
  }
  async function completeTask(task: Task) {
    if (
      !session?.activeOrgId ||
      busy ||
      !online ||
      changingOrganization ||
      loading ||
      !permission("crm.tasks.read") ||
      !canTask ||
      !csrf ||
      !taskCompletion.current.isBoundTo(taskCompletionBinding) ||
      document.visibilityState !== "visible"
    )
      return;
    if (reloadProtected.current || taskCompletion.current.getSnapshot().command) {
      setError("Resolve the current draft or unconfirmed task completion before changing tasks.");
      return;
    }
    const current = data.tasks.find(
      (row) => row.id === task.id && row.version === task.version && row.state === "open",
    );
    if (!current) return;
    try {
      const snapshot = taskCompletion.current.begin(current, crypto.randomUUID());
      reloadProtected.current = true;
      await sendTaskCompletion(snapshot);
    } catch {
      setError(
        "Task timing or completion input is unavailable. Refresh current records before trying again.",
      );
    }
  }
  async function reconcileTaskCompletion() {
    if (
      !session?.activeOrgId ||
      busy ||
      !online ||
      changingOrganization ||
      !canTask ||
      !permission("crm.tasks.read") ||
      !taskCompletion.current.isBoundTo(taskCompletionBinding) ||
      document.visibilityState !== "visible"
    )
      return;
    try {
      await sendTaskCompletion(taskCompletion.current.retry());
    } catch {
      setError("There is no current unconfirmed task completion to reconcile.");
    }
  }
  async function moveLead(lead: Lead, toStageId: string) {
    if (!session?.activeOrgId || lead.stageId === toStageId) return;
    setBusy(true);
    setError("");
    try {
      const input: Schema<"StageTransition"> = { toStageId, reason: "Moved through workspace pipeline" };
      await command<Lead>(
        `/v1/orgs/${session.activeOrgId}/leads/${lead.id}/stage-transitions`,
        input,
        "POST",
        lead.version,
      );
      setNotice("Pipeline stage updated.");
      await refresh(session);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 412
          ? "This lead changed. Refresh the pipeline and review the latest stage before retrying."
          : err instanceof Error
            ? err.message
            : "Stage could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function switchOrganization(id: string) {
    if (taskCompletion.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task completion before switching organizations.");
      return;
    }
    if (cmsProtected.current || campaignProtected.current || notificationProtected.current) {
      setError(
        notificationProtected.current
          ? "Reconcile the unconfirmed read command in Notifications before switching organizations."
          : "Resolve or discard the current draft in its editor before switching organizations.",
      );
      return;
    }
    if (unsaved && !window.confirm("Discard your draft and switch organizations?")) return;
    setBusy(true);
    setChangingOrganization(true);
    setError("");
    setNotice("");
    ++refreshEpoch.current;
    ++sessionEpoch.current;
    ++detailEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setModal(null);
    setDirty(false);
    setNoteDirty(false);
    setTagDirty(false);
    setInvitationTransfer(null);
    setSelectedContact(null);
    setSelectedLead(null);
    setSelectedTask(null);
    router.replace(view === "settings" ? `/settings?panel=${settingsPanel}` : `/${view}`);
    try {
      let commandFailure: unknown;
      try {
        await command("/dev/session/organization", { organizationId: id });
      } catch (err) {
        commandFailure = err;
      }
      const verified = await readSession(false);
      if (verified?.activeOrgId === id) {
        commandKeys.current.clear();
        setNotice(
          commandFailure
            ? "Organization switch reconciled from the current session."
            : "Organization switched. Session and access verified.",
        );
      } else
        setError(
          commandFailure instanceof Error
            ? commandFailure.message
            : "Organization switch could not be verified. Refresh your session before retrying.",
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Organization switch failed.");
    } finally {
      setBusy(false);
      setChangingOrganization(false);
    }
  }
  async function logout() {
    if (taskCompletion.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task completion before signing out.");
      return;
    }
    if (cmsProtected.current || campaignProtected.current || notificationProtected.current) {
      setError(
        notificationProtected.current
          ? "Reconcile the unconfirmed read command in Notifications before signing out."
          : "Resolve or discard the current draft in its editor before signing out.",
      );
      return;
    }
    if (unsaved && !window.confirm("Discard your draft and sign out?")) return;
    setBusy(true);
    try {
      await command("/dev/logout", {});
      ++refreshEpoch.current;
      ++sessionEpoch.current;
      ++detailEpoch.current;
      setSession(null);
      retainedSession.current = null;
      setSyntheticIdentity(false);
      setData(emptyData);
      setRefreshed(null);
      setCsrf("");
      setMember("");
      setInvitationTransfer(null);
      setInvitationAcceptance(null);
      setModal(null);
      setDirty(false);
      setNoteDirty(false);
      setTagDirty(false);
      setSelectedContact(null);
      setSelectedLead(null);
      setSelectedTask(null);
      commandKeys.current.clear();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-out failed.");
    } finally {
      setBusy(false);
    }
  }
  function openNotification(href: string) {
    const safe = safeNotificationHref(href);
    if (!safe || !online || busy) return;
    if (reloadProtected.current) {
      setError(
        notificationProtected.current
          ? "Reconcile the unconfirmed read command in Notifications before opening a notification link."
          : "Resolve the current draft or unconfirmed command before opening a notification link.",
      );
      return;
    }
    const destination = safe.split(/[?#]/)[0].slice(1) || "dashboard";
    if (!visibleNavigation.some((item) => item.id === destination)) {
      setError("This notification’s destination is unavailable with your current workspace access.");
      return;
    }
    router.push(safe);
  }
  function openAppointmentLead(id: string) {
    if (
      !online ||
      busy ||
      changingOrganization ||
      !permission("crm.leads.read") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    )
      return;
    if (reloadProtected.current) {
      setError(
        notificationProtected.current
          ? "Reconcile the unconfirmed read command in Notifications before opening appointment lead details."
          : "Resolve the current draft or unconfirmed command before opening appointment lead details.",
      );
      return;
    }
    router.push("/pipeline?lead=" + encodeURIComponent(id));
  }
  function taskAgendaAllowed() {
    if (
      currentTaskAgenda.current !== taskAgendaContext ||
      !online ||
      busy ||
      loading ||
      changingOrganization ||
      document.visibilityState !== "visible" ||
      !refreshed ||
      !permission("crm.tasks.read") ||
      !validTaskAgendaTimezone(organization?.timezone) ||
      partitionLoadedTasks(data.tasks, new Date().toISOString(), session?.profile.timezone).state !== "ready"
    )
      return false;
    if (reloadProtected.current) {
      setError(
        taskCompletion.current.getSnapshot().command
          ? "Reconcile the unconfirmed task completion before opening task details or leaving this view."
          : "Resolve the current draft or unconfirmed command before opening task details or leaving this view.",
      );
      return false;
    }
    return true;
  }
  function openAgendaTask(id: string) {
    if (!taskAgendaAllowed() || !data.tasks.some((task) => task.id === id && task.state === "open")) return;
    router.push("/tasks?task=" + encodeURIComponent(id));
  }
  function completeAgendaTask(task: Task) {
    if (
      !taskAgendaAllowed() ||
      !canTask ||
      !data.tasks.some((row) => row.id === task.id && row.version === task.version && row.state === "open")
    )
      return;
    void completeTask(task);
  }
  const nameFor = (lead: Lead) =>
    data.contacts.find((contact) => contact.id === lead.contactId)?.displayName || "Authorized lead";
  const openTasks = data.tasks.filter((task) => task.state === "open");
  const overdue = openTasks.filter((task) => new Date(task.dueAt).getTime() < Date.now());
  const greeting = session?.profile.displayName.split(" ")[0] || "there";
  const title = navigation.find((item) => item.id === view)?.name || "Dashboard";

  const taskRows = (tasks: Task[]) =>
    tasks.map((task) => (
      <div className="task-row" key={task.id}>
        <button
          type="button"
          className={`task-check ${task.state === "done" ? "done" : ""}`}
          aria-label={`Complete task: ${task.title}`}
          disabled={task.state !== "open" || busy || !online || !canTask || taskPending}
          onClick={() => void completeTask(task)}
        >
          {task.state === "done" && <Check size={16} />}
        </button>
        <div className="task-body">
          <Link href={`/tasks?task=${task.id}`}>{task.title}</Link>
          <span>
            {task.leadId
              ? nameFor(data.leads.find((lead) => lead.id === task.leadId) || ({ contactId: "" } as Lead))
              : "General follow-up"}{" "}
            · {readableDate(task.dueAt, timezone)}
          </span>
        </div>
        <Badge
          tone={
            task.state === "done"
              ? "positive"
              : new Date(task.dueAt).getTime() < Date.now()
                ? "warning"
                : "neutral"
          }
        >
          {task.state === "done"
            ? "Done"
            : new Date(task.dueAt).getTime() < Date.now()
              ? "Overdue"
              : task.priority}
        </Badge>
      </div>
    ));

  if (booting)
    return (
      <div className="boot">
        <House size={36} />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!session)
    return (
      <main className="login-page">
        <div className="login-brand">
          <div className="brand-mark">
            <House size={23} />
          </div>
          <span>
            estate<span className="brand-dot">.</span>
          </span>
        </div>
        <div className="login-layout">
          <section className="login-story">
            <Badge>REAL ESTATE WORKSPACE</Badge>
            <h1>
              Good relationships.
              <br />
              Great possibilities.
            </h1>
            <p>
              Keep your people, opportunities and next steps together. A little clarity for everything ahead.
            </p>
            <div className="login-illustration">
              <div className="illustration-house">
                <House size={72} strokeWidth={1.2} />
              </div>
              <div className="illustration-card">
                <span className="avatar small">JL</span>
                <div>
                  <strong>Your next conversation</strong>
                  <span>One thoughtful follow-up at a time</span>
                </div>
                <CircleCheck size={21} />
              </div>
            </div>
            <div className="login-footnote">
              <ShieldCheck size={18} /> Independent workspace · Built for mobile
            </div>
          </section>
          <section className="login-card">
            <span className="eyebrow">WELCOME TO ESTATE</span>
            <h2>Let’s get you settled.</h2>
            <p>Open the local development workspace with a synthetic identity.</p>
            <div className="synthetic-note">
              <ShieldCheck size={20} />
              <div>
                <strong>Synthetic development only</strong>
                <span>
                  No live MLS feed, real messages or payments. Local identities are disabled outside approved
                  development mode.
                </span>
              </div>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <Button disabled={busy || !online} onClick={() => void signIn("owner")}>
              Sign in as owner (synthetic)
              <ArrowRight size={17} />
            </Button>
            <Button variant="secondary" disabled={busy || !online} onClick={() => void signIn("agent")}>
              Sign in as agent (synthetic)
            </Button>
            <p className="login-small">
              Your browser and home-screen app use the same secure session. Installation is optional.
            </p>
          </section>
        </div>
      </main>
    );

  return (
    <div
      className="workspace"
      onClickCapture={(event) => {
        if (!taskCompletion.current.getSnapshot().command || !(event.target instanceof Element)) return;
        const anchor = event.target.closest("a[href]");
        if (!(anchor instanceof HTMLAnchorElement)) return;
        const destination = new URL(anchor.href);
        if (
          destination.origin !== window.location.origin ||
          (destination.pathname === window.location.pathname &&
            destination.search === window.location.search &&
            destination.hash)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        setError("Reconcile the unconfirmed task completion before navigating away.");
      }}
    >
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Link
          className="brand"
          href="/dashboard"
          aria-label="Estate dashboard"
          onClick={(event) => {
            if (reloadProtected.current) {
              event.preventDefault();
              setError(
                notificationProtected.current
                  ? "Reconcile the unconfirmed read command in Notifications before leaving this view."
                  : "Resolve or discard the current draft before leaving this view.",
              );
            }
          }}
        >
          <span className="brand-mark">
            <House size={22} />
          </span>
          <span>
            estate<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="organization-label">YOUR WORKSPACE</div>
        <div className="organization-select">
          <span className="org-avatar">{initials(organization?.name || "Workspace")}</span>
          <select
            aria-label="Organization"
            value={session.activeOrgId || ""}
            disabled={busy || !online}
            onChange={(event) => void switchOrganization(event.target.value)}
          >
            {session.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="Main navigation">
          {visibleNavigation.map(({ id, name, icon: Icon }) => (
            <Link
              key={id}
              href={`/${id}`}
              aria-current={view === id ? "page" : undefined}
              className={`nav-link ${view === id ? "active" : ""}`}
              onClick={(event) => {
                if (cmsProtected.current || campaignProtected.current || notificationProtected.current) {
                  event.preventDefault();
                  setError(
                    notificationProtected.current
                      ? "Reconcile the unconfirmed read command in Notifications before leaving this view."
                      : "Resolve or discard the current draft in its editor before leaving this view.",
                  );
                  return;
                }
                if (busy) {
                  event.preventDefault();
                  setError("Wait for the current command to resolve before leaving this view.");
                  return;
                }
                if (unsaved && !window.confirm("Leave this view? Your unsaved draft will be discarded."))
                  event.preventDefault();
                else {
                  setModal(null);
                  setDirty(false);
                  setNoteDirty(false);
                  setTagDirty(false);
                  setInvitationTransfer(null);
                }
              }}
            >
              <Icon size={19} />
              <span>{name}</span>
              {id === "tasks" && openTasks.length > 0 && (
                <span className="nav-count">{openTasks.length}</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="mobile-promo">
            <Smartphone size={22} />
            <strong>Your workspace, anywhere</strong>
            <p>Add Estate to your home screen.</p>
            <Link
              href="/settings"
              onClick={(event) => {
                if (reloadProtected.current) {
                  event.preventDefault();
                  setError(
                    notificationProtected.current
                      ? "Reconcile the unconfirmed read command in Notifications before opening installation settings."
                      : "Resolve or discard the current draft before opening installation settings.",
                  );
                }
              }}
            >
              Installation guide <ArrowRight size={14} />
            </Link>
          </div>
          <div className="profile">
            <span className="avatar">{initials(session.profile.displayName)}</span>
            <div>
              <strong>{session.profile.displayName}</strong>
              <span>Synthetic member</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() => void logout()}
              disabled={busy || !online}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={14} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <Badge tone="warning">Synthetic environment</Badge>
            <span className="avatar small" aria-hidden="true">
              {initials(session.profile.displayName)}
            </span>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          <div className="mobile-organization">
            <span className="org-avatar">{initials(organization?.name || "Workspace")}</span>
            <select
              aria-label="Mobile organization"
              value={session.activeOrgId || ""}
              disabled={busy || !online}
              onChange={(event) => void switchOrganization(event.target.value)}
            >
              {session.organizations.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </div>
          {!online && (
            <div className="connection-banner" role="status">
              <WifiOff size={19} />
              <span>You’re offline. Saving is disabled. Drafts stay in this tab’s memory.</span>
            </div>
          )}
          {taskPending && view !== "dashboard" && (
            <div className="connection-banner" role="status">
              <Clock3 size={19} />
              <span>
                A task completion is unconfirmed. Reconcile its original command before navigating or changing
                tasks.
              </span>
              <Button
                variant="secondary"
                disabled={
                  !online || busy || changingOrganization || !canTask || !permission("crm.tasks.read")
                }
                onClick={() => void reconcileTaskCompletion()}
              >
                Reconcile task completion
              </Button>
            </div>
          )}
          {(waiting || activatedUpdate) && (
            <div className="connection-banner update" role="status">
              <Download size={19} />
              <span>
                An app update is ready.
                {taskPending
                  ? " Reconcile the unconfirmed task completion before updating or reloading."
                  : notificationPending
                    ? " Reconcile the unconfirmed read command in Notifications before updating or reloading."
                    : unsaved || busy
                      ? " Finish or discard your draft before updating."
                      : " Reload when you’re ready."}
              </span>
              <Button
                variant="secondary"
                disabled={unsaved || busy || !online}
                onClick={() => {
                  if (reloadProtected.current || !online) return;
                  if (activatedUpdate) {
                    window.location.reload();
                    return;
                  }
                  updateAccepted.current = true;
                  waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
                }}
              >
                {activatedUpdate ? "Reload updated app" : "Update app"}
              </Button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {view === "dashboard"
                  ? new Intl.DateTimeFormat("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      timeZone: timezone,
                    }).format(new Date())
                  : "YOUR WORKSPACE"}
              </span>
              <h1>{view === "dashboard" ? `Good to see you, ${greeting}.` : title}</h1>
              <p>
                {view === "dashboard"
                  ? "A clear view of your people and your next steps."
                  : view === "contacts"
                    ? "Every relationship starts with a conversation."
                    : view === "pipeline"
                      ? "Move opportunities forward, one next step at a time."
                      : view === "tasks"
                        ? "Make room for the follow-ups that matter."
                        : view === "notifications"
                          ? "Notices for your current membership, with clear read receipts."
                          : "A workspace that travels with you."}
              </p>
            </div>
            <div className="heading-actions">
              {["contacts", "pipeline"].includes(view) &&
                (permission("crm.import") || permission("data.export")) && (
                  <Button
                    variant="secondary"
                    disabled={busy || unsaved}
                    onClick={() => router.push("/settings?panel=data")}
                  >
                    <FileSpreadsheet size={17} />
                    CSV import / export
                  </Button>
                )}
              <button
                className="icon-button refresh"
                aria-label="Refresh workspace"
                disabled={loading || !online || busy || unsaved}
                onClick={() => void refresh(session)}
              >
                <RefreshCw size={18} className={loading ? "spinning" : ""} />
              </button>
              {!["settings", "properties", "websites", "campaigns", "notifications"].includes(view) &&
                !dealsTab &&
                !captureTab && (
                  <Button
                    disabled={busy || !online || (view === "tasks" ? !canTask : !canCapture) || !member}
                    onClick={() => openModal(view === "tasks" ? "task" : "lead")}
                  >
                    <Plus size={18} />
                    {view === "tasks" ? "Add task" : "Add lead"}
                  </Button>
                )}
            </div>
          </div>
          {error && !modal && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="success" role="status">
              <CircleCheck size={17} />
              {notice}
            </div>
          )}
          {view !== "properties" &&
            view !== "websites" &&
            view !== "campaigns" &&
            view !== "notifications" && (
              <div className="scope-line">
                <span>
                  <ShieldCheck size={14} /> {organization?.name}
                  <select
                    aria-label="Workspace scope"
                    value={scope}
                    disabled={busy || loading || !online || unsaved}
                    onChange={(event) => {
                      ++refreshEpoch.current;
                      setData(emptyData);
                      setRefreshed(null);
                      setScope(event.target.value as "own" | "authorized");
                    }}
                  >
                    <option value="own">My workspace</option>
                    <option value="authorized">All permitted records</option>
                  </select>
                </span>
                <span>
                  {loading
                    ? "Refreshing…"
                    : refreshed
                      ? `Refreshed ${readableDate(refreshed, timezone)} · ${timezone}`
                      : "Data unavailable"}
                </span>
              </div>
            )}

          {notificationPending && view !== "notifications" && (
            <div className="connection-banner" role="status">
              <Bell size={18} aria-hidden="true" />
              <span>A notification read command is still unconfirmed in this tab.</span>
              <Button
                type="button"
                variant="secondary"
                disabled={
                  busy ||
                  dirty ||
                  noteDirty ||
                  tagDirty ||
                  cmsDirty ||
                  campaignDirty ||
                  Boolean(invitationTransfer)
                }
                onClick={() => {
                  if (taskCompletion.current.getSnapshot().command) {
                    setError("Reconcile the unconfirmed task completion before opening Notifications.");
                    return;
                  }
                  router.push("/notifications");
                }}
              >
                Return to notifications
              </Button>
            </div>
          )}
          {(view === "notifications" || notificationPending) && (
            <div hidden={view !== "notifications"}>
              <NotificationCenter
                key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
                session={session}
                memberId={member}
                csrf={csrf}
                online={online && !changingOrganization && view === "notifications"}
                accessRevision={accessRevision}
                onProtectedChange={protectNotification}
                onNavigate={openNotification}
                onAccessRevoked={() => {
                  router.replace("/dashboard");
                  setError(
                    "Notification access changed. Refresh workspace access before reopening Notifications.",
                  );
                }}
              />
            </div>
          )}
          {view === "properties" && (
            <PropertiesFeature
              key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
              session={session}
              online={online}
              syntheticFeaturesEnabled={syntheticEnabled && !changingOrganization}
              accessRevision={accessRevision}
              onAccessRevoked={() => {
                router.replace("/dashboard");
                setError("Property access changed. Refresh workspace access before reopening Properties.");
              }}
            />
          )}
          {view === "websites" && (
            <CmsWorkspace
              key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
              session={session}
              csrf={csrf}
              online={online}
              syntheticFeaturesEnabled={syntheticEnabled && !changingOrganization}
              accessRevision={accessRevision}
              onDirty={protectCms}
              onAccessRevoked={() => {
                router.replace("/dashboard");
                setError("Website access changed. Refresh workspace access before reopening Websites.");
              }}
            />
          )}
          {view === "campaigns" && (
            <CampaignWorkspace
              key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
              session={session}
              csrf={csrf}
              online={online}
              syntheticFeaturesEnabled={syntheticEnabled && !changingOrganization}
              accessRevision={accessRevision}
              onDirty={protectCampaign}
              onAccessRevoked={() => {
                router.replace("/dashboard");
                setError("Campaign access changed. Refresh workspace access before reopening Campaigns.");
              }}
            />
          )}
          {view === "dashboard" && (
            <>
              {permission("dashboard.read") && session.activeOrgId && (
                <VerifiedMetrics
                  key={session.activeOrgId}
                  organizationId={session.activeOrgId}
                  refreshMarker={refreshed}
                  online={online}
                />
              )}
              <div className="metrics">
                <Metric
                  icon={<Users size={21} />}
                  name="Relationships"
                  value={refreshed && permission("crm.contacts.read") ? data.contacts.length : null}
                  detail="Contacts in loaded scope"
                />
                <Metric
                  icon={<Kanban size={21} />}
                  name="Opportunities"
                  value={refreshed && permission("crm.leads.read") ? data.leads.length : null}
                  detail="Leads in loaded scope"
                />
                <Metric
                  icon={<ListTodo size={21} />}
                  name="Open follow-ups"
                  value={refreshed && permission("crm.tasks.read") ? openTasks.length : null}
                  detail="Tasks with state open"
                />
                <Metric
                  icon={<Clock3 size={21} />}
                  name="Needs attention"
                  value={refreshed && permission("crm.tasks.read") ? overdue.length : null}
                  detail="Open tasks past due"
                  warning
                />
              </div>
              <p className="metric-definition">
                Snapshot v1 · Current loaded records · All-time record inventory as of refresh · Source: CRM
                API.
                {Object.values(cursors).some(Boolean)
                  ? " Additional records exist; these counts are partial."
                  : ""}{" "}
                Counts do not represent engagement or revenue.
              </p>
              <div className="dashboard-grid">
                <TaskAgenda
                  contextKey={taskAgendaContext}
                  tasks={data.tasks}
                  userTimezone={session.profile.timezone}
                  organizationTimezone={organization?.timezone}
                  scope={scope}
                  refreshedAt={refreshed}
                  hasMore={Boolean(cursors.tasks)}
                  loading={loading}
                  online={online && !changingOrganization}
                  canRead={permission("crm.tasks.read")}
                  canComplete={canTask && Boolean(member)}
                  blocked={
                    busy ||
                    changingOrganization ||
                    dirty ||
                    noteDirty ||
                    tagDirty ||
                    cmsProtected.current ||
                    campaignProtected.current ||
                    notificationProtected.current
                  }
                  completionPending={taskPending}
                  onReconcile={() => void reconcileTaskCompletion()}
                  onOpenTask={openAgendaTask}
                  onCompleteTask={completeAgendaTask}
                  onViewTasks={() => {
                    if (taskAgendaAllowed()) router.push("/tasks");
                  }}
                  onAddTask={() => {
                    if (taskAgendaAllowed() && canTask) openModal("task");
                  }}
                />
                <section className="panel pipeline-summary">
                  <PanelHeading
                    icon={<Kanban size={18} />}
                    title="Pipeline at a glance"
                    action={
                      <Link href="/pipeline" aria-label="Open pipeline">
                        <ArrowRight size={17} />
                      </Link>
                    }
                  />
                  <div className="stage-bars">
                    {(permission("crm.leads.read") ? data.stages : []).map((stage, index) => {
                      const count = data.leads.filter((lead) => lead.stageId === stage.id).length;
                      return (
                        <div key={stage.id} className="stage-bar">
                          <div>
                            <span>
                              <i
                                style={{
                                  background: [
                                    "#2459B8",
                                    "#487ECA",
                                    "#6D89B2",
                                    "#8997AD",
                                    "#096B52",
                                    "#62A38E",
                                  ][index % 6],
                                }}
                              />
                              {stage.name}
                            </span>
                            <strong>{count}</strong>
                          </div>
                          <div className="bar-track">
                            <span
                              style={{
                                width: `${data.leads.length ? Math.max((count / data.leads.length) * 100, count ? 4 : 0) : 0}%`,
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                    {(!data.stages.length || !permission("crm.leads.read")) && (
                      <Empty icon={<Kanban size={26} />} title="Pipeline unavailable">
                        Refresh to load your organization’s stages.
                      </Empty>
                    )}
                  </div>
                </section>
              </div>
              <AppointmentAgenda
                key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
                session={session}
                memberId={member}
                online={online && !changingOrganization}
                accessRevision={accessRevision}
                onOpenLead={openAppointmentLead}
                onAccessRevoked={() => {
                  setError(
                    "Stored appointment access changed. Refresh workspace access before reopening this agenda.",
                  );
                }}
              />
              <div className="dashboard-grid lower">
                <section className="panel">
                  <PanelHeading
                    icon={<Users size={18} />}
                    title="People in your workspace"
                    action={
                      <Link href="/contacts">
                        View contacts <ArrowRight size={14} />
                      </Link>
                    }
                  />
                  {data.contacts.length ? (
                    <div className="recent-contacts">
                      {data.contacts.slice(0, 4).map((contact) => (
                        <Link
                          href={`/contacts?contact=${contact.id}`}
                          key={contact.id}
                          className="contact-row"
                        >
                          <span className="avatar light">{initials(contact.displayName)}</span>
                          <div>
                            <strong>{contact.displayName}</strong>
                            <span>{contact.emails[0] || "Email not provided"}</span>
                          </div>
                          <ChevronRight size={17} />
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Users size={27} />}
                      title={
                        refreshed && permission("crm.contacts.read")
                          ? "Your first relationship starts here"
                          : "Contacts unavailable"
                      }
                    >
                      {refreshed && permission("crm.contacts.read")
                        ? "Capture a lead to bring a new person into your workspace."
                        : "Current contact read access and a successful refresh are required."}
                    </Empty>
                  )}
                </section>
                <section className="panel health-panel">
                  <PanelHeading icon={<Activity size={18} />} title="Connections" />
                  <div className="health-row">
                    <span className="health-icon">
                      <ShieldCheck size={19} />
                    </span>
                    <div>
                      <strong>CRM workspace</strong>
                      <span>
                        {refreshed ? "Records read from the local service" : "Awaiting service response"}
                      </span>
                    </div>
                    <Badge tone={refreshed ? "positive" : "warning"}>
                      {refreshed ? "Connected" : "Unavailable"}
                    </Badge>
                  </div>
                  <div className="health-row">
                    <span className="health-icon">
                      <House size={19} />
                    </span>
                    <div>
                      <strong>Trestle MLS</strong>
                      <span>Approved feed rights and credentials required</span>
                    </div>
                    <Badge>Not connected</Badge>
                  </div>
                  <div className="health-row">
                    <span className="health-icon">
                      <Mail size={19} />
                    </span>
                    <div>
                      <strong>Messaging & calendar</strong>
                      <span>No live delivery or booking provider</span>
                    </div>
                    <Badge>Unavailable</Badge>
                  </div>
                  <div className="health-note">
                    <Sparkles size={16} />
                    <span>
                      Only confirmed activity appears here. Provider workflows are added as their acceptance
                      gates pass.
                    </span>
                  </div>
                </section>
              </div>
            </>
          )}

          {view === "contacts" && (
            <section className="panel contacts-panel">
              <div className="list-toolbar">
                <div className="search-field">
                  <Search size={18} />
                  <input
                    aria-label="Search loaded contacts"
                    placeholder="Search loaded contacts…"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                </div>
                <Badge>{data.contacts.length} loaded contacts</Badge>
              </div>
              {data.contacts.length ? (
                <div className="contacts-list">
                  {data.contacts
                    .filter((contact) =>
                      `${contact.displayName} ${contact.emails.join(" ")} ${contact.phones.join(" ")}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((contact) => (
                      <article className="contact-card" key={contact.id} id={`contact-${contact.id}`}>
                        <div className="contact-person">
                          <span className="avatar light">{initials(contact.displayName)}</span>
                          <div>
                            <h3>
                              <Link href={`/contacts?contact=${contact.id}`}>{contact.displayName}</Link>
                            </h3>
                            <span>
                              {data.leads.filter((lead) => lead.contactId === contact.id).length}{" "}
                              opportunities
                            </span>
                          </div>
                        </div>
                        <div className="contact-channel">
                          <Mail size={15} />
                          <span>{contact.emails[0] || "Email unknown"}</span>
                        </div>
                        <div className="contact-channel">
                          <span>{contact.phones[0] || "Phone unknown"}</span>
                          <Badge>v{contact.version}</Badge>
                        </div>
                      </article>
                    ))}
                </div>
              ) : (
                <Empty
                  icon={<Users size={32} />}
                  title={refreshed ? "Make your first connection" : "Contacts unavailable"}
                >
                  {refreshed
                    ? "Capture a lead to create a contact and an assigned opportunity. No messages are sent."
                    : "The service has not returned your contacts."}
                </Empty>
              )}
              <div className="panel-footer muted">
                Search filters the loaded page. CSV import and export are available in Settings when your role
                permits them. Saved filters are not available in this implementation slice.
                {cursors.contacts ? " More records are available using Load more contacts." : ""}
              </div>
            </section>
          )}

          {view === "pipeline" && (
            <nav className="settings-nav" aria-label="Pipeline sections">
              {[
                { id: "board", label: "Lead pipeline", allowed: true },
                {
                  id: "deals",
                  label: "Deals",
                  allowed: permission("crm.deals.read") && permission("crm.leads.read"),
                },
                { id: "capture", label: "Synthetic capture", allowed: captureAllowed },
              ]
                .filter((item) => item.allowed)
                .map((item) => (
                  <Link
                    key={item.id}
                    href={item.id === "board" ? "/pipeline" : `/pipeline?tab=${item.id}`}
                    aria-current={
                      (dealsTab ? "deals" : captureTab ? "capture" : "board") === item.id ? "page" : undefined
                    }
                    onClick={(event) => {
                      if (
                        busy ||
                        (unsaved && !window.confirm("Discard unsaved changes and change pipeline section?"))
                      ) {
                        event.preventDefault();
                        return;
                      }
                      setDirty(false);
                      setNoteDirty(false);
                      setTagDirty(false);
                    }}
                  >
                    {item.label}
                  </Link>
                ))}
            </nav>
          )}
          {dealsTab && permission("crm.deals.read") && permission("crm.leads.read") && (
            <DealsPanel
              key={`${session.activeOrgId}:${scope}`}
              session={session}
              memberId={member}
              scope={scope}
              online={online}
              working={busy}
              leads={data.leads}
              leadLabel={nameFor}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
            />
          )}
          {dealsTab && (!permission("crm.deals.read") || !permission("crm.leads.read")) && (
            <Empty icon={<Kanban size={30} />} title="Deals unavailable">
              Your current role cannot read deals and their linked leads.
            </Empty>
          )}
          {captureTab && syntheticEnabled && (
            <SyntheticCapture
              key={`${session.activeOrgId}:${scope}`}
              session={session}
              memberId={member}
              scope={scope}
              online={online}
              working={busy}
              contacts={data.contacts}
              sources={data.sources}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
              onSaved={() => refresh(session)}
            />
          )}
          {captureTab && !syntheticEnabled && (
            <Empty icon={<ShieldCheck size={30} />} title="Synthetic capture unavailable">
              This demonstration requires an explicitly enabled local synthetic session.
            </Empty>
          )}
          {view === "pipeline" && !dealsTab && !captureTab && (
            <div className="pipeline-board">
              {data.stages.map((stage) => {
                const leads = data.leads.filter((lead) => lead.stageId === stage.id);
                return (
                  <section className="pipeline-column" key={stage.id}>
                    <div className="pipeline-column-heading">
                      <h2>{stage.name}</h2>
                      <Badge>{leads.length}</Badge>
                    </div>
                    {leads.map((lead) => (
                      <article className="lead-card" key={lead.id}>
                        <Link href={`/pipeline?lead=${lead.id}`} className="lead-name">
                          {nameFor(lead)}
                        </Link>
                        <div className="lead-badges">
                          <Badge>{lead.intent === "unknown" ? "Intent unknown" : lead.intent}</Badge>
                          <span>v{lead.version}</span>
                        </div>
                        <p>{lead.timeline || "Timeline not provided"}</p>
                        <div className="lead-source">
                          {data.sources.find((source) => source.id === lead.sourceId)?.label ||
                            "Source unavailable"}
                        </div>
                        <label className="stage-selector">
                          <span>Move to stage</span>
                          <select
                            aria-label={`Stage for ${nameFor(lead)}`}
                            value={lead.stageId}
                            disabled={busy || !online || !permission("crm.leads.write")}
                            onChange={(event) => void moveLead(lead, event.target.value)}
                          >
                            {data.stages.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </article>
                    ))}
                    {!leads.length && <p className="column-empty">No opportunities here yet</p>}
                  </section>
                );
              })}
              {!data.stages.length && (
                <section className="panel">
                  <Empty icon={<Kanban size={30} />} title="Pipeline unavailable">
                    Reconnect and refresh to load your configured stages.
                  </Empty>
                </section>
              )}
            </div>
          )}

          {view === "tasks" && (
            <section className="panel">
              <div className="list-toolbar">
                <div className="tabs" role="group" aria-label="Task filter">
                  {["open", "done", "all"].map((filter) => (
                    <button
                      key={filter}
                      aria-pressed={taskFilter === filter}
                      className={taskFilter === filter ? "selected" : ""}
                      onClick={() => setTaskFilter(filter)}
                    >
                      {filter === "open" ? "Open" : filter === "done" ? "Completed" : "All tasks"}
                    </button>
                  ))}
                </div>
                <span className="muted">Times in {timezone}</span>
              </div>
              {data.tasks.filter((task) => taskFilter === "all" || task.state === taskFilter).length ? (
                <div>
                  {taskRows(
                    data.tasks
                      .filter((task) => taskFilter === "all" || task.state === taskFilter)
                      .sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
                  )}
                </div>
              ) : (
                <Empty
                  icon={<ListTodo size={30} />}
                  title={refreshed ? "Nothing on this list yet" : "Tasks unavailable"}
                >
                  Add a follow-up with a due time and an assigned member. Completion is confirmed by the
                  server.
                </Empty>
              )}
            </section>
          )}

          {view === "settings" && (
            <nav className="settings-nav" aria-label="Settings sections">
              {[
                { id: "device", label: "Device & app", allowed: true },
                { id: "account", label: "Account & access", allowed: true },
                {
                  id: "workspace",
                  label: "Offices & brands",
                  allowed: permission("offices.read") || permission("profiles.read"),
                },
                { id: "invitations", label: "Invitations", allowed: true },
                { id: "routing", label: "Routing", allowed: permission("crm.routing.read") },
                {
                  id: "consent",
                  label: "Synthetic consent",
                  allowed: syntheticEnabled && permission("consent.write"),
                },
                {
                  id: "crm",
                  label: "CRM configuration",
                  allowed:
                    permission("crm.pipeline.read") ||
                    permission("crm.sources.read") ||
                    permission("crm.tags.read"),
                },
                { id: "billing", label: "Billing", allowed: permission("billing.read") },
                {
                  id: "data",
                  label: "CSV import / export",
                  allowed: permission("crm.import") || permission("data.export"),
                },
                {
                  id: "support",
                  label: "Support",
                  allowed: permission("support.read") || permission("support.write"),
                },
              ]
                .filter((item) => item.allowed)
                .map((item) => (
                  <Link
                    key={item.id}
                    href={`/settings?panel=${item.id}`}
                    aria-current={settingsPanel === item.id ? "page" : undefined}
                    onClick={(event) => {
                      if (busy) {
                        event.preventDefault();
                        setError("Wait for the current command to resolve before leaving this section.");
                        return;
                      }
                      if (unsaved && !window.confirm("Discard unsaved settings and leave this section?"))
                        event.preventDefault();
                      else {
                        setDirty(false);
                        setNoteDirty(false);
                        setTagDirty(false);
                        if (item.id !== "invitations") setInvitationTransfer(null);
                      }
                    }}
                  >
                    {item.label}
                  </Link>
                ))}
            </nav>
          )}
          {view === "settings" && settingsPanel === "device" && (
            <div className="settings-grid">
              <section className="panel settings-card">
                <span className="settings-icon">
                  <Smartphone size={26} />
                </span>
                <h2>Estate on your home screen</h2>
                <p>
                  Use the complete workspace in your browser or install it on iPhone and Android. No app store
                  needed.
                </p>
                <Badge tone={standalone ? "positive" : "neutral"}>
                  {standalone ? "Running as an installed app" : "Running in your browser"}
                </Badge>
                {install && !standalone && (
                  <Button
                    onClick={async () => {
                      await install.prompt();
                      await install.userChoice;
                      setInstall(null);
                    }}
                  >
                    <ArrowDownToLine size={17} />
                    Install Estate
                  </Button>
                )}
                <ol className="install-guide">
                  <li>
                    <strong>{ios ? "On this iPhone or iPad" : "On iPhone"}</strong>
                    <span>
                      Open in Safari, use the Share or browser menu, then choose Add to Home Screen. Open the
                      new icon to launch Estate.
                    </span>
                  </li>
                  <li>
                    <strong>On Android</strong>
                    <span>
                      Open in Chrome. Use Install app or Add to Home screen in the browser menu when
                      available.
                    </span>
                  </li>
                </ol>
                <p className="muted">
                  Installation requires a secure HTTPS deployment. Localhost supports development testing.
                  Physical device acceptance is still pending.
                </p>
              </section>
              <section className="panel settings-card">
                <span className="settings-icon">
                  <ShieldCheck size={26} />
                </span>
                <h2>Your device & privacy</h2>
                <p>
                  Private records stay on the server. This app caches only original icons, a generic offline
                  page and approved static build assets.
                </p>
                <div className="settings-fact">
                  <strong>Offline saving</strong>
                  <Badge>Disabled</Badge>
                </div>
                <div className="settings-fact">
                  <strong>App update</strong>
                  <Badge>{waiting ? "Ready" : "No waiting update"}</Badge>
                </div>
                <div className="settings-fact">
                  <strong>Push notifications</strong>
                  <Badge>Unavailable</Badge>
                </div>
                <p className="muted">
                  Push opt-in will be available after encrypted member-scoped device subscriptions and
                  no-delivery provider tests are implemented.
                </p>
                <Button variant="secondary" disabled={!online || busy} onClick={() => void logout()}>
                  <LogOut size={17} />
                  Sign out
                </Button>
              </section>
              <section className="panel settings-card workspace-settings">
                <h2>Workspace details</h2>
                <dl>
                  <div>
                    <dt>Organization</dt>
                    <dd>{organization?.name}</dd>
                  </div>
                  <div>
                    <dt>Organization timezone</dt>
                    <dd>{organization?.timezone}</dd>
                  </div>
                  <div>
                    <dt>Your timezone</dt>
                    <dd>{timezone}</dd>
                  </div>
                  <div>
                    <dt>Identity mode</dt>
                    <dd>Synthetic local development</dd>
                  </div>
                  <div>
                    <dt>MLS provider</dt>
                    <dd>Trestle · Live access disabled</dd>
                  </div>
                </dl>
              </section>
            </div>
          )}
          {view === "settings" && settingsPanel === "account" && (
            <SettingsAdmin
              key={session.activeOrgId}
              session={session}
              profileVersion={profileVersion}
              online={online}
              working={busy}
              runCommand={command}
              onRefresh={async () => {
                await readSession();
              }}
              setWorking={setBusy}
              onDirty={setDirty}
            />
          )}
          {view === "settings" && settingsPanel === "support" && (
            <SupportPanel
              key={session.activeOrgId}
              session={session}
              online={online}
              working={busy}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
              ticketId={query.get("ticket")}
            />
          )}
          {view === "settings" && settingsPanel === "billing" && (
            <BillingPanel
              key={session.activeOrgId}
              session={session}
              syntheticEnabled={syntheticEnabled}
              online={online}
              working={busy}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
            />
          )}
          {view === "settings" &&
            settingsPanel === "consent" &&
            (syntheticEnabled ? (
              <ConsentPanel
                key={`${session.userId}:${session.activeOrgId}:${member}:${scope}:${session.permissions.join(",")}:${accessRevision}`}
                session={session}
                memberId={member}
                scope={scope}
                online={online}
                working={busy}
                runCommand={command}
                onDirty={setDirty}
                setWorking={setBusy}
              />
            ) : (
              <Empty icon={<ShieldCheck size={30} />} title="Synthetic consent unavailable">
                This demonstration requires an explicitly enabled local synthetic session.
              </Empty>
            ))}
          {view === "settings" && settingsPanel === "data" && (
            <DataTransfer
              key={session.activeOrgId}
              session={session}
              csrf={csrf}
              memberId={member}
              online={online}
              working={busy}
              workspaceScope={scope}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
              onImported={() => refresh(session)}
            />
          )}
          {view === "settings" && settingsPanel === "workspace" && (
            <WorkspaceRecords
              key={session.activeOrgId}
              session={session}
              online={online}
              working={busy}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
            />
          )}
          {view === "settings" && settingsPanel === "invitations" && (
            <InvitationsPanel
              key={`${session.userId}:${session.activeOrgId}`}
              session={session}
              online={online}
              working={busy}
              transfer={invitationTransfer}
              acceptanceJob={
                invitationAcceptance?.userId === session.userId ? invitationAcceptance.job : null
              }
              onAcceptedJob={(job) => setInvitationAcceptance({ userId: session.userId, job })}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
              onRefresh={async () => {
                await readSession();
              }}
              onContinue={continueInvitation}
              onClearTransfer={() => setInvitationTransfer(null)}
            />
          )}
          {view === "settings" && settingsPanel === "crm" && (
            <CrmConfiguration
              key={session.activeOrgId}
              session={session}
              online={online}
              working={busy}
              runCommand={command}
              onDirty={setDirty}
              setWorking={setBusy}
              onSaved={() => refresh(session)}
            />
          )}
          {view === "settings" &&
            settingsPanel === "routing" &&
            (permission("crm.routing.read") ? (
              <RoutingPanel
                key={session.activeOrgId}
                session={session}
                online={online}
                working={busy}
                runCommand={command}
                onDirty={setDirty}
                setWorking={setBusy}
              />
            ) : (
              <Empty icon={<Kanban size={30} />} title="Routing unavailable">
                Your current role cannot read routing configuration.
              </Empty>
            ))}
          {view === "contacts" && cursors.contacts && (
            <div className="pagination">
              <Button
                variant="secondary"
                disabled={loading || busy || !online}
                onClick={() => void loadMore("contacts")}
              >
                {loading ? "Loading…" : "Load more contacts"}
              </Button>
            </div>
          )}
          {view === "pipeline" && !dealsTab && !captureTab && cursors.leads && (
            <div className="pagination">
              <Button
                variant="secondary"
                disabled={loading || busy || !online}
                onClick={() => void loadMore("leads")}
              >
                {loading ? "Loading…" : "Load more leads"}
              </Button>
            </div>
          )}
          {view === "tasks" && cursors.tasks && (
            <div className="pagination">
              <Button
                variant="secondary"
                disabled={loading || busy || !online}
                onClick={() => void loadMore("tasks")}
              >
                {loading ? "Loading…" : "Load more tasks"}
              </Button>
            </div>
          )}
          <footer className="workspace-footer">
            <span>Estate workspace</span>
            <span>
              <ShieldCheck size={13} /> Synthetic development · No live delivery
            </span>
          </footer>
        </main>
      </div>
      <nav className="bottom-nav" aria-label="Mobile navigation, scroll for more views">
        {visibleNavigation.map(({ id, name, icon: Icon }) => (
          <Link
            key={id}
            href={`/${id}`}
            aria-current={view === id ? "page" : undefined}
            onClick={(event) => {
              if (
                cmsProtected.current ||
                campaignProtected.current ||
                notificationProtected.current ||
                unsaved ||
                busy
              ) {
                event.preventDefault();
                setError(
                  notificationProtected.current
                    ? "Reconcile the unconfirmed read command in Notifications before leaving this view."
                    : "Resolve or discard the current draft before leaving this view.",
                );
                return;
              }
            }}
          >
            <Icon size={20} />
            <span>{name}</span>
          </Link>
        ))}
      </nav>
      {modal && (
        <dialog
          ref={dialog}
          className="editor-dialog"
          onCancel={(event) => {
            event.preventDefault();
            closeModal();
          }}
          aria-labelledby="editor-title"
        >
          <div className="editor-header">
            <div>
              <span className="eyebrow">{modal === "lead" ? "A NEW CONVERSATION" : "YOUR NEXT STEP"}</span>
              <h2 id="editor-title">{modal === "lead" ? "Add a lead" : "Add a task"}</h2>
            </div>
            <button className="icon-button" aria-label="Close editor" disabled={busy} onClick={closeModal}>
              <X size={21} />
            </button>
          </div>
          <form onSubmit={modal === "lead" ? saveLead : saveTask} onChange={() => setDirty(true)}>
            <div className="editor-body">
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              {!online && (
                <div className="connection-banner">
                  <WifiOff size={17} />
                  Offline — your draft has not been saved.
                </div>
              )}
              {modal === "lead" ? (
                <>
                  <p className="muted">
                    Create a contact and a separate opportunity assigned to you. Communication consent remains
                    unknown.
                  </p>
                  <label>
                    Full name
                    <input
                      name="displayName"
                      autoComplete="name"
                      required
                      maxLength={120}
                      placeholder="e.g. Jordan Lee"
                      readOnly={Boolean(capturedContact.current)}
                    />
                  </label>
                  <label>
                    Email
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      maxLength={254}
                      placeholder="jordan@example.com"
                      readOnly={Boolean(capturedContact.current)}
                    />
                  </label>
                  <label>
                    Phone (optional)
                    <input
                      name="phone"
                      type="tel"
                      autoComplete="tel"
                      maxLength={32}
                      placeholder="+1 702 555 0100"
                      readOnly={Boolean(capturedContact.current)}
                    />
                  </label>
                  <div className="form-columns">
                    <label>
                      Intent
                      <select name="intent" defaultValue="unknown">
                        <option value="unknown">Unknown</option>
                        <option value="buyer">Buyer</option>
                        <option value="seller">Seller</option>
                        <option value="both">Buyer & seller</option>
                      </select>
                    </label>
                    <label>
                      Source
                      <select name="sourceId" required defaultValue={data.sources[0]?.id || ""}>
                        <option value="" disabled>
                          Select source
                        </option>
                        {data.sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Timeline (optional)
                    <input name="timeline" maxLength={80} placeholder="Only what the person has shared" />
                  </label>
                  <div className="form-note">
                    <ShieldCheck size={16} />
                    No email or SMS is sent when you save.
                  </div>
                </>
              ) : (
                <>
                  <p className="muted">This follow-up will be assigned to you.</p>
                  <label>
                    Title
                    <input
                      name="title"
                      required
                      maxLength={200}
                      placeholder="e.g. Check in about the home search"
                    />
                  </label>
                  <label>
                    Due date and time
                    <input name="dueAt" type="datetime-local" required />
                    <span className="field-help">
                      Enter your device’s local time: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                      Stored as a UTC instant.
                    </span>
                  </label>
                  <label>
                    Lead (optional)
                    <select name="leadId" defaultValue="">
                      <option value="">General follow-up</option>
                      {data.leads.map((lead) => (
                        <option key={lead.id} value={lead.id}>
                          {nameFor(lead)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Priority
                    <select name="priority" defaultValue="normal">
                      <option value="low">Low</option>
                      <option value="normal">Normal</option>
                      <option value="high">High</option>
                    </select>
                  </label>
                </>
              )}
            </div>
            <div className="editor-footer">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeModal}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !online || !member || (modal === "lead" && !data.sources.length)}
              >
                {busy ? "Saving…" : modal === "lead" ? "Save lead" : "Save task"}
                <ArrowRight size={16} />
              </Button>
            </div>
          </form>
        </dialog>
      )}
      {detailId && session && (
        <dialog
          ref={detailDialog}
          className="editor-dialog detail-dialog"
          onCancel={(event) => {
            event.preventDefault();
            closeDetail();
          }}
          aria-labelledby="detail-title"
        >
          <div className="editor-header">
            <div>
              <span className="eyebrow">{detailKind?.toUpperCase()} DETAILS</span>
              <h2 id="detail-title">
                {selectedContact?.displayName || selectedTask?.title || "Record details"}
              </h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close record details"
              disabled={busy}
              onClick={closeDetail}
            >
              <X size={21} />
            </button>
          </div>
          {detailLoading ? (
            <div className="empty">Loading authorized record…</div>
          ) : (
            <form onSubmit={saveDetail} onChange={() => setDirty(true)}>
              <div className="editor-body">
                {detailError && (
                  <div className="error" role="alert">
                    {detailError}
                  </div>
                )}
                {detailKind === "contact" && selectedContact && (
                  <>
                    <label>
                      Full name
                      <input
                        name="displayName"
                        defaultValue={selectedContact.displayName}
                        required
                        maxLength={120}
                      />
                    </label>
                    <label>
                      Email
                      <input
                        name="email"
                        type="email"
                        defaultValue={selectedContact.emails[0] || ""}
                        maxLength={254}
                      />
                    </label>
                    <label>
                      Phone (optional)
                      <input
                        name="phone"
                        type="tel"
                        defaultValue={selectedContact.phones[0] || ""}
                        maxLength={32}
                      />
                    </label>
                    <p className="muted">
                      Additional channels are preserved. Communication consent is not changed by editing
                      contact details.
                    </p>
                  </>
                )}
                {detailKind === "lead" && selectedLead && (
                  <>
                    <div className="detail-summary">
                      <span className="avatar light">{initials(selectedContact?.displayName || "Lead")}</span>
                      <div>
                        <strong>{selectedContact?.displayName || "Contact unavailable"}</strong>
                        <span>{selectedContact?.emails[0] || "Email unknown"}</span>
                      </div>
                    </div>
                    <label>
                      Intent
                      <select name="intent" defaultValue={selectedLead.intent}>
                        <option value="unknown">Unknown</option>
                        <option value="buyer">Buyer</option>
                        <option value="seller">Seller</option>
                        <option value="both">Buyer & seller</option>
                      </select>
                    </label>
                    <label>
                      Timeline (optional)
                      <input name="timeline" defaultValue={selectedLead.timeline || ""} maxLength={80} />
                    </label>
                    <dl className="detail-facts">
                      <div>
                        <dt>Stage</dt>
                        <dd>
                          {data.stages.find((stage) => stage.id === selectedLead.stageId)?.name ||
                            "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>
                          {data.sources.find((source) => source.id === selectedLead.sourceId)?.label ||
                            "Unavailable"}
                        </dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd>
                          {selectedLead.ownerMemberId === member
                            ? "Assigned to you"
                            : selectedLead.ownerMemberId
                              ? "Assigned member"
                              : "Unassigned queue"}
                        </dd>
                      </div>
                      <div>
                        <dt>Engagement score</dt>
                        <dd>
                          {selectedLead.score == null
                            ? "Unknown"
                            : `${selectedLead.score} · ${selectedLead.scoreVersion || "Version unavailable"}`}
                        </dd>
                      </div>
                    </dl>
                  </>
                )}
                {detailKind === "task" && selectedTask && (
                  <>
                    <label>
                      Title
                      <input name="title" defaultValue={selectedTask.title} required maxLength={200} />
                    </label>
                    <label>
                      Due date and time
                      <input
                        name="dueAt"
                        type="datetime-local"
                        defaultValue={taskDrawerBaseline.current?.value || ""}
                        required
                      />
                      <span className="field-help">
                        Unchanged time preserves the stored instant and timezone. Changed wall times use your
                        device timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Ambiguous or
                        skipped times follow your device’s daylight-saving resolution.
                      </span>
                    </label>
                    <label>
                      Priority
                      <select name="priority" defaultValue={selectedTask.priority}>
                        <option value="low">Low</option>
                        <option value="normal">Normal</option>
                        <option value="high">High</option>
                      </select>
                    </label>
                    <label>
                      Status
                      <select name="state" defaultValue={selectedTask.state}>
                        <option value="open">Open</option>
                        <option value="done">Done</option>
                        <option value="cancelled">Cancelled</option>
                      </select>
                    </label>
                  </>
                )}
                {(selectedContact || selectedLead || selectedTask) && (
                  <p className="form-note">
                    <ShieldCheck size={15} />
                    Version{" "}
                    {detailKind === "lead"
                      ? selectedLead?.version
                      : detailKind === "task"
                        ? selectedTask?.version
                        : selectedContact?.version}{" "}
                    · Changes require this exact record version.
                  </p>
                )}
              </div>
              <div className="editor-footer">
                <Button type="button" variant="secondary" disabled={busy} onClick={closeDetail}>
                  Close
                </Button>
                <Button
                  type="submit"
                  disabled={
                    !dirty ||
                    noteDirty ||
                    tagDirty ||
                    busy ||
                    !online ||
                    !(detailKind === "contact"
                      ? permission("crm.contacts.write") && selectedContact
                      : detailKind === "lead"
                        ? permission("crm.leads.write") && selectedLead
                        : canTask && selectedTask)
                  }
                >
                  {busy ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          )}
          {selectedLead && session.activeOrgId && (
            <LeadTimeline
              key={`${session.activeOrgId}:${selectedLead.id}`}
              lead={selectedLead}
              organizationId={session.activeOrgId}
              timezone={timezone}
              online={online}
              working={busy}
              editInProgress={dirty || tagDirty}
              canWrite={permission("crm.leads.write")}
              onDirty={setNoteDirty}
              setWorking={setBusy}
              runCommand={command}
              onSaved={async () => {
                const generation = detailEpoch.current;
                const result = await api<Lead>(`/v1/orgs/${session.activeOrgId}/leads/${selectedLead.id}`);
                if (generation !== detailEpoch.current) return;
                setSelectedLead(result.data);
                await refresh(session);
              }}
            />
          )}
          {selectedLead &&
            session.activeOrgId &&
            permission("crm.tags.read") &&
            permission("crm.leads.write") && (
              <LeadTags
                key={`${session.activeOrgId}:${selectedLead.id}`}
                lead={selectedLead}
                organizationId={session.activeOrgId}
                online={online}
                working={busy}
                editInProgress={dirty || noteDirty}
                runCommand={command}
                onDirty={setTagDirty}
                setWorking={setBusy}
                onSaved={async (lead) => {
                  setSelectedLead(lead);
                  await refresh(session);
                }}
              />
            )}
        </dialog>
      )}
    </div>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function Metric({
  icon,
  name,
  value,
  detail,
  warning,
}: {
  icon: ReactNode;
  name: string;
  value: number | null;
  detail: string;
  warning?: boolean;
}) {
  return (
    <section className="metric-card">
      <div className="metric-top">
        <span>{name}</span>
        <span className={`metric-icon ${warning ? "warning" : ""}`}>{icon}</span>
      </div>
      <strong className="metric-value">{value === null ? "—" : value}</strong>
      <span className="metric-detail">{value === null ? "Unavailable" : detail}</span>
    </section>
  );
}
function PanelHeading({ icon, title, action }: { icon: ReactNode; title: string; action?: ReactNode }) {
  return (
    <div className="panel-heading">
      <h2>
        {icon}
        {title}
      </h2>
      {action}
    </div>
  );
}
