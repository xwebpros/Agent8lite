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
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Users,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Badge, Button, Empty } from "../../../packages/ui/components";
import { api, ApiError } from "../lib/api";
import type { Schema } from "../lib/api";
import SettingsAdmin from "./settings-admin";
import LeadTimeline from "./lead-timeline";
import PushSettings from "./push-settings";
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
import AutomationWorkspace from "./automation-workspace";
import NotificationCenter from "./notification-center";
import { safeNotificationHref } from "./notification-controller";
import AppointmentAgenda from "./appointment-agenda";
import TaskAgenda from "./task-agenda";
import { partitionLoadedTasks, resolveTaskDrawerTiming, validTaskAgendaTimezone } from "./task-agenda-time";
import {
  TaskEditProtocol,
  taskEditContext,
  taskEditReadContext,
  taskEditEligible,
  requireTaskEditTask,
  type TaskEditCommand,
} from "./task-edit";
import {
  taskEditRequest,
  readTaskEditTask,
  taskEditReadGuard,
  taskEditReadFailureDisposition,
} from "./task-edit-controller";
import TaskEditPanel, { type TaskEditDraft } from "./task-edit-panel";
import ContactsSearch from "./contacts-search";
import { contactSearchContextBinding } from "./contacts-search-controller";
import {
  ContactEditProtocol,
  contactEditContext,
  contactEditRequest,
  contactEditReadGuard,
  contactEditReadFailureDisposition,
  localRecoveryForgottenWarning,
  readContactEditContact,
  type ContactEditCommand,
} from "./contact-edit";
import ContactEditPanel, { type ContactEditDraft } from "./contact-edit-panel";
import {
  LeadCaptureProtocol,
  leadCaptureContext,
  leadCaptureEligible,
  leadCaptureRequest,
  type LeadCaptureCommand,
  type LeadCaptureTemplate,
} from "./lead-capture";
import LeadCapturePanel, { emptyLeadCaptureDraft, type LeadCaptureDraft } from "./lead-capture-panel";
import {
  StageTransitionProtocol,
  stageTransitionContext,
  stageTransitionEligible,
  stageTransitionRequest,
  type StageTransitionCommand,
} from "./stage-transition";
import StageTransitionPanel from "./stage-transition-panel";
import {
  LeadAssignmentProtocol,
  leadAssignmentContext,
  leadAssignmentReadContext,
  leadAssignmentEligible,
  requireLeadAssignmentLead,
  type LeadAssignmentCommand,
} from "./lead-assignment";
import { leadAssignmentRequest, readLeadAssignmentLead } from "./lead-assignment-controller";
import LeadAssignmentPanel from "./lead-assignment-panel";
import {
  TaskCreateProtocol,
  taskCreateContext,
  taskCreateEligible,
  taskCreateRequest,
  captureTaskCreateTiming,
  type TaskCreateCommand,
} from "./task-create";
import TaskCreatePanel, { emptyTaskCreateDraft, type TaskCreateDraft } from "./task-create-panel";
import {
  RecordArchiveProtocol,
  recordArchiveContext,
  recordArchiveContextAllows,
  recordArchiveEligible,
  type RecordArchiveCommand,
  type RecordArchiveKind,
} from "./record-archive";
import { RecordArchiveController, type RecordArchiveOutcome } from "./record-archive-controller";
import RecordArchivePanel from "./record-archive-panel";
import {
  ContactMergeProtocol,
  contactMergeContext,
  contactMergeEligible,
  type ContactMergeCommand,
} from "./contact-merge";
import { ContactMergeController, type ContactMergeOutcome } from "./contact-merge-controller";
import { ContactMergePanel } from "./contact-merge-panel";
import { ContactDuplicateList } from "./contact-duplicate-list";

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
  | "automations"
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
  { id: "automations", name: "Automations", icon: Zap },
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
  return taskEditContext({ session: active, memberId, csrf: token, accessRevision: revision });
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
  const [automationDirty, setAutomationDirty] = useState(false);
  const automationProtected = useRef(false);
  const [notificationPending, setNotificationPending] = useState(false);
  const notificationProtected = useRef(false);
  const [invitationTransfer, setInvitationTransfer] = useState<InvitationTransfer | null>(null);
  const taskEdit = useRef(new TaskEditProtocol());
  const activeTaskEdit = useRef<TaskEditCommand | null>(null);
  const [, updateTaskEdit] = useState(0);
  const [taskEditDenied, setTaskEditDenied] = useState(false);
  const taskEditBinding = taskEditDenied ? null : completionContext(session, member, csrf, accessRevision);
  const taskReadBinding = taskEditDenied
    ? null
    : taskEditReadContext({ session, memberId: member, csrf, accessRevision });
  const currentTaskReadBinding = useRef(taskReadBinding);
  currentTaskReadBinding.current = taskReadBinding;
  const currentAccessRevision = useRef(accessRevision);
  currentAccessRevision.current = accessRevision;
  taskEdit.current.bind(taskEditBinding);
  if (activeTaskEdit.current && activeTaskEdit.current.context !== taskEditBinding)
    activeTaskEdit.current = null;
  const taskEditSnapshot = taskEdit.current.getSnapshot();
  const taskPending = Boolean(taskEditSnapshot.command);
  const contactEdit = useRef(new ContactEditProtocol());
  const contactLifetimeActive = useRef(false);
  const activeContactEdit = useRef<ContactEditCommand | null>(null);
  const [, updateContactEdit] = useState(0);
  const [contactDenied, setContactDenied] = useState(false);
  const [contactVisible, setContactVisible] = useState(true);
  const contactReadBinding = contactEditContext({
    session,
    memberId: member,
    csrf,
    accessRevision,
    requireWrite: false,
  });
  const contactEditBinding = contactDenied
    ? null
    : contactEditContext({ session, memberId: member, csrf, accessRevision });
  const currentContactBinding = useRef(contactReadBinding);
  currentContactBinding.current = contactDenied ? null : contactReadBinding;
  contactEdit.current.bind(contactEditBinding);
  const contactSnapshot = contactEdit.current.getSnapshot();
  const contactPending = Boolean(contactSnapshot.command);
  const leadCapture = useRef(new LeadCaptureProtocol());
  const activeLeadCapture = useRef<LeadCaptureCommand | null>(null);
  const [, updateLeadCapture] = useState(0);
  const [leadCaptureDenied, setLeadCaptureDenied] = useState(false);
  const [leadCaptureDraft, setLeadCaptureDraft] = useState<LeadCaptureDraft | null>(null);
  const currentLeadCaptureDraft = useRef(leadCaptureDraft);
  currentLeadCaptureDraft.current = leadCaptureDraft;
  const leadDraftBinding = useRef<string | null>(null);
  const leadCaptureBinding = leadCaptureDenied
    ? null
    : leadCaptureContext({ session, memberId: member, csrf, accessRevision });
  const currentLeadCaptureBinding = useRef(leadCaptureBinding);
  currentLeadCaptureBinding.current = leadCaptureBinding;
  leadCapture.current.bind(leadCaptureBinding);
  const leadSnapshot = leadCapture.current.getSnapshot();
  const leadPending = Boolean(leadSnapshot.sequence);
  const stageTransition = useRef(new StageTransitionProtocol());
  const activeStageTransition = useRef<StageTransitionCommand | null>(null);
  const [, updateStageTransition] = useState(0);
  const [stageDenied, setStageDenied] = useState(false);
  const stageBinding = stageDenied
    ? null
    : stageTransitionContext({ session, memberId: member, csrf, accessRevision });
  const currentStageBinding = useRef(stageBinding);
  currentStageBinding.current = stageBinding;
  stageTransition.current.bind(stageBinding);
  if (activeStageTransition.current && activeStageTransition.current.context !== stageBinding)
    activeStageTransition.current = null;
  const stageSnapshot = stageTransition.current.getSnapshot();
  const stagePending = Boolean(stageSnapshot.command);
  const leadAssignment = useRef(new LeadAssignmentProtocol());
  const activeLeadAssignment = useRef<LeadAssignmentCommand | null>(null);
  const [, updateLeadAssignment] = useState(0);
  const [assignmentDenied, setAssignmentDenied] = useState(false);
  const [assignmentDraft, setAssignmentDraft] = useState<{
    binding: string;
    leadId: string;
    target: string | null;
  } | null>(null);
  const currentAssignmentDraft = useRef(assignmentDraft);
  currentAssignmentDraft.current = assignmentDraft;
  const assignmentBinding = assignmentDenied
    ? null
    : leadAssignmentContext({ session, memberId: member, csrf, accessRevision });
  const leadReadBinding = assignmentDenied
    ? null
    : leadAssignmentReadContext({ session, memberId: member, csrf, accessRevision });
  const currentLeadReadBinding = useRef(leadReadBinding);
  currentLeadReadBinding.current = leadReadBinding;
  const currentAssignmentBinding = useRef(assignmentBinding);
  currentAssignmentBinding.current = assignmentBinding;
  leadAssignment.current.bind(assignmentBinding);
  if (activeLeadAssignment.current && activeLeadAssignment.current.context !== assignmentBinding)
    activeLeadAssignment.current = null;
  const assignmentSnapshot = leadAssignment.current.getSnapshot();
  const assignmentPending = Boolean(assignmentSnapshot.command);
  const assignmentDirty = Boolean(assignmentDraft && assignmentDraft.binding === assignmentBinding);
  const taskCreate = useRef(new TaskCreateProtocol());
  const activeTaskCreate = useRef<TaskCreateCommand | null>(null);
  const [, updateTaskCreate] = useState(0);
  const [taskCreateDenied, setTaskCreateDenied] = useState(false);
  const [taskCreateDraft, setTaskCreateDraft] = useState<TaskCreateDraft | null>(null);
  const currentTaskCreateDraft = useRef(taskCreateDraft);
  currentTaskCreateDraft.current = taskCreateDraft;
  const taskDraftBinding = useRef<string | null>(null);
  const taskCreateBinding = taskCreateDenied
    ? null
    : taskCreateContext({ session, memberId: member, csrf, accessRevision });
  const currentTaskCreateBinding = useRef(taskCreateBinding);
  currentTaskCreateBinding.current = taskCreateBinding;
  taskCreate.current.bind(taskCreateBinding);
  if (activeTaskCreate.current && activeTaskCreate.current.context !== taskCreateBinding)
    activeTaskCreate.current = null;
  const taskCreateSnapshot = taskCreate.current.getSnapshot();
  const taskCreatePending = Boolean(taskCreateSnapshot.command);
  const recordArchive = useRef(new RecordArchiveProtocol());
  const archiveController = useRef(new RecordArchiveController(recordArchive.current));
  const [, updateArchive] = useState(0);
  const [archiveDenied, setArchiveDenied] = useState(false);
  const contactMerge = useRef(new ContactMergeProtocol());
  const contactMergeController = useRef(new ContactMergeController(contactMerge.current));
  const [, updateContactMerge] = useState(0);
  const [contactMergeDenied, setContactMergeDenied] = useState(false);
  const [selectedSourceContact, setSelectedSourceContact] = useState<{
    contact: Contact;
    phoneOnly: boolean;
  } | null>(null);
  const archiveBinding = archiveDenied
    ? null
    : recordArchiveContext({ session, memberId: member, csrf, accessRevision });
  const currentArchiveBinding = useRef(archiveBinding);
  currentArchiveBinding.current = archiveBinding;
  recordArchive.current.bind(archiveBinding);
  const archiveSnapshot = recordArchive.current.getSnapshot();
  const archivePending = Boolean(archiveSnapshot.command);
  const contactMergeBinding = contactMergeDenied
    ? null
    : contactMergeContext({ session, memberId: member, csrf, accessRevision });
  const currentContactMergeBinding = useRef(contactMergeBinding);
  currentContactMergeBinding.current = contactMergeBinding;
  contactMerge.current.bind(contactMergeBinding);
  const contactMergeSnapshot = contactMerge.current.getSnapshot();
  const contactMergePending = Boolean(contactMergeSnapshot.command);
  const unsaved =
    dirty ||
    noteDirty ||
    tagDirty ||
    cmsDirty ||
    campaignDirty ||
    automationDirty ||
    notificationPending ||
    taskPending ||
    contactPending ||
    leadPending ||
    stagePending ||
    assignmentPending ||
    assignmentDirty ||
    taskCreatePending ||
    archivePending ||
    contactMergePending ||
    Boolean(invitationTransfer);
  const [taskFilter, setTaskFilter] = useState("open");
  const [pipelineIntentFilter, setPipelineIntentFilter] = useState("");
  const [pipelineSourceFilter, setPipelineSourceFilter] = useState("");
  const [taskIntentFilter, setTaskIntentFilter] = useState("");
  const [taskSourceFilter, setTaskSourceFilter] = useState("");
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
  const selectedContactBinding = useRef<string | null>(null);
  const [contactDraft, setContactDraft] = useState<ContactEditDraft | null>(null);
  const [contactReviewed, setContactReviewed] = useState(false);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const selectedLeadBinding = useRef<string | null>(null);
  const selectedLeadETag = useRef<string | null>(null);
  const leadDetailVisible = Boolean(
    selectedLeadBinding.current &&
      selectedLeadBinding.current === currentLeadReadBinding.current &&
      online &&
      contactVisible &&
      !changingOrganization &&
      !assignmentPending &&
      !archivePending,
  );
  const assignmentCurrentLead =
    leadDetailVisible && selectedLeadETag.current === `"${selectedLead?.version}"` ? selectedLead : null;
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const selectedTaskBinding = useRef<string | null>(null);
  const selectedTaskETag = useRef<string | null>(null);
  const [taskEditDraft, setTaskEditDraft] = useState<TaskEditDraft | null>(null);
  const currentTaskEditDraft = useRef(taskEditDraft);
  currentTaskEditDraft.current = taskEditDraft;
  const taskEditDraftSource = useRef<{ task: Task; binding: string; baseline: string } | null>(null);
  const taskPrivateVisible = Boolean(
    taskReadBinding &&
      selectedTaskBinding.current === taskReadBinding &&
      online &&
      contactVisible &&
      !changingOrganization &&
      !taskPending,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const currentContactUI = useRef({
    binding: contactReadBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    detailKind,
    detailId,
    busy,
    loading,
    detailLoading,
    noteDirty,
    tagDirty,
    dirty,
    modal,
  });
  currentContactUI.current = {
    binding: currentContactBinding.current,
    online,
    visible: contactVisible,
    changingOrganization,
    detailKind,
    detailId,
    busy,
    loading,
    detailLoading,
    noteDirty,
    tagDirty,
    dirty,
    modal,
  };
  const currentLeadCaptureUI = useRef({
    binding: leadCaptureBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    modal,
    busy,
    loading,
    detailLoading,
    member,
    csrf,
  });
  currentLeadCaptureUI.current = {
    binding: leadCaptureBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    modal,
    busy,
    loading,
    detailLoading,
    member,
    csrf,
  };
  const currentStageUI = useRef({
    binding: stageBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    modal,
    leads: data.leads,
    stages: data.stages,
    csrf,
  });
  currentStageUI.current = {
    binding: stageBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    modal,
    leads: data.leads,
    stages: data.stages,
    csrf,
  };
  const currentTaskCreateUI = useRef({
    binding: taskCreateBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    modal,
    member,
    csrf,
  });
  currentTaskCreateUI.current = {
    binding: taskCreateBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    modal,
    member,
    csrf,
  };
  const currentAssignmentUI = useRef({
    binding: assignmentBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    detailKind,
    detailId,
    lead: selectedLead,
    csrf,
  });
  currentAssignmentUI.current = {
    binding: assignmentBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    detailKind,
    detailId,
    lead: selectedLead,
    csrf,
  };
  const currentTaskEditUI = useRef({
    binding: taskEditBinding,
    readBinding: taskReadBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    detailKind,
    detailId,
    task: selectedTask,
    tasks: data.tasks,
    csrf,
  });
  currentTaskEditUI.current = {
    binding: taskEditBinding,
    readBinding: taskReadBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    detailKind,
    detailId,
    task: selectedTask,
    tasks: data.tasks,
    csrf,
  };
  const currentArchiveUI = useRef({
    binding: archiveBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    view,
    detailKind,
    detailId,
    contact: selectedContact,
    lead: selectedLead,
    csrf,
  });
  currentArchiveUI.current = {
    binding: archiveBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    view,
    detailKind,
    detailId,
    contact: selectedContact,
    lead: selectedLead,
    csrf,
  };
  const currentContactMergeUI = useRef({
    binding: contactMergeBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    kind: detailKind,
    resourceId: detailId,
    csrf,
  });
  currentContactMergeUI.current = {
    binding: contactMergeBinding,
    online,
    visible: contactVisible,
    changingOrganization,
    busy,
    loading,
    detailLoading,
    dirty,
    noteDirty,
    tagDirty,
    modal,
    kind: detailKind,
    resourceId: detailId,
    csrf,
  };
  const [invitationAcceptance, setInvitationAcceptance] = useState<{
    userId: string;
    job: Schema<"Job">;
  } | null>(null);
  const commandKeys = useRef(new Map<string, string>());
  const commandContext = useRef("");
  commandContext.current = `${session?.userId || ""}:${session?.activeOrgId || ""}:${member}`;
  const updateAccepted = useRef(false);
  const reloadProtected = useRef(false);
  reloadProtected.current =
    unsaved ||
    busy ||
    cmsProtected.current ||
    campaignProtected.current ||
    automationProtected.current ||
    notificationProtected.current ||
    Boolean(taskEdit.current.getSnapshot().command) ||
    Boolean(contactEdit.current.getSnapshot().command) ||
    Boolean(leadCapture.current.getSnapshot().sequence) ||
    Boolean(stageTransition.current.getSnapshot().command) ||
    Boolean(leadAssignment.current.getSnapshot().command) ||
    Boolean(taskCreate.current.getSnapshot().command) ||
    Boolean(recordArchive.current.getSnapshot().command) ||
    Boolean(contactMerge.current.getSnapshot().command);
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
  const protectAutomation = useCallback((value: boolean) => {
    automationProtected.current = value;
    if (value) reloadProtected.current = true;
    setAutomationDirty(value);
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
  const renderedDetailEpoch = detailEpoch.current;
  const verifiedMember = useRef("");
  const retainedSession = useRef<Session | null>(null);
  const organization = session?.organizations.find((org) => org.id === session.activeOrgId);
  const timezone = session?.profile.timezone || "America/Los_Angeles";
  const permission = (name: string) => session?.permissions.includes(name) === true;
  const syntheticEnabled = syntheticFeaturesEnabled && syntheticIdentity && Boolean(session);
  const canCapture = Boolean(leadCaptureBinding) && leadSnapshot.phase !== "forgotten";
  const canTask = permission("crm.tasks.write");
  const canUpdateTask = Boolean(taskEditBinding) && taskEditSnapshot.phase !== "forgotten";
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
  const contactSearchContext = [
    session ? contactSearchContextBinding({ session, memberId: member, accessRevision, scope }) : "",
    view,
    String(online),
    String(busy),
    String(loading),
    String(detailLoading),
    String(changingOrganization),
  ]
    .map((part) => part.length + ":" + part)
    .join("|");
  const currentContactSearch = useRef(contactSearchContext);
  currentContactSearch.current = contactSearchContext;
  const visibleNavigation = navigation.filter((item) => {
    if (item.id === "properties") return syntheticEnabled && permission("mls.read");
    if (item.id === "websites")
      return syntheticEnabled && permission("sites.read") && permission("content.read");
    if (item.id === "campaigns") return syntheticEnabled && permission("campaigns.read");
    if (item.id === "automations") return syntheticEnabled && permission("automations.read");
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
        taskEdit.current.getSnapshot().command ||
        contactEdit.current.getSnapshot().command ||
        leadCapture.current.getSnapshot().sequence ||
        stageTransition.current.getSnapshot().command ||
        leadAssignment.current.getSnapshot().command ||
        taskCreate.current.getSnapshot().command ||
        recordArchive.current.getSnapshot().command
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
          clearTaskCreateAccess();
          clearLeadAssignmentAccess();
          clearRecordArchiveAccess();
          clearTaskEditAccess();
          stageTransition.current.bind(null);
          currentStageBinding.current = null;
          activeStageTransition.current = null;
          setStageDenied(true);
          contactEdit.current.bind(null);
          currentContactBinding.current = null;
          selectedContactBinding.current = null;
          setContactDraft(null);
          setContactDenied(true);
          activeTaskEdit.current = null;
          setBusy(false);
          updateTaskEdit((value) => value + 1);
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
          leadCapture.current.bind(null);
          currentLeadCaptureBinding.current = null;
          activeLeadCapture.current = null;
          leadDraftBinding.current = null;
          currentLeadCaptureDraft.current = null;
          setLeadCaptureDraft(null);
          setLeadCaptureDenied(true);
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
          (taskEdit.current.getSnapshot().command &&
            taskEdit.current.getSnapshot().command?.context !== binding) ||
          (activeTaskEdit.current && activeTaskEdit.current.context !== binding)
        ) {
          activeTaskEdit.current = null;
          setBusy(false);
        }
        if (!taskEdit.current.isBoundTo(binding)) {
          selectedTaskBinding.current = null;
          selectedTaskETag.current = null;
          currentTaskEditDraft.current = null;
          taskEditDraftSource.current = null;
          setTaskEditDraft(null);
          setSelectedTask(null);
        }
        taskEdit.current.bind(binding);
        setTaskEditDenied(false);
        const nextContactReadBinding = contactEditContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
          requireWrite: false,
        });
        const nextContactBinding = contactEditContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (currentContactBinding.current !== nextContactReadBinding) {
          activeContactEdit.current = null;
          ++detailEpoch.current;
          selectedContactBinding.current = null;
          setContactDraft(null);
          setSelectedContact(null);
          setBusy(false);
          updateContactEdit((value) => value + 1);
        }
        contactEdit.current.bind(nextContactBinding);
        currentContactBinding.current = nextContactReadBinding;
        setContactDenied(false);
        const nextLeadBinding = leadCaptureContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (currentLeadCaptureBinding.current !== nextLeadBinding) {
          activeLeadCapture.current = null;
          leadDraftBinding.current = null;
          currentLeadCaptureDraft.current = null;
          setLeadCaptureDraft(null);
          setBusy(false);
        }
        leadCapture.current.bind(nextLeadBinding);
        const nextStageBinding = stageTransitionContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (currentStageBinding.current !== nextStageBinding) {
          activeStageTransition.current = null;
          setBusy(false);
        }
        stageTransition.current.bind(nextStageBinding);
        currentStageBinding.current = nextStageBinding;
        setStageDenied(false);
        updateStageTransition((value) => value + 1);
        const nextAssignmentBinding = leadAssignmentContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        const nextLeadReadBinding = leadAssignmentReadContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (
          currentAssignmentBinding.current !== nextAssignmentBinding ||
          currentLeadReadBinding.current !== nextLeadReadBinding
        ) {
          activeLeadAssignment.current = null;
          currentAssignmentDraft.current = null;
          setAssignmentDraft(null);
          clearLeadAssignmentDetail();
          setBusy(false);
        }
        leadAssignment.current.bind(nextAssignmentBinding);
        currentAssignmentBinding.current = nextAssignmentBinding;
        currentLeadReadBinding.current = nextLeadReadBinding;
        setAssignmentDenied(false);
        updateLeadAssignment((value) => value + 1);
        const nextTaskCreateBinding = taskCreateContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (currentTaskCreateBinding.current !== nextTaskCreateBinding) {
          activeTaskCreate.current = null;
          taskDraftBinding.current = null;
          currentTaskCreateDraft.current = null;
          setTaskCreateDraft(null);
          if (currentTaskCreateUI.current.modal === "task") setDirty(false);
          setBusy(false);
        }
        taskCreate.current.bind(nextTaskCreateBinding);
        currentTaskCreateBinding.current = nextTaskCreateBinding;
        setTaskCreateDenied(false);
        updateTaskCreate((value) => value + 1);
        const nextArchiveBinding = recordArchiveContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        if (currentArchiveBinding.current !== nextArchiveBinding) setBusy(false);
        recordArchive.current.bind(nextArchiveBinding);
        currentArchiveBinding.current = nextArchiveBinding;
        setArchiveDenied(false);
        updateArchive((value) => value + 1);
        const nextContactMergeBinding = contactMergeContext({
          session: result.data,
          memberId: result.headers.get("X-Member-Id") || "",
          csrf: result.headers.get("X-CSRF-Token") || "",
          accessRevision: currentAccessRevision.current,
        });
        contactMerge.current.bind(nextContactMergeBinding);
        currentContactMergeBinding.current = nextContactMergeBinding;
        setContactMergeDenied(false);
        updateContactMerge((value) => value + 1);
        currentLeadCaptureBinding.current = nextLeadBinding;
        setLeadCaptureDenied(false);
        updateLeadCapture((value) => value + 1);
        updateTaskEdit((value) => value + 1);
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
        stageTransition.current.bind(null);
        currentStageBinding.current = null;
        activeStageTransition.current = null;
        clearTaskCreateAccess();
        clearLeadAssignmentAccess();
        clearRecordArchiveAccess();
        clearTaskEditAccess();
        contactEdit.current.bind(null);
        leadCapture.current.bind(null);
        currentLeadCaptureBinding.current = null;
        activeLeadCapture.current = null;
        leadDraftBinding.current = null;
        currentLeadCaptureDraft.current = null;
        setLeadCaptureDraft(null);
        activeContactEdit.current = null;
        currentContactBinding.current = null;
        selectedContactBinding.current = null;
        setContactDraft(null);
        setContactDenied(true);
        setSelectedContact(null);
        activeTaskEdit.current = null;
        setBusy(false);
        updateTaskEdit((value) => value + 1);
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
    contactLifetimeActive.current = true;
    contactEdit.current.bind(contactEditBinding);
    return () => {
      contactLifetimeActive.current = false;
      taskEdit.current.bind(null);
      activeTaskEdit.current = null;
      currentTaskReadBinding.current = null;
      taskEditDraftSource.current = null;
      currentTaskEditDraft.current = null;
      selectedTaskBinding.current = null;
      selectedTaskETag.current = null;
      leadAssignment.current.bind(null);
      currentAssignmentBinding.current = null;
      currentLeadReadBinding.current = null;
      activeLeadAssignment.current = null;
      currentAssignmentDraft.current = null;
      selectedLeadBinding.current = null;
      selectedLeadETag.current = null;
      taskCreate.current.bind(null);
      currentTaskCreateBinding.current = null;
      activeTaskCreate.current = null;
      taskDraftBinding.current = null;
      currentTaskCreateDraft.current = null;
      recordArchive.current.bind(null);
      currentArchiveBinding.current = null;
      contactMerge.current.bind(null);
      currentContactMergeBinding.current = null;
      stageTransition.current.bind(null);
      currentStageBinding.current = null;
      activeStageTransition.current = null;
      contactEdit.current.bind(null);
      leadCapture.current.bind(null);
      currentLeadCaptureBinding.current = null;
      activeLeadCapture.current = null;
      leadDraftBinding.current = null;
      currentLeadCaptureDraft.current = null;
      currentContactBinding.current = null;
      activeContactEdit.current = null;
      ++detailEpoch.current;
    };
  }, []);
  useEffect(() => {
    void readSession();
  }, [readSession]);
  useEffect(() => {
    taskEdit.current.bind(taskEditBinding);
    return () => taskEdit.current.bind(null);
  }, [taskEditBinding]);
  useEffect(() => {
    const source = taskEditDraftSource.current;
    if (
      source &&
      (source.binding !== taskEditBinding ||
        (detailKind === "task" && detailId?.toLowerCase() !== source.task.id.toLowerCase()))
    ) {
      taskEditDraftSource.current = null;
      currentTaskEditDraft.current = null;
      setTaskEditDraft(null);
      if (detailKind === "task") setDirty(false);
    }
    if (selectedTaskBinding.current && selectedTaskBinding.current !== taskReadBinding) {
      selectedTaskBinding.current = null;
      selectedTaskETag.current = null;
      setSelectedTask(null);
    }
  }, [taskEditBinding, taskReadBinding, detailKind, detailId]);
  useEffect(() => {
    const visibility = () => {
      setContactVisible(document.visibilityState === "visible");
      updateContactEdit((value) => value + 1);
      updateLeadCapture((value) => value + 1);
      updateStageTransition((value) => value + 1);
      updateTaskCreate((value) => value + 1);
      updateLeadAssignment((value) => value + 1);
      updateTaskEdit((value) => value + 1);
      updateArchive((value) => value + 1);
    };
    visibility();
    const clock = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        updateContactEdit((value) => value + 1);
        updateLeadCapture((value) => value + 1);
        updateStageTransition((value) => value + 1);
        updateTaskCreate((value) => value + 1);
        updateLeadAssignment((value) => value + 1);
        updateTaskEdit((value) => value + 1);
        updateArchive((value) => value + 1);
      }
    }, 30000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useEffect(() => {
    if (detailKind !== "contact") return;
    if (selectedContactBinding.current !== currentContactBinding.current) {
      setSelectedContact(null);
      setContactDraft(null);
      setDirty(false);
    }
  }, [contactReadBinding, contactDenied, detailKind]);
  useEffect(() => {
    if (leadDraftBinding.current !== leadCaptureBinding) {
      leadDraftBinding.current = null;
      currentLeadCaptureDraft.current = null;
      setLeadCaptureDraft(null);
      if (modal === "lead") setDirty(false);
    }
  }, [leadCaptureBinding, modal]);
  useEffect(() => {
    if (taskDraftBinding.current !== taskCreateBinding) {
      taskDraftBinding.current = null;
      currentTaskCreateDraft.current = null;
      setTaskCreateDraft(null);
      if (modal === "task") setDirty(false);
    }
  }, [taskCreateBinding, modal]);
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
    const draft = currentAssignmentDraft.current;
    if (
      draft &&
      (draft.binding !== assignmentBinding ||
        detailKind !== "lead" ||
        detailId?.toLowerCase() !== draft.leadId.toLowerCase())
    ) {
      currentAssignmentDraft.current = null;
      setAssignmentDraft(null);
    }
    if (selectedLeadBinding.current && selectedLeadBinding.current !== leadReadBinding)
      clearLeadAssignmentDetail();
  }, [assignmentBinding, leadReadBinding, detailKind, detailId]);
  useEffect(() => {
    if (stageTransition.current.getSnapshot().command || taskCreate.current.getSnapshot().command) {
      setDetailLoading(false);
      return;
    }
    const pendingArchive = recordArchive.current.getSnapshot().command;
    if (pendingArchive) {
      // The retained archive keeps its drawer; no detail read replaces its generic recovery view.
      if (
        detailKind === pendingArchive.kind &&
        detailId?.toLowerCase() === pendingArchive.resourceId.toLowerCase() &&
        detailDialog.current &&
        !detailDialog.current.open
      )
        detailDialog.current.showModal();
      setDetailLoading(false);
      return;
    }
    if (
      taskEdit.current.getSnapshot().command ||
      (detailKind === "task" && taskEdit.current.getSnapshot().phase === "forgotten")
    ) {
      if (
        detailKind === "task" &&
        detailDialog.current &&
        !detailDialog.current.open &&
        taskEdit.current.getSnapshot().command?.taskId.toLowerCase() === detailId?.toLowerCase()
      )
        detailDialog.current.showModal();
      setDetailLoading(false);
      return;
    }
    const pendingAssignment = leadAssignment.current.getSnapshot().command;
    if (pendingAssignment) {
      if (
        detailKind === "lead" &&
        detailId?.toLowerCase() === pendingAssignment.leadId.toLowerCase() &&
        detailDialog.current &&
        !detailDialog.current.open
      )
        detailDialog.current.showModal();
      setDetailLoading(false);
      return;
    }
    const pendingContact = contactEdit.current.getSnapshot().command;
    if (
      pendingContact &&
      (detailKind !== "contact" || detailId?.toLowerCase() !== pendingContact.contactId.toLowerCase())
    ) {
      setDetailLoading(false);
      return;
    }
    if (!detailId || !detailKind || !session?.activeOrgId) {
      setSelectedContact(null);
      setSelectedLead(null);
      setSelectedTask(null);
      return;
    }
    if (detailDialog.current && !detailDialog.current.open) detailDialog.current.showModal();
    let active = true;
    const generation = ++detailEpoch.current;
    const taskReadTicket = { binding: taskReadBinding, taskId: detailId, generation };
    const taskReadCurrent = () => ({
      binding: currentTaskReadBinding.current,
      taskId: currentTaskEditUI.current.detailKind === "task" ? currentTaskEditUI.current.detailId : null,
      generation: detailEpoch.current,
      active: active && contactLifetimeActive.current,
      online: currentTaskEditUI.current.online && navigator.onLine,
      visible: currentTaskEditUI.current.visible && document.visibilityState === "visible",
      changingOrganization: currentTaskEditUI.current.changingOrganization,
    });
    const capturedLeadReadBinding = leadReadBinding;
    const leadAuthorityCurrent = () =>
      active &&
      contactLifetimeActive.current &&
      generation === detailEpoch.current &&
      capturedLeadReadBinding !== null &&
      currentLeadReadBinding.current === capturedLeadReadBinding &&
      currentAssignmentUI.current.detailKind === "lead" &&
      currentAssignmentUI.current.detailId?.toLowerCase() === detailId.toLowerCase();
    const leadDisplayCurrent = () =>
      leadAuthorityCurrent() &&
      currentAssignmentUI.current.online &&
      navigator.onLine &&
      currentAssignmentUI.current.visible &&
      document.visibilityState === "visible" &&
      !currentAssignmentUI.current.changingOrganization;
    const capturedContactBinding = contactReadBinding;
    const contactReadTicket = { binding: capturedContactBinding, contactId: detailId, generation };
    const contactReadCurrent = () => ({
      binding: currentContactBinding.current,
      contactId: currentContactUI.current.detailId,
      generation: detailEpoch.current,
      kind: currentContactUI.current.detailKind,
      active: active && contactLifetimeActive.current,
      online: currentContactUI.current.online && navigator.onLine,
      visible: currentContactUI.current.visible && document.visibilityState === "visible",
      changingOrganization: currentContactUI.current.changingOrganization,
    });
    const current = () =>
      active &&
      generation === detailEpoch.current &&
      (detailKind !== "lead" || leadDisplayCurrent()) &&
      (detailKind !== "task" || taskEditReadGuard(taskReadTicket, taskReadCurrent()).displayCurrent) &&
      (detailKind !== "contact" ||
        contactEditReadGuard(contactReadTicket, contactReadCurrent()).displayCurrent);
    setDetailLoading(true);
    if (detailKind === "contact") setContactReviewed(false);
    setDetailError("");
    setSelectedContact(null);
    setSelectedLead(null);
    selectedLeadBinding.current = null;
    selectedLeadETag.current = null;
    setSelectedTask(null);
    const base = `/v1/orgs/${session.activeOrgId}`;
    void (async () => {
      try {
        if (detailKind === "contact") {
          if (
            !capturedContactBinding ||
            contactDenied ||
            !currentContactUI.current.online ||
            !currentContactUI.current.visible ||
            currentContactUI.current.changingOrganization ||
            document.visibilityState !== "visible"
          )
            return;
          const response = await readContactEditContact(session.activeOrgId!, detailId);
          if (current()) {
            selectedContactBinding.current = capturedContactBinding;
            setSelectedContact(response.data);
            setContactReviewed(Boolean(contactEdit.current.getSnapshot().command));
            if (
              !contactEdit.current.getSnapshot().command &&
              contactEdit.current.getSnapshot().phase !== "forgotten"
            )
              setContactDraft({
                displayName: response.data.displayName,
                email: response.data.emails[0] || "",
                phone: response.data.phones[0] || "",
              });
          }
        } else if (detailKind === "lead") {
          if (!leadDisplayCurrent()) return;
          const response = await readLeadAssignmentLead(session.activeOrgId!, detailId);
          if (!current()) return;
          selectedLeadBinding.current = capturedLeadReadBinding;
          selectedLeadETag.current = response.etag;
          setSelectedLead(response.data);
          try {
            const contact = await api<Contact>(`${base}/contacts/${response.data.contactId}`);
            if (current()) setSelectedContact(contact.data);
          } catch (error) {
            if (leadAuthorityCurrent() && error instanceof ApiError && error.status === 401)
              clearLeadAssignmentAccess();
            /* A Contact-specific 403 does not establish assignment authority. */
          }
        } else {
          if (!taskEditReadGuard(taskReadTicket, taskReadCurrent()).displayCurrent) return;
          const response = await readTaskEditTask(session.activeOrgId!, detailId);
          if (current()) applyCurrentTask(response.data, response.etag, taskReadBinding);
        }
      } catch (err) {
        if (detailKind === "contact") {
          const readCurrent = contactReadCurrent();
          const disposition = contactEditReadFailureDisposition(
            contactReadTicket,
            readCurrent,
            err instanceof ApiError ? err.status : undefined,
          );
          const displayCurrent = contactEditReadGuard(contactReadTicket, readCurrent).displayCurrent;
          if (disposition === "access-denied") invalidateContactAccess();
          if (disposition === "source-unavailable") clearContactSourceDetail();
          if (displayCurrent && disposition !== "ignore")
            setDetailError(
              "Current contact details are unavailable. Refresh access or read the current contact again.",
            );
        } else if (detailKind === "lead") {
          const authorityCurrent = leadAuthorityCurrent(),
            displayCurrent = leadDisplayCurrent();
          if (!authorityCurrent) return;
          if (err instanceof ApiError && [401, 403].includes(err.status)) clearLeadAssignmentAccess();
          else if (err instanceof ApiError && err.status === 404) clearLeadAssignmentDetail();
          if (displayCurrent)
            setDetailError("Current lead details are unavailable. Refresh current access before continuing.");
        } else {
          const disposition = taskEditReadFailureDisposition(
            taskReadTicket,
            taskReadCurrent(),
            err instanceof ApiError ? err.status : undefined,
          );
          const display = taskEditReadGuard(taskReadTicket, taskReadCurrent()).displayCurrent;
          if (disposition === "access-denied") clearTaskEditAccess();
          else if (disposition === "source-unavailable") clearTaskEditDetail();
          if (display && disposition !== "ignore")
            setDetailError(
              "Current task details are unavailable. Refresh workspace access or read the current task again.",
            );
        }
      } finally {
        if (active && generation === detailEpoch.current) setDetailLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    detailId,
    detailKind,
    session?.activeOrgId,
    detailKind === "lead" ? leadReadBinding : null,
    detailKind === "contact" ? contactReadBinding : null,
    detailKind === "contact" ? contactDenied : false,
    detailKind === "task" ? taskReadBinding : null,
    detailKind === "task" ? taskEditDenied : false,
  ]);
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
          contactMerge.current.getSnapshot().command
            ? "The app update activated. Reconcile the unconfirmed merge before reloading."
            : recordArchive.current.getSnapshot().command
              ? "The app update activated. Reconcile the unconfirmed archive before reloading."
              : leadAssignment.current.getSnapshot().command
                ? "The app update activated. Reconcile the unconfirmed lead assignment before reloading."
                : contactEdit.current.getSnapshot().command
                  ? "The app update activated. Reconcile the unconfirmed contact save before reloading."
                  : taskCreate.current.getSnapshot().command
                    ? "The app update activated. Reconcile the unconfirmed task creation before reloading."
                    : stageTransition.current.getSnapshot().command
                      ? "The app update activated. Reconcile the unconfirmed stage transition before reloading."
                      : leadCapture.current.getSnapshot().sequence
                        ? "The app update activated. Resolve the unfinished lead capture before reloading."
                        : taskEdit.current.getSnapshot().command
                          ? "The app update activated. Reconcile the unconfirmed task update before reloading."
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
    if (taskCreate.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed task creation before another command.");
    if (recordArchive.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed archive before another command.");
    if (contactMerge.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed merge before another command.");
    if (leadAssignment.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed lead assignment before another command.");
    if (stageTransition.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed stage transition before starting another command.");
    if (leadCapture.current.getSnapshot().sequence)
      throw new Error("Resolve the unfinished lead capture before starting another command.");
    if (contactEdit.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed contact save before starting another command.");
    if (!online) throw new Error("You’re offline. Your draft is still in this tab; reconnect before saving.");
    if (taskEdit.current.getSnapshot().command)
      throw new Error("Reconcile the unconfirmed task update before changing tasks.");
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
    if (
      taskCreate.current.getSnapshot().command ||
      recordArchive.current.getSnapshot().command ||
      contactMerge.current.getSnapshot().command
    )
      return;
    if (stageTransition.current.getSnapshot().command || leadAssignment.current.getSnapshot().command) return;
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
    if (taskCreate.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task creation before changing identity.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before changing identity.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before changing identity.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError("Resolve the unfinished lead capture before changing identity.");
      return;
    }
    if (contactEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed contact save before changing identity.");
      return;
    }
    if (taskEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task update before changing identity.");
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
    if (taskCreate.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task creation before closing this editor.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before closing this editor.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before closing this view.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError("Resolve the unfinished lead capture in this editor before closing it.");
      return;
    }
    if (busy || (dirty && !window.confirm("Discard the unsaved draft?"))) return;
    setModal(null);
    setDirty(false);
    leadDraftBinding.current = null;
    currentLeadCaptureDraft.current = null;
    setLeadCaptureDraft(null);
    taskDraftBinding.current = null;
    currentTaskCreateDraft.current = null;
    setTaskCreateDraft(null);
  }
  function closeDetail() {
    if (taskCreate.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task creation before leaving this view.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before closing this record.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before closing this view.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError("Resolve the unfinished lead capture before leaving this view.");
      return;
    }
    if (contactEdit.current.getSnapshot().command) {
      setError(
        "Reconcile the unconfirmed contact save before leaving contact details. Current-record review does not end its unconfirmed outcome.",
      );
      return;
    }
    if (taskEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task update before leaving task details.");
      return;
    }
    if (busy || (unsaved && !window.confirm("Discard the unsaved changes?"))) return;
    setDirty(false);
    setDetailError("");
    setNoteDirty(false);
    setTagDirty(false);
    setContactDraft(null);
    currentAssignmentDraft.current = null;
    setAssignmentDraft(null);
    router.push(`/${view}`);
  }
  function invalidateContactAccess() {
    contactEdit.current.bind(null);
    currentContactBinding.current = null;
    activeContactEdit.current = null;
    ++detailEpoch.current;
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setDirty(false);
    setContactDenied(true);
    setDetailLoading(false);
    setBusy(false);
    updateContactEdit((value) => value + 1);
  }
  function clearContactSourceDetail() {
    ++detailEpoch.current;
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setContactReviewed(false);
    setDetailLoading(false);
    setDirty(false);
  }
  async function reviewContact(
    acknowledged = false,
    expectedId?: string,
    acknowledgedCommand?: ContactEditCommand,
  ) {
    const active = retainedSession.current;
    const binding = currentContactBinding.current;
    const ui = currentContactUI.current;
    if (
      !contactLifetimeActive.current ||
      !active?.activeOrgId ||
      !binding ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      ui.changingOrganization ||
      ui.detailKind !== "contact" ||
      !ui.detailId ||
      (expectedId !== undefined && ui.detailId.toLowerCase() !== expectedId.toLowerCase()) ||
      document.visibilityState !== "visible" ||
      cmsProtected.current ||
      campaignProtected.current ||
      notificationProtected.current ||
      ui.noteDirty ||
      ui.tagDirty ||
      ui.modal ||
      taskEdit.current.getSnapshot().command ||
      stageTransition.current.getSnapshot().command ||
      leadAssignment.current.getSnapshot().command ||
      taskCreate.current.getSnapshot().command ||
      recordArchive.current.getSnapshot().command ||
      (acknowledged
        ? !acknowledgedCommand ||
          activeContactEdit.current !== acknowledgedCommand ||
          expectedId?.toLowerCase() !== acknowledgedCommand.contactId.toLowerCase()
        : ui.busy || ui.detailLoading)
    )
      return;
    const retainedCommand = contactEdit.current.getSnapshot().command;
    if (retainedCommand && ui.detailId.toLowerCase() !== retainedCommand.contactId.toLowerCase()) return;
    const pending = Boolean(retainedCommand);
    if (
      !acknowledged &&
      !pending &&
      ui.dirty &&
      !window.confirm("Discard unsaved contact edits and read the current record?")
    )
      return;
    const generation = ++detailEpoch.current;
    const id = ui.detailId;
    const readTicket = { binding, contactId: id, generation };
    const readCurrent = () => ({
      binding: currentContactBinding.current,
      contactId: currentContactUI.current.detailId,
      generation: detailEpoch.current,
      kind: currentContactUI.current.detailKind,
      active: contactLifetimeActive.current,
      online: currentContactUI.current.online && navigator.onLine,
      visible: currentContactUI.current.visible && document.visibilityState === "visible",
      changingOrganization: currentContactUI.current.changingOrganization,
    });
    setDetailLoading(true);
    setContactReviewed(false);
    setDetailError("");
    if (!pending) {
      selectedContactBinding.current = null;
      setSelectedContact(null);
      setContactDraft(null);
    }
    const current = () => contactEditReadGuard(readTicket, readCurrent()).displayCurrent;
    try {
      const response = await readContactEditContact(active.activeOrgId, id);
      if (!current()) return;
      selectedContactBinding.current = binding;
      setSelectedContact(response.data);
      setContactReviewed(pending);
      if (!pending && contactEdit.current.getSnapshot().phase !== "forgotten") {
        setContactDraft({
          displayName: response.data.displayName,
          email: response.data.emails[0] || "",
          phone: response.data.phones[0] || "",
        });
        setDirty(false);
        if (contactEdit.current.getSnapshot().phase !== "acknowledged") contactEdit.current.clear();
        updateContactEdit((value) => value + 1);
      }
      if (acknowledged)
        setNotice("Contact save acknowledged. Current contact details have been read separately.");
    } catch (err) {
      const liveRead = readCurrent();
      const disposition = contactEditReadFailureDisposition(
        readTicket,
        liveRead,
        err instanceof ApiError ? err.status : undefined,
      );
      if (disposition === "ignore") return;
      const displayCurrent = contactEditReadGuard(readTicket, liveRead).displayCurrent;
      if (disposition === "access-denied") invalidateContactAccess();
      else if (disposition === "source-unavailable") clearContactSourceDetail();
      if (!displayCurrent) return;
      selectedContactBinding.current = null;
      setSelectedContact(null);
      setContactReviewed(false);
      if (!pending) setContactDraft(null);
      setDetailError(
        acknowledged
          ? "Contact save acknowledged, but current details are unavailable. No historical receipt has been applied."
          : "Current contact details are unavailable. The retained command, if any, remains unconfirmed.",
      );
    } finally {
      if (generation === detailEpoch.current) setDetailLoading(false);
    }
  }
  async function sendContactEdit(snapshot: ContactEditCommand) {
    const active = retainedSession.current;
    const ui = currentContactUI.current;
    if (
      !contactLifetimeActive.current ||
      !active?.activeOrgId ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      ui.noteDirty ||
      ui.tagDirty ||
      ui.modal ||
      cmsProtected.current ||
      campaignProtected.current ||
      notificationProtected.current ||
      taskEdit.current.getSnapshot().command ||
      recordArchive.current.getSnapshot().command ||
      ui.detailKind !== "contact" ||
      ui.detailId?.toLowerCase() !== snapshot.contactId.toLowerCase() ||
      document.visibilityState !== "visible" ||
      !contactEdit.current.isBoundTo(contactEditBinding) ||
      !contactEdit.current.isCurrent(snapshot) ||
      activeContactEdit.current ||
      !contactEdit.current.canRetry(snapshot)
    ) {
      if (contactEdit.current.isCurrent(snapshot) && !activeContactEdit.current) {
        contactEdit.current.reject(snapshot, new Error("Contact send is unavailable."));
        updateContactEdit((value) => value + 1);
      }
      return;
    }
    reloadProtected.current = true;
    activeContactEdit.current = snapshot;
    updateContactEdit((value) => value + 1);
    setBusy(true);
    setContactReviewed(false);
    setDetailError("");
    try {
      const result = await contactEditRequest(active.activeOrgId, snapshot, csrf);
      if (!contactLifetimeActive.current || !contactEdit.current.isCurrent(snapshot)) return;
      if (!contactEdit.current.acknowledge(snapshot, result.data, result.etag)) {
        setDetailError(
          "The contact save may have completed, but its receipt could not be verified. Reconcile the retained original command.",
        );
        return;
      }
      updateContactEdit((value) => value + 1);
      setDirty(false);
      selectedContactBinding.current = null;
      setSelectedContact(null);
      setContactDraft(null);
      setNotice("Contact save acknowledged. Reading current details separately.");
      await reviewContact(true, snapshot.contactId, snapshot);
      if (
        contactLifetimeActive.current &&
        currentContactBinding.current === snapshot.context &&
        currentContactUI.current.online &&
        currentContactUI.current.visible &&
        !currentContactUI.current.changingOrganization &&
        navigator.onLine &&
        document.visibilityState === "visible"
      )
        await refresh(active);
    } catch (err) {
      const outcome = contactEdit.current.reject(snapshot, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) invalidateContactAccess();
      if (err instanceof ApiError && err.status === 404) {
        clearContactSourceDetail();
      }
      setDetailError(
        outcome === "unknown"
          ? "Contact save unconfirmed. Reconciliation keeps its original input, key and record version."
          : err instanceof ApiError && err.status === 412
            ? "The first save was rejected because the contact changed. Review current details before another save."
            : "The contact save was rejected or current access is unavailable. Review input and current access before trying again.",
      );
    } finally {
      if (contactLifetimeActive.current) updateContactEdit((value) => value + 1);
      if (activeContactEdit.current === snapshot) {
        activeContactEdit.current = null;
        setBusy(false);
      }
    }
  }
  async function reconcileContactEdit() {
    if (
      !contactLifetimeActive.current ||
      currentContactUI.current.busy ||
      currentContactUI.current.detailLoading ||
      currentContactUI.current.noteDirty ||
      currentContactUI.current.tagDirty ||
      currentContactUI.current.modal ||
      cmsProtected.current ||
      campaignProtected.current ||
      notificationProtected.current ||
      taskEdit.current.getSnapshot().command ||
      recordArchive.current.getSnapshot().command ||
      !currentContactUI.current.online ||
      !navigator.onLine ||
      changingOrganization ||
      !contactEdit.current.isBoundTo(contactEditBinding) ||
      document.visibilityState !== "visible"
    )
      return;
    const pending = contactEdit.current.getSnapshot().command;
    if (
      !pending ||
      currentContactUI.current.detailKind !== "contact" ||
      currentContactUI.current.detailId?.toLowerCase() !== pending.contactId.toLowerCase()
    )
      return;
    try {
      await sendContactEdit(contactEdit.current.retry());
    } catch {
      setDetailError(
        "The original contact save cannot currently be resent. Review the current contact; its earlier outcome remains unconfirmed.",
      );
    }
  }
  function releaseForgottenRecoveryProtection() {
    currentContactUI.current.dirty = false;
    // Preserve unrelated editors and commands; forgetting removes only this recovery's protection.
    reloadProtected.current = Boolean(
      currentContactUI.current.busy ||
        currentContactUI.current.noteDirty ||
        currentContactUI.current.tagDirty ||
        cmsProtected.current ||
        campaignProtected.current ||
        notificationProtected.current ||
        invitationTransfer ||
        taskEdit.current.getSnapshot().command ||
        contactEdit.current.getSnapshot().command ||
        leadCapture.current.getSnapshot().sequence ||
        stageTransition.current.getSnapshot().command ||
        leadAssignment.current.getSnapshot().command ||
        taskCreate.current.getSnapshot().command ||
        recordArchive.current.getSnapshot().command,
    );
  }
  function forgetContactRecovery(expectedCommand = contactSnapshot.command) {
    const ui = currentContactUI.current;
    const original = contactEdit.current.getSnapshot().command;
    if (
      !contactLifetimeActive.current ||
      !contactEdit.current.isBoundTo(contactEditBinding) ||
      ui.binding !== contactEditBinding ||
      !original ||
      original !== expectedCommand ||
      ui.detailKind !== "contact" ||
      ui.detailId?.toLowerCase() !== original.contactId.toLowerCase() ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      activeContactEdit.current ||
      !contactEdit.current.forget()
    )
      return;
    activeContactEdit.current = null;
    ++detailEpoch.current;
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setContactReviewed(false);
    setDetailError("");
    setError("");
    setNotice("");
    setDirty(false);
    releaseForgottenRecoveryProtection();
    updateContactEdit((value) => value + 1);
  }
  async function saveDetail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !session?.activeOrgId ||
      busy ||
      !online ||
      noteDirty ||
      tagDirty ||
      assignmentPending ||
      assignmentDirty ||
      recordArchive.current.getSnapshot().command
    )
      return;
    if (detailKind === "task") {
      await saveTaskEdit(selectedTask, taskEditBinding);
      return;
    }
    const fields = new FormData(event.currentTarget);
    const base = `/v1/orgs/${session.activeOrgId}`;
    if (detailKind === "contact") {
      if (
        !contactLifetimeActive.current ||
        !navigator.onLine ||
        !selectedContact ||
        !contactDraft ||
        currentContactUI.current.busy ||
        currentContactUI.current.loading ||
        currentContactUI.current.detailLoading ||
        currentContactUI.current.noteDirty ||
        currentContactUI.current.tagDirty ||
        currentContactUI.current.detailKind !== "contact" ||
        currentContactUI.current.detailId?.toLowerCase() !== selectedContact.id.toLowerCase() ||
        selectedContactBinding.current !== currentContactBinding.current ||
        !contactEdit.current.isBoundTo(contactEditBinding) ||
        changingOrganization ||
        detailLoading ||
        document.visibilityState !== "visible" ||
        ["conflict", "forgotten"].includes(contactEdit.current.getSnapshot().phase) ||
        contactEdit.current.getSnapshot().command ||
        taskEdit.current.getSnapshot().command ||
        cmsProtected.current ||
        campaignProtected.current ||
        notificationProtected.current
      )
        return;
      try {
        const input: Schema<"ContactWrite"> = {
          displayName: contactDraft.displayName.trim(),
          emails: contactDraft.email.trim()
            ? [contactDraft.email.trim(), ...selectedContact.emails.slice(1)]
            : selectedContact.emails.slice(1),
          phones: contactDraft.phone.trim()
            ? [contactDraft.phone.trim(), ...selectedContact.phones.slice(1)]
            : selectedContact.phones.slice(1),
          ...(Object.hasOwn(selectedContact, "birthday") ? { birthday: selectedContact.birthday } : {}),
        };
        const snapshot = contactEdit.current.begin(
          { contactId: selectedContact.id, version: selectedContact.version, body: input },
          crypto.randomUUID(),
        );
        reloadProtected.current = true;
        await sendContactEdit(snapshot);
      } catch {
        setDetailError(
          "Contact input could not be verified. Enter a name and valid email or phone channels before saving.",
        );
      }
      return;
    }
    setBusy(true);
    setDetailError("");
    try {
      if (detailKind === "lead" && selectedLead) {
        const input: Schema<"LeadPatch"> = {
          intent: String(fields.get("intent")) as Lead["intent"],
          timeline: String(fields.get("timeline")).trim() || null,
        };
        let revision: string | null = null;
        const result = requireLeadAssignmentLead(
          await command<Lead>(
            `${base}/leads/${selectedLead.id}`,
            input,
            "PATCH",
            selectedLead.version,
            (headers) => {
              revision = headers.get("ETag");
            },
          ),
        );
        if (revision !== `"${result.version}"`)
          throw new Error("The current lead revision could not be verified. Reopen the current record.");
        selectedLeadETag.current = revision;
        setSelectedLead(result);
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
    if (taskCreate.current.getSnapshot().command) {
      setError("Return to the unconfirmed task creation before another edit.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before starting another edit.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before starting another edit.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError("Return to the unfinished lead capture before starting another edit.");
      return;
    }
    if (busy || loading || detailLoading || reloadProtected.current) {
      setError("Resolve the current draft or command before starting another edit.");
      return;
    }
    if (contactEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed contact save before starting another edit.");
      return;
    }
    if (next === "task" && taskEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task update before changing tasks.");
      return;
    }
    setError("");
    setNotice("");
    setDirty(false);
    if (next === "lead") {
      if (!leadCaptureBinding || leadCapture.current.getSnapshot().phase === "forgotten") return;
      leadDraftBinding.current = leadCaptureBinding;
      currentLeadCaptureDraft.current = { ...emptyLeadCaptureDraft };
      setLeadCaptureDraft({ ...emptyLeadCaptureDraft });
    }
    if (next === "task") {
      if (!taskCreateBinding || taskCreate.current.getSnapshot().phase === "forgotten") return;
      taskDraftBinding.current = taskCreateBinding;
      currentTaskCreateDraft.current = { ...emptyTaskCreateDraft };
      setTaskCreateDraft({ ...emptyTaskCreateDraft });
    }
    setModal(next);
  }
  function leadCaptureAllowed(binding: string | null, ownCommand?: LeadCaptureCommand) {
    const ui = currentLeadCaptureUI.current;
    return (
      leadCapture.current.isBoundTo(binding) &&
      leadCapture.current.getSnapshot().phase !== "forgotten" &&
      leadCaptureEligible(binding, {
        binding: currentLeadCaptureBinding.current,
        active: contactLifetimeActive.current,
        online: ui.online && navigator.onLine,
        visible: ui.visible && document.visibilityState === "visible",
        changingOrganization: ui.changingOrganization,
        modal: ui.modal,
        busy: ui.busy && (!ownCommand || activeLeadCapture.current !== ownCommand),
        loading: ui.loading,
        detailLoading: ui.detailLoading,
        otherProtected:
          cmsProtected.current ||
          campaignProtected.current ||
          notificationProtected.current ||
          Boolean(taskEdit.current.getSnapshot().command) ||
          Boolean(contactEdit.current.getSnapshot().command) ||
          Boolean(stageTransition.current.getSnapshot().command) ||
          Boolean(taskCreate.current.getSnapshot().command) ||
          Boolean(recordArchive.current.getSnapshot().command) ||
          Boolean(contactMerge.current.getSnapshot().command) ||
          currentContactUI.current.noteDirty ||
          currentContactUI.current.tagDirty,
      })
    );
  }
  function invalidateLeadCapture() {
    leadCapture.current.bind(null);
    currentLeadCaptureBinding.current = null;
    activeLeadCapture.current = null;
    leadDraftBinding.current = null;
    currentLeadCaptureDraft.current = null;
    setLeadCaptureDraft(null);
    setLeadCaptureDenied(true);
    setDirty(false);
    setBusy(false);
    updateLeadCapture((value) => value + 1);
  }
  async function sendLeadCapture(snapshot: LeadCaptureCommand, continuation?: LeadCaptureCommand) {
    const active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !leadCapture.current.isCurrent(snapshot) ||
      !leadCaptureAllowed(snapshot.context, continuation) ||
      (continuation &&
        (continuation.step !== "contact" ||
          continuation.context !== snapshot.context ||
          activeLeadCapture.current !== continuation)) ||
      !leadCapture.current.canRetry(snapshot)
    ) {
      if (
        contactLifetimeActive.current &&
        leadCapture.current.isCurrent(snapshot) &&
        !activeLeadCapture.current
      ) {
        leadCapture.current.reject(snapshot, new Error("Capture send unavailable."));
        updateLeadCapture((value) => value + 1);
      }
      return;
    }
    activeLeadCapture.current = snapshot;
    reloadProtected.current = true;
    setBusy(true);
    setError("");
    updateLeadCapture((value) => value + 1);
    try {
      const result = await leadCaptureRequest(
        active.activeOrgId,
        snapshot,
        currentLeadCaptureUI.current.csrf,
      );
      if (!contactLifetimeActive.current || !leadCapture.current.isCurrent(snapshot)) return;
      const acknowledgement = leadCapture.current.acknowledge(snapshot, result.data, result.etag);
      updateLeadCapture((value) => value + 1);
      if (!acknowledgement) {
        setError("The creation receipt could not be verified. Reconcile only the original unconfirmed step.");
        return;
      }
      if (acknowledgement === "contact") {
        if (leadCaptureAllowed(snapshot.context, snapshot)) {
          const next = leadCapture.current.startLead();
          await sendLeadCapture(next, snapshot);
        }
        return;
      }
      leadDraftBinding.current = null;
      currentLeadCaptureDraft.current = null;
      setLeadCaptureDraft(null);
      setDirty(false);
      setNotice("Lead creation acknowledged. Current lists are read separately.");
      if (leadCaptureAllowed(snapshot.context, snapshot)) {
        setModal(null);
        await refresh(active);
      }
    } catch (err) {
      if (!contactLifetimeActive.current) return;
      const outcome = leadCapture.current.reject(snapshot, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        invalidateLeadCapture();
        setError(
          "Lead capture access changed. Private captured fields are cleared; no interrupted outcome is inferred.",
        );
      } else
        setError(
          outcome === "unknown"
            ? "Creation is unconfirmed. Reconcile only the original step; do not begin another capture."
            : snapshot.step === "lead"
              ? "The contact is saved, but this first lead attempt was rejected. Review the lead fields or keep the saved contact."
              : "This first contact attempt was rejected. Review the contact fields before saving again.",
        );
      updateLeadCapture((value) => value + 1);
    } finally {
      if (activeLeadCapture.current === snapshot && contactLifetimeActive.current) {
        activeLeadCapture.current = null;
        setBusy(false);
      }
    }
  }
  async function saveLead() {
    if (!leadCaptureAllowed(leadCaptureBinding) || activeLeadCapture.current) return;
    const state = leadCapture.current.getSnapshot();
    try {
      if (state.phase === "lead-ready") {
        await sendLeadCapture(leadCapture.current.startLead());
        return;
      }
      const draft = currentLeadCaptureDraft.current;
      if (!draft || leadDraftBinding.current !== leadCaptureBinding) return;
      const template: LeadCaptureTemplate = {
        sourceId: draft.sourceId,
        ownerMemberId: currentLeadCaptureUI.current.member,
        intent: draft.intent,
        timeline: draft.timeline || null,
      };
      if (state.phase === "lead-rejected") {
        leadCapture.current.correctLead(template, crypto.randomUUID());
        reloadProtected.current = true;
        await sendLeadCapture(leadCapture.current.startLead());
      } else {
        const snapshot = leadCapture.current.begin(
          {
            contact: {
              displayName: draft.displayName,
              emails: draft.email ? [draft.email] : [],
              phones: draft.phone ? [draft.phone] : [],
            },
            lead: template,
          },
          crypto.randomUUID(),
          crypto.randomUUID(),
        );
        reloadProtected.current = true;
        await sendLeadCapture(snapshot);
      }
    } catch {
      if (leadCapture.current.isBoundTo(leadCaptureBinding)) {
        setError(
          "Review the captured name, channels, source, intent and timeline before continuing. An unresolved step cannot be replaced.",
        );
        updateLeadCapture((value) => value + 1);
      }
    }
  }
  async function reconcileLeadCapture() {
    const binding = leadCaptureBinding;
    if (!leadCaptureAllowed(binding) || activeLeadCapture.current) return;
    try {
      await sendLeadCapture(leadCapture.current.retry());
    } catch {
      if (leadCapture.current.isBoundTo(binding))
        setError("The original step cannot be resent. Its outcome remains unconfirmed.");
    }
  }
  async function keepCapturedContact() {
    const binding = leadCaptureBinding;
    if (
      !leadCaptureAllowed(binding) ||
      activeLeadCapture.current ||
      !leadCapture.current.keepContactAndClose()
    )
      return;
    leadDraftBinding.current = null;
    currentLeadCaptureDraft.current = null;
    setLeadCaptureDraft(null);
    setDirty(false);
    setModal(null);
    setError("");
    setNotice("The saved contact is kept. No lead was created by a confirmed command in this capture.");
    updateLeadCapture((value) => value + 1);
    if (retainedSession.current) await refresh(retainedSession.current);
  }
  function forgetLeadRecovery(expectedCommand = leadSnapshot.command) {
    const ui = currentLeadCaptureUI.current;
    if (
      !contactLifetimeActive.current ||
      !leadCapture.current.isBoundTo(leadCaptureBinding) ||
      currentLeadCaptureBinding.current !== leadCaptureBinding ||
      ui.binding !== leadCaptureBinding ||
      ui.modal !== "lead" ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      activeLeadCapture.current ||
      leadCapture.current.getSnapshot().command !== expectedCommand ||
      !leadCapture.current.forget()
    )
      return;
    activeLeadCapture.current = null;
    leadDraftBinding.current = null;
    currentLeadCaptureDraft.current = null;
    setLeadCaptureDraft(null);
    setDirty(false);
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateLeadCapture((value) => value + 1);
  }
  function taskCreateAllowed(binding: string | null, ownCommand?: TaskCreateCommand) {
    const ui = currentTaskCreateUI.current;
    return (
      taskCreate.current.isBoundTo(binding) &&
      taskCreate.current.getSnapshot().phase !== "forgotten" &&
      taskCreateEligible(binding, {
        binding: currentTaskCreateBinding.current,
        active: contactLifetimeActive.current,
        online: ui.online && navigator.onLine,
        visible: ui.visible && document.visibilityState === "visible",
        changingOrganization: ui.changingOrganization,
        modal: ui.modal,
        busy: ui.busy && (!ownCommand || activeTaskCreate.current !== ownCommand),
        loading: ui.loading,
        detailLoading: ui.detailLoading,
        otherProtected: Boolean(
          currentContactUI.current.noteDirty ||
            currentContactUI.current.tagDirty ||
            cmsProtected.current ||
            campaignProtected.current ||
            notificationProtected.current ||
            invitationTransfer ||
            taskEdit.current.getSnapshot().command ||
            contactEdit.current.getSnapshot().command ||
            leadCapture.current.getSnapshot().sequence ||
            stageTransition.current.getSnapshot().command ||
            leadAssignment.current.getSnapshot().command ||
            recordArchive.current.getSnapshot().command ||
            contactMerge.current.getSnapshot().command,
        ),
      })
    );
  }
  function clearTaskCreateAccess() {
    taskCreate.current.bind(null);
    currentTaskCreateBinding.current = null;
    activeTaskCreate.current = null;
    taskDraftBinding.current = null;
    currentTaskCreateDraft.current = null;
    setTaskCreateDraft(null);
    setTaskCreateDenied(true);
    if (currentTaskCreateUI.current.modal === "task") setDirty(false);
    updateTaskCreate((value) => value + 1);
  }
  async function sendTaskCreate(original: TaskCreateCommand) {
    const active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !taskCreate.current.isCurrent(original) ||
      !taskCreateAllowed(original.context) ||
      activeTaskCreate.current ||
      !taskCreate.current.canRetry(original)
    ) {
      if (
        contactLifetimeActive.current &&
        taskCreate.current.isCurrent(original) &&
        !activeTaskCreate.current
      ) {
        taskCreate.current.reject(original, new Error("Task send unavailable."));
        updateTaskCreate((value) => value + 1);
      }
      return;
    }
    activeTaskCreate.current = original;
    reloadProtected.current = true;
    ++refreshEpoch.current;
    ++detailEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setSelectedLead(null);
    setSelectedTask(null);
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setBusy(true);
    setError("");
    setNotice("");
    updateTaskCreate((value) => value + 1);
    try {
      const receipt = await taskCreateRequest(active.activeOrgId, original, currentTaskCreateUI.current.csrf);
      if (!contactLifetimeActive.current || !taskCreate.current.isCurrent(original)) return;
      if (!taskCreate.current.acknowledge(original, receipt.data, receipt.etag)) {
        setError(
          "Task creation may have completed, but its receipt could not be verified. Reconcile the original command.",
        );
        updateTaskCreate((value) => value + 1);
        return;
      }
      const readCurrent = taskCreateAllowed(original.context, original);
      taskDraftBinding.current = null;
      currentTaskCreateDraft.current = null;
      setTaskCreateDraft(null);
      setModal(null);
      setDirty(false);
      setNotice(
        "Task creation acknowledged. Current tasks are read separately; no reminder or calendar synchronization is configured.",
      );
      updateTaskCreate((value) => value + 1);
      if (readCurrent) await refresh(active);
    } catch (err) {
      if (!contactLifetimeActive.current) return;
      const outcome = taskCreate.current.reject(original, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) {
        clearTaskCreateAccess();
        clearLeadAssignmentAccess();
        ++refreshEpoch.current;
        ++detailEpoch.current;
        setData(emptyData);
        setRefreshed(null);
        setSelectedLead(null);
        setSelectedTask(null);
        selectedContactBinding.current = null;
        setSelectedContact(null);
        setContactDraft(null);
        setDetailLoading(false);
        setBusy(false);
      }
      setError(
        outcome === "unknown"
          ? "Task creation unconfirmed. Reconcile only its exact original command."
          : "The first task command was rejected or current access is unavailable. Review current inputs and access before continuing.",
      );
      updateTaskCreate((value) => value + 1);
    } finally {
      if (contactLifetimeActive.current && activeTaskCreate.current === original) {
        activeTaskCreate.current = null;
        setBusy(false);
      }
    }
  }
  async function saveTask() {
    const draft = currentTaskCreateDraft.current;
    if (
      !taskCreateAllowed(taskCreateBinding) ||
      taskDraftBinding.current !== taskCreateBinding ||
      !draft ||
      taskCreate.current.getSnapshot().command ||
      activeTaskCreate.current
    )
      return;
    try {
      const timing = captureTaskCreateTiming(draft.dueAt, (value) => ({
        dueAt: new Date(value).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      const input: Schema<"TaskWrite"> = {
        title: draft.title,
        ...(draft.description ? { description: draft.description } : {}),
        dueAt: timing.dueAt,
        timezone: timing.timezone,
        assigneeMemberId: currentTaskCreateUI.current.member,
        leadId: draft.leadId || null,
        priority: draft.priority,
        state: "open",
      };
      const command = taskCreate.current.begin(input, crypto.randomUUID());
      reloadProtected.current = true;
      await sendTaskCreate(command);
    } catch {
      if (contactLifetimeActive.current && taskCreate.current.isBoundTo(taskCreateBinding))
        setError("Task input or its due time is unavailable. Review the form before saving.");
    }
  }
  async function reconcileTaskCreate() {
    if (!taskCreateAllowed(taskCreateBinding) || activeTaskCreate.current) return;
    try {
      await sendTaskCreate(taskCreate.current.retry());
    } catch {
      if (contactLifetimeActive.current && taskCreate.current.isBoundTo(taskCreateBinding))
        setError("The original task command cannot be resent; its outcome remains unconfirmed.");
    }
  }
  function forgetTaskCreate(expected: TaskCreateCommand | null) {
    const ui = currentTaskCreateUI.current;
    if (
      !contactLifetimeActive.current ||
      !taskCreate.current.isBoundTo(taskCreateBinding) ||
      ui.binding !== taskCreateBinding ||
      currentTaskCreateBinding.current !== taskCreateBinding ||
      taskCreate.current.getSnapshot().command !== expected ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      activeTaskCreate.current ||
      !taskCreate.current.forget()
    )
      return;
    activeTaskCreate.current = null;
    taskDraftBinding.current = null;
    currentTaskCreateDraft.current = null;
    setTaskCreateDraft(null);
    setDirty(false);
    ++refreshEpoch.current;
    ++detailEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setSelectedTask(null);
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateTaskCreate((value) => value + 1);
  }

  function clearTaskEditDetail(clearDraft = true) {
    ++detailEpoch.current;
    selectedTaskBinding.current = null;
    selectedTaskETag.current = null;
    currentTaskEditUI.current.task = null;
    setSelectedTask(null);
    setDetailLoading(false);
    if (clearDraft) {
      currentTaskEditDraft.current = null;
      taskEditDraftSource.current = null;
      setTaskEditDraft(null);
      if (currentTaskEditUI.current.detailKind === "task") {
        currentTaskEditUI.current.dirty = false;
        setDirty(false);
      }
    }
  }
  function clearTaskEditAccess() {
    taskEdit.current.bind(null);
    activeTaskEdit.current = null;
    currentTaskEditUI.current.binding = null;
    currentTaskReadBinding.current = null;
    clearTaskEditDetail();
    setTaskEditDenied(true);
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setBusy(false);
    updateTaskEdit((value) => value + 1);
  }
  function applyCurrentTask(task: Task, etag: string, binding: string | null) {
    if (!binding || binding !== currentTaskReadBinding.current) return;
    selectedTaskBinding.current = binding;
    selectedTaskETag.current = etag;
    setSelectedTask(task);
    currentTaskEditUI.current.task = task;
    if (!taskEdit.current.getSnapshot().command && taskEdit.current.getSnapshot().phase !== "forgotten") {
      const baseline = localDateTime(task.dueAt);
      const draft: TaskEditDraft = {
        title: task.title,
        dueLocal: baseline,
        description: task.description ?? "",
        priority: task.priority,
        state: task.state,
      };
      taskEditDraftSource.current = { task, binding, baseline };
      currentTaskEditDraft.current = draft;
      setTaskEditDraft(draft);
    }
  }
  function taskEditAllowed(binding: string | null, taskId: string, allowDirty = false, ownCommand = false) {
    const ui = currentTaskEditUI.current;
    return (
      taskEdit.current.isBoundTo(binding) &&
      taskEditEligible(
        binding,
        {
          binding: ui.binding,
          active: contactLifetimeActive.current,
          online: ui.online && navigator.onLine,
          visible: ui.visible && document.visibilityState === "visible",
          changingOrganization: ui.changingOrganization,
          busy: ui.busy,
          loading: ui.loading,
          detailLoading: ui.detailLoading,
          dirty: allowDirty ? false : ui.dirty,
          otherProtected: Boolean(
            ui.noteDirty ||
              ui.tagDirty ||
              ui.modal ||
              cmsProtected.current ||
              campaignProtected.current ||
              notificationProtected.current ||
              contactEdit.current.getSnapshot().command ||
              leadCapture.current.getSnapshot().sequence ||
              stageTransition.current.getSnapshot().command ||
              leadAssignment.current.getSnapshot().command ||
              currentAssignmentDraft.current ||
              taskCreate.current.getSnapshot().command ||
              recordArchive.current.getSnapshot().command ||
              contactMerge.current.getSnapshot().command ||
              (!ownCommand && taskEdit.current.getSnapshot().command),
          ),
          taskId,
        },
        taskId,
      )
    );
  }
  function changeTaskEditDraft(value: TaskEditDraft, expectedTask: Task | null, binding: string | null) {
    const ui = currentTaskEditUI.current,
      source = taskEditDraftSource.current;
    if (
      !expectedTask ||
      ui.task !== expectedTask ||
      source?.task !== expectedTask ||
      source.binding !== binding ||
      selectedTaskBinding.current !== ui.readBinding ||
      ui.detailKind !== "task" ||
      ui.detailId?.toLowerCase() !== expectedTask.id.toLowerCase() ||
      !taskEditAllowed(binding, expectedTask.id, true) ||
      taskEdit.current.getSnapshot().phase === "forgotten"
    )
      return;
    currentTaskEditDraft.current = value;
    setTaskEditDraft(value);
    currentTaskEditUI.current.dirty = true;
    setDirty(true);
    reloadProtected.current = true;
  }
  async function reviewTaskEdit(
    taskId: string | null,
    binding: string | null,
    expectedGeneration: number,
    ownCommand?: TaskEditCommand,
  ) {
    const ui = currentTaskEditUI.current,
      active = retainedSession.current;
    if (
      !taskId ||
      !active?.activeOrgId ||
      !binding ||
      binding !== currentTaskReadBinding.current ||
      !contactLifetimeActive.current ||
      expectedGeneration !== detailEpoch.current ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      (!ownCommand && (ui.busy || ui.loading || ui.detailLoading)) ||
      (ownCommand && activeTaskEdit.current !== ownCommand)
    )
      return;
    const pending = taskEdit.current.getSnapshot().command;
    const matchingDrawer = ui.detailKind === "task" && ui.detailId?.toLowerCase() === taskId.toLowerCase();
    if (pending ? pending.taskId.toLowerCase() !== taskId.toLowerCase() : !matchingDrawer && !ownCommand)
      return;
    if (
      ui.dirty &&
      !pending &&
      !ownCommand &&
      !window.confirm("Read the current task and discard this unsaved draft?")
    )
      return;
    const generation = ++detailEpoch.current;
    const ticket = { binding, taskId, generation };
    const current = () => ({
      binding: currentTaskReadBinding.current,
      taskId:
        pending && taskEdit.current.isCurrent(pending)
          ? pending.taskId
          : ownCommand && activeTaskEdit.current === ownCommand
            ? ownCommand.taskId
            : currentTaskEditUI.current.detailKind === "task"
              ? currentTaskEditUI.current.detailId
              : null,
      generation: detailEpoch.current,
      active: contactLifetimeActive.current,
      online: currentTaskEditUI.current.online && navigator.onLine,
      visible: currentTaskEditUI.current.visible && document.visibilityState === "visible",
      changingOrganization: currentTaskEditUI.current.changingOrganization,
    });
    selectedTaskBinding.current = null;
    selectedTaskETag.current = null;
    setSelectedTask(null);
    setDetailLoading(true);
    currentTaskEditUI.current.detailLoading = true;
    setDetailError("");
    try {
      const result = await readTaskEditTask(active.activeOrgId, taskId);
      if (!taskEditReadGuard(ticket, current()).displayCurrent) return;
      if (
        currentTaskEditUI.current.detailKind === "task" &&
        currentTaskEditUI.current.detailId?.toLowerCase() === taskId.toLowerCase()
      ) {
        applyCurrentTask(result.data, result.etag, binding);
        if (!taskEdit.current.getSnapshot().command) {
          currentTaskEditUI.current.dirty = false;
          setDirty(false);
        }
      }
      if (ownCommand) setNotice("Task update acknowledged. Current task details were read separately.");
    } catch (error) {
      const disposition = taskEditReadFailureDisposition(
        ticket,
        current(),
        error instanceof ApiError ? error.status : undefined,
      );
      const display = taskEditReadGuard(ticket, current()).displayCurrent;
      if (disposition === "access-denied") clearTaskEditAccess();
      else if (disposition === "source-unavailable") clearTaskEditDetail(!pending);
      if (display && disposition !== "ignore") {
        setDetailError("Current task details are unavailable; assignment or source access may have changed.");
        if (ownCommand) setNotice("Task update acknowledged. Current task details are unavailable.");
      }
    } finally {
      if (contactLifetimeActive.current && generation === detailEpoch.current) {
        currentTaskEditUI.current.detailLoading = false;
        setDetailLoading(false);
      }
    }
  }
  async function sendTaskEdit(command: TaskEditCommand) {
    const ui = currentTaskEditUI.current,
      active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !taskEdit.current.isCurrent(command) ||
      !taskEditAllowed(command.context, command.taskId, true, true) ||
      !taskEdit.current.canRetry(command)
    )
      return;
    reloadProtected.current = true;
    activeTaskEdit.current = command;
    ++detailEpoch.current;
    selectedTaskBinding.current = null;
    selectedTaskETag.current = null;
    setSelectedTask(null);
    setData(emptyData);
    setRefreshed(null);
    currentTaskEditUI.current.dirty = false;
    setDirty(false);
    currentTaskEditUI.current.busy = true;
    setBusy(true);
    setError("");
    setDetailError("");
    updateTaskEdit((value) => value + 1);
    try {
      const result = await taskEditRequest(active.activeOrgId, command, ui.csrf);
      if (!taskEdit.current.isCurrent(command)) return;
      if (!taskEdit.current.acknowledge(command, result.data, result.etag)) {
        setError(
          "Task update unconfirmed. Reconcile the retained original command before leaving this view.",
        );
        return;
      }
      taskEditDraftSource.current = null;
      currentTaskEditDraft.current = null;
      setTaskEditDraft(null);
      setNotice("Task update acknowledged. Reading the current task separately.");
      updateTaskEdit((value) => value + 1);
      await reviewTaskEdit(command.taskId, currentTaskReadBinding.current, detailEpoch.current, command);
      if (
        contactLifetimeActive.current &&
        taskEdit.current.isBoundTo(command.context) &&
        currentTaskEditUI.current.binding === command.context &&
        currentTaskEditUI.current.online &&
        navigator.onLine &&
        currentTaskEditUI.current.visible &&
        document.visibilityState === "visible" &&
        !currentTaskEditUI.current.changingOrganization
      )
        await refresh(active);
    } catch (error) {
      const outcome = taskEdit.current.reject(command, error);
      if (outcome === "ignored") return;
      const draftOwned =
        taskEditDraftSource.current?.binding === command.context &&
        taskEditDraftSource.current.task.id.toLowerCase() === command.taskId.toLowerCase();
      const accessDenied = error instanceof ApiError && [401, 403].includes(error.status);
      if (accessDenied) clearTaskEditAccess();
      else if (error instanceof ApiError && error.status === 404) clearTaskEditDetail(outcome !== "unknown");
      else if (error instanceof ApiError && error.status === 412 && outcome === "cleared") {
        clearTaskEditDetail(false);
        // Only a drawer draft is human input worth protecting; list/agenda completion has none.
        if (draftOwned) {
          currentTaskEditUI.current.dirty = true;
          setDirty(true);
        }
      } else if (outcome === "cleared" && draftOwned && taskEditDraftSource.current) {
        // A known initial rejection retains the human draft and its original timing baseline.
        currentTaskEditUI.current.dirty = true;
        setDirty(true);
        setTaskEditDraft(currentTaskEditDraft.current);
        if (
          ui.detailKind === "task" &&
          ui.detailId?.toLowerCase() === command.taskId.toLowerCase() &&
          ui.online &&
          navigator.onLine &&
          ui.visible &&
          document.visibilityState === "visible"
        ) {
          selectedTaskBinding.current = currentTaskReadBinding.current;
          selectedTaskETag.current = command.ifMatch;
          setSelectedTask(taskEditDraftSource.current.task);
          currentTaskEditUI.current.task = taskEditDraftSource.current.task;
        }
      }
      setError(
        outcome === "unknown"
          ? "Task update unconfirmed. Its original input, key and revision remain in this tab."
          : "The task update was rejected or access is unavailable. Review the current task before another attempt.",
      );
      // A definitive rejection released the command; reload the lists cleared before sending.
      if (
        outcome === "cleared" &&
        !draftOwned &&
        !accessDenied &&
        contactLifetimeActive.current &&
        taskEdit.current.isBoundTo(command.context) &&
        currentTaskEditUI.current.binding === command.context &&
        currentTaskEditUI.current.online &&
        navigator.onLine &&
        currentTaskEditUI.current.visible &&
        document.visibilityState === "visible" &&
        !currentTaskEditUI.current.changingOrganization
      )
        await refresh(active);
    } finally {
      if (activeTaskEdit.current === command && contactLifetimeActive.current) {
        activeTaskEdit.current = null;
        currentTaskEditUI.current.busy = false;
        setBusy(false);
        updateTaskEdit((value) => value + 1);
      }
    }
  }
  async function saveTaskEdit(expectedTask: Task | null, binding: string | null) {
    const ui = currentTaskEditUI.current,
      draft = currentTaskEditDraft.current,
      source = taskEditDraftSource.current;
    if (
      !expectedTask ||
      !draft ||
      !source ||
      source.task !== expectedTask ||
      ui.task !== expectedTask ||
      source.binding !== binding ||
      ui.detailKind !== "task" ||
      ui.detailId?.toLowerCase() !== expectedTask.id.toLowerCase() ||
      selectedTaskBinding.current !== currentTaskReadBinding.current ||
      !taskEditAllowed(binding, expectedTask.id, true) ||
      taskEdit.current.getSnapshot().phase === "forgotten"
    )
      return;
    try {
      const timing = resolveTaskDrawerTiming(expectedTask, source.baseline, draft.dueLocal, (value) => ({
        dueAt: new Date(value).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }));
      const body: Schema<"TaskWrite"> = {
        title: draft.title,
        assigneeMemberId: expectedTask.assigneeMemberId,
        ...timing,
        priority: draft.priority,
        state: draft.state,
        ...(Object.hasOwn(expectedTask, "leadId") ? { leadId: expectedTask.leadId } : {}),
        ...(draft.description !== (expectedTask.description ?? "") ||
        typeof expectedTask.description === "string"
          ? { description: draft.description }
          : {}),
      };
      const command = taskEdit.current.begin(
        {
          task: expectedTask,
          body,
          ...(selectedTaskETag.current ? { ifMatch: selectedTaskETag.current } : {}),
        },
        crypto.randomUUID(),
      );
      reloadProtected.current = true;
      await sendTaskEdit(command);
    } catch {
      if (contactLifetimeActive.current && currentTaskEditUI.current.binding === binding)
        setDetailError(
          "Task input or timing could not be verified. Review the current task and your draft before saving.",
        );
    }
  }
  async function completeTask(task: Task) {
    const binding = taskEditBinding,
      ui = currentTaskEditUI.current;
    if (
      !taskEditAllowed(binding, task.id) ||
      reloadProtected.current ||
      taskEdit.current.getSnapshot().phase === "forgotten"
    )
      return;
    // Agenda rows are detached snapshots; the command must start from the loaded current row.
    const row = ui.tasks.find(
      (candidate) =>
        candidate.id.toLowerCase() === task.id.toLowerCase() &&
        candidate.version === task.version &&
        candidate.state === "open",
    );
    if (!row) return;
    try {
      const original = requireTaskEditTask(row);
      const body: Schema<"TaskWrite"> = {
        title: original.title,
        assigneeMemberId: original.assigneeMemberId,
        dueAt: original.dueAt,
        timezone: original.timezone,
        priority: original.priority,
        state: "done",
        ...(Object.hasOwn(original, "leadId") ? { leadId: original.leadId } : {}),
        ...(typeof original.description === "string" ? { description: original.description } : {}),
      };
      const command = taskEdit.current.begin({ task: original, body }, crypto.randomUUID());
      reloadProtected.current = true;
      await sendTaskEdit(command);
    } catch {
      if (contactLifetimeActive.current && currentTaskEditUI.current.binding === binding)
        setError("Task completion input is unavailable. Refresh current task records before trying again.");
    }
  }
  async function reconcileTaskEdit(expectedCommand: TaskEditCommand | null) {
    if (
      !expectedCommand ||
      !taskEdit.current.isCurrent(expectedCommand) ||
      !taskEditAllowed(expectedCommand.context, expectedCommand.taskId, true, true)
    )
      return;
    try {
      await sendTaskEdit(taskEdit.current.retry());
    } catch {
      if (taskEdit.current.isCurrent(expectedCommand))
        setError("The original task update cannot currently be resent. Its outcome remains unconfirmed.");
    }
  }
  function forgetTaskEdit(expectedCommand: TaskEditCommand | null) {
    const ui = currentTaskEditUI.current;
    if (
      !expectedCommand ||
      !contactLifetimeActive.current ||
      !taskEdit.current.isCurrent(expectedCommand) ||
      !taskEdit.current.isBoundTo(ui.binding) ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      ui.changingOrganization ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      activeTaskEdit.current ||
      !taskEdit.current.forget()
    )
      return;
    activeTaskEdit.current = null;
    clearTaskEditDetail();
    setError("");
    setDetailError("");
    setNotice("");
    setData(emptyData);
    setRefreshed(null);
    currentTaskEditUI.current.dirty = false;
    setDirty(false);
    releaseForgottenRecoveryProtection();
    updateTaskEdit((value) => value + 1);
  }
  function clearLeadAssignmentDetail() {
    ++detailEpoch.current;
    selectedLeadBinding.current = null;
    selectedLeadETag.current = null;
    currentAssignmentUI.current.lead = null;
    setSelectedLead(null);
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setDetailLoading(false);
  }
  function clearLeadAssignmentAccess() {
    leadAssignment.current.bind(null);
    currentAssignmentBinding.current = null;
    currentLeadReadBinding.current = null;
    activeLeadAssignment.current = null;
    currentAssignmentDraft.current = null;
    setAssignmentDraft(null);
    setAssignmentDenied(true);
    clearLeadAssignmentDetail();
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setDirty(false);
    setNoteDirty(false);
    setTagDirty(false);
    setBusy(false);
    updateLeadAssignment((value) => value + 1);
  }
  function assignmentAllowed(binding: string | null, leadId: string, ownCommand?: LeadAssignmentCommand) {
    const ui = currentAssignmentUI.current;
    return (
      leadAssignment.current.isBoundTo(binding) &&
      leadAssignment.current.getSnapshot().phase !== "forgotten" &&
      leadAssignmentEligible(
        binding,
        {
          binding: currentAssignmentBinding.current,
          active: contactLifetimeActive.current,
          online: ui.online && navigator.onLine,
          visible: ui.visible && document.visibilityState === "visible",
          changingOrganization: ui.changingOrganization,
          busy: ui.busy && (!ownCommand || activeLeadAssignment.current !== ownCommand),
          loading: ui.loading,
          detailLoading: ui.detailLoading,
          dirty: ui.dirty,
          leadId: ui.detailKind === "lead" ? ui.detailId : null,
          otherProtected: Boolean(
            ui.modal ||
              ui.noteDirty ||
              ui.tagDirty ||
              cmsProtected.current ||
              campaignProtected.current ||
              notificationProtected.current ||
              invitationTransfer ||
              taskEdit.current.getSnapshot().command ||
              contactEdit.current.getSnapshot().command ||
              leadCapture.current.getSnapshot().sequence ||
              stageTransition.current.getSnapshot().command ||
              taskCreate.current.getSnapshot().command ||
              recordArchive.current.getSnapshot().command ||
              contactMerge.current.getSnapshot().command,
          ),
        },
        leadId,
      )
    );
  }
  async function refreshAssignmentLead(binding: string, leadId: string, ownCommand?: LeadAssignmentCommand) {
    const active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !assignmentAllowed(binding, leadId, ownCommand) ||
      !currentLeadReadBinding.current
    )
      return;
    const readBinding = currentLeadReadBinding.current,
      generation = ++detailEpoch.current;
    const authorityCurrent = () =>
      contactLifetimeActive.current &&
      generation === detailEpoch.current &&
      currentAssignmentBinding.current === binding &&
      currentLeadReadBinding.current === readBinding &&
      currentAssignmentUI.current.detailKind === "lead" &&
      currentAssignmentUI.current.detailId?.toLowerCase() === leadId.toLowerCase();
    const displayCurrent = () =>
      authorityCurrent() &&
      currentAssignmentUI.current.online &&
      navigator.onLine &&
      currentAssignmentUI.current.visible &&
      document.visibilityState === "visible" &&
      !currentAssignmentUI.current.changingOrganization;
    selectedLeadBinding.current = null;
    selectedLeadETag.current = null;
    setSelectedLead(null);
    setSelectedContact(null);
    setDetailLoading(true);
    setDetailError("");
    try {
      const response = await readLeadAssignmentLead(active.activeOrgId, leadId);
      if (!displayCurrent()) return;
      selectedLeadBinding.current = readBinding;
      selectedLeadETag.current = response.etag;
      setSelectedLead(response.data);
      try {
        const contact = await api<Contact>(
          `/v1/orgs/${active.activeOrgId}/contacts/${response.data.contactId}`,
        );
        if (displayCurrent()) setSelectedContact(contact.data);
      } catch (error) {
        if (authorityCurrent() && error instanceof ApiError && error.status === 401)
          clearLeadAssignmentAccess(); /* A Contact-specific 403 is independent of assignment authority. */
      }
    } catch (err) {
      const isCurrent = authorityCurrent(),
        canDisplay = displayCurrent();
      if (!isCurrent) return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearLeadAssignmentAccess();
      else clearLeadAssignmentDetail();
      if (canDisplay)
        setDetailError(
          "Current lead details are unavailable. An acknowledged assignment remains acknowledged; it may have moved outside your current view.",
        );
    } finally {
      if (contactLifetimeActive.current && generation === detailEpoch.current) setDetailLoading(false);
    }
  }
  async function sendLeadAssignment(original: LeadAssignmentCommand) {
    const active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !leadAssignment.current.isCurrent(original) ||
      !assignmentAllowed(original.context, original.leadId) ||
      activeLeadAssignment.current ||
      !leadAssignment.current.canRetry(original)
    ) {
      if (
        contactLifetimeActive.current &&
        leadAssignment.current.isCurrent(original) &&
        !activeLeadAssignment.current
      ) {
        leadAssignment.current.reject(original, new Error());
        updateLeadAssignment((value) => value + 1);
      }
      return;
    }
    activeLeadAssignment.current = original;
    reloadProtected.current = true;
    ++refreshEpoch.current;
    clearLeadAssignmentDetail();
    setData(emptyData);
    setRefreshed(null);
    setBusy(true);
    setDetailError("");
    setError("");
    setNotice("");
    updateLeadAssignment((value) => value + 1);
    try {
      const receipt = await leadAssignmentRequest(
        active.activeOrgId,
        original,
        currentAssignmentUI.current.csrf,
      );
      if (!contactLifetimeActive.current || !leadAssignment.current.isCurrent(original)) return;
      if (!leadAssignment.current.acknowledge(original, receipt.data, receipt.etag)) {
        setDetailError(
          "Assignment unconfirmed. Its receipt could not be verified; reconcile the original command.",
        );
        return;
      }
      currentAssignmentDraft.current = null;
      setAssignmentDraft(null);
      setNotice("Assignment acknowledged. Current lead details are read separately.");
      updateLeadAssignment((value) => value + 1);
      await refreshAssignmentLead(original.context, original.leadId, original);
      if (assignmentAllowed(original.context, original.leadId, original)) await refresh(active);
    } catch (err) {
      if (!contactLifetimeActive.current) return;
      const outcome = leadAssignment.current.reject(original, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) clearLeadAssignmentAccess();
      else if (err instanceof ApiError && err.status === 404) {
        clearLeadAssignmentDetail();
        currentAssignmentDraft.current = null;
        setAssignmentDraft(null);
      } else if (outcome === "cleared")
        await refreshAssignmentLead(original.context, original.leadId, original);
      if (currentAssignmentBinding.current === original.context)
        setDetailError(
          outcome === "unknown"
            ? "Assignment unconfirmed. Only the original body, key and record version may be reconciled."
            : "The first assignment was rejected. Review the current lead and member choice before another assignment.",
        );
      updateLeadAssignment((value) => value + 1);
    } finally {
      if (activeLeadAssignment.current === original && contactLifetimeActive.current) {
        activeLeadAssignment.current = null;
        setBusy(false);
      }
    }
  }
  function changeAssignmentTarget(
    value: string | null,
    expectedLead: Lead | null,
    expectedBinding: string | null,
  ) {
    const ui = currentAssignmentUI.current;
    if (
      !expectedLead ||
      ui.lead !== expectedLead ||
      !expectedBinding ||
      currentAssignmentBinding.current !== expectedBinding ||
      !assignmentAllowed(expectedBinding, expectedLead.id) ||
      leadAssignment.current.getSnapshot().command ||
      selectedLeadBinding.current !== currentLeadReadBinding.current ||
      !selectedLeadETag.current
    )
      return;
    const draft = { binding: expectedBinding, leadId: expectedLead.id, target: value };
    currentAssignmentDraft.current = draft;
    setAssignmentDraft(draft);
    reloadProtected.current = true;
  }
  async function saveLeadAssignment(expectedLead: Lead | null, expectedBinding: string | null) {
    const draft = currentAssignmentDraft.current,
      ui = currentAssignmentUI.current;
    if (
      !expectedLead ||
      ui.lead !== expectedLead ||
      !draft ||
      draft.binding !== expectedBinding ||
      currentAssignmentBinding.current !== expectedBinding ||
      draft.leadId.toLowerCase() !== expectedLead.id.toLowerCase() ||
      !assignmentAllowed(draft.binding, expectedLead.id) ||
      leadAssignment.current.getSnapshot().command ||
      selectedLeadBinding.current !== currentLeadReadBinding.current ||
      !selectedLeadETag.current
    )
      return;
    try {
      const command = leadAssignment.current.begin(
        { lead: ui.lead, body: { ownerMemberId: draft.target }, ifMatch: selectedLeadETag.current },
        crypto.randomUUID(),
      );
      reloadProtected.current = true;
      await sendLeadAssignment(command);
    } catch {
      if (leadAssignment.current.isBoundTo(draft.binding))
        setDetailError(
          "The assignment input or current version is unavailable. Refresh current records before continuing.",
        );
    }
  }
  async function reconcileLeadAssignment(expected: LeadAssignmentCommand | null) {
    const original = leadAssignment.current.getSnapshot().command;
    if (
      !original ||
      original !== expected ||
      !assignmentAllowed(original.context, original.leadId) ||
      activeLeadAssignment.current
    )
      return;
    try {
      await sendLeadAssignment(leadAssignment.current.retry());
    } catch {
      if (leadAssignment.current.isBoundTo(assignmentBinding))
        setDetailError("The original assignment cannot be resent; its outcome remains unconfirmed.");
    }
  }
  function forgetLeadAssignment(expected: LeadAssignmentCommand | null) {
    const ui = currentAssignmentUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !leadAssignment.current.isBoundTo(assignmentBinding) ||
      currentAssignmentBinding.current !== expected.context ||
      leadAssignment.current.getSnapshot().command !== expected ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      activeLeadAssignment.current ||
      !leadAssignment.current.forget()
    )
      return;
    activeLeadAssignment.current = null;
    currentAssignmentDraft.current = null;
    setAssignmentDraft(null);
    clearLeadAssignmentDetail();
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setDirty(false);
    setDetailError("");
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateLeadAssignment((value) => value + 1);
  }
  function returnToAssignment(expected: LeadAssignmentCommand | null) {
    const ui = currentAssignmentUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !leadAssignment.current.isCurrent(expected) ||
      !leadAssignment.current.isBoundTo(expected.context) ||
      currentAssignmentBinding.current !== expected.context ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading
    )
      return;
    router.push("/pipeline?lead=" + encodeURIComponent(expected.leadId));
  }
  async function reviewLeadAssignment(expectedId: string, binding: string | null, generation: number) {
    if (
      !binding ||
      generation !== detailEpoch.current ||
      !assignmentAllowed(binding, expectedId) ||
      leadAssignment.current.getSnapshot().command ||
      currentAssignmentDraft.current
    )
      return;
    await refreshAssignmentLead(binding, expectedId);
  }
  function clearArchiveTargetDetail(kind: RecordArchiveKind) {
    if (kind === "lead") {
      currentAssignmentDraft.current = null;
      setAssignmentDraft(null);
      clearLeadAssignmentDetail();
    } else clearContactSourceDetail();
  }
  function clearRecordArchiveAccess() {
    recordArchive.current.bind(null);
    currentArchiveBinding.current = null;
    currentArchiveUI.current.binding = null;
    setArchiveDenied(true);
    contactMerge.current.bind(null);
    currentContactMergeBinding.current = null;
    setContactMergeDenied(true);
    updateContactMerge((value) => value + 1);
    ++detailEpoch.current;
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    currentAssignmentDraft.current = null;
    setAssignmentDraft(null);
    clearLeadAssignmentDetail();
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setDirty(false);
    setBusy(false);
    updateArchive((value) => value + 1);
  }
  function archiveAllowed(
    binding: string | null,
    kind: RecordArchiveKind,
    resourceId: string,
    ownCommand?: RecordArchiveCommand,
  ) {
    const ui = currentArchiveUI.current,
      retained = recordArchive.current.getSnapshot().command;
    return (
      recordArchive.current.isBoundTo(binding) &&
      recordArchive.current.getSnapshot().phase !== "forgotten" &&
      recordArchiveEligible(
        binding,
        {
          binding: currentArchiveBinding.current,
          active: contactLifetimeActive.current,
          online: ui.online && navigator.onLine,
          visible: ui.visible && document.visibilityState === "visible",
          changingOrganization: ui.changingOrganization,
          busy: ui.busy && !(ownCommand && archiveController.current.isActive(ownCommand)),
          loading: ui.loading,
          detailLoading: ui.detailLoading,
          dirty: ui.dirty,
          kind: ui.detailKind,
          resourceId: ui.detailId,
          otherProtected: Boolean(
            ui.modal ||
              ui.noteDirty ||
              ui.tagDirty ||
              cmsProtected.current ||
              campaignProtected.current ||
              notificationProtected.current ||
              invitationTransfer ||
              taskEdit.current.getSnapshot().command ||
              contactEdit.current.getSnapshot().command ||
              leadCapture.current.getSnapshot().sequence ||
              stageTransition.current.getSnapshot().command ||
              leadAssignment.current.getSnapshot().command ||
              currentAssignmentDraft.current ||
              taskCreate.current.getSnapshot().command ||
              contactMerge.current.getSnapshot().command ||
              (retained && retained !== ownCommand),
          ),
        },
        kind,
        resourceId,
      )
    );
  }
  function archiveRefreshAllowed(context: string) {
    const ui = currentArchiveUI.current;
    return (
      contactLifetimeActive.current &&
      recordArchive.current.isBoundTo(context) &&
      currentArchiveBinding.current === context &&
      ui.online &&
      navigator.onLine &&
      ui.visible &&
      document.visibilityState === "visible" &&
      !ui.changingOrganization
    );
  }
  async function runRecordArchive(command: RecordArchiveCommand, mode: "send" | "reconcile") {
    const active = retainedSession.current;
    let dispatched = false;
    const hooks = {
      allowed: () =>
        Boolean(
          active?.activeOrgId &&
            active.activeOrgId.toLowerCase() === command.organizationId.toLowerCase() &&
            retainedSession.current === active,
        ) && archiveAllowed(command.context, command.kind, command.resourceId, command),
      dispatched: () => {
        dispatched = true;
        reloadProtected.current = true;
        ++refreshEpoch.current;
        setData(emptyData);
        setRefreshed(null);
        currentArchiveUI.current.busy = true;
        setBusy(true);
        setDetailError("");
        setError("");
        setNotice("");
        updateArchive((value) => value + 1);
      },
    };
    let outcome: RecordArchiveOutcome;
    try {
      outcome =
        mode === "send"
          ? await archiveController.current.send(command, currentArchiveUI.current.csrf, hooks)
          : await archiveController.current.reconcile(command, currentArchiveUI.current.csrf, hooks);
    } catch {
      if (contactLifetimeActive.current && recordArchive.current.isCurrent(command)) {
        setDetailError("The original archive cannot be resent. Its outcome remains unconfirmed.");
        updateArchive((value) => value + 1);
      }
      return;
    }
    try {
      if (outcome.type === "ignored" || !contactLifetimeActive.current) return;
      if (outcome.type === "denied") {
        clearRecordArchiveAccess();
        return;
      }
      if (outcome.type === "unknown") return;
      if (outcome.type === "acknowledged") {
        const ui = currentArchiveUI.current;
        clearArchiveTargetDetail(command.kind);
        setDirty(false);
        setDetailError("");
        setNotice(
          command.kind === "contact"
            ? "Contact archive acknowledged. Current lists are read separately."
            : "Lead archive acknowledged. Current lists are read separately.",
        );
        if (ui.detailKind === command.kind && ui.detailId?.toLowerCase() === command.resourceId.toLowerCase())
          router.push(`/${ui.view}`);
      } else if (outcome.phase === "unavailable") clearArchiveTargetDetail(command.kind);
      // Lists were cleared before sending; reread them only through the current authorized path.
      if (dispatched && active && archiveRefreshAllowed(command.context)) await refresh(active);
    } finally {
      if (contactLifetimeActive.current) {
        if (dispatched && !archiveController.current.isActive()) {
          currentArchiveUI.current.busy = false;
          setBusy(false);
        }
        updateArchive((value) => value + 1);
      }
    }
  }
  async function startRecordArchive(
    kind: RecordArchiveKind,
    expected: Contact | Lead | null,
    binding: string | null,
  ) {
    const ui = currentArchiveUI.current;
    if (
      !expected ||
      !binding ||
      currentArchiveBinding.current !== binding ||
      !archiveAllowed(binding, kind, expected.id) ||
      recordArchive.current.getSnapshot().command ||
      archiveController.current.isActive() ||
      (kind === "contact"
        ? ui.contact !== expected ||
          !selectedContactBinding.current ||
          selectedContactBinding.current !== currentContactBinding.current
        : ui.lead !== expected ||
          !selectedLeadBinding.current ||
          selectedLeadBinding.current !== currentLeadReadBinding.current ||
          selectedLeadETag.current !== `"${expected.version}"`)
    )
      return;
    let command: RecordArchiveCommand;
    try {
      command = archiveController.current.begin(
        { kind, resourceId: expected.id, version: expected.version },
        crypto.randomUUID(),
      );
    } catch {
      if (recordArchive.current.isBoundTo(binding))
        setDetailError(
          "The archive target or its current version is unavailable. Read the current record first.",
        );
      return;
    }
    reloadProtected.current = true;
    await runRecordArchive(command, "send");
  }
  async function reconcileRecordArchive(expected: RecordArchiveCommand | null) {
    if (
      !expected ||
      !recordArchive.current.isCurrent(expected) ||
      recordArchive.current.getSnapshot().command !== expected ||
      archiveController.current.isActive()
    )
      return;
    await runRecordArchive(expected, "reconcile");
  }
  function forgetRecordArchive(expected: RecordArchiveCommand | null) {
    const ui = currentArchiveUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !recordArchive.current.isBoundTo(ui.binding) ||
      currentArchiveBinding.current !== expected.context ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      !archiveController.current.forget(expected)
    )
      return;
    clearArchiveTargetDetail(expected.kind);
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setDirty(false);
    setDetailError("");
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateArchive((value) => value + 1);
  }
  function returnToArchive(expected: RecordArchiveCommand | null) {
    const ui = currentArchiveUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !recordArchive.current.isCurrent(expected) ||
      currentArchiveBinding.current !== expected.context ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading
    )
      return;
    router.push(
      expected.kind === "contact"
        ? "/contacts?contact=" + encodeURIComponent(expected.resourceId)
        : "/pipeline?lead=" + encodeURIComponent(expected.resourceId),
    );
  }
  function mergeAllowed(binding: string | null, survivorId: string | null, ownCommand?: ContactMergeCommand) {
    if (!binding || !survivorId) return false;
    const ui = currentContactMergeUI.current;
    const retained = contactMerge.current.getSnapshot().command;
    return (
      contactMerge.current.isBoundTo(binding) &&
      contactMerge.current.getSnapshot().phase !== "forgotten" &&
      contactMergeEligible(
        binding,
        {
          binding: currentContactMergeBinding.current,
          active: contactLifetimeActive.current,
          online: ui.online && navigator.onLine,
          visible: ui.visible && document.visibilityState === "visible",
          changingOrganization: ui.changingOrganization,
          busy: ui.busy && !(ownCommand && contactMergeController.current.isActive(ownCommand)),
          loading: ui.loading,
          detailLoading: ui.detailLoading,
          dirty: ui.dirty,
          kind: ui.kind,
          resourceId: ui.resourceId,
          otherProtected: Boolean(
            ui.modal ||
              ui.noteDirty ||
              ui.tagDirty ||
              cmsProtected.current ||
              campaignProtected.current ||
              notificationProtected.current ||
              invitationTransfer ||
              taskEdit.current.getSnapshot().command ||
              contactEdit.current.getSnapshot().command ||
              leadCapture.current.getSnapshot().sequence ||
              stageTransition.current.getSnapshot().command ||
              leadAssignment.current.getSnapshot().command ||
              currentAssignmentDraft.current ||
              taskCreate.current.getSnapshot().command ||
              recordArchive.current.getSnapshot().command ||
              (retained && retained !== ownCommand),
          ),
        },
        survivorId,
      )
    );
  }
  function mergeRefreshAllowed(context: string) {
    const ui = currentContactMergeUI.current;
    return (
      contactLifetimeActive.current &&
      contactMerge.current.isBoundTo(context) &&
      currentContactMergeBinding.current === context &&
      ui.online &&
      navigator.onLine &&
      ui.visible &&
      document.visibilityState === "visible" &&
      !ui.changingOrganization
    );
  }
  async function runContactMerge(command: ContactMergeCommand, mode: "send" | "reconcile") {
    const active = retainedSession.current;
    let dispatched = false;
    const hooks = {
      allowed: () =>
        Boolean(
          active?.activeOrgId &&
            active.activeOrgId.toLowerCase() === command.organizationId.toLowerCase() &&
            retainedSession.current === active,
        ) && mergeAllowed(command.context, command.survivorId, command),
      dispatched: () => {
        dispatched = true;
        reloadProtected.current = true;
        currentContactMergeUI.current.busy = true;
        setBusy(true);
        setDetailError("");
        setError("");
        setNotice("");
        updateContactMerge((value) => value + 1);
      },
    };
    let outcome: ContactMergeOutcome;
    try {
      outcome =
        mode === "send"
          ? await contactMergeController.current.send(command, currentContactMergeUI.current.csrf, hooks)
          : await contactMergeController.current.reconcile(
              command,
              currentContactMergeUI.current.csrf,
              hooks,
            );
    } catch {
      if (contactLifetimeActive.current && contactMerge.current.isCurrent(command)) {
        setDetailError("The original merge cannot be resent. Its outcome remains unconfirmed.");
        updateContactMerge((value) => value + 1);
      }
      return;
    }
    try {
      if (outcome.type === "ignored" || !contactLifetimeActive.current) return;
      if (outcome.type === "denied") {
        contactMerge.current.bind(null);
        currentContactMergeBinding.current = null;
        setContactMergeDenied(true);
        updateContactMerge((value) => value + 1);
        return;
      }
      if (outcome.type === "unknown") return;
      if (outcome.type === "acknowledged") {
        setSelectedSourceContact(null);
        setDirty(false);
        setDetailError("");
        ++refreshEpoch.current;
        setData(emptyData);
        setRefreshed(null);
        setNotice("Merge acknowledged. Contact lists are read separately.");
      } else if (outcome.phase === "unavailable") {
        setSelectedSourceContact(null);
      }
      if (dispatched && active && mergeRefreshAllowed(command.context)) await refresh(active);
    } finally {
      if (contactLifetimeActive.current) {
        if (dispatched && !contactMergeController.current.isActive()) {
          currentContactMergeUI.current.busy = false;
          setBusy(false);
        }
        updateContactMerge((value) => value + 1);
      }
    }
  }
  async function startContactMerge(source: Contact, phoneOnly: boolean) {
    if (
      !selectedContact ||
      !contactMergeBinding ||
      !mergeAllowed(contactMergeBinding, selectedContact.id) ||
      contactMerge.current.getSnapshot().command ||
      contactMergeController.current.isActive() ||
      !selectedContactBinding.current ||
      selectedContactBinding.current !== currentContactBinding.current
    )
      return;
    setSelectedSourceContact({ contact: source, phoneOnly });
    if (phoneOnly) {
      try {
        contactMerge.current.showPhoneOnlyWarning({
          survivorId: selectedContact.id,
          sourceId: source.id,
          survivorVersion: selectedContact.version,
          sourceVersion: source.version,
        });
      } catch {
        // ignore — panel will handle idle state
      }
    }
    updateContactMerge((value) => value + 1);
  }
  async function confirmContactMerge(acknowledgePhoneOnly = false) {
    if (
      !selectedContact ||
      !selectedSourceContact ||
      !contactMergeBinding ||
      contactMerge.current.getSnapshot().command ||
      contactMergeController.current.isActive()
    )
      return;
    let command: ContactMergeCommand;
    try {
      command = contactMergeController.current.begin(
        {
          survivorId: selectedContact.id,
          sourceId: selectedSourceContact.contact.id,
          survivorVersion: selectedContact.version,
          sourceVersion: selectedSourceContact.contact.version,
          acknowledgePhoneOnly,
        },
        crypto.randomUUID(),
      );
    } catch {
      if (contactMerge.current.isBoundTo(contactMergeBinding))
        setDetailError("Merge target or its version is unavailable. Read the current record first.");
      return;
    }
    reloadProtected.current = true;
    await runContactMerge(command, "send");
  }
  async function reconcileContactMerge(expected: ContactMergeCommand | null) {
    if (
      !expected ||
      !contactMerge.current.isCurrent(expected) ||
      contactMerge.current.getSnapshot().command !== expected ||
      contactMergeController.current.isActive()
    )
      return;
    await runContactMerge(expected, "reconcile");
  }
  function forgetContactMerge(expected: ContactMergeCommand | null) {
    const ui = currentContactMergeUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !contactMerge.current.isBoundTo(ui.binding) ||
      currentContactMergeBinding.current !== expected.context ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      !contactMergeController.current.forget(expected)
    )
      return;
    setSelectedSourceContact(null);
    ++refreshEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setDirty(false);
    setDetailError("");
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateContactMerge((value) => value + 1);
  }
  function returnToMerge(expected: ContactMergeCommand | null) {
    const ui = currentContactMergeUI.current;
    if (
      !expected ||
      !contactLifetimeActive.current ||
      !contactMerge.current.isCurrent(expected) ||
      currentContactMergeBinding.current !== expected.context ||
      !ui.online ||
      !navigator.onLine ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading
    )
      return;
    router.push("/contacts?contact=" + encodeURIComponent(expected.survivorId));
  }
  function stageAllowed(binding: string | null, ownCommand?: StageTransitionCommand) {
    const ui = currentStageUI.current;
    return (
      stageTransition.current.isBoundTo(binding) &&
      stageTransition.current.getSnapshot().phase !== "forgotten" &&
      stageTransitionEligible(binding, {
        binding: currentStageBinding.current,
        active: contactLifetimeActive.current,
        online: ui.online && navigator.onLine,
        visible: ui.visible && document.visibilityState === "visible",
        changingOrganization: ui.changingOrganization,
        busy: ui.busy && (!ownCommand || activeStageTransition.current !== ownCommand),
        loading: ui.loading,
        detailLoading: ui.detailLoading,
        dirty: ui.dirty,
        otherProtected: Boolean(
          ui.modal ||
            currentContactUI.current.noteDirty ||
            currentContactUI.current.tagDirty ||
            cmsProtected.current ||
            campaignProtected.current ||
            notificationProtected.current ||
            invitationTransfer ||
            taskEdit.current.getSnapshot().command ||
            contactEdit.current.getSnapshot().command ||
            leadCapture.current.getSnapshot().sequence ||
            taskCreate.current.getSnapshot().command ||
            recordArchive.current.getSnapshot().command ||
            contactMerge.current.getSnapshot().command,
        ),
      })
    );
  }
  function invalidateStageAccess() {
    stageTransition.current.bind(null);
    currentStageBinding.current = null;
    activeStageTransition.current = null;
    setStageDenied(true);
    ++refreshEpoch.current;
    ++detailEpoch.current;
    setData(emptyData);
    setRefreshed(null);
    setSelectedLead(null);
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setDetailLoading(false);
    setBusy(false);
    updateStageTransition((value) => value + 1);
  }
  async function sendStageTransition(original: StageTransitionCommand) {
    const active = retainedSession.current;
    if (
      !active?.activeOrgId ||
      !stageTransition.current.isCurrent(original) ||
      !stageAllowed(original.context) ||
      activeStageTransition.current ||
      !stageTransition.current.canRetry(original)
    ) {
      if (
        contactLifetimeActive.current &&
        stageTransition.current.isCurrent(original) &&
        !activeStageTransition.current
      ) {
        stageTransition.current.reject(original, new Error("Stage send unavailable."));
        updateStageTransition((value) => value + 1);
      }
      return;
    }
    activeStageTransition.current = original;
    reloadProtected.current = true;
    ++refreshEpoch.current;
    ++detailEpoch.current;
    currentStageUI.current.leads = [];
    currentStageUI.current.stages = [];
    setData(emptyData);
    setRefreshed(null);
    setSelectedLead(null);
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setBusy(true);
    setError("");
    setNotice("");
    updateStageTransition((value) => value + 1);
    try {
      const receipt = await stageTransitionRequest(active.activeOrgId, original, currentStageUI.current.csrf);
      if (!contactLifetimeActive.current || !stageTransition.current.isCurrent(original)) return;
      if (!stageTransition.current.acknowledge(original, receipt.data, receipt.etag)) {
        setError(
          "The stage transition may have completed, but its receipt could not be verified. Reconcile the original command.",
        );
        return;
      }
      updateStageTransition((value) => value + 1);
      setNotice("Stage transition acknowledged. Current records are read separately.");
      if (stageAllowed(original.context, original)) await refresh(active);
    } catch (err) {
      if (!contactLifetimeActive.current) return;
      const outcome = stageTransition.current.reject(original, err);
      if (outcome === "ignored") return;
      if (err instanceof ApiError && [401, 403].includes(err.status)) invalidateStageAccess();
      else if (err instanceof ApiError && [404, 412].includes(err.status)) {
        ++refreshEpoch.current;
        setData(emptyData);
        setRefreshed(null);
      }
      setError(
        outcome === "unknown"
          ? "Stage transition unconfirmed. Only its exact original command may be reconciled."
          : err instanceof ApiError && err.status === 412
            ? "The first transition was rejected because the lead changed. Refresh current records before another transition."
            : "The first stage command was rejected or current access is unavailable. Review current records and access before continuing.",
      );
      updateStageTransition((value) => value + 1);
    } finally {
      if (activeStageTransition.current === original && contactLifetimeActive.current) {
        activeStageTransition.current = null;
        setBusy(false);
      }
    }
  }
  async function moveLead(lead: Lead, toStageId: string) {
    if (
      !stageAllowed(stageBinding) ||
      reloadProtected.current ||
      detailId ||
      stageTransition.current.getSnapshot().command
    )
      return;
    const ui = currentStageUI.current;
    const current = ui.leads.find(
      (row) =>
        row.id === lead.id &&
        row.version === lead.version &&
        row.stageId === lead.stageId &&
        row.contactId === lead.contactId &&
        row.sourceId === lead.sourceId,
    );
    if (!current || !ui.stages.some((stage) => stage.id === toStageId)) return;
    try {
      const command = stageTransition.current.begin(
        { lead: current, body: { toStageId, reason: "Moved through workspace pipeline" } },
        crypto.randomUUID(),
      );
      reloadProtected.current = true;
      await sendStageTransition(command);
    } catch {
      if (stageTransition.current.isBoundTo(stageBinding))
        setError("The stage input or revision is unavailable. Refresh current records before continuing.");
    }
  }
  async function reconcileStageTransition() {
    if (!stageAllowed(stageBinding) || activeStageTransition.current) return;
    try {
      await sendStageTransition(stageTransition.current.retry());
    } catch {
      if (stageTransition.current.isBoundTo(stageBinding))
        setError("The original stage command cannot be resent; its outcome remains unconfirmed.");
    }
  }
  function forgetStageTransition(expected: StageTransitionCommand | null) {
    const ui = currentStageUI.current;
    if (
      !contactLifetimeActive.current ||
      !stageTransition.current.isBoundTo(stageBinding) ||
      ui.binding !== stageBinding ||
      currentStageBinding.current !== stageBinding ||
      stageTransition.current.getSnapshot().command !== expected ||
      !ui.visible ||
      document.visibilityState !== "visible" ||
      ui.changingOrganization ||
      ui.busy ||
      ui.loading ||
      ui.detailLoading ||
      activeStageTransition.current ||
      !stageTransition.current.forget()
    )
      return;
    activeStageTransition.current = null;
    ++refreshEpoch.current;
    ++detailEpoch.current;
    currentStageUI.current.leads = [];
    currentStageUI.current.stages = [];
    setData(emptyData);
    setRefreshed(null);
    setSelectedLead(null);
    selectedContactBinding.current = null;
    setSelectedContact(null);
    setContactDraft(null);
    setError("");
    setNotice("");
    releaseForgottenRecoveryProtection();
    updateStageTransition((value) => value + 1);
  }
  async function switchOrganization(id: string) {
    if (taskCreate.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task creation before switching organizations.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before switching organizations.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before switching organizations.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError(
        "Resolve the unfinished lead capture before switching organizations. A saved contact is kept unless you explicitly close its known partial capture.",
      );
      return;
    }
    if (contactEdit.current.getSnapshot().command) {
      setError(
        "Reconcile the unconfirmed contact save before switching organizations. Current-record review does not confirm its outcome.",
      );
      return;
    }
    if (taskEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task update before switching organizations.");
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
    if (taskCreate.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task creation before signing out.");
      return;
    }
    if (recordArchive.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed archive before signing out.");
      return;
    }
    if (leadAssignment.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed lead assignment before leaving this view or changing context.");
      return;
    }
    if (stageTransition.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed stage transition before signing out.");
      return;
    }
    if (leadCapture.current.getSnapshot().sequence) {
      setError(
        "Resolve the unfinished lead capture before signing out. An unconfirmed step cannot be discarded.",
      );
      return;
    }
    if (contactEdit.current.getSnapshot().command) {
      setError(
        "Reconcile the unconfirmed contact save before signing out. Current-record review does not confirm its outcome.",
      );
      return;
    }
    if (taskEdit.current.getSnapshot().command) {
      setError("Reconcile the unconfirmed task update before signing out.");
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
  function openSearchContact(id: string) {
    if (
      currentContactSearch.current !== contactSearchContext ||
      view !== "contacts" ||
      !online ||
      busy ||
      loading ||
      detailLoading ||
      changingOrganization ||
      document.visibilityState !== "visible" ||
      !permission("crm.contacts.read") ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    )
      return;
    if (reloadProtected.current) {
      setError(
        taskEdit.current.getSnapshot().command
          ? "Reconcile the unconfirmed task update before opening contact details."
          : notificationProtected.current
            ? "Reconcile the unconfirmed notification read before opening contact details."
            : "Resolve the current draft or unconfirmed command before opening contact details.",
      );
      return;
    }
    router.push("/contacts?contact=" + encodeURIComponent(id));
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
        taskEdit.current.getSnapshot().command
          ? "Reconcile the unconfirmed task update before opening task details or leaving this view."
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
  // The open Task drawer renders its own recovery panel; avoid a second live region for one command.
  const taskDrawerPanelShown = Boolean(
    detailId &&
      session &&
      detailKind === "task" &&
      !detailLoading &&
      !stagePending &&
      !taskCreatePending &&
      !assignmentSnapshot.command &&
      !contactSnapshot.command &&
      !archiveSnapshot.command &&
      (!taskEditSnapshot.command || detailId.toLowerCase() === taskEditSnapshot.command.taskId.toLowerCase()),
  );

  const taskRows = (tasks: Task[]) =>
    tasks.map((task) => (
      <div className="task-row" key={task.id}>
        <button
          type="button"
          className={`task-check ${task.state === "done" ? "done" : ""}`}
          aria-label={`Complete task: ${task.title}`}
          disabled={task.state !== "open" || busy || !online || !canUpdateTask || taskPending}
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
        if (
          (!taskEdit.current.getSnapshot().command &&
            !contactEdit.current.getSnapshot().command &&
            !leadCapture.current.getSnapshot().sequence &&
            !stageTransition.current.getSnapshot().command &&
            !leadAssignment.current.getSnapshot().command &&
            !taskCreate.current.getSnapshot().command &&
            !recordArchive.current.getSnapshot().command) ||
          !(event.target instanceof Element)
        )
          return;
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
        setError(
          recordArchive.current.getSnapshot().command
            ? "Reconcile the unconfirmed archive before navigating away."
            : leadAssignment.current.getSnapshot().command
              ? "Reconcile the unconfirmed lead assignment before navigating away."
              : taskCreate.current.getSnapshot().command
                ? "Reconcile the unconfirmed task creation before navigating away."
                : stageTransition.current.getSnapshot().command
                  ? "Reconcile the unconfirmed stage transition before navigating away."
                  : contactEdit.current.getSnapshot().command
                    ? "Reconcile the unconfirmed contact save before navigating away. Current-record review does not confirm its outcome."
                    : leadCapture.current.getSnapshot().sequence
                      ? "Resolve the unfinished lead capture before navigating away. An unconfirmed step cannot be discarded."
                      : "Reconcile the unconfirmed task update before navigating away.",
        );
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
                if (contactEdit.current.getSnapshot().command) {
                  event.preventDefault();
                  setError("Reconcile the unconfirmed contact save before leaving this view.");
                  return;
                }
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
          {(taskPending || ["denied", "forgotten"].includes(taskEditSnapshot.phase)) &&
            !taskDrawerPanelShown && (
              <TaskEditPanel
                snapshot={taskEditSnapshot}
                task={null}
                draft={null}
                online={online && !changingOrganization}
                visible={contactVisible}
                busy={busy}
                reading={detailLoading}
                canEdit={Boolean(taskEditBinding)}
                canRead={Boolean(taskReadBinding)}
                canRetry={taskEdit.current.canRetry()}
                onDraftChange={() => {}}
                onReconcile={() => void reconcileTaskEdit(taskEditSnapshot.command)}
                onReview={() =>
                  void reviewTaskEdit(
                    taskEditSnapshot.command?.taskId || (detailKind === "task" ? detailId : null),
                    taskReadBinding,
                    renderedDetailEpoch,
                  )
                }
                onForget={() => forgetTaskEdit(taskEditSnapshot.command)}
              />
            )}
          {(waiting || activatedUpdate) && (
            <div className="connection-banner update" role="status">
              <Download size={19} />
              <span>
                An app update is ready.
                {archivePending
                  ? " Reconcile the unconfirmed archive before updating or reloading."
                  : assignmentPending
                    ? " Reconcile the unconfirmed lead assignment before updating or reloading."
                    : taskCreatePending
                      ? " Reconcile the unconfirmed task creation before updating or reloading."
                      : stagePending
                        ? " Reconcile the unconfirmed stage transition before updating or reloading."
                        : taskPending
                          ? " Reconcile the unconfirmed task update before updating or reloading."
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
          <StageTransitionPanel
            snapshot={stageSnapshot}
            online={online && !changingOrganization}
            visible={
              contactVisible && (typeof document === "undefined" || document.visibilityState === "visible")
            }
            busy={busy || loading || detailLoading}
            canWrite={Boolean(stageBinding) && !stageDenied}
            canRetry={stageTransition.current.canRetry()}
            onReconcile={() => void reconcileStageTransition()}
            onForget={() => forgetStageTransition(stageSnapshot.command)}
          />
          {(contactSnapshot.phase === "forgotten" ||
            leadSnapshot.phase === "forgotten" ||
            taskCreateSnapshot.phase === "forgotten" ||
            assignmentSnapshot.phase === "forgotten" ||
            archiveSnapshot.phase === "forgotten" ||
            contactMergeSnapshot.phase === "forgotten") && (
            <div className="connection-banner" role="status">
              <ShieldCheck size={18} aria-hidden="true" />
              <span>{localRecoveryForgottenWarning}</span>
            </div>
          )}
          {archivePending &&
            (detailKind !== archiveSnapshot.command?.kind ||
              detailId?.toLowerCase() !== archiveSnapshot.command?.resourceId.toLowerCase()) && (
              <div className="connection-banner" role="status">
                <span>
                  An archive remains unconfirmed. Return to its recovery view before another command or
                  leaving this workspace.
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    !online || !contactVisible || busy || loading || detailLoading || changingOrganization
                  }
                  onClick={() => returnToArchive(archiveSnapshot.command)}
                >
                  Return to archive recovery
                </Button>
              </div>
            )}
          {assignmentPending &&
            (detailKind !== "lead" ||
              detailId?.toLowerCase() !== assignmentSnapshot.command?.leadId.toLowerCase()) && (
              <div className="connection-banner" role="status">
                <span>
                  Lead assignment remains unconfirmed. Return to its original recovery view before another
                  command or leaving this workspace.
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    !online || !contactVisible || busy || loading || detailLoading || changingOrganization
                  }
                  onClick={() => returnToAssignment(assignmentSnapshot.command)}
                >
                  Return to assignment recovery
                </Button>
              </div>
            )}
          {contactMergePending &&
            (detailKind !== "contact" ||
              detailId?.toLowerCase() !== contactMergeSnapshot.command?.survivorId.toLowerCase()) && (
              <div className="connection-banner" role="status">
                <ShieldCheck size={18} aria-hidden="true" />
                <span>
                  A contact merge remains unconfirmed. Return to the survivor contact before another command
                  or leaving this workspace.
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    !online || !contactVisible || busy || loading || detailLoading || changingOrganization
                  }
                  onClick={() => returnToMerge(contactMergeSnapshot.command)}
                >
                  Return to merge recovery
                </Button>
              </div>
            )}
          {view !== "properties" &&
            view !== "websites" &&
            view !== "campaigns" &&
            view !== "automations" &&
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

          {contactSnapshot.command &&
            (detailKind !== "contact" ||
              detailId?.toLowerCase() !== contactSnapshot.command.contactId.toLowerCase()) && (
              <div className="connection-banner" role="status">
                <ShieldCheck size={18} aria-hidden="true" />
                <span>A contact save remains unconfirmed in this tab.</span>
                <Button
                  type="button"
                  variant="secondary"
                  style={{ minHeight: 44, whiteSpace: "normal" }}
                  disabled={
                    !online ||
                    busy ||
                    changingOrganization ||
                    !contactVisible ||
                    !contactEditBinding ||
                    noteDirty ||
                    tagDirty ||
                    cmsDirty ||
                    campaignDirty ||
                    notificationPending
                  }
                  onClick={() => {
                    const pending = contactEdit.current.getSnapshot().command;
                    if (
                      !pending ||
                      !contactEdit.current.isBoundTo(contactEditBinding) ||
                      !currentContactUI.current.online ||
                      currentContactUI.current.busy ||
                      currentContactUI.current.detailLoading ||
                      currentContactUI.current.noteDirty ||
                      currentContactUI.current.tagDirty ||
                      currentContactUI.current.modal ||
                      currentContactUI.current.changingOrganization ||
                      cmsProtected.current ||
                      campaignProtected.current ||
                      notificationProtected.current ||
                      taskEdit.current.getSnapshot().command ||
                      document.visibilityState !== "visible"
                    )
                      return;
                    router.push("/contacts?contact=" + encodeURIComponent(pending.contactId));
                  }}
                >
                  Return to unconfirmed contact save
                </Button>
              </div>
            )}
          {leadPending && modal !== "lead" && (
            <div className="connection-banner" role="status">
              <span>An unfinished lead capture remains in this tab.</span>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !online || changingOrganization || !contactVisible}
                onClick={() => {
                  const ui = currentLeadCaptureUI.current;
                  if (
                    !leadCapture.current.getSnapshot().sequence ||
                    !leadCapture.current.isBoundTo(leadCaptureBinding) ||
                    currentLeadCaptureBinding.current !== leadCaptureBinding ||
                    !ui.online ||
                    !navigator.onLine ||
                    !ui.visible ||
                    document.visibilityState !== "visible" ||
                    ui.busy ||
                    ui.loading ||
                    ui.detailLoading ||
                    ui.changingOrganization ||
                    cmsProtected.current ||
                    campaignProtected.current ||
                    notificationProtected.current ||
                    taskEdit.current.getSnapshot().command ||
                    contactEdit.current.getSnapshot().command
                  )
                    return;
                  setModal("lead");
                }}
              >
                Return to unfinished lead capture
              </Button>
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
                  if (leadCapture.current.getSnapshot().sequence) {
                    setError("Resolve the unfinished lead capture before opening Notifications.");
                    return;
                  }
                  if (taskEdit.current.getSnapshot().command) {
                    setError("Reconcile the unconfirmed task update before opening Notifications.");
                    return;
                  }
                  if (contactEdit.current.getSnapshot().command) {
                    setError("Reconcile the unconfirmed contact save before opening Notifications.");
                    return;
                  }
                  router.push("/notifications");
                }}
              >
                Return to notifications
              </Button>
            </div>
          )}
          {!stagePending && !taskCreatePending && !assignmentPending && !taskPending && !archivePending && (
            <>
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
                    setError(
                      "Property access changed. Refresh workspace access before reopening Properties.",
                    );
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
                  memberId={member}
                  onDirty={protectCampaign}
                  onAccessRevoked={() => {
                    router.replace("/dashboard");
                    setError("Campaign access changed. Refresh workspace access before reopening Campaigns.");
                  }}
                />
              )}
              {view === "automations" && (
                <AutomationWorkspace
                  key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
                  session={session}
                  csrf={csrf}
                  online={online}
                  syntheticFeaturesEnabled={syntheticEnabled && !changingOrganization}
                  accessRevision={accessRevision}
                  memberId={member}
                  onDirty={protectAutomation}
                  onAccessRevoked={() => {
                    router.replace("/dashboard");
                    setError("Automation access changed. Refresh workspace access before reopening Automations.");
                  }}
                />
              )}
              {view === "dashboard" && (
                <>
                  {permission("dashboard.read") && session.activeOrgId && (
                    <VerifiedMetrics
                      key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}:metrics`}
                      session={session}
                      memberId={member}
                      accessRevision={accessRevision}
                      refreshMarker={refreshed}
                      online={online}
                      changingOrganization={changingOrganization}
                      onAccessRevoked={() =>
                        setError(
                          "Reporting access changed. Refresh workspace access before reopening the report.",
                        )
                      }
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
                    Snapshot v1 · Current loaded records · All-time record inventory as of refresh · Source:
                    CRM API.
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
                      canComplete={canUpdateTask && Boolean(member)}
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
                      completionPending={false}
                      onReconcile={() => void reconcileTaskEdit(taskEditSnapshot.command)}
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
                    key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}:appointments`}
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
                          Only confirmed activity appears here. Provider workflows are added as their
                          acceptance gates pass.
                        </span>
                      </div>
                    </section>
                  </div>
                </>
              )}

              {view === "contacts" && (
                <ContactsSearch
                  key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}:${scope}`}
                  session={session}
                  memberId={member}
                  accessRevision={accessRevision}
                  scope={scope}
                  online={online}
                  changingOrganization={changingOrganization}
                  refreshMarker={refreshed}
                  stages={data.stages}
                  sources={data.sources}
                  actionsBlocked={busy || loading || detailLoading || unsaved}
                  onOpenContact={openSearchContact}
                  onAccessRevoked={() =>
                    setError(
                      "Contact search access changed. Use Refresh workspace to verify current access before reopening Contacts.",
                    )
                  }
                />
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
                          (dealsTab ? "deals" : captureTab ? "capture" : "board") === item.id
                            ? "page"
                            : undefined
                        }
                        onClick={(event) => {
                          if (
                            busy ||
                            (unsaved &&
                              !window.confirm("Discard unsaved changes and change pipeline section?"))
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
                  sources={data.sources}
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
              {view === "pipeline" &&
                !dealsTab &&
                !captureTab &&
                (!online || !contactVisible || changingOrganization || stagePending) && (
                  <div className="empty" role="status">
                    {stagePending
                      ? "Reconcile the original stage transition before reading the current pipeline."
                      : "Pipeline details are hidden while offline, inactive or switching organizations."}
                  </div>
                )}
              {view === "pipeline" &&
                !dealsTab &&
                !captureTab &&
                online &&
                contactVisible &&
                !changingOrganization &&
                !stagePending && (
                  <>
                  <div className="pipeline-filters" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
                      Intent
                      <select value={pipelineIntentFilter} onChange={(e) => setPipelineIntentFilter(e.target.value)}>
                        <option value="">All</option>
                        <option value="buyer">Buyer</option>
                        <option value="seller">Seller</option>
                        <option value="both">Both</option>
                        <option value="unknown">Unknown</option>
                      </select>
                    </label>
                    {data.sources.length > 0 && (
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
                        Source
                        <select value={pipelineSourceFilter} onChange={(e) => setPipelineSourceFilter(e.target.value)}>
                          <option value="">All sources</option>
                          {data.sources.map((source) => (
                            <option key={source.id} value={source.id}>{source.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="pipeline-board">
                    {data.stages.map((stage) => {
                      const leads = data.leads.filter(
                        (lead) =>
                          lead.stageId === stage.id &&
                          (!pipelineIntentFilter || lead.intent === pipelineIntentFilter) &&
                          (!pipelineSourceFilter || lead.sourceId === pipelineSourceFilter),
                      );
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
                                  disabled={
                                    busy ||
                                    loading ||
                                    !online ||
                                    !stageBinding ||
                                    stageSnapshot.phase === "forgotten" ||
                                    unsaved ||
                                    !contactVisible
                                  }
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
                  </>
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
                  <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "8px 0 12px" }}>
                    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
                      Lead intent
                      <select value={taskIntentFilter} onChange={(e) => setTaskIntentFilter(e.target.value)}>
                        <option value="">All</option>
                        <option value="buyer">Buyer</option>
                        <option value="seller">Seller</option>
                        <option value="both">Both</option>
                        <option value="unknown">Unknown</option>
                      </select>
                    </label>
                    {data.sources.length > 0 && (
                      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, fontWeight: 600 }}>
                        Lead source
                        <select value={taskSourceFilter} onChange={(e) => setTaskSourceFilter(e.target.value)}>
                          <option value="">All sources</option>
                          {data.sources.map((source) => (
                            <option key={source.id} value={source.id}>{source.label}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  {data.tasks.filter((task) => {
                    if (taskFilter !== "all" && task.state !== taskFilter) return false;
                    if (taskIntentFilter || taskSourceFilter) {
                      if (!task.leadId) return false;
                      const lead = data.leads.find((l) => l.id === task.leadId);
                      if (!lead) return false;
                      if (taskIntentFilter && lead.intent !== taskIntentFilter) return false;
                      if (taskSourceFilter && lead.sourceId !== taskSourceFilter) return false;
                    }
                    return true;
                  }).length ? (
                    <div>
                      {taskRows(
                        data.tasks
                          .filter((task) => {
                            if (taskFilter !== "all" && task.state !== taskFilter) return false;
                            if (taskIntentFilter || taskSourceFilter) {
                              if (!task.leadId) return false;
                              const lead = data.leads.find((l) => l.id === task.leadId);
                              if (!lead) return false;
                              if (taskIntentFilter && lead.intent !== taskIntentFilter) return false;
                              if (taskSourceFilter && lead.sourceId !== taskSourceFilter) return false;
                            }
                            return true;
                          })
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
                      Use the complete workspace in your browser or install it on iPhone and Android. No app
                      store needed.
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
                          Open in Safari, use the Share or browser menu, then choose Add to Home Screen. Open
                          the new icon to launch Estate.
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
                      Private records stay on the server. This app caches only original icons, a generic
                      offline page and approved static build assets.
                    </p>
                    <div className="settings-fact">
                      <strong>Offline saving</strong>
                      <Badge>Disabled</Badge>
                    </div>
                    <div className="settings-fact">
                      <strong>App update</strong>
                      <Badge>{waiting ? "Ready" : "No waiting update"}</Badge>
                    </div>
                    {session.activeOrgId && permission("self.push.write") && (
                      <PushSettings
                        organizationId={session.activeOrgId}
                        csrf={csrf}
                        online={online && !changingOrganization}
                        working={busy}
                        setWorking={setBusy}
                      />
                    )}
                    {(!session.activeOrgId || !permission("self.push.write")) && (
                      <div className="settings-fact">
                        <strong>Push notifications</strong>
                        <Badge>Unavailable</Badge>
                      </div>
                    )}
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
            </>
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
          {modal === "lead" ? (
            <LeadCapturePanel
              draft={leadDraftBinding.current === leadCaptureBinding ? leadCaptureDraft : null}
              snapshot={leadSnapshot}
              sources={data.sources}
              online={online && !changingOrganization}
              visible={
                contactVisible && (typeof document === "undefined" || document.visibilityState === "visible")
              }
              busy={busy || loading || detailLoading}
              canCapture={canCapture && !leadCaptureDenied}
              canRetry={leadCapture.current.canRetry()}
              error={error}
              onDraftChange={(draft) => {
                const current = leadCapture.current.getSnapshot();
                if (
                  !leadCaptureAllowed(leadCaptureBinding) ||
                  activeLeadCapture.current ||
                  current.phase === "forgotten" ||
                  current.command ||
                  (current.sequence && current.phase !== "lead-rejected")
                )
                  return;
                leadDraftBinding.current = leadCaptureBinding;
                currentLeadCaptureDraft.current = draft;
                setLeadCaptureDraft(draft);
                setDirty(true);
                reloadProtected.current = true;
              }}
              onSave={() => void saveLead()}
              onReconcile={() => void reconcileLeadCapture()}
              onKeepContact={() => void keepCapturedContact()}
              onForget={() => forgetLeadRecovery(leadSnapshot.command)}
              onClose={closeModal}
            />
          ) : (
            <TaskCreatePanel
              draft={taskDraftBinding.current === taskCreateBinding ? taskCreateDraft : null}
              snapshot={taskCreateSnapshot}
              leads={data.leads}
              leadLabel={nameFor}
              online={online && !changingOrganization}
              visible={
                contactVisible && (typeof document === "undefined" || document.visibilityState === "visible")
              }
              busy={busy || loading || detailLoading}
              canCreate={canTask && Boolean(taskCreateBinding) && !taskCreateDenied}
              canRetry={taskCreate.current.canRetry()}
              deviceTimezone={Intl.DateTimeFormat().resolvedOptions().timeZone || null}
              error={error}
              onDraftChange={(draft) => {
                if (
                  !taskCreateAllowed(taskCreateBinding) ||
                  activeTaskCreate.current ||
                  taskCreate.current.getSnapshot().command
                )
                  return;
                taskDraftBinding.current = taskCreateBinding;
                currentTaskCreateDraft.current = draft;
                setTaskCreateDraft(draft);
                setDirty(true);
                reloadProtected.current = true;
              }}
              onSave={() => void saveTask()}
              onReconcile={() => void reconcileTaskCreate()}
              onForget={() => forgetTaskCreate(taskCreateSnapshot.command)}
              onClose={closeModal}
            />
          )}
        </dialog>
      )}
      {detailId &&
        session &&
        !stagePending &&
        !taskCreatePending &&
        (!taskEditSnapshot.command ||
          (detailKind === "task" &&
            detailId.toLowerCase() === taskEditSnapshot.command.taskId.toLowerCase())) &&
        (!assignmentSnapshot.command ||
          (detailKind === "lead" &&
            detailId.toLowerCase() === assignmentSnapshot.command.leadId.toLowerCase())) &&
        (!contactSnapshot.command ||
          (detailKind === "contact" &&
            detailId.toLowerCase() === contactSnapshot.command.contactId.toLowerCase())) &&
        (!archiveSnapshot.command ||
          (detailKind === archiveSnapshot.command.kind &&
            detailId.toLowerCase() === archiveSnapshot.command.resourceId.toLowerCase())) && (
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
                  {detailKind === "task" && !taskPrivateVisible
                    ? "Task details"
                    : detailKind === "lead" && !leadDetailVisible
                      ? "Lead details"
                      : detailKind === "contact" &&
                          (!online ||
                            !contactVisible ||
                            selectedContactBinding.current !== currentContactBinding.current)
                        ? "Contact details"
                        : selectedContact?.displayName || selectedTask?.title || "Record details"}
                </h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close record details"
                disabled={busy || contactPending || assignmentPending || taskPending || archivePending}
                onClick={closeDetail}
              >
                <X size={21} />
              </button>
            </div>
            {archiveSnapshot.command ? (
              <div className="editor-body">
                {detailError && online && contactVisible && (
                  <div className="error" role="alert">
                    {detailError}
                  </div>
                )}
                <RecordArchivePanel
                  kind={archiveSnapshot.command.kind}
                  resourceId={archiveSnapshot.command.resourceId}
                  snapshot={archiveSnapshot}
                  available={false}
                  online={online && !changingOrganization}
                  visible={
                    contactVisible &&
                    (typeof document === "undefined" || document.visibilityState === "visible")
                  }
                  busy={busy || loading || detailLoading}
                  canArchive={Boolean(archiveBinding) && !archiveDenied}
                  canRetry={recordArchive.current.canRetry()}
                  onArchive={() => {}}
                  onReconcile={() => void reconcileRecordArchive(archiveSnapshot.command)}
                  onForget={() => forgetRecordArchive(archiveSnapshot.command)}
                />
              </div>
            ) : (
              <>
                {detailLoading ? (
                  <div className="empty">Loading authorized record…</div>
                ) : (
                  <form
                    onSubmit={(event) => {
                      if (detailKind === "task") {
                        event.preventDefault();
                        void saveTaskEdit(selectedTask, taskEditBinding);
                      } else void saveDetail(event);
                    }}
                    onChange={() => {
                      if (detailKind !== "task") setDirty(true);
                    }}
                  >
                    <div className="editor-body">
                      {detailError && (detailKind !== "contact" || (online && contactVisible)) && (
                        <div className="error" role="alert">
                          {detailError}
                        </div>
                      )}
                      {detailKind === "contact" && (
                        <ContactEditPanel
                          contact={
                            selectedContactBinding.current === currentContactBinding.current
                              ? selectedContact
                              : null
                          }
                          draft={
                            selectedContactBinding.current === currentContactBinding.current
                              ? contactDraft
                              : null
                          }
                          snapshot={contactSnapshot}
                          online={online && !changingOrganization}
                          visible={contactVisible}
                          busy={busy}
                          reading={detailLoading}
                          canEdit={
                            Boolean(contactEditBinding) &&
                            !contactDenied &&
                            contactSnapshot.phase !== "forgotten"
                          }
                          canRead={Boolean(contactReadBinding) && !contactDenied}
                          canRetry={contactEdit.current.canRetry()}
                          currentReviewed={contactReviewed}
                          onDraftChange={(value) => {
                            if (
                              !contactEdit.current.isBoundTo(contactEditBinding) ||
                              contactEdit.current.getSnapshot().phase === "forgotten" ||
                              contactEdit.current.getSnapshot().command ||
                              selectedContactBinding.current !== currentContactBinding.current ||
                              !currentContactUI.current.online ||
                              document.visibilityState !== "visible"
                            )
                              return;
                            setContactDraft(value);
                            setDirty(true);
                            reloadProtected.current = true;
                          }}
                          onReconcile={() => void reconcileContactEdit()}
                          onReview={() => void reviewContact()}
                          onForget={() => forgetContactRecovery(contactSnapshot.command)}
                        />
                      )}
                      {detailKind === "lead" && selectedLead && leadDetailVisible && (
                        <>
                          <div className="detail-summary">
                            <span className="avatar light">
                              {initials(selectedContact?.displayName || "Lead")}
                            </span>
                            <div>
                              <strong>{selectedContact?.displayName || "Contact unavailable"}</strong>
                              <span>{selectedContact?.emails[0] || "Email unknown"}</span>
                            </div>
                          </div>
                          <label>
                            Intent
                            <select
                              name="intent"
                              defaultValue={selectedLead.intent}
                              disabled={assignmentDirty}
                            >
                              <option value="unknown">Unknown</option>
                              <option value="buyer">Buyer</option>
                              <option value="seller">Seller</option>
                              <option value="both">Buyer & seller</option>
                            </select>
                          </label>
                          <label>
                            Timeline (optional)
                            <input
                              name="timeline"
                              defaultValue={selectedLead.timeline || ""}
                              maxLength={80}
                              disabled={assignmentDirty}
                            />
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
                      {detailKind === "task" && (
                        <TaskEditPanel
                          snapshot={taskEditSnapshot}
                          task={taskPrivateVisible ? selectedTask : null}
                          draft={taskPrivateVisible ? taskEditDraft : null}
                          online={online && !changingOrganization}
                          visible={contactVisible}
                          busy={busy}
                          reading={detailLoading}
                          canEdit={Boolean(taskEditBinding)}
                          canRead={Boolean(taskReadBinding)}
                          canRetry={taskEdit.current.canRetry()}
                          deviceTimezone={Intl.DateTimeFormat().resolvedOptions().timeZone || null}
                          onDraftChange={(value) => changeTaskEditDraft(value, selectedTask, taskEditBinding)}
                          onReconcile={() => void reconcileTaskEdit(taskEditSnapshot.command)}
                          onReview={() => void reviewTaskEdit(detailId, taskReadBinding, renderedDetailEpoch)}
                          onForget={() => forgetTaskEdit(taskEditSnapshot.command)}
                        />
                      )}
                      {(selectedContact || selectedLead || selectedTask) &&
                        (detailKind !== "lead" || leadDetailVisible) &&
                        (detailKind !== "task" || taskPrivateVisible) &&
                        (detailKind !== "contact" ||
                          (online &&
                            contactVisible &&
                            selectedContactBinding.current === currentContactBinding.current)) && (
                          <p className="form-note">
                            <ShieldCheck size={15} />
                            Version{" "}
                            {detailKind === "lead"
                              ? selectedLead?.version
                              : detailKind === "task"
                                ? selectedTask?.version
                                : selectedContact?.version}{" "}
                            ·{" "}
                            {detailKind === "contact" && contactPending
                              ? "Reconciliation retains the original save version."
                              : "Changes require this exact record version."}
                          </p>
                        )}
                    </div>
                    <div className="editor-footer">
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={busy || contactPending || assignmentPending || taskPending}
                        onClick={closeDetail}
                      >
                        Close
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          !dirty ||
                          noteDirty ||
                          tagDirty ||
                          busy ||
                          contactPending ||
                          taskPending ||
                          (detailKind === "task" &&
                            (!taskPrivateVisible || taskEditSnapshot.phase === "forgotten")) ||
                          assignmentPending ||
                          assignmentDirty ||
                          !online ||
                          (detailKind === "contact" &&
                            (!contactVisible ||
                              changingOrganization ||
                              !contactEditBinding ||
                              selectedContactBinding.current !== currentContactBinding.current ||
                              ["conflict", "forgotten"].includes(contactSnapshot.phase))) ||
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
                {detailKind === "lead" && (
                  <LeadAssignmentPanel
                    key={`${leadReadBinding || assignmentBinding || "unavailable"}:${detailId}`}
                    session={session}
                    binding={assignmentBinding}
                    snapshot={assignmentSnapshot}
                    currentLead={assignmentCurrentLead}
                    memberId={member}
                    targetMemberId={
                      assignmentDraft?.binding === assignmentBinding &&
                      assignmentDraft.leadId.toLowerCase() === detailId.toLowerCase()
                        ? assignmentDraft.target
                        : (selectedLead?.ownerMemberId ?? null)
                    }
                    draftChanged={assignmentDirty}
                    canUnassign={false}
                    online={online && !changingOrganization}
                    visible={
                      contactVisible &&
                      (typeof document === "undefined" || document.visibilityState === "visible")
                    }
                    busy={busy || loading || detailLoading || dirty || noteDirty || tagDirty}
                    canAssign={Boolean(assignmentBinding) && !assignmentDenied}
                    canRetry={leadAssignment.current.canRetry()}
                    onTargetChange={(value) => changeAssignmentTarget(value, selectedLead, assignmentBinding)}
                    onSave={() => void saveLeadAssignment(selectedLead, assignmentBinding)}
                    onReconcile={() => void reconcileLeadAssignment(assignmentSnapshot.command)}
                    onForget={() => forgetLeadAssignment(assignmentSnapshot.command)}
                    onIdentityLost={() => {
                      if (
                        contactLifetimeActive.current &&
                        currentAssignmentBinding.current === assignmentBinding
                      )
                        clearLeadAssignmentAccess();
                    }}
                    onReview={
                      leadReadBinding
                        ? () => void reviewLeadAssignment(detailId, assignmentBinding, renderedDetailEpoch)
                        : undefined
                    }
                  />
                )}
                {selectedLead && session.activeOrgId && leadDetailVisible && (
                  <LeadTimeline
                    key={`${session.activeOrgId}:${selectedLead.id}`}
                    lead={selectedLead}
                    organizationId={session.activeOrgId}
                    timezone={timezone}
                    online={online}
                    working={busy}
                    editInProgress={dirty || tagDirty || assignmentDirty}
                    canWrite={permission("crm.leads.write")}
                    onDirty={setNoteDirty}
                    setWorking={setBusy}
                    runCommand={command}
                    onSaved={async () => {
                      const generation = detailEpoch.current;
                      const result = await api<Lead>(
                        `/v1/orgs/${session.activeOrgId}/leads/${selectedLead.id}`,
                      );
                      if (generation !== detailEpoch.current) return;
                      setSelectedLead(result.data);
                      await refresh(session);
                    }}
                  />
                )}
                {selectedLead &&
                  leadDetailVisible &&
                  session.activeOrgId &&
                  permission("crm.tags.read") &&
                  permission("crm.leads.write") && (
                    <LeadTags
                      key={`${session.activeOrgId}:${selectedLead.id}`}
                      lead={selectedLead}
                      organizationId={session.activeOrgId}
                      online={online}
                      working={busy}
                      editInProgress={dirty || noteDirty || assignmentDirty}
                      runCommand={command}
                      onDirty={setTagDirty}
                      setWorking={setBusy}
                      onSaved={async (lead) => {
                        setSelectedLead(lead);
                        await refresh(session);
                      }}
                    />
                  )}
                {detailKind === "contact" && selectedContact && session?.activeOrgId && (
                  <>
                    <ContactDuplicateList
                      key={`${session.activeOrgId}:${selectedContact.id}`}
                      organizationId={session.activeOrgId}
                      survivorContact={selectedContact}
                      canMerge={
                        Boolean(contactMergeBinding) &&
                        !contactMergeDenied &&
                        contactMergeSnapshot.phase !== "forgotten" &&
                        !contactMergeSnapshot.command &&
                        !contactMergeController.current.isActive() &&
                        Boolean(
                          selectedContactBinding.current &&
                            selectedContactBinding.current === currentContactBinding.current,
                        )
                      }
                      online={online && !changingOrganization}
                      onSelectSource={(source, phoneOnly) => void startContactMerge(source, phoneOnly)}
                    />
                    {(selectedSourceContact !== null ||
                      (contactMergeSnapshot.phase !== "idle" &&
                        contactMergeSnapshot.phase !== "forgotten")) && (
                      <ContactMergePanel
                        key={`${contactMergeBinding || "unavailable"}:${selectedContact.id}`}
                        survivorId={selectedContact.id}
                        sourceId={
                          selectedSourceContact?.contact.id ?? contactMergeSnapshot.subject?.sourceId ?? ""
                        }
                        survivorName={selectedContact.displayName}
                        sourceName={selectedSourceContact?.contact.displayName ?? "the source contact"}
                        snapshot={contactMergeSnapshot}
                        available={
                          !detailLoading &&
                          Boolean(
                            selectedContact &&
                              selectedContact.id.toLowerCase() === detailId.toLowerCase() &&
                              selectedContactBinding.current &&
                              selectedContactBinding.current === currentContactBinding.current &&
                              !contactPending,
                          )
                        }
                        online={online && !changingOrganization}
                        visible={
                          contactVisible &&
                          (typeof document === "undefined" || document.visibilityState === "visible")
                        }
                        busy={busy || loading || detailLoading}
                        canMerge={mergeAllowed(contactMergeBinding, selectedContact.id)}
                        canRetry={contactMerge.current.canRetry()}
                        phoneOnlyMatch={selectedSourceContact?.phoneOnly ?? false}
                        onRequest={() => {}}
                        onCancel={() => {}}
                        onConfirm={() => void confirmContactMerge(false)}
                        onConfirmPhoneOnly={() => void confirmContactMerge(true)}
                        onDismissPhoneOnly={() => {
                          contactMerge.current.dismissPhoneOnlyWarning();
                          setSelectedSourceContact(null);
                          updateContactMerge((v) => v + 1);
                        }}
                        onReconcile={() => void reconcileContactMerge(contactMergeSnapshot.command)}
                        onForget={() => forgetContactMerge(contactMergeSnapshot.command)}
                      />
                    )}
                  </>
                )}
                {(detailKind === "contact" || detailKind === "lead") && (
                  <RecordArchivePanel
                    key={`${archiveBinding || "unavailable"}:${detailKind}:${detailId}`}
                    kind={detailKind}
                    resourceId={detailId}
                    snapshot={archiveSnapshot}
                    available={
                      !detailLoading &&
                      (detailKind === "contact"
                        ? Boolean(
                            selectedContact &&
                              selectedContact.id.toLowerCase() === detailId.toLowerCase() &&
                              selectedContactBinding.current &&
                              selectedContactBinding.current === currentContactBinding.current &&
                              !contactPending,
                          )
                        : Boolean(
                            assignmentCurrentLead &&
                              assignmentCurrentLead.id.toLowerCase() === detailId.toLowerCase() &&
                              !assignmentDirty,
                          ))
                    }
                    online={online && !changingOrganization}
                    visible={
                      contactVisible &&
                      (typeof document === "undefined" || document.visibilityState === "visible")
                    }
                    busy={
                      busy || loading || detailLoading || dirty || noteDirty || tagDirty || assignmentDirty
                    }
                    canArchive={
                      Boolean(archiveBinding) &&
                      !archiveDenied &&
                      archiveSnapshot.phase !== "forgotten" &&
                      recordArchiveContextAllows(archiveBinding, detailKind)
                    }
                    canRetry={recordArchive.current.canRetry()}
                    onArchive={() =>
                      void startRecordArchive(
                        detailKind,
                        detailKind === "contact" ? selectedContact : selectedLead,
                        archiveBinding,
                      )
                    }
                    onReconcile={() => void reconcileRecordArchive(archiveSnapshot.command)}
                    onForget={() => forgetRecordArchive(archiveSnapshot.command)}
                  />
                )}
              </>
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
