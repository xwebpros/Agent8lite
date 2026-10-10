import fs from 'node:fs/promises';
import path from 'node:path';
import {tables,operations,out} from './contracts.mjs';

export const tokens={status:'Proposed independent design system v1',font:{sans:'Inter, system-ui, sans-serif',mono:'ui-monospace, Consolas, monospace',body:16,dense:14,label:14,caption:12,h1:32,h2:24,h3:18,lineHeight:1.5},color:{canvas:'#F5F7FB',surface:'#FFFFFF',ink:'#172238',muted:'#52617A',border:'#CBD3DF',primary:'#2459B8',primaryHover:'#19458F',primaryText:'#FFFFFF',positive:'#096B52',positiveSurface:'#E8F6F0',warning:'#805300',warningSurface:'#FFF3D6',danger:'#A52432',dangerSurface:'#FDECEE',focus:'#2459B8',nav:'#15263F',navText:'#E8EFF9'},spacing:[4,8,12,16,24,32,48,64],radius:{control:8,card:12,dialog:16},layout:{sidebar:240,header:64,contentMax:1440,pagePadding:24,touchTarget:44},motion:{shortMs:120,standardMs:180,respectReducedMotion:true},breakpoints:{mobile:360,tablet:768,desktop:1200},density:{comfortableRow:52,compactRow:40,compactDesktopOnly:true}};

export const invariants=[
 ['INV-01','Verified context','Identity, membership, tenant, row scope and entitlement are verified at request and job execution. A tenant ID supplied by a browser is never authorization.'],
 ['INV-02','Database boundary','Business FKs contain tenant_id; PostgreSQL runtime roles cannot bypass RLS or own tables. Every pooled transaction sets local verified context; missing context denies access.'],
 ['INV-03','One durable command','Idempotency keys bind actor, tenant, operation and canonical input hash. Domain changes and outbox events commit in the same PostgreSQL transaction.'],
 ['INV-04','Explicit versions','Content, forms, campaigns, metrics, routing policies, provider mappings, prompts and display policies are versioned. Conflicting edits never silently overwrite.'],
 ['INV-05','Delivery eligibility','Sending checks current consent, suppression, resource state, scope, entitlements, quiet hours and provider readiness at dispatch. Unknown provider acceptance requires reconciliation.'],
 ['INV-06','MLS rights before visibility','Unknown permissions mean deny. Data display, media storage, caches, alerts, retention and AI use are independently gated by approved provider rights.'],
 ['INV-07','Synthetic development','Until authorized connectivity, the only MLS source is the mock adapter and conspicuously fictional fixtures. Production live adapters reject synthetic data.'],
 ['INV-08','Human AI control','AI proposes drafts; acceptance saves a reviewed draft only. Publishing, sending, billing and consent changes remain explicit authorized commands.'],
 ['INV-09','Truthful outcomes','A queued operation is not a completed operation. Unknown, zero, unavailable and stale metrics are different states with timestamps and definitions.'],
 ['INV-10','No hidden cross-module writes','Module service ports and versioned events are the integration boundaries. Consumer modules do not directly mutate another module’s tables.'],
 ['INV-11','Revocation applies everywhere','Revoked membership, staff grants, visitor sessions, feeds or consents invalidate future requests, jobs and signed downloads.'],
 ['INV-12','Evidence and proposed behavior','Audit observation, inferred technology and proposed architecture remain labeled. Runtime, licensing and commercial assumptions need their milestone gates.']
];

