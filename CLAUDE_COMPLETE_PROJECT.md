# Complete Agent8lite — autonomous Claude Code handoff

> Maintenance note, 2026-10-13: the owner authorized repository cleanup after this handoff's snapshot. Duplicate audit/TDD packages, root evidence/reports and diagnostic scripts were preserved in `C:/Users/Monar/Agent8lite-archive/cleanup-20261013-015110/preserved/`, with a hash inventory and original-path restore map. The canonical `blueprint/` bundle remains in place. PostgreSQL was stopped at the owner's request, and the original development servers were stopped for cache cleanup. See `docs/runbooks/repository-cleanup.md`; use current Git state and the newest implementation-status evidence for continuation. The dated inventory below is historical.
>
> The owner subsequently requested service restart on 2026-10-13, superseding the earlier ZIP maintenance hold. Consult the newest `IMPLEMENTATION_STATUS.md` entry and current process identity for runtime state.

Prepared on **2026-10-12, Asia/Bangkok** for `C:/Users/Monar/Agent8lite`. Repository snapshot: **`ed38ce2`**, branch **`feat/W01-foundation`**. Reinspect HEAD and the working tree before acting; this document is a dated handoff, not a live progress feed.

## 1. Owner instruction and objective

You are Claude Code, acting as the coordinating implementation and integration owner, **W01/W11**. Complete the full approved Agent8lite scope through **M1–M8**, including implementation, integration, meaningful verification, documentation, production readiness and the gated release handoff. Follow the approved scope and its explicit deferrals. A narrower demo or CRM-only release does not complete the full project requested here.

**Begin execution after reading this document and the authoritative sources. Continue until every applicable approved requirement, module acceptance criterion, integrated workflow and milestone exit gate is satisfied.** Do not stop after producing a plan, proposal, partial feature, passing subset of tests or progress summary. Do not treat a temporary provider/access blocker as a reason to abandon independent work.

The earlier **55% completion estimate was an informal engineering estimate**. It is not a measured baseline, acceptance decision or basis for skipping work. No milestone has a current recorded full acceptance decision at this snapshot.

### Standing authorization

The owner grants standing authorization to perform the actions necessary to complete this project without repeatedly requesting approval for routine work. You may inspect and edit project files; implement features and fixes; manage root dependencies, the pinned lockfile and generated contracts; prepare and apply reviewed forward migrations; manage development/test services; run checks; update documentation/runbooks; create branches/worktrees; use subagents with explicit ownership; and commit, push and integrate verified changes.

This instruction supersedes historical pause/hold instructions and the need for repeated approval of ordinary implementation steps. Existing authorization remains effective across sessions. Follow approved architecture, review and additive contract-amendment procedures. As integration owner, coordinate shared changes before consumers; independent technical review can be supplied by the assigned reviewer rather than repeatedly asking the owner about routine implementation choices.

Preserve unrelated user files, credentials, existing data and the separate GoDaddy demo history. Use explicit paths when staging. Never use a blanket add, hard reset, broad clean, production reset or destructive migration as a shortcut. Check process ownership before stopping a service and use only a dedicated disposable instance for failure injection.

External activation and production release must satisfy the documented acceptance gates and applicable account, provider and licensing requirements. This authorization does not supply missing credentials, contractual rights, third-party approval or undocumented commercial/product decisions. Keep live MLS, delivery and financial actions gated until their actual prerequisites are recorded. Prepare the concrete reviewable release before requesting any indispensable final release decision that is still required by the documented M8 gate.

## 2. Authority, source order and startup inspection

Read these sources before implementation and the owning module before each slice:

1. This owner instruction and any later owner corrections.
2. Root `AGENTS.md` and every applicable nested `AGENTS.md`. Currently the implementation tree has a nested instruction at `apps/web/AGENTS.md`; inspect again for additions. For web changes, read the relevant installed Next.js guides under `node_modules/next/dist/docs/` as that instruction requires.
3. `docs/tdd/technical-design.json` and `docs/tdd/real-estate-saas-tdd-2026-10-10.html`, especially module specifications, invariants, flows, provider gates, operations and verification. `docs/tdd/README.md` explains the copied specification boundaries.
4. Accepted ADRs in `docs/adr/`, implementation contracts in `packages/contracts/`, original contracts under `blueprint/`, `packages/contracts/permission-catalog.json`, `role-presets.json`, event schemas, `pwa-policy.json` and migrations in `packages/db/migrations/`.
5. The newest entries in `IMPLEMENTATION_STATUS.md`, recent commits, source/tests and the runbooks in `docs/runbooks/`. `HANDOFF-CLAUDE-CODE.md` is useful for toolchain details but its completion/blocker inventory is older.

When sources disagree, preserve immutable originals, inspect the accepted amendment and actual implementation, and record the discrepancy. Do not silently invent an API/provider capability. Amendments already enforced by `scripts/check-contracts.mjs` are **ADR-022 attribution contact, ADR-043 stage-transition If-Match, and ADR-049 contact merge**. The root instruction's older statement that only ADR-022 exists is stale. Update continuation documentation through normal reviewed work; do not remove accepted amendments to match old prose.

At startup inspect branch, HEAD, tracking refs, worktrees, dirty paths, active agents and owned services. Presence of a local tracking ref is not proof that a remote was just queried. Detect an active verification process before modifying files it reads.

### Existing checkout ownership

| Owner | Owned paths / coordination |
| --- | --- |
| Coordinator W01/W11 | Root dependencies/lockfile, contracts/generation, migrations allocation, CI, provider seams, status, integration and release gates. |
| Frontend/PWA W02/W12 | `apps/web/**`, `packages/ui/**`; coordinate with CMS/property feature owners. |
| Backend/database | `apps/api/**`, `packages/db/**`, `packages/auth/**`; coordinate with module specialists. |
| Test/review W11 | `tests/**`, independent boundary review and acceptance evidence. |
| W05 CMS | `packages/cms/**`, `apps/api/src/cms/**`, `apps/web/features/cms/**`, `tests/cms/**`, `docs/proposals/W05/**`. |
| W07 property/MLS | Corresponding `packages/mls/**`, API `mls`, web `features/properties`, `tests/mls/**`, `docs/proposals/W07/**`. |

Existing worktrees observed at the snapshot:

| Path | Branch | Observed HEAD |
| --- | --- | --- |
| `C:/Users/Monar/Agent8lite` | `feat/W01-foundation` | `ed38ce2` |
| `C:/Users/Monar/.codex/worktrees/2e5a/Agent8lite` | `feat/W05-native-cms-drafts` | `9ab2787` |
| `C:/Users/Monar/.codex/worktrees/8509/Agent8lite` | `feat/W07-native-mock-search` | `3c32028` |
| `C:/Users/Monar/.codex/worktrees/trestle-scaffold/Agent8lite` | `feat/W07-trestle-scaffold` | `3900eb7` |
| `C:/Users/Monar/.codex/worktrees/w11-xweb-preflight/Agent8lite` | `feat/W11-xweb-host-preflight` | `60782ee` |
| `C:/Users/Monar/.codex/worktrees/godaddy-main-integration/Agent8lite` | `feat/W11-godaddy-launch` | `5d9e567` |

Reconfirm ownership and activity before assigning work. Shared-checkout concurrent work is authorized with clear ownership; isolated worktrees remain appropriate for new independent streams. Do not edit another agent's checkout or duplicate work already being performed. Review and integrate proposals in dependency order. Do not merge full SaaS work into the separate demo history merely because local checks pass; establish the intended integration/release branch from current repository evidence.

At capture `apps/web/next-env.d.ts` was modified, and unrelated audit/blueprint archives, `evidence/`, `reports/`, `HANDOFF-CLAUDE-CODE.md`, `check-inquiry.mjs`, `collect-public-evidence.ps1` and `scripts/test-media-insert.mjs` were untracked. Preserve them. Reinspect rather than treating this list as exhaustive. Never include ignored secrets, raw MLS records, customer exports or private agreements in commits or this handoff.

## 3. Current evidence and reconciled inventory

Evidence below is **reported historical execution**, except the contract check explicitly identified as executed while preparing this document. Source presence or an accepted ADR establishes neither production acceptance nor security correctness.

| Area | Current implementation evidence | Remaining acceptance |
| --- | --- | --- |
| M1 foundation | Real PostgreSQL/PostGIS migrations, distinct application roles, RLS, context/scope checks, outbox, compiled runtime and mock/no-delivery seams exist. | Latest migrations/privileges need combined verification; real Redis restart/data-loss, isolated green CI and relevant environment gates remain. |
| M2 SaaS/CRM | Recoverable Contact/Lead creation/edit/archive, assignment/stage/task commands, merge, import/export, routing, administration/support/billing simulation, dashboard/notifications/agendas exist. ADR-049 merge accepted and implemented; Lead activity/note GETs added at `61c4f28`. | Event-catalog gaps, full scope/workflow coverage, production identity, real billing/provider acceptance, remaining CRM features and broad browser/device acceptance. |
| M3 CMS | ADR-053–058 added domain/media/form management, publication/rollback, publication panel, document archive/site update and mock upload grants. CMS suite reported **96/96** after ADR-058. | Independent boundary review, actual media/DNS/TLS evidence, editor/public rendering/SEO/jobs, complete public forms UI and integrated acceptance. |
| M4 marketing | Conditions ADR-050, audience preview ADR-051, campaign publish/archive ADR-059 (`53ede16`) and automation/enrollment ADR-060 (`c080c39`) exist alongside native drafts/designs. Latest lifecycle tests reported **43 workflow + 35 draft**; automation **14/14**. | Correct enrollment linkage/permissions, current source authorization, durable execution, broadcast confirmation, send reconciliation, real suppression and provider/calendar integration. |
| M5 mock/public property | Native synthetic search/detail, rights projections and mock replication helpers exist. ADR-052 added all 17 public operations, including inquiry, visitor and organizer APIs. | Harden public actors/sessions, wire public UI/map/organizer, durable ingestion/invalidation and alerts; API existence is not complete IDX acceptance. |
| M6 live Trestle | Reviewed scaffold, mapping/attribution tests and owner-supplied license/access evidence exist. Earlier isolated diagnostics are not a live application. | Current complete rules/amendments, exact party/site binding and permitted field/media/cache/alert/AI/retention mapping; trusted authorization/secrets and partner acceptance. |
| M7 reporting/AI/local | Basic measured dashboard and pure helper/provider scaffolds exist. | Advanced reconciled reports, evaluated review-only AI, local-provider jobs and launch brand kits/templates; conditional integrations remain rights/procurement gated. |
| M8/mobile/hosting | Static-only PWA shell/update protection and compiled launch tools exist. XWeb Pros is selected; the GoDaddy web-only demo is separate. | Production identity/services, actual Linux/HTTPS staging, physical device modes/push, load/security/PITR/object/queue recovery, operations ownership and approved release. |

Key verification boundaries:

