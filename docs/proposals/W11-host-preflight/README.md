# XWeb Pros host capability preflight

Implemented 10 October 2026 as a bounded W11/M8 deployment-preparation tool under ADR-028. This directory and `scripts/hosting/**` are the owned scope. Shared dependencies, API contracts, migrations, runtime startup and application modules are unchanged.

The selected destination is XWeb Pros, `68.178.204.192`, owner-reported AlmaLinux 10/cPanel, United States (West). The tool inspects this exact IP through an existing locally configured OpenSSH alias. Its configured account, key and port are supplied by OpenSSH; it accepts no password/key values and does not load any application `.env` file.

The SSH process uses strict host-key verification, key-only batch authentication, no agent/X11/port forwarding, no local command and no reused SSH control socket. Host-key updates/DNS trust and automatic agent key loading are disabled. SSH configuration can still supply an existing proxy/jump arrangement; use only the authorized alias for this server. No new SSH trust, account access or credential is created by the tool.

## Inspect the command before connecting

Using the repository's pinned Node24.19.0:

```powershell
node scripts/hosting/preflight.mjs --help
node scripts/hosting/preflight.mjs --ssh-target agent8lite-staging --dry-run
```

`agent8lite-staging` is an example alias, not a configured account or a claim of access. Dry-run prints the fixed SSH arguments and complete Bash probe and makes no network call. The program always overrides HostName to the selected IP; it does not accept arbitrary hosts or remote commands.

Once the authorized alias exists and its host key is verified through normal SSH setup:

```powershell
node scripts/hosting/preflight.mjs --ssh-target agent8lite-staging
```

No server connection was performed during implementation. Do not paste passwords or private keys into chat, Git, command arguments or the report.

## What is inspected

The fixed Bash probe reads OS/cPanel versions, architecture, the inspected account's Node version, installed pnpm package metadata, PostgreSQL client/Redis binary versions, CPU count, memory, root-filesystem free space and visible process-manager/proxy executable availability. Its inner shell clears BASH_ENV/ENV and disables profile/rc loading. The server's outer SSH account-startup policy remains outside this tool; use the authorized inspection account. The probe never invokes pnpm/Corepack, reads application configuration, connects to a database or Redis, enumerates process arguments, invokes sudo, installs packages, starts/stops services, edits DNS or deploys the application.

Only known bounded tokens, numeric/version values and booleans enter the JSON report. A per-run framed protocol rejects incomplete, duplicate, unknown, contradictory and malformed facts. SSH banners, raw errors and other command output are discarded. Total output and execution time are bounded; timeout/overflow stops only the spawned SSH process, escalating if necessary. Unreadable facts remain unknown rather than becoming zero or success.

Runtime checks compare Node24.19.0/pnpm11.25.0 to the repository pins. The cPanel/AlmaLinux checks reflect the [official AlmaLinux requirements](https://docs.cpanel.net/installation-guide/system-requirements-almalinux/): AlmaLinux10 requires cPanel132 or later, with x86_64 rather than ARM. This is a compatibility observation, not a recommendation to install, downgrade or modify an existing shared server.

The inspected SSH account may differ from the application service account. PATH-visible binaries and root-filesystem resources do not establish private services, effective account quotas, capacity, PostgreSQL server/extension versions, RLS roles, private networking, worker supervision, TLS, backups or restore. External private database/Redis services remain possible when a local executable is absent.

## Result and release gates

- Exit0: the inventory completed, or help/dry-run completed. Unknown observations may remain.
- Exit1: arguments, SSH access, timeout, stream/output limits or response validation failed. A closed error code/message is printed; raw output is never printed.
- Exit2: inventory completed but an observed platform/runtime differs from the selected requirements.

Every report has `deploymentReady: false`. Complete inventory never authorizes deployment or live MLS. The report retains explicit gates for capacity, application-account runtime, private PostgreSQL/PostGIS/roles, Redis recovery, durable supervision, production identity, DNS/TLS/proxy/cache behavior, private storage/restore and physical PWA/security/M6/M8 acceptance. Follow [the host runbook](../../runbooks/xweb-pros-hosting.md) and ADR-028/ADR-030 for subsequent implementation and review.

## Verification

```powershell
node node_modules/vitest/vitest.mjs run --config scripts/hosting/vitest.config.mts
node node_modules/@biomejs/biome/bin/biome check scripts/hosting --diagnostic-level=error
node --check scripts/hosting/preflight.mjs
```

The isolated suite uses Vitest5.0.3 and synthetic inventories; it never connects to XWeb Pros. It covers shell/option injection, fixed host/trust/forwarding behavior, malformed/partial/duplicate/prototype-bearing responses, unknown versus zero, mismatch reporting, false readiness claims, secret-bearing banners/errors, bounded process execution, timeout escalation, stream failure, real local subprocess stdin handling, Windows newline/BOM normalization, dry-run and import safety. These cases are separate from the application-wide aggregate and close no server or M8 acceptance gate. Linux probe execution still requires the first authorized host inspection; no Bash runtime is available in the current Windows environment.

Latest local result: **49/49 tests pass**, with JavaScript syntax and scoped Biome checks passing. Actual CLI help and dry-run also run under the pinned Node runtime. This count is not added to an application aggregate unless the integration harness runs the suite.

The original coordinating owner's in-progress compiled-runtime files were preserved. Integration can review/register this isolated suite in the shared harness without changing its tests or weakening deployment gates.
