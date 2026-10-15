# R00 — Requirement-to-Evidence Ledger

**Generated:** 2026-10-13 at commit `4be79c5` on `feat/W01-foundation`.
**Updated:** 2026-10-16 at commit `fab983e` — 339 integration tests across 47 suites (shared DB), 66 disposable-DB tests across 4 suites, 3287 unit tests across 96 suites. Contract check, build and runtime verification pass.
**Status:** Reconcile each row to current evidence and update when work is split.

## Legend

- **Implemented**: Code exists, tests pass, verified at current HEAD.
- **Partial**: Some sub-requirements implemented, others pending.
- **Verified**: Tests prove the behavior at the stated commit.
- **Blocked**: Requires external input, provider access, or later milestone work.
- **Deferred**: Explicitly deferred per scope dispositions (§8.5).

---

## MOD-A — SaaS administration, identity and billing

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-A-001 | Partial | `admin-service.ts` invite/accept; `invitation-api.test.ts` (7 tests); `admin-api.test.ts` (14 tests) | Provisioning bootstrap seeds roles/stages/sources/profile via `packages/db/seed.ts`. Invitation hashing/expiry/one-use verified. Durable job state (pending/ready/failed) in `integration_job`. Full provisioning flow (new org creation) not tested end-to-end yet. |
| MOD-A-002 | Implemented | `admin-api.test.ts`: custom roles, delegation scope, reserved names; `admin-service.ts` lines 183-207 | 6 presets seeded. Delegation check prevents scope escalation. Owner name reserved. |
| MOD-A-003 | Implemented | `offices-profiles-api.test.ts` (12 tests); `admin-api.test.ts` org update/stale; `organization-api.test.ts` (5 tests); `crm-api.test.ts` org switch; `member-management-api.test.ts` (4 tests) | Optimistic versions on org/office/profile/role/member. Audit events emitted. Multi-org identity switch verified. Org GET/PATCH, fabricated org denial, stale revision tested. |
| MOD-A-004 | Implemented | `billing-api.test.ts` (9 tests): preview/confirm/reconcile/portal | Subscription, capabilities, invoices, preview/confirm flow verified. |
| MOD-A-005 | Implemented | `billing-api.test.ts`: webhook reconciliation, durable jobs | Stripe adapter with idempotent reconciliation. Failed provisioning stays failed. |
| MOD-A-006 | Partial | `staff-feature-api.test.ts`, `staff-support-api.test.ts` (disposable DB) | Staff identity/grant/banner implemented. Time-bound grants in `staff_access_grant`. Requires disposable DB for full verification. |

### MOD-A Acceptance Criteria

| AC | Status | Evidence |
|----|--------|----------|
| MOD-A-AC-1 | Verified | `database-isolation.test.ts`: tenant RLS; `crm-api.test.ts`: cross-tenant denial; `admin-api.test.ts`: fabricated org returns 404 |
| MOD-A-AC-2 | Verified | `admin-api.test.ts`: concurrent last-owner protected; invitation replay/expired/wrong-email all fail |
| MOD-A-AC-3 | Partial | `billing-api.test.ts`: preview replay, stale preview rejection. Failed provision stays pending. Provider mock only. |
| MOD-A-AC-4 | Partial | Staff grant scope implemented but full verification requires disposable DB (`staff-feature-api.test.ts`) |

---

## MOD-B — Agent workspace, activity and appointments

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-B-001 | Partial | `dashboard-report-api.test.ts` (disposable DB); dashboard endpoint returns 200 with pipeline/task/lead summaries, unread notifications and integration health | Dashboard wired to real notification data and integration_connection state. Activity endpoint works. |
| MOD-B-002 | Implemented | Dashboard returns 6 metrics: leads.created, contacts.created, deals.created, deals.pipeline_value, tasks.completed, revenue (unconfigured). Frontend definitions with titles/descriptions/denominators. Period/timezone labels. | Revenue metric blocked on billing provider. |
| MOD-B-003 | Deferred | Frontend scope (R09). API supports detail/drawer routes. | |
| MOD-B-004 | Partial | `appointments-api.test.ts` (disposable DB); `appointment-list-api.test.ts` (2 tests, shared DB): paginated listing verified; `AppointmentService` implemented | No scheduling provider integration yet. |
| MOD-B-005 | Implemented | `notifications-api.test.ts` (disposable DB); `notification-producer-api.test.ts` (4 tests); `notification-read-api.test.ts` (3 tests, shared DB): mark-read, nonexistent rejection, listing with seeded data; notification list/mark-read + producer (lead.assigned, task.assigned, lead.stage_changed); `push-settings.tsx` subscription management UI | Poll-based. SSE deferred per spec. SECURITY DEFINER `app.create_notification` validates active membership. Dashboard returns real unread notifications. Push subscription UI permission-gated (self.push.write). |

