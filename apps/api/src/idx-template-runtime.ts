import type { components } from "../../../packages/contracts/generated/api";
import type { IdxTemplateProviderFactory } from "../../../packages/contracts/internal/idx-template-provider";
import { AccessError } from "../../../packages/db/tenant-transaction";
import { projectNativeMockListing } from "../../../packages/mls/projection";
import {
  createMockIdxTemplateProvider,
  createUnavailableIdxTemplateProvider,
} from "../../../packages/providers/mls/las-vegas-idx/provider";
import { NativeMockListingRepository } from "./mls/repository";

/** The public template consumes the same current, policy-aware mock source as native IDX. */
export const createIdxTemplateRuntimeProvider: IdxTemplateProviderFactory = (binding, authorize, client) => {
  if (binding.mode !== "mock") return createUnavailableIdxTemplateProvider();
  if (!client)
    throw new AccessError(503, "idx_provider_unavailable", "The current listing transaction is unavailable.");
  return createMockIdxTemplateProvider(binding, authorize, async () => {
    const { snapshot, now } = await new NativeMockListingRepository(client).current();
    const feed = snapshot.feeds.find((row) => row.id === binding.feedId);
    if (!feed || feed.providerCode !== "mock-synthetic" || feed.mode !== "mock")
      throw new AccessError(503, "idx_provider_unavailable", "The synthetic feed is unavailable.");
    const results: components["schemas"]["IdxTemplateListing"][] = [];
    for (const row of snapshot.listings) {
      if (row.feedId !== feed.id) continue;
      const current = projectNativeMockListing(row, feed, now);
      if (!current) continue;
      const media = await client.query<{ source_url: string; expires_at: Date }>(
        "SELECT source_url,expires_at FROM app.listing_media WHERE tenant_id=app.current_tenant() AND listing_id=$1 AND expires_at>clock_timestamp() ORDER BY position,id LIMIT 1025 FOR SHARE",
        [row.id],
      );
      if (media.rowCount && media.rowCount > 1024)
        throw new AccessError(
          503,
          "idx_media_limit",
          "The complete gallery exceeds the approved response bound.",
        );
      // Local synthetic media is a safe static fixture. Mock mode never borrows live MLS photos.
      const photos = media.rows.filter((item) =>
        /^\/idx-template-fixtures\/[a-z0-9-]+\.svg$/.test(item.source_url),
      );
      const address = current.displayAddress ?? undefined;
      const pieces = address?.match(/,\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
      const item: components["schemas"]["IdxTemplateListing"] = {
        listingKey: row.canonical.sourceListingKey,
        ...(current.sourceListingId !== null ? { listingId: current.sourceListingId } : {}),
        status: current.status === "active" ? "Active" : "Pending",
        ...(current.listPrice !== null ? { price: current.listPrice } : {}),
        ...(address ? { streetAddress: address } : {}),
        ...(pieces ? { city: pieces[1], state: pieces[2], postalCode: pieces[3] } : {}),
        ...(current.bedrooms !== null ? { bedrooms: current.bedrooms } : {}),
        ...(current.bathrooms !== null ? { bathrooms: current.bathrooms } : {}),
        ...(current.livingAreaSqft !== null ? { livingArea: current.livingAreaSqft } : {}),
        ...(current.latitude !== null ? { latitude: current.latitude } : {}),
        ...(current.longitude !== null ? { longitude: current.longitude } : {}),
        ...(current.remarks !== null ? { publicRemarks: current.remarks } : {}),
        ...(current.propertyType !== null ? { propertyType: current.propertyType } : {}),
        listingOffice: current.attribution.brokerageName,
        ...(current.attribution.agentName ? { listingAgent: current.attribution.agentName } : {}),
        ...(current.sourceUpdatedAt ? { modificationTimestamp: current.sourceUpdatedAt } : {}),
        photos: photos.map((value) => value.source_url),
        synthetic: true,
        expiresAt: new Date(
          Math.min(Date.parse(current.expiresAt), ...photos.map((value) => value.expires_at.getTime())),
        ).toISOString(),
      };
      results.push(item);
    }
    return results;
  });
};
