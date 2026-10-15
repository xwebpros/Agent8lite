# ADR-051 — Broadcast audience (segment) preview

Integration review, 2026-10-13: an inherited confirmation handler created a queued job/audit without the approved sender, current consent, provider, preview-expiry and idempotency gates. Removed those unreviewed effects and restored the documented404 `route_unavailable` boundary. A valid current preview cannot confirm delivery; regression checks preserve the same preview response and verify unchanged jobs, audits, receipts, events, schedules, deliveries and consent.

Accepted by the coordinating session on 2026-10-11. This bounded M4 slice implements the frozen `previewBroadcast` operation and the PWA segment authoring that feeds it. It advances MOD-E-001 ("broadcast segment previews"), the MOD-E UI requirement for an "audience eligibility preview", MOD-E acceptance 2 (preview never displays a successful delivery), INV-01/02 and MOD-K-006/007. It adds no contract amendment, migration, dependency, outbox event or provider behavior. `confirmBroadcast` stays on its existing unavailable path (`404`, no effect): sending needs sender readiness, provider and consent review that M4 has not passed.

## Contract (frozen)

`POST /v1/orgs/{orgId}/broadcast-previews`, permission `campaigns.send`, requires `Idempotency-Key` and CSRF, accepts no query parameters. Body `BroadcastRequest` (closed): `messageDesignId`, `filter` (`LeadFilter`), optional `scheduledAt`, `timezone`. Response `201 BroadcastPreview`: `id`, `eligible`, `ineligible`, `estimatedRecipients`, `expiresAt`.

## Authority

The route is a locally guarded synthetic marketing route like ADR-021/023/026 (`localAccess`). The command requires organization-scoped `campaigns.send`, `campaigns.read`, `crm.leads.read` and `crm.contacts.read`, rechecked with the `WorkflowAuthority` membership/role/organization/grant query and current marketing and CRM capability, before the computation and again before returning. A filter reference adds the matching read grant at organization scope, exactly as ADR-023 conditions do (`members.read` for `ownerMemberId`, `crm.pipeline.read`, `crm.sources.read`, `crm.tags.read`); referenced stages, sources, tags and active owners must belong to the current tenant (`422 workflow_reference_unavailable` with the `filter.*` field otherwise). The message design must be a current, valid native design (the ADR-023 design checks); its channel selects the purpose: `email` → `email_marketing` over email channels, `sms` → `sms_marketing` over phone channels. An SMS design additionally requires current SMS capability when that capability is modelled; none is today, so this is documented, not enforced.

Organization scope is deliberate: a broadcast reaches the organization's audience, and a narrower CRM scope would silently produce a smaller count that reads as the whole segment. Members without organization scope get `403 permission_denied`.

## Validation

Before any wait: detach the body, validate the closed schema, a meaningful filter (at least one predicate, the shared condition rules: unique tags, nonblank bounded `q`, supported intent), a named IANA timezone with the server rule used by Task commands, and `scheduledAt`, when present, as a valid instant that is preserved only. `scheduledAt` must be after database time when checked; nothing is scheduled. The request hash is the canonical `{body, expectedVersion: null}` (the same spelling `crm.idempotent` uses).

## Computation

One SQL statement (one snapshot) evaluates the segment:

- **Matched leads:** unarchived leads with unarchived contacts in the current tenant matching every supplied predicate: `stageId`, `ownerMemberId`, `sourceId`, `intent` equality; all `tagIds` present; `q` as a literal case-insensitive substring of the contact display name (the `listLead` semantics, with `%`, `_`, `\` escaped).
- **Eligible destination:** an active channel of the purpose's kind whose consent state for that purpose is `granted` with verified evidence, synthetic-local provenance and the synthetic policy (only in explicit development/test mode, the same rule as `ConsentService.readEligibility`), with no `withdrawn` state for the same destination and purpose on any channel, and no blocking suppression for that destination and purpose. The consent rule is a consent-owned SQL fragment in `apps/api/src/consent-eligibility-sql.ts`, kept in step with `ConsentService.readEligibility`, so the marketing preview does not restate consent policy.
- **eligible:** matched leads whose contact has at least one eligible destination. **ineligible:** the other matched leads. **estimatedRecipients:** distinct normalized eligible destinations, choosing one per eligible contact (primary first, then oldest), so two leads of one contact or two contacts sharing an address count once.

The scan is bounded at 5,000 matched leads. A larger segment returns `422 broadcast_audience_too_large` instead of a partial or capped count, because a truncated number would read as the whole audience. Unknown is never shown as zero: a failure returns a problem, never counts.

The preview is a point-in-time estimate. Consent, suppression, archive and scope are rechecked at any future execution (MOD-E-004, acceptance 2); a withdrawal after the preview still blocks a send.

## Effects and replay

A fresh preview commits, in the caller transaction, one audit reference (`broadcast.previewed`, counts and opaque IDs only, never the filter `q`, names or destinations) and one one-day idempotency receipt holding the frozen response. It uses a dedicated receipt boundary (ADR-039/047 pattern, not the generic `crm.idempotent`, which ignores expired receipts): an advisory lock on tenant/actor/route/key, then the matching receipt is inspected regardless of expiry. Changed hash `409 idempotency_conflict`, expired receipt `409 receipt_expired`, replay returns the historical response after the current authority checks above (filter references and design re-validated). `id` is a fresh UUID; `expiresAt` is database time plus 15 minutes, the validity a future confirm ADR may rely on. There is no outbox event and no row in any other module's tables.

## PWA

The campaigns area gains a **Broadcast audience** panel (`broadcast-preview-*.ts(x)`): choose a current native email or SMS design from the existing design catalogue, author the segment with the same allowlisted predicates as ADR-050 conditions (reusing its reference catalogue), set a timezone and optional scheduled time, then **Preview audience**. The result shows eligible, ineligible and estimated recipient counts, the expiry time and the plain statement that nothing is sent or scheduled. There is no send or confirm control.

A preview has no business side effect (receipt and audit only), so it is not a protected command: an unknown outcome keeps the immutable request and key and offers **Retry this preview** with the same key while the panel stays open; closing or navigating discards it without a guard. Results are private tab memory, cleared on offline, hidden, context change and access loss, expire on screen at `expiresAt`, and never enter URLs, history or storage. `403`/`401` clear private state; `422 broadcast_audience_too_large` explains that the segment must be narrowed.

## Ownership and acceptance

Backend: `apps/api/src/marketing/broadcast-preview-service.ts`, the consent SQL fragment in `apps/api/src/consent-eligibility-sql.ts`, and route registration in `apps/api/src/main.ts` ahead of the generic fallback. Frontend: `apps/web/components/broadcast-preview-*` and its mount in the campaigns workspace. Tests: `tests/integration/broadcast-preview-api.test.ts` against real runtime roles (counts across consent states, verified versus unverified grants, withdrawn sibling destinations, suppression active and expired, archived lead/contact, every predicate, deduplicated recipients, the 5,000 bound, organization-scope and grant/capability denial, foreign references and designs, receipt replay/conflict/expiry, audit privacy, no outbox, no other-table writes); unit tests for the client protocol, controller and panel. Browser/axe/keyboard/device acceptance remains blocked.
