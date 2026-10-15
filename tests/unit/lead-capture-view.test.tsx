import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LeadCaptureView, type LeadCaptureViewProps } from "../../apps/web/components/lead-capture-panel";
import { LeadCaptureProtocol, type LeadCaptureSnapshot } from "../../apps/web/components/lead-capture";
import { ApiError } from "../../apps/web/lib/api";

const id = "ec000000-0000-4000-8000-000000000001",
  source = "ec000000-0000-4000-8000-000000000002",
  member = "ec000000-0000-4000-8000-000000000003",
  ck = "ec000000-0000-4000-8000-000000000004",
  lk = "ec000000-0000-4000-8000-000000000005";
const draft = {
  displayName: "PRIVATE_NAME",
  email: "private@example.test",
  phone: "+15550001111",
  sourceId: source,
  intent: "buyer" as const,
  timeline: "PRIVATE_TIMELINE",
};
function state(
  phase:
    | "contact-sending"
    | "contact-unknown"
    | "lead-ready"
    | "lead-sending"
    | "lead-unknown"
    | "lead-rejected",
): LeadCaptureSnapshot {
  const protocol = new LeadCaptureProtocol();
  protocol.bind("PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS");
  const command = protocol.begin(
    {
      contact: { displayName: draft.displayName, emails: [draft.email], phones: [draft.phone] },
      lead: { sourceId: source, ownerMemberId: member, intent: draft.intent, timeline: draft.timeline },
    },
    ck,
    lk,
  );
  if (phase === "contact-unknown") protocol.reject(command, new TypeError("PRIVATE_PROVIDER_ERROR"));
  else if (phase !== "contact-sending") {
    protocol.acknowledge(
      command,
      { id, displayName: draft.displayName, emails: [draft.email], phones: [draft.phone], version: 1 },
      '"1"',
    );
    if (phase !== "lead-ready") {
      const lead = protocol.startLead();
      if (phase === "lead-unknown") protocol.reject(lead, new TypeError("PRIVATE_PROVIDER_ERROR"));
      if (phase === "lead-rejected") protocol.reject(lead, new ApiError(422, "safe", "source_invalid"));
    }
  }
  return protocol.getSnapshot();
}
function render(patch: Partial<LeadCaptureViewProps> = {}) {
  return renderToStaticMarkup(
    <LeadCaptureView
      draft={draft}
      snapshot={{ sequence: null, command: null, phase: "idle" }}
      sources={[{ id: source, label: "Synthetic manual source", code: "manual", version: 1 }]}
      online
      visible
      busy={false}
      canCapture
      canRetry
      onDraftChange={vi.fn()}
      onSave={vi.fn()}
      onReconcile={vi.fn()}
      onKeepContact={vi.fn()}
      onClose={vi.fn()}
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
    draft.displayName,
    draft.email,
    draft.phone,
    draft.timeline,
    source,
    id,
    member,
    ck,
    lk,
    "PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS",
    "PRIVATE_PROVIDER_ERROR",
  ])
    expect(html).not.toContain(value);
}

