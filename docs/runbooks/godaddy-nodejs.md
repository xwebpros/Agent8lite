# GoDaddy Node.js proof-of-concept launch

The repository root supports `npm run build` and `npm start` with local executables; no global pnpm is required for these commands. Next listens on `0.0.0.0` at the hosting-assigned `PORT`. Do not replace PORT with the local development ports. Explicit demo mode supports stable Node22.13+ within22.x or24.x. Full application, API, worker and local development still require the exact `.node-version` pin,24.19.0. See ADR-034 for the bounded compatibility decision.

Use the GitHub application's `main` branch and configure secrets through GoDaddy's environment-variable UI. Do not commit `.env`, credentials, node_modules or build artifacts. The platform's dependency-only install is supported: build-time TypeScript and required type packages are production dependencies with the existing exact version pins. GoDaddy selects the package manager from the lockfile/packageManager: this repository supplies pnpm11.25.0 and pnpm-lock.yaml. Use `pnpm install --prod --frozen-lockfile`, then `pnpm run build` and `pnpm start` when the host exposes those settings. The root scripts also run through npm after dependencies are installed; npm install does not consume the pnpm lockfile. Root package.json declares the existing launcher as main, and .npmrc explicitly selects the public npm registry.

The official [GoDaddy hosting contract](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/contract.md) permits outbound HTTP/HTTPS and GoDaddy-managed MySQL, not external PostgreSQL or Redis. Deploy the isolated demo on this Node.js PaaS. Host the PostgreSQL/PostGIS SaaS on suitable infrastructure such as the separately specified XWeb Pros VPS; its runtime and database prerequisites remain required. A single root start boots the demo's only Next server, consistent with the repository's [single-entry exception](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/AGENTS.md).

## Official hosting audit — 2026-10-10

