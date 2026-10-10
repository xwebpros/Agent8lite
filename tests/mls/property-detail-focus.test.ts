import { describe, expect, it } from "vitest";
import { PropertyDetailFocus } from "../../apps/web/features/properties/detail-focus";

function target(name: string, history: string[], connected = true) {
  return {
    isConnected: connected,
    focus: () => {
      history.push(name);
    },
  };
}
const scope = "synthetic-member:org-A:access-1";

describe("current property detail focus lifecycle (helper tests, no browser acceptance)", () => {
  it("focuses the mounted detail heading while a read is still loading", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.open(scope, "listing-A");
    expect(focus.show(scope, true, null)).toBe(false);
    const heading = target("loading-heading", history);
    expect(focus.show(scope, true, heading)).toBe(true);
    expect(history).toEqual(["loading-heading"]);
  });

  it("does not steal focus on response completion or automatic refresh", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.open(scope, "listing-A");
    focus.show(scope, true, target("heading", history));
    focus.show(scope, true, target("response-heading", history));
    focus.show(scope, true, target("refreshed-heading", history));
    expect(history).toEqual(["heading"]);
  });

  it("allows an explicit reopen of the same selection to focus the existing heading again", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    const heading = target("heading", history);
    focus.open(scope, "listing-A");
    focus.show(scope, true, heading);
    focus.open(scope, "listing-A");
    focus.show(scope, true, heading);
    expect(history).toEqual(["heading", "heading"]);
  });

  it("returns to the current card after its original opener was replaced during refresh", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    const original = target("removed-card", history);
    const dispose = focus.register(scope, "listing-A", original);
    focus.open(scope, "listing-A");
    original.isConnected = false;
    focus.register(scope, "listing-A", target("current-card", history));
    dispose();
    expect(focus.close(scope, true, target("properties-heading", history))).toBe(true);
    expect(history).toEqual(["current-card"]);
  });

  it("a late ref cleanup cannot erase a replacement registration of the same reused DOM node", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    const button = target("reused-card", history);
    const dispose = focus.register(scope, "listing-A", button);
    focus.register(scope, "listing-A", button);
    dispose();
    focus.open(scope, "listing-A");
    focus.close(scope, true, target("fallback", history));
    expect(history).toEqual(["reused-card"]);
  });

  it("cleanup after a context reset cannot erase newly registered controls", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    const dispose = focus.register(scope, "listing-A", target("old-card", history));
    focus.reset();
    focus.register(scope, "listing-A", target("new-card", history));
    dispose();
    focus.open(scope, "listing-A");
    focus.close(scope, true, target("fallback", history));
    expect(history).toEqual(["new-card"]);
  });

  it.each(["unmounted", "disconnected"])(
    "falls back to the Properties heading when the selected card is %s",
    (state) => {
      const focus = new PropertyDetailFocus();
      const history: string[] = [];
      const card = target("withdrawn-card", history);
      const dispose = focus.register(scope, "listing-A", card);
      focus.open(scope, "listing-A");
      if (state === "unmounted") dispose();
      else card.isConnected = false;
      focus.close(scope, true, target("properties-heading", history));
      expect(history).toEqual(["properties-heading"]);
    },
  );

  it("never returns to a different listing's control", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register(scope, "listing-B", target("other-listing", history));
    focus.open(scope, "listing-A");
    focus.close(scope, true, target("properties-heading", history));
    expect(history).toEqual(["properties-heading"]);
  });

  it("does not use a different organization's control with an identical native ID", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register("synthetic-member:org-B:access-1", "listing-A", target("other-org", history));
    focus.open(scope, "listing-A");
    focus.close(scope, true, target("current-properties-heading", history));
    expect(history).toEqual(["current-properties-heading"]);
  });

  it("a changed scope cannot focus either stale controls or the new workspace's fallback", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register(scope, "listing-A", target("old-org-card", history));
    focus.open(scope, "listing-A");
    const nextScope = "synthetic-member:org-B:access-1";
    expect(focus.show(nextScope, true, target("new-org-detail", history))).toBe(false);
    expect(focus.close(nextScope, true, target("new-org-heading", history))).toBe(false);
    expect(history).toEqual([]);
  });

  it("offline/revoked access prevents focus and consumes an old close request", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register(scope, "listing-A", target("private-card", history));
    focus.open(scope, "listing-A");
    expect(focus.show(scope, false, target("private-heading", history))).toBe(false);
    expect(focus.close(scope, false, target("fallback", history))).toBe(false);
    expect(focus.close(scope, true, target("fallback", history))).toBe(false);
    expect(history).toEqual([]);
  });

  it("clears selected controls and pending heading focus across access revision changes", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register(scope, "listing-A", target("old-access-card", history));
    focus.open(scope, "listing-A");
    focus.reset();
    const nextScope = "synthetic-member:org-A:access-2";
    expect(focus.show(nextScope, true, target("heading", history))).toBe(false);
    expect(focus.close(nextScope, true, target("fallback", history))).toBe(false);
    focus.open(nextScope, "listing-A");
    focus.close(nextScope, true, target("fallback", history));
    expect(history).toEqual(["fallback"]);
  });

  it("filter dismissal cancels pending heading/return focus without moving focus from the form", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.register(scope, "listing-A", target("old-card", history));
    focus.open(scope, "listing-A");
    focus.dismiss();
    expect(focus.show(scope, true, target("detail-heading", history))).toBe(false);
    expect(focus.close(scope, true, target("properties-heading", history))).toBe(false);
    expect(history).toEqual([]);
  });

  it("disconnected headings never receive focus or consume a pending open", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    const heading = target("heading", history, false);
    focus.open(scope, "listing-A");
    expect(focus.show(scope, true, heading)).toBe(false);
    heading.isConnected = true;
    expect(focus.show(scope, true, heading)).toBe(true);
    expect(history).toEqual(["heading"]);
  });

  it("does not attempt focus when both the opener and fallback have been removed", () => {
    const focus = new PropertyDetailFocus();
    const history: string[] = [];
    focus.open(scope, "listing-A");
    expect(focus.close(scope, true, target("removed-heading", history, false))).toBe(false);
    expect(focus.close(scope, true, null)).toBe(false);
    expect(history).toEqual([]);
  });
});
