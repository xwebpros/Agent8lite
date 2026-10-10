# Trestle scaffold handoff

Branch: `feat/W07-trestle-scaffold`, based on foundation checkpoint `26d80bb`. Proposal `f4baf3d` precedes its implementation. This workstream owns only `packages/providers/mls/trestle/**`, `docs/proposals/W07-trestle/**` and `docs/runbooks/trestle-feed.md`. Other active CMS, mock MLS, backend, frontend and test-owner files are untouched.

The owner requested a Trestle MLS scaffold using two Release v3 guides, reported having a Web API ID/password, and supplied the public RETS reference. The implementation selects RESO Web API and documents RETS as a separate future adapter. The owner entered credentials directly into ignored local configuration and authorized a joint authentication-plus-metadata test. Credentials and tokens were kept out of chat, logs and Git.

Implemented: server-only client-credentials OAuth, private token renewal/rotation, bounded HTTPS/no-redirect requests, safe errors, scoped authorization and revocation guards, licensed source/field projection, active/pending live-query search/detail, opaque bounded cursors, local honest capabilities/health, and a doubly gated authentication-plus-metadata command. A manual approval record is confined to this isolated command. Root dependency files, frozen v1 contracts, database tables/grants, provider selection and existing application routes are unchanged.

Verification on 10 October 2026 with pinned Node 24.19.0:

- 42/42 injected-response tests across two files passed; no network access.
- Strict scoped TypeScript check passed for all eleven new provider TypeScript files.
- Default command executed and returned `TRESTLE_ACCESS_TEST_NOT_ENABLED` without reading configuration or requesting credentials/network.
- Formatting check passed for all eleven provider TypeScript files. Frozen-contract/generated-type validation passed: 170 operations, 169 schemas and the event envelope.
- Owner-authorized live probe succeeded for the approved Las Vegas REALTORS (LVR) / GLVAR IDX Plus WebAPI connection: OAuth authentication and XML `$metadata` retrieval at the account's `api.cotality.com` endpoints. Metadata size was 1,963,523 bytes; SHA-256 was `5bbed57d488d06e21bbb92bbfa63865944f35a34d15063aa40c5febe6652f103`. The probe requested no Property records. No metadata XML, listing data or credentials were saved to the repository, and the application remains on mock MLS data.

Tests cover disabled/pending approval, broker contingency, forged tenant/feed/policy, revocation/changed policy during requests, token encoding/lifetime/concurrency/rotation/expiry, 401/403/429 without blind retries, safe timeout/errors, bounded responses, metadata entities, foreign/synthetic/duplicate records, hidden fields and address flags, freshness, withdrawal reads, unknown numeric/area values, query escaping, forbidden predicates, rechecking projected criteria, continuation origin/scope/progress, opaque cursor binding/expiry and truthful health/capabilities. Probe tests cover both enable gates, placeholders, pending approval and metadata-only diagnostics.

Next operator step: review the authorized Property schema and MLS agreement to confirm licensed source identifiers, fields, display/address/location rules, attribution, freshness and permitted downstream uses. Authentication and metadata endpoints are verified; actual Property query/continuation behavior and licensed display rights remain unverified. Keep secrets out of chat and live listing requests disabled until those gates are satisfied.

Next coordinator step: review this additive server seam before integration. Supply a trusted, current database-backed authorization resolver and server secret manager binding. Complete M6 field/display/attribution/freshness acceptance before application Property requests or provider registration. Storage, durable replication, deletion reconciliation, media delivery/storage, alerts, AI and production readiness are not implemented or claimed. Do not use the native mock repository for live data or cache MLS responses in the PWA.

## Owner-authorized single-listing diagnostic

The owner subsequently requested an isolated test retrieving all information from one listing. Proposal `single-listing-test.md` was committed before implementation. The new doubly gated `listing-test.ts` command uses the existing transport and an explicit ignored local-inspection record. It discovers the authenticated Property schema, applies an approved source-system name filter, requests one active and entirely/address displayable listing, and expands related resources with a 1,000-record bound. It rechecks local authorization across requests, rejects multiple/foreign/synthetic/unsafe records, and follows neither continuations nor image URLs. Raw-record output is confined to ignored local JSON and an escaped, script-free HTML report, separate from the public adapter. It does not establish production policy or grant public display/retention rights.

Verification on 10 October 2026:

- 69/69 injected-response tests across three files passed without network access; this includes the original 42 tests and 27 diagnostic cases.
- Strict scoped TypeScript and Biome checks passed for all sixteen provider TypeScript files. The default listing command returned `TRESTLE_LISTING_TEST_NOT_ENABLED` offline.
- The catalogue extractor read the actual authenticated metadata: 758 Property fields and 14 navigation resources.
- One owner-authorized live GLVAR Property request succeeded. All 758 Property fields were returned; 95 had non-null/non-empty values. Media, ListAgent, ListOffice and CustomProperty each returned one related record, and the other ten collections were empty. No related continuation or collection bound was encountered. No image downloads, database writes or application activation occurred.
- Local output files and credentials remain ignored. No raw listing values, agent/office records, metadata XML, credentials or tokens are published in this branch.

The official 63-page LVRMLS rulebook, updated and Board-approved on 9 September 2026, was subsequently located through page 18 of the approved standard Trestle agreement and saved in ignored `.local/trestle-license-docs/`. Its IDX provisions are in Section 14, pages 36-41. The separate Authorized IDX Display Fields schedule has not been located; executed agreement clauses and a feed-specific accepted policy still require review. Source locations and verification limits are recorded in `license-sources.md`. This review and the coordinator's trusted runtime integration remain M6 gates. The earlier no-Property-request gate remains applicable to application integration; the owner's one-listing authorization covers only the separate local diagnostic.