export const adrs=[
 ['ADR-001','Modular monolith with separate workers','NestJS modules expose service ports over one transactional database; Next.js and workers are independently deployable. This keeps tenant commands atomic and reduces operational overhead. Extract a service only after measured scaling or isolation needs justify it.'],
 ['ADR-002','Contracts first, REST first','OpenAPI 3.1.1 and JSON Schema are shared contracts. Generate TypeScript clients and validate inputs at the boundary. No initial GraphQL layer: current list/detail/command flows fit REST and avoid a second authorization surface.'],
 ['ADR-003','PostgreSQL/PostGIS search first','Use tenant-scoped relational filters, text indexes and geographic indexes. An external search engine is optional after measured query/index limits; rights expiry and authoritative policy still govern cached index results.'],
 ['ADR-004','Native website content model','Use independently designed blocks, templates and a Puck editor adapter. Store data owned by the platform and render through Next.js. WordPress migration is a later adapter, not a requirement to operate two publishing systems.'],
 ['ADR-005','Durability in PostgreSQL, wakeups in Redis','Persist jobs, scheduled actions and outbox rows in PostgreSQL. BullMQ manages concurrency and wakeups. A Redis loss must be recoverable by scanning due committed work; a Redis acknowledgment is not the business transaction.'],
 ['ADR-006','Tenant isolation in depth','One schema with composite tenant keys and FORCE RLS, plus application permission/row-scope guards. Separate databases per tenant remain an exceptional later deployment option; neither schema count nor a browser selector supplies security.'],
 ['ADR-007','Provider capabilities determine IDX UX','Support authorized replication, live-query and embed modes. Unsupported actions are hidden or explained; embed-only rights do not authorize native storage, alerts or AI retrieval.'],
 ['ADR-008','Hosted identity and payments','OIDC Authorization Code + PKCE through a BFF; proposed Entra External ID. Stripe hosted payment/customer flows and verified webhooks. Local roles/entitlements stay platform-owned.'],
 ['ADR-009','Assistive AI behind an adapter','Use the OpenAI Responses API with strict schemas, scoped facts, evaluation gates and draft review. Pin model/prompt versions per release after measurement; do not make the architecture depend on a permanently named model.'],
 ['ADR-010','Managed infrastructure, portable applications','Propose Azure Container Apps, managed PostgreSQL, private Redis, Blob Storage, Key Vault and CDN. OCI images and provider interfaces keep the application portable; provider procurement, region and capacity remain owner decisions.']
];

export const repoTree=`/
  AGENTS.md                         # copied from this blueprint after repo approval
  package.json  pnpm-workspace.yaml  pnpm-lock.yaml  tsconfig.base.json
  .github/CODEOWNERS
  .github/workflows/{ci,preview,release}.yml
  apps/
    web/{app,features,components,lib}/
      app/(workspace)/{dashboard,crm,websites,marketing,properties,reports,settings,support}/
      app/(sites)/[[...slug]]/page.tsx
      app/(staff)/organizations/
      lib/{api,session,site-resolution}.ts
    api/src/
      main.ts  app.module.ts
      platform/{auth,tenancy,permissions,validation,idempotency,observability}/
      modules/{saas,billing,dashboard,crm,cms,marketing,property,reporting,ai,local-presence,support}/
        MODULE/{MODULE.module,MODULE.controller,MODULE.service,MODULE.repository}.ts
        MODULE/{dto,ports,policies,__tests__}/
    worker/src/
      main.ts
      {outbox,imports,publishing,campaigns,delivery,mls,analytics,ai,integrations}/
  packages/
    contracts/{openapi.json,events.schema.json,permissions.json,generated/,src/}
    db/{schema/,migrations/,tenant-transaction.ts,test-roles.sql}
    auth/{session.ts,permission.ts,scope.ts,csrf.ts}
    ui/{components/,forms/,tables/,charts/,stories/}
    tokens/{tokens.json,tokens.css}
    blocks/{schema/,registry.ts,render/,editor/,migrations/}
    templates/{agent/,brokerage/,landing/,manifest.json}
    providers/{mls,email,sms,email-editor,ai,local,calendar,dns}/
      PROVIDER/{port.ts,mock.ts,adapter.ts,contract.test.ts}
    metrics/{definitions/,aggregation/,schema.ts}
    config/{env.schema.ts,capabilities.ts}
  fixtures/{identity,crm,mls,cms,marketing}/
  evals/ai/{datasets/,runners/,rubrics/,results/}
  tests/{integration,e2e,load,accessibility}/
  infra/terraform/{modules,environments/{dev,staging,production}}/
  docs/{tdd,adr,runbooks,api,changelog}/`;

