import { describe, expect, it } from "vitest";
import {
  LeadCaptureProtocol,
  leadCaptureContext,
  leadCaptureRetryWindowMs,
  requireLeadCaptureInput,
  type LeadCaptureInput,
  type LeadCaptureTemplate,
} from "../../apps/web/components/lead-capture";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const contactId = "ea000000-0000-4000-8000-000000000001",
  leadId = "ea000000-0000-4000-8000-000000000002",
  sourceId = "ea000000-0000-4000-8000-000000000003",
  memberId = "ea000000-0000-4000-8000-000000000004",
  stageId = "ea000000-0000-4000-8000-000000000005",
  contactKey = "ea000000-0000-4000-8000-000000000006",
  leadKey = "ea000000-0000-4000-8000-000000000007",
  nextKey = "ea000000-0000-4000-8000-000000000008";
const context = "verified-user/org/member/csrf/access/grants";
function input(): LeadCaptureInput {
  return {
    contact: {
      displayName: " Original name ",
      emails: ["FIRST@example.test", "second@example.test", "first@example.test"],
      phones: ["+1 (555) 333-4444", "+15553334444"],
      birthday: null,
    },
    lead: { sourceId, ownerMemberId: memberId, intent: "buyer", timeline: "Original timeline" },
  };
}
function contact(): Schema<"Contact"> {
  return {
    id: contactId,
    displayName: "Original name",
    emails: ["second@example.test", "first@example.test"],
    phones: ["+15553334444"],
    birthday: null,
    version: 1,
  };
}
function lead(): Schema<"Lead"> {
  return {
    id: leadId,
    contactId,
    sourceId,
    stageId,
    ownerMemberId: memberId,
    intent: "buyer",
    timeline: "Original timeline",
    version: 1,
    score: null,
    scoreVersion: null,
  };
}
function setup(body = input()) {
  let wall = 1000000,
    mono = 1000;
  const protocol = new LeadCaptureProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(context);
  const command = protocol.begin(body, contactKey, leadKey);
  if (command.step !== "contact") throw new Error("Expected contact command");
  return {
    protocol,
    command,
    body,
    clocks: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
function leadSetup() {
  const value = setup();
  expect(value.protocol.acknowledge(value.command, contact(), '"1"')).toBe("contact");
  return { ...value, command: value.protocol.startLead() };
}

describe("ADR040 immutable two-step creation without a compound atomicity promise", () => {
  it("captures the complete form and two distinct keys before the contact request", () => {
    const { protocol, command, body } = setup(),
      json = JSON.stringify(body.contact);
    body.contact.displayName = "later";
    body.contact.emails![0] = "later@example.test";
    body.lead.intent = "seller";
    body.lead.timeline = "later";
    expect(command).toMatchObject({ step: "contact", key: contactKey, context, serializedBody: json });
    expect(command.body.displayName).toBe(" Original name ");
    expect(protocol.getSnapshot().sequence?.input.lead.intent).toBe("buyer");
    expect(Object.isFrozen(command.body)).toBe(true);
    expect(Object.isFrozen(command.body.emails)).toBe(true);
    expect(Object.isFrozen(protocol.getSnapshot().sequence?.input.lead)).toBe(true);
    expect(() => protocol.startLead()).toThrow();
    expect(() => protocol.begin(input(), contactKey, leadKey)).toThrow();
  });
  it("a normalized version1 Contact acknowledges only contact then injects its UUID into the retained lead", () => {
    const { protocol, command } = setup();
    expect(protocol.acknowledge(command, contact(), '"1"')).toBe("contact");
    expect(protocol.getSnapshot()).toMatchObject({
      phase: "lead-ready",
      command: null,
      sequence: { contactId },
    });
    const next = protocol.startLead();
    expect(next).toMatchObject({ step: "lead", key: leadKey, body: { ...input().lead, contactId } });
    expect(protocol.isCurrent(command)).toBe(false);
    expect(() => protocol.startLead()).toThrow();
    expect(protocol.acknowledge(next, lead(), '"1"')).toBe("lead");
    expect(protocol.getSnapshot()).toEqual({ phase: "acknowledged", sequence: null, command: null });
  });
  it("omitted create channels mean newly created empty sets, not preserved unrelated channels", () => {
    const value = setup({ contact: { displayName: " Original name " }, lead: input().lead });
    expect(value.protocol.acknowledge(value.command, contact(), '"1"')).toBe(false);
    expect(
      value.protocol.acknowledge(value.protocol.retry(), { ...contact(), emails: [], phones: [] }, '"1"'),
    ).toBe("contact");
  });
  it("omitted birthday cannot acknowledge an unexpected populated create receipt", () => {
    const value = setup({ contact: { displayName: " Original name " }, lead: input().lead });
    expect(
      value.protocol.acknowledge(
        value.command,
        { ...contact(), emails: [], phones: [], birthday: "2000-02-29" },
        '"1"',
      ),
    ).toBe(false);
    expect(value.protocol.getSnapshot().phase).toBe("contact-unknown");
  });
  it("valid canonical UUID receipts may lowercase the retained source/owner UUIDs", () => {
    const body = input();
    body.lead.sourceId = sourceId.toUpperCase();
    body.lead.ownerMemberId = memberId.toUpperCase();
    const value = setup(body);
    value.protocol.acknowledge(value.command, contact(), '"1"');
    const next = value.protocol.startLead();
    if (next.step !== "lead") throw new Error("Expected lead command");
    expect(value.protocol.acknowledge(next, lead(), '"1"')).toBe("lead");
    expect(next.body.sourceId).toBe(sourceId.toUpperCase());
  });
  it.each([null, 'W/"1"', '"01"', '"2"', "1"])(
    "unverified Contact ETag %s cannot advance to lead",
    (etag) => {
      const value = setup();
      expect(value.protocol.acknowledge(value.command, contact(), etag)).toBe(false);
      expect(value.protocol.getSnapshot().phase).toBe("contact-unknown");
      expect(() => value.protocol.startLead()).toThrow();
    },
  );
  it.each([
    { version: 2 },
    { displayName: "different" },
    { emails: ["different@example.test"] },
    { phones: ["+15550001111"] },
    { birthday: "2001-01-01" },
    { id: "not-uuid" },
    { privatePayload: "unapproved" },
  ])("Contact mismatch case%# stays unknown", (patch) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, { ...contact(), ...patch }, '"1"')).toBe(false);
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([
    { version: 2 },
    { id: "not-uuid" },
    { contactId: leadId },
    { sourceId: leadId },
    { ownerMemberId: leadId },
    { intent: "seller" },
    { timeline: "changed" },
    { stageId: "unknown-stage" },
    { privatePayload: "unapproved" },
  ])("Lead mismatch case%# does not claim completion", (patch) => {
    const value = leadSetup();
    expect(value.protocol.acknowledge(value.command, { ...lead(), ...patch }, '"1"')).toBe(false);
    expect(value.protocol.getSnapshot().phase).toBe("lead-unknown");
    expect(value.protocol.getSnapshot().sequence?.contactId).toBe(contactId);
  });
  it.each([{ score: 10 }, { scoreVersion: "unapproved-scoring" }])(
    "manual lead receipt does not invent scoring%#",
    (patch) => {
      const value = leadSetup();
      expect(value.protocol.acknowledge(value.command, { ...lead(), ...patch }, '"1"')).toBe(false);
      expect(value.protocol.getSnapshot().phase).toBe("lead-unknown");
    },
  );
  it("an omitted lead timeline is explicitly equivalent only to a null/omitted receipt timeline", () => {
    const body = input();
    delete body.lead.timeline;
    const value = setup(body);
    value.protocol.acknowledge(value.command, contact(), '"1"');
    expect(value.protocol.acknowledge(value.protocol.startLead(), { ...lead(), timeline: null }, '"1"')).toBe(
      "lead",
    );
  });
  it.each([contactKey, contactKey.toUpperCase(), "malformed"])(
    "does not accept invalid or reused second key%s",
    (key) => {
      const protocol = new LeadCaptureProtocol();
      protocol.bind(context);
      expect(() => protocol.begin(input(), contactKey, key)).toThrow();
    },
  );
  it("closed generated snapshots reject accessors without evaluating private values", () => {
    let calls = 0;
    const body = input();
    Object.defineProperty(body.contact, "displayName", {
      enumerable: true,
      get: () => {
        calls++;
        return "private";
      },
    });
    expect(() => requireLeadCaptureInput(body)).toThrow();
    expect(calls).toBe(0);
  });
  it.each(["extra", "contactId", "owner", "sparse"])("rejects invalid captured shape%s", (caseName) => {
    const body: unknown =
      caseName === "extra"
        ? { ...input(), tenantId: contactId }
        : caseName === "contactId"
          ? { ...input(), lead: { ...input().lead, contactId } }
          : caseName === "owner"
            ? { ...input(), lead: { ...input().lead, ownerMemberId: null } }
            : { ...input(), contact: { displayName: "x", emails: new Array(1) } };
    expect(() => requireLeadCaptureInput(body)).toThrow();
  });
  it("Object/Array inherited serialization hooks never alter captured input or receipts", () => {
    const oldObject = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON"),
      oldArray = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let calls = 0;
    try {
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        get: () => {
          calls++;
          return () => {
            calls++;
            return "poison";
          };
        },
      });
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        get: () => {
          calls++;
          return () => {
            calls++;
            return [];
          };
        },
      });
      const value = setup();
      expect(value.protocol.acknowledge(value.command, contact(), '"1"')).toBe("contact");
      expect(value.protocol.acknowledge(value.protocol.startLead(), lead(), '"1"')).toBe("lead");
      expect(calls).toBe(0);
    } finally {
      if (oldObject) Object.defineProperty(Object.prototype, "toJSON", oldObject);
      else Reflect.deleteProperty(Object.prototype, "toJSON");
      if (oldArray) Object.defineProperty(Array.prototype, "toJSON", oldArray);
      else Reflect.deleteProperty(Array.prototype, "toJSON");
    }
  });
});

