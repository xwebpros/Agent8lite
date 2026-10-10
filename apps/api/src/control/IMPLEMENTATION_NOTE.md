# MOD-A control-plane phase 1

Implemented against the reviewed migration 0012, internal control-plane port and ADR-017. The HTTP adapter is deliberately unregistered; the integration owner owns shared router/BFF registration and final combined acceptance.

## Implemented behavior

- Separate explicit `estate_control` and `estate_staff_issuer` pools require enabled development/test mode, loopback URLs, expected current/session role, safe recursive ancestry and bidirectional control/issuer separation. Synthetic identity is rejected before database use outside that mode.
- Staff-only mock OIDC verifies signed tokens, nonce, audience and the one-use PKCE code. Issuer resolves the existing verified identity and locks its active principal before inserting an opaque eight-hour session. Every control transaction reloads and locks current principal/session; selected support contexts remain unavailable in phase 1. No staff Owner membership is created.
- Frozen `POST /v1/platform/organizations` returns a durable queued `organization.provision` Job. Enqueue is atomic with a provisioning organization, immutable command record and safe audit reference. Exact replay resolves the current requester-authorized Job; changed input conflicts. Metadata listing validates bounded, actor/session/grant-bound pagination.
- Explicit local execution commits a durable claim and immutable run-key-to-attempt binding together before work. Internal ledger metadata records the claim UUID and attempt number; public replay returns only the current authorized frozen Job. A crash after claim or failure commit cannot cause the same key to start another attempt, including after lease expiry. SaaS, CRM and Billing bootstrap adapters share the invoking client and claim. They insert six built-in presets, one approved existing non-staff Owner, business profile, exactly six pipeline stages, website source, default routing state/rules, starter mock subscription, CRM/billing capabilities and one no-charge Stripe mock connection. No feed or website capability is inferred.
- Owner identity/version and approved policy are SHARE-locked/rechecked through activation. Defaults, activation, Job success, audit and validated reference event commit together. Failure rolls back defaults/activation, then records only a fixed safe failure in a separate authorized transaction. A deliberate new-key retry may recover; replay of the failed run key does not silently repeat it. Expired claims can be replaced, and old claims cannot overwrite their successors.
- All adapter responses are private/no-store with safe trace and content-type headers; error responses use the frozen Problem schema and `application/problem+json`. Actual socket and forwarded headers, Origin, CSRF, JSON schema/size, opaque cookie and command keys are checked. Mixed member/staff cookies fail closed. Body errors and module failure details are redacted at collection.

## Unregistered adapter contract

`createStaffHttpAdapter({control, issuer, allowedOrigins, bootstrapPorts?})` returns an async Node request handler which returns whether it handled the route. The optional port factory is trusted server/test dependency injection; it is never supplied by a request.

| Route | Result |
| --- | --- |
| POST `/dev/staff/session` | Closed internal SessionRequest; 200 SyntheticStaffSessionResponse, HttpOnly `estate_staff_session`, `X-CSRF-Token` |
| GET `/dev/staff/session` | 200 same internal response/header |
| POST `/dev/staff/logout` | `{}` with CSRF; 204, deletes current session/cookie |
| GET `/dev/staff/jobs/:id` | Requester-only frozen Job, 200; requires `platform.orgs.provision` |
| POST `/dev/staff/jobs/:id/run` | `{}` with CSRF and Idempotency-Key; frozen Job, 202 |
| POST `/v1/platform/organizations` | Frozen OrganizationCreate and Job, 202; provision permission |
| GET `/v1/platform/organizations` | Frozen PageOrganization, 200; organization-read permission |

The adapter consumes the raw request stream and must precede a JSON body parser when integrated. Shared middleware must retain the existing approved rate-limit boundary. Member/staff cookies never combine authority; any future explicit context selector requires reviewed integration. Job resultUrl stays null because a production platform Job/result contract is missing; the requester local Job and platform metadata list provide readback.

## Actual verification

`node tests/control/run.mjs` creates a uniquely named disposable loopback database, applies migrations 0001–0014 under the separate migration login, seeds synthetic fixtures, starts only an ephemeral adapter, closes pools/listener and drops only that database. Latest run on 2026-10-10: **20/20 tests passed**, one test file, 9.68 seconds of Vitest execution. Root TypeScript and owned Biome checks passed immediately before that run.

Acceptance covers real expected roles and SQL denials, unavailable/mixed/expired/revoked sessions, mode-before-database, current permission replay, concurrent enqueue/claim, requester health-read isolation, exact defaults/no-charge effects, caller-wide rollback, injected module failure/retry, durable crash cut points after claim and failure commit, expired claim takeover/stale failure, owner version/verified changes, actual blocked owner writer until activation commit, post-activation seed denial, cursor binding and safe malformed/oversized JSON including frozen Problem validation. Independent review found and corrected a late run-key persistence window; the key is now recorded atomically with the claim and survives recovery. Earlier failures were fixed: UUID/text parameter inference in outbox insertion and three test assumptions (preset count, expired-session CHECK, identity resolver context). Every recorded pass used a fresh database.

## Remaining gates and next steps

Integration owner review and shared router/BFF registration, staff-console connection, combined API acceptance and mobile/accessibility review remain. Phase 2 support grants/selections/customer projections remain interfaces only and are unavailable here. No production identity/onboarding, unattended worker, live payments/messages/Trestle, commercial activation or deployment has been enabled. Full MOD-A/M2 completion is not claimed.
