# Synthetic publication preparation integration

ADR-024 and its generated-alias declaration were adopted from coordinator commit `cef643b` as local `b2fde54`. This work owns only the two new preparation source/test files and this evidence document. It implements a pure fixture candidate, with no route registration, persistence, publication authorization or host verification.

## Shared serializer proposal before renderer reuse

Read-only inspection of the coordinator checkout at `6b3599f` confirms that `packages/templates/registry.ts` still reflects on untrusted objects without a native proxy guard, calls `JSON.stringify` on the original input, and parses back into ordinary prototypes. That can execute proxy traps or inherited `toJSON` hooks. Subsequent optional reads (`children`, `action`, `links`, `canonicalPath`, `ogAssetId`) can also consult inherited properties. `packages/cms/drafts.ts` depends on this path. The bounded CMS JSON helper detaches descriptor values but also lacks a proxy guard.

Proposed shared-owner fix: reject proxies with Node's native `types.isProxy` before any reflection; require plain own enumerable data and dense ordinary arrays; clone to null prototypes before serialization; retain that detached representation through validation/rendering; use validators with `ownProperties: true` and own-data optional reads. Preserve the existing canonical revision hash for ordinary valid JSON and add hostile proxy/inherited-hook regression tests before migrating callers. A browser-safe counterpart needs separate review because Node's proxy guard is server-only.

The new server helper implements that safe traversal, uses the frozen OpenAPI and repository block-property schemas with own-property validation, reuses only the existing primitive link predicate and detached template metadata, and renders its own escaped complete document. No existing serializer, registry, browser export, dependency or route is changed. Shared fragment parity is tested only with ordinary fixture inputs.

## Entry point and bounds

Direct import from `packages/cms/publication-preparation.ts`; no barrel registration. Exact value exports are `prepareCmsPublication(input: unknown): PreparedCmsPublicationV1` and `CmsPublicationPreparationError` (safe `code`, generic message, no snapshot). Input validation uses the shared `CmsPublicationPreparationInputV1` generated aliases; output uses the shared declaration unchanged.

The own-data envelope is bounded to 1 MiB, 22,000 nodes and depth 35. Its canonical revision body independently retains 256 KiB, 20,000 nodes and depth 32. Policy accepts at most 50 raw origins, normalizes duplicates into a sorted unique frozen set and hashes `{ code, rendererVersion, approvedLinkOrigins }` as canonical JSON with SHA-256. Exact canonical HTTPS `example.test` origins have bounded DNS labels/hostname; URL-parser failures also yield the defined safe error. Slugs are at most 160 characters, with lowercase alphanumeric segments separated by single hyphens or slashes; first segments `api`, `v1`, `dev`, `staff`, `preview` deny. UUID source matches and duplicate block IDs are case-insensitive.

The helper freezes the output, detached scalar SEO and header projection. It hashes only canonical `{ schemaVersion, blocks, seo }` for stored-content consistency, then hashes the complete UTF-8 HTML separately (1 MiB limit). Document title/kind/route/theme and binding version remain explicit immutable candidate fields. HTML uses the SEO title, escaped text/attributes, canonical URL and explicit index/noindex robots tag; the visible synthetic banner and renderer-owned CSS are fixed. CSP allows only the SHA-256-pinned stylesheet and denies scripts, remote assets, connections, forms and framing. There is no current-session/profile authorization implied by these supplied snapshots.

## Verification

Executed: **236/236** pure cases across the new preparation, existing draft/recovery/history and template registry/catalog suites, including **138** new preparation cases. Coverage includes canonical hash/fragment compatibility for all three repository templates, complete escaped HTML/CSP/SEO, frozen detached output, matching identities and safe successor versions, unsupported content preserved on denial, exact target/policy origins and closed shapes, full 256 KiB UTF-8 body acceptance plus one-byte excess denial, independent escaped-HTML/envelope limits, and hostile/revoked proxies, accessors, array irregularities, inherited JSON/optional-field hooks with zero executions.

CMS TypeScript, two-file Biome and whitespace checks pass. `pnpm contracts:check` passes at 170 operations/169 schemas with frozen contracts intact. No database, browser, provider, host or server calls were used. Publication jobs, current transactional authorization, real-role public reads, browser/device acceptance and live hosting remain coordinator-owned gates. Coordinator integration/full acceptance is still required.