- Latest recorded full isolated aggregate: **4,607/4,607 tests, 151 files at `2db7813`**, recorded by `b1915a4`. It predates ADR-053–060 and latest test fixes. One startup-timeout batch reportedly passed on immediate rerun; preserve that qualification and original logs.
- Recorded real-browser workspace result: **12/12**, desktop Chromium plus 360px Pixel 5 emulation, including axe, focus, service-worker draft protection and generic offline behavior. `test-results/browser/.last-run.json` also reports passed. This was a **development-build, bounded workspace suite**, not current full-flow, production-build, manual screen-reader or physical-device acceptance.
- Recorded local queue transport: **1/1 against Memurai Developer 4.1.2**, Redis 7.2.5-compatible. It is not the pinned real Redis 7.4.6 CI service and does not prove process restart/data loss.
- During handoff preparation, `node scripts/check-contracts.mjs` **passed at `ed38ce2`: 173 operations, 174 schemas, event envelope, original contracts plus exact ADR-022/043/049 amendments**. Generated-type drift, full tests, build and runtime checks were not rerun while preparing this file.
- Older ledger rows still say merge, publication/rollback, domains/forms, conditions, audience and enrollment are absent; those statements are superseded by the committed slices above. Older universal browser-block and no-local-Redis claims are also superseded by bounded browser/Memurai evidence. Tool access in a new session must still be checked; never bypass an actual saved access denial.
- Historical 2,123-case and later scoped totals belong to their exact checkpoints. Never add overlapping suites or use an older full aggregate as latest-source acceptance. The portable `reports/project-plan/` snapshot is older and does not automatically poll implementation.

## 4. Source-review findings to resolve first

These observations were made from source during preparation; **no runtime reproduction was performed**. Use adversarial tests to establish impact and fix the verified boundary rather than treating happy-path test counts as sufficient.

| Finding | Concrete source | Required resolution |
| --- | --- | --- |
| Enrollment checks the wrong entity | `apps/api/src/marketing/automation-service.ts`, `assertLead`; `tests/integration/automation-service.test.ts`; enrollment FK in `0001-blueprint.sql`. The service queries `app.contact` using `leadId`; the test creates a Contact with its fixture Lead ID. | Distinct Contact and Lead IDs enroll correctly; actual Lead/Contact relationships, ownership, archive/current capability and tenant scope are checked. Correct the fixture and add foreign/wrong-entity tests. |
| Enrollment permission/response mismatch | Create/cancel currently authorize `automations.write` instead of contract `campaigns.enroll`; list uses `automations.read` instead of `campaigns.read`; cancellation returns 200 instead of contract 201. | Follow exact grants, scope and response status; prove allowed and denied roles on fresh commands, replay and cancellation. |
| Automation mutation evidence is incomplete | `AutomationService` writes domain/idempotency rows without audit/outbox calls. | Resolve audit and INV-03 event requirements through reviewed schemas/ports; prove atomic effects/rollback and replay without duplicate events. |
| Public actor and module-boundary shortcuts | `apps/api/src/public-site-service.ts`, `withPublicSiteTransaction` selects an active Owner by role name and sets actor context; `findOrCreatePublicContact` writes CRM tables directly. | Reviewed public-site actor/context boundary and CRM-owned transactional capture/channel ports; no anonymous Owner impersonation. Actual-role tests prove tenant/site/current-source authorization and races. |
| Visitor authentication lacks complete current site/session binding | Same file: visitor signature, challenge/verify, logout, saved-search/favorite queries. Source shows visitor-ID-only signing, tenant/visitor queries, plaintext OTP logging, missing complete expiry/revocation checks and cookie hardening. | Tenant + site + session binding; expiring hashed one-use challenges, bounded attempts, current visitor state, logout/revocation and secure HTTPS cookies; no OTP/token/PII logs. Prove same-tenant cross-site and cross-tenant isolation, expiry, replay and origin/CSRF/rate policy. |
| Public dispatcher has different guard ordering | `apps/api/src/main.ts`, public dispatch occurs before member/synthetic/origin/rate guards. | Explicit documented anonymous/visitor policy at ingress; classify each operation, restrict synthetic behavior by environment and test production reachability. Public routes need their own appropriate checks, not inherited Owner privileges. |
| Unsubscribe/analytics success exceeds effects | `public-site-service.ts` analytics discards data while returning an event-recorded receipt; unsubscribe handlers validate shape without durable suppression. | Honest local status; cryptographically valid scoped unsubscribe and durable consent/suppression before delivery; approved privacy-aware analytics ingestion/retention. No false completed-operation claims. |
| Caller assertion is treated as provider/scan evidence | `apps/api/src/cms/service.ts`, `repository.ts`: finalize marks media clean; domain verification marks DNS verified/TLS active. | Keep synthetic evidence explicit. Real state changes follow verified object/hash/MIME/scan/rights checks and DNS/TLS provider results, with pending/failure/recovery tests. |
| Elevated database function hardening is unproven | SECURITY DEFINER functions in migrations `0023`–`0027`; several lack explicit PUBLIC revocation or fixed search_path. | Inspect actual `pg_proc` owner/ACL/proconfig and default privileges. Review safe search_path, explicit execute grants and actor/tenant/source checks, and prove hostile role/context and concurrent revocation denial. Use forward migrations for corrections. |
| Publication/source eligibility relies on historical receipts | Automation `assertPublishedVersion` reads an idempotency receipt; archive execution cancellation/current source locks are not established by ADR-059/060. | Use approved current campaign/version/Lead/consent ports; archived, revoked or changed sources prevent future work. Prove post-wait current-clock reauthorization, cancellation generation and historical replay behavior. |

## 5. Ordered completion register

Every task below is open for completion or latest-source verification. Preserve working implementations; extend, repair or verify them. Each task's completion includes the shared evidence rule in section 6 and its mapped normative requirements/acceptance criteria in the appendix. Do not substitute a stub, receipt-only handler, mock provider or skipped test for a required effect.

Dependency references normally mean the reviewed contracts/ports and implementation prerequisites for the specific substep, not a whole-task finish-to-start lock. Separate contract/policy preparation, local implementation, downstream integration and external/full acceptance. Consumers can implement against reviewed mocks before provider/staging acceptance. Record full-acceptance dependencies explicitly; split a task if a dependency cycle appears.

### R00 — Establish and maintain the current baseline

**Owners/paths:** W01/W11; root status/instructions/contracts, all module evidence. **Dependencies:** none.

Inspect repository/service/agent state; build a requirement-to-evidence ledger for all 76 requirements, 48 module acceptance criteria, INV-01–12 and FL-01–10. Separate implemented, partially implemented, verified at an older checkpoint, currently verified, blocked and approved deferred. Reconcile stale records using commits and actual source; split unknown coverage into executable subtasks. Verify applicable pins and allocate subsequent ADR/migration numbers by inspecting the live tree.

**Done:** every requirement/gate has an owner, exact source, executable next action, dependencies and evidence or blocker; no known current feature is incorrectly listed as absent. Record the starting and final HEAD for every gate.

### R01 — Repair and independently verify recent security/integrity boundaries

**Owners/paths:** W01/W11 with backend/test owners; `public-site-service.ts`, `marketing/automation-service.ts`, CMS services, `packages/db/migrations/0023-*` through `0028-*`, affected tests. **Dependencies:** R00; precedes consumers and activation.

Resolve every finding in section 4. Review all privileged functions and public/member transitions, receipt expiry, state visibility, current capabilities, tenant context, source locks, permission scope and module writes. Review accepted ADR text against actual behavior; amend inaccurate ADRs rather than preserving unsupported claims.

**Done:** targeted adversarial real-role tests prove ordinary distinct Lead/Contact IDs, correct grants, anonymous/visitor isolation, no leaked OTP/private content, revocation/expiry after actual waits, trusted scan/DNS transitions, safe function ACL/search_path and rollback/replay effects. An independent reviewer records resolved findings and remaining conditions. Source review alone does not close this task.

### R02 — Close contract/event coverage and migration compatibility

**Owners/paths:** W01/W11; `packages/contracts/**`, `scripts/check-contracts.mjs`, migration runner/schema and API registration. **Dependencies:** R00/R01 for affected boundaries.

Audit all 173 current operations against route registration, request/response schemas, permissions and real effects. Preserve original blueprint bytes and exact accepted amendments. Resolve documented Task mutation, Lead archive and other command/event-catalog gaps through reviewed additive schemas before producers/consumers. Reuse approved module ports; version incompatible changes. Verify fresh and upgrade migrations through the current latest number, checksum replay and least-privilege grants.

**Done:** generated files are current; exact contract checks pass; no launch-required operation remains an undocumented generic stub; mutations satisfy INV-03/04/10; fresh/upgrade real-role tests pass without resets or permission widening.

### R03 — Complete foundation recovery and isolated CI

**Owners/paths:** W01/W11; `.github/workflows/ci.yml`, `compose.yaml`, `apps/worker/src/**`, `tests/recovery/**`. **Dependencies:** R01/R02 for verified source; independent of live providers.

Use a dedicated actual Redis 7.4.6 service for transport, stop/restart and data-loss tests. Prove PostgreSQL-authoritative outbox/due-work recovery, dedupe, lease/generation behavior, pool reuse and post-revocation denial. Confirm CI application Redis and acceptance Redis isolation; inspect current run results/artifacts rather than relying on authored YAML or historical failure reports.

**Done:** all M1 exit criteria pass on one identified source; a fully green isolated CI run is linked; real Redis process-loss evidence is retained. Memurai transport and disconnected-Redis tests remain separately labeled.

### R04 — Complete production identity, invitations and revocation

**Owners/paths:** W01/W03/backend; `packages/auth/**`, `packages/providers/identity/**`, API session/staff boundaries, web BFF/auth return, integration tests. **Dependencies:** R01/R02; real identity configuration can block only provider acceptance.

Complete the approved OIDC provider adapter/authorization return flow, issuer/audience/subject/PKCE/callback validation, server-held sessions, secure cookies, CSRF, current membership/capabilities, session expiry/logout and production environment denial of fixture identities. Complete invitations with verified-email matching and one-use hashed expiry; include staff principal/grant lifecycle separately from tenant roles. Require fresh authentication for financial/staff/high-impact role commands; a staff grant creator cannot self-approve unrestricted access.

**Done:** multi-org sign-in/return, invitation/replay, privilege changes and revocation pass scope/browser tests; real-provider acceptance is recorded before activation; synthetic identities remain explicit and loopback-only.

### R05 — Finish administration, provisioning and delegation

**Owners/paths:** W03/backend with W01; admin/control services and ports, web administration/staff UI, `tests/control/**`. **Dependencies:** R02/R04 for activation; mock implementation may continue.

Finish organization/office/member/business-profile/custom-role operations and capability limits; durable provisioning/downstream bootstrap readiness, safe failed-attempt retry and jobs; final-owner/delegation races; platform health/configuration/plans/redacted audit. Complete purpose-bound time-limited staff support and visible staff banner.

**Done:** pending/ready/failed states reflect durable work; bootstrap failures never become ready from payment alone; exact last-owner, invite, tenant-switch, grant-expiry and delegated-scope acceptance passes including UI.

### R06 — Finish CRM views, routing, scoring and command completeness

**Owners/paths:** W04/backend/frontend; CRM/routing/capture/command services, workspace/drawers/pipeline/configuration and tests. **Dependencies:** R01/R02/R05 boundaries; R18 supplies trusted listing attribution.

