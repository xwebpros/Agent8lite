# GoDaddy Node.js proof-of-concept launch

The repository root now supports `npm run build` and `npm start`. Build compiles the API/worker artifact and Next with local pinned executables; no global pnpm is required for these commands. Next listens on `0.0.0.0` at the hosting-assigned `PORT`. Do not replace PORT with the local development ports. Node24.19.0 is the required engine; verify the selected hosting runtime supports it before import.

Use the GitHub application's `main` branch and configure secrets through GoDaddy's environment-variable UI. Do not commit `.env`, credentials, node_modules or build artifacts. The platform's dependency-only install is supported: build-time TypeScript and required type packages are production dependencies with the existing exact version pins. pnpm11.25.0 plus the frozen pnpm lockfile remains the reproducible repository/CI install. GoDaddy's npm install does not consume that lockfile; a clean npm production-only install is separately smoke-tested, but transitive npm resolution is not promised to be byte-identical to pnpm.

## If the host runs dev and reports EACCES on port3000

Logs containing `node scripts/dev.mjs`, `Synthetic workspace` and `listen EACCES ...127.0.0.1:3000` show the local development command was selected. Set the build command to `npm run build` and the start/run command to `npm start`, then redeploy GitHub main. Keep PORT at the host-assigned value. Do not force port3000 or enable ordinary synthetic authentication to resolve this error.

The dev command also has a host compatibility safeguard: a supplied PORT, production NODE_ENV/APP_ENV or explicit HOSTED_DEMO_ENABLED=true selects the same production launcher as npm start, before loading local fixture settings or dev dependencies. Updated logs show `hosted-launch-selected`, then `status:ready` with the assigned port. Missing/invalid PORT reports `launch_port_required`; it never falls back to port3000. An old `Synthetic workspace` log after redeployment indicates old source or missing hosting settings. Both launch paths still need a successful build and the mode's environment configuration below. Local development without hosting markers continues to use the loopback workflow.

## Temporary preview without PostgreSQL or a production identity provider

Set these values before starting:

| Variable | Value |
| --- | --- |
| `HOSTED_DEMO_ENABLED` | `true` |
| `WEB_ORIGIN` | Exact HTTPS preview/site origin, such as `https://your-preview-host.example`; no trailing slash or path |
| `DEMO_ACCESS_PASSWORD` | Your private randomly generated preview password,16–128 characters |
| `DEMO_SESSION_SECRET` | An independent randomly generated signing secret,32–256 characters |
| `PORT` | Assigned by GoDaddy |

No DATABASE_URL, migration identity, Redis, worker or external provider is needed in this mode. The launcher starts only Next. Open the root URL; it redirects to `/demo`, where the shared preview password unlocks a separate sample workspace. Contacts, pipeline stages, tasks, saved sample homes, website content and message drafts can be changed temporarily. All records are fictional; reload/reset discards edits. No email/SMS, publishing, payments or live MLS operation exists in this preview.

Password-manager/paste support is enabled. Sign-in is same-origin, rate-limited and uses an HttpOnly/SameSite=Strict one-hour cookie scoped to `/demo`; HTTPS cookies are Secure. Logout clears that cookie and requires session-bound CSRF. Cookies are stateless: an already copied cookie remains valid until expiry or signing-secret rotation. Rotate DEMO_SESSION_SECRET to revoke all preview sessions, and change the password when access changes. Preview secrets are server-only and are never exposed through NEXT_PUBLIC values. Private HTML/RSC/routes are no-store; the service worker retains only safe static assets and the generic offline shell. This is preview access, not SaaS membership authentication.

Ordinary `/api/*` requests fail closed in demo mode. Turning the mode off restores normal launch prerequisites; preview changes cannot be promoted into real records. Add to Home Screen/Install works through the existing manifest/service worker on HTTPS, but physical iPhone/Android acceptance is still required. Reopening the installed app routes through the same preview access. Offline mutations are unavailable.

## Full application launch

Leave HOSTED_DEMO_ENABLED unset or false. Configure `WEB_ORIGIN` and an explicit private PostgreSQL `DATABASE_URL` for a non-owner, NOSUPERUSER/NOBYPASSRLS runtime identity. The launcher starts API on127.0.0.1 at an ephemeral port and passes its verified IPC-reported origin to Next's existing BFF. Migration/control/issuer/provider credentials are not passed to the web child. It never migrates, seeds or starts the worker. Provision/migrate PostgreSQL/PostGIS separately under the reviewed migration identity.

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

The launch probe uses only its own non-default ports/processes, public loopback fixture DB credentials and synthetic preview secrets. It verifies application BFF routing, forced production denial, sibling cleanup after a web failure, and a web-only preview's origin/password/cookie/CSRF/logout boundaries. It does not deploy, dispatch work, load secrets, inspect browser UI or close any M8/production gate. All other agents remain paused until the owner resumes them.
