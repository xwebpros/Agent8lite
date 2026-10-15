import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskCreateView, type TaskCreateViewProps } from "../../apps/web/components/task-create-panel";
import { TaskCreateProtocol, type TaskCreateSnapshot } from "../../apps/web/components/task-create";
const member = "fc000000-0000-4000-8000-000000000001",
  leadId = "fc000000-0000-4000-8000-000000000002",
  key = "fc000000-0000-4000-8000-000000000003",
  source = "fc000000-0000-4000-8000-000000000004",
  stage = "fc000000-0000-4000-8000-000000000005";
const draft = {
  title: "PRIVATE_TITLE",
  description: "PRIVATE_DESCRIPTION",
  dueAt: "2026-11-01T01:30",
  leadId,
  priority: "high" as const,
};
function state(phase: "sending" | "unknown" = "unknown"): TaskCreateSnapshot {
  const protocol = new TaskCreateProtocol();
  protocol.bind("PRIVATE_USER_ORG_MEMBER_CSRF_FULL_GRANTS");
  const command = protocol.begin(
    {
      title: draft.title,
      description: draft.description,
      leadId,
      assigneeMemberId: member,
      dueAt: "2026-11-01T09:30:00.123Z",
      timezone: "US/Pacific",
      priority: "high",
    },
    key,
  );
  if (phase === "unknown") protocol.reject(command, new Error("PRIVATE_PROVIDER_TEXT"));
  return protocol.getSnapshot();
}
function render(patch: Partial<TaskCreateViewProps> = {}) {
  return renderToStaticMarkup(
    <TaskCreateView
      draft={draft}
      snapshot={{ command: null, phase: "idle" }}
      leads={[
        { id: leadId, contactId: member, sourceId: source, stageId: stage, intent: "buyer", version: 1 },
      ]}
      leadLabel={() => "PRIVATE_LEAD_LABEL"}
      online
      visible
      busy={false}
      canCreate
      canRetry
      deviceTimezone="US/Pacific"
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onReconcile={vi.fn()}
      onForget={vi.fn()}
      onClose={vi.fn()}
      {...patch}
    />,
  );
}
function button(html: string, name: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([value]) => value.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}
function noPrivate(html: string) {
  for (const value of [
    draft.title,
    draft.description,
    draft.dueAt,
    leadId,
    member,
    key,
    source,
    stage,
    "US/Pacific",
    "2026-11-01T09:30:00.123Z",
    "PRIVATE_LEAD_LABEL",
    "PRIVATE_USER_ORG_MEMBER_CSRF_FULL_GRANTS",
    "PRIVATE_PROVIDER_TEXT",
  ])
    expect(html).not.toContain(value);
}
describe("Task creation native presentation and private recovery states", () => {
  it("offers labeled native form and one-time UTC capture with no calendar/reminder claim", () => {
    const html = render();
    for (const value of [
      "Title",
      "Description (optional)",
      "Due date and time",
      "Lead (optional)",
      "Priority",
      "captured once as a UTC instant",
      "Calendar synchronization and reminders are not configured",
    ])
      expect(html).toContain(value);
    expect(html).toContain('type="datetime-local"');
    expect(button(html, "Save task")).not.toContain("disabled");
  });
  it("unknown exposes only original reconciliation without private command fields, form, close or replacement", () => {
    const html = render({ snapshot: state() });
    noPrivate(html);
    expect(button(html, "Reconcile task creation")).not.toContain("disabled");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Save task");
    expect(html).not.toContain("Cancel");
    expect(html).toContain("may have completed");
    expect(html).toContain("Current tasks are read separately");
  });
  it("sending disables resend and has no replacement or forgetting action", () => {
    const html = render({ snapshot: state("sending"), canRetry: false });
    noPrivate(html);
    expect(html).toContain("Confirming task creation");
    expect(button(html, "Reconcile task creation")).toContain("disabled");
    expect(html).not.toContain("Clear this tab");
  });
  it.each([
    { online: false },
    { visible: false },
    { canCreate: false },
    { snapshot: { ...state(), phase: "denied" as const } },
  ])("privacy/access cut %j withholds all stale draft/command/source values", (patch) => {
    const html = render({ snapshot: state(), error: "PRIVATE_PROVIDER_TEXT", ...patch });
    noPrivate(html);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(button(html, "Reconcile task creation")).toContain("disabled");
  });
  it.each([{ online: false }, { visible: false }, { canCreate: false }])(
    "ordinary private draft also withheld after %j",
    (patch) => {
      noPrivate(render({ ...patch, error: "PRIVATE_PROVIDER_TEXT" }));
    },
  );
  it("expired unknown remains unresolved and allows only visible local forgetting", () => {
    const html = render({ snapshot: state(), canRetry: false, online: false });
    noPrivate(html);
    expect(button(html, "Reconcile task creation")).toContain("disabled");
    expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    expect(html).toContain("does not cancel or undo");
    expect(html).not.toContain("Cancel");
  });
  it.each([{ visible: false }, { busy: true }, { canCreate: false }])(
    "local forget native guard %j remains disabled",
    (patch) => {
      expect(
        button(render({ snapshot: state(), canRetry: false, ...patch }), "Clear this tab’s recovery data"),
      ).toContain("disabled");
    },
  );
  it("forgotten state ignores stale values and warns possible duplication without a replacement form", () => {
    const html = render({ snapshot: { ...state(), phase: "forgotten" }, error: "PRIVATE_PROVIDER_TEXT" });
    noPrivate(html);
    expect(html).toContain("duplicate");
    expect(html).toContain("Close editor");
    expect(html).not.toContain("Save task");
    expect(html).not.toContain("Reconcile task creation");
  });
  it("missing device timezone disables native save and declares unavailability", () => {
    const html = render({ deviceTimezone: null });
    expect(button(html, "Save task")).toContain("disabled");
    expect(html).toContain("device time zone is unavailable");
  });
  it("busy disables ordinary save/cancel as well as uncertain reconciliation", () => {
    expect(button(render({ busy: true }), "Save task")).toContain("disabled");
    expect(button(render({ busy: true }), "Cancel")).toContain("disabled");
    expect(button(render({ busy: true, snapshot: state() }), "Reconcile task creation")).toContain(
      "disabled",
    );
  });
  it("first rejected creation remains a draft; acknowledged creation is distinct from current read", () => {
    expect(render({ snapshot: { command: null, phase: "rejected" } })).toContain(
      "first task attempt was rejected",
    );
    expect(render({ snapshot: { command: null, phase: "acknowledged" } })).toContain(
      "Current records are read separately",
    );
  });
});
