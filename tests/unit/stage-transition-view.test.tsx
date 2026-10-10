import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  StageTransitionView,
  type StageTransitionViewProps,
} from "../../apps/web/components/stage-transition-panel";
import {
  StageTransitionProtocol,
  type StageTransitionSnapshot,
} from "../../apps/web/components/stage-transition";
const leadId = "ed000000-0000-4000-8000-000000000001",
  contactId = "ed000000-0000-4000-8000-000000000002",
  sourceId = "ed000000-0000-4000-8000-000000000003",
  stageId = "ed000000-0000-4000-8000-000000000004",
  target = "ed000000-0000-4000-8000-000000000005",
  key = "ed000000-0000-4000-8000-000000000006";
function state(phase: "sending" | "unknown" = "unknown"): StageTransitionSnapshot {
  const protocol = new StageTransitionProtocol();
  protocol.bind("PRIVATE_CSRF_ORG_MEMBER_AUTHORITY");
  const command = protocol.begin(
    {
      lead: {
        id: leadId,
        contactId,
        sourceId,
        stageId,
        intent: "buyer",
        timeline: "PRIVATE_TIMELINE",
        version: 1,
      },
      body: { toStageId: target, reason: "PRIVATE_REASON" },
    },
    key,
  );
  if (phase === "unknown") protocol.reject(command, new Error("PRIVATE_PROVIDER_TEXT"));
  return protocol.getSnapshot();
}
function render(patch: Partial<StageTransitionViewProps> = {}) {
  return renderToStaticMarkup(
    <StageTransitionView
      snapshot={state()}
      online
      visible
      busy={false}
      canWrite
      canRetry
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
function noPrivate(html: string) {
  for (const value of [
    leadId,
    contactId,
    sourceId,
    stageId,
    target,
    key,
    "PRIVATE_CSRF_ORG_MEMBER_AUTHORITY",
    "PRIVATE_TIMELINE",
    "PRIVATE_REASON",
    "PRIVATE_PROVIDER_TEXT",
  ])
    expect(html).not.toContain(value);
}
describe("private-safe native stage recovery presentation", () => {
  it("unknown exposes exact reconciliation and distinguishes historical acknowledgement from current read", () => {
    const html = render();
    noPrivate(html);
    expect(button(html, "Reconcile stage transition")).not.toContain("disabled");
    expect(html).toContain("may have completed");
    expect(html).toContain("separate current-record read");
    expect(html).not.toContain("successfully");
  });
  it.each([{ online: false }, { visible: false }, { busy: true }, { canWrite: false }, { canRetry: false }])(
    "current display/access cut %j disables reconciliation",
    (patch) => {
      const html = render(patch);
      noPrivate(html);
      expect(button(html, "Reconcile stage transition")).toContain("disabled");
    },
  );
  it("sending has no replacement or local-forget action and disables resending", () => {
    const html = render({ snapshot: state("sending"), canRetry: false });
    noPrivate(html);
    expect(html).toContain("Confirming stage transition");
    expect(button(html, "Reconcile stage transition")).toContain("disabled");
    expect(html).not.toContain("Clear this tab");
  });
  it("expired unknown permits a visible local-only offline forget without claiming cancellation", () => {
    const html = render({ canRetry: false, online: false });
    noPrivate(html);
    expect(button(html, "Reconcile stage transition")).toContain("disabled");
    expect(button(html, "Clear this tab’s recovery data")).not.toContain("disabled");
    expect(html).toContain("does not cancel or undo");
    expect(html).toContain("unconfirmed");
  });
  it.each([{ visible: false }, { busy: true }, { canWrite: false }])(
    "local forgetting %j has a native disabled guard",
    (patch) => {
      expect(button(render({ ...patch, canRetry: false }), "Clear this tab’s recovery data")).toContain(
        "disabled",
      );
    },
  );
  it("retryable unknown does not offer local forgetting", () => {
    expect(render()).not.toContain("Clear this tab");
  });
  it("forgotten generic state never recovers private stale command props or claims completion", () => {
    const html = render({ snapshot: { ...state(), phase: "forgotten" } });
    noPrivate(html);
    expect(html).toContain("cleared");
    expect(html).toContain("duplicate");
    expect(html).not.toContain("Reconcile stage transition");
  });
  it("access denial ignores stale private command props and reports no interrupted outcome", () => {
    const html = render({ snapshot: { ...state(), phase: "denied" } });
    noPrivate(html);
    expect(html).toContain("no interrupted outcome is inferred");
    expect(html).not.toContain("<button");
  });
  it("an acknowledged/idle command-free snapshot does not keep a recovery panel", () => {
    expect(render({ snapshot: { command: null, phase: "acknowledged" } })).toBe("");
    expect(render({ snapshot: { command: null, phase: "idle" } })).toBe("");
  });
});