Audit current contact/lead/deal/task/note/activity functionality, saved filters/column preferences and scoped bulk selection. Complete trusted first-touch/listing-agent/geography/weighted routing, office/member eligibility and unassigned fallback. Finish versioned cumulative deterministic engagement scoring with reasons/timestamps; close frozen-contract tag readback/deal close-date gaps through approved changes. Preserve dedicated recoverable commands and interrupted two-step capture semantics.

**Done:** FL-02 and MOD-D acceptance pass, including concurrent distribution, current historical/current-source replay scope, optimistic conflicts, task timezone parity, six configurable immutable stages and full mobile command paths. Scores never infer housing eligibility.

### R07 — Complete reviewed import/merge/export and archive consequences

**Owners/paths:** W04/backend/test; private transfer/storage, CRM merge/archive/consent ports and corresponding UI. **Dependencies:** R01/R02/R06; cancellation integrates with R15–R20.

Retain ADR-049 merge and CSV protections; complete candidate detail/review, explicit merge/skip decisions, withdrawal-wins consent, scoped durable exports and current authorization at download. Ensure archive/merge invalidates eligible pending work and organizer relationships according to the approved retention policy without erasing immutable evidence. Do not recast stored acceptance as current send eligibility.

**Done:** module import/export/merge acceptance passes across own/team/org scope, races/replays, formula injection, primary channel/household-phone ambiguity and revoked downloads; archive blocks future dispatch/alerts and handles organizer retention honestly.

### R08 — Complete sandbox billing and current-state reconciliation

**Owners/paths:** W03/W10/backend; billing services/providers, platform catalog, settings UI and callbacks. **Dependencies:** R02/R04/R05; merchant credentials block provider acceptance only.

Implement approved Stripe hosted sandbox flow, catalog/interval versioning, invoices and precise preview price/tax/proration/effective-date/expiry. Complete signed webhook inbox, duplicate/out-of-order reconciliation from current provider state, financial dispatch and independent entitlement/provisioning records. Preserve explicit confirmation and visible pending/failed outcomes.

**Done:** FL-07 and MOD-A billing acceptance pass with approved sandbox recipients/accounts; duplicate or stale callbacks do not unlock or regress entitlements; real charges remain behind documented activation and explicit financial commands.

### R09 — Complete workspace onboarding, KPIs, agendas and notifications

**Owners/paths:** W02/W03/W08/W12; workspace/dashboard, notification/appointment/report services and tests. **Dependencies:** R04–R06; provider event ingestion in R17, reporting in R23.

Complete honest empty-account onboarding, default agent scope, explicit broader views, website/campaign health, shareable task/lead drawers and preferences. Retain measured KPI source/version/period/timezone/freshness; finish appointment cancellation/order/dedup from verified events and notification read/unread behavior without mutating underlying Leads.

**Done:** MOD-B acceptance passes; no unavailable metric becomes zero, no iframe implies calendar sync, and mobile agendas/notifications honor current source access and timezone labels.

### R10 — Complete support, integration registry and safe operations UI

**Owners/paths:** W03/W10/W11; support services/settings, `packages/providers/**`, integration/job/audit endpoints and platform diagnostics. **Dependencies:** R02/R04/R05; provider-specific consumers follow their own gates.

Finish requester-scoped tickets/timeline, safe job status, operational health and redacted diagnostics. Implement approved integration connect/authorization/disconnect lifecycle with server-only credential references, truthful capability/readiness state, typed errors, timeout/quota/circuit policies and reconciliation. Staff replay uses purpose-bound grants; unknown sends cannot use a generic rerun.

**Done:** MOD-J and adapter boundary acceptance passes; current disconnect/grant revocation prevents future jobs/downloads; customer UI never exposes raw provider errors or cross-tenant tickets.

### R11 — Complete the CMS editor and durable publication pipeline

**Owners/paths:** W05/W02/W01; `packages/cms/**`, CMS API/web feature, `packages/templates/**`, reviewed W05 publication proposals. **Dependencies:** R01/R02/R05 interfaces; local editor/publication implementation proceeds before external DNS/storage acceptance. Media R13, domains R12 and capture R14 complete integrated acceptance.

Complete the approved Puck adapter/license decision and accessible mobile alternative, registered block families/migrations/templates, navigation/site settings, signed draft preview on a separate preview hostname and recovery. Retain existing publication/rollback UI/API; validate current same-document revision, block/link/form/MLS compatibility, media/source grants, CAS and historical receipts. Implement durable publication/CDN/sitemap jobs, generation/fence/current-clock checks and derived-source invalidation through reviewed ports. Existing pointer swaps alone do not establish these checks or public hosting artifacts.

**Done:** FL-03 and MOD-C draft/publication acceptance pass, including conflict recovery, unknown/legacy blocks, immutable revisions, malicious content, failed purge/restart, explicit rollback and responsive public output. Draft changes never appear publicly before an authorized publication.

### R12 — Complete domain ownership, TLS and public host resolution

**Owners/paths:** W05/W10/W11; CMS domains, hosting/provider seams, public routing and `docs/proposals/W05/**`. **Dependencies:** R01/R02 and reviewed R11 site/publication interfaces, not full R11 acceptance. Implement local/mock domain lifecycle first; DNS/TLS account/domain access may block external acceptance.

Replace synthetic DNS/TLS claims with provider-backed ownership evidence and durable pending/failure/reconciliation. Resolve public hostname to the correct current published site/profile/policy using approved source/context ports. Enforce unique hosts, archive/detach/suspend, safe redirects/origins and expired authorization invalidation. Review proposals and actual-role concurrency before allocating migrations.

**Done:** tenant/host ownership and concurrent unique-host tests pass; real staging DNS/TLS is verified; unverified/archived/suspended hosts cannot serve tenant content; no published-site lookup confers member Owner authority.

### R13 — Complete secure object/media storage and processing

**Owners/paths:** W05/W10/backend; `packages/providers/storage/**`, `packages/storage/**`, CMS media API/UI/workers. **Dependencies:** R01/R02 for local implementation and mock/provider contracts. R27 supplies production private storage for later environment acceptance; it does not block local pipeline work.

Extend the mock upload-grant seam into approved bounded upload/download providers. Verify uploaded bytes/hash, MIME sniffing, size limits, tenant prefix/access, quarantine/scanning, rights attestation/evidence, safe transforms, derivative expiry/purge and signed access. Complete responsive upload/library/edit/alt-text flows and replay/reconciliation.

**Done:** hostile/unscanned/unlicensed/corrupt media cannot publish; rejected scans and provider failures remain visible; current membership/source/rights authorize reads; actual storage/object restore and purge evidence precede activation.

### R14 — Complete public forms, capture, SEO and privacy analytics

**Owners/paths:** W05/W04/W08; forms/version UI, public renderer/API, shared capture/consent ports and analytics. **Dependencies:** R01/R02/R06/R11–R13; analytics expands in R23.

Finish form authoring/version publication, allowed fields/confirmations/spam/retention, accessible validation and public submission. Shared CRM capture must atomically record the submission, source provenance, Lead decision, appropriate consent evidence/audit/outbox and durable result across retries. Complete registered conversion/community/profile blocks and policy-safe SEO/structured data/sitemaps. Ingest only approved analytics fields under current consent policy; return honest status for disabled work.

**Done:** FL-01 and CMS form/public acceptance pass; a validated retry creates one Lead decision/evidence set, anonymous inputs cannot choose tenant/owner, suppressed listing data does not leak through SEO and mobile public pages are keyboard accessible.

### R15 — Implement PostgreSQL-authoritative workflow execution

**Owners/paths:** W06/W01/backend; marketing workflow services, worker/scheduler, event schemas and recovery suites. **Dependencies:** R01–R03 and reviewed CRM/archive ports from R06/R07; consent/calendar policy and provider contracts from early R17 preparation. Full downstream dispatch/alert acceptance follows later integration.

Retain branch authoring and immutable drafts; finish publication graph validation and event-driven enrollment triggers. Implement persisted due instants, workflow position, immutable schedule/action identity, leases/fences/generations, execution through approved task/send ports, cancellation/archive/withdrawal and retry/reconciliation. Wire reviewed calendar/quiet-hour helpers with visible IANA timezone/DST policy; define anniversary/leap-day behavior before consumers.

**Done:** MOD-E restart/virtual-clock/Redis-loss acceptance passes; crashes before/after commit/dispatch and duplicate/late events create no duplicate native action key; archived/revoked sources cannot advance; Redis is never the only schedule; calendar helpers actually govern durable schedules.

### R16 — Complete broadcast confirmation, enrollment and marketing UI

**Owners/paths:** W06/frontend/backend; audience preview, automations/enrollments/campaign controls and tests. **Dependencies:** R01/R02/R06/R15; delivery gates R17.

Retain current audience preview, publication/archive and enrollment slices. Complete frozen `confirmBroadcast`, generation-bound preview freshness/source/consent/time/cost checks, current published version access and correct `campaigns.enroll` authority. Add usable mobile rule/enrollment/lifecycle controls and current status/cancel views with stable unknown-command keys.

**Done:** FL-04 preview → explicit confirmation → durable enrollment/broadcast works without any real test delivery; stale/changed previews fail; counted destinations dedupe correctly; publication/archive/cancel semantics are enforced by workers and UI never equates queued with delivered.

### R17 — Complete consent, delivery, callbacks and calendar providers

**Owners/paths:** W06/W10 with consent/CRM owners; provider seams, consent/suppression, communication worker/callbacks/calendar. **Dependencies:** early policy/provider-contract preparation follows R01/R02 and supplies R15/R16. Later delivery integration uses reviewed R04/R10/R15/R16 interfaces; provider agreements/sender readiness may block external acceptance.

Implement approved email/SMS adapters and editor export/license/mobile fallback, sanitization, verified signed callbacks, provider budgets/readiness and no-delivery contracts. Recheck current channel consent, suppression, archive/member scope, entitlement, quiet hours and readiness at dispatch. Unknown acceptance enters reconciliation before retry. Implement cryptographically verified unsubscribe/one-click withdrawal and durable destination/purpose suppression. RFC8058 mail-client one-click POST uses a signed purpose/channel URL token without login, cookies, session/CSRF dependence or redirect; GET preview cannot withdraw. Verify appropriate headers/DKIM and token-log redaction. Complete verified scheduling/cancellation provider events and safe timezone mapping.

**Done:** revoked consent after preview/enrollment prevents future sends; equivalent destinations suppress conservatively; forged/out-of-order callbacks and 429/auth failures are handled; unknown sends never blindly resend; provider sandbox and calendar acceptance is documented before live activation.

### R18 — Complete durable synthetic MLS ingestion and invalidation

**Owners/paths:** W07/W01; `packages/mls/**`, `apps/api/src/mls/**`, `packages/providers/mls/**`, W07 persistence proposals and workers. **Dependencies:** R01–R03/R11 boundaries; can proceed alongside R15.

Finish normalized Listing/media persistence and run/checkpoint storage using reviewed source identity/mapping/policy ports. Commit a page before advancing checkpoints; use ordered source timestamps/keys, overlap and complete scan generations. Never infer deletion from partial reconciliation. Implement expiry/withdrawal/termination propagation to list/map/detail/media/SEO/featured blocks/cache and pending alert work.

