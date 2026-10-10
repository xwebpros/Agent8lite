import type { components } from "../generated/api";

type Consent = components["schemas"]["ConsentWrite"];
export type ConsentPurpose = Consent["purpose"];
export type SyntheticEvidenceRequest = Pick<Consent, "contactChannelId" | "purpose">;
export interface SyntheticEvidenceResponse {
  readonly evidenceRef: string;
  readonly policyVersion: "synthetic-communication-v1";
  readonly expiresAt: string;
  readonly synthetic: true;
}
export interface SyntheticConsentChannelsResponse {
  readonly contactId: string;
  readonly channels: readonly {
    readonly id: string;
    readonly kind: "email" | "phone";
    /** Generic label such as Email channel 1; no destination or contact values. */
    readonly label: string;
  }[];
}
export interface ConsentCommandIdentity {
  /** Server-selected caller namespace, never taken from a public body. */
  readonly producer: "staff" | "form";
  readonly key: string;
}
export interface ScopedConsentChannel {
  readonly channelId: string;
  readonly contactId: string;
  readonly kind: "email" | "phone";
  /** Private source data, never logged, emitted in events, or returned by the consent API. */
  readonly normalizedDestination: string;
  readonly contactVersion: string;
  readonly channelVersion: string;
}
/** CRM-owned reader bound to verified context and the invoking transaction. */
export interface ConsentChannelPort {
  /** Withdrawal keeps current scope checks but may resolve preserved archived/inactive identities. */
  resolve(
    channelId: string,
    access: "read" | "write" | "withdraw",
    lock?: boolean,
  ): Promise<ScopedConsentChannel>;
}
export interface VerifiedConsentEvidence {
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly initiatingMemberId: string;
  readonly channelId: string;
  readonly purpose: ConsentPurpose;
  readonly action: "grant";
  readonly policyVersion: string;
  readonly stateVersion: string;
  readonly channelVersion: string;
  readonly contactVersion: string;
  readonly expiresAt: string;
  readonly provenance: "synthetic-local";
}
/** Unknown/unconfigured provenance denies grants. Never fetch an evidence URL. */
export interface ConsentEvidencePort {
  resolveGrant(command: Consent): Promise<VerifiedConsentEvidence>;
}
export interface ConsentSnapshot {
  readonly contactChannelId: string;
  readonly purpose: ConsentPurpose;
  readonly state: "unknown" | "granted" | "withdrawn";
  readonly consentEligible: boolean;
  readonly revision: string;
  readonly reasonCodes: readonly string[];
}
/** Transaction-bound consent ownership; no nested transaction or provider delivery. */
export interface NativeConsentPort {
  record(command: Consent, identity: ConsentCommandIdentity): Promise<components["schemas"]["Job"]>;
  readEligibility(channelId: string, purpose: ConsentPurpose): Promise<ConsentSnapshot>;
  /** Re-resolve source authorization and consent/suppression state immediately before future dispatch. */
  assertCurrent(snapshot: ConsentSnapshot): Promise<ConsentSnapshot>;
}
