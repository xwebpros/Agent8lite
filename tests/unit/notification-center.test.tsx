import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationCenterView,
  type NotificationActions,
} from "../../apps/web/components/notification-center";
import {
  NotificationController,
  type NotificationState,
} from "../../apps/web/components/notification-controller";
import type { Schema } from "../../apps/web/lib/api";

const id = "d7000000-0000-4000-8000-000000000001";
const notice: Schema<"Notification"> = {
  id,
  kind: "synthetic.lead.assigned",
  title: "<script>PRIVATE_NOTICE()</script>",
  href: "/pipeline?leadId=d7000000-0000-4000-8000-000000000002",
  readAt: null,
};
const unreadPage = (): Schema<"PageNotification"> => ({ items: [notice], nextCursor: null, hasMore: false });
function state(): NotificationState {
  return new NotificationController({
    binding: "PRIVATE_BINDING_NEVER_RENDER",
    online: true,
    canRead: true,
    canWrite: true,
    createKey: () => "d7000000-0000-4000-8000-000000000003",
    client: {
      list: async () => unreadPage(),
      markRead: async () => ({ ...notice, readAt: "2026-10-10T12:00:00.000Z" }),
    },
  }).getSnapshot();
}
function render(patch: Partial<NotificationState> = {}, timezone = "America/Los_Angeles") {
  const actions: NotificationActions = {
    refresh: vi.fn(),
    more: vi.fn(),
    markRead: vi.fn(),
    reconcile: vi.fn(),
    open: vi.fn(),
  };
  return {
    markup: renderToStaticMarkup(
      <NotificationCenterView state={{ ...state(), ...patch }} actions={actions} timezone={timezone} />,
    ),
    actions,
  };
}
function button(markup: string, text: string) {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([html]) => html.replace(/<[^>]*>/g, "").trim() === text,
  )?.[0];
}

describe("notification presentation through the established static React harness", () => {
  it("keeps unread, loading, empty and source-unavailable states distinct", () => {
    const unread = render().markup;
    expect(unread).toContain("Refresh notifications to read the current list");
    expect(unread).not.toContain("No notifications");
    const loading = render({ reading: true }).markup;
    expect(loading).toContain("Loading your notifications");
    expect(loading).not.toContain("No notifications");
    const empty = render({ page: { items: [], hasMore: false, nextCursor: null } }).markup;
    expect(empty).toContain("No notifications");
    const unavailable = render({
      phase: "unavailable",
      error: "Notifications are unavailable. Refresh to retry; no empty list has been inferred.",
    }).markup;
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).not.toContain("No notifications");
  });
  it("escapes private titles and renders explicit native buttons without executing actions", () => {
    const { markup, actions } = render({ page: unreadPage() });
    expect(markup).toContain("&lt;script&gt;PRIVATE_NOTICE()&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).toContain('aria-label="Member notifications"');
    expect(markup).toContain('aria-label="Mark read:');
    expect(markup).toContain('aria-label="Open notice:');
    expect(button(markup, "Mark read")).not.toContain('disabled=""');
    expect(button(markup, "Open record")).not.toContain('disabled=""');
    expect(markup).not.toContain("PRIVATE_BINDING_NEVER_RENDER");
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });
  it.each(["offline", "denied"])("hides existing private rows immediately while %s", (mode) => {
    const markup = render({
      page: unreadPage(),
      ...(mode === "offline"
        ? { online: false }
        : { canRead: false, canWrite: false, phase: "denied" as const }),
    }).markup;
    expect(markup).not.toContain("PRIVATE_NOTICE");
    expect(markup).not.toContain("synthetic.lead.assigned");
    expect(markup).not.toContain("No notifications");
    expect(button(markup, "Refresh notifications")).toContain('disabled=""');
  });
  it("offers read-only navigation while read mutation permission is absent", () => {
    const markup = render({ page: unreadPage(), canWrite: false }).markup;
    expect(button(markup, "Mark read")).toContain('disabled=""');
    expect(button(markup, "Open record")).not.toContain('disabled=""');
  });
  it.each(["sending", "uncertain"] as const)(
    "shows explicit %s recovery without exposing command credentials",
    (phase) => {
      const pending = { binding: "PRIVATE_BINDING", notificationId: id, idempotencyKey: "PRIVATE_KEY" };
      const markup = render({ phase, pending, page: unreadPage() }).markup;
      expect(markup).toContain(phase === "sending" ? "Read command pending" : "Read result unconfirmed");
      expect(markup).toContain("Reconcile read command");
      expect(markup).not.toContain("PRIVATE_KEY");
      expect(markup).not.toContain("PRIVATE_BINDING");
      expect(button(markup, "Mark read")).toContain('disabled=""');
      expect(button(markup, "Open record")).toContain('disabled=""');
      expect(button(markup, "Reconcile read command")?.includes('disabled=""')).toBe(phase === "sending");
    },
  );
  it("disables uncertain reconciliation offline and when write authority is revoked", () => {
    const pending = { binding: "PRIVATE_BINDING", notificationId: id, idempotencyKey: "PRIVATE_KEY" };
    for (const patch of [{ online: false }, { canWrite: false }])
      expect(
        button(render({ phase: "uncertain", pending, ...patch }).markup, "Reconcile read command"),
      ).toContain('disabled=""');
  });
  it("shows the exact stored timestamp and organization timezone and removes the read action", () => {
    const page = { ...unreadPage(), items: [{ ...notice, readAt: "2026-11-01T09:15:00.000Z" }] };
    const markup = render({ page }).markup;
    expect(markup).toContain('<time dateTime="2026-11-01T09:15:00.000Z"');
    expect(markup).toContain("America/Los_Angeles");
    expect(markup).toContain("0 unread in this list");
    expect(button(markup, "Mark read")).toBeUndefined();
  });
  it("labels stale refreshes rather than silently showing previous data as current", () => {
    const markup = render({ page: unreadPage(), reading: true, pageStale: true }).markup;
    expect(markup).toContain("Refreshing · previous list");
    expect(markup).toContain('aria-busy="true"');
    expect(button(markup, "Mark read")).toContain('disabled=""');
    expect(button(markup, "Open record")).toContain('disabled=""');
  });
  it("provides keyboard-operable pagination and stops at the visible private memory cap", () => {
    const page = { ...unreadPage(), hasMore: true, nextCursor: "PRIVATE_CURSOR" };
    expect(button(render({ page }).markup, "Load more notifications")).toBeDefined();
    const capped = {
      ...page,
      items: Array.from({ length: 200 }, (_, index) => ({
        ...notice,
        id: `d7000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      })),
    };
    const markup = render({ page: capped }).markup;
    expect(button(markup, "Load more notifications")).toBeUndefined();
    expect(markup).toContain("limit of 200 notices");
    expect(markup).not.toContain("PRIVATE_CURSOR");
  });
  it("never renders an executable or unsupported notification href as an actionable link", () => {
    for (const href of [
      "https://outside.example.test",
      "javascript:PRIVATE()",
      "/api/v1/session",
      "/tasks/%2e%2e/dev/session",
    ]) {
      const markup = render({ page: { ...unreadPage(), items: [{ ...notice, href }] } }).markup;
      expect(button(markup, "Open record")).toBeUndefined();
      expect(markup).not.toContain(href);
    }
  });
});
