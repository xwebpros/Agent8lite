# ADR-056 — CMS document publication panel (MOD-C-003 PWA)

Accepted 2026-10-12, coordinating session. Adds the frontend publication panel for the `publishDocument` and `rollbackDocument` operations implemented in ADR-055.

## Scope

`apps/web/features/cms/document-publication.tsx` — `CmsDocumentPublication` component, mounted in `cms-workspace.tsx` when:
- A document is selected (`documentId` is non-empty), AND
- The session has `content.publish` permission, AND
- Data context is current (`currentData`)

The panel:
1. **Reads** the current document state (`GET /v1/orgs/{orgId}/documents/{documentId}`) on mount and after any successful command, showing the current `version` and `publishedRevisionId`.
2. **Reads** the revision list (`GET /v1/orgs/{orgId}/documents/{documentId}/revisions?limit=20`), letting the user select which revision to publish or roll back to.
3. **Executes** `POST .../publish` or `POST .../rollback` with `{ revisionId, expectedDocumentVersion }` and a fresh `Idempotency-Key`.
4. **Handles** uncertain outcomes (5xx / network errors): retains the key and shows a retry prompt. On 412 (version changed), reloads the document and shows a clear message. Known rejections (4xx except 412/408) clear the key and show the error.

## Authorization and invariants

- `content.publish` permission check is done in the service layer (API); the panel hides entirely when the permission is absent.
- Idempotency key is generated fresh per attempt (or retained for retry on unknown outcomes), matching the pattern used by all other CMS command panels.
- No draft state is modified; this is a pure pointer-move operation.

## What is deferred

- Publishing directly from a loaded draft revision (without selecting from the list) — deferred; the panel provides a full list instead.
- Real-time publication state subscription — not available; the panel reloads on demand.
- Signed-URL asset publishing pipeline — out of scope for this panel.
