import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  RecordArchiveProtocol,
  recordArchiveContext,
  type RecordArchiveKind,
  type RecordArchiveSnapshot,
} from "../../apps/web/components/record-archive";
import {
  RecordArchiveView,
  type RecordArchiveViewProps,
} from "../../apps/web/components/record-archive-panel";
import { ApiError } from "../../apps/web/lib/api";

const org = "ae000000-0000-4000-8000-000000000001",
  user = "ae000000-0000-4000-8000-000000000002",
  member = "ae000000-0000-4000-8000-000000000003",
  contactId = "ae000000-0000-4000-8000-000000000004",
  leadId = "ae000000-0000-4000-8000-000000000005",
  key = "ae000000-0000-4000-8000-000000000006",
  csrf = "PRIVATE_CSRF_TOKEN";
const binding = recordArchiveContext({
  session: {
    userId: user,
    activeOrgId: org,
    organizations: [],
    permissions: ["crm.contacts.write", "crm.leads.write"],
    profile: { displayName: "Synthetic", timezone: "UTC" },
  },
  memberId: member,
  csrf,
  accessRevision: 1,
});
function snapshotFor(
  phase: "sending" | "unknown" | "blocked" | "unavailable" | "rejected" | "denied" | "acknowledged",
  kind: RecordArchiveKind = "contact",
): RecordArchiveSnapshot {
  const protocol = new RecordArchiveProtocol();
  protocol.bind(binding);
  const command = protocol.begin(
    { kind, resourceId: kind === "contact" ? contactId : leadId, version: 3 },
    key,
  );
  if (phase === "unknown") protocol.reject(command, new Error("PRIVATE_PROVIDER_ERROR"));
  if (phase === "blocked") protocol.reject(command, new ApiError(409, "x", "contact_has_active_leads"));
  if (phase === "unavailable") protocol.reject(command, new ApiError(404, "x", "resource_unavailable"));
  if (phase === "rejected") protocol.reject(command, new ApiError(422, "x", "body_not_allowed"));
  if (phase === "denied") protocol.reject(command, new ApiError(403, "x"));
  if (phase === "acknowledged")
    protocol.acknowledge(
      command,
      {
        id: key,
        state: "succeeded",
        kind: kind === "contact" ? "crm.contact.archived" : "crm.lead.archived",
        createdAt: "2026-10-11T10:00:00.000Z",
      },
      '"4"',
    );
  return protocol.getSnapshot();
}
function render(patch: Partial<RecordArchiveViewProps> = {}) {
  return renderToStaticMarkup(
    <RecordArchiveView
      kind="contact"
      resourceId={contactId}
      snapshot={{ command: null, phase: "idle", subject: null }}
      available
      online
      visible
      busy={false}
      canArchive
      canRetry
      confirming={false}
      onRequest={vi.fn()}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      onReconcile={vi.fn()}
      onForget={vi.fn()}
      {...patch}
    />,
  );
}
function button(html: string, name: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([item]) => item.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}
function privateAbsent(html: string) {
  for (const value of [org, user, member, contactId, leadId, key, csrf, "PRIVATE_PROVIDER_ERROR", "/archive"])
    expect(html).not.toContain(value);
}

describe("ADR-047 archive action and in-page confirmation", () => {
  it("offers an explicit labelled action without submitting the enclosing drawer form", () => {
    const html = render();
    privateAbsent(html);
    expect(html).toContain('aria-label="Archive contact"');
    expect(button(html, "Archive contact")).not.toContain("disabled");
    expect(html).not.toContain("Confirm archive");
    expect([...html.matchAll(/<button\b[^>]*>/g)].every(([tag]) => tag.includes('type="button"'))).toBe(true);
    expect(html).not.toContain("<form");
  });
  it("lead drawer labels its own action", () => {
    const html = render({ kind: "lead", resourceId: leadId });
    expect(button(html, "Archive lead")).toBeDefined();
    expect(html).toContain('aria-label="Archive lead"');
  });
  it("confirmation step is a labelled group with confirm and cancel and explains the effect", () => {
    const html = render({ confirming: true });
    privateAbsent(html);
    expect(html).toMatch(/role="group" aria-labelledby="record-archive-contact-confirm"/);
    expect(html).toContain('id="record-archive-contact-confirm"');
    expect(html).toContain("Archive this contact?");
    expect(html).toContain("Consent and suppression history stay unchanged");
    expect(button(html, "Confirm archive")).not.toContain("disabled");
    expect(button(html, "Cancel")).toBeDefined();
    expect(button(html, "Archive contact")).toBeUndefined();
    expect(render({ kind: "lead", resourceId: leadId, confirming: true })).toContain(
      "Tasks linked to it become unavailable",
    );
  });
  it("busy disables both the action and confirmation", () => {
    expect(button(render({ busy: true }), "Archive contact")).toContain("disabled");
    expect(button(render({ busy: true, confirming: true }), "Confirm archive")).toContain("disabled");
  });
  it("no verified current record offers no archive command", () => {
    const html = render({ available: false, confirming: true });
    expect(html).toContain("after the current contact is read");
    expect(html).not.toContain("Archive contact</button>");
    expect(html).not.toContain("Confirm archive");
  });
  it("missing grant renders nothing", () => {
    expect(render({ canArchive: false })).toBe("");
  });
  it.each([{ online: false }, { visible: false }])("inactive %j withholds controls", (patch) => {
    const html = render({ ...patch, confirming: true });
    privateAbsent(html);
    expect(html).toContain("unavailable while offline or this view is inactive");
    expect(html).not.toContain("<button");
  });
});

