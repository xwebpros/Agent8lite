import type { TenantContext } from "../db/tenant-transaction";
import type { CanonicalListing } from "../providers/mls/port";

/** Caller must obtain this context from the verified tenant transaction, never request JSON. */
export type ListingReadContext = Pick<
  TenantContext,
  "organizationId" | "userId" | "memberId" | "roleId" | "permissions"
>;

export interface NativeMockFeed {
  readonly tenantId: string;
  readonly id: string;
  readonly mode: string;
  readonly transport: string;
  readonly providerCode: string;
  readonly state: string;
  readonly revision: number;
  /** Untrusted persisted JSON: validated independently on every read. */
  readonly displayPolicy: unknown;
  readonly nativeRights: unknown;
}

export interface NativeMockListing {
  readonly tenantId: string;
  readonly id: string;
  readonly feedId: string;
  readonly sourceListingId: string | null;
  readonly currency: string;
  readonly revision: number;
  readonly withdrawnAt: string | null;
  readonly canonical: CanonicalListing;
}

/** Fresh transaction snapshot, not a reusable display cache. */
export interface NativeMockSnapshot {
  readonly feeds: readonly NativeMockFeed[];
  readonly listings: readonly NativeMockListing[];
}
