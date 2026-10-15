import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskEditView, type TaskEditViewProps } from "../../apps/web/components/task-edit-panel";
import { TaskEditProtocol, type TaskEditSnapshot } from "../../apps/web/components/task-edit";
import type { Schema } from "../../apps/web/lib/api";
const id = "dd000000-0000-4000-8000-000000000001",
  member = "dd000000-0000-4000-8000-000000000002",
  lead = "dd000000-0000-4000-8000-000000000003",
  key = "dd000000-0000-4000-8000-000000000004";
const task = (): Schema<"Task"> => ({
  id,
  assigneeMemberId: member,
  leadId: lead,
  title: "PRIVATE_TASK_TITLE",
  description: "PRIVATE_DESCRIPTION",
  dueAt: "2026-11-01T09:30:00.123Z",
  timezone: "US/Pacific",
  priority: "high",
  state: "open",
  version: 1,
});
const draft = {
  title: "PRIVATE_TASK_TITLE",
  description: "PRIVATE_DESCRIPTION",
  dueLocal: "2026-11-01T01:30",
  priority: "high" as const,
  state: "open" as const,
};
function pending(phase: "sending" | "unknown" = "unknown"): TaskEditSnapshot {
  const protocol = new TaskEditProtocol();
  protocol.bind("PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS");
  const command = protocol.begin(
    {
      task: task(),
      body: {
        assigneeMemberId: member,
        title: draft.title,
        description: draft.description,
        dueAt: task().dueAt,
        timezone: task().timezone,
        state: "done",
      },
    },
    key,
  );
  if (phase === "unknown") protocol.reject(command, new Error("PRIVATE_PROVIDER_TEXT"));
  return protocol.getSnapshot();
}
function render(patch: Partial<TaskEditViewProps> = {}) {
  return renderToStaticMarkup(
    <TaskEditView
      snapshot={{ command: null, phase: "idle" }}
      task={task()}
      draft={draft}
      online
      visible
      busy={false}
      reading={false}
      canEdit
      canRead
      canRetry
      deviceTimezone="US/Pacific"
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onReconcile={vi.fn()}
      onReview={vi.fn()}
      onForget={vi.fn()}
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
    id,
    member,
    lead,
    key,
    task().title,
    task().description!,
    task().dueAt,
    task().timezone,
    draft.dueLocal,
    "PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS",
    "PRIVATE_PROVIDER_TEXT",
  ])
    expect(html).not.toContain(value);
}
describe("Task edit native controls and generic private recovery", () => {
  it("verified current form exposes labeled fields and unchanged timing disclosure", () => {
    const html = render();
    for (const value of [
      "Title",
      "Due date and time",
      "Description",
      "Priority",
      "Status",
      "Unchanged time preserves the stored instant and timezone",
    ])
      expect(html).toContain(value);
    expect(html).toContain('type="datetime-local"');
    expect(button(html, "Save task changes")).not.toContain("disabled");
    expect(button(html, "Save task changes")).toContain('type="button"');
  });
  it("unknown withholds every Task/Lead/assignee/time value and permits exact reconciliation only", () => {
    const html = render({ snapshot: pending() });
    noPrivate(html);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Save task changes");
    expect(button(html, "Reconcile task update")).not.toContain("disabled");
    expect(html).toContain("Reading the current task cannot prove whether the earlier update completed");
  });
  it("sending cannot resend and has no local forgetting", () => {
    const html = render({ snapshot: pending("sending") });
    noPrivate(html);
    expect(button(html, "Reconcile task update")).toContain("disabled");
    expect(html).not.toContain("Clear this tab");
  });
  it.each([
    { online: false },
    { visible: false },
    { canRead: false },
    { snapshot: { ...pending(), phase: "denied" as const } },
  ])("private current draft is hidden after %j", (patch) => {
    noPrivate(render(patch));
  });
  it.each([{ online: false }, { visible: false }, { canEdit: false }, { busy: true }, { reading: true }])(
    "pending %j prevents unsafe reconciliation",
    (patch) => {
      const html = render({ snapshot: pending(), ...patch });
      noPrivate(html);
      const action = button(html, "Reconcile task update");
      if (action) expect(action).toContain("disabled");
    },
  );
  it("read unavailable does not invent a write prerequisite or current-detail form", () => {
    const html = render({ snapshot: pending(), canRead: false });
    noPrivate(html);
    expect(button(html, "Reconcile task update")).not.toContain("disabled");
    expect(button(html, "Review current task")).toContain("disabled");
  });
  it("known acknowledged outcome with no current read stays acknowledged and exposes no historical form", () => {
    const html = render({ snapshot: { command: null, phase: "acknowledged" }, task: null, draft: null });
    noPrivate(html);
    expect(html).toContain("Task update acknowledged");
    expect(html).toContain("assignment or source access may have changed");
    expect(html).not.toContain("Save task changes");
  });
  it("reading with a stale verified prop does not render previous details", () => {
    const html = render({ reading: true, snapshot: { command: null, phase: "acknowledged" } });
    noPrivate(html);
    expect(html).toContain("Reading current details");
  });
  it("expired unknown offers local forget offline without suggesting server cancellation", () => {
    const html = render({ snapshot: pending(), canRetry: false, online: false });
    noPrivate(html);
    expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    expect(html).toContain("does not cancel or undo");
  });
  it.each([{ visible: false }, { busy: true }, { reading: true }, { canEdit: false }])(
    "local forget is disabled after %j",
    (patch) => {
      const html = render({ snapshot: pending(), canRetry: false, ...patch });
      noPrivate(html);
      expect(button(html, "Clear this tab’s recovery data")).toContain("disabled");
    },
  );
  it("forgotten branch ignores all stale private props and renders only unresolved warning", () => {
    const html = render({ snapshot: { command: null, phase: "forgotten" } });
    noPrivate(html);
    expect(html).not.toContain("<button");
    expect(html).toContain("unconfirmed");
  });
  it("no supplied review/save handler can enable denied private editor", () => {
    const html = render({ snapshot: { command: null, phase: "denied" } });
    noPrivate(html);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });
});