export const mlsInterface=`/** Design interface only. Implement and test mock first at M5. No secrets in UI or DTOs. */
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
`;

export const agentRules=`# Codex implementation rules — proposed future repository

This is a template for the future implementation repository. The current blueprint is a design artifact, not a deployed product. Copy this file to that repository only when implementation starts.

## Authority and scope
- Read docs/tdd and the owning module specification before coding. The approved TDD, OpenAPI contracts, event schemas, permission catalog and ADRs define behavior. Identify discrepancies in a contract PR; never silently invent provider features or undocumented API shapes.
- Inspect the current tree, branch and applicable nested AGENTS.md files. More specific repository instructions apply to their directory. User instructions take precedence.
- Work only on the assigned workstream and its owned files. Shared contract, database migration, root dependency or design token changes require the named shared owner’s review.

## Worktrees and coordination
- Use one Git worktree and a distinct branch per workstream. Create a branch before submitting changes from a detached worktree. Do not edit another agent’s checkout or run a destructive cleanup against it.
- Branch format: feat/Wxx-short-purpose. Commit a contract/schema proposal before consumers implement it. Keep contract changes additive within v1; use a new event/API version for incompatible behavior.
- Never copy credentials, customer exports or production .env files into worktrees. Use fixture identities, mock providers and a no-delivery communication transport.
- Integration owner merges reviewed PRs in dependency order and owns release tags, migrations and deployment gates. No automatic merge or production deployment merely because local tests pass.

## Platform invariants
- Enforce INV-01 through INV-12. Verify session identity and active membership; never trust request tenant/owner/site identifiers as permission evidence.
- Use packages/db/tenant-transaction.ts to set verified tenant and actor context transaction-locally. Runtime/worker roles are non-owner, NOSUPERUSER and NOBYPASSRLS. Scope own/team/organization in addition to RLS. Test pool reuse and missing context.
- No module directly writes another module’s tables. Use an approved service port for transactional commands or a versioned outbox event for asynchronous work. Preserve tenant context through every boundary.
- Generate API types from packages/contracts/openapi.json; validate request schemas and business rules. Do not introduce a second handwritten client contract. Mutations follow idempotency, CSRF, revision and audit conventions.
- Schema changes use reviewed forward migrations with expand/backfill/contract phases where compatibility matters. Never reset production data. Run migrations under the separate migration identity; never expose it to runtime pods.
- Logs, traces and events must not contain credentials, session tokens, complete provider payloads, contact message bodies or unrestricted personal data. Redact at collection, not only in the UI.

## MLS and communication rules
- Before M6 authorization, implement and test only the mock MLS adapter with conspicuously synthetic data. Do not scrape, obtain restricted data, assume a provider or use production feed credentials.
- The owner-selected provider is CoreLogic/Cotality Trestle; its public RESO WebAPI documentation is known. M6 uses owner-provided approved connection documentation and licensed access. Confirm capabilities, field/display/retention/media/cache/alert/AI rights and current MLS rules before enabling the live feed. Unknown rights deny the action.
- Live adapters reject synthetic records. Search, detail, map, cache and alert workers recheck display policy and expiry; withdrawing a listing invalidates all derived surfaces.
- Sending checks current consent, suppression, recipient/archive state, quiet hours, entitlement and provider readiness. Unknown delivery acceptance enters reconciliation; do not blindly resend. Do not send real campaigns from tests.

## Mobile web application
- Deliver the full web application as an installable PWA for iPhone and Android without any app-store release. Implement MOD-K and all mobile workflow acceptance criteria; no desktop-only critical paths.
- Cache only safe static assets and a generic offline shell. Never persist private API, personalized HTML/RSC, CRM, billing, AI or MLS data in service-worker/IndexedDB storage. Offline mutations are disabled initially.
- Protect dirty drafts during service-worker updates; reconcile interrupted commands with idempotency. Validate physical iPhone/Android browser and installed modes at M8.
- Web Push is opt-in and generic; device subscriptions are encrypted, member-scoped and revoked with access. Business scheduling stays server-side.

## CMS, AI and UI
- Render only registered, versioned content blocks. Sanitize rich text, restrict links/media origins and keep executable code out of tenant content. Publish and rollback are explicit versioned commands.
- AI drafts require scoped facts, licensed use, strict output validation, evaluation evidence and human acceptance. Acceptance saves a draft; never autonomously publish, message contacts, change consent, bill or decide housing/credit eligibility.
- Implement shared design tokens and components. Target WCAG 2.2 AA, keyboard access, visible focus, accessible authentication, clear errors, reduced motion and responsive 360px layouts. Paste and password managers must work.
- Show real pending/succeeded/failed states. Unknown/stale/unavailable metrics cannot be shown as zero or as completed work.

## Verification and handoff
- Use the approved runtime pins and pnpm lockfile. Integration owner updates root dependencies. Run formatting/lint, TypeScript checks, contract validation and relevant tests.
- Tests must prove behavior: tenant and own/team scope, revoked access, race conditions, idempotency, provider failures, and the module acceptance criteria. Use PostgreSQL/PostGIS with real RLS roles for isolation tests, not mocked repositories alone.
- Unit: Vitest; API: integration tests against disposable databases; UI: Testing Library; E2E: Playwright through the approved test harness; accessibility: axe plus manual keyboard checks; load: k6 synthetic datasets. Tool choice can change only through an ADR.
- A PR states concrete behavior, requirement IDs, contracts/migrations affected, tests/results, operational risks and rollout notes. Do not claim runtime validation for generated specifications or unexecuted tests.
- Definition of done: owning module acceptance criteria pass; generated files are current; scope/security tests pass; UI states/accessibility reviewed; provider and recovery behavior covered; docs/runbook updated; required owners approve. Production release also requires the M8 gate.
`;

