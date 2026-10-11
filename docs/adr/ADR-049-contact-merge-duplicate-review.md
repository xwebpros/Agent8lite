# ADR-049 — Contact duplicate review and merge (contract proposal)

Proposed by the coordinating session on 2026-10-11. **Status: proposed; the additive public operations below wait for owner review.** No code, migration, generated type or OpenAPI change may depend on this ADR until the owner accepts it; the acceptance date and any changes will be recorded here first. This slice targets MOD-D-005, MOD-D acceptance 5, MOD-D-001 (unknown values remain unknown), INV-01/02/03 and MOD-K-006/007.

## Problem

MOD-D-005 requires duplicate candidates and an explicit reviewed merge/skip policy; MOD-D acceptance 5 requires that "contact merging preserves consent provenance and reports conflicting grants/withdrawals; withdrawal wins until a later valid grant is verified." The frozen contract provides only two related surfaces:

- `ImportPreview.duplicates` (a count) and `ImportCommit.duplicatePolicy` (`skip` | `merge_reviewed`). The current implementation rejects `merge_reviewed` with `422`, and `tests/integration/data-transfer-api.test.ts` asserts that.
- No operation to list duplicate candidates among existing Contacts, merge two Contacts, or report consent conflicts.

A count cannot support a human review of which records merge, and import rows carry no consent evidence, so acceptance 5 cannot be met through the import path alone. The blueprint OpenAPI stays frozen; anything new must be an explicitly reviewed additive amendment in the style of ADR-022/043, applied by `scripts/check-contracts.mjs` to the implementation OpenAPI only.

## Decision 1 — import `merge_reviewed` stays unavailable in this slice

`merge_reviewed` keeps returning `422` until Decision 2 is accepted and implemented, because the frozen preview exposes no reviewable candidate list. After Decision 2 lands, a later ADR may define `merge_reviewed` as "add the row's new channels to the single in-scope Contact that shares a normalized email, never on a phone-only match, and skip otherwise", reusing the merge rules below. That is out of scope here.

## Decision 2 — proposed additive operations

All three use the existing `Problem`, `Job`, `X-Trace-Id`, CSRF, rate-limit and tenant-context conventions. None accepts query parameters other than those listed.

### 2a. `GET /v1/orgs/{orgId}/contact-duplicates` — `listContactDuplicates`

Permission `crm.contacts.read`. Query: `cursor` (signed, binding authority and filter), `limit` 1–50 (default 25). Response `PageContactDuplicate`: `{ items: ContactDuplicate[], nextCursor: string|null, hasMore: boolean }`.

`ContactDuplicate` (closed): `{ id: uuid, contactIds: [uuid, uuid], contactVersions: [int, int], matchKinds: ("email"|"phone")[], phoneOnly: boolean }`. It carries no names, channel values, birthdays or consent. `id` is a deterministic UUIDv5 of the ordered pair so it is stable across pages. The client reads each Contact through the existing `getContact` to show the comparison.

Candidates are pairs of unarchived Contacts in the current tenant that share at least one normalized email or phone, where **both** Contacts are inside the caller's current read scope (own/team/organization, the same predicate as `listContact`). The server orders by `id`, bounds the scan to 200 candidates per authority binding, and states `hasMore` truthfully. A phone-only match is listed with `phoneOnly: true` and is never auto-merged (MOD-D-005 household rule).

### 2b. `POST /v1/orgs/{orgId}/contacts/{contactId}/merges` — `mergeContact`

