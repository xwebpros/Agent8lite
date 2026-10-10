import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ContactEditProtocol,
  contactEditRetryWindowMs,
  type ContactEditSnapshot,
} from "../../apps/web/components/contact-edit";
import { ContactEditView, type ContactEditViewProps } from "../../apps/web/components/contact-edit-panel";
import { LeadCaptureProtocol, type LeadCaptureSnapshot } from "../../apps/web/components/lead-capture";
import { LeadCaptureView, type LeadCaptureViewProps } from "../../apps/web/components/lead-capture-panel";

const id = "ee000000-0000-4000-8000-000000000001",
  key = "ee000000-0000-4000-8000-000000000002",
  source = "ee000000-0000-4000-8000-000000000003",
  member = "ee000000-0000-4000-8000-000000000004";
const privateDraft = {
  displayName: "PRIVATE_NAME",
  email: "private@example.test",
  phone: "+15557779999",
  sourceId: source,
  intent: "buyer" as const,
  timeline: "PRIVATE_TIMELINE",
};
const contact = {
  id,
  displayName: privateDraft.displayName,
  emails: [privateDraft.email],
  phones: [privateDraft.phone],
  version: 1,
};
function states() {
  let clock = 1000;
  const edit = new ContactEditProtocol({ wallNow: () => clock, monotonicNow: () => clock });
  edit.bind("PRIVATE_CONTEXT");
  const editCommand = edit.begin(
    { contactId: id, version: 1, body: { displayName: privateDraft.displayName } },
    key,
  );
  edit.reject(editCommand, new Error("PRIVATE_ERROR"));
  const capture = new LeadCaptureProtocol({ wallNow: () => clock, monotonicNow: () => clock });
  capture.bind("PRIVATE_CONTEXT");
  const command = capture.begin(
    {
      contact: { displayName: privateDraft.displayName },
      lead: { sourceId: source, ownerMemberId: member, intent: "buyer", timeline: privateDraft.timeline },
    },
    id,
    key,
  );
  capture.reject(command, new Error("PRIVATE_ERROR"));
  const pending = { edit: edit.getSnapshot(), capture: capture.getSnapshot() };
  clock += contactEditRetryWindowMs;
  expect(edit.forget()).toBe(true);
  expect(capture.forget()).toBe(true);
  return { pending, forgotten: { edit: edit.getSnapshot(), capture: capture.getSnapshot() } };
}
const renderEdit = (snapshot: ContactEditSnapshot, patch: Partial<ContactEditViewProps> = {}) =>
  renderToStaticMarkup(
    <ContactEditView
      contact={contact}
      draft={privateDraft}
      snapshot={snapshot}
      online
      visible
      busy={false}
      reading={false}
      canEdit
      canRead
      canRetry={false}
      currentReviewed
      onDraftChange={vi.fn()}
      onReconcile={vi.fn()}
      onReview={vi.fn()}
      onForget={vi.fn()}
      {...patch}
    />,
  );
const renderCapture = (snapshot: LeadCaptureSnapshot, patch: Partial<LeadCaptureViewProps> = {}) =>
  renderToStaticMarkup(
    <LeadCaptureView
      draft={privateDraft}
      snapshot={snapshot}
      sources={[{ id: source, label: "PRIVATE_SOURCE", code: "synthetic", version: 1 }]}
      online
      visible
      busy={false}
      canCapture
      canRetry={false}
      error="PRIVATE_ERROR"
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onReconcile={vi.fn()}
      onKeepContact={vi.fn()}
      onClose={vi.fn()}
      onForget={vi.fn()}
      {...patch}
    />,
  );
