# ADR-055 — CMS document publication (MOD-C-003)

Accepted 2026-10-12, coordinating session. Implements the `publishDocument` and `rollbackDocument` operations for the native CMS.

## Scope

Two new command endpoints:

- `POST /v1/orgs/{orgId}/documents/{documentId}/publish` — sets `published_revision_id` to a given revision.
- `POST /v1/orgs/{orgId}/documents/{documentId}/rollback` — moves `published_revision_id` back to a prior revision. Same request/response shape.

Both accept `PublishRequest { revisionId: uuid, expectedDocumentVersion: integer ≥ 1 }` and return a `Job` with `state: "succeeded"` and `kind: "document.published"` or `"document.rolledback"` at HTTP 202. Both are idempotent (route keys `cms:publish` / `cms:rollback`).

## SECURITY DEFINER function (migration 0025)

Migration 0013 explicitly excludes `UPDATE(published_revision_id)` from `estate_runtime` to enforce the immutable-history invariant. A direct column grant would break the 42501 security test. Instead, migration 0025 introduces a SECURITY DEFINER function `app.publish_document(p_document_id, p_revision_id, p_expected_version)` owned by `postgres` (BYPASSRLS) that performs the atomic optimistic-lock UPDATE and is the only path through which `estate_runtime` can move the pointer. `GRANT EXECUTE` on this function is the only privilege added.

## Null-composite guard

PostgreSQL composite-returning functions return a row with all-NULL columns (not 0 rows) when the WHERE clause finds no match. The repository checks `row?.id != null` rather than `?? undefined` to distinguish a real update from the no-op null-composite, ensuring a version mismatch produces 412 (`revision_changed`) rather than propagating through to `documentEtag(0)` which would throw `DraftConflictError(409)`.

## Permission

Requires `content.publish` at `organization` scope. `content.publish` is already in the Owner role preset; no role-definition migration is needed.

## Verification

85/85 integration tests pass, including:
- Publish sets pointer and bumps `row_version`; idempotent replay returns same job ID.
- Version mismatch returns 412.
- Foreign-document revision returns 404.
- Full publish → publish → rollback flow with idempotent replay.
- `content.publish` absence returns 403.
- Cross-tenant isolation verified.
- Security invariant (42501): `estate_runtime` direct UPDATE of `published_revision_id` still denied.
