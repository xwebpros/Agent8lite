import type { components } from "../generated/api";

/** Reviewed local-only synthetic capture. Body identities never establish tenant or assignment permission. */
export type NativeCaptureV1 = Pick<
  components["schemas"]["LeadCreate"],
  "contactId" | "sourceId" | "intent" | "timeline"
> & {
  readonly sourceSubmissionId: string;
  readonly postalCode?: string;
};
export interface NativeCaptureDecision {
  readonly lead: components["schemas"]["Lead"];
  readonly decisionId: string;
  readonly winningRuleId: string | null;
  readonly reasonCodes: readonly string[];
}
/** Bound to verified context and the caller's tenant transaction; no nested independent transaction. */
export interface NativeCapturePort {
  capture(command: NativeCaptureV1): Promise<NativeCaptureDecision>;
}
