export type BillingAction = "change_plan" | "cancel" | "resume";
export interface BillingPlan {
  readonly code: string;
  readonly currency: "USD";
  readonly recurringTotalMinor: number;
  readonly interval: "month" | "year";
}
export interface BillingPreviewInput {
  readonly action: BillingAction;
  readonly currentPlan: BillingPlan;
  readonly targetPlan?: BillingPlan;
  readonly now: Date;
}
export interface ProviderBillingPreview {
  readonly currency: "USD";
  readonly dueNowMinor: number;
  readonly recurringTotalMinor: number;
  readonly interval: "month" | "year";
  readonly effectiveAt: string;
  readonly terms: readonly string[];
  readonly termsVersion: string;
}
export interface BillingCommand {
  readonly tenantId: string;
  readonly commandId: string;
  readonly action: BillingAction;
  readonly currentPlan: BillingPlan;
  readonly targetPlan?: BillingPlan;
}
export interface BillingAcceptance {
  readonly state: "accepted" | "unknown" | "failed";
  readonly providerReference: string | null;
  readonly externalCharge: false;
}
export interface AuthoritativeBillingState {
  readonly tenantId: string;
  readonly commandId: string;
  readonly providerReference: string;
  readonly status: "active" | "canceled" | "failed";
  readonly plan: BillingPlan;
  readonly observedAt: string;
  readonly externalCharge: false;
}
export interface BillingWebhookEvent {
  readonly id: string;
  readonly type: "billing.changed";
  readonly tenantId: string;
  readonly commandId: string;
  readonly providerReference: string;
}
export interface HostedPortalSession {
  readonly url: string;
  readonly expiresAt: string;
}
/** A provider acceptance is not an entitlement or provisioning decision. */
export interface BillingProvider {
  preview(input: BillingPreviewInput): Promise<ProviderBillingPreview>;
  confirm(command: BillingCommand): Promise<BillingAcceptance>;
  readCurrentState(tenantId: string, commandId: string): Promise<AuthoritativeBillingState | null>;
  verifyWebhook(rawBody: string, signature: string, now?: Date): BillingWebhookEvent;
  createPortalSession(tenantId: string): Promise<HostedPortalSession>;
}
