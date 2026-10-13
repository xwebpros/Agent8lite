# Las Vegas IDX template integration

The imported public website comes from `djmichaelmartin-cmd/Las-Vegas-Live-IDX`, `Full_Web_App_phase_1`, commit `920d148ee0ec6465381bf245381afcbdb5540bce`. Agent8lite owns CMS revisions and CRM leads. The source application's Directus, CRM, SMTP, administration and automation backends are excluded. Source history and its deployment are separate.

## Create and view a local site

1. Use the approved Node/pnpm pins and install the committed lockfile with `pnpm install --frozen-lockfile`. Apply forward migrations with the migration identity using `pnpm db:migrate`. Keep runtime/worker credentials separate. Never reset an existing database or change an applied migration checksum. An existing unrecorded0032 schema needs its separately reviewed ledger repair; rerunning or resetting it is not a remedy.
2. Start the application's development services using the existing launcher/runbook. Defaults remain web `http://localhost:3000`, API loopback3001, mock MLS and no-delivery. Configure `IDX_TEMPLATE_WEB_ORIGINS` to the exact web origin used for the new site; `localhost` and `127.0.0.1` are distinct origins.
3. In `/websites`, create a site using **Las Vegas IDX — Agent** (`las-vegas-idx-agent@1.0.0`) or **Las Vegas IDX — Brokerage** (`las-vegas-idx-brokerage@1.0.0`). Select its authorized business profile. Create its `home` page with the selected template's draft starter. Edit the hero, quick-search, explore and footer copy, brand and SEO in native CMS. Save the immutable revision. Saving does not publish.
4. Provision a loopback-only mock binding with the explicit tenant/site/document/profile/mock-feed references using `scripts/idx-template/` and its README. The reviewed tool may create a site-scoped synthetic lead source, a draft four-field form and a dedicated non-login capture identity. Agent sites require an explicit currently eligible agent membership; brokerage sites use their current native routing rules. No MLS display name establishes member identity.
5. Explicitly publish the native content revision and the form version through CMS. Run the same provisioning command again to activate only the tool-owned, unchanged mock binding after its checks pass. It does not publish content, replace differing bindings, renew expired approval or activate live access. Keep the reported IDs and expiry as an operational checkpoint.
6. Open `/templates/las-vegas-idx/<siteId>`, or select the site in CMS and use **View published IDX website**. The gallery is `/templates/las-vegas-idx`; `IDX_TEMPLATE_EXAMPLE_SITE_ID` can provide an explicit configured example link. Only a current published revision renders. Drafts, revoked bindings, expired approvals and unverified hosts cannot select private content.
7. Search permitted synthetic listings, open a listing and submit **Ask about this property** with a fictional test name/email/phone/message. Confirm its durable receipt and the native CRM contact/lead, original message note, source site/feed/listing, routing decision and lack of inferred marketing consent. No email delivery is promised. Reconcile an uncertain request with its same UUID and frozen body; do not create another key merely because a response was lost.

Mock images must be explicitly provisioned local synthetic assets under `/idx-template-fixtures/`; `synthetic-home.svg` is an original fictional illustration. Do not copy customer/provider media into mock fixtures. Missing permitted data or images are shown as unavailable. Empty valid searches remain distinguishable from a provider error.

## Runtime and activation boundaries

Public browser requests use `apps/web/app/api/idx-template/[siteId]/[...path]/route.ts`. The server signs the exact method, URL/query, origin, timestamp, submission key and body hash. API routes verify the signature, allowed private peer and explicit server-owned binding before a tenant transaction. They do not use a visitor-supplied tenant, assignee, forwarded host or human Owner cookie as authority.

Production needs a shared `IDX_TEMPLATE_BRIDGE_SECRET` of at least32 characters on web/API, explicit `IDX_TEMPLATE_WEB_ORIGINS`, approved private API address and `IDX_TEMPLATE_BRIDGE_PEERS`. The visibly synthetic fallback exists only in explicitly enabled loopback development/test. Never expose migration credentials to either runtime.

Migration0035 adds tenant-bound bindings and explicit listing assignments with FORCE RLS; runtime cannot activate them. Migration0036 grants only current-media projection columns and lock-only UPDATE with mutation denial. Both are forward migrations. Revocation is an operational server-owned binding change; services recheck binding, membership, policy, feed, source and listing state after waits and before durable effects.

The original Trestle query/address/full-media code is retained with hashes in `docs/reference/las-vegas-live-idx/` and adapted as an injected server-only client in `packages/providers/mls/las-vegas-idx/preserved-client.ts`. Its caches are instance-local and import performs no environment-file read or provider request. The default live provider remains closed. Existing approved account connectivity is credited, but does not establish licensed rights for every new tenant/site. Live activation requires the documented M6 rights, field mapping, attribution, expiry/withdrawal/media/cache rules, bounded transport, provider acceptance and monitoring. Tile providers and real delivery have separate gates.

The source account/organizer, community, saved-homes and legal page layouts are retained. Unconnected visitor, AI, comparison, notification, market-statistic and legal-publication capabilities are visibly unavailable. Native CRM/admin links replace source private workspaces. This import does not claim the full MOD-C block catalog, all MOD-F features or M1–M8 completion.

Public template/API/RSC data are `no-store`; service workers persist only approved static assets and the generic offline shell. Drafts and unresolved inquiry commands use tab memory, without localStorage/IndexedDB. A full browser restart does not preserve that memory; database receipts remain authoritative.

## Verify and hand off

- `pnpm contracts:check`, `pnpm typecheck`, scoped/full `pnpm lint`, and `pnpm build` must pass against the final integrated tree.
- `pnpm test:idx-template:unit` runs contract/bridge/injected-provider checks without a database or outbound network. The owned isolated PostgreSQL/PostGIS setup and real-role tests are documented in `tests/idx-template/README.md`; `pnpm test:idx-template` uses that separate cluster, never the interactive application's data directory.
- Run meaningful CMS/template/capture regressions after shared changes. Record exact totals, executed commands and source-parity results in `IMPLEMENTATION_STATUS.md`.
- Required browser acceptance remains search → listing → inquiry → CRM, CMS draft → publish → rollback, keyboard/focus/errors and responsive360/768/1440px views. Physical iPhone/Android installed/browser acceptance is an M8 gate. Static checks and server rendering do not substitute for those results.
- Push the verified branch `Las-Vegas-IDX` to `https://github.com/xwebpros/Agent8lite.git`; preserve separate demo history during integration. Review all remaining acceptance gaps before merging main or activating a public/live deployment.
