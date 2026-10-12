import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  AuthoritativeBillingState,
  BillingAcceptance,
  BillingCommand,
  BillingPlan,
  BillingPreviewInput,
  BillingProvider,
  BillingWebhookEvent,
  HostedPortalSession,
  ProviderBillingPreview,
} from "./port";

export const SYNTHETIC_BILLING_TERMS = "synthetic-billing-v1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validatePlan(plan: BillingPlan) {
  if (
    !plan ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(plan.code) ||
    plan.currency !== "USD" ||
    !Number.isSafeInteger(plan.recurringTotalMinor) ||
    plan.recurringTotalMinor < 0 ||
    !["month", "year"].includes(plan.interval)
  )
    throw new Error("INVALID_BILLING_PLAN");
}
function target(command: Pick<BillingCommand, "action" | "currentPlan" | "targetPlan">) {
  validatePlan(command.currentPlan);
  if (!["change_plan", "cancel", "resume"].includes(command.action))
    throw new Error("INVALID_BILLING_ACTION");
  if (command.action === "change_plan" && !command.targetPlan) throw new Error("TARGET_PLAN_REQUIRED");
  if (command.targetPlan) validatePlan(command.targetPlan);
  if (command.action !== "change_plan" && command.targetPlan) throw new Error("UNEXPECTED_TARGET_PLAN");
  return command.targetPlan ?? command.currentPlan;
}

/** Local simulator: no network, payment methods, customer data, or charges. */
export class MockBillingProvider implements BillingProvider {
  private readonly key: Buffer;
  private readonly commands = new Map<
    string,
    {
      hash: string;
      acceptance: BillingAcceptance;
      authoritative: AuthoritativeBillingState;
    }
  >();
  constructor(
    private readonly options: {
      mode: "development" | "test";
      webhookSecret?: string;
      outcome?: "accepted" | "unknown" | "failed";
      clock?: () => Date;
    },
  ) {
    if (!["development", "test"].includes(options.mode)) throw new Error("MOCK_BILLING_DISABLED");
    if (options.webhookSecret && Buffer.byteLength(options.webhookSecret) < 32)
      throw new Error("WEAK_WEBHOOK_SECRET");
    this.key = options.webhookSecret ? Buffer.from(options.webhookSecret) : randomBytes(32);
  }
  async preview(input: BillingPreviewInput): Promise<ProviderBillingPreview> {
    const plan = target(input);
    if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
      throw new Error("INVALID_BILLING_TIME");
    return {
      currency: "USD",
      dueNowMinor: 0,
      recurringTotalMinor: input.action === "cancel" ? 0 : plan.recurringTotalMinor,
      interval: plan.interval,
      effectiveAt: input.now.toISOString(),
      termsVersion: SYNTHETIC_BILLING_TERMS,
      terms: [
        "Synthetic billing simulation; no money will be charged.",
        "Synthetic tax and proration are zero; live amounts require a reviewed provider quote.",
        "Provider acceptance does not enable application capabilities or complete provisioning.",
      ],
    };
  }
  async confirm(command: BillingCommand): Promise<BillingAcceptance> {
    const plan = target(command);
    if (!uuid.test(command.tenantId) || !uuid.test(command.commandId))
      throw new Error("INVALID_BILLING_REFERENCE");
    const key = `${command.tenantId}:${command.commandId}`;
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          command.tenantId,
          command.commandId,
          command.action,
          command.currentPlan.code,
          command.currentPlan.currency,
          command.currentPlan.recurringTotalMinor,
          command.currentPlan.interval,
          plan.code,
          plan.currency,
          plan.recurringTotalMinor,
          plan.interval,
        ]),
      )
      .digest("hex");
    const existing = this.commands.get(key);
    if (existing && existing.hash !== hash) throw new Error("BILLING_IDEMPOTENCY_CONFLICT");
    if (existing) return structuredClone(existing.acceptance);
    const providerReference = `synthetic_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const outcome = this.options.outcome ?? "accepted";
    const acceptance: BillingAcceptance = {
      state: outcome,
      providerReference: outcome === "unknown" ? null : providerReference,
      externalCharge: false,
    };
    // Unknown acceptance simulates a lost response after the provider accepted the command.
    // Recovery reads current state instead of repeating the financial command.
    const authoritative: AuthoritativeBillingState = {
      tenantId: command.tenantId,
      commandId: command.commandId,
      providerReference,
      status: outcome === "failed" ? "failed" : command.action === "cancel" ? "canceled" : "active",
      plan: structuredClone(plan),
      observedAt: (this.options.clock?.() ?? new Date()).toISOString(),
      externalCharge: false,
    };
    this.commands.set(key, { hash, acceptance, authoritative });
    return structuredClone(acceptance);
  }
  async readCurrentState(tenantId: string, commandId: string) {
    const state = this.commands.get(`${tenantId}:${commandId}`)?.authoritative;
    return state ? structuredClone(state) : null;
  }
  async createPortalSession(tenantId: string): Promise<HostedPortalSession> {
    if (!uuid.test(tenantId)) throw new Error("INVALID_BILLING_REFERENCE");
    const expires = new Date((this.options.clock?.() ?? new Date()).getTime() + 30 * 60 * 1000);
    return {
      url: `http://127.0.0.1:3001/dev/billing/portal?tenant=${tenantId}`,
      expiresAt: expires.toISOString(),
    };
  }
  verifyWebhook(
    rawBody: string,
    signature: string,
    now = this.options.clock?.() ?? new Date(),
  ): BillingWebhookEvent {
    if (Buffer.byteLength(rawBody) > 16_384 || !Number.isFinite(now.getTime()))
      throw new Error("INVALID_BILLING_WEBHOOK");
    const match = /^t=(\d{10}),v1=([0-9a-f]{64})$/.exec(signature);
    if (!match || Math.abs(now.getTime() / 1000 - Number(match[1])) > 300)
      throw new Error("INVALID_BILLING_WEBHOOK_SIGNATURE");
    const expected = createHmac("sha256", this.key).update(`${match[1]}.${rawBody}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2], "hex")))
      throw new Error("INVALID_BILLING_WEBHOOK_SIGNATURE");
    const event: unknown = JSON.parse(rawBody);
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new Error("INVALID_BILLING_WEBHOOK");
    const value = event as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "commandId,id,providerReference,tenantId,type" ||
      value.type !== "billing.changed" ||
      typeof value.id !== "string" ||
      !uuid.test(value.id) ||
      typeof value.tenantId !== "string" ||
      !uuid.test(value.tenantId) ||
      typeof value.commandId !== "string" ||
      !uuid.test(value.commandId) ||
      typeof value.providerReference !== "string" ||
      !/^synthetic_[0-9a-f]{32}$/.test(value.providerReference)
    )
      throw new Error("INVALID_BILLING_WEBHOOK");
    return value as unknown as BillingWebhookEvent;
  }
  /** Fixture generator only. Production adapters must never accept this signature format. */
  syntheticWebhook(event: BillingWebhookEvent, now = this.options.clock?.() ?? new Date()) {
    const rawBody = JSON.stringify(event);
    const timestamp = Math.floor(now.getTime() / 1000);
    const digest = createHmac("sha256", this.key).update(`${timestamp}.${rawBody}`).digest("hex");
    return { rawBody, signature: `t=${timestamp},v1=${digest}` };
  }
}
