import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppointmentAgendaView, type AppointmentActions } from "../../apps/web/components/appointment-agenda";
import {
  AppointmentController,
  type AppointmentState,
} from "../../apps/web/components/appointment-controller";
import type { Schema } from "../../apps/web/lib/api";

const id = (index = 1) => `d9000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const entity = (index = 1): Schema<"Appointment"> => ({
  id: id(index),
  leadId: id(900),
  startsAt: "2026-11-01T08:30:00.000Z",
  endsAt: "2026-11-01T09:30:00.000Z",
  timezone: "America/Los_Angeles",
  state: "scheduled",
});
const page = (count = 1): Schema<"PageAppointment"> => ({
  items: Array.from({ length: count }, (_, index) => entity(index + 1)),
  nextCursor: null,
  hasMore: false,
});
function initial(): AppointmentState {
  return new AppointmentController({
    binding: "PRIVATE_MEMBER_BINDING",
    online: true,
    canRead: true,
    client: { list: async () => page() },
  }).getSnapshot();
}
function render(
  patch: Partial<AppointmentState> = {},
  userTimezone: unknown = "America/New_York",
  organizationTimezone: unknown = "Asia/Bangkok",
) {
  const actions: AppointmentActions = { refresh: vi.fn(), more: vi.fn(), openLead: vi.fn() };
  return {
    markup: renderToStaticMarkup(
      <AppointmentAgendaView
        state={{ ...initial(), ...patch }}
        userTimezone={userTimezone}
        organizationTimezone={organizationTimezone}
        actions={actions}
      />,
    ),
    actions,
  };
}
function button(markup: string, name: string) {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([html]) => html.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}

describe("stored appointment agenda using the existing static React harness", () => {
  it("labels the bounded records as stored, current-member only and unsynchronized", () => {
    const { markup } = render({ page: page() });
    expect(markup).toContain("Stored appointments");
    expect(markup).toContain("Calendar synchronization is not configured");
    expect(markup).toContain("Current member only");
    expect(markup).toContain("1 loaded");
    expect(markup).toContain("Loaded pages are not a snapshot or a complete daily agenda");
    expect(markup).toContain("Booking and cancellation actions are not available");
    expect(markup).not.toMatch(/<a\b/);
    expect(markup).not.toContain("PRIVATE_MEMBER_BINDING");
    expect(button(markup, "Open lead")).toContain('aria-label="Open lead for stored appointment 1"');
  });
  it("keeps unrequested, loading, verified empty and unavailable states separate", () => {
    const untouched = render().markup;
    expect(untouched).toContain("Refresh appointments to read");
    expect(untouched).not.toContain("No stored appointments");
    const loading = render({ reading: true }).markup;
    expect(loading).toContain("Loading your stored appointments");
    expect(loading).not.toContain("No stored appointments");
    const empty = render({ page: page(0) }).markup;
    expect(empty).toContain("No stored appointments");
    expect(empty).toContain("does not confirm");
    const unavailable = render({
      phase: "unavailable",
      error: "Stored appointments are unavailable.",
    }).markup;
    expect(unavailable).toContain('role="alert"');
    expect(unavailable).not.toContain("No stored appointments");
  });
  it.each(["offline", "hidden", "denied"])("never renders a retained private projection while%s", (kind) => {
    const { markup } = render({
      page: page(),
      online: kind !== "offline",
      visible: kind !== "hidden",
      canRead: kind !== "denied",
    });
    expect(markup).not.toContain(entity().startsAt);
    expect(markup).not.toContain("Stored appointment 1");
    expect(button(markup, "Refresh appointments")).toContain('disabled=""');
    expect(button(markup, "Open lead")).toBeUndefined();
  });
  it("marks the previous loaded list as refreshing and disables current navigation during the read", () => {
    const { markup } = render({ page: page(), reading: true, pageStale: true });
    expect(markup).toContain("Refreshing · previous list");
    expect(button(markup, "Open lead")).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
  });
  it("distinguishes both Los Angeles fall offsets alongside labeled user, organization, source and UTC references", () => {
    const { markup } = render({ page: page() });
    for (const label of [
      "Your time",
      "Organization time",
      "Stored source time",
      "UTC reference",
      "America/New_York",
      "Asia/Bangkok",
      "America/Los_Angeles",
      "01:30 GMT-7",
      "01:30 GMT-8",
      entity().startsAt,
      entity().endsAt,
    ])
      expect(markup).toContain(label);
    expect(markup).toMatch(new RegExp('dateTime="' + entity().startsAt.replaceAll(".", "\\.") + '"', "i"));
  });
  it("shows the spring transition from01:30 GMT-8 to03:30 GMT-7 rather than nonexistent local02:30", () => {
    const response = page();
    response.items[0].startsAt = "2026-03-08T09:30:00.000Z";
    response.items[0].endsAt = "2026-03-08T10:30:00.000Z";
    const { markup } = render({ page: response }, "America/Los_Angeles", "America/Los_Angeles");
    expect(markup).toContain("01:30 GMT-8");
    expect(markup).toContain("03:30 GMT-7");
    expect(markup).not.toContain("02:30");
    expect(markup).not.toContain("Organization time");
    expect(markup).not.toContain("Stored source time");
    expect(markup).toContain("UTC reference");
  });
  it("labels invalid user/organization zones unavailable while retaining explicit UTC, without raw invalid-zone text", () => {
    const { markup } = render({ page: page() }, "PRIVATE_USER_ZONE", "PRIVATE_ORG_ZONE");
    expect(markup).toContain("Your timezone is unavailable");
    expect(markup).toContain("Organization timezone is unavailable");
    expect(markup).toContain("UTC reference");
    expect(markup).toContain(entity().startsAt);
    expect(markup).not.toContain("PRIVATE_USER_ZONE");
    expect(markup).not.toContain("PRIVATE_ORG_ZONE");
    const sameInvalid = render({ page: page() }, "PRIVATE_INVALID_ZONE", "PRIVATE_INVALID_ZONE").markup;
    expect(sameInvalid).toContain("Your timezone is unavailable");
    expect(sameInvalid).toContain("Organization timezone is unavailable");
    expect(sameInvalid).not.toContain("PRIVATE_INVALID_ZONE");
  });
  it("renders each stored state explicitly without deriving completion or availability from timestamps", () => {
    const response = page(3);
    response.items[1].state = "cancelled";
    response.items[2].state = "completed";
    const { markup } = render({ page: response });
    for (const state of ["Scheduled", "Cancelled", "Completed"]) expect(markup).toContain(">" + state + "<");
    expect(markup).not.toContain("Booking confirmed");
  });
  it("makes more/limit/current-read freshness explicit without inventing totals", () => {
    const response = { ...page(), hasMore: true, nextCursor: "PRIVATE_OPAQUE_CURSOR" };
    const more = render({ page: response, refreshedAt: "2026-10-10T00:00:00.000Z" }).markup;
    expect(button(more, "Load more appointments")).toBeDefined();
    expect(more).toContain("More stored records exist");
    expect(more).toContain("Source: stored appointment API");
    expect(more).toContain("2026-10-10T00:00:00.000Z");
    expect(more).not.toContain("PRIVATE_OPAQUE_CURSOR");
    const capped = render({ page: { ...page(200), hasMore: true, nextCursor: "cursor" } }).markup;
    expect(capped).toContain("limit of 200 loaded appointments");
    expect(button(capped, "Load more appointments")).toBeUndefined();
  });
  it("orders only the loaded subset by start time with stable IDs, without changing source pagination state", () => {
    const response = page(2);
    response.items[0].startsAt = "2027-11-01T08:30:00.000Z";
    response.items[0].endsAt = "2027-11-01T09:30:00.000Z";
    const before = JSON.stringify(response);
    const { markup } = render({ page: response });
    expect(markup.indexOf("2026-11-01T08:30:00.000Z")).toBeLessThan(
      markup.indexOf("2027-11-01T08:30:00.000Z"),
    );
    expect(JSON.stringify(response)).toBe(before);
    expect(markup).toContain("within these loaded records");
  });
});