Reviewed [GoDaddy's published skill](https://github.com/godaddy/nodejs-hosting-agent-skill/blob/main/skills/godaddy-nodejs-hosting/SKILL.md) and contract version3 at repository commit37fb2ea7d1d7b54fa716a60134e915e3e24bd98c. Its validator found missing package.json main (E008); manual review also found the missing explicit npm registry (C14). Both are corrected without changing dependency versions, API contracts or application behavior.

| Requirement | Verification |
| --- | --- |
| Root name/version/main/build/start | Existing launcher declared as main; real TypeScript/Next build and root start |
| Production dependency installation | Fresh pnpm11.25.0 `install --prod --frozen-lockfile` succeeds; dev dependencies omitted |
| Lockfile/public registry | Frozen lockfile accepted; no non-public URL; explicit .npmrc public registry |
| Assigned port/public listener | Root launcher passes assigned PORT and0.0.0.0 to Next; owned non-default port smoke succeeds |
| Single app | Demo boots one Next child; no API, worker, PostgreSQL, Redis or provider needed |
| Source hygiene | Git-tracked source export:906 files/66,046,116 bytes before this documentation update; no secret env files, node_modules or build/cache files |
| Official validator | Completed source-only export passes `validate-paas.mjs . --strict`, exit0/no warnings |
| Build/start | Production-only compile/build succeeds; root start and hosted-dev demo probes pass28 assertions, clean owned-process shutdown |
| Session/API/PWA server boundaries | Password/origin/cookie/no-store/logout/API isolation, manifest and service-worker responses pass; browser/device acceptance remains open |
| Network/email | Demo requires no outbound DB, Redis, SMTP, email gateway or live service |
| Actual GoDaddy acceptance | Pending current deployed commit, hosting commands, supported demo Node version, env settings, exact HTTPS URL and current build/start logs |

The validator only checks source heuristics; it does not establish network, hosting runtime, environment, HTTPS or browser acceptance. Its local node_modules warning is expected for an installed checkout; Git never uploads that ignored directory. Run it on completed source-only deployment input, not an installed directory or an unfinished export. Windows callers can use `.` as the target while running from the project directory.

For the connected GitHub application, sync/redeploy the latest main. Confirm repository root as the app folder, production installation, root build and root start; keep the platform's PORT. Set the demo settings below through the hosting UI. Successful launch logs contain `status:ready`, `mode:demo` and the assigned port. If still failing, capture the first error in install/build/start and the deployed commit; do not include secret values.

| Fixed error code/log | Required check |
| --- | --- |
| `Synthetic workspace` / EACCES port3000 | Old source or local dev command: latest main, root start and assigned PORT |
| `application_build_node_version_invalid` / `launch_node_version_invalid` | Read safe `node` and `requiredNode` diagnostics. Enable explicit demo mode at build/start and use stable22.13+ within22.x or24.x; full mode still requires24.19.0 |
| `application_build_configuration_invalid` | Use the root build without unsupported arguments; retain the same valid build directory at start |
| `launch_port_required` | Keep GoDaddy's supplied PORT; do not configure local development ports |
| `launch_web_origin_required` | WEB_ORIGIN must equal the site's HTTPS origin with no trailing slash/path |
| `launch_demo_secrets_required` | Demo flag and both independent secret values must meet the documented lengths |
| `launch_database_url_required` | Demo flag absent/false; enable the database-free demo on this PaaS |
| `application_launch_failed` | Confirm successful build and use the same default .next directory at build/start; check first host error and resource/runtime limits |

## If the host runs dev and reports EACCES on port3000

Logs containing `node scripts/dev.mjs`, `Synthetic workspace` and `listen EACCES ...127.0.0.1:3000` show the local development command was selected. Set the build command to `npm run build` and the start/run command to `npm start`, then redeploy GitHub main. Keep PORT at the host-assigned value. Do not force port3000 or enable ordinary synthetic authentication to resolve this error.

The dev command also has a host compatibility safeguard: a supplied PORT, production NODE_ENV/APP_ENV or explicit HOSTED_DEMO_ENABLED=true selects the same production launcher as npm start, before loading local fixture settings or dev dependencies. Updated logs show `hosted-launch-selected`, then `status:ready` with the assigned port. Missing/invalid PORT reports `launch_port_required`; it never falls back to port3000. An old `Synthetic workspace` log after redeployment indicates old source or missing hosting settings. Both launch paths still need a successful build and the mode's environment configuration below. Local development without hosting markers continues to use the loopback workflow.

## Temporary preview without PostgreSQL or a production identity provider

Set these values before both building and starting:

| Variable | Value |
| --- | --- |
| `HOSTED_DEMO_ENABLED` | `true` |
| `WEB_ORIGIN` | Exact HTTPS preview/site origin, such as `https://your-preview-host.example`; no trailing slash or path |
| `DEMO_ACCESS_PASSWORD` | Your private randomly generated preview password,16–128 characters |
| `DEMO_SESSION_SECRET` | An independent randomly generated signing secret,32–256 characters |
| `PORT` | Assigned by GoDaddy |

No DATABASE_URL, migration identity, Redis, worker or external provider is needed in this mode. The launcher starts only Next. Open the root URL; it redirects to `/demo`, where the shared preview password unlocks a separate sample workspace. Contacts, pipeline stages, tasks, saved sample homes, website content and message drafts can be changed temporarily. All records are fictional; reload/reset discards edits. No email/SMS, publishing, payments or live MLS operation exists in this preview.

Demo build compiles Next only and reports `application-built`, `mode:demo` and actual `node`. Ready logs also report actual Node. The install envelope is `>=22.13.0 <23 || >=24.0.0 <25`, matching the existing pnpm/Next requirements without changing dependency versions. Actual production-only builds and both root/hosted-dev starts pass on Node22.23.3 and24.21.0; each binary passes28 server boundary checks. Unsupported versions deny with bounded version diagnostics. These local Windows results do not establish GoDaddy's actual runtime or Linux/HTTPS acceptance. If the host supplies Node20 or an odd major, select a supported runtime; do not remove the guard.

Password-manager/paste support is enabled. Sign-in is same-origin, rate-limited and uses an HttpOnly/SameSite=Strict one-hour cookie scoped to `/demo`; HTTPS cookies are Secure. Logout clears that cookie and requires session-bound CSRF. Cookies are stateless: an already copied cookie remains valid until expiry or signing-secret rotation. Rotate DEMO_SESSION_SECRET to revoke all preview sessions, and change the password when access changes. Preview secrets are server-only and are never exposed through NEXT_PUBLIC values. Private HTML/RSC/routes are no-store; the service worker retains only safe static assets and the generic offline shell. This is preview access, not SaaS membership authentication.

Ordinary `/api/*` requests fail closed in demo mode. Turning the mode off requires a full rebuild on24.19.0 and restores normal database/identity prerequisites; a demo build does not produce or certify API/worker artifacts. Preview changes cannot be promoted into real records. Add to Home Screen/Install uses the existing manifest/service worker on HTTPS, but physical iPhone/Android acceptance is still required. Reopening the installed app routes through the same preview access. Offline mutations are unavailable.

## Full application launch

This mode is not compatible with the GoDaddy Node.js PaaS network contract. These instructions apply to a host with supported PostgreSQL/PostGIS connectivity.

Use Node24.19.0 and leave HOSTED_DEMO_ENABLED unset or false during build and start. Full build compiles both API/worker and Next. Standalone `start:api`/`start:worker` also enforce this pin, regardless of a demo flag. Configure `WEB_ORIGIN` and an explicit private PostgreSQL `DATABASE_URL` for a non-owner, NOSUPERUSER/NOBYPASSRLS runtime identity. The launcher starts API on127.0.0.1 at an ephemeral port and passes its verified IPC-reported origin to Next's existing BFF. Migration/control/issuer/provider credentials are not passed to the web child. It never migrates, seeds or starts the worker. Provision/migrate PostgreSQL/PostGIS separately under the reviewed migration identity.

Both processes force production mode and disable ordinary synthetic authentication, even if inherited development flags are true. The full application currently has no configured production identity adapter, so its authenticated workflows deny access. Use the isolated preview above for the proof of concept rather than weakening identity/RLS guards.

Unexpected child exits fail the launcher and stop its sibling. SIGINT/SIGTERM stop owned children; API IPC closes the app/pool, with bounded forced termination if needed. Next CLI readiness parsing is pinned to16.4.0 and must be reviewed when upgrading Next. No public process-control endpoint exists. Actual GoDaddy process supervision, assigned origin/HTTPS, resource limits and redeployment behavior remain host checks.

## Local verification

Use the approved pinned Node/runtime and local fixture PostgreSQL service. Keep ESTATE_BUILD_DIR=.next-build for checks beside a live Next development instance; it protects the development `.next` output.

```powershell
$env:ESTATE_BUILD_DIR = '.next-build'
node scripts/build-app.mjs
node scripts/verify-runtime.mjs
node scripts/verify-runtime-local.mjs
node scripts/verify-launch-local.mjs
pnpm exec vitest run --config scripts/vitest.launch.config.mts
pnpm exec vitest run tests/unit/hosted-demo.test.ts
```

The launch probe uses only its own non-default ports/processes, public loopback fixture DB credentials and synthetic preview secrets. It verifies application BFF routing, forced production denial, sibling cleanup after a web failure, and a web-only preview's origin/password/cookie/CSRF/logout boundaries. It does not deploy, dispatch work, load secrets, inspect browser UI or close any M8/production gate. Bounded agents reviewed runtime compatibility and tests; unrelated implementation work remains outside this hosting fix.
