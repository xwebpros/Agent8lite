/** Design interface only. Implement and test mock first at M5. No secrets in UI or DTOs. */
export type ProviderMode = 'replication' | 'live_query' | 'embed';
export type PermissionState = 'allowed' | 'denied' | 'unknown';
export interface FeedContext { readonly organizationId: string; readonly feedId: string; readonly policyVersion: string; }
export interface MlsPolicy {
  readonly approvalState: 'unapproved' | 'approved' | 'revoked';
  readonly rights: Readonly<Record<'display'|'replicate'|'cache'|'storeMedia'|'alerts'|'aiUse',PermissionState>>;
  readonly allowedFields: readonly string[];
  readonly addressRule: 'visible' | 'hidden' | 'listing_specific';
  readonly locationRule: 'exact' | 'coarse' | 'hidden' | 'listing_specific';
  readonly maxDataAgeSeconds: number | null; // null means unresolved, NOT unlimited
  readonly maxCacheAgeSeconds: number | null;
  readonly retentionDays: number | null;
  readonly attributionText: string;
  readonly attributionLogoAssetId: string | null;
  readonly disclaimerVersion: string;
}
export interface Capabilities {
  readonly mode: ProviderMode;
  readonly reso: {version: string; dictionaryVersion: string} | null;
  readonly supports: Readonly<Record<'incremental'|'deletions'|'search'|'maps'|'savedSearches'|'alerts'|'openHouses'|'inquiryWebhook',boolean>>;
  readonly media: 'provider_url' | 'signed_proxy' | 'licensed_copy' | 'none';
  readonly rate: {requestsPerMinute: number|null; maxPageSize: number|null};
}
export interface ListingCriteria { feedIds?: readonly string[]; status?: readonly ('active'|'pending'|'closed'|'off_market')[]; priceMin?: number; priceMax?: number; bedroomsMin?: number; bathroomsMin?: number; propertyTypes?: readonly string[]; bbox?: readonly [number,number,number,number]; q?: string; }
export interface CanonicalListing {
  readonly sourceListingKey: string; readonly sourceStatus: string;
  readonly status: 'active'|'pending'|'closed'|'off_market'|'unknown';
  readonly sourceModifiedAt: string|null; readonly ingestedAt: string; readonly expiresAt: string;
  readonly listPrice: number|null; readonly bedrooms: number|null; readonly bathrooms: number|null;
  readonly area: {value:number;unit:'sqft'|'sqm'}|null;
  readonly address: string|null; readonly coordinates: readonly [number,number]|null;
  readonly publicRemarks: string|null; readonly propertyType: string|null;
  readonly displayAllowed: boolean; readonly addressAllowed: boolean;
  readonly attribution: {brokerage:string|null;agent:string|null;disclaimer:string};
  readonly synthetic: boolean;
}
export interface SourceChange {readonly kind:'upsert'|'delete';readonly sourceListingKey:string;readonly listing?:CanonicalListing;}
export interface ChangePage {readonly changes:readonly SourceChange[];readonly nextOpaqueCursor:string|null;readonly completedWatermark:string|null;}
export interface SearchPage {readonly items:readonly CanonicalListing[];readonly nextOpaqueCursor:string|null;readonly asOf:string;}
export interface MediaDescriptor {readonly sourceMediaKey:string;readonly listingKey:string;readonly url:string;readonly expiresAt:string|null;readonly ordering:number;readonly alternativeText:string|null;}
export interface EmbedDescriptor {readonly origin:string;readonly path:string;readonly supportedPostMessageTypes:readonly string[];}
export interface MlsBase {readonly providerCode:string;capabilities(context:FeedContext):Promise<Capabilities>;health(context:FeedContext):Promise<{state:'ready'|'degraded'|'unavailable';lastSuccessAt:string|null}>;}
export interface ReplicationAdapter extends MlsBase {readonly mode:'replication';readChanges(context:FeedContext,input:{cursor:string|null;watermark:string|null;overlapSeconds:number;limit:number}):Promise<ChangePage>;readMedia(context:FeedContext,sourceListingKey:string):Promise<readonly MediaDescriptor[]>;}
export interface LiveQueryAdapter extends MlsBase {readonly mode:'live_query';search(context:FeedContext,criteria:ListingCriteria,cursor:string|null):Promise<SearchPage>;getListing(context:FeedContext,sourceListingKey:string):Promise<CanonicalListing|null>;}
export interface EmbedAdapter extends MlsBase {readonly mode:'embed';getEmbed(context:FeedContext,siteId:string):Promise<EmbedDescriptor>;}
export type MlsAdapter = ReplicationAdapter | LiveQueryAdapter | EmbedAdapter;
export interface SecretBroker { withCredential<T>(context:FeedContext,run:(credential:Readonly<{kind:'oauth'|'api_key';accessToken:string}>)=>Promise<T>):Promise<T>; }
// Credential lifetime is server-only. Do not serialize, log, persist in listings or accept from a job body.
// Mock implements the same replication/live-query contract, with synthetic:true and obvious sample branding.
// Embed events require allowlisted exact origins and a separately verified inquiry adapter; never trust arbitrary postMessage.
