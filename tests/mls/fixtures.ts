import { fixtures } from "../../packages/db/fixtures";
import type { DisplayPolicy, ListingReadContext, NativeMockSnapshot } from "../../packages/mls";
import { MOCK_CLOCK, MockMlsAdapter, mockPolicy } from "../../packages/providers/mls/mock";
import type { FeedContext, MlsAttributionContact, MlsPolicy } from "../../packages/providers/mls/port";

export const syntheticAttributionContacts: readonly MlsAttributionContact[] = [
  { kind: "email", value: "attribution@fictional-brokerage.example.invalid" },
  { kind: "phone", value: "+1 702 555 0100" },
];

export const feedId = "a0000000-0000-4000-8000-000000000001";
export const context: ListingReadContext = {
  organizationId: fixtures.orgA,
  userId: fixtures.ownerUser,
  memberId: fixtures.ownerMemberA,
  roleId: "40000000-0000-4000-8000-000000000101",
  permissions: [{ code: "mls.read", scope: "organization" }],
};
export const providerContext: FeedContext = {
  organizationId: context.organizationId,
  feedId,
  policyVersion: "synthetic-v1",
};
export const nativeRights: MlsPolicy = {
  ...mockPolicy,
  allowedFields: [
    ...mockPolicy.allowedFields,
    "propertyType",
    "sourceListingId",
    "sourceModifiedAt",
    "attribution.brokerage",
    "attribution.agent",
    "attribution.disclaimer",
    "attribution.contact",
  ],
};
export const displayPolicy: DisplayPolicy = {
  version: 1,
  allowedStatuses: ["active", "pending"],
  displayFields: [...nativeRights.allowedFields],
  maxStaleSeconds: 86400,
  refreshSeconds: 60,
  rawRetentionSeconds: 86400,
  mediaCacheSeconds: 0,
  allowAiUse: false,
  allowReplication: true,
  attributionText: "SYNTHETIC DEMO DATA. No real property or offer.",
  approved: true,
};
export const options = {
  now: new Date(MOCK_CLOCK),
  signingKey: "w07-synthetic-test-cursor-key-at-least-32-bytes",
};

/** Read the existing mock replication seam; do not invent a second fixture provider. */
export async function mockSnapshot(
  adapter = new MockMlsAdapter(
    () => MOCK_CLOCK,
    () => nativeRights,
  ),
): Promise<NativeMockSnapshot> {
  const page = await adapter.readChanges(providerContext, {
    cursor: null,
    watermark: null,
    overlapSeconds: 0,
    limit: 100,
  });
  return {
    feeds: [
      {
        tenantId: context.organizationId,
        id: feedId,
        mode: "mock",
        transport: "mock",
        providerCode: adapter.providerCode,
        state: "ready",
        revision: 1,
        displayPolicy: structuredClone(displayPolicy),
        nativeRights: structuredClone(nativeRights),
      },
    ],
    listings: page.changes.flatMap((change, index) =>
      change.listing
        ? [
            {
              tenantId: context.organizationId,
              id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
              feedId,
              sourceListingId: change.sourceListingKey,
              currency: "USD",
              revision: 1,
              withdrawnAt: null,
              canonical: {
                ...structuredClone(change.listing),
                attribution: {
                  ...structuredClone(change.listing.attribution),
                  ...(syntheticAttributionContacts[index]
                    ? { contact: structuredClone(syntheticAttributionContacts[index]) }
                    : {}),
                },
              },
            },
          ]
        : [],
    ),
  };
}
