# ADR-059: Campaign Lifecycle — publishCampaign and archiveCampaign

**Status:** Accepted

**Date:** 2026-10-12

**Workstream:** W01 Foundation (coordinator)

## Context

M4 requires two campaign lifecycle transitions: publishing a draft campaign version (activating it) and archiving a campaign. The `campaign_version` table has a `BEFORE UPDATE OR DELETE` immutability trigger (`app.reject_campaign_version_mutation`), and `estate_runtime` has restrictive RLS policies on `app.campaign` that prevent direct state changes.

## Decision

1. **Migration 0027** extends the immutability trigger to allow exactly one supervised mutation: `state 'draft' → 'published'` with `published_at NULL → non-null`, and no changes to any content columns. All other updates remain blocked.

2. **SECURITY DEFINER functions** (`app.publish_campaign_version` and `app.archive_campaign`) are owned by the migration user (postgres/BYPASSRLS) and exposed to `estate_runtime` via GRANT EXECUTE. They perform state transitions that the RLS policies would otherwise block.

3. **`CampaignWorkflowService.publish()`** calls `app.publish_campaign_version()` and gates on the `campaigns.publish` permission (distinct from `campaigns.write`). Uses advisory-lock + idempotency pattern. Already-published detection uses the `app.idempotency_record` table because RLS hides published versions from `estate_runtime`.

4. **`CampaignDraftService.archive()`** calls `app.archive_campaign()` and gates on `campaigns.write`. Returns a 202 Job record (kind: `marketing.campaign.archived`, state: `succeeded`).

5. Routes added to `main.ts`:
   - `POST /v1/orgs/{orgId}/campaign-versions/{id}/publish`
   - `POST /v1/orgs/{orgId}/campaigns/{id}/archive`

## Consequences

- Campaign versions are effectively immutable from the application layer; the trigger blocks all mutations except the supervised publish transition.
- The `campaigns.publish` permission enables role-based separation between edit and publish access.
- Archive is immediate and synchronous; no further workflow processing is blocked.
- Integration tests verify: publish transitions DB state, idempotency replay, 403 without `campaigns.publish`, 409 on already-published, tenant isolation; archive transitions state, idempotency, 403 without `campaigns.write`, tenant isolation.