export const comparisonChoices=[
 ['Improve','MOD-A','M1','Unified OIDC session, verified membership and accessible authentication.'],
 ['Redesign','MOD-B','M2','Prioritize actionable leads, tasks and truthful freshness over upsell cards.'],
 ['Remove','MOD-B','M2','Replace unverifiable hours-saved narratives with defined operational metrics; defer ROI estimates until measured.'],
 ['Redesign','MOD-B','M1','One consistent workspace shell and contextual support.'],
 ['Match','MOD-A','M2','Verified identity-owned email and versioned profile editing.'],
 ['Improve','MOD-A','M2','Canonical brokerage/business identity reused by sites and local visibility.'],
 ['Redesign','MOD-A','M1','Unified owner/manager/agent/editor/billing/analyst roles across products.'],
 ['Improve','MOD-A','M1','Explicit permission scopes, delegation limits and last-owner race protection.'],
 ['Improve','MOD-A','M2','Queryable redacted audit history with attributable commands and exports.'],
 ['Improve','MOD-A','M2','Clear annual total, monthly equivalent and current entitlement state.'],
 ['Improve','MOD-A','M2','Versioned financial previews and asynchronous reconciled lifecycle.'],
 ['Match','MOD-A','M2','Hosted payment method management and safely authorized invoice links.'],
 ['Redesign','MOD-C','M3','Native CMS workspace and public site preview with atomic publishing.'],
 ['Improve','MOD-C','M3','Ownership verification and managed TLS rather than unrestricted DNS editing.'],
 ['Redesign','MOD-F','M5','Native property/CRM experience sharing identity and provider capabilities.'],
 ['Improve','MOD-B','M2','Scoped queue and pipeline insight with documented metric definitions.'],
 ['Improve','MOD-D','M2','URL-driven views, quick search and accessible responsive lead drawer.'],
 ['Improve','MOD-D','M2','Reusable scoped filters and persisted user display preferences.'],
 ['Improve','MOD-D','M2','CSV preview, dedupe review, durable commits and formula-safe exports.'],
 ['Improve','MOD-D','M2','Contact/lead/deal separation with configurable stages and optimistic updates.'],
 ['Improve','MOD-D','M2','Unified chronological history with consent-aware communication metadata.'],
 ['Redesign','MOD-F','M5','Site-bound visitor organizer and clear subscription/consent distinction.'],
 ['Improve','MOD-D','M2','Tasks with timezones, owners, due state and agenda integration.'],
 ['Redesign','MOD-F','M5','Reusable criteria-based market sections backed by the approved adapter.'],
 ['Improve','MOD-C','M3/M5','Versioned property block settings with capability-aware controls.'],
 ['Improve','MOD-F','M5/M6','Preserve source status and enforce feed-specific display rights.'],
 ['Improve','MOD-G','M7','Versioned metrics, freshness and deduplicated provider receipt accounting.'],
 ['Improve','MOD-G','M7','Scoped property/lead engagement reports with meaningful denominators.'],
 ['Redesign','MOD-F','M5/M6','Native replication/live-query or licensed embed according to actual rights.'],
 ['Redesign','MOD-C','M3','Design tokens and registered property blocks replace fragmented theme controls.'],
 ['Redesign','MOD-F','M6','Explicit feed capability, approved policy and health setup.'],
 ['Improve','MOD-J','M2/M4','Distinguish available, connected, degraded and unavailable connectors.'],
 ['Improve','MOD-E','M4/M5','Verified sender/recipient readiness and current consent at alert dispatch.'],
 ['Improve','MOD-F','M5','Central typed criteria and predictable default search behavior.'],
 ['Match','MOD-F','M5/M6','Provider-normalized types/locations with unsupported filters disabled.'],
 ['Match','MOD-F','M5/M6','Accessible list/map views; open houses only when supported and licensed.'],
 ['Improve','MOD-C','M3/M5','Featured listing references resolved through current display policy.'],
 ['Redesign','MOD-F','M5','Clear details and attribution; schools/Walk Score deferred pending rights/provider.'],
 ['Defer','MOD-F','Later','Optional illustrative calculator with owner-approved assumptions; not a core launch dependency.'],
 ['Improve','MOD-C','M3','Minimal capture friction, published schemas and granular consent.'],
 ['Redesign','MOD-F','M5','One responsive website/property UX rather than separate mobile settings.'],
 ['Redesign','MOD-A','M2','Native office/member directory using common tenant roles.'],
 ['Improve','MOD-D','M2','Preserve useful routing precedence with eligibility, fallback and race safety.'],
 ['Improve','MOD-E','M4','Audience preview, suppression, consent and explicit confirmation.'],
 ['Improve','MOD-E','M4','Reusable campaign templates and immutable published versions.'],
 ['Improve','MOD-E','M4','Version-pinned enrollments, bounded workflows and reliable cancellation.'],
 ['Improve','MOD-E','M4','Editor adapter, accessible text alternatives and sender-readiness checks.'],
 ['Improve','MOD-E','M4','Typed event triggers and deterministic once/restart/inactivity rules.'],
 ['Match','MOD-E','M4','Reusable sender/greeting defaults with verified domain identity.'],
 ['Improve','MOD-E','M4','Visible SMS verification state and no sending before readiness/consent.'],
 ['Improve','MOD-I','M7','Separate directory coverage from actual search and AI-answer metrics.'],
 ['Redesign','MOD-I','M7','Sync approved canonical profile revisions through an explicit job.'],
 ['Match','MOD-I','M7','Licensed media/social attributes with validated provider mapping.'],
 ['Defer','MOD-I','Later','Competitor/rank-tracker products require procurement and a defined measurement method.'],
 ['Defer','MOD-I','Later','Advanced premium workflow was not inspected; validate demand before implementing.'],
 ['Defer','MOD-C','Later','Advanced print/design studio requires verified scope and licensing; basic website/email templates launch first.'],
 ['Improve','MOD-J','M2','Contextual support tickets with safe diagnostics and status.'],
 ['Redesign','MOD-A','M2','Capability-based plan comparison and transparent previews; do not replicate every upsell.'],
 ['Redesign','MOD-C','M3','One native builder/dashboard rather than a second WordPress administration shell.'],
 ['Improve','MOD-G','M7','Measured traffic/performance reports with explicit source and collection coverage.'],
 ['Improve','MOD-C','M3','Versioned pages/blog/SEO, sitemap and canonical controls.'],
 ['Redesign','MOD-C','M3','Registered blocks, migration paths, revision preview and recoverable unknown blocks.'],
 ['Improve','MOD-C','M3/M5','Dynamic approved listing references and reusable community content.'],
 ['Match','MOD-C','M3','Agent/team/testimonial/resource content through registered blocks and document kinds.'],
 ['Improve','MOD-C','M3','Tenant media isolation, scanning and reproducible derivative generation.'],
 ['Redesign','MOD-C','M3','Responsive navigation blocks and consistent site settings.'],
 ['Improve','MOD-C','M3','Native conversion blocks with experiment/attribution hooks and accessible behavior.'],
 ['Redesign','MOD-C','M3','Native versioned lead forms; payments/file-upload fields deferred.'],
 ['Improve','MOD-C','M3','Explicit confirmations, consent evidence, suppression and retention controls.'],
 ['Redesign','MOD-B','M2','Task-oriented onboarding and contextual help; cosmetic achievement scoring deferred.'],
 ['Improve','MOD-F','M5/M6','Clear sample/live state, responsive search and verified visitor organizer.'],
 ['Redesign','MOD-B','M2/M3','Accessible base UI and optional scheduling adapter; overlays do not replace accessibility.']
];

