import type { components } from "../../../packages/contracts/generated/api";
import type { VerifiedOidcIdentity } from "../../../packages/providers/identity/port";

type Schemas = components["schemas"];
/** Identity module only: its separate pool can insert sessions, never read tenant/control data. */
export interface StaffSessionIssuerPort {
  /** Accept only the server verifier's result after code/PKCE/nonce/issuer/signature validation. */
  issueVerifiedIdentity(identity: VerifiedOidcIdentity): Promise<{
    readonly opaqueToken: string;
    readonly csrfToken: string;
    readonly expiresAt: string;
  }>;
}
export interface SyntheticStaffSessionRequest {
  readonly identity: "administrator" | "support";
}
export interface SyntheticSupportSelection {
  readonly organizationId: string;
  readonly accessGrantId: string;
}
export interface SyntheticStaffSessionResponse {
  readonly staffUserId: string;
  readonly permissions: readonly string[];
  readonly synthetic: true;
  readonly supportContext: null | {
    readonly organizationId: string;
    readonly accessGrantId: string;
    readonly permissions: readonly string[];
    readonly reason: string;
    readonly expiresAt: string;
  };
}
/** Constructed only by current opaque-session/principal verification inside the caller transaction. */
export interface VerifiedStaffContext {
  readonly userId: string;
  readonly staffPrincipalId: string;
  readonly principalVersion: string;
  readonly permissionCodes: readonly string[];
  readonly sessionHash: string;
  readonly provenance: "synthetic-local";
}
export interface BootstrapPolicy {
  readonly version: "synthetic-provisioning-v1";
  readonly ownerUserId: string;
  readonly ownerDisplayName: string;
  readonly ownerIdentityVersion: string;
  readonly planId: string;
  readonly enabledCapabilities: readonly ("crm" | "billing")[];
  readonly provenance: "synthetic-local";
}
/** Unknown production onboarding/commercial binding denies enqueue/execution. */
export interface BootstrapPolicyResolver {
  resolve(): Promise<BootstrapPolicy>;
  assertCurrent(policy: BootstrapPolicy): Promise<void>;
}
export interface ProvisioningClaim {
  readonly jobId: string;
  readonly organizationId: string;
  readonly claimId: string;
  readonly expiresAt: string;
  readonly initiatingStaffUserId: string;
  readonly policy: BootstrapPolicy;
}
/** A verified claim binds all module bootstrap ports to this one invoking transaction. */
export interface VerifiedProvisioningContext extends ProvisioningClaim {
  readonly traceId: string;
}
export interface CrmBootstrapPort {
  seedDefaults(ownerMemberId: string): Promise<void>;
  verifyDefaults(ownerMemberId: string): Promise<void>;
}
export interface BillingBootstrapPort {
  seedApprovedPolicy(): Promise<void>;
  assertReady(): Promise<void>;
}
export interface ControlProvisioningPort {
  enqueue(body: Schemas["OrganizationCreate"], key: string): Promise<Schemas["Job"]>;
  claim(jobId: string): Promise<ProvisioningClaim | null>;
  readJob(jobId: string): Promise<Schemas["Job"]>;
  fail(
    jobId: string,
    claimId: string,
    code:
      | "bootstrap_owner_unavailable"
      | "bootstrap_policy_changed"
      | "bootstrap_defaults_invalid"
      | "provisioning_lease_lost"
      | "provisioning_unavailable",
  ): Promise<Schemas["Job"]>;
}
/** Constructed in the caller's verified provisioning transaction, with its bound module ports. */
export interface ProvisioningExecutionPort {
  execute(): Promise<Schemas["Job"]>;
}
/** Separate staff grant authority; never a synthetic Owner membership. */
export interface SupportReadContext {
  readonly organizationId: string;
  readonly staffUserId: string;
  readonly staffPrincipalId: string;
  readonly principalVersion: string;
  readonly accessGrantId: string;
  readonly grantVersion: string;
  readonly expiresAt: string;
  readonly permissionCodes: readonly string[];
  readonly provenance: "synthetic-local";
}
export interface SupportAccessPort {
  createGrant(organizationId: string, body: Schemas["AccessGrant"], key: string): Promise<Schemas["Job"]>;
  select(selection: SyntheticSupportSelection): Promise<SyntheticStaffSessionResponse>;
  clear(): Promise<SyntheticStaffSessionResponse>;
  revoke(
    organizationId: string,
    grantId: string,
    key: string,
    expectedVersion: string,
  ): Promise<Schemas["Job"]>;
  resolveCurrent(permission: string): Promise<SupportReadContext>;
  /** Reload current principal/grant/mode and ignore caller-provided permission/provenance fields. */
  assertCurrent(context: SupportReadContext, permission: string): Promise<SupportReadContext>;
}
export type SupportResource =
  | "contacts"
  | "leads"
  | "tasks"
  | "deals"
  | "pipeline-stages"
  | "lead-sources"
  | "tags";
/** CRM-owned authorized projection. No write commands, notes, exports or provider effects. */
export interface SupportCrmReadPort {
  detail<R extends SupportResource>(resource: R, id: string): Promise<SupportResourceEntity[R]>;
  list<R extends SupportResource>(
    resource: R,
    query: { readonly cursor?: string; readonly limit?: string; readonly filter?: string },
  ): Promise<SupportResourcePage[R]>;
}
export interface SupportResourceEntity {
  contacts: Schemas["Contact"];
  leads: Schemas["Lead"];
  tasks: Schemas["Task"];
  deals: Schemas["Deal"];
  "pipeline-stages": Schemas["PipelineStage"];
  "lead-sources": Schemas["LeadSource"];
  tags: Schemas["Tag"];
}
export interface SupportResourcePage {
  contacts: Schemas["PageContact"];
  leads: Schemas["PageLead"];
  tasks: Schemas["PageTask"];
  deals: Schemas["PageDeal"];
  "pipeline-stages": Schemas["PagePipelineStage"];
  "lead-sources": Schemas["PageLeadSource"];
  tags: Schemas["PageTag"];
}