describe("definitive outcomes are shown only on the matching drawer", () => {
  it("active-lead refusal explains that leads must be archived first", () => {
    const html = render({ snapshot: snapshotFor("blocked") });
    privateAbsent(html);
    expect(html).toContain("Archive this contact’s active leads first");
    expect(html).toContain('role="alert"');
    expect(button(html, "Archive contact")).not.toContain("disabled");
  });
  it("another drawer does not inherit a resolved outcome", () => {
    const html = render({ snapshot: snapshotFor("blocked"), resourceId: leadId });
    expect(html).not.toContain("active leads first");
    const lead = render({ kind: "lead", resourceId: contactId, snapshot: snapshotFor("blocked") });
    expect(lead).not.toContain("active leads first");
  });
  it("404 and other rejections have explicit, non-fabricated messages", () => {
    expect(render({ snapshot: snapshotFor("unavailable") })).toContain("unavailable or already archived");
    expect(render({ snapshot: snapshotFor("rejected") })).toContain("The archive request was rejected");
  });
  it("denied clears to generic text with no controls", () => {
    const html = render({ snapshot: snapshotFor("denied") });
    privateAbsent(html);
    expect(html).toContain("Archive access is unavailable");
    expect(html).not.toContain("<button");
  });
});

describe("private-safe recovery", () => {
  it("unknown outcome offers exact reconciliation and no new archive controls", () => {
    const html = render({ snapshot: snapshotFor("unknown") });
    privateAbsent(html);
    expect(html).toContain('aria-label="Archive recovery"');
    expect(html).toContain("Archive unconfirmed");
    expect(html).toContain("may have completed");
    expect(button(html, "Reconcile archive")).not.toContain("disabled");
    expect(html).not.toContain("Archive contact</button>");
    expect(html).not.toContain("Confirm archive");
    expect(html).not.toContain("Clear this tab");
  });
  it("a recovery view in another drawer still renders the retained command generically", () => {
    const html = render({ kind: "lead", resourceId: leadId, snapshot: snapshotFor("unknown", "contact") });
    privateAbsent(html);
    expect(button(html, "Reconcile archive")).toBeDefined();
    expect(html).not.toContain("Archive lead</button>");
  });
  it.each([{ online: false }, { visible: false }])("%j hides details and disables resend", (patch) => {
    const html = render({ snapshot: snapshotFor("unknown"), ...patch });
    privateAbsent(html);
    expect(html).toContain("hidden while offline or this view is inactive");
    expect(button(html, "Reconcile archive")).toContain("disabled");
  });
  it.each([{ busy: true }, { canRetry: false }])("%j disables resend", (patch) => {
    expect(button(render({ snapshot: snapshotFor("unknown"), ...patch }), "Reconcile archive")).toContain(
      "disabled",
    );
  });
  it("in-flight command cannot be resent or forgotten", () => {
    const html = render({ snapshot: snapshotFor("sending"), canRetry: false });
    privateAbsent(html);
    expect(html).toContain("Confirming archive");
    expect(button(html, "Reconcile archive")).toContain("disabled");
    expect(html).not.toContain("Clear this tab");
  });
  it("expired unknown may clear local recovery offline with the ADR-042 warning", () => {
    const html = render({ snapshot: snapshotFor("unknown"), canRetry: false, online: false });
    privateAbsent(html);
    expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    expect(html).toContain("does not cancel or undo");
  });
  it.each([{ visible: false }, { busy: true }])("local forget guard %j is disabled", (patch) => {
    expect(
      button(
        render({ snapshot: snapshotFor("unknown"), canRetry: false, ...patch }),
        "Clear this tab’s recovery data",
      ),
    ).toContain("disabled");
  });
  it("forgotten state shows only the warning", () => {
    const html = render({ snapshot: { command: null, phase: "forgotten", subject: null } });
    privateAbsent(html);
    expect(html).toContain("cleared");
    expect(html).toContain("duplicate");
    expect(html).not.toContain("<button");
  });
  it("acknowledged state never displays historical record data", () => {
    const html = render({ snapshot: snapshotFor("acknowledged") });
    privateAbsent(html);
  });
});
