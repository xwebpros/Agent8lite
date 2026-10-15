# Public template frontend checkpoint

This feature retains the selected public source at `920d148ee0ec6465381bf245381afcbdb5540bce`.
`source-parity.json` lists original byte hashes and intentional adaptations. Active JSX uses the native generated API and published CMS content; original CRM, Directus, authentication, private browser storage and outbound delivery are inactive.

## Reproducible commands

Run from the repository root with its pinned Node runtime and installed lockfile dependencies:

```powershell
node apps/web/features/idx-template/import-source.mjs
node apps/web/features/idx-template/build-styles.mjs
node node_modules/@biomejs/biome/bin/biome check --write apps/web/features/idx-template apps/web/app/templates/las-vegas-idx apps/web/public/idx-template-leaflet/provenance.json --diagnostic-level=error
node apps/web/features/idx-template/verify-source-parity.mjs
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/vitest/vitest.mjs run --config apps/web/features/idx-template/vitest.config.mts
```

The importer reads the selected read-only reference when present, or its archived original files otherwise. It regenerates active source-derived pages/components and the source manifest. It does not overwrite the native inquiry implementation. The style generator compiles source Tailwind utilities, scopes every top-level selector to `data-idx-template`, uses licensed local fonts, and copies unchanged Leaflet 1.9.4 images/license from the installed dependency. Absolute `/idx-template-leaflet/` image URLs prevent Next's CSS resolver from looking for source-relative images. Asset byte hashes live in `apps/web/public/idx-template-leaflet/provenance.json`.

## Executed evidence, 2026-10-13

- Focused Vitest: 23 tests passed in 2 files. The 17 controller tests cover overlapping submissions, response loss after durable acceptance, identical key/body replay, denial after uncertain acceptance, 408/409/425/429/5xx outcomes, definite rejection and reviewed correction, offline refusal, malformed receipts, invalid fields, remount retention and site/property scope.
- Six React static-render checks cover field labels/autocomplete/input modes, error associations and focusable summary, pending/uncertain field locks and deliberate retry, receipt-only success and synthetic no-delivery text, the mobile filter trigger name, and disabled native capabilities.
- Web TypeScript passed. Scoped Biome and whitespace checks passed.
- Source parity passed for 29 archived originals and 27 active files. CSS selectors and external URL restrictions passed; all five Leaflet image hashes matched.

## Current behavior and acceptance limits

Inquiry state lives only in the site's client layout memory. Same-site navigation, Back/forward, Next `router.refresh()` and the expired/offline content shell retain the original command, form revision and draft by the installed layout contract. The shared recovery panel remains available when the detail page or published content cannot render. A response loss never generates another key; fields remain locked until the original command has a verified durable receipt. After acceptance, private form values and command bodies are cleared. Offline mutations are refused; reconnection never automatically resends. Leaving/reloading warns about dirty or unresolved work, and unresolved link navigation is blocked. A forced reload, closing the tab, leaving the site via history, or a browser refusing unload prompts can discard tab memory; it is deliberately not persisted in private browser storage. Native backend idempotency and receipts remain authoritative. Browser behavior still requires the checks below.

Account, organizer, favorites, saved searches, AI interpretation, comparisons, recommendations, notifications, history and market statistics retain their source panels or controls with explicit unavailable states. Source policy/retention promises remain inactive until approved tenant legal content is published. No live MLS, messages, payments or licensed tile provider was enabled.

Mobile adaptations are limited to named filter controls with Escape/focus return, 16px text-entry controls and 44px button/input heights below 768px, accessible inquiry errors, and protecting recovery state. Source fonts, sections and classes otherwise remain preserved.

Browser interaction, screenshot/pixel parity, manual keyboard/axe verification at 360px, Leaflet interaction, physical iPhone/Android browser and installed-PWA behavior, service-worker update behavior and cross-site history loss are still unverified gates. Static rendering and archived source hashes cannot establish those gates. The coordinator owns full Next build, integration/security checks, production prerequisites and release status.