**Done:** full fictional lifecycle/paging/deletion/token/429/equal-time/partial-scan/replay/concurrency suite passes on real roles; unknown rights deny independently; all samples are conspicuous; no live record enters the synthetic repository.

### R19 — Complete public property search and site-bound organizer

**Owners/paths:** W07/W05/W02; public/member property UI, `public-site-service.ts`, visitor/organizer ports. **Dependencies:** R01/R02/R11/R14/R18; map tile licensing blocks only live tiles.

Wire shared typed filters/paging/sort to list/map, safe attribution/detail/inquiry, verified visitor challenge/session, favorites and saved-search preference controls. Finish map extent/result bounds and accessible list alternative, address/coordinate masking and permitted media. Use exact current feed/site policy and source provenance through the shared capture port.

**Done:** FL-05 and organizer ownership acceptance pass; visitor A cannot read B, same-tenant site A cannot use site B sessions, logout/expiry/revocation applies immediately and withdrawn/expired details do not reappear from delayed reads or caches.

### R20 — Complete licensed-policy-aware synthetic alerts

**Owners/paths:** W07/W06; saved-search preferences, listing-match events, scheduler/delivery interfaces and tests. **Dependencies:** R15/R17–R19; no-delivery execution is independent of live rights.

Implement match dedupe by feed/listing/source change/search/preference generation; explicit frequency/channel/off controls; current visitor preference/consent and listing/media/feed rights at dispatch; cancellation after withdrawal/expiry/access changes and safe deep links.

**Done:** FL-06 passes with synthetic no-delivery fixtures, replay/crash/withdrawal races and current preferences. Turning alerts off stops future work; live alerts remain disabled until separately licensed and accepted.

### R21 — Resolve and record the M6 live authorization matrix

**Owners/paths:** W07/W10/W11 with owner/provider; `docs/proposals/W07-trestle/lvr-connection-rights-review.md`, approved connection references and server policy store. **Dependencies:** R18/R19 specifications; final live activation requires M5 acceptance.

Reconcile owner-supplied approved agreements/access with current complete LVR rules or verified applicable amendments. The available older rulebook and 2026 Coming Soon bulletin do not by themselves supply all current rules. Bind the exact participant/customer/site/current affiliation and originating systems; map permitted statuses/fields/address/location/attribution-contact/media/cache/retention/alerts/AI, quotas and freshness. Resolve trusted current-member attribution and operational deletion duties.

**Done:** written current policy approval and exact source/party/site/rights matrix are recorded without redistributing secrets/contracts. Every unknown right denies that capability. Missing external inputs have an explicit owner and affected gate; unrelated work continues.

### R22 — Integrate and accept the approved live Trestle adapter

**Owners/paths:** W07/W10/W11; server-only Trestle adapter/resolver, feed runtime/storage, monitoring/runbook. **Dependencies:** R03/R10/R18–R21 plus documented M6 activation prerequisites.

Resolve secrets from trusted server context; reject fixture identities/records and unapproved URLs. Validate actual authorized metadata/mappings, bounded opaque next-links, token renewal/quota/backoff and source reconciliation. Enable only licensed modes/surfaces; verify source-to-normalized/display comparisons, current rights/expiry, withdrawal/purge/termination, attribution screenshots and controlled rollback/monitoring.

**Done:** every M6 exit criterion and applicable MOD-F acceptance passes with approved partner evidence. A token, metadata read or one-listing diagnostic is insufficient. Do not make live requests before the documented gate is satisfied.

### R23 — Complete reconciled reporting and attribution

**Owners/paths:** W08 with domain owners; approved event consumers/read ports, report query/export UI and API. **Dependencies:** R02/R06/R09/R14/R15/R18 event boundaries; live metrics depend on their actual accepted providers.

Implement versioned metric definitions, ingestion/dedup/late correction and scope-safe funnels/cohorts/pipeline/source/delivery/website/property reports. Expose periods, timezone, numerator/denominator, source, freshness and honest unavailable states. Complete approved filters/charts/table alternatives, scoped report exports, retention/privacy and reconciliation to source records.

**Done:** MOD-G fixture reconciliation and duplicate/late-event acceptance pass; revocation applies to reports/downloads; published metrics match documented sources and UI never renames directory coverage as query-based AI visibility.

### R24 — Complete evaluated, human-reviewed assistive AI

**Owners/paths:** W09/W01/domain owners; approved AI provider port, job/read/accept endpoints, prompt registry/evaluation fixtures and UI. **Dependencies:** R02/R04/R06/R11/R16/R23 facts; MLS purposes additionally require R21/R22 AI rights.

Implement approved draft purposes, scoped source retrieval, schema/citation validation, prompt/model versioning, quotas/cost/latency/expiry and provider errors. Verify current OpenAI product/model/data controls from official sources at implementation time. Human acceptance saves a draft through the owning module's port with expected destination version; suggestions do not autonomously publish, send, alter consent, bill or determine housing/credit eligibility. Preserve explicit deferrals.

**Done:** all MOD-H evaluations meet approved thresholds on at least 200 versioned synthetic/redacted cases: accepted drafts have 100% schema/citation validity, no cross-scope disclosure or unsupported critical property/financial claim, at least 95% supported assertions and 100% draft-only acceptance. Invented claims, prompt injection, inaccessible sources, permission revocation, PII leakage, abstention and cost/latency caps are evaluated. Acceptance alone cannot trigger external actions. Missing model/provider agreement blocks enablement rather than mock test development; `store:false` alone is not a zero-retention guarantee.

### R25 — Complete launch brand assets and approved local presence

**Owners/paths:** W10/W05/W06/W09; business-profile ports, local-presence integration/jobs, brand/template components. **Dependencies:** R05/R10/R11/R16/R23; provider procurement gates only connected capabilities.

Finish reusable brand kits and email/page templates as launch features. Implement versioned validated business-profile synchronization, pending/failed/reconciled jobs, last-success and defined publisher/review/visibility domains. Verify actual Yext or owner-approved capabilities/procurement before connecting. Google Business/social/review publication stays gated; AI review responses remain human-approved drafts.

**Done:** MOD-I acceptance passes using provider mocks then approved connected acceptance where applicable; failed sync cannot rewrite canonical profile on page load. Deferred print/design packs/mortgage products/advanced creative tooling are explicitly recorded rather than silently included or represented as working.

### R26 — Complete mobile parity, accessibility, push and update safety

**Owners/paths:** W12/W02 with every module owner; `apps/web/**`, `packages/ui/**`, manifest/service worker, push registry/providers and E2E/device tests. **Dependencies:** continuous with R04–R25; final physical checks require R27 HTTPS staging.

Provide every entitled core command at 360px with safe areas, touch/keyboard access, labeled errors, focus, reduced motion, 200% zoom/reflow and desktop parity. Validate manifest/icons/install guidance/deep links/standalone sign-in/return. Keep only safe static assets/generic shell in caches; private HTML/RSC/API/CRM/billing/AI/MLS remains out of service worker/IndexedDB. Protect dirty/unknown commands during updates and reconcile using original keys. Implement encrypted member/device push subscriptions, explicit opt-in, generic payload, current authorization and revoke/remove flows; in-app status remains authoritative. Validate push endpoint HTTPS/egress without private-host SSRF, keep VAPID secrets server-side and authorize same-origin notification deep links.

**Done:** MOD-K and FL-09 acceptance passes on physical iPhone Safari browser + installed home-screen and Android Chrome browser + installed modes, covering current and previous supported OS/browser versions at release. Verify desktop Chrome/Edge/Safari/Firefox compatibility and record exact device/OS/browser versions. Axe plus manual keyboard/VoiceOver/TalkBack/zoom results are recorded; offline writes remain disabled; push denial/revocation works and app use never depends on push.

### R27 — Complete host preflight, production services and HTTPS staging

**Owners/paths:** W11/W01/W10; `scripts/hosting/**`, `docs/runbooks/xweb-pros-hosting.md`, runtime/build/service/infrastructure configuration. **Dependencies:** read-only preflight and infrastructure/provider-contract preparation start independently under available access. Staging integration uses reviewed R04/R10/R12/R13 interfaces and verified host/account inputs; full provider acceptance does not block preparing the environment.

Inspect selected XWeb Pros host `68.178.204.192` read-only first; confirm actual OS/cPanel/account/resources/pinned Node/private PostgreSQL+PostGIS/Redis/object/secret/backup capabilities. Use supported provider configuration and preserve other hosted applications. Complete production identity/env/proxy validation, private services and continuously supervised web/API/worker, trusted worker context discovery, Linux-native immutable artifacts/SBOM and versioned infrastructure. Separate staging/production identities/databases/buckets/queues/secrets/origins and no-delivery preview modes. Never seed production or copy Windows node_modules to Linux.

**Done:** exact committed artifacts run on the inspected host/Linux with approved HTTPS domain, safe forwarding/cookies/no-store policy, private listeners, owned shutdown/restart and independent backups. The database-free GoDaddy demo remains a separate deliverable. Credentials/access/domain decisions may block host acceptance only.

### R28 — Prove security, load, fairness and recovery

**Owners/paths:** W11/test with all owners; security/load/recovery suites, observability and incident/recovery runbooks. **Dependencies:** R03/R27 plus representative completed modules; test design begins early.

Run tenant/IDOR/SSRF/private-cache/threat tests, dependency/secret/image review, redacted traces and credential rotation. Measure representative synthetic capacity, query plans, tenant fairness, provider budgets, bundle/Web Vitals and per-purpose job latency. Exercise actual isolated PostgreSQL PITR, object and queue restoration, deletion/rights reapplication, generation reconciliation, canary/rollback and incident response. Confirm operational owners and capacity assumptions.

**Done:** measured approved SLO/RPO/RTO targets and recovery drill evidence are retained; no critical tenant/data-rights defect remains; restore cannot resurrect revoked records or duplicate unknown deliveries. Proposed targets are not reported as measurements.

### R29 — Accept every milestone and perform the gated final handoff

**Owners/paths:** W11 coordinates all owners; status/evidence/runbooks, CI and exact release branch/artifacts. **Dependencies:** all applicable tasks and external gates.

Run final combined verification on an unchanged identified source, all FL-01–10 degraded/scope paths, module acceptance and production-build browser/device suites. Obtain required owner/provider acceptance against concrete evidence; execute only the release steps authorized by the documented M8 decision. Deploy compatible schema expansion before API/workers/web, monitor canaries and retain an explicit rollback. Record any approved deferral exactly; do not treat an unresolved requirement as an implicit deferral.

**Done:** every applicable requirement/gate has current evidence and approval; deployment/release status is exact; final checkpoint/artifact hashes, migrations, CI links, device/load/recovery results, operational owners and limitations are handed off. If an indispensable external gate remains, report the actual incomplete gate and continue any independent work; do not claim full completion.

### Parallel execution and dependency guidance

