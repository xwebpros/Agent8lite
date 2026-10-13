import { describe, expect, it } from "vitest";
import { StageTransitionProtocol } from "../../apps/web/components/stage-transition";
import { ApiError, type Schema } from "../../apps/web/lib/api";

const id = "ef000000-0000-4000-8000-000000000001",
  contactId = "ef000000-0000-4000-8000-000000000002",
  sourceId = "ef000000-0000-4000-8000-000000000003",
  oldStage = "ef000000-0000-4000-8000-000000000004",
  target = "ef000000-0000-4000-8000-000000000005",
  member = "ef000000-0000-4000-8000-000000000006",
  key = "ef000000-0000-4000-8000-000000000007";
const context = "PRIVATE_VERIFIED_USER_ORG_MEMBER_CSRF_ACCESS_FULL_GRANTS";
const horizon = 23 * 60 * 60 * 1000;
function lead(): Schema<"Lead"> {
  return {
    id,
    contactId,
    sourceId,
    stageId: oldStage,
    ownerMemberId: member,
    intent: "buyer",
    timeline: "PRIVATE_TIMELINE",
    score: null,
    scoreVersion: null,
    version: 7,
  };
}
function body(): Schema<"StageTransition"> {
  return { toStageId: target, reason: " PRIVATE_REASON " };
}
function setup() {
  let wall = 1000000,
    mono = 1000;
  const protocol = new StageTransitionProtocol({ wallNow: () => wall, monotonicNow: () => mono });
  protocol.bind(context);
  const original = lead(),
    input = body(),
    command = protocol.begin({ lead: original, body: input }, key);
  return {
    protocol,
    original,
    input,
    command,
    clock: (w: number, m: number) => {
      wall = w;
      mono = m;
    },
  };
}
const receipt = (): Schema<"Lead"> => ({ ...lead(), version: 8, stageId: target });

