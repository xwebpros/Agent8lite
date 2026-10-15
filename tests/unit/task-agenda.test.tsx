import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskAgendaView, type TaskAgendaViewProps } from "../../apps/web/components/task-agenda";
import type { Schema } from "../../apps/web/lib/api";

const id = (n: number) => `dd000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const task = (n = 1, dueAt = "2026-11-01T09:30:00.000Z"): Schema<"Task"> => ({
  id: id(n),
  assigneeMemberId: id(999),
  title: `Private loaded task ${n}`,
  dueAt,
  timezone: "America/Los_Angeles",
  priority: "normal",
  state: "open",
  version: 1,
});
function render(patch: Partial<TaskAgendaViewProps> = {}) {
  const props: TaskAgendaViewProps = {
    tasks: [task()],
    nowInstant: "2026-11-01T08:00:00.000Z",
    userTimezone: "America/New_York",
    organizationTimezone: "Asia/Bangkok",
    scope: "own",
    refreshedAt: "2026-11-01T07:55:00.000Z",
    hasMore: false,
    loading: false,
    online: true,
    visible: true,
    canRead: true,
    canComplete: true,
    blocked: false,
    actions: { openTask: vi.fn(), completeTask: vi.fn(), viewTasks: vi.fn(), addTask: vi.fn() },
    ...patch,
  };
  return renderToStaticMarkup(<TaskAgendaView {...props} />);
}
function buttons(markup: string) {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(([html]) => html);
}
function button(markup: string, label: string) {
  return buttons(markup).find((html) => html.replace(/<[^>]*>/g, "").trim() === label);
}
function completion(markup: string, title: string) {
  return buttons(markup).find((html) => html.includes(`aria-label="Complete task: ${title}"`));
}

describe("loaded task agenda through the established static React harness", () => {
  it("labels source/scope/captured UTC time without claiming a complete calendar", () => {
    const markup = render({ hasMore: true });
    for (const text of [
      "Loaded task agenda",
      "Source: loaded CRM tasks",
      "My tasks",
      "Gregorian day 2026-11-01",
      "Calendar synchronization is not implied",
      "Additional task pages are available",
      "agenda is partial",
      "Classification captured at",
      "2026-11-01T08:00:00.000Z",
      "Source refreshed at",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toMatch(/<a\b/);
    expect(button(markup, "View tasks")).not.toContain('disabled=""');
    expect(button(markup, task().title)).not.toContain('disabled=""');
    expect(completion(markup, task().title)).not.toContain('disabled=""');
  });
  it("distinguishes unrequested/loading from verified empty and invalid metadata", () => {
    const untouched = render({ tasks: [], refreshedAt: null });
    expect(untouched).toContain("Refresh the workspace to load them");
    expect(untouched).not.toContain("No open tasks");
    const loading = render({ tasks: [], refreshedAt: null, loading: true });
    expect(loading).toContain("Loading task records");
    expect(loading).not.toContain("No open tasks");
    const empty = render({ tasks: [] });
    expect(empty).toContain("No open tasks in the loaded records");
    expect(empty).toContain("loaded records only");
    const invalid = render({ tasks: [{ ...task(), timezone: "PRIVATE_INVALID_SOURCE" }] });
    expect(invalid).toContain("Task timing metadata is unavailable");
    expect(invalid).not.toContain("No open tasks");
    expect(invalid).not.toContain("PRIVATE_INVALID_SOURCE");
    expect(invalid).not.toContain(task().title);
  });
  it.each(["offline", "hidden", "denied"])(
    "hides private loaded rows while%s and disables native actions",
    (cut) => {
      const markup = render({
        online: cut !== "offline",
        visible: cut !== "hidden",
        canRead: cut !== "denied",
      });
      expect(markup).not.toContain(task().title);
      expect(markup).not.toContain(task().id);
      expect(markup).not.toContain(task().dueAt);
      expect(button(markup, "View tasks")).toContain('disabled=""');
      expect(button(markup, "Add a follow-up")).toContain('disabled=""');
      expect(completion(markup, task().title)).toBeUndefined();
    },
  );
  it("discloses stale loaded rows during refresh and pauses actions", () => {
    const markup = render({ loading: true });
    expect(markup).toContain("Refreshing tasks");
    expect(markup).toContain("actions are paused");
    expect(markup).toContain(task().title);
    for (const html of buttons(markup)) expect(html).toContain('disabled=""');
  });
  it("labels all three loaded groups and bounds each independently to five visible rows", () => {
    const overdue = Array.from({ length: 7 }, (_, i) => task(i + 1, "2026-11-01T07:59:00.000Z"));
    const today = Array.from({ length: 7 }, (_, i) => task(i + 21));
    const upcoming = Array.from({ length: 7 }, (_, i) => task(i + 41, "2026-11-02T12:00:00.000Z"));
    const markup = render({ tasks: [...overdue, ...today, ...upcoming], hasMore: true });
    for (const label of ["Loaded overdue tasks", "Loaded tasks due today", "Loaded upcoming tasks"])
      expect(markup).toContain(label);
    expect(markup.match(/5 shown of 7 loaded/g)).toHaveLength(3);
    expect(markup.match(/aria-label="Complete task:/g)).toHaveLength(15);
    for (const title of [overdue[5].title, today[5].title, upcoming[5].title])
      expect(markup).not.toContain(title);
    expect(markup).toContain("agenda is partial");
  });
  it("shows valid done/cancelled exclusions rather than inventing overdue work", () => {
    const markup = render({
      tasks: [
        { ...task(), state: "done" },
        { ...task(2), state: "cancelled" },
      ],
    });
    expect(markup).toContain("No open tasks in the loaded records");
    expect(markup).toContain("Completed and cancelled tasks are excluded");
    expect(markup).not.toContain(task().title);
  });
  it("shows both fall offsets with independently labeled user/organization/source and UTC references", () => {
    const markup = render({ tasks: [task(1, "2026-11-01T08:30:00.000Z"), task(2)] });
    for (const text of [
      "User time (America/New_York)",
      "Organization time (Asia/Bangkok)",
      "Stored source time (America/Los_Angeles)",
      "UTC reference",
      "2026-11-01T08:30:00.000Z",
      "2026-11-01T09:30:00.000Z",
    ])
      expect(markup).toContain(text);
    expect(markup).toMatch(/01:30(?::00)? GMT-7/);
    expect(markup).toMatch(/01:30(?::00)? GMT-8/);
  });
  it("does not duplicate matching organization/source display zones", () => {
    const markup = render({
      userTimezone: "America/Los_Angeles",
      organizationTimezone: "America/Los_Angeles",
    });
    expect(markup).not.toContain("Organization time (");
    expect(markup).not.toContain("Stored source time (");
    expect(markup).toContain("Stored source timezone: America/Los_Angeles");
    expect(markup).toContain("UTC reference");
  });
  it.each(["user", "organization", "clock"])(
    "disables actions when current%s metadata cannot be verified",
    (kind) => {
      const markup = render({
        userTimezone: kind === "user" ? "PRIVATE_INVALID_USER" : "America/New_York",
        organizationTimezone: kind === "organization" ? "PRIVATE_INVALID_ORG" : "Asia/Bangkok",
        nowInstant: kind === "clock" ? "PRIVATE_INVALID_CLOCK" : "2026-11-01T08:00:00.000Z",
      });
      expect(markup).toContain("Task timing metadata is unavailable");
      expect(markup).not.toContain("PRIVATE_INVALID");
      expect(markup).not.toContain(task().title);
      for (const html of buttons(markup)) expect(html).toContain('disabled=""');
      if (kind !== "clock") expect(markup).toContain("Current UTC reference");
    },
  );
  it("retains drawer access but disables completion/add when task write access is absent", () => {
    const markup = render({ canComplete: false });
    expect(button(markup, task().title)).not.toContain('disabled=""');
    expect(completion(markup, task().title)).toContain('disabled=""');
    expect(button(markup, "Add a follow-up")).toContain('disabled=""');
  });
  it("blocks new task creation independently while preserving current task completion and reads", () => {
    const markup = render({ canAddTask: false });
    expect(button(markup, "Add a follow-up")).toContain('disabled=""');
    expect(completion(markup, task().title)).not.toContain('disabled=""');
    expect(button(markup, task().title)).not.toContain('disabled=""');
    expect(button(markup, "View tasks")).not.toContain('disabled=""');
  });
  it("allows separately authorized task creation without enabling task completion", () => {
    const markup = render({ canAddTask: true, canComplete: false });
    expect(button(markup, "Add a follow-up")).not.toContain('disabled=""');
    expect(completion(markup, task().title)).toContain('disabled=""');
    expect(button(markup, task().title)).not.toContain('disabled=""');
  });
  it("disables native drawer/completion/navigation actions while blocked by shell guards", () => {
    const markup = render({ blocked: true });
    expect(markup).toContain(task().title);
    for (const html of buttons(markup)) expect(html).toContain('disabled=""');
    expect(markup).not.toMatch(/<a\b/);
  });
  it("provides a distinct reconciliation control and blocks unrelated actions during an unknown completion", () => {
    const markup = render({ completionPending: true, onReconcile: vi.fn() });
    expect(markup).toContain("A task completion is unconfirmed");
    expect(button(markup, "Reconcile task completion")).not.toContain('disabled=""');
    expect(button(markup, task().title)).toContain('disabled=""');
    expect(completion(markup, task().title)).toContain('disabled=""');
    expect(button(markup, "View tasks")).toContain('disabled=""');
  });
  it.each(["offline", "hidden", "busy", "write-denied"])(
    "does not expose retained pending source details or allow reconciliation while%s",
    (cut) => {
      const markup = render({
        completionPending: true,
        onReconcile: vi.fn(),
        online: cut !== "offline",
        visible: cut !== "hidden",
        blocked: cut === "busy",
        canComplete: cut !== "write-denied",
      });
      expect(button(markup, "Reconcile task completion")).toContain('disabled=""');
      if (cut === "offline" || cut === "hidden") {
        expect(markup).not.toContain(task().title);
        expect(markup).not.toContain(task().id);
        expect(markup).not.toContain(task().dueAt);
      }
    },
  );
  it("escapes stored titles and uses authorized scope only as a display label", () => {
    const markup = render({
      tasks: [{ ...task(), title: '<img src=x onerror="private()">' }],
      scope: "authorized",
    });
    expect(markup).toContain("Authorized task scope");
    expect(markup).toContain("&lt;img");
    expect(markup).not.toContain("<img src=x");
    expect(markup).not.toContain("All organization tasks");
  });
});
