import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContactEditView, type ContactEditViewProps } from "../../apps/web/components/contact-edit-panel";
import { ContactEditProtocol, type ContactEditSnapshot } from "../../apps/web/components/contact-edit";
import type { Schema } from "../../apps/web/lib/api";

const id = "df000000-0000-4000-8000-000000000001",
  key = "df000000-0000-4000-8000-000000000002";
const contact: Schema<"Contact"> = {
  id,
  displayName: "PRIVATE_NAME",
  emails: ["private@example.test"],
  phones: ["+15550009999"],
  version: 1,
};
const draft = { displayName: "PRIVATE_DRAFT_NAME", email: "draft@example.test", phone: "+15550008888" };
function pending(phase: "sending" | "unknown" = "unknown"): ContactEditSnapshot {
  const protocol = new ContactEditProtocol();
  protocol.bind("PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS");
  const command = protocol.begin(
    { contactId: id, version: 1, body: { displayName: "PRIVATE_COMMAND_NAME" } },
    key,
  );
  if (phase === "unknown") protocol.reject(command, new TypeError("PRIVATE_PROVIDER_ERROR"));
  return protocol.getSnapshot();
}
function render(patch: Partial<ContactEditViewProps> = {}) {
  return renderToStaticMarkup(
    <ContactEditView
      contact={contact}
      draft={draft}
      snapshot={{ command: null, phase: "idle" }}
      online
      visible
      busy={false}
      reading={false}
      canEdit
      canRead
      canRetry
      onDraftChange={vi.fn()}
      onReconcile={vi.fn()}
      onReview={vi.fn()}
      {...patch}
    />,
  );
}
function button(html: string, name: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([item]) => item.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}
function noPrivate(html: string) {
  for (const value of [
    "PRIVATE_NAME",
    "PRIVATE_DRAFT_NAME",
    "PRIVATE_COMMAND_NAME",
    "draft@example.test",
    "+15550008888",
    "PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS",
    "PRIVATE_PROVIDER_ERROR",
    id,
    key,
  ])
    expect(html).not.toContain(value);
}

