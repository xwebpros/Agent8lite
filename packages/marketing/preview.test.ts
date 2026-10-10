import { describe, expect, it } from "vitest";
import { previewWorkflow, type WorkflowDefinition, WorkflowValidationError } from "./index";

const startInstant = "2026-10-10T00:00:00Z";
const definition = (): WorkflowDefinition => ({
  nodes: [
    { key: "start", kind: "wait", delaySeconds: 0 },
    { key: "choose", kind: "condition", condition: { intent: "buyer" } },
    { key: "yes", kind: "wait", delaySeconds: 90 },
    { key: "no", kind: "wait", delaySeconds: 180 },
    { key: "finish", kind: "task", taskTitle: "Synthetic follow-up" },
  ],
  edges: [
    { from: "start", to: "choose", branch: "always" },
    { from: "choose", to: "yes", branch: "true" },
    { from: "choose", to: "no", branch: "false" },
    { from: "yes", to: "finish", branch: "always" },
    { from: "no", to: "finish", branch: "always" },
  ],
  timezone: "America/Los_Angeles",
  quietHours: { start: "21:00", end: "08:00" },
});

describe("explicit virtual elapsed-clock preview", () => {
  it.each([true, false])(
    "follows the selected branch %s with deterministic elapsed completion instants",
    (choice) => {
      const value = definition();
      const options = { startInstant, conditionChoices: { choose: choice } };
      const steps = previewWorkflow(value, options);
      expect(steps.map((step) => step.nodeKey)).toEqual(["start", "choose", choice ? "yes" : "no", "finish"]);
      expect(steps.map((step) => step.at)).toEqual([
        "2026-10-10T00:00:00.000Z",
        "2026-10-10T00:00:00.000Z",
        choice ? "2026-10-10T00:01:30.000Z" : "2026-10-10T00:03:00.000Z",
        choice ? "2026-10-10T00:01:30.000Z" : "2026-10-10T00:03:00.000Z",
      ]);
      expect(previewWorkflow(value, options)).toEqual(steps);
    },
  );
  it("ignores input array order and protects immutable output without mutating input", () => {
    const value = definition();
    const expected = previewWorkflow(value, { startInstant, conditionChoices: { choose: true } });
    value.nodes.reverse();
    value.edges.reverse();
    const before = JSON.stringify(value);
    const steps = previewWorkflow(value, { startInstant, conditionChoices: { choose: true } });
    expect(steps).toEqual(expected);
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.isFrozen(steps)).toBe(true);
    expect(steps.every((step) => Object.isFrozen(step) && Object.isFrozen(step.prerequisites))).toBe(true);
  });
  it.each([{}, { choose: "true" }, { choose: null }, { choose: true, unrelated: false }, []])(
    "requires explicit non-coerced choices for condition nodes %#",
    (conditionChoices) => {
      expect(() => previewWorkflow(definition(), { startInstant, conditionChoices } as never)).toThrowError(
        WorkflowValidationError,
      );
    },
  );
  it("requires choices for reached conditions without inventing decisions on unchosen branches", () => {
    const value = definition();
    value.nodes[2] = { key: "yes", kind: "condition", condition: { intent: "seller" } };
    value.nodes.push({ key: "other", kind: "task", taskTitle: "Other" });
    value.edges[3] = { from: "yes", to: "finish", branch: "true" };
    value.edges.push({ from: "yes", to: "other", branch: "false" });
    expect(() => previewWorkflow(value, { startInstant, conditionChoices: { choose: true } })).toThrowError(
      WorkflowValidationError,
    );
    expect(
      previewWorkflow(value, { startInstant, conditionChoices: { choose: false } }).map(
        (step) => step.nodeKey,
      ),
    ).toEqual(["start", "choose", "no", "finish"]);
    expect(
      previewWorkflow(value, { startInstant, conditionChoices: { choose: false, yes: true } }).map(
        (step) => step.nodeKey,
      ),
    ).toEqual(["start", "choose", "no", "finish"]);
  });
  it.each([
    "",
    "2026-10-10",
    "2026-02-30T00:00:00Z",
    "2026-10-10T24:00:00Z",
    "2026-10-10T00:00:00+00:00",
    "2026-10-10T00:00:00.1234Z",
  ])("rejects missing, ambiguous or invalid start instant %s", (instant) =>
    expect(() =>
      previewWorkflow(definition(), { startInstant: instant, conditionChoices: { choose: true } }),
    ).toThrowError(WorkflowValidationError),
  );
  it("uses bounded safe option errors instead of reflecting arbitrary values", () => {
    try {
      previewWorkflow(definition(), {
        startInstant: "DO_NOT_REFLECT",
        conditionChoices: { choose: true },
        extra: "DO_NOT_REFLECT",
      } as never);
      throw new Error("expected invalid options");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      const validation = error as WorkflowValidationError;
      expect(validation.code).toBe("preview_options_invalid");
      expect(validation.issues.map((issue) => issue.field)).toEqual(["options", "startInstant"]);
      expect(JSON.stringify(validation.issues)).not.toContain("DO_NOT_REFLECT");
      expect(Object.isFrozen(validation.issues)).toBe(true);
    }
  });
  it("refuses an invalid graph rather than attempting a partial preview", () => {
    const value = definition();
    value.edges.push({ from: "finish", to: "start", branch: "always" });
    expect(() => previewWorkflow(value, { startInstant, conditionChoices: { choose: true } })).toThrowError(
      WorkflowValidationError,
    );
  });
  it.each([
    ["2026-03-08T09:30:00Z", "2026-03-08T10:30:00.000Z"],
    ["2026-11-01T08:30:00Z", "2026-11-01T09:30:00.000Z"],
    ["2028-02-28T23:30:00Z", "2028-02-29T00:30:00.000Z"],
  ])("keeps elapsed time across DST and leap-day boundaries beginning %s", (startInstant, at) => {
    const value: WorkflowDefinition = {
      nodes: [{ key: "wait", kind: "wait", delaySeconds: 3600 }],
      edges: [],
      timezone: "America/Los_Angeles",
      quietHours: { start: "00:00", end: "23:59" },
    };
    expect(previewWorkflow(value, { startInstant, conditionChoices: {} })[0].at).toBe(at);
  });
  it("reports channel/design/current-consent checks without inferring sender, send or task readiness", () => {
    const value: WorkflowDefinition = {
      nodes: [
        { key: "email", kind: "email", messageDesignId: "a0000000-0000-4000-8000-000000000001" },
        { key: "sms", kind: "sms", messageDesignId: "a0000000-0000-4000-8000-000000000002" },
        { key: "task", kind: "task", taskTitle: "Safe" },
      ],
      edges: [
        { from: "email", to: "sms", branch: "always" },
        { from: "sms", to: "task", branch: "always" },
      ],
      timezone: "UTC",
    };
    const steps = previewWorkflow(value, { startInstant, conditionChoices: {} });
    expect(steps[0].prerequisites).toEqual(
      expect.arrayContaining([
        "email_channel",
        "current_email_design",
        "current_consent",
        "provider_ready",
        "quiet_hours_check",
        "campaigns_send",
      ]),
    );
    expect(steps[1].prerequisites).toEqual(
      expect.arrayContaining(["sms_entitlement", "sms_channel", "current_sms_design", "suppression_clear"]),
    );
    expect(steps[2].prerequisites).toContain("crm_tasks_write");
    expect(JSON.stringify(steps)).not.toMatch(/messageDesignId|taskTitle|delivered|eligible|succeeded/);
  });
});
