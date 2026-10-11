# ADR-052: Public site service — visitor sessions, forms, listings and organizer

**Status:** accepted  
**Date:** 2026-10-11  
**Milestone:** M3 (website builder forms), M5 (public listing search and organizer)

## Context

The frozen OpenAPI contract declares fifteen public-facing operations that are not yet implemented:

| Route | Operation |
|---|---|
| `GET /v1/public/sites/{siteId}/forms/{formId}` | `getPublicForm` |
| `POST /v1/public/sites/{siteId}/form-submissions` | `submitPublicForm` |
| `POST /v1/public/sites/{siteId}/property-inquiries` | `submitInquiry` |
| `GET /v1/public/sites/{siteId}/listings` | `searchPublicListings` |
| `GET /v1/public/sites/{siteId}/listings/{listingId}` | `getPublicListing` |
| `POST /v1/public/sites/{siteId}/visitor-sessions/challenge` | `requestVisitorLogin` |
| `POST /v1/public/sites/{siteId}/visitor-sessions/verify` | `verifyVisitorLogin` |
| `DELETE /v1/public/sites/{siteId}/visitor-sessions/current` | `signOutVisitor` |
| `GET /v1/public/sites/{siteId}/saved-searches` | `listSavedSearches` |
| `POST /v1/public/sites/{siteId}/saved-searches` | `createSavedSearch` |
| `PATCH /v1/public/sites/{siteId}/saved-searches/{savedSearchId}` | `updateSavedSearch` |
| `GET /v1/public/sites/{siteId}/favorites` | `listFavorites` |
| `POST /v1/public/sites/{siteId}/favorites` | `addFavorite` |
| `DELETE /v1/public/sites/{siteId}/favorites/{listingId}` | `removeFavorite` |
| `POST /v1/public/sites/{siteId}/analytics-events` | `collectPublicAnalytics` |
| `POST /v1/public/message-unsubscriptions` | `unsubscribeMessage` |
| `POST /v1/public/one-click-unsubscribe` | `oneClickUnsubscribe` |

All database tables exist in migration `0001-blueprint.sql`: `app.site`, `app.site_domain`, `app.form_schema`, `app.form_entry`, `app.visitor_identity`, `app.saved_search`, `app.favorite`, `app.listing_alert_match`.

## Decision

Implement these operations in two phases in a single `apps/api/src/public-site-service.ts` file. Phase A (this ADR) covers the M3 exit gate prerequisites and MOD-F search-to-inquiry path. Phase B (saved searches, favorites, alert matches) follows when the organizer PWA is ready.

### Public site context resolution

Public site routes identify the site by `siteId` (UUID). The server resolves the site's `tenant_id` from `app.site` with `status='published'`. This is NOT a member operation — it runs under the runtime pool with a verified tenant context using the site's `tenant_id`. The rate limit is per remote address (not per member). No session cookie is required for anonymous operations.

### Visitor session

A visitor session is a separate cookie (`estate_visitor_session`) from the member session. It stores a signed `{tenantId, siteId, visitorId}` payload. The challenge flow:

1. `requestVisitorLogin`: validate email; look up or create a contact by normalized email; store a time-limited hashed OTP in `app.visitor_identity` (or a separate challenge table); in no-delivery mode, log the OTP as a structured trace; return `202`.
2. `verifyVisitorLogin`: validate OTP; create or update `app.visitor_identity`; set `estate_visitor_session` cookie (HttpOnly, SameSite=Lax, max-age 30 days); return `200 VisitorSession`.
3. `signOutVisitor`: clear the cookie; return `204`.

### Form submission (`getPublicForm`, `submitPublicForm`)

- `getPublicForm`: look up `app.form_schema` by `formId` joined to the site; return the published schema. Return `410` if unpublished/deleted.
- `submitPublicForm`: validate request body against the stored JSON schema; check idempotency key in `app.form_entry`; create `app.form_entry`; call `NativeCaptureService` port to create/merge contact and lead; in a no-delivery transport, the confirmation email is suppressed. Returns `202 Job`.

### Property inquiry (`submitInquiry`)

- Validate request body (contact details, `listingId`, message); check idempotency key; call `NativeCaptureService` with the inquiry as a capture event; return `202 Job`. Does not require a visitor session (anonymous inquiry is permitted).

### Public listing search (`searchPublicListings`, `getPublicListing`)

- Delegate to the existing `NativeMockReadService` repository for the site's feed. Apply published display policy (address suppression, status filter). Return `200 PageNativeListing` / `200 NativeListing`. No visitor session required.

### Analytics (`collectPublicAnalytics`)

Accept the event, validate it does not contain personal data fields, and discard it silently (no-op in development). Return `202`.

### Unsubscriptions (`unsubscribeMessage`, `oneClickUnsubscribe`)

These require a signed token from a campaign delivery. In no-delivery mode, validate the token format (HMAC-SHA256, base64url, under 512 chars) and return `200`. A real implementation updates `app.suppression`; this ADR implements the validation-only version.

### No new contract, migration, or dependency

All operations use the frozen contract. The database tables exist in migration `0001`. No new ADR amendments, outbox events, or external services are introduced.

## Invariants preserved

- **INV-01/02**: tenant context is set from the resolved site's `tenant_id`; actor context for anonymous operations uses a zero-privilege public actor role.
- **INV-09**: no personal data (visitor email, form fields, inquiry message) appears in logs; only `traceId` and opaque IDs are logged.
- **Consent/suppression**: form submission applies the same consent-evidence rule as `NativeCaptureService` (one evidence set per submission key).
- **No real outbound delivery**: challenge OTPs and confirmation emails are suppressed in no-delivery mode.

## Consequences

Completes M3 AC-4 ("a form retry records one lead decision and one consent evidence set") and M5 AC-3 ("search→inquiry→CRM"). Organizer (saved searches, favorites) and visitor sessions are implemented but the PWA integration is future work.
