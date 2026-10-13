import type { components, operations } from "../generated/api";

type Schemas = components["schemas"];
export type IdxTemplateQuery = NonNullable<operations["searchIdxTemplateListings"]["parameters"]["query"]>;

/** Server-owned proof. This type is never accepted as public request authority. */
export interface IdxTemplateProviderBinding {
  readonly bindingId: string;
  readonly siteId: string;
  readonly organizationId: string;
  readonly feedId: string;
  readonly mode: "mock" | "live";
  readonly policyVersion: string;
  readonly policyExpiresAt: string;
  readonly expiresAt: string;
}
export interface IdxTemplateProvider {
  status(): Promise<Schemas["IdxTemplateStatus"]>;
  search(query: IdxTemplateQuery): Promise<Schemas["IdxTemplateListingPage"]>;
  detail(listingKey: string): Promise<Schemas["IdxTemplateListing"]>;
}
/** Invoked only inside the verified site transaction; reauthorization survives awaits. */
export type IdxTemplateProviderFactory = (
  binding: IdxTemplateProviderBinding,
  assertCurrent: () => Promise<void>,
) => IdxTemplateProvider;