R00/R01/R02 take priority. After reviewed boundaries are stable, run administration/CRM, CMS, marketing, synthetic property, reporting/AI and mobile streams concurrently where dependencies permit. W01 allocates shared contracts/migrations/dependencies before consumers. W11 independently reviews risky changes. Prepare R21/R27 external prerequisites early while continuing local implementation. R26 acceptance follows each new workflow, then final device acceptance. R29 closes the project only after all applicable tasks/gates.

No scheduled completion date is authorized by this document. Historical weekend deadlines and informal percentage estimates do not establish a feasible forecast or waive acceptance.

## 6. Verification procedure and evidence standard

For every slice: read the requirement/ADR/contract; define meaningful acceptance; review and commit shared proposals before consumers; implement the smallest complete boundary; run relevant unit/UI and actual-role integration tests; fix failures; run required types/contracts/lint; review UI states/provider/recovery effects; update evidence and runbooks; independently review material boundaries; commit explicit owned paths and integrate in dependency order.

Evidence records must state source HEAD, working-tree differences, command, runtime/environment/provider mode, start/end, pass/fail/skip/batch counts, artifact location, reviewer and limitations. Retain failures and rerun qualifications. A receipt, queued job, schema validation, source inspection, generated file or mock provider must be described at the level it proves.

### Windows toolchain

Git/Node/pnpm were not on the default PATH during preparation. These observed paths supply the existing approved runtimes; recheck before use:

```powershell
Set-Location -LiteralPath 'C:/Users/Monar/Agent8lite'
$env:PATH = 'C:/Users/Monar/.codex/tmp/trestle-scaffold-runtime/node-v24.19.0-win-x64;C:/Users/Monar/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/git/cmd;' + $env:PATH
function pnpm {
  & 'C:/Users/Monar/.codex/tmp/trestle-scaffold-runtime/node-v24.19.0-win-x64/node.exe' 'C:/Users/Monar/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs' @args
}
node --version
pnpm --version
git --version
git status --short
git branch --show-current
git log -12 --oneline
git worktree list
```

Authoritative pins: `.node-version` **24.19.0**, `package.json` **pnpm 11.25.0**, exact root dependencies and `pnpm-lock.yaml`. Package engine compatibility for the isolated hosted demo is not authority to change full-runtime pins. If paths disappear, find an existing approved runtime or install the exact pin; do not upgrade globals or change pins silently.

### Required checks

Commands are a verification sequence, not permission to run against arbitrary databases or stop shared services. Configure the intended synthetic/disposable environment first, following `docs/runbooks/local-development.md` and the harness source.

```powershell
pnpm install --frozen-lockfile
node scripts/check-contracts.mjs --generated
pnpm typecheck
pnpm lint
pnpm db:verify-fresh
node scripts/test-isolated.mjs
pnpm exec vitest run --config scripts/vitest.launch.config.mts
pnpm exec vitest run --config scripts/hosting/vitest.config.mts
$env:ESTATE_BUILD_DIR = '.next-build'
node scripts/build-app.mjs
node scripts/verify-runtime.mjs
node scripts/verify-runtime-local.mjs
node scripts/verify-launch-local.mjs
pnpm test:e2e
git diff --check
```

- `scripts/test-isolated.mjs` discovers unit/package/scoped suites, then runs each integration file in a fresh disposable process/database and the control harness. Keep source read by the gate stable. Its aggregate report directory is cleaned by the runner; retain the command's safe output and checkpoint elsewhere in approved evidence storage.
- Only one cluster-role/database verification process may run at a time on the shared local cluster. Multiple explicit integration paths share one database and can contaminate fixture expectations; for scoped integration use one file per invocation. Example: `node scripts/test-isolated.mjs tests/integration/automation-service.test.ts`. Inspect current CMS/MLS harness integration before running them.
- Long tests can run in the background with regular progress updates, but never edit source the running gate reads. Coordinate an explicit stable-source window. Do not run `format --write` over another owner's files as a shortcut.
- `verify-runtime-local.mjs` uses synthetic loopback fixtures and mutates fixture sessions. Do not point it at staging/production. Use approved environment-specific probes for actual host acceptance.
- Existing Playwright uses one worker, desktop Chromium and 360px emulation. Start/await the approved test servers; `pnpm test:e2e` alone does not start a production-build harness. Add/review a production-build harness and broaden flow/device acceptance through the approved tests. Respect actual browser access state.
- For queue acceptance, set `REQUIRED_REDIS` to an **actually dedicated disposable instance** and `REQUIRED_REDIS_ISOLATED=true`, then run `pnpm exec vitest run --config tests/recovery/redis-service.vitest.config.mts`. The flag is not proof of isolation. The current transport test does not stop/restart/drop Redis; add separate owned-service loss tests under R03/R15. Never flush or stop the shared Memurai service for failure injection.
- Supplement the sequence with relevant provider contracts, axe/manual keyboard/screen-reader checks, k6 representative synthetic load, real RLS concurrency/rollback, recovery and physical-device acceptance. Follow approved tools; alternate tooling requires an ADR.

### Operational targets to verify, not assume

TDD planning envelope: 500 organizations, 5,000 members, 50 API requests/second with short 5x bursts, up to two million contacts and 100,000 permitted listings per regional feed. Confirm against owner forecasts and use synthetic datasets.

Proposed targets: 99.9% monthly availability; ordinary warm API reads p95 <=400ms and public property query p95 <=800ms; mobile p75 LCP <=2.5s, INP <=200ms, CLS <=0.1; initial compressed JS <=350KB authenticated and <=200KB public non-map; ordinary capture notifications within 60 seconds; **RPO <=15 minutes / RTO <=4 hours**. Validate approved provider-specific cadence, quotas/cost caps and rollback/recovery ownership. Change targets only through the documented decision process; do not report proposed values as observed production results.

## 7. Persistent execution, blockers and final output

Maintain `IMPLEMENTATION_STATUS.md` as the authoritative continuation ledger and a concise current execution checkpoint linked from it. Preserve historical results while updating current inventories. Keep a durable entry with:

```markdown
Source/branch/worktree:
Current task and requirement/flow IDs:
Completed implementation and exact commits:
Dirty owned files and other-owner files to preserve:
Active agents/services/tests and ownership:
Executed checks, results, artifacts and limitations:
Open defects and acceptance gates:
External blocker, required input/evidence, responsible party:
Independent ready work:
Next executable command/action:
```

Context/session limits require a checkpoint and continuation, not a fabricated completion claim. Resume from the checkpoint; verify changed HEAD/source/tool access before continuing. Do not repeatedly ask permission already granted. Ask only when an indispensable decision, credential, access mechanism or external approval cannot be obtained from available authorized evidence. Request secret delivery through the approved secure mechanism, never a chat paste or committed file.

When blocked, isolate the affected requirement, prepare all reversible/reviewable work, document what exact input unlocks it and keep executing ready tasks. Elapsed time is not approval. If every remaining task depends on unavailable external state, report the actual blocked gates and a resumable checkpoint; do not promise unattended execution beyond the available session or mark the project complete.

The final handoff must include the exact implementation/integration/release checkpoints; all requirement/module/flow/milestone acceptance evidence; contracts/migrations and upgrade notes; CI/build/artifact/device/load/recovery results; actual provider and deployment status; operational owners/runbooks/rollback; approved deferrals and any remaining limitations. A separate demo, disabled provider or unexecuted acceptance must be labeled accurately.

## 8. Normative coverage appendix

The following requirement and acceptance register is copied from the approved JSON at this snapshot and mapped to the execution register. It is a coverage checklist, not a declaration that each row is complete. Reconcile every row to current evidence under R00 and update mappings when work is split. The approved JSON/HTML remains authoritative if later reviewed specifications change.

### 8.1 Requirements

All requirements also depend on R00 inventory, R01 boundary review where affected, R02 contract integrity, R26 mobile parity and R29 final acceptance. Conditional/deferred requirements require an explicit disposition; they are not unconditionally enabled.

#### MOD-A - SaaS administration, identity and billing

**Milestone:** M1–M2. **Specification owner:** W01 + W03.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-A-001 | Provision an organization through a durable job: seed built-in roles, six configurable pipeline stages, default lead source and business profile; expose pending/ready/failed state. Invitations use a hashed, expiring, one-use token and require the signed-in verified email to match the invitation. | R04, R05, R08 |
| MOD-A-002 | Support owner, organization manager, agent, marketing editor, billing administrator and read-only analyst role presets. Permission codes come from the API catalog; scope is own/team/organization. Custom roles cannot grant rights the caller cannot delegate. Lock the organization row during owner changes and reject removal or demotion of its final active owner. | R05 |
| MOD-A-003 | Offer organization, office, member and business-profile management with optimistic versions, audit events and visible entitlement limits. An identity may belong to multiple organizations; the active organization selector changes all data, cache and job contexts together. | R05, R26 |
| MOD-A-004 | Show account subscription, enabled/pending/disabled capabilities, invoices, annual invoice total and monthly equivalent separately. Preview plan changes, cancellation/resumption, proration, currency, taxes and effective date; require an unexpired preview and explicit acceptance before a financial operation. | R08 |
| MOD-A-005 | Stripe webhook reconciliation determines billing state; application entitlements remain explicit records. Duplicate or out-of-order events trigger a current provider-state read, not timestamp-only entitlement changes. Failed provisioning never becomes ready merely because payment succeeded. | R08 |
| MOD-A-006 | Super administrators see organization health, provisioning jobs, feature configuration, subscription reconciliation, redacted audit logs and operational summaries. Access to customer records requires a time-bound, reasoned grant and visible staff-session banner; it is not an ordinary tenant role. | R04, R05, R10 |

#### MOD-B - Agent workspace, activity and appointments

**Milestone:** M2. **Specification owner:** W02 + W03.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-B-001 | Render assigned lead activity, overdue/today/upcoming tasks, appointments, pipeline summary, notifications and website/campaign health. Default scope is the current agent; permitted team/organization views are explicit selectors. | R09, R23 |
| MOD-B-002 | Every KPI includes definition/version, period, timezone, numerator/denominator where relevant, source and refresh time. Loading, empty, unavailable and ineligible states remain distinct; zero is a valid measured value. | R09, R23 |
| MOD-B-003 | Actions open an existing lead/task in a drawer with a shareable route. Quick actions use the same authorization and validation as full pages. Preferences affect layout only, not data-access scope. | R06, R09 |
| MOD-B-004 | Appointments reflect verified scheduling/cancellation events. The platform initially integrates a scheduling provider; it does not infer that a booking iframe synchronizes with CRM. Display organization and user timezone labels when they differ. | R09, R17 |
| MOD-B-005 | Notifications are member-owned and can be read without altering the underlying lead. Poll job/notification status initially; add server-sent events only after traffic measurements justify the extra connection lifecycle. | R09, R26 |

#### MOD-D - CRM, leads, deals, tasks and routing

