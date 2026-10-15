"use client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { components, operations } from "../../../../packages/contracts/generated/api";
import { useTemplateSite } from "./context";
import { templateRequest } from "./request";
export { templateRequest, TemplateApiError } from "./request";

export type Listing = components["schemas"]["IdxTemplateListing"];
export type ListListingsParams = NonNullable<operations["searchIdxTemplateListings"]["parameters"]["query"]>;
export type ListListingsSort = NonNullable<ListListingsParams["sort"]>;
export const ListListingsSort = {
  newest: "newest",
  "price-asc": "price-asc",
  "price-desc": "price-desc",
} as const;
export type SavedSearchCriteria = ListListingsParams;
function useExpiry(expiresAt: string | undefined) {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!expiresAt) {
      setExpired(false);
      return;
    }
    const check = () =>
      setExpired(!Number.isFinite(Date.parse(expiresAt)) || Date.now() >= Date.parse(expiresAt));
    check();
    const timer = setTimeout(check, Math.max(0, Math.min(2147483647, Date.parse(expiresAt) - Date.now())));
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", check);
    };
  }, [expiresAt]);
  return expired || Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
}
export function getListListingsQueryKey(filters: ListListingsParams) {
  return ["idx-template-listings", filters] as const;
}
export function useGetIdxStatus() {
  const site = useTemplateSite();
  return useQuery({
    queryKey: ["idx-template-status", site.siteId, site.revisionId],
    queryFn: ({ signal }) =>
      templateRequest<components["schemas"]["IdxTemplateStatus"]>(site.siteId, "status", { signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}
export function useListListings(
  filters: ListListingsParams,
  options?: { query?: { enabled?: boolean; queryKey?: unknown } },
) {
  const site = useTemplateSite();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
  const enabled = options ? options.query?.enabled === true : true;
  const query = useQuery({
    queryKey: [site.siteId, site.revisionId, ...getListListingsQueryKey(filters)],
    enabled,
    queryFn: ({ signal }) =>
      templateRequest<components["schemas"]["IdxTemplateListingPage"]>(site.siteId, `listings?${params}`, {
        signal,
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const deadline = query.data?.items.reduce(
    (min, row) => (Date.parse(row.expiresAt) < Date.parse(min) ? row.expiresAt : min),
    site.expiresAt,
  );
  const expired = useExpiry(deadline);
  return { ...query, data: expired || !enabled ? undefined : query.data, isError: query.isError || expired };
}
export function useGetListing(listingKey: string) {
  const site = useTemplateSite();
  const query = useQuery({
    queryKey: ["idx-template-detail", site.siteId, site.revisionId, listingKey],
    queryFn: ({ signal }) =>
      templateRequest<Listing>(site.siteId, `listings/${encodeURIComponent(listingKey)}`, { signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const expired = useExpiry(query.data?.expiresAt);
  return { ...query, data: expired ? undefined : query.data, isError: query.isError || expired };
}
