import { describe, expect, it, vi } from "vitest";
import { TaskCompletionProtocol } from "../../apps/web/components/task-completion";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const taskId = "dc000000-0000-4000-8000-000000000001";
const memberId = "dc000000-0000-4000-8000-000000000002";
const leadId = "dc000000-0000-4000-8000-000000000003";
const key = "dc000000-0000-4000-8000-000000000004";
function task(): Schema<"Task"> {
  return {
    id: taskId,
    assigneeMemberId: memberId,
    leadId,
    title: "Complete original synthetic follow-up",
    dueAt: "2026-11-01T09:30:00.000Z",
    timezone: "America/Los_Angeles",
    priority: "high",
    state: "open",
    version: 7,
  };
}
function setup() {
  const protocol = new TaskCompletionProtocol();
  protocol.bind("user:org:member:access:csrf");
  const source = task();
  const command = protocol.begin(source, key);
  const receipt = { ...source, state: "done" as const, version: 8 };
  return { protocol, command, source, receipt };
}

describe("context-bound completion acknowledgement and original-command reconciliation", () => {
  it("does not authorize null or unbound callback context", () => {
    const protocol = new TaskCompletionProtocol();
    expect(protocol.isBoundTo(null)).toBe(false);
    expect(protocol.isBoundTo("previous-context")).toBe(false);
    protocol.bind(null);
    expect(protocol.isBoundTo(null)).toBe(false);
  });
  it("recognizes the exact current verified callback binding before a command exists", () => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("user:org:member:access:csrf");
    expect(protocol.isBoundTo("user:org:member:access:csrf")).toBe(true);
    expect(protocol.isBoundTo("user:other-org:member:access:csrf")).toBe(false);
    expect(protocol.isBoundTo("user:org:member:access:rotated-csrf")).toBe(false);
    expect(protocol.isBoundTo(null)).toBe(false);
    protocol.clear();
    expect(protocol.isBoundTo("user:org:member:access:csrf")).toBe(true);
  });
  it.each([null, "user:other-org:member:access:csrf", "user:org:member:changed-access:csrf"])(
    "denies a retained callback binding after context cut %# at every command phase",
    (next) => {
      const { protocol, command, receipt } = setup();
      expect(protocol.isBoundTo(command.context)).toBe(true);
      protocol.reject(command, new TypeError("Original outcome unavailable"));
      expect(protocol.isBoundTo(command.context)).toBe(true);
      protocol.bind(next);
      expect(protocol.isBoundTo(command.context)).toBe(false);
      expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
      expect(() => protocol.retry()).toThrow();
      expect(protocol.isCurrent(command)).toBe(false);
      expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
      expect(protocol.reject(command, new Error("Late network outcome"))).toBe("ignored");
      if (next !== null) expect(protocol.isBoundTo(next)).toBe(true);
    },
  );
  it("does not authorize an empty binding even if a caller supplied one", () => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("");
    expect(protocol.isBoundTo("")).toBe(false);
    expect(() => protocol.begin(task(), key)).toThrow();
  });
  it("captures original body/key/revision before yielding and never retains the mutable source", () => {
    const { protocol, command, source } = setup();
    expect(command).toEqual({
      context: "user:org:member:access:csrf",
      taskId,
      version: 7,
      key,
      body: {
        assigneeMemberId: memberId,
        leadId,
        title: source.title,
        dueAt: source.dueAt,
        timezone: source.timezone,
        priority: "high",
        state: "done",
      },
    });
    source.title = "Newer private title";
    source.version = 99;
    source.leadId = null;
    expect(command.body.title).toBe("Complete original synthetic follow-up");
    expect(command.body.leadId).toBe(leadId);
    expect(command.version).toBe(7);
    expect(protocol.getSnapshot()).toEqual({ phase: "sending", command });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.body)).toBe(true);
    expect(Object.isFrozen(protocol.getSnapshot())).toBe(true);
  });
  it("requires a bound context and an explicit valid key", () => {
    const protocol = new TaskCompletionProtocol();
    expect(() => protocol.begin(task(), key)).toThrow();
    protocol.bind("verified-context");
    for (const invalid of ["", "new-key", " PRIVATE ", "dc000000-0000-4000-8000-00000000000x"])
      expect(() => protocol.begin(task(), invalid)).toThrow();
    expect(protocol.getSnapshot().command).toBeNull();
  });
  it.each(["done", "cancelled"] as const)("does not create a new completion for%s source", (state) => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("context");
    expect(() => protocol.begin({ ...task(), state }, key)).toThrow();
    expect(protocol.getSnapshot().phase).toBe("idle");
  });
  it("blocks unrelated completions and retry until an outcome is unknown", () => {
    const { protocol } = setup();
    expect(() => protocol.begin({ ...task(), id: leadId }, memberId)).toThrow();
    expect(() => protocol.retry()).toThrow();
  });
  it.each([
    new TypeError("network failed"),
    new SyntaxError("JSON outcome unavailable"),
    new ApiError(408, "timeout"),
    new ApiError(500, "failed"),
    new ApiError(502, "gateway"),
    new ApiError(503, "unavailable"),
    new ApiError(504, "timeout"),
  ])("retains an ambiguous initial outcome without inventing a new command %#", (error) => {
    const { protocol, command } = setup();
    expect(protocol.reject(command, error)).toBe("unknown");
    expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
    expect(protocol.retry()).toBe(command);
    expect(protocol.getSnapshot()).toEqual({ command, phase: "sending" });
  });
  it.each([400, 404, 409, 412, 422, 429])(
    "releases a definitive initial%s failure without claiming acknowledgement",
    (status) => {
      const { protocol, command } = setup();
      expect(protocol.reject(command, new ApiError(status, "rejected"))).toBe("cleared");
      expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
      expect(protocol.isCurrent(command)).toBe(false);
    },
  );
  it.each([400, 404, 408, 409, 412, 422, 429, 500, 503])(
    "retains original uncertainty after a retry%s instead of proving the first command failed",
    (status) => {
      const { protocol, command } = setup();
      protocol.reject(command, new TypeError("response lost"));
      const same = protocol.retry();
      expect(protocol.reject(same, new ApiError(status, "retry rejected"))).toBe("unknown");
      expect(protocol.retry()).toBe(command);
      expect(command.key).toBe(key);
      expect(command.version).toBe(7);
    },
  );
  it.each([401, 403])(
    "clears private pending data after current access%s even during reconciliation",
    (status) => {
      const { protocol, command, receipt } = setup();
      protocol.reject(command, new TypeError("unknown"));
      protocol.retry();
      expect(protocol.reject(command, new ApiError(status, "access revoked"))).toBe("cleared");
      expect(protocol.getSnapshot().command).toBeNull();
      expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
    },
  );
  it("acknowledges only the matching closed done receipt and leaves newer source rows untouched", () => {
    const { protocol, command, receipt } = setup();
    const newer = { ...receipt, title: "Newer authoritative title", state: "open" as const, version: 9 };
    const before = JSON.stringify(newer);
    expect(protocol.acknowledge(command, receipt, '"8"')).toBe(true);
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
    expect(JSON.stringify(newer)).toBe(before);
    expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
  });
  it.each([null, "8", 'W/"8"', '"7"', '"9"', '"08"', '"8", "9"'])(
    "does not acknowledge a missing/nonmatching strong receipt ETag %#",
    (etag) => {
      const { protocol, command, receipt } = setup();
      expect(protocol.acknowledge(command, receipt, etag)).toBe(false);
      expect(protocol.getSnapshot()).toEqual({ command, phase: "unknown" });
    },
  );
  it.each([
    { id: leadId },
    { assigneeMemberId: leadId },
    { leadId: null },
    { title: "Different title" },
    { dueAt: "2026-11-01T08:30:00.000Z" },
    { timezone: "UTC" },
    { priority: "low" },
    { state: "open" },
    { version: 9 },
    { unexpected: "private" },
    { dueAt: "invalid" },
  ])("retains uncertainty for a mismatched or malformed receipt %#", (patch) => {
    const { protocol, command, receipt } = setup();
    expect(protocol.acknowledge(command, { ...receipt, ...patch }, '"8"')).toBe(false);
    expect(protocol.getSnapshot().phase).toBe("unknown");
    expect(protocol.getSnapshot().command).toBe(command);
  });
  it("preserves the semantic instant when the verified receipt uses a different UTC representation", () => {
    const { protocol, command, receipt } = setup();
    expect(protocol.acknowledge(command, { ...receipt, dueAt: "2026-11-01T01:30:00.000-08:00" }, '"8"')).toBe(
      true,
    );
  });
  it("retains uppercase original UUID input while accepting the database's canonical lowercase receipt", () => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("context");
    const original = {
      ...task(),
      id: taskId.toUpperCase(),
      assigneeMemberId: memberId.toUpperCase(),
      leadId: leadId.toUpperCase(),
    };
    const command = protocol.begin(original, key);
    expect(command.taskId).toBe(original.id);
    expect(command.body.assigneeMemberId).toBe(original.assigneeMemberId);
    expect(command.body.leadId).toBe(original.leadId);
    expect(protocol.acknowledge(command, { ...task(), state: "done", version: 8 }, '"8"')).toBe(true);
  });
  it("retains exact original title but accepts the server's documented whitespace trimming", () => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("context");
    const original = { ...task(), title: "  Synthetic follow-up  " };
    const command = protocol.begin(original, key);
    expect(command.body.title).toBe(original.title);
    expect(
      protocol.acknowledge(
        command,
        { ...original, title: "Synthetic follow-up", state: "done", version: 8 },
        '"8"',
      ),
    ).toBe(true);
  });
  it("does not infer an unlink when original PATCH input omitted the optional lead field", () => {
    const protocol = new TaskCompletionProtocol();
    protocol.bind("context");
    const original = task();
    delete original.leadId;
    const command = protocol.begin(original, key);
    expect(Object.hasOwn(command.body, "leadId")).toBe(false);
    expect(protocol.acknowledge(command, { ...task(), state: "done", version: 8 }, '"8"')).toBe(true);
  });
  it("does not use structurally copied commands as authority", () => {
    const { protocol, command, receipt } = setup();
    const copied = { ...command };
    expect(protocol.isCurrent(copied)).toBe(false);
    expect(protocol.acknowledge(copied, receipt, '"8"')).toBe(false);
    expect(protocol.reject(copied, new ApiError(403, "denied"))).toBe("ignored");
    expect(protocol.getSnapshot().command).toBe(command);
  });
  it("retains the original command when rebinding the same exact context", () => {
    const { protocol, command } = setup();
    protocol.reject(command, new TypeError("lost"));
    protocol.bind(command.context);
    expect(protocol.retry()).toBe(command);
  });
  it.each([null, "different-org", "changed-permissions", "rotated-csrf"])(
    "invalidates late responses after context loss/change %#",
    (context) => {
      const { protocol, command, receipt } = setup();
      protocol.bind(context);
      expect(protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
      expect(protocol.reject(command, new Error("late response"))).toBe("ignored");
      expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
    },
  );
  it("does not execute accessor source/receipt fields while retaining a command", () => {
    const { protocol, command, receipt } = setup();
    const hook = vi.fn(() => "PRIVATE_SOURCE");
    Object.defineProperty(receipt, "title", { enumerable: true, get: hook });
    expect(protocol.acknowledge(command, receipt, '"8"')).toBe(false);
    const another = new TaskCompletionProtocol();
    another.bind("context");
    const hostile = task();
    Object.defineProperty(hostile, "dueAt", { enumerable: true, get: hook });
    expect(() => another.begin(hostile, key)).toThrow();
    expect(hook).not.toHaveBeenCalled();
  });
});