**Milestone:** M2. **Specification owner:** W04.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-D-001 | Separate contact identity/channels from a lead opportunity and a deal. Maintain normalized email/phone values, source attribution, optional user-provided intent/timeline, tags, stage history, notes and a communication/activity timeline. Unknown values remain unknown. | R06, R07 |
| MOD-D-002 | Provide saved list filters, server pagination, column preferences, bulk selection scope, lead detail drawers and a pipeline view. Default stages are Uncontacted, Attempted Contact, Nurturing, Dead, Under Contract and Closed; organizations can configure their own immutable stage IDs. | R06 |
| MOD-D-003 | Routing precedence defaults to first-touch owner, listing-attributed agent, geography, then weighted round robin. Evaluate only active eligible members; serialize distribution state, record the winning rule and fall back to an unassigned queue when no recipient is eligible. Office and tenant boundaries apply to every rule. | R06, R18, R19 |
| MOD-D-004 | Score documented engagement signals using a versioned deterministic formula before introducing AI. Show reason codes and last event time; score is sales follow-up prioritization, never housing eligibility, protected-attribute inference or mortgage approval. | R06, R23 |
| MOD-D-005 | CSV imports require a scoped signed upload, mapping, preview, row errors, duplicate candidates and an explicit reviewed merge/skip policy. Commit the accepted snapshot with an idempotency key; do not merge automatically across organizations or solely because a household shares a phone. | R07, R13 |
| MOD-D-006 | Exports run as jobs with source-scope authorization at request and download, short-lived artifact access, spreadsheet-formula neutralization and audit. Archiving a contact/lead cancels eligible pending sends and marks public organizer relationships according to the retention plan. | R07, R15, R17, R19, R20 |
| MOD-D-007 | Tasks require assignee, title, due instant and IANA timezone. Stage, owner and note changes use If-Match or expected version, preserve historical events and return conflict instead of silently overwriting another agent. | R02, R06 |

#### MOD-C - Real estate website builder, content, domains and forms

**Milestone:** M3. **Specification owner:** W05 + W02.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-C-001 | Use Puck as an editor component behind an adapter; retain platform-owned block documents, schemas and renderer. Ship independently designed agent, brokerage and landing template families. Template definitions are versioned repository assets; tenant customizations become content revisions. | R11 |
| MOD-C-002 | Allow page, blog, landing, community, agent and testimonial documents with navigation, slug, SEO title/description, canonical path, social image and noindex settings. Offer hero, text, image, CTA, agent, testimonials, community, listing grid, search, form, map and footer blocks. | R11, R14, R25 |
| MOD-C-003 | Save drafts as immutable revisions with optimistic document versions. Publish validates every block, image right, link, form and MLS capability, then atomically updates the revision pointer and emits cache invalidation. Preview and production have distinct hostnames and signed preview access; rollback republishes an existing compatible revision. | R01, R11, R12, R13 |
| MOD-C-004 | Unknown/older blocks preserve their data and render a safe editor warning; they cannot be silently dropped or published until migrated. Arbitrary scripts, SQL, unsafe HTML, remote fetch URLs and free-form executable custom CSS are excluded from the initial block contract. | R11 |
| MOD-C-005 | Custom domains require ownership verification, a globally unique normalized hostname, TLS provisioning and exact host→site→organization mapping. A verification job never grants a hostname based on an unverified client claim. Detach revokes routing and certificates before the domain can be reassigned. | R12 |
| MOD-C-006 | Media uploads are signed, tenant-prefixed, capped and MIME-sniffed, scanned before publication, transformed into responsive derivatives and attached to a rights attestation. Originals remain private unless explicitly permitted; SVG uploads are rejected or sanitized by a vetted pipeline, not embedded as executable user HTML. | R13 |
| MOD-C-007 | Versioned form schemas define labels, required fields, bounds, select choices, honeypot/challenge, purpose-specific consent and confirmation. Server validation uses the published version. A durable transaction stores the entry, lead decision and outbox event before acknowledging. Ordinary form entry permits paste and accessible validation. | R14 |
| MOD-C-008 | Initial forms do not offer public file uploads or pricing/payment fields. The API upload grant is staff-authenticated; public visitor file uploads require a later quota, scanning and abuse review. These are deferred from the reference Gravity Forms library rather than accidentally promised. | R13, R14 |
| MOD-C-009 | Public rendering is server-produced and SEO-friendly. Property blocks use approved public listing projections; a provider supporting only embeds cannot be presented as native searchable feed data. Hidden/deleted/expired listings invalidate page, map, image and alert caches. | R11, R14, R18, R19 |

#### MOD-E - Marketing, campaigns, consent and automation

**Milestone:** M4. **Specification owner:** W06.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-E-001 | Support reusable email/SMS designs, broadcast segment previews, send-later, drip campaigns, birthday/transaction-anniversary greetings and enrollment tables. Email design uses Unlayer when licensed; design JSON and rendered HTML are versioned together through EmailEditorAdapter. | R16, R17, R25 |
| MOD-E-002 | Workflow nodes are wait/email/SMS/condition/task; graphs contain at most 100 nodes, one entry and no cycles. Conditions use an allowlisted lead-filter/event DSL, not arbitrary code. Preview runs on a deterministic virtual clock and identifies required channel/entitlement prerequisites. | R15, R16 |
| MOD-E-003 | Triggers include captured lead, property inquiry, saved search, favorite, stage change and anniversary. Enrollment policies are once, after completion, or after configured inactivity. Published versions are immutable; edits affect future enrollments unless an explicit migration/cancellation is approved. | R15, R16, R20 |
| MOD-E-004 | Store scheduled actions durably in PostgreSQL. BullMQ/Redis dispatches wake-ups, not the only copy of a schedule. Workers acquire bounded leases, validate tenant scope, version, entitlement, contact archive state, consent, suppression, sender verification and quiet hours immediately before provider submission. | R03, R15, R17 |
| MOD-E-005 | Email uses a proposed Resend adapter; SMS uses a proposed Twilio adapter with registration/opt-in gates. Development uses a no-delivery transport. Sender domain/number readiness is a real state, not inferred from a campaign active flag. Vendor callbacks determine submitted/delivered/bounced/failed; opens are explicitly non-guaranteed engagement signals. | R10, R17 |
| MOD-E-006 | Idempotency covers native actions and provider request keys, but provider guarantees are capability-specific and time-limited. A timed-out send with uncertain acceptance becomes unknown; reconcile with the provider before resubmission. Never promise universal exactly-once delivery. | R15, R17 |
| MOD-E-007 | Opt-outs produce a suppression/withdrawal event before further marketing work is eligible. Cancelled enrollments invalidate pending generation keys; already accepted provider sends may be unretractable and must be shown accurately. Replies and STOP-like events follow the approved provider/consent policy. | R07, R17, R20 |
| MOD-E-008 | Quiet hours use the recipient’s known IANA timezone or an organization fallback with visible policy. For calendar schedules, choose the first valid instant after a spring gap and the earlier occurrence in a fall overlap; record the choice and execute once. Anniversary schedules define leap-day behavior explicitly. | R15, R17 |

#### MOD-F - Property search, organizer and Las Vegas MLS

**Milestone:** M1 contract; M5 mock; M6 live gate. **Specification owner:** W07.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-F-001 | Implement the MlsAdapter contract with a mock provider first. Each feed declares replication, live query, embedding, incremental/deletion and media-caching capabilities. Native ingestion is used only where authorized; proxy-only and embed-only providers have explicit feature limits. | R18, R21, R22 |
| MOD-F-002 | Normalize provider/board/source listing keys, source status, price/currency, address, coordinates, property type, bedrooms/baths, area units, public remarks, media, attribution, modification time and display restrictions. Preserve source fields needed for mapping internally; never expose raw agent/private fields. | R18, R22 |
| MOD-F-003 | Provide list/map search, location/bounding-box filters, price/type/bed/bath filters, safe keywords, pagination, stable sorting, details and a property inquiry. Map and list use the same filtered result definition; hidden addresses also hide exact coordinates according to the approved policy. | R18, R19 |
| MOD-F-004 | Saved properties/searches are owned by a site-bound verified visitor. Listing changes generate deduplicated alert matches; before notification, recheck feed permission, listing availability, alert preference and consent. Inquiry capture routes through the native CRM with source and listing provenance. | R19, R20 |
| MOD-F-005 | Incremental synchronization follows opaque provider paging/cursors, handles identical timestamps and overlap, upserts idempotently and advances a checkpoint only after durable processing. Deleted/withdrawn data disappears promptly through listing state, caches, search indexes and scheduled alerts. Missing deletion support requires contract-approved reconciliation. | R18, R22 |
| MOD-F-006 | DisplayPolicy governs field/status visibility, attribution, refresh/freshness, retention, cache, images and AI use. Unknown contract rights default to disabled; independent regional adapters do not share tenant/feed data without explicit licensed authorization. | R18, R21, R22 |
| MOD-F-007 | The project owner selected CoreLogic Trestle (now Cotality Trestle) as the provider on 10 October 2026. Target its documented RESO WebAPI adapter; approved Las Vegas connection details and credentials arrive at M6. Confirm the actual board, feed product, participant permissions, endpoint, accessible metadata and display/retention/media rights then; public documentation does not establish account authorization. | R21, R22 |
| MOD-F-008 | Every mock record/page/map result and exported sample is marked SYNTHETIC DEMO DATA. The production live-feed configuration rejects mock connections and synthetic records; mock listing changes can only drive no-delivery transport in development/staging. | R18, R19, R22 |

#### MOD-G - Reporting, attribution and product analytics

**Milestone:** M2 basics; M7 advanced. **Specification owner:** W08.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-G-001 | Define website session/page engagement, captured/qualified leads, contact rate, stage conversion, campaign submitted/delivered/bounced/clicked activity, pipeline value and listing engagement. Separate counts, unique entities, cohorts and estimates. | R09, R23 |
| MOD-G-002 | Metric definitions are versioned JSON contracts with event source, numerator, denominator, exclusion rules, deduplication, timezone and freshness. Initial aggregates live in PostgreSQL; introduce a warehouse/search service only after measured query/retention limits. | R02, R23 |
| MOD-G-003 | Campaign conversion joins eligible events to a documented attribution window and reports unattributed records. Email opens may be affected by privacy proxies; never equate opens with confirmed human reading or business conversion. | R23 |
| MOD-G-004 | Reporting filters and exports respect underlying agent/team/organization permissions. Raw form/chat payloads and full contact records do not enter anonymous traffic telemetry. Respect approved analytics consent and collection configuration. | R07, R14, R23 |
| MOD-G-005 | Display data source, last refresh and unavailable status. Provider metrics retain their original source/window; publisher coverage is reported separately from actual search visibility or AI assistant answers. | R09, R23, R25 |
| MOD-G-006 | Provide period comparisons, funnel and pipeline views, campaign/listing drill-down and account operational health. Initial reports are bounded synchronous queries; heavy exports become scoped durable jobs. | R23 |

#### MOD-H - Assistive AI and competitive intelligence