describe("ambiguous step outcomes, known partial success and exact original retries", () => {
  it.each(["contact", "lead"] as const)(
    "unknown%s retry uses the same immutable object/key and cannot close or replace",
    (step) => {
      const value = step === "contact" ? setup() : leadSetup();
      expect(value.protocol.reject(value.command, new TypeError("private transport details"))).toBe(
        "unknown",
      );
      expect(value.protocol.retry()).toBe(value.command);
      expect(value.protocol.keepContactAndClose()).toBe(false);
      expect(() => value.protocol.correctLead(input().lead, nextKey)).toThrow();
      expect(() => value.protocol.begin(input(), contactKey, nextKey)).toThrow();
    },
  );
  it.each([400, 409, 412, 422, 429])(
    "initial Contact rejection%s releases form without claiming saved",
    (status) => {
      const value = setup();
      expect(value.protocol.reject(value.command, new ApiError(status, "safe", "rejected"))).toBe("cleared");
      expect(value.protocol.getSnapshot()).toEqual({
        phase: "contact-rejected",
        sequence: null,
        command: null,
      });
      expect(() => value.protocol.startLead()).toThrow();
    },
  );
  it.each([400, 409, 412, 422, 429])(
    "unknown reconciliation%s cannot prove the original request failed",
    (status) => {
      const value = leadSetup();
      value.protocol.reject(value.command, new TypeError("unknown"));
      expect(value.protocol.reject(value.protocol.retry(), new ApiError(status, "safe", "rejected"))).toBe(
        "unknown",
      );
      expect(value.protocol.getSnapshot().command).toBe(value.command);
      expect(value.protocol.keepContactAndClose()).toBe(false);
    },
  );
  it.each([408, 500, 503])("initial%s remains ambiguous and keeps its original key", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe", "unknown"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("known first lead rejection can explicitly correct only lead with a fresh key and fixed contact/owner", () => {
    const value = leadSetup();
    value.protocol.reject(value.command, new ApiError(422, "safe", "source_invalid"));
    const template: LeadCaptureTemplate = { ...input().lead, sourceId: stageId, intent: "seller" };
    value.protocol.correctLead(template, nextKey);
    template.intent = "unknown";
    const next = value.protocol.startLead();
    expect(next).toMatchObject({
      step: "lead",
      key: nextKey,
      body: { contactId, sourceId: stageId, intent: "seller", ownerMemberId: memberId },
    });
    expect(value.protocol.getSnapshot().sequence?.contactKey).toBe(contactKey);
    expect(() => value.protocol.correctLead(input().lead, leadKey)).toThrow();
  });
  it("lead-ready input remains original until its first attempt has actually been rejected", () => {
    const value = setup();
    value.protocol.acknowledge(value.command, contact(), '"1"');
    expect(() => value.protocol.correctLead({ ...input().lead, intent: "seller" }, nextKey)).toThrow();
    expect(value.protocol.startLead().key).toBe(leadKey);
  });
  it("a corrected lead cannot assign a new owner or reuse either original key", () => {
    const value = leadSetup();
    value.protocol.reject(value.command, new ApiError(422, "safe", "rejected"));
    for (const key of [contactKey, leadKey])
      expect(() => value.protocol.correctLead(input().lead, key)).toThrow();
    expect(() =>
      value.protocol.correctLead({ ...input().lead, ownerMemberId: contactId }, nextKey),
    ).toThrow();
  });
  it.each(["never-sent", "rejected"] as const)(
    "explicit keep-contact close is allowed only for known partial%s",
    (kind) => {
      const value = setup();
      value.protocol.acknowledge(value.command, contact(), '"1"');
      if (kind === "rejected")
        value.protocol.reject(value.protocol.startLead(), new ApiError(422, "safe", "rejected"));
      expect(value.protocol.keepContactAndClose()).toBe(true);
      expect(value.protocol.getSnapshot()).toEqual({ phase: "idle", sequence: null, command: null });
    },
  );
  it.each([401, 403])("current%s clears private sequence without declaring success or retrying", (status) => {
    const value = leadSetup();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe", "denied"))).toBe("cleared");
    expect(value.protocol.getSnapshot()).toEqual({ phase: "denied", sequence: null, command: null });
    expect(value.protocol.isBoundTo(context)).toBe(false);
  });
  it("context/CSRF/grant changes cut old acknowledgements/denials and exact retries", () => {
    const value = setup();
    value.protocol.bind("new verified context");
    expect(value.protocol.acknowledge(value.command, contact(), '"1"')).toBe(false);
    expect(value.protocol.reject(value.command, new ApiError(403, "safe", "denied"))).toBe("ignored");
    expect(value.protocol.isBoundTo(context)).toBe(false);
    expect(value.protocol.isBoundTo(null)).toBe(false);
    expect(() => value.protocol.retry()).toThrow();
  });
});

