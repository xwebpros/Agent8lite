# W07 properties feature — stable root integration requirements

The approved owned preparation slice is implemented behind unregistered routes. No root dependency, provider, shared contract, migration, seed, router, BFF, shell or navigation file changed here.

Backend integration is specified in `backend-export-contract.md`. Root's review found capability expiry while waiting on source locks; the service now calls the existing entitlement guard again after repository locks/DB clock and additionally checks current `clock_timestamp()` itself, because this branch's foundation still uses transaction-start `now()`. The real-role test blocks list and detail on a writer, observes the lock wait, waits for capability expiry using the database clock, releases the writer and proves 403 with no listing response. Root owns the generic entitlement predicate fix; the owned additional check can be retained safely after integration.

## Stable web export

Import `PropertiesFeature` from `../features/properties` in the existing workspace shell. Its props are:

```tsx
<PropertiesFeature
  key={`${session.userId}:${session.activeOrgId}:${member}:${accessRevision}`}
  session={session}
  online={online}
  syntheticFeaturesEnabled={syntheticEnabled}
  accessRevision={accessRevision}
  onAccessRevoked={() => {
    // Use the existing workspace access/session refresh path, preserving shared state conventions.
  }}
/>
```

`session` is generated frozen Session; `online` and syntheticEnabled are existing shell state. `accessRevision` is required so revoked/reloaded grants invalidate child data. The callback is optional; on 401/403 the feature hides all data even without it. Root should connect the callback to its current access refresh/invalidation mechanism. Do not pass session cookie, CSRF, source credentials, request tenant authorization or entitlement claims.

Root adds a synthetic-only Properties navigation/view and routes it through the existing workspace. Honor current session MLS read permission; server independently enforces organization scope and current capability. Root extends its GET BFF allowlist for only `/dev/orgs/:uuid/mls/listings` and `/dev/orgs/:uuid/mls/listings/:uuid`, preserving existing upstream origin, host, method/body bounds, cookies, no-store and error handling. No public or mutation allowlist addition.

The feature imports its own CSS module using existing design tokens. No global stylesheet or shell style registration is needed. Read local Next 16.4 server/client and CSS documentation before authoring. There are no tiles, photos, media proxies, external scripts/fonts or external links.

## Behavior

Accessible labelled price/type/bed/bath/status/keyword/sort form, optional bounded longitude/latitude fields, responsive list cards, fresh server-read detail region, visible synthetic disclaimer/attribution/freshness and null-field alternatives. Safe provider remarks remain escaped text. Detail focus moves once on explicit open and returns to its button on close; automatic refresh does not take focus. Controls have 44px minimum height, visible focus and layouts that shrink to 360px. Visual/reflow/keyboard/axe/device acceptance is unverified because browser automation remains blocked.

All state is memory-only. The browser-only `PropertyReads` lifecycle owns independent list/detail requests, aborts replacements and rejects late completions even when transport ignores abort. Current scope/access checks also apply before effect cleanup and when a queued list state update runs. Any detail failure clears both displayed surfaces and invalidates both pending reads, so an overlapping list cannot restore records after detail becomes unavailable. Closing/changing detail selection preserves the independent list. A 401/403 denies that access context until the root supplies a refreshed accessRevision/context; toggling connectivity cannot silently restore it.

Render guards hide private data immediately on tenant/member access revision/permission/synthetic/offline changes and at the earliest stored record expiry. Invalid expiry values deny display. Timers clear expired records, cap long delays at the browser's signed 32-bit limit and recheck the deadline before clearing; later renders remain safe if a suspended tab delays its timer. Periodic thirty-second and window-focus/foreground refresh recheck current rights and availability. No localStorage, IndexedDB, service-worker/private cache or offline read/mutation path is added. Background refresh can replace accumulated pages; this is a bounded synthetic preparation feature rather than final M5 browser acceptance.

## Verification discovery patch

Existing root changes remain coordinator-owned:

- Vitest includes `tests/mls/**/*.test.ts`; each `*.integration.test.ts` is a separate disposable DB process. Pure/static suite uses owned config without integrating DB files by default.
- W07 scoped typecheck is `pnpm exec tsc --noEmit -p tests/mls/tsconfig.json`. It includes JSX/static feature tests plus Next CSS types. If root tsconfig directly includes the static test, it also needs JSX `react-jsx` and the existing Next `next-env.d.ts` declarations; alternatively root runs this scoped typecheck separately.
- Lint/format paths include `packages/mls`, `apps/api/src/mls`, `apps/web/features/properties`, and `tests/mls`.
- After root's approved migration/seed/BFF/router/shell registration, run its integrated API/source/type/build regressions. This branch's static render/type checks do not prove registered shell builds or browser workflows.

Executed after lifecycle hardening: 177/177 pure/static tests (146 W07 plus 31 existing providers), including sixteen new deferred-response ordering, cross-surface invalidation, scope/access and expiry cases. These exercise the actual browser-only lifecycle/expiry helpers consumed by the component, without claiming browser interaction acceptance. Latest complete backend verification is 10/10 real-role repository cases and 13/13 HTTP cases, each in a fresh disposable DB, including current-session expiry/revocation/switch races described in `session-read-boundary.md`. Root/web/W07 TypeScript, owned Biome check, unchanged frozen contract/generated-type validation and diff whitespace check pass. No browser automation, 3000/3001, shared estate reset, real messaging/provider fetch, merge or push.

M5 remains pending: public site/identity prerequisites, organizer/inquiry→CRM, sync token/429/checkpoint/crash and no-delivery alerts, registered UI/browser/device acceptance. The reviewed boundary does not activate those flows.
