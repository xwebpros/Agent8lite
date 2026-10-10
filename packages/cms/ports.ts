/** Supplied by administration, bound to the caller's PoolClient and verified tenant transaction. */
export interface CmsProfileReferencePort {
  /** Reject missing/foreign/ineligible references; retain a SHARE row lock until caller commit. */
  requireActiveReference(profileId: string): Promise<{ id: string; organizationId: string }>;
}