**Milestone:** M7. **Specification owner:** W09.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-H-001 | Provide optional page/blog drafts, property descriptions, campaign drafts, lead activity summaries, workflow suggestions and analytics explanations. Each job records purpose, requester, context references, prompt/model configuration version, usage, warnings and expiry. | R24 |
| MOD-H-002 | Use a server-side OpenAI Responses API adapter with schema-constrained outputs and a configured model selected through evaluation. Do not hard-code a marketing model name as a permanent default. Handle refusal, incomplete output, timeout and schema-invalid results without applying a partial result. | R24 |
| MOD-H-003 | Retrieve only tenant-scoped, permission-filtered facts, with an explicit MLS AI-use flag where listing data is involved. Distinguish source facts from generated prose; citations point to verified fields/documents and cannot be fabricated by accepting model-provided IDs blindly. | R21, R22, R24 |
| MOD-H-004 | Acceptance of a draft checks the destination write permission and expected revision, then saves a draft/version through the domain service. It never publishes, sends a campaign, changes consent, modifies a billing plan or acts on a lead merely because an AI job succeeded. | R11, R16, R24 |
| MOD-H-005 | Lead qualification assistance summarizes voluntarily supplied intent/timeline and interaction history. It must not infer protected characteristics, decide access to housing/credit, or score financial eligibility. Humans review follow-up recommendations. | R06, R24 |
| MOD-H-006 | A conversational public-site assistant is a separate later opt-in capability: public published content and permitted listings only, no CRM/customer retrieval. Begin with read-only FAQ/property answers, citations and handoff; property inquiries use the standard consent-aware form, not a hidden AI side effect. | R24 |
| MOD-H-007 | Analytics explanations include actual metric definitions and computed values; the model does not calculate financial/KPI truth from prose. A provider-neutral guard prevents arbitrary URL fetching, unapproved tool use and cross-tenant retrieval induced by listing or user prompt injection. | R23, R24 |
| MOD-H-008 | Require per-organization cost/request caps, bounded context/output, redacted telemetry, configurable retention and an approved provider data agreement. store:false reduces response persistence where supported but is not a promise of zero provider retention. | R24, R28 |

#### MOD-I - Local presence, brand assets and optional creative services

**Milestone:** M7 extension. **Specification owner:** W10.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-I-001 | Maintain a canonical business profile for identity, contact, hours, categories, media and social links. A Yext adapter is the proposed first network provider; integration rights and API scope require procurement verification. | R05, R25 |
| MOD-I-002 | Profile changes create versioned synchronization jobs with validation, provider errors, retry/reconciliation and last-success indicators. Publisher listing health and duplicate/review references are distinct data domains. | R10, R25 |
| MOD-I-003 | Report publisher sync coverage, reviews/reputation and source-specific visibility metrics with definitions. Any real query-based AI visibility tracking is a separate explicit measurement feature, not renamed directory coverage. | R23, R25 |
| MOD-I-004 | Google Business connection, social scheduling and review-response workflows remain capability/permission gated. AI-assisted review responses are drafts that require human approval and a provider-supported publication method. | R24, R25 |
| MOD-I-005 | Reusable brand kits and email/page templates are launch features. Standalone print fulfillment, design packs, mortgage-specific products and advanced creative editors are deferred until product demand, licensing and fulfillment behavior are verified. | R11, R16, R25 |

#### MOD-J - Support, integration operations and account health

**Milestone:** M2 basics; ongoing. **Specification owner:** W03 + W10 + W11.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-J-001 | Create/read scoped support tickets with subject, category and detailed description; maintain a ticket-event timeline with actor and status. Attachments are deferred until the upload/retention pipeline supports them. | R10 |
| MOD-J-002 | Expose customer-safe integration status and jobs: queued/running/succeeded/failed/unknown, attempts, last success, safe error code and recommended action. Never display secrets, provider raw payloads or another organization’s support record. | R10 |
| MOD-J-003 | Provide staff dashboards for failed provisioning, billing/feed reconciliation, sender eligibility, expired domains and worker lag. Replay is an explicit audited domain action with idempotency and scope validation, not a generic rerun-any-payload button. | R05, R10, R28 |
| MOD-J-004 | Document onboarding and contextual help. Replace reference achievement/help clutter with task-relevant learning; do not assume a tutorial link means the named service is integrated. | R09, R10 |

#### MOD-K - Full web application and installable iPhone/Android experience

**Milestone:** M1 foundation; M2–M7 workflow parity; M8 device gate. **Specification owner:** W12 + W02 + W11.

| Requirement | Approved requirement text | Execution tasks |
| --- | --- | --- |
| MOD-K-001 | Implement an HTTPS Progressive Web App using Next.js manifest support, an original icon set, display:standalone, stable manifest id, start URL, app scope and service worker. The workspace remains usable in ordinary browsers without installation. No native wrapper or app-store submission is part of the architecture. | R26, R27 |
| MOD-K-002 | Provide platform-appropriate installation guidance: iPhone browser share/menu Add to Home Screen and Android Install/Add to Home Screen. Detect install capability and standalone mode; never show a nonfunctional universal install button or block use behind installation. | R26 |
| MOD-K-003 | Make every entitled workflow usable at 360px and larger: CRM capture/edit/tasks, dashboards, builder draft/preview/publish, campaign edit/preview/confirm, property search/inquiry/organizer, reports, settings and authorized administration. Complex canvases have accessible list/form alternatives; do not require a desktop to complete core commands. | R26 |
| MOD-K-004 | Respect device safe areas, dynamic viewport height, orientation, virtual keyboards, touch targets, screen readers and system text enlargement. Preserve deep links and navigation history; reauthenticate safely after suspension, external OIDC and hosted billing flows. | R04, R26 |
| MOD-K-005 | Cache only approved static application assets and a generic offline screen. Initial release is online-first: no private CRM, session tokens, personalized HTML/RSC, messages, exports, AI results or MLS data in service-worker caches or IndexedDB. Offline mutations are visibly disabled and never reported as saved. | R26, R28 |
| MOD-K-006 | Preserve unsaved changes in current tab memory during brief connection loss and warn before navigation/update; process eviction may discard them. After reconnection refetch versions and permissions. Durable offline editing/synchronization is deferred to a separately reviewed data-conflict/security design. | R06, R11, R16, R26 |
| MOD-K-007 | Use versioned static asset caches and a waiting-worker update notice. Never force reload while a draft is dirty or a payment/publish/send confirmation is in flight. Reload only after user acceptance or a safe idle transition, and remove obsolete non-sensitive caches. | R26 |
| MOD-K-008 | Offer opt-in standards-based Web Push for assigned-lead, task-due and job-failure notices where supported; the in-app inbox remains authoritative. Check capabilities and user gesture, handle denied permission, and keep lock-screen text generic with no contact/property details. | R26 |
| MOD-K-009 | Store encrypted, tenant/member-scoped push subscriptions and revoke devices on explicit removal/logout and membership revocation. Validate HTTPS push endpoints against approved provider egress policy; reject local/private hosts. VAPID private keys are server secrets; push clicks open allowlisted same-origin deep links and recheck authorization. | R04, R10, R26 |
| MOD-K-010 | M8 requires physical iPhone Safari/browser and installed-home-screen tests, plus Android Chrome/browser and installed tests. Cover sign-in, organization switching, all core workflows, interruptions/offline, SW upgrades, denied push, device removal, keyboard/safe-area behavior and no sensitive persistent caching. | R26, R27, R29 |

### 8.2 Module acceptance criteria

Acceptance IDs use the TDD workstream convention MOD-X-AC-n; the text below is copied from each module acceptance array. A checkbox is not evidence. Record exact passing suites, source and approvals against each ID.

#### MOD-A acceptance

**Execution:** R04, R05, R08, R10, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-A-AC-1 | Given a member of organizations A and B, selecting A never returns B leads, jobs, exports, assets or notifications; a fabricated organization ID returns 404/403 with no data. |
| MOD-A-AC-2 | Two concurrent requests to remove the last owners cannot leave an organization without one. Invitation replay, expired token and wrong verified email all fail. |
| MOD-A-AC-3 | Repeated subscription confirmation creates one operation; a stale preview or changed entitlement version fails. A failed provider provision remains pending/failed with actionable support context. |
| MOD-A-AC-4 | A staff user without a valid scoped grant cannot read tenant CRM data. Expired/revoked grants fail on API and worker boundaries. |

#### MOD-B acceptance

**Execution:** R06, R09, R17, R23, R26, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-B-AC-1 | An empty account shows onboarding and empty states without fabricated engagement or hours-saved values. |
| MOD-B-AC-2 | Dashboard totals reconcile with the same scoped CRM/report query for the same time window; expired integrations display unavailable rather than zero. |
| MOD-B-AC-3 | Task completion updates the task and emits one activity/audit event; a unauthorized quick action fails identically to its full-page equivalent. |
| MOD-B-AC-4 | A booking cancellation delivered twice leaves one cancelled appointment, with UTC storage and correct America/Los_Angeles daylight-saving display. |

#### MOD-D acceptance

**Execution:** R01, R06, R07, R15, R17, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-D-AC-1 | A captured inquiry retries twice but creates one submission/event and one deduplicated lead decision with source provenance. |
| MOD-D-AC-2 | A listing agent in another organization cannot become owner. Disabled members and round-robin race conditions are handled without lost or cross-office assignments. |
| MOD-D-AC-3 | A stale lead/task update returns 412; the existing event history remains intact. Archived leads do not receive new marketing enrollments. |
| MOD-D-AC-4 | Import preview/commit yields deterministic counts and cannot commit changed input under the same preview. Formula-like export cells are safe to open in a spreadsheet. |
| MOD-D-AC-5 | Contact merging preserves consent provenance and reports conflicting grants/withdrawals; withdrawal wins until a later valid grant is verified. |

#### MOD-C acceptance

**Execution:** R11, R12, R13, R14, R26, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-C-AC-1 | An editor can save a draft without publishing. Two editors changing the same document receive a conflict rather than losing content; rollback reproduces the selected published revision. |
| MOD-C-AC-2 | A malicious block/link/media URL or executable HTML is rejected; unsupported blocks remain recoverable. The public page cannot access another tenant’s media or draft revision. |
| MOD-C-AC-3 | Two organizations cannot claim the same hostname, including case/IDN-normalized variants. A spoofed Host header or unverified domain cannot select customer data. |
| MOD-C-AC-4 | A form retry records one lead decision and one consent evidence set. An unrecognized field, invalid published version, malicious size or unavailable commit returns a defined error without false success. |
| MOD-C-AC-5 | Published pages include correct canonical/robots/Open Graph and permitted listing attribution, with tested 360/768/1440px layout and keyboard block editing. |

#### MOD-E acceptance

**Execution:** R03, R15, R16, R17, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-E-AC-1 | A worker crash, duplicate event or Redis loss does not lose the PostgreSQL schedule. Recovery does not create duplicate native action keys. |
| MOD-E-AC-2 | Withdrawal between audience preview and execution blocks the send. Disabled texting, missing consent or suspended entitlement never displays a successful delivery. |
| MOD-E-AC-3 | Unknown provider acceptance cannot enter the normal blind-retry path. Duplicate/out-of-order receipts do not regress delivered to submitted. |
| MOD-E-AC-4 | Virtual-clock tests cover wait delays, cancel/restart generations, quiet hours, leap-day handling and both daylight-saving transitions. |
| MOD-E-AC-5 | Publishing a graph with cycles, missing designs, invalid merge fields or inaccessible segments fails with node-specific errors. |

#### MOD-F acceptance

