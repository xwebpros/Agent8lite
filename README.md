# Estate Workspace

An independent real-estate web application and PWA, currently running with synthetic identities, listings and external-service simulators. Implementation follows the approved technical design in `docs/tdd` and the frozen contracts in `packages/contracts`.

The local application includes organization switching and administration, contacts, opportunities, follow-up tasks, notes, pipeline and deals, CRM configuration, routing, reviewed CSV imports/exports, billing simulation and support. The PWA includes install guidance, a generic offline shell and draft protection. Remaining module and milestone gates are recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md); local success does not authorize a production release or live MLS access.

Use Node 24.19.0 and pnpm 11.25.0. Start the dedicated PostgreSQL/PostGIS service, migrate and seed explicitly enabled synthetic data, then run `pnpm dev`. The existing Windows workspace uses a dedicated portable database on loopback port 55432. Follow the [local development runbook](docs/runbooks/local-development.md) for setup, role separation and verification commands.

Open the application at `http://localhost:3000`. Synthetic sign-in offers fictional owner and agent identities. No app-store distribution is required; actual iPhone/Android installation acceptance needs HTTPS staging and physical-device checks.

Run `pnpm contracts:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test:isolated` and `pnpm build` for non-browser verification. The isolated test runner creates and removes only its own databases, API processes and private-object directories. Browser tests use the approved Playwright harness when browser access is available.

Trestle is the selected future MLS provider. Live feeds, outbound messaging, charges and production deployment remain disabled until their documented authorization and integration gates are satisfied.

For GoDaddy Node.js hosting, root `npm run build` and `npm start` now use the assigned `PORT`. An explicit password-protected temporary demo can run without PostgreSQL or production identity. See the [GoDaddy launch runbook](docs/runbooks/godaddy-nodejs.md) for required environment variables and the preview's limitations.