function button(html: string, name: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([markup]) => markup.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}
function noPrivate(html: string) {
  for (const value of [
    id,
    key,
    source,
    member,
    "PRIVATE_NAME",
    "private@example.test",
    "+15557779999",
    "PRIVATE_TIMELINE",
    "PRIVATE_CONTEXT",
    "PRIVATE_SOURCE",
    "PRIVATE_ERROR",
  ])
    expect(html).not.toContain(value);
}
describe("ADR-042 static explicit local forgetting controls, without browser claims", () => {
  it.each(["edit", "capture"] as const)(
    "%s shows explanation and an explicit local-only action at retry expiry",
    (kind) => {
      const value = states().pending;
      const html = kind === "edit" ? renderEdit(value.edit) : renderCapture(value.capture);
      expect(button(html, "Clear this tab’s recovery data")).toBeDefined();
      expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
      expect(html).toMatch(/may or may not have completed/);
      expect(html).toMatch(/does not cancel or undo/);
      expect(html).toMatch(/review current records/i);
      expect(html).not.toMatch(/automatically retry|cancel command|undo command/i);
    },
  );
  it.each(["edit", "capture"] as const)(
    "%s has no forgetting control while the exact command is retryable",
    (kind) => {
      const value = states().pending;
      const html =
        kind === "edit"
          ? renderEdit(value.edit, { canRetry: true })
          : renderCapture(value.capture, { canRetry: true });
      expect(button(html, "Clear this tab’s recovery data")).toBeUndefined();
    },
  );
  it.each(["edit", "capture"] as const)(
    "%s does not invent a forget action without its bound callback",
    (kind) => {
      const value = states().pending;
      const html =
        kind === "edit"
          ? renderEdit(value.edit, { onForget: undefined })
          : renderCapture(value.capture, { onForget: undefined });
      expect(button(html, "Clear this tab’s recovery data")).toBeUndefined();
    },
  );
  it.each(["hidden", "busy", "access"] as const)(
    "%s cuts disable/remove local forgetting without private hidden markup",
    (cut) => {
      const value = states().pending;
      const html = renderEdit(value.edit, {
        visible: cut !== "hidden",
        busy: cut === "busy",
        canRead: cut !== "access",
        canEdit: cut !== "access",
      });
      const action = button(html, "Clear this tab’s recovery data");
      if (action) expect(action).toContain("disabled");
      if (cut !== "busy") noPrivate(html);
    },
  );
  it("edit current-record read blocks forgetting until the read settles", () => {
    expect(
      button(renderEdit(states().pending.edit, { reading: true }), "Clear this tab’s recovery data"),
    ).toContain("disabled");
  });
  it.each(["hidden", "busy", "access"] as const)("capture %s cuts disable/remove local forgetting", (cut) => {
    const html = renderCapture(states().pending.capture, {
      visible: cut !== "hidden",
      busy: cut === "busy",
      canCapture: cut !== "access",
    });
    const action = button(html, "Clear this tab’s recovery data");
    if (action) expect(action).toContain("disabled");
    if (cut !== "busy") noPrivate(html);
  });
  it.each(["edit", "capture"] as const)(
    "%s can locally clear offline when visible and retains only generic markup",
    (kind) => {
      const value = states().pending;
      const html =
        kind === "edit"
          ? renderEdit(value.edit, { online: false })
          : renderCapture(value.capture, { online: false });
      noPrivate(html);
      expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    },
  );
  it.each(["normal", "offline", "hidden", "denied"] as const)(
    "forgotten edit %s ignores stale private contact/draft props",
    (cut) => {
      const html = renderEdit(states().forgotten.edit, {
        online: cut !== "offline",
        visible: cut !== "hidden",
        canRead: cut !== "denied",
        canEdit: cut !== "denied",
      });
      noPrivate(html);
      expect(html).toMatch(/outcome.*unconfirmed/i);
      expect(html).toMatch(/recovery data.*cleared/i);
      expect(html).not.toContain("<input");
      expect(html).not.toContain("<button");
      expect(html).not.toMatch(/saved|failed|cancelled|not applied|resolved/i);
    },
  );
  it.each(["normal", "offline", "hidden", "denied"] as const)(
    "forgotten capture %s removes stale sources/draft/error and offers only close",
    (cut) => {
      const html = renderCapture(states().forgotten.capture, {
        online: cut !== "offline",
        visible: cut !== "hidden",
        canCapture: cut !== "denied",
      });
      noPrivate(html);
      expect(html).toMatch(/outcome.*unconfirmed/i);
      expect(html).toMatch(/recovery data.*cleared/i);
      expect(html).not.toContain("<input");
      expect(button(html, "Close editor")).toBeDefined();
      expect(button(html, "Clear this tab’s recovery data")).toBeUndefined();
      expect(html).not.toMatch(/saved|failed|cancelled|not applied|resolved/i);
    },
  );
});