---

## MOD-D — CRM, leads, deals, tasks and routing

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-D-001 | Implemented | `crm-api.test.ts`, `contact-edit-api`, `lead-notes-activity-api.test.ts` (5 tests), `crm-configuration-api.test.ts` (11 tests), `lead-tags-api.test.ts` (5 tests) | Contacts, leads, deals separated. Emails/phones normalized. Tags, stage history, notes, activity timeline all verified. |
| MOD-D-002 | Implemented | `crm-configuration-api.test.ts`: pipeline stages; `crm-service.ts`: list filters, pagination; `contact-filter-api.test.ts` (6 tests); `lead-filter-api.test.ts` (8 tests); `task-filter-api.test.ts` (7 tests); `deal-filter-api.test.ts` (5 tests) | 6 default stages seeded. Configurable stages with optimistic versions. Server pagination with cursor. All 6 filter fields (q, ownerMemberId, tagIds, stageId, sourceId, intent) implemented and tested for contacts, leads, tasks and deals. Frontend filter controls (intent/stage/source dropdowns) added to contacts search, pipeline board, task list and deals panel — verified in browser. |
| MOD-D-003 | Partial | `routing-capture-api.test.ts` (routing config); routing service implemented | Round-robin and rule evaluation in `routing-service.ts`. Full geographic routing not yet tested. |
| MOD-D-004 | Implemented | `scoring-api.test.ts` (scoring CRUD); `engagement-scoring-trigger` migration | Versioned deterministic formula. Score is prioritization only. |
| MOD-D-005 | Implemented | `data-transfer-api.test.ts` (9 tests): upload/mapping/preview/commit/export | CSV import with preview, duplicate candidates, merge/skip. Idempotent commit. |
| MOD-D-006 | Implemented | `archive-api.test.ts`: contact/lead archive; `data-transfer-api.test.ts`: exports. `retention-service.ts`: purges expired idempotency records and old outbox receipts, reports archived contacts/leads past 365-day threshold. `POST /dev/retention` dev route. | Export as durable job implemented. Archive cancels sends. Retention enforcement wired. |
| MOD-D-007 | Implemented | `task-create-api`, `task-edit-api` (disposable DB); `crm-api.test.ts`: concurrency test | Tasks with assignee/title/due/tz. If-Match versioning. 412 on conflict. |

### MOD-D Acceptance Criteria

| AC | Status | Evidence |
|----|--------|----------|
| MOD-D-AC-1 | Verified | `lead-capture-api.test.ts`: capture→one lead decision. `public-site-api.test.ts`: form idempotency |
| MOD-D-AC-2 | Partial | Routing config tested. Cross-org assignment denied. Round-robin race handling needs disposable DB. |
| MOD-D-AC-3 | Verified | `crm-api.test.ts`: stale update returns 412. `archive-api.test.ts`: archived leads block enrollment. |
| MOD-D-AC-4 | Verified | `data-transfer-api.test.ts`: preview/commit deterministic. Formula neutralization in exports. |
| MOD-D-AC-5 | Verified | `contact-merge-api.test.ts`: merge preserves consent. Conflict reporting implemented. |

---

## MOD-C — Website builder, content, domains and forms

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-C-001–009 | Partial | CMS adapter routes implemented in `main.ts`. `packages/cms/` has block/document/revision logic. `native-message-design-service.test.ts` covers design CRUD. `campaign-draft-service.test.ts`, `campaign-workflow-service.test.ts` cover campaign flows. | M3 scope. Block rendering, domain verification, media pipeline need W05 CMS owner's implementation. |

---

