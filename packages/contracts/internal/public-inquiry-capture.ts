import type { components } from "../generated/api";

type Schemas = components["schemas"];

/** Private server command; public bodies never establish source or assignment authority. */
export type PublicInquiryCaptureCommand = Pick<
  Schemas["IdxTemplateInquiryWrite"],
  "name" | "email" | "phone" | "message" | "listingKey" | "listingId"
> & {
  readonly sourceSubmissionId: string;
  readonly siteId: string;
  readonly bindingId: string;
  readonly expectedBindingVersion: string;
};

/** Current source projection returned only by a transaction-bound trusted resolver. */
export interface PublicInquirySource {
  readonly siteId: string;
  readonly bindingId: string;
  readonly bindingVersion: string;
  readonly sourceId: string;
  readonly feedId: string;
  readonly providerCode: "mock-synthetic" | "trestle";
  readonly providerListingKey: string;
  readonly providerListingId?: string;
  readonly postalCode?: string;
  readonly policyVersion: string;
  readonly siteAgentMemberId: string | null;
  readonly listingAgentMemberId: string | null;
  readonly brokerageOfficeId: string | null;
}

export type PublicInquirySourceRequest = Pick<
  PublicInquiryCaptureCommand,
  "siteId" | "bindingId" | "expectedBindingVersion" | "listingKey"
>;

/**
 * Bound to verified tenant context and the invoking transaction. Retains SHARE
 * locks for site/source/feed/policy/member/office rows. Each invocation checks
 * the current database clock after waits; a previous projection is not authority.
 * Provider names, display IDs and client ownership fields never identify members.
 */
export interface PublicInquirySourcePort {
  requireCurrent(command: PublicInquirySourceRequest): Promise<PublicInquirySource>;
}

export interface PublicInquiryCaptureResult {
  readonly lead: Schemas["Lead"];
  readonly contactId: string;
  readonly noteId: string;
  readonly decisionId: string;
  readonly winningRuleId: string | null;
  readonly reasonCodes: readonly string[];
}

/**
 * CRM-owned transactional command. The caller serializes its durable public
 * receipt before execution. Contact/lead/note/audit/outbox effects share the
 * caller's transaction, and source authority is rechecked after lock waits and
 * after note creation before commit. Message text stays out of audit/outbox/logs.
 * The optional submitted listingId must match the resolved provider identifier;
 * matching it never supplies permission. Marketing consent is not inferred.
 */
export interface PublicInquiryCapturePort {
  capturePublicInquiry(command: PublicInquiryCaptureCommand): Promise<PublicInquiryCaptureResult>;
}
