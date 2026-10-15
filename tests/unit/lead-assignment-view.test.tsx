import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  LeadAssignmentView,
  type LeadAssignmentViewProps,
} from "../../apps/web/components/lead-assignment-panel";
import {
  LeadAssignmentProtocol,
  type LeadAssignmentSnapshot,
} from "../../apps/web/components/lead-assignment";
import type { Schema } from "../../apps/web/lib/api";

const leadId = "ef000000-0000-4000-8000-000000000001",
  contactId = "ef000000-0000-4000-8000-000000000002",
  sourceId = "ef000000-0000-4000-8000-000000000003",
  stageId = "ef000000-0000-4000-8000-000000000004",
  memberId = "ef000000-0000-4000-8000-000000000005",
  target = "ef000000-0000-4000-8000-000000000006",
  disabled = "ef000000-0000-4000-8000-000000000007",
  key = "ef000000-0000-4000-8000-000000000008";
const lead = (): Schema<"Lead"> => ({
  id: leadId,
  contactId,
  sourceId,
  stageId,
  ownerMemberId: memberId,
  intent: "buyer",
  timeline: "PRIVATE_LEAD_TIMELINE",
  score: 10,
  scoreVersion: "PRIVATE_SCORE_VERSION",
  version: 1,
});
const member = (id: string, status: Schema<"Member">["status"] = "active"): Schema<"Member"> => ({
  id,
  displayName: id === target ? "PRIVATE_TARGET_NAME" : "PRIVATE_DISABLED_NAME",
  roleId: sourceId,
  status,
  version: 1,
});
function pending(phase: "unknown" | "sending" = "unknown"): LeadAssignmentSnapshot {
  const protocol = new LeadAssignmentProtocol();
  protocol.bind("PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS");
  const command = protocol.begin({ lead: lead(), body: { ownerMemberId: target } }, key);
  if (phase === "unknown") protocol.reject(command, new Error("PRIVATE_PROVIDER_ERROR"));
  return protocol.getSnapshot();
}
function render(patch: Partial<LeadAssignmentViewProps> = {}) {
  return renderToStaticMarkup(
    <LeadAssignmentView
      snapshot={{ command: null, phase: "idle" }}
      currentLead={lead()}
      members={[member(target), member(disabled, "disabled")]}
      memberId={memberId}
      targetMemberId={target}
      draftChanged
      canUnassign={false}
      catalogueState="ready"
      hasMore={false}
      online
      visible
      busy={false}
      canAssign
      canRetry
      onTargetChange={vi.fn()}
      onSave={vi.fn()}
      onReconcile={vi.fn()}
      onForget={vi.fn()}
      onRefreshMembers={vi.fn()}
      onMoreMembers={vi.fn()}
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
  for (const value of [
    leadId,
    contactId,
    sourceId,
    stageId,
    memberId,
    target,
    disabled,
    key,
    "PRIVATE_LEAD_TIMELINE",
    "PRIVATE_SCORE_VERSION",
    "PRIVATE_TARGET_NAME",
    "PRIVATE_DISABLED_NAME",
    "PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS",
    "PRIVATE_PROVIDER_ERROR",
  ])
    expect(html).not.toContain(value);
}

describe("private-safe recoverable assignment presentation", () => {
  it("offers active choices and self without claiming catalogue authority or submitting the enclosing Lead form", () => {
    const html = render();
    expect(html).toContain("Assigned member");
    expect(html).toContain("Assign to me");
    expect(html).toContain("PRIVATE_TARGET_NAME");
    expect(html).not.toContain("PRIVATE_DISABLED_NAME");
    expect(html).not.toContain("PRIVATE_LEAD_TIMELINE");
    expect(html).toContain("server checks current assignment access");
    expect(html).not.toContain("Unassigned queue");
    expect(button(html, "Save assignment")).not.toContain("disabled");
    expect([...html.matchAll(/<button\b[^>]*>/g)].every(([tag]) => tag.includes('type="button"'))).toBe(true);
    expect(html).not.toContain("<form");
  });
  it("an explicitly verified organization scope may choose null; unverified scope cannot save null", () => {
    expect(render({ canUnassign: true, targetMemberId: null })).toContain("Unassigned queue");
    expect(button(render({ canUnassign: true, targetMemberId: null }), "Save assignment")).not.toContain(
      "disabled",
    );
    expect(button(render({ targetMemberId: null }), "Save assignment")).toContain("disabled");
  });
  it("member discovery failure leaves self available but never approves an unavailable other member", () => {
    const self = render({ catalogueState: "unavailable", members: [], targetMemberId: memberId });
    expect(button(self, "Save assignment")).not.toContain("disabled");
    expect(self).toContain("Additional member choices are unavailable");
    const other = render({ catalogueState: "unavailable", targetMemberId: target });
    expect(other).toContain("Current selection unavailable");
    expect(button(other, "Save assignment")).toContain("disabled");
  });
  it.each([{ busy: true }, { draftChanged: false }, { catalogueState: "loading" as const }])(
    "current save guard %j uses a native disabled button",
    (patch) => {
      expect(button(render(patch), "Save assignment")).toContain("disabled");
    },
  );
  it("conflict without a current record offers no command; a separately verified current record permits review", () => {
    const snapshot: LeadAssignmentSnapshot = { command: null, phase: "conflict" };
    const unavailable = render({ snapshot, currentLead: null });
    privateAbsent(unavailable);
    expect(unavailable).not.toContain("<select");
    expect(unavailable).not.toContain("Save assignment");
    const current = render({ snapshot, currentLead: { ...lead(), version: 3 } });
    expect(current).toContain("Read its current version");
    expect(button(current, "Save assignment")).not.toContain("disabled");
  });
  it("acknowledgement is distinguished from separately read current details", () => {
    const html = render({ snapshot: { command: null, phase: "acknowledged" } });
    expect(html).toContain("Assignment acknowledged");
    expect(html).toContain("Current lead details are read separately");
    const unavailable = render({ snapshot: { command: null, phase: "acknowledged" }, currentLead: null });
    privateAbsent(unavailable);
    expect(unavailable).toContain("Current lead assignment is unavailable");
    expect(unavailable).not.toContain("Save assignment");
  });
  it.each([
    { online: false },
    { visible: false },
    { canAssign: false },
    { snapshot: { ...pending(), phase: "denied" as const } },
  ])("inactive/denied stale props %j never render private Lead or members", (patch) => {
    const html = render(patch);
    privateAbsent(html);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Save assignment");
  });
  it("unknown outcome offers exact reconciliation without private input or new assignment controls", () => {
    const html = render({ snapshot: pending() });
    privateAbsent(html);
    expect(html).toContain("may have completed");
    expect(button(html, "Reconcile assignment")).not.toContain("disabled");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Save assignment");
    expect(html).not.toContain("Clear this tab");
  });
  it.each([{ online: false }, { visible: false }, { busy: true }, { canRetry: false }])(
    "unknown current display guard %j disables resend",
    (patch) => {
      const html = render({ snapshot: pending(), ...patch });
      privateAbsent(html);
      expect(button(html, "Reconcile assignment")).toContain("disabled");
    },
  );
  it("in-flight state cannot send a replacement or forget before uncertainty", () => {
    const html = render({ snapshot: pending("sending"), canRetry: false });
    privateAbsent(html);
    expect(html).toContain("Confirming assignment");
    expect(button(html, "Reconcile assignment")).toContain("disabled");
    expect(html).not.toContain("Clear this tab");
  });
  it("expired unknown may clear local recovery offline while warning that no remote action is undone", () => {
    const html = render({ snapshot: pending(), canRetry: false, online: false });
    privateAbsent(html);
    expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    expect(html).toContain("does not cancel or undo");
    expect(button(html, "Reconcile assignment")).toContain("disabled");
  });
  it.each([{ visible: false }, { busy: true }])("local forget guard %j is disabled", (patch) => {
    const html = render({ snapshot: pending(), canRetry: false, ...patch });
    privateAbsent(html);
    expect(button(html, "Clear this tab’s recovery data")).toContain("disabled");
  });
  it("forgotten state ignores stale private command/current-record/catalogue props", () => {
    const html = render({ snapshot: { ...pending(), phase: "forgotten" } });
    privateAbsent(html);
    expect(html).toContain("cleared");
    expect(html).toContain("duplicate");
    expect(html).not.toContain("<button");
  });
  it("loaded catalogue cap and continuation are disclosed without inventing total eligibility", () => {
    const members = Array.from({ length: 200 }, (_, index) =>
      member("ef000000-0000-4000-8000-" + (index + 100).toString(16).padStart(12, "0")),
    );
    const html = render({ members, hasMore: true, targetMemberId: memberId });
    expect(html).toContain("at most 200 loaded member records");
    expect(button(html, "Load more members")).not.toContain("disabled");
    expect(html).not.toContain("total members");
  });
});
