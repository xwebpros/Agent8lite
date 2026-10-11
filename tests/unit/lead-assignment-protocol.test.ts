import { describe, expect, it } from "vitest";
import { LeadAssignmentProtocol } from "../../apps/web/components/lead-assignment";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "ea000000-0000-4000-8000-000000000001",
  contactId = "ea000000-0000-4000-8000-000000000002",
  sourceId = "ea000000-0000-4000-8000-000000000003",
  stageId = "ea000000-0000-4000-8000-000000000004",
  oldOwner = "ea000000-0000-4000-8000-000000000005",
  target = "ea000000-0000-4000-8000-000000000006",
  key = "ea000000-0000-4000-8000-000000000007";
const binding = "PRIVATE_FULL_USER_ORG_MEMBER_CSRF_GRANTS_CONTEXT",
  horizon = 23 * 60 * 60 * 1000;
const lead = (): Schema<"Lead"> => ({
  id,
  contactId,
  sourceId,
  stageId,
  ownerMemberId: oldOwner,
  intent: "buyer",
  timeline: "PRIVATE_TIMELINE",
  score: 10,
  scoreVersion: "synthetic-v1",
  version: 7,
});
const input = (): Schema<"LeadPatch"> => ({ ownerMemberId: target });
const receipt = (): Schema<"Lead"> => ({ ...lead(), ownerMemberId: target, version: 8 });
function setup(body: Schema<"LeadPatch"> = input()) {
  let wall = 1000000,
    mono = 1000;
  const protocol = new LeadAssignmentProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(binding);
  const original = lead(),
    command = protocol.begin({ lead: original, body }, key);
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
describe("ADR-045 immutable assignment and strict historical acknowledgement", () => {
  it("captures exact body, original identity/fields, key and revision before mutable caller changes", () => {
    const value = setup(),
      bytes = JSON.stringify(value.body);
    value.body.ownerMemberId = null;
    value.original.contactId = target;
    value.original.version = 12;
    value.original.timeline = "later";
    expect(value.command).toMatchObject({
      context: binding,
      leadId: id,
      version: 7,
      key,
      ifMatch: '"7"',
      body: input(),
      serializedBody: bytes,
      originalLead: lead(),
    });
    expect(Object.isFrozen(value.command)).toBe(true);
    expect(Object.isFrozen(value.command.body)).toBe(true);
    expect(Object.isFrozen(value.command.originalLead)).toBe(true);
  });
  it("unknown command retries the identical object and cannot accept replacement", () => {
    const value = setup();
    expect(value.protocol.reject(value.command, new TypeError("network interrupted"))).toBe("unknown");
    expect(() => value.protocol.begin({ lead: lead(), body: { ownerMemberId: null } }, key)).toThrow();
    expect(value.protocol.retry()).toBe(value.command);
    expect(value.protocol.getSnapshot()).toMatchObject({ phase: "sending", command: value.command });
  });
  it("valid historical assignment ACK clears command but does not manufacture a current Lead", () => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), '"8"')).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(value.protocol.isCurrent(value.command)).toBe(false);
  });
  it("canonical UUID receipt acknowledges original uppercase spelling without altering original bytes", () => {
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    const original = lead();
    for (const field of ["id", "contactId", "sourceId", "stageId", "ownerMemberId"] as const)
      original[field] = original[field]!.toUpperCase();
    const body = { ownerMemberId: target.toUpperCase() },
      command = protocol.begin({ lead: original, body }, key);
    expect(protocol.acknowledge(command, receipt(), '"8"')).toBe(true);
    expect(command.serializedBody).toBe(JSON.stringify(body));
  });
  it.each([
    { id: target },
    { contactId: target },
    { sourceId: target },
    { stageId: target },
    { ownerMemberId: oldOwner },
    { ownerMemberId: null },
    { intent: "seller" },
    { timeline: null },
    { timeline: "changed" },
    { score: 11 },
    { scoreVersion: "changed" },
    { version: 7 },
    { version: 9 },
    { tenantId: target },
  ])("mismatched receipt %j cannot acknowledge", (patch) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, { ...receipt(), ...patch }, '"8"')).toBe(false);
    expect(value.protocol.getSnapshot()).toMatchObject({ phase: "unknown", command: value.command });
  });
  it.each([null, 'W/"8"', "8", '"08"', '"7"'])("nonmatching strong ETag %s remains unknown", (etag) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), etag)).toBe(false);
    expect(value.protocol.getSnapshot().phase).toBe("unknown");
  });
  it("null unassignment and explicit metadata edits match only requested fields", () => {
    const value = setup({ ownerMemberId: null, intent: "unknown", timeline: null });
    expect(
      value.protocol.acknowledge(
        value.command,
        { ...receipt(), ownerMemberId: null, intent: "unknown", timeline: null },
        '"8"',
      ),
    ).toBe(true);
  });
  it("empty patch preserves all original Lead facts while incrementing only version", () => {
    const value = setup({});
    expect(value.protocol.acknowledge(value.command, { ...lead(), version: 8 }, '"8"')).toBe(true);
  });
  it("omitted nullable facts normalize to null but cannot introduce an unexpected owner", () => {
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    const original = lead();
    delete original.ownerMemberId;
    delete original.timeline;
    delete original.score;
    delete original.scoreVersion;
    const command = protocol.begin({ lead: original, body: { intent: "seller" } }, key);
    expect(
      protocol.acknowledge(
        command,
        {
          ...original,
          intent: "seller",
          ownerMemberId: null,
          timeline: null,
          score: null,
          scoreVersion: null,
          version: 8,
        },
        '"8"',
      ),
    ).toBe(true);
  });
  it.each(["lead", "body"] as const)("accessor %s fails without invoking it", (field) => {
    let calls = 0;
    const original = lead(),
      body = input();
    Object.defineProperty(
      field === "lead" ? original : body,
      field === "lead" ? "timeline" : "ownerMemberId",
      {
        enumerable: true,
        get: () => {
          calls++;
          return target;
        },
      },
    );
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    expect(() => protocol.begin({ lead: original, body }, key)).toThrow();
    expect(calls).toBe(0);
  });
  it("revoked Proxy traps are not executed during snapshot validation", () => {
    let hooks = 0;
    const wrapped = Proxy.revocable(input(), {
      ownKeys: () => {
        hooks++;
        return [];
      },
    });
    wrapped.revoke();
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    expect(() => protocol.begin({ lead: lead(), body: wrapped.proxy }, key)).toThrow();
    expect(hooks).toBe(0);
  });
  it.each(["object-getter", "object-function", "array-getter", "array-function"] as const)(
    "inherited %s serialization hooks are never called",
    (kind) => {
      const prototype = kind.startsWith("object") ? Object.prototype : Array.prototype,
        previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0,
        accepted = false,
        bytes = "";
      try {
        Object.defineProperty(
          prototype,
          "toJSON",
          kind.endsWith("getter")
            ? {
                configurable: true,
                get: () => {
                  calls++;
                  return () => "private";
                },
              }
            : {
                configurable: true,
                value: () => {
                  calls++;
                  return "private";
                },
              },
        );
        const value = setup();
        bytes = value.command.serializedBody;
        accepted = value.protocol.acknowledge(value.command, receipt(), '"8"');
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(calls).toBe(0);
      expect(accepted).toBe(true);
      expect(bytes).toBe('{"ownerMemberId":"' + target + '"}');
    },
  );
  it.each([
    { ownerMemberId: "invalid" },
    { intent: "private" },
    { timeline: "x".repeat(81) },
    { stageId: target },
    [],
  ])("invalid LeadPatch %j cannot start", (body) => {
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    expect(() => protocol.begin({ lead: lead(), body: body as never }, key)).toThrow();
  });
  it.each([
    { version: 0 },
    { version: Number.MAX_SAFE_INTEGER },
    { id: "invalid" },
    { contactId: "invalid" },
  ])("invalid original Lead %j cannot start", (patch) => {
    const protocol = new LeadAssignmentProtocol();
    protocol.bind(binding);
    expect(() => protocol.begin({ lead: { ...lead(), ...patch }, body: input() }, key)).toThrow();
  });
});
describe("initial rejection versus prior uncertainty and access loss", () => {
  it.each([400, 404, 409, 412, 422, 429])("initial definitive %s permits reviewed replacement", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("cleared");
    expect(value.protocol.getSnapshot().command).toBeNull();
    expect(value.protocol.begin({ lead: lead(), body: input() }, key)).toBeDefined();
  });
  it.each([408, 500, 502, 503])("initial %s is unknown", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([404, 409, 412, 422, 429])("retry %s cannot prove original assignment did not apply", (status) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interrupted"));
    value.protocol.retry();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([401, 403])("known %s authority loss clears private state without inferring success", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "PRIVATE_ERROR"))).toBe("cleared");
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
    expect(value.protocol.isBoundTo(binding)).toBe(false);
  });
  it("old-generation success and denial cannot alter replacement binding", () => {
    const value = setup();
    value.protocol.bind("replacement");
    expect(value.protocol.acknowledge(value.command, receipt(), '"8"')).toBe(false);
    expect(value.protocol.reject(value.command, new ApiError(403, "late"))).toBe("ignored");
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "idle" });
  });
});
describe("bounded retry clocks and explicit local forgetting", () => {
  it.each(["wall", "monotonic"] as const)("%s horizon is strictly less than23 hours", (clock) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("unknown"));
    value.clock(
      1000000 + (clock === "wall" ? horizon - 1 : 0),
      1000 + (clock === "monotonic" ? horizon - 1 : 0),
    );
    expect(value.protocol.canRetry()).toBe(true);
    expect(value.protocol.canForget()).toBe(false);
    value.clock(1000000 + (clock === "wall" ? horizon : 0), 1000 + (clock === "monotonic" ? horizon : 0));
    expect(value.protocol.canRetry()).toBe(false);
    expect(() => value.protocol.retry()).toThrow();
    expect(value.protocol.canForget()).toBe(true);
  });
  it.each([
    [Number.NaN, 1000],
    [1000000, Infinity],
    [999999, 1000],
    [1000000, 999],
  ])("invalid/backward clocks %s/%s permanently stop retry", (wall, mono) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("unknown"));
    value.clock(wall, mono);
    expect(value.protocol.canRetry()).toBe(false);
    value.clock(1000001, 1001);
    expect(value.protocol.canRetry()).toBe(false);
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("forgetting clears all private values and invalidates callbacks without acknowledging/cancelling", () => {
    const value = setup();
    value.protocol.reject(value.command, new Error("unknown"));
    value.clock(NaN, 1000);
    expect(value.protocol.forget()).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "forgotten" });
    expect(value.protocol.isCurrent(value.command)).toBe(false);
    value.protocol.bind(binding);
    expect(() => value.protocol.begin({ lead: lead(), body: input() }, key)).toThrow();
    value.protocol.bind("new verified binding");
    expect(value.protocol.getSnapshot().phase).toBe("idle");
  });
  it("sending and retryable unknown do not offer forgetting", () => {
    const value = setup();
    expect(value.protocol.forget()).toBe(false);
    value.protocol.reject(value.command, new Error("unknown"));
    expect(value.protocol.forget()).toBe(false);
  });
  it("cleared binding disables begin and retry", () => {
    const value = setup();
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(null)).toBe(false);
    expect(() => value.protocol.begin({ lead: lead(), body: input() }, key)).toThrow();
    expect(() => value.protocol.retry()).toThrow();
  });
});
