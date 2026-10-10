# Trestle feed scaffold and first access test

This server-only scaffold uses the existing MLS `LiveQueryAdapter` port. It is unregistered: the running application continues to use synthetic mock MLS data. No public API, database migration, mobile cache, scheduler or root dependency changes are included. Requirements: MOD-F-001/002/003/006/007/008. Provider activation and integration belong to the coordinator after M6 acceptance.

## Connection choice

Use RESO Web API for the supplied Web API ID/password. It uses OAuth client credentials, `scope=api`, JSON Property queries and XML metadata. The current public documentation uses `api.cotality.com`; the attached Release v3 manuals use older CoreLogic hosts. Explicitly verify the account's endpoints. Only the documented HTTPS hosts and paths are allowed, and redirects are denied. Token renewal uses the returned lifetime, bounded by the actual credential expiry.

RETS is a separate transport. Trestle documents RETS 1.8, basic authentication or OAuth with `scope=rets`, `/trestle/rets/login` and `/trestle/rets/search`. Do not switch a Web API token to RETS endpoints or retry the same credentials across protocols automatically. A RETS-only feed needs a separate reviewed adapter, DMQL query compiler and response parser. RETS search/media/replication are not implemented here. The public RETS page was reviewed on 10 October 2026.

## Secure local setup

1. Confirm the product, feed type, MLS, approved connection/license and broker approval where required. An ID/password alone does not establish those approvals. Verify credential expiry and that the issued pair is for this product/feed.
2. In this checkout, copy `docs/proposals/W07-trestle/credentials.example.txt` to `.env.trestle.local`. Enter the ID as `TRESTLE_CLIENT_ID` and password as `TRESTLE_CLIENT_SECRET` directly in the local editor. Set a non-secret rotation label in `TRESTLE_CREDENTIAL_VERSION` and the actual UTC expiry. Quote environment values where required by Node's environment-file syntax. Never paste credentials into chat, commit them, place them in `NEXT_PUBLIC_*`, or pass them as command arguments. The existing `.gitignore` ignores `.env.*` and `.local/`; confirm with `git check-ignore .env.trestle.local .local/trestle-access.json`.
3. Copy `docs/proposals/W07-trestle/access-config.example.json` to `.local/trestle-access.json`. Fill its non-secret account/context values. For this isolated probe, `organizationId` and `feedId` are distinct local audit labels for the owner and selected feed; the scoped environment contains only that feed's issued pair. They are not production tenant identities or credential IDs. Use the actual product registration ID and approved MLS/feed description. Set connection approval to `approved` only after confirming it in Trestle; set broker state to `approved` or verified `not_required`. This manual operator record authorizes only an isolated probe. It is not a production feed-policy store or tenant verification mechanism.
4. Leave the enable flag false until the owner is ready for the joint test. Production credentials should later reside in the deployment's server secret manager, referenced by the trusted feed resolver. Do not copy local secrets to other worktrees.

## Commands

Run from the checkout using the repository's pinned Node 24.19.0 runtime and installed dependencies. The default command is offline and does not read configuration, obtain credentials or send requests:

```powershell
node --import tsx packages/providers/mls/trestle/access-test.ts
```

After the owner confirms the access test, set `TRESTLE_ACCESS_TEST_ENABLED=true` in the ignored file and run:

```powershell
node --env-file=.env.trestle.local --import tsx packages/providers/mls/trestle/access-test.ts --access-test
```

Both gates are required. A successful run obtains one token and reads only `$metadata`. It prints protocol, metadata byte count and SHA-256; it never prints XML, tokens, passwords, listing data or upstream error bodies. No Property request, database write, website publication, paid connection creation or contract acceptance occurs. Return the flag to false afterward.

`TRESTLE_AUTH_DENIED` indicates HTTP 401/403; verify the issued pair, selected protocol, expiry and approvals in Trestle. Do not paste the error response into chat. `TRESTLE_QUOTA_EXCEEDED` carries a bounded retry delay and performs no automatic retry. Timeout, malformed metadata, pending broker approval, unknown endpoints and configuration placeholders fail closed. Configuration file/system errors print only a generic safe code.

## Listing integration gate

Provider health is process-local evidence for the exact feed/policy/context binding. A successful Property read is ready only until the approved maxDataAgeSeconds boundary. A subsequent provider/credential/response failure makes fresh historical evidence degraded; expired evidence is unavailable. Invalid or regressed clocks withhold readiness. Policy/connection revocation clears historical health, and metadata access or malformed client filters cannot establish Property readiness. Health reads make no network request and never renew data freshness.

After metadata access succeeds, use the actual authorized Property schema and the MLS agreement to record allowed originating-system IDs, field permissions, current display/address/location policy, attribution/disclaimer requirements and a bounded freshness interval. Verify required control fields, enum values and actual next-link shape. Public catalog fields do not prove licensed access. The runtime resolver must derive verified tenant context from server identity and read current approval/policy on every operation. Never accept this authorization record from an API request or job body.

The adapter implements bounded active/pending search and fresh detail reads. It selects only allowed observed fields, escapes literals, rechecks projected criteria, filters source systems and rejects synthetic/foreign records. Display and address flags must be boolean true. Unknown numeric values remain null. Unsupported statuses are excluded. Credentials and tokens stay server-private; authorization is rechecked before authentication/data requests and after responses. Cursors are opaque, tenant/query/policy-bound and expire after four minutes in one process. They are not durable replication checkpoints.

This first slice has no stored listings or stale fallback. Withdrawal returns no listing on a fresh read. A later repository/cache must enforce current policy and expiry on every surface, invalidate derived data on withdrawal, and implement approved retention/purge behavior. Do not store live rows in the native mock repository. Replication and deletion reconciliation, media storage/proxy, alerts, saved searches and MLS-based AI are disabled until their licensed rights and acceptance evidence exist. Maps require permitted exact coordinates and displayable addresses; coarse-location handling is not implemented. Server-rendered MLS data must remain out of service-worker/IndexedDB caches in both browser and installed iPhone/Android PWA modes.

## Sources and verification

Owner-supplied Technology Providers Release v3: pages 6–10 and 25–31. Multiple Listing Managers Release v3: pages 2–4, 8–10 and 13–15. Source PDFs are not redistributed in this repository.

- [Trestle Web API](https://trestle-documentation.corelogic.com/web-api/)
- [Web API query reference](https://trestle-documentation.corelogic.com/web-api/reference/)
- [Trestle RETS reference](https://trestle-documentation.corelogic.com/rets/)

The provider tests use injected synthetic HTTP responses and make no network calls. Run `node node_modules/vitest/vitest.mjs run packages/providers/mls/trestle`. Test results and handoff are recorded in `docs/proposals/W07-trestle/handoff.md`; a passing mocked suite is not licensed-feed or production acceptance.
