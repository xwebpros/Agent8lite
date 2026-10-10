# W06 native campaign draft metadata

This bounded MOD-E-001/003 prerequisite implements the four frozen campaign metadata operations only. It does not meet the full M4 acceptance gate. The approved source is `docs/tdd/technical-design.json` MOD-E and unchanged `packages/contracts/openapi.json` Campaign/CampaignWrite. Workflow versions, message designs, publication, enrollment, schedules and delivery remain unavailable.

## Shared decisions awaiting review

- Promote `campaign-draft-policy.proposed.sql` through an additive migration. Existing FORCE RLS is retained; restrictive runtime SELECT and mutation policies allow only drafts, and runtime cannot update state. Worker/control/issuer privileges do not change.
- Use organization-scoped `campaigns.read` or `campaigns.write` and a currently enabled, unexpired `marketing` entitlement. The current seed does not grant this entitlement. Disposable tests may explicitly configure it; interactive enablement requires the integration owner's synthetic fixture decision.
- Promote `campaign-draft-event-v1.proposed.schema.json` to an additive internal schema without editing the frozen event catalog. Native draft metadata commits one validated `campaign.draft_metadata_changed` v1 outbox reference, one audit reference and one idempotency receipt atomically with the campaign. The closed payload contains only campaign ID, metadata row revision and create/update operation; it is not a workflow version, enrollment or send. `campaign.enrolled`/`campaign.cancelled` must not stand in for metadata.
- Keep native metadata command receipts durable (`expires_at='infinity'`) and read them without a time-window filter, preventing a later retry from recreating a campaign. This is native database idempotency, not a provider guarantee. Replays recheck current permission, membership, capability and the current draft before returning the original frozen response/ETag. Historical input is never reapplied.

## Integration export contract

`apps/api/src/marketing/index.ts` will export `CampaignDraftService`, the frozen generated Campaign/PageCampaign aliases, and service-only query/command header types. Construct the service with the existing `PoolClient`, verified `TenantContext` and trace ID inside `withTenantTransaction`; it never starts or commits a nested transaction. The integration adapter remains responsible for authenticated synthetic mode/socket/session, same-origin CSRF, rate limiting, header extraction, safe errors/private headers and committing before returning success.

| Method | Frozen route | Return |
| --- | --- | --- |
| `list(query)` | GET `/v1/orgs/{orgId}/campaigns` | PageCampaign, 200 |
| `get(id)` | GET `/v1/orgs/{orgId}/campaigns/{campaignId}` | Campaign, 200 and strong numeric ETag |
| `create(body, headers)` | POST `/v1/orgs/{orgId}/campaigns` | Campaign, 201 and strong numeric ETag |
| `update(id, body, headers)` | PATCH `/v1/orgs/{orgId}/campaigns/{campaignId}` | Campaign, 200 and strong numeric ETag |

Only drafts are listed/read/edited in this slice. Existing active/paused/archived metadata is unavailable; no state implies permission, provider readiness or delivery. Query accepts only scalar `cursor` and `limit` (1–100, default 25). Cursor binds tenant/actor/member/role/current grants/resource/draft scope/sort/limit and expiry; UUID ascending keyset pagination is a live view, not a frozen audience preview. Strong `If-Match` is a quoted positive safe integer. Blank trimmed names/categories are rejected. Closed request and response validation uses the frozen generated schema. Source timestamps and entitlement expiry use the database clock.

## Recommended real-role acceptance

Use a unique disposable PostgreSQL/PostGIS database with actual runtime login and existing migrations plus the reviewed candidate. Prove missing context/pool reuse/cross-tenant invisibility; draft-only direct INSERT/UPDATE and no state/version/enrollment privileges; organization scope and current role/membership/marketing capability denial; no inferred publish/enroll/send authority; one campaign/audit/receipt for concurrent identical create; changed input conflict; same-key historical replay after later edit; two new update keys on one revision yield one update and one stale precondition; malformed/missing If-Match; current permission/capability revocation blocks cached replay; capability expiry while waiting for a campaign/advisory lock blocks mutation; full caller rollback removes campaign/audit/receipt together. Verify cursor actor/tenant/limit/current-grant binding and private route responses when registration is reviewed.

## Internal event validation and dispatch

The producer validates the closed additive internal envelope before inserting it into the existing outbox with `initiating_actor_id` from the verified context. The database clock supplies both event timestamps. It also asserts envelope aggregate ID equals payload campaign ID and tenant/current actor are the transaction context. There is no provider, delivery, notification or worker consumer in this slice. The existing lead-only reference dispatcher must leave this new family deferred; it must not mark an unknown envelope accepted. A later reviewed consumer must explicitly register this local schema, reauthorize the current campaign and capability, and keep the immutable consumer receipt boundary. No names, message content or customer data are put in the event/audit safe fields.

The frozen CampaignVersion/Write contract is reserved for a later reviewed graph validator/versioning slice: one entry, bounded nodes/edges, acyclic graph and approved condition DSL, immutable published versions, scoped design/segment references and deterministic virtual-clock preview. Metadata commands do not insert a version or infer those prerequisites.