function colorLuminance(hex){const a=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722;}
export const contrastPairs=[['Body','ink','surface'],['Secondary text','muted','surface'],['Primary button','primaryText','primary'],['Navigation','navText','nav'],['Error','danger','dangerSurface'],['Warning','warning','warningSurface'],['Success','positive','positiveSurface']].map(([name,fg,bg])=>({name,foreground:tokens.color[fg],background:tokens.color[bg],ratio:+((Math.max(colorLuminance(tokens.color[fg]),colorLuminance(tokens.color[bg]))+.05)/(Math.min(colorLuminance(tokens.color[fg]),colorLuminance(tokens.color[bg]))+.05)).toFixed(2)}));

export async function buildSupplements(audit){
 for(const d of ['contracts','data','design-system','fixtures','future-repo','reference'])await fs.mkdir(path.join(out,d),{recursive:true});
 const write=(p,value)=>fs.writeFile(path.join(out,p),typeof value==='string'?value:JSON.stringify(value,null,2));
 const permissionCodes=[...new Set(operations.map(x=>x.permission))].sort();
 const guards=['published.site','challenge','signature_verified','authenticated','verified.email','unsubscribe_token'];
 const memberCodes=permissionCodes.filter(c=>!c.startsWith('platform.')&&!c.startsWith('visitor.')&&!guards.includes(c));
 const common=c=>c.startsWith('self.')||['dashboard.read','jobs.read','support.read','support.write','org.read'].includes(c);
 const preset=(name,select,scope)=>({name,permissions:memberCodes.filter(select).map(code=>({code,scope:code.startsWith('self.')?'own':code.startsWith('crm.')||code==='reports.read'||code==='data.export'?scope:'organization'}))});
 await write('contracts/role-presets.json',{version:'1.0.0',status:'Proposed explicit built-in grants; every request also checks row/resource purpose, membership and entitlement',presets:[preset('Owner',()=>true,'organization'),preset('Organization manager',c=>common(c)||c.startsWith('crm.')||['members.read','members.manage','offices.read','offices.write','profiles.read','reports.read','appointments.read'].includes(c),'organization'),preset('Agent',c=>common(c)||/^crm\.(contacts|leads|tasks|deals|tags)\.(read|write)$/.test(c)||['crm.sources.read','crm.pipeline.read','sites.read','content.read','appointments.read','reports.read'].includes(c),'own'),preset('Marketing editor',c=>common(c)||['sites.read','content.read','content.write','media.read','media.write','forms.read','forms.write','campaigns.read','campaigns.write','automations.read','automations.write','profiles.read'].includes(c),'organization'),preset('Billing administrator',c=>common(c)||['billing.read','billing.manage'].includes(c),'own'),preset('Read-only analyst',c=>common(c)||['reports.read'].includes(c),'organization')],notes:['Job read is restricted to permitted domain/purpose or requesting member, never all organization jobs just because a code exists.','Manager cannot change owner roles, billing or staff grants. Delegation is the intersection of caller rights and scope.','Team scope is a custom approved office-based grant; agent defaults remain own.','Owner can delegate ordinary codes but not staff/guard capabilities. Publish/send/export remain explicit actions.','Self capabilities are own only. Public visitor and platform staff use separate policy contexts.']});
 await write('contracts/permission-catalog.json',{version:'1.0.0',status:'Proposed; role preset mapping is normative in TDD',codes:permissionCodes.map(code=>({code,boundary:code.startsWith('platform.')?'staff':code.startsWith('visitor.')?'visitor':guards.includes(code)?'guard':'member',scopes:code.startsWith('self.')||code==='visitor.own'?['own']:code.startsWith('crm.')||code==='reports.read'?['own','team','organization']:['organization'],delegatable:!code.startsWith('platform.')&&!guards.includes(code)}))});
 await write('contracts/mls-adapter.ts',mlsInterface);
 const eventTypes=['lead.captured','lead.assigned','lead.stage_changed','contact.archived','task.due','site.published','form.submitted','campaign.enrolled','campaign.cancelled','delivery.receipt','consent.changed','listing.changed','listing.withdrawn','subscription.reconciled','integration.state_changed','ai.draft_ready'];
 await write('contracts/events.schema.json',{$schema:'https://json-schema.org/draft/2020-12/schema',$id:'https://platform.example/schemas/event-envelope-v1.json',title:'Internal event envelope v1 — proposed design',type:'object',additionalProperties:false,required:['eventId','type','version','tenantId','occurredAt','ingestedAt','producer','aggregateType','aggregateId','correlationId','payload'],properties:{eventId:{type:'string',format:'uuid'},type:{enum:eventTypes},version:{const:1},tenantId:{type:'string',format:'uuid'},occurredAt:{type:'string',format:'date-time'},ingestedAt:{type:'string',format:'date-time'},producer:{type:'string',maxLength:80},aggregateType:{type:'string',maxLength:80},aggregateId:{type:'string',format:'uuid'},correlationId:{type:'string',maxLength:80},causationId:{type:['string','null'],format:'uuid'},payload:{$ref:'#/$defs/Payload'}},$defs:{Payload:{type:'object',additionalProperties:false,required:['resourceId','resourceVersion'],properties:{resourceId:{type:'string',format:'uuid'},resourceVersion:{type:'integer',minimum:1},relatedResourceIds:{type:'array',maxItems:20,items:{type:'string',format:'uuid'}},safeCode:{type:'string',maxLength:100},sourceEventId:{type:'string',maxLength:255}}}},description:'Events carry references and safe codes, not raw CRM messages, secrets or unrestricted provider data. Consumers reload scoped authorized data. Event-type-specific rules and producer/consumer ownership are specified in TDD.'});
 await write('design-system/tokens.json',tokens);
 await write('design-system/tokens.css',`:root {\n${Object.entries(tokens.color).map(([k,v])=>`  --color-${k.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}: ${v};`).join('\n')}\n  --font-sans: ${tokens.font.sans};\n  --font-mono: ${tokens.font.mono};\n  --radius-control: 8px;\n  --radius-card: 12px;\n  --sidebar-width: 240px;\n  --header-height: 64px;\n}\n@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }\n/* Bind these values through Tailwind v4 @theme in the implementation. */\n`);
 await write('future-repo/AGENTS.md',agentRules);
 const fictitious=['Juniper Sample House','Mesa Example Loft','Canyon Demo Residence','Desert Fiction Villa','Sunrise Sample Condo','Pioneer Example Home','Acacia Demo Retreat','Valley Fiction Townhome','Solstice Sample Duplex','Orchard Example House','Sage Demo Residence','Vista Fiction Condo'];
 const scenarios=['active','active','pending','closed','off_market','unknown','active','active','active','active','active','active'];
 const listings=fictitious.map((name,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,sourceListingKey:`SYNTHETIC-VEGAS-${String(i+1).padStart(3,'0')}`,name,address:i===8?null:`${100+i} Example Only Lane — fictional address`,coordinates:i===8?null:[-115.15+(i%4)*.02,36.12+Math.floor(i/4)*.02],status:scenarios[i],sourceStatus:`Mock ${scenarios[i]}`,listPrice:350000+i*45000,bedrooms:2+i%4,bathrooms:2+(i%3)*.5,area:{value:1200+i*175,unit:'sqft'},displayAllowed:![4,5].includes(i),addressAllowed:i!==8,synthetic:true,publicRemarks:`SYNTHETIC SAMPLE: ${name}. Fictional demonstration record; not a real property or offer.`,attribution:{brokerage:'Fictional Sample Brokerage',agent:'Sample Agent',disclaimer:'Synthetic demonstration data. Not an MLS listing.'},sourceModifiedAt:'2026-10-10T00:00:00Z',ingestedAt:'2026-10-10T00:01:00Z',expiresAt:i===9?'2026-10-09T00:00:00Z':'2026-10-11T00:01:00Z',fixtureCase:['normal','map_bounds','pending_policy','closed_policy','withdrawn','unmapped_status','price_change','missing_media','hidden_address_and_location','expired','duplicate_change','alert_candidate'][i],media:[]}));
 await write('fixtures/synthetic-listings.json',{synthetic:true,banner:'SYNTHETIC SAMPLE DATA — not actual MLS listings',mode:'mock',clock:'2026-10-10T00:01:00Z',instructions:'Tests freeze this clock. Sample prices and coordinates are invented. No customer/property imagery. Show a sample banner in search, detail, map and alert previews. Policies deliberately include denied/expired/unmapped cases. Do not ingest this file into a live feed.',listings});
 let er='erDiagram\n';
 for(const t of tables){er+=`  ${t.name} {\n${t.columns.map(c=>`    ${c.type.replace(/[^a-zA-Z0-9_]/g,'_')} ${c.name}${c.name==='id'?' PK':c.name==='tenant_id'?' FK':''}`).join('\n')}\n  }\n`;for(const f of t.foreign)er+=`  ${f.target} ||--o{ ${t.name} : "${f.column}"\n`;}
 er+='  content_document ||--o{ content_revision : "document_id; published pointer stays in document"\n';
 await write('data/schema.mmd',er);
 await write('reference/source-audit.json',audit);
 try {await fs.copyFile(path.join(out,'../Agent-Elite-Audit-2026-10-10.zip'),path.join(out,'reference/Agent-Elite-Audit-2026-10-10.zip'));} catch(error) {if(error.code!=='ENOENT')throw error;await fs.access(path.join(out,'reference/Agent-Elite-Audit-2026-10-10.zip'));}
  // The manifest is a specification example; icon assets are an implementation deliverable.
  await write('contracts/pwa-manifest.example.json',{id:'/workspace',name:'Real Estate Workspace',short_name:'Workspace',description:'Independent real estate SaaS web application',start_url:'/dashboard',scope:'/',display:'standalone',background_color:tokens.color.canvas,theme_color:tokens.color.nav,icons:[{src:'/icons/app-192.png',sizes:'192x192',type:'image/png',purpose:'any'},{src:'/icons/app-512.png',sizes:'512x512',type:'image/png',purpose:'any'},{src:'/icons/app-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}]});
  await write('contracts/pwa-policy.json',{version:'1.0.0',status:'Design policy, not an implemented service worker',distribution:'HTTPS browser and home-screen install only; no app stores',staticAllowlist:['hashed JS/CSS without embedded private data','approved local fonts','original app icons','generic offline screen'],neverPersist:['session/auth tokens','private API responses','personalized HTML or RSC','CRM contacts/messages','billing data','exports','AI results','MLS records/media unless separately licensed and approved'],initialOfflineWrites:false,updates:'waiting worker; user acceptance after dirty drafts and in-flight sensitive commands resolve',push:'opt-in, generic payload, member/device authorization; in-app inbox authoritative'});

 return {permissionCodes:permissionCodes.length,eventTypes:eventTypes.length,fixtures:listings.length};
}
