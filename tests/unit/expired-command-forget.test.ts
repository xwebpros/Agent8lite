import { describe, expect, it, vi } from "vitest";
import { ContactEditProtocol, contactEditRetryWindowMs } from "../../apps/web/components/contact-edit";
import { LeadCaptureProtocol } from "../../apps/web/components/lead-capture";
import { ApiError } from "../../apps/web/lib/api";

const id = "ed000000-0000-4000-8000-000000000001",
  source = "ed000000-0000-4000-8000-000000000002",
  member = "ed000000-0000-4000-8000-000000000003",
  key = "ed000000-0000-4000-8000-000000000004",
  leadKey = "ed000000-0000-4000-8000-000000000005";
const binding = "PRIVATE_USER_ORG_MEMBER_CSRF_CURRENT_GRANTS";
const input = () => ({
  contact: { displayName: "PRIVATE_NAME", emails: ["private@example.test"], phones: ["+15551112222"] },
  lead: { sourceId: source, ownerMemberId: member, intent: "buyer" as const, timeline: "PRIVATE_TIMELINE" },
});
const contact = () => ({
  id,
  displayName: "PRIVATE_NAME",
  emails: ["private@example.test"],
  phones: ["+15551112222"],
  version: 1,
});
type Kind = "contact edit" | "contact creation" | "lead creation";
function setup(kind: Kind) {
  let wall = 1_000_000,
    monotonic = 1000;
  const clocks = { wallNow: () => wall, monotonicNow: () => monotonic };
  const move = (w: number, m: number) => {
    wall = w;
    monotonic = m;
  };
  if (kind === "contact edit") {
    const protocol = new ContactEditProtocol(clocks);
    protocol.bind(binding);
    const command = protocol.begin({ contactId: id, version: 1, body: input().contact }, key);
    return {
      protocol,
      move,
      unknown: () => protocol.reject(command, new TypeError("private network error")),
      late: () => protocol.acknowledge(command, { ...contact(), version: 2 }, '"2"'),
      lateReject: () => protocol.reject(command, new ApiError(403, "private", "permission_denied")),
      current: () => protocol.isCurrent(command),
      begin: () => protocol.begin({ contactId: id, version: 1, body: input().contact }, leadKey),
      clear: () => protocol.clear(),
      start: () => undefined,
      correct: () => undefined,
      partialClose: () => undefined,
    };
  }
  const protocol = new LeadCaptureProtocol(clocks);
  protocol.bind(binding);
  let command = protocol.begin(input(), key, leadKey);
  if (kind === "lead creation") {
    expect(protocol.acknowledge(command, contact(), '"1"')).toBe("contact");
    command = protocol.startLead();
  }
  return {
    protocol,
    move,
    unknown: () => protocol.reject(command, new TypeError("private network error")),
    late: () =>
      protocol.acknowledge(
        command,
        command.step === "contact"
          ? contact()
          : {
              id: leadKey,
              contactId: id,
              sourceId: source,
              stageId: key,
              ownerMemberId: member,
              intent: "buyer",
              timeline: "PRIVATE_TIMELINE",
              version: 1,
            },
        '"1"',
      ),
    lateReject: () => protocol.reject(command, new ApiError(403, "private", "permission_denied")),
    current: () => protocol.isCurrent(command),
    begin: () => protocol.begin(input(), key, leadKey),
    clear: () => undefined,
    start: () => protocol.startLead(),
    correct: () => protocol.correctLead(input().lead, key),
    partialClose: () => protocol.keepContactAndClose(),
  };
}
const kinds: Kind[] = ["contact edit", "contact creation", "lead creation"];
describe.each(kinds)("ADR-042 expired %s tab-only recovery forgetting", (kind) => {
  it("does not offer forgetting during send or while exact retry is available", () => {
    const value = setup(kind);
    expect(value.protocol.canForget()).toBe(false);
    expect(value.protocol.forget()).toBe(false);
    value.unknown();
    expect(value.protocol.canRetry()).toBe(true);
    expect(value.protocol.canForget()).toBe(false);
    expect(value.protocol.forget()).toBe(false);
    expect(value.current()).toBe(true);
  });
  it.each(["wall", "monotonic"] as const)("allows forgetting exactly at the %s 23-hour boundary", (clock) => {
    const value = setup(kind);
    value.unknown();
    value.move(
      1_000_000 + (clock === "wall" ? contactEditRetryWindowMs - 1 : 0),
      1000 + (clock === "monotonic" ? contactEditRetryWindowMs - 1 : 0),
    );
    expect(value.protocol.canForget()).toBe(false);
    value.move(
      1_000_000 + (clock === "wall" ? contactEditRetryWindowMs : 0),
      1000 + (clock === "monotonic" ? contactEditRetryWindowMs : 0),
    );
    expect(value.protocol.canForget()).toBe(true);
    expect(value.protocol.forget()).toBe(true);
  });
  it.each([
    [Number.NaN, 1000],
    [1_000_000, Number.POSITIVE_INFINITY],
    [999_999, 1000],
    [1_000_000, 999],
  ])("allows explicit forgetting after invalid/backward clock (%s,%s)", (wall, mono) => {
    const value = setup(kind);
    value.unknown();
    value.move(wall, mono);
    expect(value.protocol.canForget()).toBe(true);
    expect(value.protocol.forget()).toBe(true);
  });
  it("forgets synchronously without network, retaining only a generic phase and no private command data", () => {
    const value = setup(kind);
    value.unknown();
    value.move(1_000_000 + contactEditRetryWindowMs, 1000);
    const fetch = vi.fn(() => {
      throw new Error("Forgetting must never request a server outcome");
    });
    vi.stubGlobal("fetch", fetch);
    try {
      expect(value.protocol.forget()).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(value.protocol.getSnapshot()).toEqual(
      kind === "contact edit"
        ? { command: null, phase: "forgotten" }
        : { sequence: null, command: null, phase: "forgotten" },
    );
    const retained = JSON.stringify(value.protocol.getSnapshot());
    for (const privateValue of [
      id,
      source,
      member,
      key,
      leadKey,
      binding,
      "PRIVATE_NAME",
      "private@example.test",
      "PRIVATE_TIMELINE",
    ])
      expect(retained).not.toContain(privateValue);
    expect(Object.isFrozen(value.protocol.getSnapshot())).toBe(true);
    expect(value.current()).toBe(false);
  });
  it("late successful or denied responses cannot acknowledge, restore or replace the forgotten outcome", () => {
    const value = setup(kind);
    value.unknown();
    value.move(Number.NaN, 1000);
    value.protocol.forget();
    expect(value.late()).toBe(false);
    expect(value.lateReject()).toBe("ignored");
    expect(value.protocol.getSnapshot().phase).toBe("forgotten");
    expect(value.protocol.canRetry()).toBe(false);
  });
  it("same binding and ordinary clear cannot silently enable a replacement command", () => {
    const value = setup(kind);
    value.unknown();
    value.move(Number.NaN, 1000);
    value.protocol.forget();
    value.protocol.bind(binding);
    value.clear();
    expect(value.protocol.getSnapshot().phase).toBe("forgotten");
    expect(value.begin).toThrow();
    expect(() => value.protocol.retry()).toThrow();
    if (kind !== "contact edit") {
      expect(value.start).toThrow();
      expect(value.correct).toThrow();
      expect(value.partialClose()).toBe(false);
    }
    expect(value.protocol.forget()).toBe(false);
  });
  it("verified context replacement resets the controller lifetime without an automatic new command", () => {
    const value = setup(kind);
    value.unknown();
    value.move(Number.NaN, 1000);
    value.protocol.forget();
    value.protocol.bind("different verified context");
    expect(value.protocol.getSnapshot().phase).toBe("idle");
    expect(value.protocol.getSnapshot().command).toBeNull();
    expect(value.protocol.isBoundTo(binding)).toBe(false);
    value.move(2_000_000, 2000);
    expect(value.begin()).toBeDefined();
  });
  it("losing the binding clears recovery memory without claiming any outcome", () => {
    const value = setup(kind);
    value.unknown();
    value.move(Number.NaN, 1000);
    value.protocol.forget();
    value.protocol.bind(null);
    expect(value.protocol.getSnapshot().phase).toBe("idle");
    expect(value.protocol.getSnapshot().command).toBeNull();
    expect(value.begin).toThrow();
  });
});
