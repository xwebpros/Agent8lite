import { describe, expect, it, vi } from "vitest";
import {
  TaskEditProtocol,
  requireTaskEditTask,
  requireTaskEditWrite,
  taskEditRetryWindowMs,
} from "../../apps/web/components/task-edit";
import { resolveTaskDrawerTiming } from "../../apps/web/components/task-agenda-time";
import { ApiError, type Schema } from "../../apps/web/lib/api";
const id = "da000000-0000-4000-8000-000000000001",
  member = "da000000-0000-4000-8000-000000000002",
  lead = "da000000-0000-4000-8000-000000000003",
  key = "da000000-0000-4000-8000-000000000004",
  other = "da000000-0000-4000-8000-000000000005",
  binding = "PRIVATE_USER_ORG_MEMBER_CSRF_GRANTS";
const task = (): Schema<"Task"> => ({
  id,
  assigneeMemberId: member,
  leadId: lead,
  title: "PRIVATE_TASK_TITLE",
  description: " PRIVATE_DESCRIPTION ",
  dueAt: "2026-11-01T09:30:00.123Z",
  timezone: "US/Pacific",
  priority: "high",
  state: "open",
  version: 7,
});
const input = (): Schema<"TaskWrite"> => ({
  assigneeMemberId: member,
  title: " Edited synthetic title ",
  dueAt: task().dueAt,
  timezone: task().timezone,
});
const receipt = (): Schema<"Task"> => ({ ...task(), title: "Edited synthetic title", version: 8 });
function setup(body: Schema<"TaskWrite"> = input(), ifMatch?: string) {
  let wall = 1000000,
    mono = 1000;
  const protocol = new TaskEditProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(binding);
  const original = task(),
    command = protocol.begin({ task: original, body, ...(ifMatch === undefined ? {} : { ifMatch }) }, key);
  return {
    protocol,
    original,
    body,
    command,
    clock: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
describe("immutable full Task PATCH and historical receipt", () => {
  it("detaches original full Task/body/exact bytes/revision before caller changes", () => {
    const v = setup(),
      bytes = JSON.stringify(v.body);
    v.body.title = "later";
    v.body.leadId = null;
    v.original.description = "later";
    v.original.version = 99;
    expect(v.command).toMatchObject({
      context: binding,
      taskId: id,
      version: 7,
      key,
      ifMatch: '"7"',
      serializedBody: bytes,
      body: input(),
      originalTask: task(),
    });
    for (const x of [v.command, v.command.body, v.command.originalTask, v.protocol.getSnapshot()])
      expect(Object.isFrozen(x)).toBe(true);
  });
  it("completion and drawer cannot replace each other's unknown command", () => {
    const v = setup();
    v.protocol.reject(v.command, new Error("interrupted"));
    expect(() => v.protocol.begin({ task: task(), body: { ...input(), state: "done" } }, other)).toThrow();
    expect(v.protocol.retry()).toBe(v.command);
  });
  it("ACK verifies historical complete fields without inserting a current Task", () => {
    const v = setup(),
      newer = { ...task(), version: 9, state: "cancelled", title: "newer" },
      before = JSON.stringify(newer);
    expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(true);
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(JSON.stringify(newer)).toBe(before);
    expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(false);
  });
  it("requested optional values override original and explicit null/empty clears", () => {
    const v = setup({ ...input(), description: "", leadId: null, priority: "low", state: "done" });
    expect(
      v.protocol.acknowledge(
        v.command,
        { ...receipt(), description: "", leadId: null, priority: "low", state: "done" },
        '"8"',
      ),
    ).toBe(true);
  });
  it("omitted fields retain original description/priority/state/link", () => {
    const v = setup();
    expect(Object.hasOwn(v.command.body, "description")).toBe(false);
    expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(true);
  });
  it("uppercase UUID requests retain exact bytes and accept lowercase database receipt", () => {
    const protocol = new TaskEditProtocol();
    protocol.bind(binding);
    const original = {
        ...task(),
        id: id.toUpperCase(),
        assigneeMemberId: member.toUpperCase(),
        leadId: lead.toUpperCase(),
      },
      body = { ...input(), assigneeMemberId: member.toUpperCase() },
      command = protocol.begin({ task: original, body }, key);
    expect(command.serializedBody).toBe(JSON.stringify(body));
    expect(protocol.acknowledge(command, receipt(), '"8"')).toBe(true);
  });
  it.each(['"7"', "7", '"007"', "007"])("retains original accepted If-Match %s exactly", (ifMatch) => {
    expect(setup(input(), ifMatch).command.ifMatch).toBe(ifMatch);
  });
  it.each(["", 'W/"7"', '"8"', '"7', "7.0", "-7"])(
    "invalid/revision-mismatched If-Match %s cannot start",
    (ifMatch) => {
      expect(() => setup(input(), ifMatch)).toThrow();
    },
  );
  it.each([
    { id: other },
    { assigneeMemberId: other },
    { leadId: null },
    { description: null },
    { description: "modified" },
    { priority: "normal" },
    { state: "done" },
    { title: "wrong" },
    { dueAt: "2026-11-01T08:30:00.123Z" },
    { timezone: "America/Los_Angeles" },
    { version: 7 },
    { version: 9 },
    { private: "PRIVATE" },
  ])("mismatched receipt %j remains unknown", (patch) => {
    const v = setup();
    expect(v.protocol.acknowledge(v.command, { ...receipt(), ...patch }, '"8"')).toBe(false);
    expect(v.protocol.getSnapshot()).toMatchObject({ command: v.command, phase: "unknown" });
  });
  it.each([null, "8", '"08"', 'W/"8"', '"7"', '"9"'])("nonmatching receipt ETag %s does not ACK", (etag) => {
    const v = setup();
    expect(v.protocol.acknowledge(v.command, receipt(), etag)).toBe(false);
  });
  it("semantic due instant accepts a verified equivalent offset without recapturing", () => {
    const v = setup();
    expect(
      v.protocol.acknowledge(v.command, { ...receipt(), dueAt: "2026-11-01T01:30:00.123-08:00" }, '"8"'),
    ).toBe(true);
  });
  it.each([400, 404, 409, 412, 422, 429])("first definitive %s releases only the command", (status) => {
    const v = setup();
    expect(v.protocol.reject(v.command, new ApiError(status, "PRIVATE"))).toBe("cleared");
    expect(v.protocol.getSnapshot()).toEqual({
      command: null,
      phase: status === 412 ? "conflict" : "rejected",
    });
  });
  it.each([408, 500, 502, 503])("first ambiguous %s preserves exact retry", (status) => {
    const v = setup();
    expect(v.protocol.reject(v.command, new ApiError(status, "PRIVATE"))).toBe("unknown");
    expect(v.protocol.retry()).toBe(v.command);
  });
  it.each([400, 404, 409, 412, 422, 429])(
    "reconciliation %s cannot disprove original completion",
    (status) => {
      const v = setup();
      v.protocol.reject(v.command, new Error());
      v.protocol.retry();
      expect(v.protocol.reject(v.command, new ApiError(status, "safe"))).toBe("unknown");
      expect(v.protocol.getSnapshot().command).toBe(v.command);
    },
  );
  it.each([401, 403])("current %s cuts private command and all late ACK", (status) => {
    const v = setup();
    v.protocol.reject(v.command, new Error());
    expect(v.protocol.reject(v.command, new ApiError(status, "private"))).toBe("cleared");
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
    expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(false);
  });
  it.each([null, "other-org", "rotated-csrf", "new-access"])("binding %s cuts old callbacks", (context) => {
    const v = setup();
    v.protocol.bind(context);
    expect(v.protocol.isBoundTo(binding)).toBe(false);
    expect(v.protocol.reject(v.command, new ApiError(403, "late"))).toBe("ignored");
    expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(false);
  });
  it("same binding retains original; copied command has no authority", () => {
    const v = setup();
    v.protocol.bind(binding);
    expect(v.protocol.isCurrent({ ...v.command })).toBe(false);
    expect(v.protocol.reject({ ...v.command }, new ApiError(403, "late"))).toBe("ignored");
    expect(v.protocol.getSnapshot().command).toBe(v.command);
  });
});
describe("lifetime, forgetting and exact original timing", () => {
  it.each(["wall", "monotonic"] as const)("%s strictly limits 23-hour retry", (clock) => {
    const v = setup();
    v.protocol.reject(v.command, new Error());
    v.clock(
      1000000 + (clock === "wall" ? taskEditRetryWindowMs - 1 : 0),
      1000 + (clock === "monotonic" ? taskEditRetryWindowMs - 1 : 0),
    );
    expect(v.protocol.canRetry()).toBe(true);
    v.clock(
      1000000 + (clock === "wall" ? taskEditRetryWindowMs : 0),
      1000 + (clock === "monotonic" ? taskEditRetryWindowMs : 0),
    );
    expect(v.protocol.canRetry()).toBe(false);
    expect(v.protocol.canForget()).toBe(true);
    expect(() => v.protocol.retry()).toThrow();
  });
  it.each([
    [999999, 1000],
    [1000000, 999],
    [Number.NaN, 1000],
    [1000000, Number.POSITIVE_INFINITY],
  ])("invalid/backward clock %j permanently fails closed", (wall, mono) => {
    const v = setup();
    v.protocol.reject(v.command, new Error());
    v.clock(wall, mono);
    expect(v.protocol.canRetry()).toBe(false);
    v.clock(1000001, 1001);
    expect(v.protocol.canRetry()).toBe(false);
    expect(v.protocol.forget()).toBe(true);
  });
  it("forget removes every private value, disables old callbacks and blocks same-binding PATCH", () => {
    const v = setup();
    v.protocol.reject(v.command, new Error());
    v.clock(1000000 + taskEditRetryWindowMs, 1000);
    expect(v.protocol.forget()).toBe(true);
    expect(v.protocol.getSnapshot()).toEqual({ command: null, phase: "forgotten" });
    expect(v.protocol.isCurrent(v.command)).toBe(false);
    expect(() => v.protocol.begin({ task: task(), body: input() }, other)).toThrow();
    v.protocol.bind("new-context");
    expect(v.protocol.begin({ task: task(), body: input() }, other)).toBeDefined();
  });
  it("retryable or sending command cannot be forgotten", () => {
    const v = setup();
    expect(v.protocol.forget()).toBe(false);
    v.protocol.reject(v.command, new Error());
    expect(v.protocol.forget()).toBe(false);
  });
  it("unchanged drawer preserves exact second fall occurrence/ms/alias without resolver", () => {
    const resolver = vi.fn(),
      original = task(),
      timing = resolveTaskDrawerTiming(
        { dueAt: original.dueAt, timezone: original.timezone },
        "2026-11-01T01:30",
        "2026-11-01T01:30",
        resolver,
      );
    const v = setup({ ...input(), ...timing });
    v.protocol.reject(v.command, new Error());
    expect(v.protocol.retry()).toBe(v.command);
    expect(v.command.body).toMatchObject({ dueAt: original.dueAt, timezone: "US/Pacific" });
    expect(resolver).not.toHaveBeenCalled();
  });
  it("changed due resolves once before command and retry retains converted instant", () => {
    const resolver = vi.fn(() => ({ dueAt: "2026-11-02T10:01:22.456Z", timezone: "US/Pacific" })),
      timing = resolveTaskDrawerTiming(
        { dueAt: task().dueAt, timezone: task().timezone },
        "2026-11-01T01:30",
        "2026-11-02T02:01",
        resolver,
      ),
      v = setup({ ...input(), ...timing });
    v.protocol.reject(v.command, new Error());
    v.protocol.retry();
    expect(resolver).toHaveBeenCalledExactlyOnceWith("2026-11-02T02:01");
    expect(v.command.body.dueAt).toBe("2026-11-02T10:01:22.456Z");
  });
  it.each(["PST", "GMT", "+01:00", "PRIVATE_ZONE"])("invalid zone %s cannot enter command", (timezone) =>
    expect(() => requireTaskEditWrite({ ...input(), timezone })).toThrow(),
  );
  it("getter source/receipt is rejected without evaluating private fields", () => {
    let calls = 0;
    const hostile = task();
    Object.defineProperty(hostile, "title", {
      enumerable: true,
      get() {
        calls++;
        return "PRIVATE";
      },
    });
    expect(() => requireTaskEditTask(hostile)).toThrow();
    const v = setup();
    expect(v.protocol.acknowledge(v.command, hostile, '"8"')).toBe(false);
    expect(calls).toBe(0);
  });
  it.each(["object-function", "array-function", "object-getter", "array-getter"])(
    "inherited JSON %s is never used",
    (kind) => {
      const prototype = kind.startsWith("object") ? Object.prototype : Array.prototype,
        previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0;
      try {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          ...(kind.endsWith("getter")
            ? {
                get() {
                  calls++;
                  return () => "PRIVATE";
                },
              }
            : {
                value() {
                  calls++;
                  return "PRIVATE";
                },
              }),
        });
        const v = setup();
        expect(v.protocol.acknowledge(v.command, receipt(), '"8"')).toBe(true);
        expect(calls).toBe(0);
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
    },
  );
});
