# W05 native site/document/draft boundary

Status: proposed for coordinator review, 2026-10-10. Base: `38c42a5c5305c3092fdbb9b95fd080745e443111`. This is a bounded MOD-C-001/002/003/004 preparation slice; M3 remains incomplete.

## Requirements and prerequisites inspected

The normative `docs/tdd/technical-design.json` and companion HTML agree: platform-owned versioned documents/templates, immutable revisions, optimistic document versions, and recoverable unsupported content are required. M3 also requires M2 capture/CRM, M1 mock MLS and media security. The foundation has synthetic capture/CRM, mock MLS, three template families, and hero/text/CTA/footer v1 validators/renderers. Media rights/scan/transforms, Puck, signed preview hosts, publication/rollback, public forms, navigation and domains/TLS remain unfinished. These independent prerequisites do not block strict private draft helpers; they block M3 completion and public activation.

Read sources: root AGENTS.md, nested apps/web/AGENTS.md, frozen OpenAPI/generated types, migrations 0001–0011, ADR-012, template registry/catalog, and IMPLEMENTATION_STATUS.md. The actual native tables are `app.site`, `app.content_document`, `app.content_revision`; no replacement CMS tables are needed. All three already have tenant composite foreign keys and FORCE RLS. The document publication pointer already binds the revision to the same document/tenant.

## Minimal service port

Implement a private CMS service bound to the caller's existing verified `TenantContext` and tenant transaction. It must not open a second transaction or accept tenant/member/profile claims as authorization. Organization-only `sites.read/write` and `content.read/write` follow the permission catalog; forged own/team CMS grants fail closed. Business profiles are read through the approved administration resolver (or an explicitly reviewed SELECT-only lookup), never written by CMS. Entitlement capability must be supplied by the foundation resolver; no capability name is invented here.

Frozen bodies/responses remain generated types: SiteWrite→Site, DocumentWrite→Document, RevisionWrite→Revision, and PageSite/PageDocument/PageRevision/PageTemplate. Propose list/detail/create site; list/detail/create/update document; list/detail/save immutable revision; and template catalog reads. Site starts in `draft`, `published_at` is null, document `published_revision_id` is null. TemplateCode resolves the exact repository-owned current template version, recorded as `<code>@<version>` in `theme_version`; changing an existing site's template/profile is deferred rather than silently replacing tenant revisions. Creating a document does not seed/publish content implicitly: its starter is an explicit RevisionWrite command selected from the catalog.

Draft saving validates a detached JSON copy through the registered v1 block property schemas and trusted approved-origin policy. Save inserts `schema_version`, `block_data`, `seo`, author membership and deterministic SHA-256 content hash; it increments the **document** row_version in the same transaction. No update/delete rights exist on content_revision. A second editor using the old document version gets 412 and retains their draft. Saving an identical body with a new command key is a new revision; only exact idempotency replay returns the existing result. Hashes identify content, not permission or deduplication evidence.

Unknown/older JSON is retained by a separate recovery inspection helper, with issue codes/paths and no HTML execution. Recovery is not permission to write future block kinds through frozen v1. Registered v1 only is accepted for new strict saves. Media/OG assets, unregistered blocks, unsafe HTML/links/CSS, unsupported nesting and duplicate block IDs fail. External HTTPS links require origins from trusted server policy; body or template customizations cannot approve origins. Internal local paths remain relative to the verified site.

Every mutation uses existing CSRF/idempotency conventions and append-only safe audit metadata in its transaction. Replay rechecks active membership, current write permission, entitlement and current site/document state before returning historical success. Do not include block text/SEO/provider payloads in audits or errors. Private reads and responses use no-store. Pagination uses existing signed tenant/member/permission/resource-bound cursors; revisions order by immutable ID with deterministic tie-breaking. Document metadata versions and draft versions share row_version.

## Frozen saveRevision conflict discrepancy — decision needed

`saveRevision` currently has **no If-Match parameter and no expectedDocumentVersion in RevisionWrite**. Revision has no document version field; Document does. Therefore a concurrency-safe HTTP save cannot be silently implemented from the frozen body alone.

