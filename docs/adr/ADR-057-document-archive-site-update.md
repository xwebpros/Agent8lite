# ADR-057 — Document archive and site update (MOD-C-003 / MOD-C-001)

Accepted 2026-10-12, coordinating session. Adds `archiveDocument` and `updateSite` operations to the CMS module.

## Scope

### archiveDocument
`POST /v1/orgs/{orgId}/documents/{docId}/archive`

- Requires `content.write` permission.
- Soft-deletes the document by setting `archived_at = now()` via the `app.archive_document()` SECURITY DEFINER function (migration 0026). Direct UPDATE of `archived_at` is denied to `estate_runtime`.
- Returns `202 Job` with `kind: "document.archived"`.
- Idempotent: replays the same Job body for the same key. The document fetch is inside the command closure so a replay on an already-archived document does not throw 404.
- Returns 409 if the document is already archived (no key, or new key).
- Returns 404 if the document is not found or out of tenant scope.

### updateSite
`PATCH /v1/orgs/{orgId}/sites/{siteId}`

- Requires `sites.write` permission and `If-Match` optimistic-lock header.
- Updates `name` and `businessProfileId` only; `templateCode` in the body is ignored at the data layer (stored `theme_version` is immutable after creation).
- Returns `200 Site` with updated `version` and ETag.
- Returns 412 on version mismatch.
- Idempotent: replays the same Site body for the same key.

## Security

- `archived_at` on `content_document` is not granted to `estate_runtime` directly; the SECURITY DEFINER function is the only path.
- `name`, `business_profile_id`, `updated_at` on `site` are granted via column-level UPDATE in migration 0026.
- Both operations verify tenant isolation via `app.current_tenant()` in the SQL WHERE clause.

## Migration

`packages/db/migrations/0026-document-archive-site-update.sql` — `app.archive_document(uuid)` SECURITY DEFINER + `GRANT UPDATE(name, business_profile_id, updated_at) ON app.site`.

## Tests

6 new tests in `tests/cms/native-drafts.integration.test.ts` under `ADR-057: document archive and site update`:
- Archive idempotency and post-archive invisibility in document list
- 409 on re-archive without key
- Site update idempotency
- 412 on version mismatch
- 403 for missing permission
- Tenant isolation
