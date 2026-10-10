# W06 immutable workflow draft integration

This bounded MOD-E-002/003 slice follows ADR-023 and unchanged generated CampaignVersionWrite/CampaignVersion/PageCampaignVersion contracts. It appends immutable drafts and previews one explicit path with an elapsed clock. Publication, enrollment, message design editing, scheduling, quiet-hour adjustment, sender readiness and delivery remain unavailable. Interactive marketing capability remains disabled.

## Exports and transaction boundary

`packages/marketing/index.ts` exports generated workflow aliases, `validateWorkflowDefinition(definition)` returning readonly safe field issues, and `previewWorkflow(definition, { startInstant, conditionChoices })` returning ordered readonly `{ nodeKey, kind, at, prerequisites }` steps. Preview requires an explicit valid UTC start and choices only for reached conditions. Prerequisites are future checks, not eligibility claims. The package production graph is browser-safe and imports no API, database, identity or provider runtime.

`apps/api/src/marketing/workflow-service.ts` exports `CampaignWorkflowService(client, verifiedContext, traceId)`, `WorkflowCommandError` and generated page/entity aliases. Construct it inside the caller-owned `withTenantTransaction`; it neither opens nor commits a nested transaction. The coordinator owns HTTP registration, CSRF/origin/session/rate safeguards, curated Problem field mapping and commit-before-success.

| Method | Frozen route | Response |
| --- | --- | --- |
| `list(campaignId, query)` | GET `/v1/orgs/{orgId}/campaigns/{campaignId}/versions` | PageCampaignVersion, 200 |
| `get(versionId)` | GET `/v1/orgs/{orgId}/campaign-versions/{campaignVersionId}` | CampaignVersion, 200 |
| `create(campaignId, body, { key })` | POST `/v1/orgs/{orgId}/campaigns/{campaignId}/versions` | CampaignVersion, 201 and quoted numeric workflow ordinal ETag |

Lists accept only scalar cursor/limit, at most five complete definitions per page and a bounded response budget. Signed cursors bind tenant, actor, current grants, campaign and requested limit. This is a live draft list. Reads and cached receipts recheck current organization-scoped campaign access, marketing capability, draft parent and every referenced source. Unavailable/non-draft sources deny access; a saved graph is never permission evidence.

## Reviewed storage and source prerequisites

Actual forward migrations 0017 (`7206e22`) and 0018 (`d56e07a`) were committed before consumers. Runtime can insert/read draft versions, with no update/delete/publish authority. The reviewed migration-owned sequence trigger locks the draft parent and allocates across all historical ordinals without exposing published definitions. Exhaustion becomes safe `409 workflow_version_exhausted`.

Condition sources require organization-scoped CRM lead access, current CRM capability and matching member/stage/source/tag read permissions. Source rows are locked and checked again after waits. Message designs require current tenant/channel/native editor, the approved closed `native-message-text-design-v1.schema.json`, positive revisions, bounded static text, exact newline-joined rendered text and matching SHA-256. Markup, URL/template syntax, unknown formats and Unlayer references deny; no provider or renderer runs.

Command input is detached and deeply frozen from own plain JSON descriptors before validation, hashing or awaited locks. Accessors, proxies, custom prototypes, sparse arrays, cycles and oversized/deep input deny safely. Canonical own-data serialization never invokes inherited Object/Array `toJSON` hooks. Its original text binds idempotency and persistence. A same-key retry returns its historical immutable receipt only after current reauthorization; changed input conflicts. New keys append under the parent lock. Version, audit, the closed internal `campaign.workflow_draft_created` reference event and durable receipt share the caller transaction. Events contain only safe IDs and ordinal; the lead-only dispatcher defers this family.

## Verification and remaining gates

Owned package tests pass 98/98 across three files, including semantic graph/virtual-clock checks, Unicode bounds, browser production import graph, immutable input snapshots and polluted-prototype serialization. Root TypeScript and 13 owned-file Biome checks pass. Independent actual-role candidate probes passed 16/16 for 0017 and 24/24 for 0018; the coordinator independently repeated these and fresh 0001–0018 migrations, synthetic seed and checksum verification with 82 FORCE-RLS tables.

Actual-role direct/registered HTTP service acceptance passes 37/37 in `tests/integration/campaign-workflow-service.test.ts` against fresh actual 0001–0018 migrations. It verifies current permissions/capabilities/references, historical and concurrent receipts, genuine lock-wait expiry, caller rollback, caller-object mutation during waits, published ordinal 10 → new draft 11, exhausted sequence denial, safe events and deferred dispatch, and registered private HTTP boundaries. Five approximately 218 KiB definitions paginate as four complete objects then one through the continuation cursor, with room reserved for the Page envelope. The first acceptance run exposed two test-only fixture errors, corrected before passing reruns. Physical mobile/browser accessibility and the full M4 publish/enroll/send/recovery gates remain unfinished. No workstream test changes the interactive database, renews capabilities or invokes an external service.
