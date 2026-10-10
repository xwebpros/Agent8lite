# W07 workstream status — 2026-10-10

Branch: `feat/W07-native-mock-search`, from application foundation `38c42a5c5305c3092fdbb9b95fd080745e443111`.
Owned checkout: `C:/Users/Monar/.codex/worktrees/8509/Agent8lite`.

## Prepared and read

Read root and web AGENTS.md, normative TDD JSON and companion HTML MOD-F/W07/M5 sections, frozen generated listing/feed/search contracts, current listing/RLS/runtime grant migrations, tenant transaction/cursor/test isolation conventions, provider port/mock, synthetic fixture behavior and IMPLEMENTATION_STATUS.md. Runtime pins available: Node 24.19.0 and pnpm 11.25.0. No browser automation attempted.

## Proposal and current boundary

Concrete seam and minimal database/grant proposal: `docs/proposals/W07/native-mock-search.md`, initial commit `66f6db2`. Coordinator approved the bounded preparation boundary at `221af81`; exact review and candidate row_version-only SHARE-lock grants are restored into the owned proposal paths and committed before service consumers. See `docs/proposals/W07/coordinator-review.md`. Approval covers org-only `mls.read`, current `mls` capability, synthetic loopback dev list/detail, nullable rights/ingestion storage with strict denial/no backfill. Root retains seed/capability activation, final migration allocation, routers/BFF/shell/discovery. Frozen public API is not registered without M3 prerequisites. Existing provider implementations/shared contracts/root dependencies/migrations/routers remain untouched. Coordinator reserved 0012 for MOD-A; this proposal does not choose a migration number. Latest coordinator baseline is 256/256 tests; this branch does not claim to have rerun that combined suite.

## Implemented owned code

`packages/mls/index.ts` exports generated-contract Listing/PageListing/criteria/sort aliases, `projectNativeMockListing`, `searchNativeMockListings`, `getNativeMockListing`, `normalizeListingCriteria`, `matchesListingCriteria`, `parseNativeListingQuery`, `requireListingRead` and safe `MlsReadError`. Projection intersects frozen DisplayPolicy and closed native rights, checks expiry/age/withdrawal/synthetic tenant/feed provenance, masks optional fields/addresses/coordinates/attribution, and emits no media/raw provider payload. Search operates only on permitted fields with stable native-ID ties. Signed cursors bind current tenant/member/role/grants/filters/sort/limit/source/rights and expire by fifteen minutes or earliest listing validity. Bounded mock snapshots fail above 500 records. Closed query parser rejects repeated/unknown/coerced/oversized parameters.

`tests/mls` derives raw canonical records through the existing mock's replication port; it introduces no second provider or remote requests. Native/mock equivalence covers the permitted numeric/type/status/keyword/spatial definition. Tests explicitly cover the stricter frozen limits and field gating absent from older mock's property-type/source-metadata projection. Owned configs compensate for root test discovery omissions pending coordinator changes.

Helper implementation checkpoint: `ff5e8a16430d088657e6490ded5c82294f10aff8`.
Review packet: `docs/proposals/W07/integration-boundary.md`, unnumbered `proposed-read-migration.sql`, closed `local-read.schema.json` and `native-rights.schema.json`. Existing foundation capability lookup maps `mls.read` to feature `mls`; the approved service uses it and rechecks current-clock expiry after source locks. Seed activation in the product checkout remains root-owned; test-only MLS capability activation occurs only in disposable databases.

## Executed verification

Approved backend checkpoint: `7e0f6aa5d8ad5da08ee8b194393b9b63e6a8803e`; approved boundary recorded before consumers at `6361186`. `apps/api/src/mls/index.ts` exports `tryNativeMockRead`, `NativeMockReadService`, `NativeMockListingRepository`. Exact shared patch/source mapping: `docs/proposals/W07/backend-export-contract.md`. The service rechecks existing MLS entitlement and org-only permission; current source locks precede DB clock; current raw metadata generation invalidates cursors. No business write or session bypass. Coordinator found the capability time-expiry edge at this checkpoint; it is fixed in the next commit with a post-source-lock current-clock check and blocked list/detail regression. Shared entitlement predicate remains root-owned.

Responsive feature implemented under `apps/web/features/properties`; stable export `PropertiesFeature` accepts frozen session, online/synthetic gates, accessRevision and optional onAccessRevoked callback. It provides labelled filters/bounds, stable list/detail, fresh detail reads, escaped text, synthetic/attribution/freshness/null-field states, abort/generation/private render guards, expiry clearing and periodic/focus refresh. No photos/tiles/storage/offline private cache. Exact shell/BFF/type/build patch requirements: `docs/proposals/W07/feature-integration.md`. Registration remains root-owned/unperformed here.

`node tests/mls/run-isolated.mjs` final complete run: repository 10/10 and HTTP 7/7 PASS in fresh separate disposable databases on 0001–0011 plus approved candidate. Actual role/RLS, source/capability lock races/expiry while blocked (list and detail), denied business writes, source/rights/capability/membership current-state denial, cursor withdrawal/invalidation and authenticated HTTP/no-store/generic 404 boundaries verified. Initial failures were test-only duplicate role names and a nonnested inquiry path expectation, corrected without relaxing product behavior. All created DBs/private directories/ephemeral HTTP listeners removed by the owned runner. No browser used.

Branch/worktree clean before branching; supplied foundation commit exists. Node 24.19.0 / pnpm 11.25.0 match. `pnpm install --frozen-lockfile` passed without shared file changes.

- `pnpm exec tsc --noEmit -p tests/mls/tsconfig.json`: PASS.
- `pnpm exec vitest run --config tests/mls/vitest.config.mts`: PASS, 161/161 across six files (130 W07 pure/static cases + 31 existing provider regressions), no failures/skips. Projection/rights/expiry/withdrawal, safe filters/native equivalence, closed query parser, all three sorts/keyset pages/tampering/revoked grants tested. All proposed schema definitions compile against frozen contracts; persisted rights guard and closed schema agree on valid/invalid cases. Static feature rendering verifies escaped text/synthetic attribution/masked-field alternatives; UI requests validate against frozen criteria.
- `pnpm exec tsc --noEmit -p tsconfig.json` and `pnpm --dir apps/web typecheck`: PASS.
- `pnpm exec biome check apps/api/src/mls apps/web/features/properties packages/mls tests/mls --diagnostic-level=error`: PASS, 29 files, no changes needed.
- `node scripts/check-contracts.mjs --generated`: PASS, 170 operations/169 schemas/event envelope/unchanged frozen copies/current generated types.
- `git diff --check`: PASS.
- No registered product UI/browser/device acceptance claim. Candidate SQL was applied only to disposable DBs; no migration allocation, shared estate reset, existing-port server, credential copy, browser automation, live feed or outbound delivery.

## Next concrete steps

Coordinator reviews/imports final owned service/feature checkpoint and exact integration documents; applies approved seed/capability/migration allocation and API/BFF/shell/discovery changes centrally, then runs integrated source/API/build checks. Source tests use `*.integration.test.ts` and private disposable verification only. M3/M4 prerequisites, public inquiry/organizer/alerts, lifecycle token/429/crash sync acceptance, browser/device QA and M5 completion remain pending. No merge, push or other-chat messages performed.