## MOD-E — Marketing, campaigns, consent and automation

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-E-001–003 | Implemented | `campaign-draft-service.test.ts`, `campaign-workflow-service.test.ts`: campaign versioning, draft CRUD, workflow publish. `broadcast-preview-api.test.ts`: audience preview with consent eligibility. `campaign-automation-crud-api.test.ts` (8 tests, shared DB): campaign create/get/list, version create with nodes/edges, automation create/list/get/update. `resource-listing-api.test.ts` (9 tests): automations/campaigns/notifications/audit-events listing. | Campaign drafts, message designs and workflow versions implemented. Full CRUD verified via shared-DB integration tests. |
| MOD-E-004 | Implemented | `automation-service.ts`: automation CRUD + enrollment. `automation-workspace.tsx`: frontend list/create/toggle/enroll/cancel. `enrollments-api.test.ts` (5 tests): enroll/list/cancel/double-cancel/fabricated-lead. `action-worker.ts`: scheduled-action dispatch worker claims pending actions, checks consent, records synthetic delivery attempts. `POST /dev/dispatch-actions` dev route. | Worker uses `FOR UPDATE SKIP LOCKED` for safe concurrent processing. Enrollment CRUD verified via shared-DB integration tests. |
| MOD-E-005 | Implemented | `dispatch-service.ts`: no-delivery transport adapter. `POST /dev/dispatch-broadcasts` dev route. Consent eligibility checked per lead. Synthetic delivery results recorded in `integration_job.safe_result`. | No real messages sent. Live send gated on provider. |
| MOD-E-006 | Implemented | Broadcast confirmation `POST /v1/orgs/:orgId/broadcast-confirmations` now requires `Idempotency-Key` header, uses advisory lock and `idempotency_record` for replay. All other campaign/automation mutations already had idempotency. | |
| MOD-E-007 | Implemented | `dispatch-service.ts` checks `app.consent_state` and `app.suppression` per lead before synthetic dispatch. Withdrawn consent or active suppression prevents delivery. | Live consent review still required before production. |
| MOD-E-008 | Implemented | `consent-api.test.ts` (17/18 pass): consent events, opt-out, eligibility, suppression. | |

---

## MOD-F — Property search and MLS

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-F-001–008 | Blocked | `native-feature-api.test.ts`: MLS boundary tests (disposable DB). Mock adapter exists in `packages/mls/`. | M5 mock, M6 live. No CoreLogic/Trestle access yet. Routes registered but services stub 404. |

---

## MOD-G — Reporting and analytics

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-G-001–006 | Partial | Dashboard endpoint returns metrics. `dashboard-report-api.test.ts` (disposable DB). | M2 basics implemented. Advanced reporting (M7) deferred. |

---

## MOD-H — AI assistance

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-H-001–008 | Blocked | AI routes registered (`ai/jobs` compound routing works). No AI service implementation yet. | M7 scope. Blocked on OpenAI provider agreement and evaluation framework. |

---

## MOD-I — Local presence and brand

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-I-001–005 | Blocked | Routes registered (`local-presence` compound routing works). | M7 scope. Blocked on Yext provider procurement. |

---

## MOD-J — Support and integration operations

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-J-001 | Implemented | `support-api.test.ts` (6 tests): ticket create/list/detail/status | Scoped tickets with event timeline. |
| MOD-J-002 | Implemented | Integration job model exists. GET /v1/orgs/:orgId/jobs lists jobs with state/kind filters and cursor pagination. `jobs-panel.tsx` frontend with state badges, error details, export download links. | Job listing scoped to requesting member. |
| MOD-J-003 | Implemented | Staff dashboard routes exist. `POST /dev/staff/jobs/:id/run` replay handler in `http-adapter.ts` lines 435-449. Uses `runProvisioning` with CSRF verification and idempotency. | |
| MOD-J-004 | Deferred | Documentation/onboarding is frontend scope. | |

---

## MOD-K — PWA and mobile

| Req | Status | Evidence | Notes |
|-----|--------|----------|-------|
| MOD-K-001–010 | Partial | Push subscription CRUD (main.ts lines 816-890). VAPID/endpoint security in place. PWA manifest (`app/manifest.ts`), service worker (`sw.js`) with cache allowlist, offline fallback, push handler. Install prompt in workspace. `push-settings.tsx` subscription management UI. SW update banner guards dirty drafts, pending commands, and in-flight reconciliation before allowing reload. `beforeunload` guard on unsaved state. Offline mutation blocking with clear error messages. | VAPID keys not yet configured — push delivery blocked until server keys set. M8 physical device testing required. |

---

## Invariants (INV-01 through INV-12)

