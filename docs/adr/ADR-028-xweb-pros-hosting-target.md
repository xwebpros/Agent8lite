# ADR-028 — Owner-selected XWeb Pros hosting target

Accepted target selection on 2026-10-10. The owner supplied XWeb Pros, active server `68.178.204.192`, AlmaLinux 10 with cPanel, United States (West). These are owner-reported properties; the coordinator has not inspected or changed the server.

The TDD's Azure stack was a proposed default. The selected target changes the hosting plan without changing application contracts, tenancy, private storage, recovery or mobile acceptance requirements. Keep provider interfaces portable. This decision selects the destination; it does not certify its installed services, capacity or production readiness.

Use the existing Next.js web/BFF, Nest API and separately supervised worker model. Keep the API, PostgreSQL/PostGIS and Redis behind private bindings/network policy. The public HTTPS origin must reach the web application through a reviewed cPanel-compatible proxy. Preserve origin/CSRF checks and private/no-store responses through that proxy. Runtime, worker, control, issuer and migration database credentials remain separate; migration authority is never passed to web/API/worker processes.

cPanel documents AlmaLinux 10 support starting at cPanel/WHM132. Its Application Manager requires provider-enabled Passenger support. The documented EasyApache Node packages do not establish availability of this repository's pinned Node24.19.0, and a web process manager alone does not establish background-worker supervision. Verify the actual server before choosing Passenger, separately supervised services or OCI deployment. Do not downgrade runtime pins or replace PostgreSQL with MySQL to fit a default hosting package. See the [AlmaLinux requirements](https://docs.cpanel.net/installation-guide/system-requirements-almalinux/) and [Application Manager requirements](https://docs.cpanel.net/cpanel/software/application-manager/).

An authorized HTTPS staging origin, production identity, private object storage, backup/restore and queue recovery remain required. Synthetic authentication stays loopback-only; do not relax it to make a public preview usable. Live Trestle, delivery and payment adapters stay disabled until their own gates pass. M8 and owner-authorized release still precede production deployment.

The implementation and capability-verification sequence is in [the hosting runbook](../runbooks/xweb-pros-hosting.md). No server connection, package installation, DNS edit, credential transfer or deployment occurred while recording this decision.
