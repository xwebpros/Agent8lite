# ADR-058 — Media upload grant (MOD-C-006)

Accepted 2026-10-12, coordinating session. Adds `createUploadGrant` to the CMS module.

## Scope

`POST /v1/orgs/{orgId}/uploads`

- Requires `media.write` permission.
- Validates `UploadRequest` body: `filename`, `mimeType`, `bytes` (1–20971520), `purpose` (`media` | `contact_import`).
- Creates a `media_asset` row in state `pending` with `upload_expires_at = now() + 1 hour`.
- Calls `StoragePort.createUploadGrant()` to obtain a signed PUT URL.
- Returns `201 UploadGrant` with `assetId`, `url`, `method: "PUT"`, `expiresAt`, `requiredHeaders`.
- Idempotent: the route key is `cms:upload-grant` with the caller's Idempotency-Key header; the `assetId` is generated inside the command closure so replays return the stored asset id.

## Storage provider

`packages/providers/storage/port.ts` defines the `StoragePort` interface. `packages/providers/storage/mock.ts` (`MockStorageProvider`) returns loopback dev URLs at `{devApiOrigin}/dev/uploads/{assetId}`. Live S3-compatible providers implement the same interface.

`MockStorageProvider` is injected into `CmsHttpAdapter` and `CmsService` via the `dependencies.storage` constructor field. `main.ts` uses the mock pointed at the local API port; it will be replaced in M5/M6.

## Bug fix: `$1` type ambiguity

The repository INSERT uses `$1` for `id` (uuid) and a separate `$2` for `object_key` (text) — not `$1` for both. PostgreSQL raises `42P08` (inconsistent type deduction) when the same parameter is bound to columns of different types in subsequent queries within the same session.

## Security

- `estate_runtime` has `SELECT, INSERT` on `app.media_asset` (migration 0007).
- `scan_state` defaults to `pending`; `estate_runtime` can UPDATE `scan_state`, `content_sha256`, `alt_text`, `updated_at`, `row_version`.
- Uploaded bytes are never written here; the client PUTs directly to the storage URL. Finalization (`POST /v1/orgs/{orgId}/media/finalize`) validates checksum and marks `scan_state = clean`.
- Tenant isolation is enforced via `app.current_tenant()` in all SQL.

## Tests

5 tests in `tests/cms/native-drafts.integration.test.ts` under `ADR-058: media upload grant`:
- Creates grant and returns 201 with valid UploadGrant body
- Replays same grant for same idempotency key
- Returns distinct grants for distinct keys
- Returns 403 when `media.write` permission is absent
- Confirms tenant isolation via distinct org prefixes
