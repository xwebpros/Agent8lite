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

Render guards hide private data immediately on tenant/member access revision/permission/synthetic/offline changes and at the earliest stored record expiry. Invalid expiry values deny display. Timers clear expired records, cap long delays at the browser's signed 32-bit limit and recheck the deadline before clearing; later renders remain safe if a suspended tab delays its timer. Periodic thirty-second and window-focus/foreground refresh recheck current rights and availability. No localStorage, IndexedDB, service-worker/private cache or offline read/mutation path is added.

Refresh rebuilds the previous visible result count from fresh signed-cursor reads rather than resetting to the first twenty records. Up to five requests use adaptive limits at most100 across the approved500-record cohort; the final complete page may include up to four additional records to preserve a valid continuation. Withdrawn/no-longer-matching records disappear. The component retains the current limit/filter/sort parameters for subsequent load-more, because signed cursors bind the limit. Apply/clear/context changes start from twenty again. Old private records are cleared before refresh, partial refreshed pages are not displayed, and changed rights/stale cursors/expired items invalidate the whole read. Repeated cursors/IDs and malformed progress fail conservatively. Automatic refresh skips active list/detail reads; finishing a request marks it idle without invalidating its queued current state update. Manual refresh remains explicit. The coordinator's integrated16px input correction is preserved in the owned CSS.

## Verification discovery patch

Existing root changes remain coordinator-owned:

- Vitest includes `tests/mls/**/*.test.ts`; each `*.integration.test.ts` is a separate disposable DB process. Pure/static suite uses owned config without integrating DB files by default.
- W07 scoped typecheck is `pnpm exec tsc --noEmit -p tests/mls/tsconfig.json`. It includes JSX/static feature tests plus Next CSS types. If root tsconfig directly includes the static test, it also needs JSX `react-jsx` and the existing Next `next-env.d.ts` declarations; alternatively root runs this scoped typecheck separately.
- Lint/format paths include `packages/mls`, `apps/api/src/mls`, `apps/web/features/properties`, and `tests/mls`.
- `node tests/mls/check-browser-bundle.mjs` builds the actual public feature entry point in memory with existing Vitest/Vite dependencies and rejects Node globals/built-ins or server MLS/auth/database/provider/API modules. No listener/browser/output directory is created.
- After root's approved migration/seed/BFF/router/shell registration, run its integrated API/source/type/build regressions. This branch's static render/type checks do not prove registered shell builds or browser workflows.

Executed after refresh improvement: 200/200 pure/static tests (169 W07 plus 31 existing providers), including 23 new current-cursor refresh/busy-lifecycle cases using the real pure backend projection/search/cursor implementation. These prove bounded rebuild and correct continued paging, rights changes/expiry between pages, deferred cancellation, exhausted/withdrawn cohorts, invalid progress/counts and preserved403 errors. The in-memory browser source bundle passes with two outputs and no Node/server modules. These are source checks without browser interaction acceptance. Latest backend verification remains 10/10 real-role repository +13/13 HTTP in separate fresh disposable DBs, including `session-read-boundary.md`. Scoped/root/web TypeScript,35-file owned Biome, frozen/generated contracts and diff checks pass. No browser automation,3000/3001, shared estate reset, real messaging/provider fetch, merge or push.

M5 remains pending: public site/identity prerequisites, organizer/inquiry→CRM, sync token/429/checkpoint/crash and no-delivery alerts, registered UI/browser/device acceptance. The reviewed boundary does not activate those flows.

## Continued detail focus lifecycle

Closing details after a fresh list rebuild previously held the removed card's original button, so `.focus()` could silently do nothing. The owned `PropertyDetailFocus` now tracks current mounted card controls by access context and native ID. React 19 callback-ref cleanup removes only its own registration; late cleanup, reused nodes and a context reset cannot erase a newer control. Close/Escape returns to the currently mounted matching card, or to the generic Properties heading when that card was withdrawn/unmounted. Changed/offline/revoked contexts cannot focus old controls or another workspace's fallback. Ref state remains in tab memory and resets on context/online changes and unmount.

Explicit open focuses the detail heading as soon as the panel mounts, including the loading/error state. Reopening the same selected card also works with the existing heading. Read completion and automatic refresh do not take focus again. Applying/clearing filters dismisses the focus request without moving from the form to an old result. Escape is handled only inside the detail section and respects an already-handled event or IME composition. Card buttons expose their expanded state and reference the detail panel only while their corresponding panel exists. Stable public `PropertiesFeature` props, generated Listing bodies, source requests, rights/expiry guards and CSS remain unchanged.

Executed after this change: **296/296 pure/static/provider PASS** across ten files (265 W07 + 31 existing providers), including **16 new focus helper scenarios and one new static ARIA/ref case**. Tests use structural focus targets to prove lifecycle decisions, current-card replacement, cleanup ordering, withdrawal fallback, per-scope/native-ID selection, disabled context and filter dismissal. They do not execute a browser DOM or native keyboard events. Scoped/root/web TypeScript, 41-file owned Biome, frozen/generated contracts and actual feature-entry browser source bundle PASS (two in-memory outputs, no Node/server modules). Backend code is unchanged in this pass; prior DB/HTTP evidence is retained. Coordinator independently reports the earlier multi-feed switch correction passes all13 registered API cases on actual0001–0015, and imported refresh targeted checks pass.

