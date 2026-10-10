/** Administration-owned reference resolver, bound to the caller's verified tenant transaction. */
export interface CmsProfileReferencePort {
  /** Return only reference identity, retaining a SHARE lock until the caller commits. */
  requireActiveReference(profileId: string): Promise<{ id: string; organizationId: string }>;
}