describe("Add lead static native controls and truthful partial/unknown states", () => {
  it("renders native labeled fields and discloses independent saves/no delivery/unknown consent", () => {
    const html = render();
    for (const value of [
      "Full name",
      "Email",
      "Phone (optional)",
      "Intent",
      "Source",
      "Timeline (optional)",
      "Contact and lead creation are separate saves",
      "No email or SMS is sent",
      "Communication consent remains unknown",
    ])
      expect(html).toContain(value);
    expect(html).toContain('type="email"');
    expect(html).toContain('type="tel"');
    expect(button(html, "Save lead")).not.toContain("disabled");
    expect(button(html, "Cancel")).not.toContain("disabled");
  });
  it.each(["contact-sending", "lead-sending"] as const)(
    "%s disables draft/send/close during the in-flight command",
    (phase) => {
      const html = render({ snapshot: state(phase) });
      expect(html).toMatch(/<fieldset disabled/);
      expect(button(html, "Saving…")).toContain("disabled");
      expect(button(html, "Cancel")).toContain("disabled");
      expect(html).not.toContain("Keep saved contact and close");
    },
  );
  it.each(["contact-unknown", "lead-unknown"] as const)(
    "%s exposes only same-step reconciliation and disables replacement/close",
    (phase) => {
      const html = render({ snapshot: state(phase) });
      expect(html).toContain("original unconfirmed step");
      expect(html).toContain("captured input cannot be changed");
      expect(html).toMatch(/<fieldset disabled/);
      expect(button(html, "Reconcile original step")).not.toContain("disabled");
      expect(button(html, "Save lead")).toContain("disabled");
      expect(button(html, "Cancel")).toContain("disabled");
      expect(html).not.toContain("Keep saved contact and close");
      expect(html).not.toContain(ck);
      expect(html).not.toContain(lk);
    },
  );
  it("contact unknown explicitly says no lead has been sent", () => {
    expect(render({ snapshot: state("contact-unknown") })).toContain("No lead has been sent");
  });
  it("lead unknown truthfully retains acknowledged contact without declaring the lead saved", () => {
    const html = render({ snapshot: state("lead-unknown") });
    expect(html).toContain("Contact creation is acknowledged. Lead creation is unconfirmed");
    expect(html).not.toContain("Lead creation is acknowledged.");
  });
  it("the never-sent lead-ready form reflects original lead input and cannot be silently changed", () => {
    const html = render({
      snapshot: state("lead-ready"),
      draft: { ...draft, intent: "seller", timeline: "LATER_EDIT" },
    });
    expect(html).not.toContain("LATER_EDIT");
    expect(html).toContain("PRIVATE_TIMELINE");
    const fieldset = html.match(/<fieldset[^>]*>/)?.[0] ?? "";
    const selects = [...html.matchAll(/<select\b[^>]*>/g)].map((v) => v[0]);
    expect(fieldset.includes("disabled") || selects.every((v) => v.includes("disabled"))).toBe(true);
    expect(button(html, "Keep saved contact and close")).not.toContain("disabled");
  });
  it("first lead rejection permits explicit corrected lead-only attempt but keeps contact values read-only", () => {
    const html = render({ snapshot: state("lead-rejected") });
    expect(html).toContain("The contact is saved");
    expect(html).toContain("first lead attempt was rejected");
    expect(html).toContain("readOnly");
    expect(button(html, "Keep saved contact and close")).not.toContain("disabled");
    expect(button(html, "Save reviewed lead")).not.toContain("disabled");
  });
  it("an expired unknown step stays unresolved and cannot close or be replaced", () => {
    const html = render({ snapshot: state("lead-unknown"), canRetry: false });
    expect(html).toContain("original outcome remains unconfirmed");
    expect(html).toContain("no replacement is permitted");
    expect(button(html, "Reconcile original step")).toContain("disabled");
    expect(button(html, "Cancel")).toContain("disabled");
  });
  it.each(["offline", "hidden"] as const)(
    "%s withholds all private form/source/command data for every pending state",
    (cut) => {
      for (const phase of [
        "contact-sending",
        "contact-unknown",
        "lead-ready",
        "lead-sending",
        "lead-unknown",
        "lead-rejected",
      ] as const) {
        const html = render({ snapshot: state(phase), online: cut !== "offline", visible: cut !== "hidden" });
        noPrivate(html);
        expect(html).not.toContain("<input");
        expect(html).not.toContain("<select");
        expect(button(html, "Reconcile original step")).toContain("disabled");
        expect(html).not.toContain("draft has not been saved");
      }
    },
  );
  it.each(["offline", "hidden"] as const)("%s ordinary draft is private too", (cut) => {
    const html = render({ online: cut !== "offline", visible: cut !== "hidden" });
    noPrivate(html);
  });
  it.each(["denied", "permission-cut"] as const)(
    "%s never renders retained private input even with stale props",
    (cut) => {
      const snapshot = state("lead-unknown");
      const html = render({
        snapshot: cut === "denied" ? { ...snapshot, phase: "denied" } : snapshot,
        canCapture: cut !== "permission-cut",
      });
      noPrivate(html);
      expect(html).not.toContain("<input");
      expect(html).toContain("No success or failure is inferred");
    },
  );
  it("busy disables both known-partial exit and reviewed lead send", () => {
    const html = render({ snapshot: state("lead-rejected"), busy: true });
    expect(button(html, "Keep saved contact and close")).toContain("disabled");
    expect(button(html, "Save reviewed lead")).toContain("disabled");
  });
  it("missing draft/source cannot submit an ordinary empty capture", () => {
    expect(button(render({ draft: null }), "Save lead")).toContain("disabled");
    expect(button(render({ draft: { ...draft, sourceId: "" } }), "Save lead")).toContain("disabled");
  });
  it("a missing current source remains explicitly unverified rather than silently substituting the first source", () => {
    const html = render({ sources: [] });
    expect(html).toContain("Previously selected source");
    expect(html).toContain(source);
  });
  it("complete receipt status distinguishes acknowledged save from separate current list availability", () => {
    const html = render({ snapshot: { sequence: null, command: null, phase: "acknowledged" } });
    expect(html).toContain("Lead creation is acknowledged. Current lists are read separately");
    expect(html).not.toContain("unconfirmed");
  });
});
