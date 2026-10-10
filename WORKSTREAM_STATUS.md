# W05 native CMS drafts — 2026-10-10

Branch: feat/W05-native-cms-drafts. Base: 38c42a5c5305c3092fdbb9b95fd080745e443111. Worktree: C:/Users/Monar/.codex/worktrees/2e5a/Agent8lite.

Requirements: bounded MOD-C-001/002/003/004 preparation. M3 incomplete; public publish/rollback, domains/TLS, media, forms, navigation and MLS blocks gated.

Completed inspection: root/nested AGENTS.md, TDD JSON/HTML, frozen OpenAPI/generated types, migrations 0001–0011, ADR-012, registry/catalog and IMPLEMENTATION_STATUS.md. Concrete service-port/runtime-grant proposal: docs/proposals/W05/native-draft-boundary.md and native-draft-grants.proposed.sql. No shared files edited and no DB/API/browser started.

Proposal checkpoint: 84a6bb8 (docs(cms): propose bounded native draft service boundary). Coordinator confirmed migration 0012 is reserved for MOD-A; CMS proposal intentionally has no final sequence number. Shared boundary review remains pending.

Implemented helpers: packages/cms exports prepareDraft/recoverDraft, deterministic content hashes, documentEtag/requireDraftVersion/planDraftAppend and exact repository template resolution/starters. New saves accept only registered v1 blocks under trusted link policy. Unknown/older JSON is detached and preserved for recovery, but cannot save/render/publish. Native append plans use existing revision columns, expected→next document version and frozen Revision responses; they perform no I/O, permission checks or implicit publication. No runtime CMS route/persistence is activated yet.

Executed setup: Node 24.19.0, pnpm 11.25.0; pnpm install --offline --frozen-lockfile passed from the existing local store, with no dependency or lockfile change. Coordinator subsequently requested no further dependency installs/changes.

Executed verification: pnpm exec vitest run packages/cms packages/templates — 56/56 passed across three files (33 new CMS cases + 23 existing template/registry cases); pnpm exec tsc --noEmit -p packages/cms/tsconfig.json passed; pnpm exec biome check packages/cms --diagnostic-level=error passed. Initial tests/cms invocation selected only the existing 23 tests because shared Vitest config excludes that directory; tests were moved into owned packages/cms so the normal unit/regression runner now discovers them. No DB/API/browser checks were run. Latest coordinator-reported baseline is 256/256; this is separate evidence and was not rerun here.

Blocking shared decisions: saveRevision has no optimistic precondition in frozen contract; Revision lacks a document version for replay ETag. Coordinator must review the local development route/header and durable replay metadata, migration grants/immutability, profile/entitlement read port and API wiring before runtime activation. Helpers can proceed independently.

Next steps: checkpoint reviewed helper exports, run root source TypeScript/frozen contract verification, and implement activated native persistence/routes only when approved shared boundaries arrive. Existing frontend owner/coordinator will integrate navigation/BFF/router/dependencies after stable exports are reviewed. No new dependency is needed for the helper slice. Do not send messages to other chats, merge or push.
