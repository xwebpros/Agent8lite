# W05 native CMS drafts — 2026-10-10

Branch: feat/W05-native-cms-drafts. Base: 38c42a5c5305c3092fdbb9b95fd080745e443111. Worktree: C:/Users/Monar/.codex/worktrees/2e5a/Agent8lite.

Requirements: bounded MOD-C-001/002/003/004 preparation. M3 incomplete; public publish/rollback, domains/TLS, media, forms, navigation and MLS blocks gated.

Completed inspection: root/nested AGENTS.md, TDD JSON/HTML, frozen OpenAPI/generated types, migrations 0001–0011, ADR-012, registry/catalog and IMPLEMENTATION_STATUS.md. Concrete service-port/runtime-grant proposal: docs/proposals/W05/native-draft-boundary.md and native-draft-grants.proposed.sql. No shared files edited and no DB/API/browser started.

Executed setup: Node 24.19.0, pnpm 11.25.0; pnpm install --offline --frozen-lockfile passed from the existing local store, with no dependency or lockfile change. Tests not yet run; helper implementation in progress.

Blocking shared decisions: saveRevision has no optimistic precondition in frozen contract; Revision lacks a document version for replay ETag. Coordinator must review the local development route/header and durable replay metadata, migration grants/immutability, profile/entitlement read port and API wiring before runtime activation. Helpers can proceed independently.

Next steps: commit proposal, implement/test strict detached draft helpers, version-conflict planning and template starter integration under owned packages, then record exact verification and commit. Implement activated native persistence/routes only when approved shared boundaries arrive. No new dependency is needed for the helper slice. Do not send messages to other chats, merge or push.
