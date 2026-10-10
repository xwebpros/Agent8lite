import { createHmac, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBillingProvider, SYNTHETIC_BILLING_TERMS } from "../../packages/providers/billing/mock";
import type { BillingCommand, BillingPlan, BillingWebhookEvent } from "../../packages/providers/billing/port";

const instant = new Date("2026-10-10T00:00:00.000Z");
const secret = "synthetic-test-signature-key-32-bytes-minimum";
const currentPlan: BillingPlan = {
  code: "starter",
  currency: "USD",
  recurringTotalMinor: 2900,
  interval: "month",
};
const targetPlan: BillingPlan = {
  code: "professional",
  currency: "USD",
  recurringTotalMinor: 19900,
  interval: "year",
};
const provider = (outcome: "accepted" | "unknown" | "failed" = "accepted") =>
  new MockBillingProvider({ mode: "test", webhookSecret: secret, outcome, clock: () => instant });
const command = (): BillingCommand => ({
  tenantId: randomUUID(),
  commandId: randomUUID(),
  action: "change_plan",
  currentPlan,
  targetPlan,
});
const event = (): BillingWebhookEvent => ({
  id: randomUUID(),
  type: "billing.changed",
  tenantId: randomUUID(),
  commandId: randomUUID(),
  providerReference: `synthetic_${"a".repeat(32)}`,
});
const signed = (rawBody: string, timestamp = Math.floor(instant.getTime() / 1000)) => ({
  rawBody,
  signature: `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`,
});

afterEach(() => vi.unstubAllGlobals());

