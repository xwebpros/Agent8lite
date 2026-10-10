# Agent8lite — Estate Workspace

An independent real-estate web application and PWA, currently running with synthetic identities, listings and external-service simulators. Implementation follows the approved technical design in docs/tdd and the frozen contracts in packages/contracts. The reviewed application is integrated on main; no milestone or production release is claimed.

The local application includes organization switching and administration, contacts, opportunities, follow-up tasks, notes, pipeline and deals, CRM configuration, routing, reviewed CSV imports/exports, billing simulation and support. The PWA includes install guidance, a generic offline shell and draft protection. Remaining module and milestone gates are recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); local success does not authorize a production release or live MLS access.

Use Node24.19.0 and pnpm11.25.0. Start the dedicated PostgreSQL/PostGIS service, migrate and seed explicitly enabled synthetic data, then run `pnpm dev`. The existing Windows workspace uses a dedicated portable database on loopback port55432. Follow the [local development runbook](docs/runbooks/local-development.md) for setup, role separation and verification commands.

Open the local application at http://localhost:3000. Synthetic sign-in offers fictional owner and agent identities. No app-store distribution is required; actual iPhone/Android installation acceptance needs HTTPS staging and physical-device checks.

Run `pnpm contracts:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test:isolated` and `pnpm build` for non-browser verification. The isolated runner creates/removes only its own databases, API processes and private-object directories. Browser tests use the approved Playwright harness when browser access is available.

For GoDaddy Node.js hosting, root `npm run build` and `npm start` use the assigned PORT. An explicit password-protected temporary demo runs without PostgreSQL or production identity. See the [GoDaddy launch runbook](docs/runbooks/godaddy-nodejs.md) for environment variables and preview limitations. Agents remain paused; deployment is a separate owner action.

Cotality/CoreLogic Trestle is the selected future MLS provider. The [disabled server scaffold and secure setup runbook](docs/runbooks/trestle-feed.md) are included. Live feeds, outbound messaging, charges and production deployment remain disabled until their documented authorization and integration gates are satisfied.

## Requirements and reference artifacts

- [Executive requirements PDF](reports/executive/Agent8lite-Application-Requirements-and-Features-2026-10-10.pdf) and [editable Word document](reports/executive/Agent8lite-Application-Requirements-and-Features-2026-10-10.docx).
- [Technical design](docs/tdd/) and [implementation blueprint](blueprint/).
- [Technical design package](Competitive-Real-Estate-SaaS-TDD-2026-10-10.zip).
- [Agent Elite audit package](Agent-Elite-Audit-2026-10-10.zip), [audit source](Agent-Elite-Audit-2026-10-10/) and [sanitized reference evidence](evidence/).
- [Reports and document-generation sources](reports/).

The audit is reference evidence about the observed platform, not permission to reuse proprietary functionality or a statement that inferred internal architecture is known. The blueprint describes planned behavior. The executive document is the forward-facing product requirements artifact.

See [publication notes](PUBLICATION_NOTES.md) for archive redaction and reference integrity. Existing main history and sanitized artifacts are preserved. Local environments, credentials, source Trestle PDF manuals, dependencies, databases, rendering QA and transient caches are excluded.