describe("contact edit static privacy and native recovery controls without browser claims", () => {
  it("renders labeled native current draft inputs and preservation/consent disclosure", () => {
    const html = render();
    expect(html).toContain("Contact details");
    for (const value of [
      "Full name",
      "Email",
      "Phone (optional)",
      "PRIVATE_DRAFT_NAME",
      "draft@example.test",
      "+15550008888",
    ])
      expect(html).toContain(value);
    expect(html).toContain('type="email"');
    expect(html).toContain('type="tel"');
    expect(html).toContain("Additional channels are preserved");
    expect(html).toContain("Communication consent is not changed");
    expect(html).not.toContain("PRIVATE_NAME");
    expect(html).not.toContain(id);
    expect(html).not.toContain(key);
    expect(html).not.toMatch(/<fieldset disabled/);
  });
  it.each(["offline", "hidden"] as const)(
    "%s removes all private draft/command markup and no actionable retry",
    (cut) => {
      const html = render({ snapshot: pending(), online: cut !== "offline", visible: cut !== "hidden" });
      noPrivate(html);
      expect(html).toContain("save is unconfirmed");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<button");
    },
  );
  it.each(["offline", "hidden"] as const)("%s hides ordinary unsaved details too", (cut) => {
    const html = render({ online: cut !== "offline", visible: cut !== "hidden" });
    noPrivate(html);
    expect(html).toContain("unsaved edits are hidden");
  });
  it("explicit current access denial does not project retained stale private props", () => {
    const html = render({ snapshot: { command: null, phase: "denied" }, canEdit: false, canRead: false });
    noPrivate(html);
    expect(html).toContain("Contact access is unavailable");
    expect(html).not.toContain("<input");
  });
  it("a current read permission cut with retained props fails closed before displaying drafts", () => {
    const html = render({ canEdit: false, canRead: false });
    noPrivate(html);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
  });
  it("does not confuse permitted readonly contact fields with identity denial", () => {
    const html = render({ canEdit: false, canRead: true });
    expect(html).toContain("PRIVATE_DRAFT_NAME");
    expect(html).toMatch(/<fieldset disabled/);
  });
  it("unknown command offers explicit same-command reconciliation and locks competing edit inputs", () => {
    const html = render({ snapshot: pending() });
    expect(html).toContain("Contact save unconfirmed");
    expect(html).toContain("save may have completed");
    expect(html).toContain("Reading current details cannot prove");
    expect(html).toContain("original input and record version");
    expect(button(html, "Reconcile contact save")).not.toContain("disabled");
    expect(button(html, "Review current contact")).not.toContain("disabled");
    expect(html).toMatch(/<fieldset disabled/);
    expect(html).not.toContain("PRIVATE_COMMAND_NAME");
    expect(html).not.toContain(key);
    expect(html).not.toContain(id);
  });
  it("sending cannot start reconciliation while the original request is in flight", () => {
    const html = render({ snapshot: pending("sending") });
    expect(html).toContain("Saving the original contact command");
    expect(button(html, "Reconcile contact save")).toContain("disabled");
    expect(html).toMatch(/<fieldset disabled/);
  });
  it("current-record review stays separate from retained edits and does not resolve uncertainty", () => {
    const html = render({ snapshot: pending(), currentReviewed: true });
    expect(html).toContain("Current contact (read-only)");
    expect(html).toContain("PRIVATE_NAME");
    expect(html).toContain("Current record version 1");
    expect(html).toContain("original save remains unconfirmed");
    expect(html).toContain("Retained contact edits");
    expect(html).toContain('value="PRIVATE_DRAFT_NAME"');
    expect(html).toMatch(/<fieldset disabled/);
    expect(button(html, "Reconcile contact save")).not.toContain("disabled");
  });
  it("a new current-record verification withholds a previous read-only projection while it loads", () => {
    const html = render({ snapshot: pending(), currentReviewed: true, reading: true });
    noPrivate(html);
    expect(html).toContain("Reading current contact details");
    expect(button(html, "Reconcile contact save")).toContain("disabled");
  });
  it("expired/invalid retry horizon preserves truthful unknown state and only permits current review", () => {
    const html = render({ snapshot: pending(), canRetry: false });
    expect(html).toContain("retry window is unavailable or has expired");
    expect(html).toContain("save remains unconfirmed");
    expect(html).toContain("no new save or automatic retry");
    expect(button(html, "Reconcile contact save")).toContain("disabled");
    expect(button(html, "Review current contact")).not.toContain("disabled");
  });
  it.each(["busy", "reading", "no-write"] as const)("native reconciliation is disabled by%s", (cut) => {
    const html = render({
      snapshot: pending(),
      busy: cut === "busy",
      reading: cut === "reading",
      canEdit: cut !== "no-write",
    });
    expect(button(html, "Reconcile contact save")).toContain("disabled");
    if (cut !== "no-write") expect(button(html, "Review current contact")).toContain("disabled");
  });
  it("a fresh authoritative read in progress does not show prior private fields", () => {
    const html = render({ reading: true });
    noPrivate(html);
    expect(html).toContain("Reading current contact details");
    expect(html).not.toContain("<input");
  });
  it("acknowledgment and failed current read remain distinct without replacing detail with a receipt", () => {
    const html = render({ snapshot: { command: null, phase: "acknowledged" }, contact: null, draft: null });
    expect(html).toContain("Contact save acknowledged");
    expect(html).toContain("Current details are unavailable");
    expect(html).toContain("read them before editing again");
    expect(button(html, "Read current contact")).not.toContain("disabled");
    noPrivate(html);
    expect(html).not.toContain("Reconcile contact save");
  });
  it("acknowledged receipt does not make a newer authoritative detail look like an unconfirmed command", () => {
    const html = render({ snapshot: { command: null, phase: "acknowledged" } });
    expect(html).toContain("Current details have been read separately");
    expect(html).toContain("PRIVATE_DRAFT_NAME");
    expect(html).not.toContain("Reconcile contact save");
  });
  it("initial CAS conflict offers review and never claims the original save was acknowledged", () => {
    const html = render({ snapshot: { command: null, phase: "conflict" } });
    expect(html).toContain("first save was rejected because this contact changed");
    expect(html).toContain("unsaved edits remain in this tab");
    expect(button(html, "Review current contact")).not.toContain("disabled");
    expect(html).not.toContain("save acknowledged");
  });
  it("initial definitive rejection remains an error state and has no hidden automatic resend", () => {
    const html = render({ snapshot: { command: null, phase: "rejected" } });
    expect(html).toContain("first save was rejected");
    expect(html).not.toContain("Reconcile contact save");
    expect(html).not.toContain("save acknowledged");
  });
  it("missing authoritative source is unavailable rather than a fabricated blank editable contact", () => {
    const html = render({ contact: null, draft: null });
    expect(html).toContain("Current contact details are unavailable");
    expect(html).not.toContain("<input");
    expect(button(html, "Read current contact")).not.toContain("disabled");
  });
});