describe("ADR-043 exact immutable stage command and historical acknowledgement", () => {
  it("captures identities, revision, exact reason/key/header and serialized bytes before caller mutation", () => {
    const value = setup(),
      json = JSON.stringify(value.input);
    value.original.id = member;
    value.original.contactId = member;
    value.original.version = 100;
    value.input.toStageId = oldStage;
    value.input.reason = "Changed later";
    expect(value.command).toMatchObject({
      context,
      leadId: id,
      contactId,
      sourceId,
      originalStageId: oldStage,
      version: 7,
      key,
      ifMatch: '"7"',
      body: body(),
      serializedBody: json,
    });
    expect(Object.isFrozen(value.command)).toBe(true);
    expect(Object.isFrozen(value.command.body)).toBe(true);
  });
  it("ambiguous failure retries the original object without a new key/version/body", () => {
    const value = setup();
    expect(value.protocol.reject(value.command, new TypeError("connection interrupted"))).toBe("unknown");
    expect(value.protocol.retry()).toBe(value.command);
    expect(value.protocol.getSnapshot()).toMatchObject({ phase: "sending", command: value.command });
  });
  it("matching historical receipt acknowledges the command without pretending to refresh current detail", () => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), '"8"')).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(value.protocol.isCurrent(value.command)).toBe(false);
  });
  it("accepts the command's derived score change without relaxing its exact lead, stage or revision facts", () => {
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    const original = { ...lead(), score: 15, scoreVersion: "v1" };
    const command = protocol.begin({ lead: original, body: body() }, key);
    expect(protocol.acknowledge(command, { ...receipt(), score: 31, scoreVersion: "v1" }, '"8"')).toBe(true);
    expect(protocol.getSnapshot()).toEqual({ command: null, phase: "acknowledged" });
    expect(command.originalLead).toMatchObject({
      score: 15,
      scoreVersion: "v1",
      stageId: oldStage,
      version: 7,
    });
  });
  it.each([0, 16, 100])("accepts a coherent generated score %i on a formerly unscored lead", (score) => {
    const value = setup();
    expect(
      value.protocol.acknowledge(value.command, { ...receipt(), score, scoreVersion: "v1" }, '"8"'),
    ).toBe(true);
  });
  it.each([
    { score: -1, scoreVersion: "v1" },
    { score: 101, scoreVersion: "v1" },
    { score: "31", scoreVersion: "v1" },
    { score: Number.NaN, scoreVersion: "v1" },
    { score: 31, scoreVersion: null },
    { score: 31, scoreVersion: "" },
    { score: 31, scoreVersion: "   " },
    { score: 31, scoreVersion: "v".repeat(81) },
    { score: 31, scoreVersion: 1 },
    { score: null, scoreVersion: "v1" },
  ])("retains an uncertain command for malformed or unpaired scoring %j", (patch) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, { ...receipt(), ...patch }, '"8"')).toBe(false);
    expect(value.protocol.getSnapshot()).toMatchObject({ command: value.command, phase: "unknown" });
  });
  it.each([{ contactId: member }, { stageId: oldStage }, { version: 9 }, { intent: "seller" }])(
    "a valid scored pair cannot override mismatched command facts %j",
    (patch) => {
      const value = setup();
      expect(
        value.protocol.acknowledge(
          value.command,
          { ...receipt(), ...patch, score: 31, scoreVersion: "v1" },
          '"8"',
        ),
      ).toBe(false);
      expect(value.protocol.getSnapshot().phase).toBe("unknown");
    },
  );
  it("canonical lowercase receipt accepts original uppercase UUID spelling without altering original bytes", () => {
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    const source = lead();
    source.id = source.id.toUpperCase();
    source.contactId = source.contactId.toUpperCase();
    source.sourceId = source.sourceId.toUpperCase();
    const input = body();
    input.toStageId = input.toStageId.toUpperCase();
    const command = protocol.begin({ lead: source, body: input }, key);
    expect(protocol.acknowledge(command, receipt(), '"8"')).toBe(true);
    expect(command.serializedBody).toBe(JSON.stringify(input));
  });
  it.each([
    { id: member },
    { contactId: member },
    { sourceId: member },
    { stageId: oldStage },
    { version: 7 },
    { version: 9 },
    { tenantId: member },
    { ownerMemberId: id },
    { ownerMemberId: null },
    { intent: "seller" },
    { timeline: "DIFFERENT_TIMELINE" },
    { score: 10 },
    { scoreVersion: "different-version" },
  ])("nonmatching or nonclosed receipt %j remains unknown", (patch) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, { ...receipt(), ...patch }, '"8"')).toBe(false);
    expect(value.protocol.getSnapshot()).toMatchObject({ command: value.command, phase: "unknown" });
  });
  it.each([null, 'W/"8"', "8", '"7"', '"08"'])("nonmatching strong ETag %s cannot acknowledge", (etag) => {
    const value = setup();
    expect(value.protocol.acknowledge(value.command, receipt(), etag)).toBe(false);
    expect(value.protocol.getSnapshot().phase).toBe("unknown");
  });
  it("omitted/null optional fields and UUID case normalize without relaxing unchanged Lead facts", () => {
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    const original = lead();
    original.ownerMemberId = original.ownerMemberId!.toUpperCase();
    delete original.timeline;
    delete original.score;
    delete original.scoreVersion;
    const command = protocol.begin({ lead: original, body: body() }, key);
    expect(
      protocol.acknowledge(command, { ...receipt(), timeline: null, score: null, scoreVersion: null }, '"8"'),
    ).toBe(true);
    expect(command.body.reason).toBe(" PRIVATE_REASON ");
  });
  it("exact supplied canonical strong header survives retained reconciliation", () => {
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    const command = protocol.begin({ lead: lead(), body: body(), ifMatch: '"7"' }, key);
    protocol.reject(command, new TypeError("interruption"));
    expect(protocol.retry().ifMatch).toBe('"7"');
  });
  it("accessor-provided original Lead or stage body is rejected without invoking it", () => {
    let calls = 0;
    const original = lead();
    Object.defineProperty(original, "timeline", {
      enumerable: true,
      get: () => {
        calls++;
        return "PRIVATE";
      },
    });
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    expect(() => protocol.begin({ lead: original, body: body() }, key)).toThrow();
    const input = body();
    Object.defineProperty(input, "reason", {
      enumerable: true,
      get: () => {
        calls++;
        return "PRIVATE";
      },
    });
    expect(() => protocol.begin({ lead: lead(), body: input }, key)).toThrow();
    expect(calls).toBe(0);
  });
  it.each(["object-getter", "object-function", "array-getter", "array-function"] as const)(
    "inherited %s JSON hooks never alter original command or receipt",
    (kind) => {
      const prototype = kind.startsWith("object") ? Object.prototype : Array.prototype,
        previous = Object.getOwnPropertyDescriptor(prototype, "toJSON");
      let calls = 0,
        command: unknown,
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
                  return () => "PRIVATE_HOOK";
                },
              }
            : {
                configurable: true,
                value: () => {
                  calls++;
                  return "PRIVATE_HOOK";
                },
              },
        );
        const protocol = new StageTransitionProtocol();
        protocol.bind(context);
        const captured = protocol.begin({ lead: lead(), body: body() }, key);
        command = captured;
        accepted = protocol.acknowledge(captured, receipt(), '"8"');
      } finally {
        if (previous) Object.defineProperty(prototype, "toJSON", previous);
        else Reflect.deleteProperty(prototype, "toJSON");
      }
      expect(calls).toBe(0);
      expect(accepted).toBe(true);
      expect(command).toMatchObject({
        body: body(),
        serializedBody: '{"toStageId":"' + target + '","reason":" PRIVATE_REASON "}',
      });
    },
  );
  it.each([400, 404, 409, 412, 422, 429])(
    "first definitive %s rejection releases the never-confirmed command",
    (status) => {
      const value = setup();
      expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("cleared");
      expect(value.protocol.getSnapshot().command).toBeNull();
      expect(value.protocol.begin({ lead: lead(), body: body() }, key)).toBeDefined();
    },
  );
  it.each([408, 500, 502, 503])("initial %s remains an unknown outcome", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("unknown");
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it.each([404, 409, 412, 422, 429])(
    "a retry %s cannot prove the original unknown command failed",
    (status) => {
      const value = setup();
      value.protocol.reject(value.command, new Error("interruption"));
      value.protocol.retry();
      expect(value.protocol.reject(value.command, new ApiError(status, "safe"))).toBe("unknown");
      expect(value.protocol.getSnapshot().command).toBe(value.command);
    },
  );
  it.each([401, 403])("current %s access loss removes all private command authority", (status) => {
    const value = setup();
    expect(value.protocol.reject(value.command, new ApiError(status, "PRIVATE_FAILURE"))).toBe("cleared");
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "denied" });
    expect(value.protocol.isBoundTo(context)).toBe(false);
  });
});

