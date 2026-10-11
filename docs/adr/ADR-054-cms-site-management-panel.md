# ADR-054 — CMS site management panel (domains, media, forms)

Accepted 2026-10-12, coordinating session. Implements MOD-C-005/006/007/008 PWA slice on top of the ADR-053 API backend. No new server routes, migrations, contract changes, or external providers.

## Scope

Adds a **Manage Site** section to the existing `CmsWorkspace` when a site is selected. Three panels:

- **Domains** — lists active domains (GET `/sites/{siteId}/domains`), adds a domain (POST), verifies a domain (POST `/domains/{id}/verify`), archives a domain (POST `/domains/{id}/archive`). Shows the required DNS TXT record when verification state is `pending`.
- **Media** — lists media assets owned by the organization (GET `/media?limit=20`), finalizes a pending asset (POST `/media/finalize` with `id`, `contentSha256`, optional `altText`). No upload UI in this slice; upload is signed and out of scope here.
- **Forms** — lists the latest-version forms for the selected site (GET `/sites/{siteId}/forms`), creates a form (POST `/sites/{siteId}/forms` with `name` + a minimal single-field `definition`). Lists form versions (GET `/forms/{formId}/versions`) as a read-only accordion. A form editor is deferred.

## Authorization and invariants

All calls require the existing `domains.manage`, `media.write` and `forms.write` grants checked by the service. The panel checks the session's permission set and shows each tab only when the corresponding grant is present. Mutation calls require an `Idempotency-Key` (UUID generated fresh per attempt) and `X-CSRF-Token`. Second-call idempotency replays are handled the same way as the draft-editor (uncertain = retry-safe).

## What is deferred

Publication, signed upload, form designer, domain TLS provisioning, actual DNS verification jobs, site archival UI, and media derivatives remain deferred. The panel is read-write for the above operations only; unavailable operations are not shown.

## Component

`apps/web/features/cms/site-management.tsx` renders three tabs: Domains, Media, Forms. It is imported and rendered by `cms-workspace.tsx` below the document section when a site is selected and at least one of `domains.manage`, `media.write`, or `forms.write` is present. The component receives the site ID, org base URL, CSRF token, online flag, and access revision. It is a `"use client"` component.

No new CSS module file; uses the existing design tokens via Tailwind-like inline class names through the existing `packages/ui` components.
