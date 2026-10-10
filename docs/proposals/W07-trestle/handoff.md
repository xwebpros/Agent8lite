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

Next coordinator step: review this additive server seam before integration. Supply a trusted, current database-backed authorization resolver and server secret manager binding. Complete M6 field/display/attribution/freshness acceptance before any Property request or application registration. Storage, durable replication, deletion reconciliation, media, alerts, AI and production readiness are not implemented or claimed. Do not use the native mock repository for live data or cache MLS responses in the PWA.
