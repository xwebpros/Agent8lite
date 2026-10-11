import { describe, expect, it, vi } from "vitest";
import {
  TaskCreateProtocol,
  captureTaskCreateTiming,
  taskCreateContext,
  requireTaskCreateWrite,
} from "../../apps/web/components/task-create";
import { ApiError, type Schema } from "../../apps/web/lib/api";
const id = "fa000000-0000-4000-8000-000000000001",
  member = "fa000000-0000-4000-8000-000000000002",
  lead = "fa000000-0000-4000-8000-000000000003",
  key = "fa000000-0000-4000-8000-000000000004",
  org = "fa000000-0000-4000-8000-000000000005";
const binding = "PRIVATE_USER_ORG_MEMBER_CSRF_ACCESS_FULL_GRANTS",
  horizon = 23 * 60 * 60 * 1000;
const input = (): Schema<"TaskWrite"> => ({
  assigneeMemberId: member,
  leadId: lead,
  title: " Original task ",
  description: " PRIVATE_DESCRIPTION ",
  dueAt: "2026-11-01T01:30:00.123-08:00",
  timezone: "US/Pacific",
  priority: "high",
  state: "open",
});
const receipt = (): Schema<"Task"> => ({
  ...input(),
  id,
  title: "Original task",
  dueAt: "2026-11-01T09:30:00.123Z",
  priority: "high",
  state: "open",
  version: 1,
});
function setup(body = input()) {
  let wall = 1000000,
    mono = 1000;
  const protocol = new TaskCreateProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(binding);
  const command = protocol.begin(body, key);
  return {
    protocol,
    body,
    command,
    clocks: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}

describe("ADR044 exact captured Task POST and normalized historical acknowledgement", () => {
  it("captures detached immutable original title/description/lead/time/key before any caller change", () => {
    const value = setup(),
      json = JSON.stringify(value.body);
    value.body.title = "changed";
    value.body.description = "changed";
    value.body.dueAt = "2026-11-01T08:30:00Z";
    value.body.leadId = member;
    expect(value.command).toMatchObject({ context: binding, key, serializedBody: json, body: input() });
    expect(Object.isFrozen(value.command)).toBe(true);
    expect(Object.isFrozen(value.command.body)).toBe(true);
    expect(() => value.protocol.begin(input(), id)).toThrow();
  });
  it("ambiguous outcome resends the same object/key/body and cannot reconvert its time", () => {
    const value = setup();
    value.protocol.reject(value.command, new TypeError("interrupted"));
    expect(value.protocol.retry()).toBe(value.command);
    expect(value.protocol.retry).toBeDefined();
    expect(value.command.body.dueAt).toBe("2026-11-01T01:30:00.123-08:00");
  });
  it("normalized version1 receipt acknowledges historical creation without supplying current record data", () => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), '"1"')).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(value.protocol.isCurrent(value.command)).toBe(false);
  });
  it("canonical lowercase UUID receipt accepts uppercase original identities without changing request bytes", () => {
    const body = input();
    body.assigneeMemberId = member.toUpperCase();
    body.leadId = lead.toUpperCase();
    const value = setup(body);
    expect(value.protocol.acknowledge(value.command, receipt(), '"1"')).toBe(true);
    expect(value.command.serializedBody).toBe(JSON.stringify(body));
  });
  it("omitted optional fields acknowledge only create defaults, with no inherited Task linkage/description", () => {
    const body = input();
    delete body.description;
    delete body.leadId;
    delete body.priority;
    delete body.state;
    const value = setup(body);
    expect(
      value.protocol.acknowledge(
        value.command,
        { ...receipt(), leadId: null, description: null, priority: "normal", state: "open" },
        '"1"',
      ),
    ).toBe(true);
  });
  it.each([
    { title: "Different" },
    { description: "PRIVATE_DESCRIPTION" },
    { leadId: member },
    { leadId: null },
    { assigneeMemberId: lead },
    { dueAt: "2026-11-01T08:30:00.123Z" },
    { timezone: "America/Los_Angeles" },
    { priority: "normal" },
    { state: "done" },
    { version: 2 },
    { id: "not-uuid" },
    { tenantId: org },
  ])("changed or nonclosed receipt %j cannot acknowledge", (patch) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, { ...receipt(), ...patch }, '"1"')).toBe(false);
    expect(value.protocol.getSnapshot()).toMatchObject({ command: value.command, phase: "unknown" });
  });
  it.each([null, "1", 'W/"1"', '"01"', '"2"'])("ETag %s cannot acknowledge version1 creation", (etag) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), etag)).toBe(false);
    expect(value.protocol.getSnapshot().phase).toBe("unknown");
  });
  it.each([400, 404, 409, 412, 422, 429])(
    "first definitive %s rejection releases only the rejected creation",
    (status) => {
      const value = setup();
      expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("cleared");
      expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "rejected" });
      expect(value.protocol.begin(input(), id)).toBeDefined();
    },
  );
  it.each([408, 500, 502, 503])("initial %s stays unknown", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "PRIVATE"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([404, 409, 412, 422, 429])("retry %s does not prove the original command failed", (status) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interruption"));
    value.protocol.retry();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([401, 403])(
    "current %s clears private command authority and ignores its late acknowledgement",
    (status) => {
      const value = setup();
      expect(value.protocol.reject(value.command, new ApiError(status, "PRIVATE"))).toBe("cleared");
      expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
      expect(value.protocol.isBoundTo(binding)).toBe(false);
      expect(value.protocol.acknowledge(value.command, receipt(), '"1"')).toBe(false);
    },
  );
});

