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

### Isolated one-listing inspection

The owner separately authorized an operator-only one-listing diagnostic after metadata access succeeded. This is a local inspection command, not the public adapter or approval of downstream use. It requests one active, entirely displayable, address-displayable record from explicitly named approved source systems. It requests all Property fields and metadata-described related resources, with at most 1,000 records per related collection. It follows no continuation or media URL and does not activate the application feed.

Copy `docs/proposals/W07-trestle/listing-test-config.example.json` to the ignored `.local/trestle-listing-test.json`. Populate the same verified product/feed approval values used by the metadata test, the exact approved `originatingSystemNames`, `operatorPurpose=single-listing-local-inspection`, and `localInspectionApproved=true` only for an owner-authorized local inspection. Optionally add `listingKey` to inspect a specific source key; an ordinary MLS `ListingId` is not necessarily that key. Configuration is re-read before and after network operations; changed or revoked approval discards the result. This manual configuration must never be accepted as application authorization.

The default listing command is offline. For an authorized test, enable the separate flag in the command process, keeping the saved credential file unchanged:

```powershell
node --import tsx packages/providers/mls/trestle/listing-test.ts
$env:TRESTLE_LISTING_TEST_ENABLED='true'
node --env-file=.env.trestle.local --import tsx packages/providers/mls/trestle/listing-test.ts --listing-test
Remove-Item Env:TRESTLE_LISTING_TEST_ENABLED
```

Git must be available to verify that the actual output files are ignored. If it is not on PATH, set `TRESTLE_GIT_EXECUTABLE` in the process to the trusted local Git executable. The command writes JSON and escaped, script-free HTML to a new `.local/trestle-listing-<timestamp>/` directory, without overwriting existing reports. The HTML requests no remote assets and displays media URLs as text. Console output is limited to counts, completeness, field names and local paths. Do not paste the raw report into chat, publish it, commit it or use it as an AI input. Delete the local reports when the inspection is finished; this diagnostic does not establish licensed retention or production storage rights.

The JSON contains the schema inventory, the complete returned Property object and its expanded related records. Null/empty values differ from fields not returned. Any omitted field, omitted related resource, related continuation or collection reaching its bound marks the report incomplete. Completeness is relative to this authenticated schema and query response; it does not imply that all MLS-held information is licensed or accessible. Unknown public display/retention/media/cache/alert/AI rights still deny those uses.

On 10 October 2026, the owner-authorized GLVAR diagnostic returned one record, all 758 described Property fields (95 populated), and 14 related resources. Media, ListAgent, ListOffice and CustomProperty each contained one related record; the other collections were empty. No related continuation or bound was encountered. No raw feed artifacts were committed. See the handoff for verification evidence.

After metadata access succeeds, use the actual authorized Property schema and the MLS agreement to record allowed originating-system IDs, field permissions, current display/address/location policy, attribution/disclaimer requirements and a bounded freshness interval. Verify required control fields, enum values and actual next-link shape. Public catalog fields do not prove licensed access. The runtime resolver must derive verified tenant context from server identity and read current approval/policy on every operation. Never accept this authorization record from an API request or job body.

The adapter implements bounded active/pending search and fresh detail reads. It selects only allowed observed fields, escapes literals, rechecks projected criteria, filters source systems and rejects synthetic/foreign records. Display and address flags must be boolean true. Unknown numeric values remain null. Unsupported statuses are excluded. Credentials and tokens stay server-private; authorization is rechecked before authentication/data requests and after responses. Cursors are opaque, tenant/query/policy-bound and expire after four minutes in one process. They are not durable replication checkpoints.

This first slice has no stored listings or stale fallback. Withdrawal returns no listing on a fresh read. A later repository/cache must enforce current policy and expiry on every surface, invalidate derived data on withdrawal, and implement approved retention/purge behavior. Do not store live rows in the native mock repository. Replication and deletion reconciliation, media storage/proxy, alerts, saved searches and MLS-based AI are disabled until their licensed rights and acceptance evidence exist. Maps require permitted exact coordinates and displayable addresses; coarse-location handling is not implemented. Server-rendered MLS data must remain out of service-worker/IndexedDB caches in both browser and installed iPhone/Android PWA modes.

## Sources and verification

Owner-supplied Technology Providers Release v3: pages 6–10 and 25–31. Multiple Listing Managers Release v3: pages 2–4, 8–10 and 13–15. Source PDFs are not redistributed in this repository.

- [Trestle Web API](https://trestle-documentation.corelogic.com/web-api/)
- [Web API query reference](https://trestle-documentation.corelogic.com/web-api/reference/)
- [Trestle RETS reference](https://trestle-documentation.corelogic.com/rets/)

The provider tests use injected synthetic HTTP responses and make no network calls. Run `node node_modules/vitest/vitest.mjs run packages/providers/mls/trestle`. Test results and handoff are recorded in `docs/proposals/W07-trestle/handoff.md`; a passing mocked suite is not licensed-feed or production acceptance.