**Execution:** R18, R19, R20, R21, R22, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-F-AC-1 | The same application search contract works with mock and a capability-compatible live adapter without changing CRM, builder or organizer primary keys. |
| MOD-F-AC-2 | The mock suite covers active→pending→off-market, deletion, address suppression, no media, partial pages, expired token, 429, equal timestamps and retry after crash. |
| MOD-F-AC-3 | A failed page leaves the checkpoint at its last successful boundary. Replayed pages do not duplicate listings, alert matches or inquiry leads. |
| MOD-F-AC-4 | Expired, disallowed or stale-beyond-policy records do not appear in list, map, details, images or outbound alerts. Hidden address fields are not leaked through SEO/JSON-LD or coordinates. |
| MOD-F-AC-5 | M6 cannot exit without source-field mapping, signed-off display policy, permitted media/cache behavior, partner acceptance evidence and live synchronization monitoring. |

#### MOD-G acceptance

**Execution:** R23, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-G-AC-1 | A deterministic event fixture produces documented KPI numerator and denominator; duplicate and late events produce stable corrected aggregates. |
| MOD-G-AC-2 | Report row data and totals cannot exceed a caller’s CRM scope. Day boundaries and comparisons match the selected IANA timezone. |
| MOD-G-AC-3 | Unknown/missing provider statistics display unavailable and cannot be averaged into a synthetic success score. |
| MOD-G-AC-4 | An exported report includes metric version, scope, timezone, source period and last refresh; changing a definition preserves old report provenance. |

#### MOD-H acceptance

**Execution:** R24, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-H-AC-1 | A generated claim absent from source facts is rejected or flagged by the evaluation workflow; source IDs must exist and be readable by the requester. |
| MOD-H-AC-2 | A malicious property description cannot cause a tool call, another tenant’s retrieval or an autonomous write/send. |
| MOD-H-AC-3 | A cancelled/refused/incomplete job leaves source records unchanged. Accepting a result fails if the destination version or permission changed. |
| MOD-H-AC-4 | Evaluation sets cover factuality, protected-attribute/eligibility requests, PII disclosure, prompt injection, useful abstention, schema compliance, cost and latency. |
| MOD-H-AC-5 | No AI feature is enabled in production until its evaluation thresholds, data rights, provider retention and user-review flow are accepted. |

#### MOD-I acceptance

**Execution:** R25, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-I-AC-1 | A provider failure leaves a visible pending/failed job and never silently rewrites the business profile on an ordinary page view. |
| MOD-I-AC-2 | Publisher coverage cannot be labeled as actual AI answer visibility. Unavailable/gated review metrics remain outside any numeric denominator. |
| MOD-I-AC-3 | A drafted review response cannot be submitted without a permitted human publication action and provider capability. |

#### MOD-J acceptance

**Execution:** R05, R10, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-J-AC-1 | A customer cannot retrieve another tenant’s ticket or raw provider error. A staff action records actor, grant, purpose, affected resource and trace ID. |
| MOD-J-AC-2 | Replay of a completed idempotent job cannot duplicate customer state or sends; unknown provider acceptance requires reconciliation before any retry. |
| MOD-J-AC-3 | Onboarding accurately distinguishes unconfigured, pending authorization, ready and degraded integrations. |

#### MOD-K acceptance

**Execution:** R26, R27, R29.

| Acceptance ID | Required behavior |
| --- | --- |
| MOD-K-AC-1 | The application installs and launches standalone on a physical iPhone and Android device without an app-store listing; all entitled core commands have usable mobile paths. |
| MOD-K-AC-2 | An interrupted request never displays saved/completed without durable server acknowledgment; reconnection resolves idempotency and stale revisions safely. |
| MOD-K-AC-3 | After viewing contacts, billing, AI and listing details, CacheStorage/IndexedDB contain no sensitive API or personalized page data; logout/account switch cannot expose earlier user data offline. |
| MOD-K-AC-4 | A waiting service-worker update does not discard dirty editor content or duplicate a submitted command. Browser-tab use works when installation or push is unavailable. |
| MOD-K-AC-5 | Revoked/expired devices receive no new customer notices; lock-screen payloads and routes reveal no contact details and cannot bypass authentication. |

### 8.3 Exact milestone exit gates

| Milestone | Approved exit gate | Execution |
| --- | --- | --- |
| M1 - Foundation | Contracts validate; empty database migrates; tenant/identity role tests pass; deterministic fixtures and no-delivery transport work; preview CI is isolated. | R00-R03, R04 test identity, R26 foundations |
| M2 - Core SaaS and CRM | Invite/tenant-switch/last-owner tests; capture→assignment→follow-up; scoped import/export; billing webhook reconciliation; no cross-tenant output. | R04-R10, R23 basics, R26 |
| M3 - Website builder and public sites | Draft never publishes; revision conflict recovery; domain ownership/unique-host tests; validated form creates one lead; responsive/keyboard public pages. | R11-R14, R26 |
| M4 - Marketing and automation | Virtual-clock/restart/withdrawal/Redis-recovery tests pass; approved sandbox recipients only; live transport remains disabled until provider and consent review. | R15-R17, R03 recovery, R26 |
| M5 - IDX/MLS preparation | All samples visibly synthetic; mock lifecycle/paging/deletion/token/429 tests; expired-policy data suppressed; search→inquiry→CRM and organizer ownership pass. | R18-R20, R14 capture, R26 |
| M6 - Live Las Vegas integration | Written policy approval; mapping/transport contract tests; live freshness/withdrawal/cache validation; approved attribution screenshots; synthetic/live separation; provider monitoring and rollback evidence. | R21-R22 |
| M7 - AI, advanced reporting and differentiation | Evaluation thresholds, review-only acceptance, source/permission checks, cost caps, provider data agreement; reconciled metrics and honest visibility definitions. | R23-R25, R26 |
| M8 - Production readiness and controlled rollout | Measured SLOs; recovery drill meets approved RPO/RTO; no critical tenant/data-rights defects; operational ownership and owner-authorized release; live feed compliance accepted. | R26-R29 and all launch-scope acceptance |

### 8.4 Invariants and integrated workflows

| Invariant | Approved rule | Evidence tasks |
| --- | --- | --- |
| INV-01 - Verified context | Identity, membership, tenant, row scope and entitlement are verified at request and job execution. A tenant ID supplied by a browser is never authorization. | R01, R04, R05, R06, R10, R29 |
| INV-02 - Database boundary | Business FKs contain tenant_id; PostgreSQL runtime roles cannot bypass RLS or own tables. Every pooled transaction sets local verified context; missing context denies access. | R01, R02, R03, R28 |
| INV-03 - One durable command | Idempotency keys bind actor, tenant, operation and canonical input hash. Domain changes and outbox events commit in the same PostgreSQL transaction. | R02, R06, R14, R15, R17, R18 |
| INV-04 - Explicit versions | Content, forms, campaigns, metrics, routing policies, provider mappings, prompts and display policies are versioned. Conflicting edits never silently overwrite. | R02, R06, R11, R15, R23, R24 |
| INV-05 - Delivery eligibility | Sending checks current consent, suppression, resource state, scope, entitlements, quiet hours and provider readiness at dispatch. Unknown provider acceptance requires reconciliation. | R07, R15, R17, R20 |
| INV-06 - MLS rights before visibility | Unknown permissions mean deny. Data display, media storage, caches, alerts, retention and AI use are independently gated by approved provider rights. | R18, R19, R20, R21, R22, R24 |
| INV-07 - Synthetic development | Until authorized connectivity, the only MLS source is the mock adapter and conspicuously fictional fixtures. Production live adapters reject synthetic data. | R18, R19, R21, R22, R27 |
| INV-08 - Human AI control | AI proposes drafts; acceptance saves a reviewed draft only. Publishing, sending, billing and consent changes remain explicit authorized commands. | R24, R25 |
| INV-09 - Truthful outcomes | A queued operation is not a completed operation. Unknown, zero, unavailable and stale metrics are different states with timestamps and definitions. | R09, R10, R13, R16, R23 |
| INV-10 - No hidden cross-module writes | Module service ports and versioned events are the integration boundaries. Consumer modules do not directly mutate another module’s tables. | R01, R02, R05, R14, R15, R24 |
| INV-11 - Revocation applies everywhere | Revoked membership, staff grants, visitor sessions, feeds or consents invalidate future requests, jobs and signed downloads. | R04, R07, R10, R17, R19, R20, R26 |
| INV-12 - Evidence and proposed behavior | Audit observation, inferred technology and proposed architecture remain labeled. Runtime, licensing and commercial assumptions need their milestone gates. | R00, R21, R27, R29 |

| Flow | Integrated acceptance path | Execution |
| --- | --- | --- |
| FL-01 | Public form capture, consent, routing and durable outcome | R01, R06, R07, R14, R17 |
| FL-02 | Lead assignment and follow-up | R02, R06, R09 |
| FL-03 | Draft, publication, invalidation and rollback | R11, R12, R13, R14 |
| FL-04 | Campaign preview, explicit confirmation, execution and reconciliation | R15, R16, R17 |
| FL-05 | Policy-safe property search, attribution, inquiry and CRM | R14, R18, R19, R21, R22 |
| FL-06 | Site-bound saved search, licensed matching, preference and alert | R17, R18, R19, R20 |
| FL-07 | Priced billing preview, confirmation and current-state reconciliation | R05, R08 |
| FL-08 | Scoped AI facts, validated draft, human acceptance | R24 |
| FL-09 | Physical install, full mobile work, offline/update recovery | R04, R26, R27 |
| FL-10 | Purpose-bound staff support, audit, expiry and safe replay | R04, R05, R10 |

Every flow needs scope, revoked access, provider-degraded outcomes and browser acceptance on the final source. R28/R29 close cross-cutting security, operational and release evidence.

### 8.5 Scope dispositions

Preserve explicitly approved deferrals and conditional procurement. Do not silently convert launch requirements into deferrals.

- Deferred/conditional: public form file/payment fields; support attachments; WordPress migration; durable offline editing; SSE until measured; warehouse/external search until measured; later opt-in public AI assistant; print fulfillment/design packs/mortgage products/advanced creative; unprocured helpdesk/social/Google Business/review actions and separately measured search/AI query visibility.
- Required launch work: reusable brand kits and email/page templates, all entitled mobile command paths, evaluated review-only AI within approved scope, and all applicable M1-M8 exit gates.
- Document every conditional capability as unavailable/pending until procured/approved and verified. Do not fabricate provider functionality or replace a full requested release with the separate sample demo.

### 8.6 Baseline source fingerprints

SHA-256 captured during handoff preparation. These establish the document snapshot, not runtime or legal acceptance.

| Source | SHA-256 |
| --- | --- |
| docs/tdd/technical-design.json | 73ab6ba7d4a3f1804ed5be99108810b6763822ecd452027ccfda1e94297491bb |
| docs/tdd/real-estate-saas-tdd-2026-10-10.html | 32924aab909d917b23dc1b0ffd1da2398273f677aa02211150f1d6980cfe2ade |
| packages/contracts/openapi.json | 383854a6b94a3343510fa2e557d4c1ac1d669e5c6e56d2ea29f149360d434645 |
| IMPLEMENTATION_STATUS.md | b72b7deda6c79238ad4c81ee6658dc8b5993355e1a458f3af0c63664e162cb5e |
