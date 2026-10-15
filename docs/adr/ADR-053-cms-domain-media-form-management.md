# ADR-053 — CMS domain, media and form management

**Date:** 2026-10-12

**Status:** Accepted

**Author:** Coordinating agent (W01)

## Context

ADR-052 completed the public-side visitor service for published sites.  The
authenticated website-builder API (MOD-C, M3) still has six route groups in
the frozen contract that fall through to the 503 `feature_not_implemented`
catch-all:

| Group | Operations |
|---|---|
| Domain management | `GET /v1/orgs/{orgId}/sites/{siteId}/domains`, `POST /v1/orgs/{orgId}/sites/{siteId}/domains`, `POST /v1/orgs/{orgId}/domains/{domainId}/verify`, `POST /v1/orgs/{orgId}/domains/{domainId}/archive` |
| Media management | `GET /v1/orgs/{orgId}/media`, `POST /v1/orgs/{orgId}/media/finalize` |
| Form management | `GET /v1/orgs/{orgId}/sites/{siteId}/forms`, `POST /v1/orgs/{orgId}/sites/{siteId}/forms`, `GET /v1/orgs/{orgId}/forms/{formId}`, `POST /v1/orgs/{orgId}/forms/{formId}/versions` |
| Site lifecycle | `POST /v1/orgs/{orgId}/sites/{siteId}/archive` |

All corresponding database tables (`app.site_domain`, `app.media_asset`,
`app.form_schema`) exist in migration 0001.  No new migrations are required
unless runtime GRANTs are missing.

## Decision

Implement all eleven operations in the CMS HTTP adapter
(`apps/api/src/cms/`).  No contract amendments, no new event schemas, no new
migrations beyond runtime GRANTs where needed.

### Domain management (MOD-C-005)

- `listDomains(siteId)` — `domains.read`; validates site membership.
- `createDomain(siteId, body)` — `domains.manage`; idempotent by
  `(tenant_id, hostname)`; normalizes hostname to lowercase; rejects globally
  non-unique hostnames with `409 domain_hostname_conflict`; sets
  `verificationState='pending'`, `tlsState='pending'`.
- `verifyDomain(id)` — `domains.manage`; in the initial synthetic implementation
  it transitions `verificationState` from `pending` to `verified` and emits no
  real DNS challenge.  A `requiredDns` array is returned on `Domain` listing.
- `archiveDomain(id)` — `domains.manage`; soft-archives a domain; returns `202 Job`.

### Media management (MOD-C-006)

- `listMedia(query)` — `media.read`; cursor-paginated list of `app.media_asset`
  rows for the tenant.  Returns `PageMedia`.
- `finalizeMedia(body, key)` — `media.write`; idempotent by key; marks an
  existing `pending` asset `clean` after checksum confirmation; rejects if
  already `rejected`; returns `Media`.  The upload grant and PUT are handled
  by the existing `UploadService`; finalize is the confirmation step.

### Form management (MOD-C-007 / MOD-C-008)

- `listForms(siteId, query)` — `forms.read`; cursor-paginated by site.
- `createForm(siteId, body, key)` — `forms.write`; idempotent; inserts into
  `app.form_schema` with `version=1`; validates `FormWrite` against the frozen
  schema including field kinds and purpose values.
- `getForm(id)` — `forms.read`; returns a single `Form`.
- `publishFormVersion(id, body, key)` — `forms.write`; idempotent; inserts a
  new version row (`version = current_max + 1`) for the form; validates
  `FormWrite`.

### Site archive

- `archiveSite(id)` — `sites.write`; soft-archives a site by setting
  `state='archived'`; refuses if any domain is still `verificationState='verified'`
  (`409 domain_still_active`); returns `202 Job`.

## Consequences

- All eleven operations are implemented and tested.
- The `app.site_domain`, `app.media_asset` and `app.form_schema` tables need
  `estate_runtime` GRANTs; migration 0024 adds them.
- No change to the frozen original contract or existing ADR amendments.
- Integration test suite: `tests/cms/native-drafts.integration.test.ts` is
  extended to cover all new operations with tenant isolation and idempotency.

## Invariants

- INV-01: every query checks `tenant_id=app.current_tenant()` through RLS.
- INV-04: no module writes another module's tables directly; domain/media/form
  writes use only `app.site_domain`, `app.media_asset`, `app.form_schema`.
- INV-09: idempotent commands bind the run-key before execution.