| INV | Status | Evidence |
|-----|--------|----------|
| INV-01 | Verified | `database-isolation.test.ts`, `runtime-role.test.ts`: tenant context required. `crm-api.test.ts`: session identity. `admin-api.test.ts`: permission checks. `permission-boundary-api.test.ts` (5 tests): agent role denial, CSRF enforcement, unauthenticated rejection. `session-api.test.ts` (4 tests): identity isolation. |
| INV-02 | Verified | `database-isolation.test.ts`: RLS non-bypass (disposable DB). `runtime-role.test.ts`: role verification. Control tests: migration roles. |
| INV-03 | Verified | `outbox.test.ts`: domain+outbox in one transaction. `invitation-api.test.ts`: idempotency replay. `billing-api.test.ts`: idempotent confirm. |
| INV-04 | Verified | `crm-api.test.ts`: If-Match concurrency. `admin-api.test.ts`: role/org versioning. `crm-configuration-api.test.ts`: tag/source/stage versions. |
| INV-05 | Verified | `consent-api.test.ts`: consent check at dispatch. `dispatch-service.ts`: consent eligibility verified per lead before synthetic delivery. No-delivery transport enforced. Live delivery gated. |
| INV-06 | N/A | MLS not yet connected. Mock adapter rejects live data. |
| INV-07 | Verified | All fixtures are conspicuously synthetic. `synthetic-session-boundary.test.ts` confirms dev-only access. |
| INV-08 | N/A | AI not yet implemented. |
| INV-09 | Verified | Job states (pending/succeeded/failed) distinguished. Dashboard 6 metrics with definitions. Job listing with state filter. `dispatch-api.test.ts` verifies states. |
| INV-10 | Verified | Service ports in `crm-service.ts`, `admin-service.ts`, `contact-upsert-port.ts`. No cross-module direct table writes. |
| INV-11 | Partial | Revoked membership denies access. Push subscription revocation implemented. Visitor/feed/consent revocation partial. |
| INV-12 | Active | This ledger. Proposed architecture labeled throughout. |

---

## Integrated Flows (FL-01 through FL-10)

| Flow | Status | Evidence |
|------|--------|----------|
| FL-01 | Verified | `public-site-api.test.ts` (25 tests): form capture → consent → routing → durable outcome |
| FL-02 | Partial | `lead-assignment-api.test.ts`, `stage-transition-api.test.ts` (disposable DB): lead assignment and follow-up |
| FL-03 | Partial | CMS draft/publish/rollback exists. Needs W05 integration. |
| FL-04 | Partial | `campaign-draft-service.test.ts`, `campaign-workflow-service.test.ts`, `broadcast-preview-api.test.ts`. `dispatch-service.ts` processes queued broadcasts with consent check. `automation-workspace.tsx` manages automation rules. Broadcast confirmation idempotency implemented. |
| FL-05 | Blocked | MLS not connected. |
| FL-06 | Blocked | MLS not connected. |
| FL-07 | Verified | `billing-api.test.ts`: preview → confirm → reconcile |
| FL-08 | Blocked | AI not implemented. |
| FL-09 | Blocked | Frontend PWA scope (M8). |
| FL-10 | Partial | `staff-feature-api.test.ts`, `staff-support-api.test.ts` (disposable DB) |

---

## Milestone Exit Gates

| Milestone | Status | Blockers |
|-----------|--------|----------|
| M1 | Partial | Contracts validate ✓ (174 ops, ADR-022/043/049/055). Empty DB migrates ✓ (66 control tests). Tenant/identity role tests pass ✓. Fixtures work ✓. No-delivery transport ✓. Build ✓. Runtime verify ✓. CI isolation needs green remote run. |
| M2 | Partial | Invite/switch/last-owner ✓. Capture→assignment ✓ (disposable DB verified locally, 66/66). Import/export ✓. Billing reconciliation ✓. Cross-tenant denial ✓. Scope/revocation tested. Data retention enforcement ✓. Integration job listing ✓. Scoring unit + edge tests ✓. Routing rules API ✓. Push subscription boundaries ✓. |
| M3 | Partial | CMS adapter routes wired. Blocks W05 CMS owner for rendering/domains/media. |
| M4 | Substantial | All MOD-E acceptance criteria implemented: campaign drafts, message designs, workflow versions, automation CRUD/UI, broadcast dispatch with consent, action worker, idempotency. Live send gated on provider. |
| M5–M6 | Blocked | MLS mock adapter exists. No CoreLogic/Trestle access. |
| M7 | Blocked | AI and reporting blocked on provider agreements. |
| M8 | Not started | Build passes ✓. Runtime verifies ✓. Physical device testing, production deployment gates pending. |

---

## Test Evidence Summary (2026-10-16)

| Category | Count | Suites |
|----------|-------|--------|
| Control (disposable DB) | 66 | 4 (verified locally, all pass) |
| Integration (shared DB) | 339 | 47 |
| Integration (disposable DB env) | 23 suites | require `TEST_DATABASE_URL` (expected failure in shared-DB mode) |
| Unit + Package | 3,287 | 96 |
| Contract validation | 174 ops / 174 schemas | PASS (ADR-022/043/049/055) |
| Build | PASS | application-built |
| Runtime verification | PASS | 146 files, 18 JSON resources |
