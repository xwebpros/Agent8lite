# W07 bounded native mock listing seam — proposed for shared review

Status: proposal committed before consumers; shared integration approval pending.
Foundation: `38c42a5c5305c3092fdbb9b95fd080745e443111`. Requirements: MOD-F-001/002/003/005/006/008, INV-01/02/11. This is a preparation slice, not M5 completion.

## Scope and route decision

Only the existing `MockMlsAdapter` is a source. “Mock Trestle” describes synthetic preparation for the selected eventual provider; it does not claim RESO transport or licensed Trestle data. Existing provider files remain coordinator-owned. No remote fetch, credentials, property photos, licensed maps, public-site registration, organizer, inquiry, cache, alerts or AI use.

Frozen v1 exposes only public site listing search/detail. M3 site publication and visitor identity prerequisites are missing. Propose authenticated local-only `GET /dev/orgs/:orgId/mls/listings` and `GET /dev/orgs/:orgId/mls/listings/:listingId`, using unchanged generated `PageListing`/`Listing` responses and the frozen search query (`filter`, `limit`, `cursor`, `sort`). Coordinator must approve/register both in the existing synthetic loopback boundary and document ADR-011. They must not be registered under public `/v1/` routes.

Reads use verified sessions and `withTenantTransaction`, recheck active membership/organization, and require organization scope for `mls.read`. The frozen permission catalog permits only organization scope. Tenant request IDs are routing input, not authority. Follow current capability/entitlement conventions once the coordinator supplies the MLS capability decision; no invented entitlement code. All responses are private/no-store and schema-validated. Hidden, withdrawn, expired, unapproved, wrong-tenant and nonexistent detail results share a generic 404. Production/disabled synthetic mode denies before reading.

## Projection and source identity

The owned package accepts a native identity (`tenantId`, durable UUID `id`, UUID `feedId`, nullable `sourceListingId`, currency) plus a canonical synthetic listing, current feed policy, allowed statuses, policy version, and withdrawal state. Storage uniquely binds `(tenant_id, feed_id, source_listing_key)` to the existing durable native ID. Retries never replace that ID. Native IDs, rather than provider keys, appear in the response and cursor tie-breaker.

Projection explicitly constructs generated `Listing`; raw payload/private metadata never spreads into it. Source key/status, flags, policy, hashes and internal ingest metadata remain internal. `displayAddress` maps permitted address, `[longitude,latitude]` maps permitted coordinates, `remarks` maps public remarks, and permitted sqft area maps directly. Sqm is omitted until a unit conversion rule is reviewed. Unknown statuses deny, and mandatory `status` visibility must be granted. Optional disallowed fields become null, including property type and source listing ID. Currency is the stored mock mapping (USD), not inferred from price. Media is always empty; logo URL is null.

Every read requires current policy approval, display=`allowed`, resolved positive max age, allowed current listing status, `displayAllowed`, nonwithdrawn state, valid nonfuture ingest time, and expiry strictly after the read clock. Address suppression also suppresses coordinates; coarse or unknown location rules suppress coordinates until a rounding scheme is approved. Brokerage/agent attribution is separately field-gated; synthetic disclaimer and policy attribution remain visible. A conspicuous SYNTHETIC DEMO DATA prefix is added to every response disclaimer. Synthetic source separation is checked at ingest and projection.

## Search, sorting, pagination and invalidation

Validate against frozen `ListingCriteria`, then apply numeric, type, status, safe substring keyword and bbox filters only to the permitted projection. A forbidden field cannot influence matches or sorting, avoiding hidden-value inference. Use the same function for list and spatial subsets. Bounds follow the existing mock seam: bbox at most 5 degrees in either axis, query at most 200 characters; reject unknown filters and malformed/nonfinite values. Limit 1–100. Sort `updated_desc`, `price_asc`, `price_desc`, null values last, durable UUID ascending for ties.

The signed opaque keyset cursor binds verified tenant/member/role/grants, normalized filter, sort, limit, current policy fingerprint and native source generation. It contains only position/expiry/binding, not listing payload. Changed feed rights, any withdrawal/update or changed membership/filter/sort invalidate pagination. Expiry is bounded to fifteen minutes and the earliest displayed listing expiry. Each new page/detail rereads current rows and rights rather than replaying a cached projection. Bounded first implementation can read at most 500 mock records, project/filter in process and fail unavailable above that limit; it must never silently truncate. Production spatial/index optimization is a later reviewed change.

## Minimal coordinator-owned database and grants proposal

Existing tables already provide native UUIDs, feed source uniqueness, tenant composite FKs, withdrawal, expiry, FORCE RLS and PostGIS. Runtime currently has no listing/feed grants. Proposed forward migration for review (not applied here):

```sql
ALTER TABLE app.mls_feed ADD COLUMN native_rights jsonb;
ALTER TABLE app.listing ADD COLUMN ingested_at timestamptz;
GRANT SELECT ON app.mls_feed, app.listing TO estate_runtime;
```

`display_policy` retains the frozen `DisplayPolicy` shape; `native_rights` holds the server-only port `MlsPolicy` shape to represent tri-state display/replication/cache/media/alert/AI rights and address/location rules that frozen DisplayPolicy lacks. Null/malformed/contradictory native rights deny. Both policies must approve; intersect fields/statuses and take the stricter age/expiry. No permissive backfill. Seed only conspicuously synthetic mock connection/feed/listing rows under migration identity in explicit local/test mode. Runtime slice remains read-only; do not grant sync/writes yet. `ingested_at` records the adapter's actual ingestion timestamp; created/updated timestamps must not silently refresh stale data. Coordinator can instead approve a strict mock-only mapping without schema change, but must explicitly resolve the missing rights/time representation.

Sync/checkpoint ingestion is a separate approved service transaction. Upsert uniqueness retains ID, deletion records withdrawal, and checkpoint advancement must be atomic with the entire page. No worker/cache/alert interfaces or extra grants are introduced in this slice. Later derived surfaces must consume withdrawal and reauthorize independently.

## Review requests and integration patch boundary

1. Approve local routes, organization `mls.read` boundary and capability rule.
2. Approve native rights/ingested-at representation, forward migration/read grants and synthetic seed mapping.
3. Provide existing API router and web shell registration through coordinator-owned changes; W07 owns only `packages/mls/**`, `apps/api/src/mls/**`, `apps/web/features/properties/**`, `tests/mls/**`, and this proposal directory.
4. Root TypeScript include/lint/test batch discovery must include these owned directories (current root tsconfig/test runner omit `tests/mls` and new web feature lint paths).

While review is pending, implement and execute projection/filter/cursor/native-versus-mock equivalence tests in owned files. After boundary approval, add the authenticated repository/service and responsive accessible list/detail feature, validate with a new uniquely named disposable database and ephemeral owned API port. Existing 3000/3001 and shared estate remain untouched. Saved browser Block applies here; no browser/chat/CLI workaround. API/source/database tests can proceed.

M5 remains pending: public search→inquiry→CRM, visitor organizer, no-delivery alerts, sync crash/token/429 suite and browser/device acceptance are outside this slice.
