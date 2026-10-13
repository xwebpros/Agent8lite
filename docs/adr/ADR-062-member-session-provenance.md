# ADR-062 — Member session provenance and production denial

Accepted for bounded implementation on 2026-10-13 after coordinating integration-owner and backend/security review. Requirements: INV-01/02, MOD-A verified identity and active membership, M1 identity acceptance, and ADR-011's explicit synthetic-mode boundary. This corrects a runtime integration defect discovered by the existing compiled production-denial smoke; it does not approve an external identity provider or production release.

## Evidence and decision

`readProductionSession` previously accepted every unexpired `app.login_session` row. The incoming HTTP regression assertion also accepted a retained synthetic cookie in production with no OIDC configuration. Both contradict the approved architecture. Keep the production-denial smoke strict and correct the implementation and regression assertion.

Reviewed forward `0039-member-session-provenance.sql` adds `identity_provenance` (`legacy-unknown`, `synthetic-local`, `oidc`) and nullable, bounded `oidc_issuer`, `oidc_client_id`, and `oidc_subject`. Existing rows remain `legacy-unknown`; do not infer trusted provenance, delete data or extend expiry. Such rows require reauthentication for production. Existing explicitly enabled local development/test reads may still consume legacy rows for compatibility.

Only the trusted, verified OIDC callback supplies the verified identity and audience to `createSession`. Its transaction checks the exact configured issuer/client, current linked issuer/subject/verified email and active membership before issuing an OIDC-bound session. Synthetic creation retains its development/test gate and writes `synthetic-local`. Production reads require configured issuer/client before any database connection, then exact persisted OIDC provenance/provider binding and current linked identity and membership. Recheck expiry after lock waits. Synthetic reads cannot consume OIDC sessions.

Configuration requires a bounded absolute HTTPS issuer without user information, query or fragment and a nonempty bounded client ID. Use the same single trailing-slash normalization as the existing discovery verifier; all stored and compared issuer values use that convention. A synthetic URN cannot configure production identity. Fixture-only acceptance never fetches its invented HTTPS issuer.

The new columns are private database state; the frozen Session/API/event contracts do not change. Preserve FORCE RLS and transaction-local token/actor/tenant context. Runtime UPDATE becomes column-scoped to the existing organization selector. A trigger also prevents rewriting token, identity, provenance, provider binding, creation time or expiry. DELETE remains available for revocation. No migration modifies an already applied checksum.

## Verification and rollout

Use disposable PostgreSQL/PostGIS and real non-bypass runtime roles to prove unconfigured denial before connection, retained synthetic/unknown denial under configured production, exact provider-bound acceptance, issuer/client/subject/email/membership/expiry changes, immutable session origin and unchanged local loopback/private-response behavior. Run the actual compiled API/CLI smoke with owned fixture databases, plus relevant member-session and existing capture/CMS regressions. Test fixtures use an invented HTTPS issuer; they never call a live provider.

Apply the forward migration before the new readers/issuers. Old rows and expiry remain intact; production users must authenticate again through the separately approved provider. External redirect/callback, provider-account approval, proxy/session operational acceptance, browser/device review and M8 release remain separate gates. Record executed results and remaining gaps in `IMPLEMENTATION_STATUS.md`.
