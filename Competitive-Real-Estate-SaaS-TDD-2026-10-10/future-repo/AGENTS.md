# Codex implementation rules — proposed future repository

This is a template for the future implementation repository. The current blueprint is a design artifact, not a deployed product. Copy this file to that repository only when implementation starts.

## Authority and scope
- Read docs/tdd and the owning module specification before coding. The approved TDD, OpenAPI contracts, event schemas, permission catalog and ADRs define behavior. Identify discrepancies in a contract PR; never silently invent provider features or undocumented API shapes.
- Inspect the current tree, branch and applicable nested AGENTS.md files. More specific repository instructions apply to their directory. User instructions take precedence.
- Work only on the assigned workstream and its owned files. Shared contract, database migration, root dependency or design token changes require the named shared owner’s review.

## Worktrees and coordination
- Use one Git worktree and a distinct branch per workstream. Create a branch before submitting changes from a detached worktree. Do not edit another agent’s checkout or run a destructive cleanup against it.
- Branch format: feat/Wxx-short-purpose. Commit a contract/schema proposal before consumers implement it. Keep contract changes additive within v1; use a new event/API version for incompatible behavior.
- Never copy credentials, customer exports or production .env files into worktrees. Use fixture identities, mock providers and a no-delivery communication transport.
- Integration owner merges reviewed PRs in dependency order and owns release tags, migrations and deployment gates. No automatic merge or production deployment merely because local tests pass.

## Platform invariants
- Enforce INV-01 through INV-12. Verify session identity and active membership; never trust request tenant/owner/site identifiers as permission evidence.
- Use packages/db/tenant-transaction.ts to set verified tenant and actor context transaction-locally. Runtime/worker roles are non-owner, NOSUPERUSER and NOBYPASSRLS. Scope own/team/organization in addition to RLS. Test pool reuse and missing context.
- No module directly writes another module’s tables. Use an approved service port for transactional commands or a versioned outbox event for asynchronous work. Preserve tenant context through every boundary.
- Generate API types from packages/contracts/openapi.json; validate request schemas and business rules. Do not introduce a second handwritten client contract. Mutations follow idempotency, CSRF, revision and audit conventions.
- Schema changes use reviewed forward migrations with expand/backfill/contract phases where compatibility matters. Never reset production data. Run migrations under the separate migration identity; never expose it to runtime pods.
- Logs, traces and events must not contain credentials, session tokens, complete provider payloads, contact message bodies or unrestricted personal data. Redact at collection, not only in the UI.

## MLS and communication rules
- Before M6 authorization, implement and test only the mock MLS adapter with conspicuously synthetic data. Do not scrape, obtain restricted data, assume a provider or use production feed credentials.
- The owner-selected provider is CoreLogic/Cotality Trestle; its public RESO WebAPI documentation is known. M6 uses owner-provided approved connection documentation and licensed access. Confirm capabilities, field/display/retention/media/cache/alert/AI rights and current MLS rules before enabling the live feed. Unknown rights deny the action.
- Live adapters reject synthetic records. Search, detail, map, cache and alert workers recheck display policy and expiry; withdrawing a listing invalidates all derived surfaces.
- Sending checks current consent, suppression, recipient/archive state, quiet hours, entitlement and provider readiness. Unknown delivery acceptance enters reconciliation; do not blindly resend. Do not send real campaigns from tests.

## Mobile web application
- Deliver the full web application as an installable PWA for iPhone and Android without any app-store release. Implement MOD-K and all mobile workflow acceptance criteria; no desktop-only critical paths.
- Cache only safe static assets and a generic offline shell. Never persist private API, personalized HTML/RSC, CRM, billing, AI or MLS data in service-worker/IndexedDB storage. Offline mutations are disabled initially.
- Protect dirty drafts during service-worker updates; reconcile interrupted commands with idempotency. Validate physical iPhone/Android browser and installed modes at M8.
- Web Push is opt-in and generic; device subscriptions are encrypted, member-scoped and revoked with access. Business scheduling stays server-side.

## CMS, AI and UI
- Render only registered, versioned content blocks. Sanitize rich text, restrict links/media origins and keep executable code out of tenant content. Publish and rollback are explicit versioned commands.
- AI drafts require scoped facts, licensed use, strict output validation, evaluation evidence and human acceptance. Acceptance saves a draft; never autonomously publish, message contacts, change consent, bill or decide housing/credit eligibility.
- Implement shared design tokens and components. Target WCAG 2.2 AA, keyboard access, visible focus, accessible authentication, clear errors, reduced motion and responsive 360px layouts. Paste and password managers must work.
- Show real pending/succeeded/failed states. Unknown/stale/unavailable metrics cannot be shown as zero or as completed work.

## Verification and handoff
- Use the approved runtime pins and pnpm lockfile. Integration owner updates root dependencies. Run formatting/lint, TypeScript checks, contract validation and relevant tests.
- Tests must prove behavior: tenant and own/team scope, revoked access, race conditions, idempotency, provider failures, and the module acceptance criteria. Use PostgreSQL/PostGIS with real RLS roles for isolation tests, not mocked repositories alone.
- Unit: Vitest; API: integration tests against disposable databases; UI: Testing Library; E2E: Playwright through the approved test harness; accessibility: axe plus manual keyboard checks; load: k6 synthetic datasets. Tool choice can change only through an ADR.
- A PR states concrete behavior, requirement IDs, contracts/migrations affected, tests/results, operational risks and rollout notes. Do not claim runtime validation for generated specifications or unexecuted tests.
- Definition of done: owning module acceptance criteria pass; generated files are current; scope/security tests pass; UI states/accessibility reviewed; provider and recovery behavior covered; docs/runbook updated; required owners approve. Production release also requires the M8 gate.
