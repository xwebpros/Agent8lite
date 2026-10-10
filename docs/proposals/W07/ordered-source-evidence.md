# W07 ordered synthetic source integration evidence

Implemented the bounded ADR-025 prerequisite after cherry-picking coordinator commit `6b3599f` (local `86baa82`). Only the new source module, fixed manifest, targeted pure suite and this evidence document belong to the implementation commit. Existing indexes, adapters, replication helper, dependencies and runtime registration are unchanged.

Direct server-only imports from `packages/mls/ordered-source.ts`:

- `createOrderedMockSource(context)` implements the approved `OrderedMockSourcePort`; no custom manifest, clock, append or generation option exists.
- `isOrderedMockSourceResult(context, input, result)` checks detached own data, closed schema, canonical digest and exact correspondence to the registered source page, including identities, indices, sequence, context, generation, options, cursor and completed watermark. This is content evidence; independent current actor/feed rights and SQL receipt checks remain mandatory.
- `ORDERED_MOCK_SOURCE_PROFILE`, `ORDERED_MOCK_SOURCE_GENERATION`, `ORDERED_MOCK_SOURCE_WATERMARK` and `OrderedMockSourceError` expose fixed source metadata and fixed safe error codes. No existing package index export was added.

`packages/mls/fixtures/ordered-synthetic-v1.json` declares USD pricing, generation `5d753531-7ad1-4bc4-87a2-036cf442f527`, completed watermark `2026-10-10T00:10:00Z` and seven explicitly identified operations with sequences `10,25,60,90,130,210,300`. Fixed `observedAt` selection is independent of tied/null source timestamps. The fixture includes active → pending, known/unknown deletion, off-market and closed operations, conspicuous synthetic attribution, and validated ADR-022 email/phone/null contact shapes. Ingestion and expiry are fixed; no clock renewal occurs.

Each factory retains a detached frozen validated context and a private frozen copy of the registered manifest. Each read reconstructs server-owned page boundaries from that immutable source and original watermark/overlap/limit. It matches opaque tokens without decoding caller offsets. Page/proof outputs are detached and deeply frozen. Proxy, accessor, symbol, nonenumerable, inherited/custom-prototype, sparse/augmented-array, nonfinite and oversized input data fail closed without executing serialization hooks. Proof hashing sorts own object keys, preserves array order and includes page clocks.

Verification on Node `24.19.0`:

- 89/89 targeted tests pass, including exact continuation replay in two separate Node processes, wall-clock changes without freshness renewal, fixed observation overlap, tied/null timestamps, deletion identities, context/options/cursor tampering, detached immutability, hook safety and recomputed-digest tampering.
- 451/451 pure W07/provider tests pass across 12 files using `tests/mls/vitest.config.mts`; database integration suites are excluded. The targeted suite also passed after the test-only TypeScript annotation correction.
- Root TypeScript and scoped `tests/mls/tsconfig.json` pass; Biome checks the three new code/fixture/test files without diagnostics.
- Frozen contract verification passes: 170 operations, 169 schemas, event envelope and exact ADR-022 amendment.

No SQL/role/database writes, servers, browser or live provider requests were used. Actual SQL persistence, initiating-command authorization, durable job claim/fencing, atomic ledger/checkpoint/receipt/outbox writes, invalidation consumers and retention/reconciliation remain the coordinator-reviewed prerequisites described in `replication-persistence.md`. These source tests establish neither those gates nor M5 completion.