Permission `crm.contacts.write`. Headers: `Idempotency-Key` (required), `X-CSRF-Token` (required), `If-Match` (required, the surviving Contact's version). Body `ContactMergeRequest` (closed): `{ sourceContactId: uuid, sourceVersion: int >= 1, acknowledgePhoneOnly?: boolean }`. Response `202 Job` (`kind: "crm.contact.merged"`, `state: "succeeded"`, `resultUrl` pointing at 2c), `ETag` = the survivor's new version. Errors: `404 resource_unavailable` (either Contact archived or out of scope), `409 merge_same_contact`, `409 merge_phone_only_unacknowledged`, `409 merge_requires_lead_scope`, `412` (either version stale), `409 idempotency_conflict` / `receipt_expired`, `422` for shape.

### 2c. `GET /v1/orgs/{orgId}/contact-merges/{mergeId}` — `getContactMerge`

Permission `crm.contacts.read`; readable by the requesting member while both Contacts' identities remain inside their current read scope (the merged source is read as archived-with-survivor). Response `ContactMerge` (closed): `{ id, survivorContactId, mergedContactId, survivorVersion, createdAt, channelsMoved: int, channelsCombined: int, leadsMoved: int, consentOutcomes: ConsentMergeOutcome[] }`.

`ConsentMergeOutcome` (closed): `{ channelKind: "email"|"phone", channelOrdinal: int, purpose: "email_marketing"|"sms_marketing"|"listing_alert", survivorState, mergedState, resultState: "unknown"|"granted"|"withdrawn", conflict: boolean, reason: "withdrawal_wins"|"later_verified_grant"|"same_state"|"unknown_kept_unknown" }`. Channels are identified by a generic ordinal on the survivor (as the consent channels response already does), never by destination.

## Merge rules (server)

The command follows the established recoverable pattern (ADR-039/045/047): detach and validate route, body, key and exact `If-Match` before any wait; serialize by tenant/actor/route/key; inspect receipts regardless of expiry; hash `{body, expectedVersion}`; recheck runtime role, transaction context, membership/role/organization, exact grants and CRM capability after every wait and before returning.

1. **Scope.** Both Contacts must be unarchived and inside the intersection of current `crm.contacts.read` and `crm.contacts.write` scope. Every unarchived Lead of the source must be inside the caller's current `crm.leads.write` scope, otherwise `409 merge_requires_lead_scope` with no effects. Cross-tenant merge is impossible by RLS and by verified-context checks.
2. **Lock order.** Both Contacts `FOR UPDATE` in ascending UUID order (avoids deadlock between opposite-direction merges), then the source's Leads `FOR UPDATE`, then channels, then consent state rows, then team offices. This keeps the Contact → Lead → membership/office order from ADR-047.
3. **Versions.** `If-Match` must equal the survivor's current version and `sourceVersion` the source's; either mismatch is `412`. Survivor advances by exactly one; source advances by one when archived.
4. **Fields.** Survivor's `displayName` is kept. A null survivor `birthday` takes the source's non-null value; a conflicting non-null value keeps the survivor's (no silent overwrite; reported only as a count in audit, never the value).
5. **Channels.** A source channel whose `(kind, normalized_value)` the survivor lacks is re-parented to the survivor, keeping its id, so its consent ledger and evidence follow unchanged (`channelsMoved`). A source channel that duplicates a survivor channel stays attached to the archived source, is marked combined into the survivor channel, and its consent is combined (`channelsCombined`). Primary flags: the survivor's primaries win.
6. **Consent.** Per combined channel and purpose, the result is computed from both immutable ledgers: if either side's latest decisive event is a withdrawal, the result is `withdrawn` unless the most recent event across both ledgers is a grant with verified evidence that occurred after that withdrawal (`later_verified_grant`). Two unknowns stay unknown; an unverified grant never yields `granted`. The ledger rows are never updated or deleted. The survivor channel's `consent_state` is updated through the consent module's port (a new `NativeConsentPort.combineForMerge`, transaction-bound), not by CRM writing marketing tables directly. Suppression is keyed by destination and is unaffected.
7. **Leads.** The source's unarchived Leads are re-pointed to the survivor (`leadsMoved`), each advancing `row_version` by one. Tasks follow their Lead. Archived Leads keep their historical `contact_id`.
8. **Source.** The source Contact is archived with `merged_into_contact_id` = survivor.
9. **Effects in one transaction.** Contact updates, channel moves, consent combination, Lead re-points, a `contact_merge` record holding the outcome summary, one audit, one Job, one one-day receipt, and outbox events: one internal `contact.merged` v1 (references only: survivor and merged IDs and versions, counts), the frozen `contact.archived` for the source, and `consent.changed` from the consent module only when a survivor channel's state actually changes.
10. **Replay.** Returns the historical `202 Job` and ETag after strict receipt validation and current authorization over the survivor (and the merged source read as archived). No second effect set.

## Required supporting changes (after acceptance)

- Migration `0022-contact-merge.sql`: `app.contact.merged_into_contact_id`, `app.contact_channel.combined_into_channel_id`, and `app.contact_merge` (tenant, id, actor member, survivor/merged ids and versions, counts, closed outcome JSON, created_at) with FORCE RLS, runtime `SELECT, INSERT` only, no UPDATE/DELETE. Narrow column grants for the new pointer columns.
- Amendment file `packages/contracts/amendments/ADR-049-contact-merge.json` with the three operations and five schemas exactly as above, applied and checked by `scripts/check-contracts.mjs`; regenerate `packages/contracts/generated/api.ts`.
- Internal `packages/contracts/internal/native-contact-merged-event-v1.schema.json`, registered in `check-contracts`.
- `NativeConsentPort.combineForMerge` in `packages/contracts/internal/consent-port.ts`.
- PWA: a "Possible duplicates" review list, a side-by-side comparison read through `getContact`, a merge confirmation that names which record survives and states the phone-only warning, and the recoverable command protocol/controller/panel modeled on `record-archive*`, added to every Workspace guard. The result view shows consent outcomes in words ("Withdrawal kept for email marketing on Email channel 2").

## Acceptance (after acceptance of the ADR)

PostgreSQL/RLS with real runtime roles: same-key and distinct-key races, opposite-direction concurrent merges (no deadlock, one wins), stale survivor/source versions, replay/expiry/corrupt receipts, own/team/organization scope including a source Lead outside scope, revocation mid-wait, phone-only acknowledgement, channel move versus combine, every consent combination (grant/withdraw/unknown × verified/unverified × ordering) with withdrawal-wins and later-verified-grant cases, Lead re-pointing with Task linkage intact, rollback of every effect, event schema/privacy and database time, and that the merged source disappears from list/detail and from duplicate candidates. Client acceptance as for ADR-047. Browser/axe/keyboard/device checks remain blocked as before.

## Alternatives considered

- **Merge only through import `merge_reviewed`:** rejected; no reviewable candidates and no consent to combine.
- **Hard-delete the source Contact:** rejected; AGENTS.md forbids silent data loss, and consent ledgers must remain intact.
- **Rewrite consent ledger rows onto the survivor:** rejected; the ledger is immutable (migration 0010 grants no UPDATE/DELETE) and provenance would be lost.
- **Use `PATCH updateContact` with extra fields:** rejected; it would silently change the frozen Contact PATCH body.