describe("stage retry clocks, local forgetting and context lifetime", () => {
  it.each(["wall", "monotonic"] as const)("%s retry boundary is strictly below23 hours", (clock) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interruption"));
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
    [1000000, Number.POSITIVE_INFINITY],
    [999999, 1000],
    [1000000, 999],
  ])("invalid/backward clocks %s/%s permanently stop retry", (wall, mono) => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interruption"));
    value.clock(wall, mono);
    expect(value.protocol.canRetry()).toBe(false);
    value.clock(1000001, 1001);
    expect(value.protocol.canRetry()).toBe(false);
    expect(value.protocol.getSnapshot().command).toBe(value.command);
  });
  it("explicit local forgetting removes values and rejects replacement in the same verified binding", () => {
    const value = setup();
    value.protocol.reject(value.command, new Error("interruption"));
    value.clock(Number.NaN, 1000);
    expect(value.protocol.forget()).toBe(true);
    expect(value.protocol.getSnapshot()).toEqual({ command: null, phase: "forgotten" });
    value.protocol.bind(context);
    expect(() => value.protocol.begin({ lead: lead(), body: body() }, key)).toThrow();
    expect(value.protocol.acknowledge(value.command, receipt(), '"8"')).toBe(false);
    expect(value.protocol.reject(value.command, new ApiError(403, "late"))).toBe("ignored");
    value.protocol.bind("new verified context");
    expect(value.protocol.getSnapshot().phase).toBe("idle");
    value.clock(2000000, 2000);
    expect(value.protocol.begin({ lead: lead(), body: body() }, key)).toBeDefined();
  });
  it("send and retryable unknown states cannot be locally forgotten", () => {
    const value = setup();
    expect(value.protocol.canForget()).toBe(false);
    expect(value.protocol.forget()).toBe(false);
    value.protocol.reject(value.command, new Error("interruption"));
    expect(value.protocol.forget()).toBe(false);
  });
  it("changed or cleared context ignores all old responses and commands", () => {
    const value = setup();
    value.protocol.bind("new context");
    expect(value.protocol.isCurrent(value.command)).toBe(false);
    expect(value.protocol.acknowledge(value.command, receipt(), '"8"')).toBe(false);
    expect(value.protocol.reject(value.command, new ApiError(403, "late"))).toBe("ignored");
    value.protocol.bind(null);
    expect(value.protocol.isBoundTo(null)).toBe(false);
    expect(() => value.protocol.begin({ lead: lead(), body: body() }, key)).toThrow();
  });
  it.each([{ version: 0 }, { version: Number.MAX_SAFE_INTEGER }, { id: "invalid" }, { stageId: "invalid" }])(
    "invalid original Lead %j cannot start",
    (patch) => {
      const protocol = new StageTransitionProtocol();
      protocol.bind(context);
      expect(() => protocol.begin({ lead: { ...lead(), ...patch }, body: body() }, key)).toThrow();
    },
  );
  it.each([
    { toStageId: oldStage },
    { toStageId: "invalid" },
    { ...body(), reason: "x".repeat(1001) },
    { ...body(), ownerMemberId: member },
  ])("invalid stage request %j cannot start", (input) => {
    const protocol = new StageTransitionProtocol();
    protocol.bind(context);
    expect(() => protocol.begin({ lead: lead(), body: input }, key)).toThrow();
  });
});
