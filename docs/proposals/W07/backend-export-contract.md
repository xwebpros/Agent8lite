# W07 owned backend exports — coordinator integration patch

Review boundary: coordinator `221af81`, recorded here before consumers as `6361186`.
Implemented under `apps/api/src/mls/**`; no existing router, migration, seed, BFF or provider file changed.

## Stable entry point

Import `tryNativeMockRead` from `./mls` in the existing API. After shared synthetic/session/local/rate guards and before the existing `/v1/orgs/...` matcher, call:

```ts
const mls = await tryNativeMockRead(
  {
    path: req.path,
    method: req.method,
    query: req.query,
    body: req.body,
    remoteAddress: req.socket.remoteAddress,
    forwardedFor: req.headers["x-forwarded-for"],
  },
  session,
  runtimePool,
  {
    signingKey: process.env.CURSOR_SIGNING_KEY ??
      "synthetic-local-cursor-signing-only-not-for-production",
  },
);
if (mls) {
  res.status(200).json(mls.body);
  return;
}
```

The module returns null for other paths/methods and registers nothing itself. It denies non-development/test, disabled synthetic identity, nonmock MLS configuration, nonloopback/remote forwarding, substituted active org and GET bodies before tenant DB work. It obtains verified membership/role context through `withTenantTransaction`, rechecks organization MLS grant and current existing MLS entitlement, returns safe `AccessError`, validates frozen responses and uses current locks/DB clock. The shared router retains session lookup, rate limiting, private/no-store, trace headers and Problem serialization. Synthetic fallback signing is development/test only because the module denies all other modes; root can pass its existing configured/fallback key. No MLS source/secret is read from the request.

Owned current-session hardening is recorded before consumers at `f098a73`; see `session-read-boundary.md`. The handler now SHARE-locks the existing verified session's current token-hash/user/active-organization binding inside that tenant transaction and separately checks `clock_timestamp()` after acquiring the lock and after the source read. It consumes existing session RLS/grants without issuing or changing sessions. Expiry/revocation/mismatched retained values produce safe 401; concurrent revocation or organization switching waits for caller commit. Session context is transaction-local and clears on pooled reuse. Root reviews this owned supplementary guard when importing; shared `readSession` remains unchanged.

For service-level tests/ports, `NativeMockReadService(client, context, {signingKey})` exposes `.list(query)` and `.detail(id, query={})`. It requires an existing verified tenant transaction. `NativeMockListingRepository(client).current()` returns `{snapshot, now}` with locked current feed/connection/listing metadata. Both are exported through `apps/api/src/mls/index.ts`.

## Candidate SQL and source/seed requirements

Apply the reviewed unnumbered candidate only through root's forward migration allocation. Runtime SELECT and row_version-only UPDATE grants pass real-role tests; runtime source/policy/withdrawal writes, inserts and deletes deny. No worker grants or source backfill.

Current source must have provider=`trestle`, mode=`mock`, state=`mock`, secret_ref=null, safe_config.synthetic=true and safe_config.liveFeedRights=`unapproved`; feed mode/transport=`mock`, state=`ready`, nonfuture policy_approved_at, valid frozen display_policy and closed native_rights. Unknown/malformed/contradictory source denies. Use exactly closed `{displayAddress:string|null}` address JSON and `{brokerage:string|null,agent:string|null,disclaimer:string}` attribution JSON. Retain adapter ingestion time, original synthetic identity and native source-key uniqueness. No created/updated-at freshness substitute.

The repository locks all current tenant feeds/connections (cap 20) and listings (cap 500), obtains clock_timestamp after locks, and fingerprints all source metadata for cursors. Failed bounds return unavailable. Projection/filter/sort use only permitted fields. Details reread current rows; no prior list item bypass. Shared API/BFF responses must retain private/no-store. Source writes remain migration/test-only in this slice.

Root needs additive explicit synthetic seed/capability activation, approved dev paths in ADR-011/BFF, per-file isolation discovery for `tests/mls/*.integration.test.ts`, then shell registration after the feature export is supplied. Public/visitor/inquiry/organizer/media/alert/AI/live endpoints remain absent. M5 is not complete.

## Executed isolated acceptance

`node tests/mls/run-isolated.mjs`: each owned integration file uses a new uniquely named disposable database, migrations 0001–0011, approved candidate SQL, private directory and ephemeral owned HTTP port. No 3000/3001/shared estate. Tests can also run in root per-file isolated runner because `tests/mls/database.ts` accepts only explicit loopback `estate_acceptance_<16 hex>` or `estate_w07_<16 hex>` database URLs.

Latest complete owned runner: repository 10/10 and HTTP 13/13 passed in separate fresh batches. Coverage: PostgreSQL/PostGIS, actual nonowner/NOBYPASSRLS role, missing-context/pool reuse/cross-tenant isolation, denied runtime writes, current permission/membership/capability, null/malformed/expired rights/time/provenance, hidden-field predicates, withdrawal/cursor invalidation, real lock races and source/capability expiry while blocked, opaque synthetic sessions, closed HTTP query, generic 404/no-store, unregistered later routes and configuration denial before DB connection. Current MLS entitlement is rechecked after source locks with clock_timestamp, independent of the old shared transaction-start predicate. Both blocked list and detail deny once the capability expires. Six additional HTTP cases cover retained-session revoke/switch/actor/hash mismatch, session expiry during list/detail source waits, time checked after an unchanged session tuple lock wait, and concurrent revocation/switch serialization through commit. Source/unit suite remains 177/177; TypeScript/Biome/contracts pass. No product rights/clock/grants were relaxed.