Recommended bounded choice: coordinator approves a local development route under ADR-011, `/dev/orgs/{orgId}/cms/documents/{documentId}/drafts`, using the unchanged RevisionWrite/Revision envelopes plus mandatory If-Match (document version), Idempotency-Key and X-CSRF-Token. Return the new document version in ETag. Frozen v1 saveRevision stays unavailable until the shared contract owner reviews the missing precondition in a contract PR. Alternate choice: explicitly review an additive header correction to frozen v1 and regenerate contracts; W05 will not do that itself. Helpers accept the precondition separately and are useful under either decision.

## Forward migration proposal

`native-draft-grants.proposed.sql` is review material only, outside the migration runner. Minimal runtime-only SELECT/column INSERT/column UPDATE grants use the existing schema. Default new site state to draft; partial INSERT excludes publication fields. Deny updates/deletes to immutable revisions with both grants and a trigger. Do not grant publication-pointer/state updates, worker access, domains, media or forms. Coordinator chooses the next sequence number, reviews existing data before adding the trigger, applies to a uniquely named disposable database, and verifies actual estate_runtime/FORCE-RLS behavior before integration.

## Required shared decisions and tests before activation

1. Approve transaction-bound CMS service port plus business-profile/entitlement read boundary and current template version resolution.
2. Choose the reviewed revision precondition route/header, including ETag semantics and durable idempotent response metadata. Existing idempotency_record stores only response body/status; Revision lacks `version`, so historical ETag must be durably retained. The concrete minimal proposal adds nullable `response_etag` to idempotency_record (existing commands remain compatible), storing the next document ETag alongside the Revision body/status. CMS replay returns that original header only after current authorization checks. Never return the document's later current version for a historical replay. A reviewed revision→document-version mapping is an alternative if preferred by the shared owner.
3. Approve column grants/immutable-history migration and allocate migration sequence; review site update behavior separately.
4. Approve API router/BFF navigation wiring and Puck adapter dependency/version in the shared owner's checkout. This helper slice does not require a new dependency.
5. Execute disposable real-role DB/API acceptance: foreign profile/document/revision denial, missing tenant/pool reuse, revoked membership/capability replay, append-only history, same-slug race, concurrent expected-version saves, transaction rollback (revision/version/audit/idempotency), and no change to publication pointers. Browser/Puck/accessibility acceptance remains subject to the parent's saved localhost Browser Block; no alternate origin/tool bypass is authorized.

## Ownership and rollout

W05 owns packages/cms, apps/api/src/cms, apps/web/features/cms, tests/cms, docs/proposals/W05 and the explicitly requested WORKSTREAM_STATUS.md in this checkout. Shared dependencies/lockfile/frozen contracts/migrations and existing routers/components remain unchanged. Commit this proposal before helper consumers. Integrate only after coordinator review; no push/merge, public activation, live providers or M3-complete claim.

## Helper checkpoint and shared integration notes

`1d79f94` implements packages/cms exports without a new dependency: prepareDraft/recoverDraft, documentEtag/requireDraftVersion/planDraftAppend, resolveSiteTemplate/templateThemeVersion/prepareTemplateDraft. These are pure server helpers, not a browser-safe bundle: content hashing uses node:crypto and the existing registry uses Buffer. Future client editor adapters should consume the generated contracts and their reviewed client adapter rather than importing this server index into a client component. No Next.js router/component changes are included.

Plans map directly to existing native revision columns and specify a conditional document version update. The reviewed repository must reject a failed compare-and-swap before insertion or roll the entire transaction back; a pure plan alone is not a race-safe repository. It must bind author_member_id from verified context, preserve publication fields, and commit audit/idempotency response_etag atomically. Mutable plan objects should not be shared across requests; the repository must validate its current input when executing. The unit tests cover helpers and frozen response compatibility, not actual RLS/transaction enforcement.

The shared Vitest include pattern discovers tests under packages; the 33 new cases therefore live in packages/cms/drafts.test.ts. Targeted helpers + registry/catalog: 56/56 pass. Root source TypeScript and frozen contract verification pass. No dependency/lockfile/shared schema change or DB/API/browser run occurred. Coordinator has reserved 0012 for MOD-A; assign the CMS migration number only during integration review.
