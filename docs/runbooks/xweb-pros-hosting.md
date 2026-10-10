# XWeb Pros hosting target

Owner-selected on 2026-10-10: XWeb Pros, active server `68.178.204.192`, AlmaLinux 10 (cPanel), United States (West). ADR-028 records this selection. Installed cPanel version, account permissions, CPU/RAM/disk, hostname, DNS, TLS and service capabilities remain unverified. No deployment has occurred.

## Application topology

| Component | Repository behavior and hosting requirement |
| --- | --- |
| Web/BFF | Next16.4.0/React19.3.0 on Node24.19.0. `apps/web` builds with pnpm11.25.0; `pnpm --dir apps/web start` currently binds127.0.0.1:3000. Requires a supervised process and a public HTTPS reverse proxy. This is a server-rendered application with a BFF, not a static `public_html` upload. |
| API | Nest12.1.2, currently loopback3001. `pnpm build:runtime` emits `dist/runtime/apps/api/src/main.js`; `pnpm start:api` starts the compiled entrypoint. Requires a separate process, private database access, exact web-origin configuration and verified production identity. Current synthetic sign-in is disabled outside explicit local development/test mode. A production identity adapter/return flow remains unfinished. |
| Worker | `pnpm start:worker` starts the compiled PostgreSQL-authoritative outbox recovery process independently of Redis wakeups. Requires separate supervision, explicit trusted `WORKER_CONTEXTS` and non-owner worker credentials outside approved synthetic mode. Trusted production context discovery, campaign execution, CMS hosting and MLS replication remain unfinished boundaries. The current reference-ledger consumer is no-delivery. |
| Database | Acceptance uses PostgreSQL17.10/PostGIS3.6.2 with actual0001–0019,84 FORCE-RLS tables and distinct non-bypass runtime/worker/control/issuer roles. Migration ownership is separate. Verify these capabilities on a private service before running any migration. |
| Queue | Redis7.4.6 is the development service pin. Requires private connectivity and recovery evidence with BullMQ5.61.0/ioredis5.8.1. PostgreSQL remains the durable source. Actual Redis restart/data-loss acceptance is still open. |
| Private objects/secrets | Current private-transfer implementation uses a local filesystem adapter. Production needs an approved storage/secret adapter, access checks, retention and independent restore. Keep private uploads, credentials and agreements outside the public document root and version control. |

The root `compose.yaml` is a loopback synthetic development configuration, not a production deployment bundle. Its PostgreSQL image tag also does not establish the locally verified PostGIS3.6.2 runtime. ADR-030 adds the pinned local compiled API/worker build/start seam. Local verification is recorded in IMPLEMENTATION_STATUS.md; actual Linux/host execution, production OCI images, service definitions and rollout automation remain unverified.

## Server capability verification

Once a server-access configuration is available, perform read-only inspection first and record results without secrets:

1. Confirm OS/cPanel versions, available account/root permissions, resource limits and existing hosted applications. AlmaLinux10 requires cPanel/WHM132 or later in the [official requirements](https://docs.cpanel.net/installation-guide/system-requirements-almalinux/). The owner's control-panel summary does not prove installed patch level or available resources.
2. Confirm the exact Node24.19.0 and pnpm11.25.0 runtime under the application account. [Application Manager](https://docs.cpanel.net/cpanel/software/application-manager/) requires its feature and Passenger package to be enabled. Its documented Node package choices do not prove the pinned runtime exists. Choose a provider-supported pinned runtime/service arrangement after inspection; preserve the lockfile.
3. Confirm separate durable worker supervision and restart behavior. Web request-driven Passenger startup is insufficient evidence that the background recovery process will run continuously.
4. Confirm private PostgreSQL/PostGIS and Redis versions, role administration, extension installation, private connectivity, backup destinations and restore permissions. A cPanel database menu does not prove PostGIS or non-bypass role capabilities. Do not modify another hosted application's database installation to accommodate this application.
5. Confirm the intended staging/application domains and valid HTTPS, then verify DNS and the chosen proxy configuration. Use supported cPanel configuration mechanisms; do not overwrite generated web-server files. The official [Apache virtual-host include guide](https://docs.cpanel.net/ea4/apache/modify-apache-virtual-hosts-with-include-files/) and [NGINX customization guide](https://docs.cpanel.net/knowledge-base/nginx/customize-reverse-proxy-nginx-configurations/) describe their respective extension points. Which mechanism exists on this host is still unknown.

## Proxy and PWA verification

Route the approved HTTPS application origin to the web/BFF. Keep API/database/queue listeners private and overwrite untrusted forwarding headers at the verified edge. Review explicit trusted-proxy behavior before production; never weaken synthetic loopback checks to accept a public reverse proxy.

Preserve `private, no-store` for API, authenticated HTML/RSC, exports and all personalized responses. Disable proxy/CDN caching for them. Cache only approved static assets and the generic offline shell. `/sw.js` must retain its no-cache/no-store update headers and root scope. Verify service-worker upgrades with protected drafts and original idempotency keys.

Use the approved HTTPS staging domain for physical iPhone Safari/browser and installed-home-screen tests and Android Chrome/browser and installed tests. The supplied IP alone does not establish a suitable PWA origin. No app-store distribution is required.

## Build, release and recovery sequence

Keep implementing missing module boundaries locally. Before staging, complete production identity and environment validation, private adapters and host capability inspection, then reproduce and verify the ADR-030 artifacts on Linux and the selected host. Build an exact committed release with `pnpm install --frozen-lockfile`, contract validation, typecheck, lint, the relevant tests and `pnpm build`. The root build now compiles API/worker and builds Next; it performs no migration, seed or deployment. Install production dependencies on the target OS from the exact lockfile; do not transfer Windows node_modules.

`pnpm verify:runtime` checks artifact integrity, inert API import and worker empty-context denial without database access. `pnpm verify:runtime:local` is only for the existing loopback fixture database: it uses fixed public synthetic runtime credentials and creates/revokes a synthetic session. Do not point this command at staging/production or repurpose it for migrations. It proves local startup boundaries, not production identity. Record actual Linux verification separately.

Build commands are serialized and the workspace dist/runtime replacement is not an atomic deployment swap. Deployment must use separately owned immutable release directories, supervised process transitions and explicit rollback. Run migrations under separate migration authority and verify non-owner runtime roles; never run the synthetic seed against production.

Verify staging isolation, CSRF/proxy behavior, private cache policy, UI/accessibility/device workflows and independent PostgreSQL/object/Redis recovery. Record measured capacity and approved RPO/RTO. Release requires the launch-scope milestone gates, M8 and owner authorization. Keep an explicit rollback/forward-migration plan and backups independent of the server. Passing local tests does not close those operational gates.

Pending inputs for that stage are the actual SSH/account access mechanism, staging/application domains and TLS ownership, capacity, private data/queue/object/secret services and operational ownership. Do not request or store passwords in this document. None of these inputs blocks continued synthetic application implementation.
