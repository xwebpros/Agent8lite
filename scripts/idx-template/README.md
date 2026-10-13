# Local mock IDX provisioning

`provision-mock.ts` connects a CMS-created `las-vegas-idx-agent@1.0.0` or `las-vegas-idx-brokerage@1.0.0` site to the native public template and CRM capture path. It is an explicit development/test CLI, never an API/worker dependency or production activation path.

Use the approved Node/pnpm runtime and installed lockfile dependencies. Set `APP_ENV` to `development` or `test`, `DEV_AUTH_ENABLED=true`, and an **explicit** `MIGRATION_DATABASE_URL` for the intended loopback PostgreSQL database after migrations through 0037. The separate migration/table-owner identity must be used; runtime, worker and control identities are rejected. The tool never prints the connection URL or credentials and never alters database accounts or disables RLS. Its SQL context is transaction-local to the explicit tenant and generated non-login capture identity.

Create the site through the ordinary CMS picker. Create its `home` document and save the selected template starter through CMS. Obtain the actual tenant/site/document/profile IDs and an existing explicitly synthetic ready mock feed ID. An agent site also needs an explicitly selected eligible member; names from listing attribution and the first human Owner are never used as authority.

Replace the quoted placeholder IDs below with actual authorized local record IDs. Configure the database URL separately; do not put credentials in the command or saved output.

```powershell
$env:APP_ENV = 'development'
$env:DEV_AUTH_ENABLED = 'true'
pnpm exec tsx scripts/idx-template/provision-mock.ts `
  --tenant-id 'TENANT_UUID' `
  --site-id 'SITE_UUID' `
  --document-id 'DOCUMENT_UUID' `
  --feed-id 'MOCK_FEED_UUID' `
  --profile-id 'BUSINESS_PROFILE_UUID' `
  --origin 'http://localhost:3000' `
  --site-agent-member-id 'ELIGIBLE_MEMBER_UUID' `
  --create-source --create-form
```

Required inputs are `--tenant-id`, `--site-id`, `--document-id`, `--feed-id`, `--profile-id` and `--origin`. Each source/form must have either an explicit existing `--source-id` / `--form-id` or its respective `--create-source` / `--create-form` flag. Existing references must agree on tenant/site/source. The origin must be a normalized HTTP `localhost` or `127.0.0.1` origin, optionally with a port, with no path or credentials.

`--site-agent-member-id` is required for agent sites and optional for brokerage sites. `--brokerage-office-id` restricts recipients to an explicit tenant office and requires the selected site member to belong to it. Brokerage capture uses current native first-touch, explicit listing/site-agent, geography and eligible weighted routing; missing matching recipients use the native unassigned queue. The tool does not create routing rules, eligible recipients, pipeline stages or entitlements. `--ttl-seconds` defaults to 3600 and accepts 60–86400; current entitlement expiry can shorten that lifetime.

`--create-source` creates a deterministic, site-scoped synthetic inquiry source. `--create-form` creates a **draft** four-field form: required name (max 100), email (max 254), message (max 2000), and optional phone (max 30). No consent field or marketing grant is inferred. Existing forms must retain these exact field types, required flags and bounds, and their source must match. Identity, limited role, membership and binding IDs are deterministic. A non-login identity uses the reserved capture issuer and site UUID subject; it is never a human Owner or an external identity provider account.

The command returns JSON with safe reference IDs, state, fixed expiry, `pending` steps and any `limitations`. A draft site/document/form or missing entitlement/routing-state/pipeline prerequisite leaves the binding `disabled`. Explicitly publish the chosen document revision and the inquiry form through the normal CMS commands, complete the reported prerequisites, then rerun the **same** command before its fixed expiry. Only an identical tool-owned disabled mock binding can become active. The tool validates the published controlled source slots and current approved mock policy; it never saves, edits, publishes or rolls back CMS content.

An identical active rerun preserves its expiry, row version, source/form/principal and historical data. Differing references, modified capture grants, revoked memberships/bindings, live feeds/bindings and expired authorization are refused. The tool does not renew expired authorization or overwrite an existing binding. Recovery requires a separate reviewed action. Provisioning/activation records a safe audit entry in the same transaction, without form text or personal data.

With an active binding and the server bridge origin configured, open `/templates/las-vegas-idx/SITE_UUID` at the same bound loopback origin. Default mock data remains conspicuously synthetic. Map tiles, visitor organizer features and other optional capabilities remain gated; unknown rights deny their use. A successful local template inquiry records one native CRM lead decision and a CRM-readable private note, with a durable receipt and no real send.

Real PostgreSQL tests in `tests/idx-template` run against a disposable database on the dedicated 54434 cluster and must prove draft→explicit publication→activation, idempotent reruns, rejected unsafe input/principal/binding changes and ordinary public capture. CLI source/type checks alone are not runtime acceptance evidence. Production DNS/TLS, verified domain activation, licensed MLS/media/maps, delivery providers and M6/M8 release gates remain separate required work; this CLI enables none of them.