describe("per-step wall/monotonic retry lifetime and full verified binding", () => {
  it("starts lead lifetime at its first send rather than contact send/acknowledgement", () => {
    const value = setup();
    value.clocks(1000000 + leadCaptureRetryWindowMs - 1, 1000 + leadCaptureRetryWindowMs - 1);
    value.protocol.acknowledge(value.command, contact(), '"1"');
    const next = value.protocol.startLead();
    expect(next.firstWall).toBe(1000000 + leadCaptureRetryWindowMs - 1);
    value.protocol.reject(next, new TypeError("unknown"));
    expect(value.protocol.canRetry()).toBe(true);
  });
  it.each(["wall", "monotonic"] as const)(
    "retry stops at exactly23h on%s while preserving the unknown step",
    (clock) => {
      const value = setup();
      value.protocol.reject(value.command, new TypeError("unknown"));
      value.clocks(
        clock === "wall" ? 1000000 + leadCaptureRetryWindowMs : 1000000,
        clock === "monotonic" ? 1000 + leadCaptureRetryWindowMs : 1000,
      );
      expect(value.protocol.canRetry()).toBe(false);
      expect(() => value.protocol.retry()).toThrow();
      expect(value.protocol.getSnapshot().command).toBe(value.command);
      expect(value.protocol.keepContactAndClose()).toBe(false);
    },
  );
  it.each([
    [999999, 1000],
    [1000000, 999],
    [NaN, 1000],
    [1000000, Infinity],
  ])("invalid/backward clock%# never restarts the horizon", (wall, mono) => {
    const value = setup();
    value.protocol.reject(value.command, new TypeError("unknown"));
    value.clocks(wall, mono);
    expect(value.protocol.canRetry()).toBe(false);
    value.clocks(1000000, 1000);
    expect(value.protocol.canRetry()).toBe(false);
  });
  it("full context accepts exactly the published write grants without read/source grants", () => {
    const session = {
        userId: contactId,
        activeOrgId: leadId,
        permissions: ["crm.contacts.write", "crm.leads.write"],
      } as Schema<"Session">,
      value = { session, memberId, csrf: "synthetic-csrf", accessRevision: 1 };
    const original = leadCaptureContext(value);
    expect(original).not.toBeNull();
    expect(
      leadCaptureContext({
        ...value,
        session: { ...session, permissions: [...session.permissions].reverse() },
      }),
    ).toBe(original);
    for (const changed of [
      { ...value, csrf: "new-csrf" },
      { ...value, memberId: stageId },
      { ...value, accessRevision: 2 },
      { ...value, session: { ...session, permissions: [...session.permissions, "crm.contacts.read"] } },
    ])
      expect(leadCaptureContext(changed)).not.toBe(original);
    for (const invalid of [
      { ...value, csrf: "" },
      { ...value, accessRevision: NaN },
      { ...value, session: null },
      { ...value, session: { ...session, permissions: ["crm.contacts.write"] } },
    ])
      expect(leadCaptureContext(invalid)).toBeNull();
  });
});