describe("single due conversion and bounded retry lifetime", () => {
  it("captures second repeated-hour UTC/millisecond/alias once and retry never invokes conversion again", () => {
    const converted = { dueAt: "2026-11-01T09:30:00.123Z", timezone: "US/Pacific" },
      resolver = vi.fn(() => converted);
    const timing = captureTaskCreateTiming("2026-11-01T01:30:00.123", resolver),
      value = setup({ ...input(), ...timing });
    converted.dueAt = "2026-11-01T08:30:00.123Z";
    value.protocol.reject(value.command, new TypeError("interruption"));
    value.protocol.retry();
    expect(resolver).toHaveBeenCalledExactlyOnceWith("2026-11-01T01:30:00.123");
    expect(value.command.body).toMatchObject({ dueAt: "2026-11-01T09:30:00.123Z", timezone: "US/Pacific" });
    expect(Object.isFrozen(timing)).toBe(true);
  });
  it.each([
    "",
    "not-a-date",
    "2026-02-30T12:00",
    "2026-13-01T12:00",
    "2026-10-11T25:00",
    "2026-10-11T12:60",
    "2026-10-11T12:00Z",
  ])("invalid local input %s denies before conversion", (entered) => {
    const resolver = vi.fn(() => ({ dueAt: "2026-10-11T12:00:00.000Z", timezone: "UTC" }));
    expect(() => captureTaskCreateTiming(entered, resolver)).toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
  it.each([
    { dueAt: "invalid", timezone: "UTC" },
    { dueAt: "2026-11-01T09:30:00.123Z", timezone: "PST" },
    { dueAt: "2026-11-01T09:30:00.123Z", timezone: "+01:00" },
    { dueAt: "2026-11-01T09:30:00.123Z", timezone: "UTC", hidden: "PRIVATE" },
  ])("invalid/nonclosed converted metadata %j cannot become command input", (value) => {
    expect(() => captureTaskCreateTiming("2026-11-01T01:30", () => value)).toThrow();
  });
  it.each(["PST", "GMT", "+01:00", "PRIVATE_INVALID_ZONE"])(
    "unnamed/invalid Task zone %s cannot begin",
    (timezone) => {
      expect(() => requireTaskCreateWrite({ ...input(), timezone })).toThrow();
    },
  );
  it.each(["wall", "monotonic"] as const)("%s horizon is strictly below23 hours", (clock) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interrupted"));
    value.clocks(
      1000000 + (clock === "wall" ? horizon - 1 : 0),
      1000 + (clock === "monotonic" ? horizon - 1 : 0),
    );
    expect(value.protocol.canRetry()).toBe(true);
    value.clocks(1000000 + (clock === "wall" ? horizon : 0), 1000 + (clock === "monotonic" ? horizon : 0));
    expect(value.protocol.canRetry()).toBe(false);
    expect(value.protocol.canForget()).toBe(true);
    expect(() => value.protocol.retry()).toThrow();
  });
  it.each([
    [NaN, 1000],
    [1000000, Infinity],
    [999999, 1000],
    [1000000, 999],
  ])("clock invalidity/backward %s/%s cannot reset retention lifetime", (wall, mono) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interrupted"));
    value.clocks(wall, mono);
    expect(value.protocol.canRetry()).toBe(false);
    value.clocks(1000001, 1001);
    expect(value.protocol.canRetry()).toBe(false);
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("local forgetting removes private data with no replacement allowed in same binding", () => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interrupted"));
    value.clocks(NaN, 1000);
    expect(value.protocol.forget()).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "forgotten" });
    value.protocol.bind(binding);
    expect(() => value.protocol.begin(input(), id)).toThrow();
    expect(value.protocol.reject(value.command, new ApiError(403, "late"))).toBe("ignored");
    expect(value.protocol.acknowledge(value.command, receipt(), '"1"')).toBe(false);
    value.protocol.bind("new binding");
    value.clocks(2000000, 2000);
    expect(value.protocol.begin(input(), id)).toBeDefined();
  });
  it("active send and retryable unknown command cannot be forgotten", () => {
    const value = setup();
    expect(value.protocol.forget()).toBe(false);
    value.protocol.reject(value.command, new Error("interrupted"));
    expect(value.protocol.forget()).toBe(false);
  });
  it("binding replacement/clearing rejects every old callback and command", () => {
    const value = setup();
    value.protocol.bind("new binding");
    expect(value.protocol.acknowledge(value.command, receipt(), '"1"')).toBe(false);
    expect(value.protocol.reject(value.command, new ApiError(403, "late"))).toBe("ignored");
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(null)).toBe(false);
    expect(() => value.protocol.begin(input(), key)).toThrow();
  });
  it("only current tasks.write is needed and all identity/grants/CSRF/revision changes alter binding", () => {
    const session: Schema<"Session"> = {
      userId: id,
      activeOrgId: org,
      profile: { displayName: "Synthetic", timezone: "UTC" },
      organizations: [],
      permissions: ["crm.tasks.write"],
    };
    const options = { session, memberId: member, csrf: "synthetic-csrf", accessRevision: 1 },
      original = taskCreateContext(options);
    expect(original).not.toBeNull();
    expect(taskCreateContext({ ...options, session: { ...session, permissions: [] } })).toBeNull();
    for (const patch of [
      { csrf: "different" },
      { memberId: lead },
      { accessRevision: 2 },
      { session: { ...session, permissions: ["crm.tasks.write", "crm.tasks.read"] } },
    ])
      expect(taskCreateContext({ ...options, ...patch })).not.toBe(original);
  });
  it("accessor-provided description is rejected without running it", () => {
    let calls = 0;
    const body = input();
    Object.defineProperty(body, "description", {
      enumerable: true,
      get: () => {
        calls++;
        return "PRIVATE";
      },
    });
    expect(() => setup(body)).toThrow();
    expect(calls).toBe(0);
  });
  it.each(["object-getter", "object-function", "array-getter", "array-function"] as const)(
    "inherited %s JSON hooks cannot alter command or receipt",
    (kind) => {
      const prototype = kind.startsWith("object") ? Object.prototype : Array.prototype,
        old = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0,
        accepted = false;
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get: () => {
                  calls++;
                  return () => "PRIVATE";
                },
              }
            : {
                configurable: true,
                value: () => {
                  calls++;
                  return "PRIVATE";
                },
              },
        );
        const value = setup();
        accepted = value.protocol.acknowledge(value.command, receipt(), '"1"');
      } finally {
        if (old) Object.defineProperty(prototype, "toJSON", old);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(calls).toBe(0);
      expect(accepted).toBe(true);
    },
  );
});
