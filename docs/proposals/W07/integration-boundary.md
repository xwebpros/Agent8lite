# W07 stable exports and shared integration review

Helper checkpoint: `ff5e8a16430d088657e6490ded5c82294f10aff8`. Proposal-first checkpoint: `66f6db2`.

The helpers and 102 new tests are working source code. They are not registered API/UI functionality. The coordinator owns runtime authorization, shared SQL/seed, existing routers/shell and root verification discovery. This review packet supplements `native-mock-search.md` with closed proposal schemas and exact unnumbered SQL; 0012 remains reserved for MOD-A.

## Existing capability rule found in foundation source

`packages/auth/entitlements.ts` already maps `mls.read` to feature `mls`. Propose using `requireEntitlement(client, "mls.read")`, including the existing SHARE lock/current effective-until check. The current seed only enables CRM/billing, so MLS synthetic seed activation must be an explicit coordinator change. `mls.read` organization scope is the sole listing read grant; feed administration is separate. No own/team widening.

## Closed local route additions for ADR-011 review

- `GET /dev/orgs/:orgId/mls/listings`: `local-read.schema.json` SearchPath/SearchQuery; filter JSON additionally validates frozen ListingCriteria. Return frozen PageListing after response validation.
- `GET /dev/orgs/:orgId/mls/listings/:listingId`: DetailPath/empty DetailQuery; return frozen Listing or generic 404. Reject request bodies on both routes.

Use the existing `syntheticEnabled`, `readSession`, `localAccess`, rate limiter, `withTenantTransaction` and response Problem handling in `apps/api/src/main.ts`. Deny production/disabled configuration before DB work. Compare parsed orgId to active verified session. Obtain context exclusively through the tenant transaction. Calls into owned service should receive PoolClient/context/signing key, not raw session or request authorization fields. Convert `MlsReadError` to the existing `AccessError` boundary, preserving only safe status/code/message. No header, policy, source key or listing payload enters logs.

`parseNativeListingQuery` is a closed parser for Express query strings and rejects arrays, unknown keys, coercion and oversized filter/cursor. `requireListingRead` checks the verified context's organization grant. `searchNativeMockListings` and `getNativeMockListing` receive a current transaction snapshot. `projectNativeMockListing` checks both persisted policy representations independently. Details cannot reuse a prior list item.

## Repository mapping and lock proposal

Before snapshot reads, acquire current tenant mock feed rows and their `integration_connection` rows with SHARE locks, and current listing rows with SHARE locks; keep these through projection and transaction commit. Read the database clock once with `clock_timestamp()`. Recompute expiry against this clock after lock acquisition. Current membership/role/organization locks come from `withTenantTransaction`; capability locks come from existing `requireEntitlement`. Locked rows prevent concurrent withdrawal or rights revocation from completing before the authorized read commits. A future production implementation needs reviewed generation/index paging to avoid broad locks.

The source must be the seeded `integration_connection.provider='trestle'`, connection/feed mode=`mock`, feed transport=`mock`, and `safe_config.synthetic=true`; no secret_ref use. Existing connection state is `mock`. Only that explicitly synthetic verified source maps to the adapter code `mock-synthetic`. Any unknown connection/feed state/configuration denies. Feed row policy approval timestamp and both policy JSONs must be valid/current. Existing mock records can be seeded using the provider's `readChanges`, retaining native identity via source-key uniqueness. No adapter network behavior or current provider file edit is required.

Storage mapping proposal: listing.address is exactly `{ "displayAddress": <string|null> }`; geography maps ST_X/ST_Y; brokerage_attribution stores closed `{ brokerage, agent, disclaimer }`; ingested_at is the canonical actual ingest timestamp; other canonical fields map directly to the existing columns. Source synthetic id is stored in source_listing_id and gated independently from mandatory native id. Nullable new ingested_at/native_rights deny reads until explicit synthetic seed. A read repository must not substitute created_at/updated_at for ingestion or infer rights from ready state.

Read all tenant feeds (at most 20) and source listings (at most 500) for this bounded slice; query cap+1 and reject oversize. Do not prefilter on hidden fields or silently omit unrelated source rows from cursor generation. Rights and source revisions/content bind cursors; withdrawal updates cannot resurrect through old pages. Snapshot generation currently fingerprints all rows/rights in process, adequate only for bounded synthetic data.

## Coordinator patch requests

1. Approve the proposed read migration/native rights storage (unnumbered SQL provided), seed mapping, and existing `mls` capability requirement.
2. Register reviewed local routes via the current guard/transaction/error stack after owned API exports are supplied.
3. Include `tests/mls/**/*.test.ts` in root Vitest config, `tests/mls/**/*.ts` in root tsconfig and `packages/mls`, `apps/api/src/mls`, `apps/web/features/properties` in lint/format paths. Isolated runner must pass the owned config/discover new tests until root config is updated.
4. Register a synthetic-only Properties shell view after the API boundary is approved and the owned responsive feature is supplied; clear tenant/access generations exactly as existing workspace children do.

No public route, inquiry, organizer, alert/AI/media rights, tile server, browser workaround, live transport, merge or push is included. Actual DB/API/UI acceptance remains pending approved implementation and disposable verification. M5 remains pending.