Root imports only owned feature/helper/tests/docs. No dependencies, router/shell/BFF changes, shared schema or migrations are needed. Browser/keyboard/screen-reader/device review remains pending: slow or failed detail reads should focus the heading; repeated refresh should retain user focus; Close/Escape after refresh should return to the replacement card; withdrawal should use the Properties heading; context/offline changes should discard prior focus references. M5 completion and the separate replication helper's persistence/integration review remain pending.

## Reviewed participant attribution contact

Coordinator prerequisites `f13ca01` and `e6eff43` are imported as `9908d15` and `26e76b6` before final consumer verification. ADR-022 is the only named amendment to the immutable original contract. Phone contacts require at least seven base-number digits before any extension; `123 ext4567` is rejected at source projection, canonical replication and repository readback.

Owned repository readback accepts the closed canonical attribution plus optional generated contact; absent/null older records remain valid and malformed/extra contacts suppress the malformed record. Native projection requires both exact current field grants for `attribution.contact` and never substitutes unrelated agent/owner/office information. Supplied firm/contact appears immediately after primary price and before facts on both cards and detail, in 1rem ink-colored escaped text. No links, contact action, inferred logo or network behavior is added. Footer keeps permitted agent/disclaimer/freshness.

See `attribution-contact.md` for the narrowly synthetic seed proposal. Shared seed/migrations/router/provider implementation remain coordinator-owned; root must explicitly approve fixture field grants and fictional values without broadly rewriting existing rights/ingestion/expiry/withdrawal. Live required firm/contact suppression belongs to the root Trestle resolver.

Verification: **333/333 pure/static/provider checks** in eleven files (302 W07 +31 existing providers); **14/14 repository +14/14 owned HTTP** in separate fresh disposable PostgreSQL/PostGIS databases on this foundation's0001–0011 plus approved read candidate. Actual-role readback, old/null/malformed attribution, independent field denial, contact-only cursor invalidation and source/context/expiry/withdrawal guards pass. Static list/detail tests cover adjacency, supplied email/phone, escaped text and no inferred contact/link. Generated contracts, scoped/root/web TypeScript,42-file owned formatting, diff and actual feature-entry in-memory browser bundle pass. No browser/device or centrally registered build acceptance is claimed. Root reruns its registered API/build checks after importing the owned changes and approved fixture decisions.

## Current accumulated-page continuation

The old Load more path silently merged duplicate IDs and validated only newly returned expiry. Owned `loadMorePropertyPage` now requires the displayed parent's exact cursor and the current paging limit, tracks consumed opaque cursors through both refresh and continuation, rejects repeated IDs/tokens and invalid terminal/progress claims, and enforces the500-record cohort. It checks the entire accumulated batch's expiry before accepting a continuation. The component captures the current parent page; a queued update cannot append to a replaced parent, and current read/context/access guards remain mandatory before acceptance.

A failed or malformed continuation uses the existing whole-surface private clearing path. Deliberately cancelled/superseded requests remain ignored by `PropertyReads.current`; a still-current transport `AbortError` no longer bypasses failure clearing. Consumed cursors stay in component memory and reset on fresh search, refresh and private/context clearing. Both list/detail attribution and focus protections remain unchanged. Public feature props, generated bodies, backend sources and shared files are unchanged.

Source verification now passes **362/362** across eleven files (331 W07 +31 provider), including29 new continuation/refresh/error cases. Tests use actual native projection/search/signed cursors to verify all three sorts, adaptive limit retention, opaque history, expired parent during a delayed read, access/context loss, duplicate/nonprogressing/oversized pages, exact500-record terminal behavior and retained error identity. Actual feature-entry browser bundling passes with two in-memory outputs and no Node/server modules. No browser/device interaction or centrally registered shell acceptance is claimed; prior14 repository +14 HTTP evidence is unchanged and was not repeated for this frontend-only change.

Final scoped/root/web TypeScript,42-file owned formatting, generated contracts and diff checks PASS. Root imports only the owned feature/helper/test/docs changes and reruns registered build/UI acceptance. No shared dependency, schema, router, seed or provider change is needed.

## Synchronous abort callback ordering

`AbortController.abort()` invokes registered abort handlers synchronously. The previous `PropertyReads.cancel` removed tracking after invoking them, so a handler-created replacement could lose its registration. `begin` could overwrite a newer nested request without aborting it. Whole-view clearing also cancelled the two surfaces sequentially: a callback could observe the other surface as current or start a request that survived clearing, allowing its late response to restore cleared private records.

The browser-only tracker now retires cancelled tracking before callbacks, publishes a replacement before aborting its predecessor, and invalidates both surfaces together before any whole-view abort. Requests attempted during whole-view clearing return already-aborted controllers without registration. A nesting counter keeps that barrier active across recursive clearing. Ordinary single-surface cancellation preserves the independent surface and a deliberately fresh callback-created read; the newest nested replacement remains current. Normal reads can resume after clearing finishes. Existing component props, generated contracts, API requests, access/expiry checks and focus behavior are unchanged.

The twelve new regressions failed on the prior implementation, including a deferred private response restoring data after clearing. After correction, the focused lifecycle/paging suites pass **80/80**, and the full owned pure/static/provider suite passes **521/521 across fourteen files**, with no skips. Scoped/root/web TypeScript,48-file owned Biome, frozen contracts170operations/169schemas plus ADR-022, diff and actual feature-entry browser source graph all pass. The source graph has two in-memory outputs and no Node/server modules. Tests use the runtime's real AbortController with synchronous listeners and deferred completions; they do not prove browser/component/device interaction. Backend and storage code remain unchanged, so prior database evidence was not rerun. Root integration and browser/device acceptance remain pending.