describe("M2 — no-charge synthetic billing provider and reconciliation", () => {
  it("cannot run in production and rejects weak webhook keys", () => {
    expect(() => new MockBillingProvider({ mode: "production" as "test" })).toThrow("MOCK_BILLING_DISABLED");
    expect(() => new MockBillingProvider({ mode: "test", webhookSecret: "weak" })).toThrow(
      "WEAK_WEBHOOK_SECRET",
    );
  });

  it.each(["change_plan", "cancel", "resume"] as const)(
    "provides explicit synthetic terms and zero due-now amount for %s",
    async (action) => {
      const fetchSpy = vi.fn(() => {
        throw new Error("External billing is prohibited in synthetic tests");
      });
      vi.stubGlobal("fetch", fetchSpy);
      const preview = await provider().preview({
        action,
        currentPlan,
        ...(action === "change_plan" ? { targetPlan } : {}),
        now: instant,
      });
      expect(preview).toMatchObject({
        currency: "USD",
        dueNowMinor: 0,
        effectiveAt: instant.toISOString(),
        termsVersion: SYNTHETIC_BILLING_TERMS,
      });
      expect(preview.recurringTotalMinor).toBe(
        action === "cancel"
          ? 0
          : action === "change_plan"
            ? targetPlan.recurringTotalMinor
            : currentPlan.recurringTotalMinor,
      );
      expect(preview.interval).toBe(action === "change_plan" ? "year" : "month");
      expect(preview.terms.join(" ")).toContain("no money will be charged");
      expect(preview.terms.join(" ")).toContain("tax and proration are zero");
      expect(preview.terms.join(" ")).toContain("does not enable application capabilities");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported actions, incomplete targets, invalid prices and invalid time", async () => {
    const simulator = provider();
    for (const input of [
      { action: "invented", currentPlan, now: instant },
      { action: "change_plan", currentPlan, now: instant },
      { action: "cancel", currentPlan, targetPlan, now: instant },
      { action: "resume", currentPlan, now: new Date("invalid") },
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN].map((recurringTotalMinor) => ({
        action: "resume",
        currentPlan: { ...currentPlan, recurringTotalMinor },
        now: instant,
      })),
      { action: "resume", currentPlan: { ...currentPlan, currency: "EUR" }, now: instant },
      { action: "resume", currentPlan: { ...currentPlan, interval: "week" }, now: instant },
    ])
      await expect(simulator.preview(input as Parameters<typeof simulator.preview>[0])).rejects.toThrow();
  });

  it("reconciles identical retries once, isolates command keys by tenant and returns detached state", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("No external payment request allowed");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const simulator = provider();
    const input = command();
    const first = await simulator.confirm(input);
    const replay = await simulator.confirm(structuredClone(input));
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ state: "accepted", externalCharge: false });
    expect(first.providerReference).toMatch(/^synthetic_[0-9a-f]{32}$/);
    (first as { providerReference: string | null }).providerReference = "mutated-by-caller";
    expect(await simulator.confirm(input)).toEqual(replay);
    const otherTenant = { ...input, tenantId: randomUUID() };
    expect((await simulator.confirm(otherTenant)).providerReference).not.toBe(replay.providerReference);
    const state = await simulator.readCurrentState(input.tenantId, input.commandId);
    expect(state).toMatchObject({
      tenantId: input.tenantId,
      commandId: input.commandId,
      status: "active",
      plan: targetPlan,
      externalCharge: false,
      observedAt: instant.toISOString(),
    });
    (state!.plan as { code: string }).code = "caller-change";
    expect((await simulator.readCurrentState(input.tenantId, input.commandId))!.plan.code).toBe(
      targetPlan.code,
    );
    expect(await simulator.readCurrentState(randomUUID(), input.commandId)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects reuse of a financial command identity for a changed target, price, action or current plan", async () => {
    const simulator = provider();
    const input = command();
    const accepted = await simulator.confirm(input);
    const conflicts: BillingCommand[] = [
      { ...input, targetPlan: { ...targetPlan, code: "another" } },
      { ...input, targetPlan: { ...targetPlan, recurringTotalMinor: targetPlan.recurringTotalMinor + 1 } },
      { ...input, currentPlan: { ...currentPlan, recurringTotalMinor: currentPlan.recurringTotalMinor + 1 } },
      { ...input, action: "cancel", targetPlan: undefined },
    ];
    for (const conflict of conflicts)
      await expect(simulator.confirm(conflict)).rejects.toThrow("BILLING_IDEMPOTENCY_CONFLICT");
    expect(await simulator.confirm(input)).toEqual(accepted);
    await expect(simulator.confirm({ ...input, tenantId: "not-a-tenant" })).rejects.toThrow(
      "INVALID_BILLING_REFERENCE",
    );
  });

  it("keeps unknown acceptance unknown while an authoritative read recovers the accepted state", async () => {
    const simulator = provider("unknown");
    const input = command();
    expect(await simulator.readCurrentState(input.tenantId, input.commandId)).toBeNull();
    const response = await simulator.confirm(input);
    expect(response).toEqual({ state: "unknown", providerReference: null, externalCharge: false });
    const recovered = await simulator.readCurrentState(input.tenantId, input.commandId);
    expect(recovered).toMatchObject({ status: "active", plan: targetPlan, externalCharge: false });
    expect(recovered!.providerReference).toMatch(/^synthetic_/);
    expect(await simulator.confirm(input)).toEqual(response);
  });

  it("reports authoritative failure and synthetic cancellation without enabling capabilities", async () => {
    const failed = provider("failed");
    const input = command();
    expect((await failed.confirm(input)).state).toBe("failed");
    expect(await failed.readCurrentState(input.tenantId, input.commandId)).toMatchObject({
      status: "failed",
      externalCharge: false,
    });
    const canceled = provider();
    const cancellation: BillingCommand = { ...command(), action: "cancel", targetPlan: undefined };
    await canceled.confirm(cancellation);
    const state = await canceled.readCurrentState(cancellation.tenantId, cancellation.commandId);
    expect(state).toMatchObject({ status: "canceled", externalCharge: false, plan: currentPlan });
    expect(state).not.toHaveProperty("entitlements");
  });

  it("authenticates the exact webhook bytes and permits bounded skew in either direction", () => {
    const simulator = provider();
    const input = event();
    const webhook = simulator.syntheticWebhook(input);
    expect(simulator.verifyWebhook(webhook.rawBody, webhook.signature)).toEqual(input);
    for (const skew of [-300_000, 300_000])
      expect(
        simulator.verifyWebhook(webhook.rawBody, webhook.signature, new Date(instant.getTime() + skew)),
      ).toEqual(input);
    expect(() => simulator.verifyWebhook(`${webhook.rawBody} `, webhook.signature)).toThrow(
      "INVALID_BILLING_WEBHOOK_SIGNATURE",
    );
    const wrongSecret = new MockBillingProvider({
      mode: "test",
      webhookSecret: "different-test-signature-key-32-bytes",
      clock: () => instant,
    });
    expect(() => wrongSecret.verifyWebhook(webhook.rawBody, webhook.signature)).toThrow(
      "INVALID_BILLING_WEBHOOK_SIGNATURE",
    );
  });

  it("rejects stale/future signatures, malformed signatures and invalid clocks", () => {
    const simulator = provider();
    const webhook = simulator.syntheticWebhook(event());
    for (const skew of [-301_000, 301_000])
      expect(() =>
        simulator.verifyWebhook(webhook.rawBody, webhook.signature, new Date(instant.getTime() + skew)),
      ).toThrow("INVALID_BILLING_WEBHOOK_SIGNATURE");
    for (const signature of [
      "",
      "v1=unknown",
      `${webhook.signature},v1=${"0".repeat(64)}`,
      webhook.signature.replace(/v1=.*/, "v1=00"),
      webhook.signature.replace("v1=", "v2="),
    ])
      expect(() => simulator.verifyWebhook(webhook.rawBody, signature)).toThrow(
        "INVALID_BILLING_WEBHOOK_SIGNATURE",
      );
    expect(() => simulator.verifyWebhook(webhook.rawBody, webhook.signature, new Date("invalid"))).toThrow(
      "INVALID_BILLING_WEBHOOK",
    );
  });

  it("rejects validly signed malformed, oversized, non-synthetic and privilege-bearing payloads", () => {
    const simulator = provider();
    const valid = event();
    const invalidPayloads = [
      null,
      [],
      { ...valid, type: "billing.paid" },
      { ...valid, id: "invalid" },
      { ...valid, tenantId: "invalid" },
      { ...valid, commandId: "invalid" },
      { ...valid, providerReference: "live_charge" },
      { ...valid, entitlements: { crm: true } },
      { ...valid, rawCustomerEmail: "private@example.invalid" },
      { ...valid, id: undefined },
    ];
    for (const input of invalidPayloads) {
      const webhook = signed(JSON.stringify(input));
      expect(() => simulator.verifyWebhook(webhook.rawBody, webhook.signature)).toThrow(
        "INVALID_BILLING_WEBHOOK",
      );
    }
    const malformed = signed("not-json");
    expect(() => simulator.verifyWebhook(malformed.rawBody, malformed.signature)).toThrow();
    const oversized = signed(JSON.stringify({ ...valid, extra: "x".repeat(16_384) }));
    expect(() => simulator.verifyWebhook(oversized.rawBody, oversized.signature)).toThrow(
      "INVALID_BILLING_WEBHOOK",
    );
  });
});
