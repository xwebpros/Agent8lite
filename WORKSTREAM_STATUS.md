# W07 workstream status — 2026-10-10

Branch: `feat/W07-native-mock-search`, from application foundation `38c42a5c5305c3092fdbb9b95fd080745e443111`.
Owned checkout: `C:/Users/Monar/.codex/worktrees/8509/Agent8lite`.

## Prepared and read

Read root and web AGENTS.md, normative TDD JSON and companion HTML MOD-F/W07/M5 sections, frozen generated listing/feed/search contracts, current listing/RLS/runtime grant migrations, tenant transaction/cursor/test isolation conventions, provider port/mock, synthetic fixture behavior and IMPLEMENTATION_STATUS.md. Runtime pins available: Node 24.19.0 and pnpm 11.25.0. No browser automation attempted.

## Proposal and current boundary

Concrete seam and minimal database/grant proposal: `docs/proposals/W07/native-mock-search.md`, initial commit `66f6db2`. Committed before consumers. Coordinator review pending for local authenticated routes, capability rule, rights/time storage, migration/read grants, seed mapping and API/web registration. Frozen public API is not registered without M3 prerequisites. Existing provider implementations/shared contracts/root dependencies/migrations/routers remain untouched. Coordinator reserved 0012 for MOD-A; this proposal does not choose a migration number. Latest coordinator baseline is 256/256 tests; this branch does not claim to have rerun that combined suite.

## Implemented owned code

`packages/mls/index.ts` exports generated-contract Listing/PageListing/criteria/sort aliases, `projectNativeMockListing`, `searchNativeMockListings`, `getNativeMockListing`, `normalizeListingCriteria`, `matchesListingCriteria`, `parseNativeListingQuery`, `requireListingRead` and safe `MlsReadError`. Projection intersects frozen DisplayPolicy and closed native rights, checks expiry/age/withdrawal/synthetic tenant/feed provenance, masks optional fields/addresses/coordinates/attribution, and emits no media/raw provider payload. Search operates only on permitted fields with stable native-ID ties. Signed cursors bind current tenant/member/role/grants/filters/sort/limit/source/rights and expire by fifteen minutes or earliest listing validity. Bounded mock snapshots fail above 500 records. Closed query parser rejects repeated/unknown/coerced/oversized parameters.

`tests/mls` derives raw canonical records through the existing mock's replication port; it introduces no second provider or remote requests. Native/mock equivalence covers the permitted numeric/type/status/keyword/spatial definition. Tests explicitly cover the stricter frozen limits and field gating absent from older mock's property-type/source-metadata projection. Owned configs compensate for root test discovery omissions pending coordinator changes.

## Executed verification

Branch/worktree clean before branching; supplied foundation commit exists. Node 24.19.0 / pnpm 11.25.0 match. `pnpm install --frozen-lockfile` passed without shared file changes.

- `pnpm exec tsc --noEmit -p tests/mls/tsconfig.json`: PASS.
- `pnpm exec vitest run --config tests/mls/vitest.config.mts`: PASS, 133/133 across four files (102 new W07 cases + 31 existing provider regressions), no failures/skips. Projection/rights/expiry/withdrawal, safe filters/native equivalence, closed query parser, all three sorts/keyset pages/tampering/revoked grants tested.
- Owned Biome formatting: PASS after formatting. Contract consistency/full root checks pending final checkpoint.
- No API/DB/browser/UI acceptance claim. No migration, shared estate reset, existing-port server, credential copy, browser automation, live feed or outbound delivery.

## Next concrete steps

Finish source review/contract consistency checks and commit verified helpers/tests. Coordinator can review stable exports and the proposal now. API/UI implementation follows coordinator approval of the shared boundaries, current capability and rights/time representation; all integration verification uses disposable databases/private directories/ephemeral ports. Root Vitest/TypeScript/lint/isolated-batch discovery and existing API/web registration remain coordinator changes. M3/M4 prerequisites, public inquiry/organizer/alerts, lifecycle token/429/crash sync acceptance, browser/device QA and M5 completion remain pending.
