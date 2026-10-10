# ADR-027 — Explicit local calendar-time resolution

Accepted bounded MOD-E-008 preparation on 2026-10-10. This internal pure server helper resolves one supplied local calendar minute; public contracts, existing elapsed-time workflow preview and scheduling/storage authority remain unchanged. It adds no current-clock lookup, worker, provider or route.

## Input and result

The closed internal declaration is packages/contracts/internal/calendar-time.ts. resolveCalendarTime(input: unknown) accepts exactly localDate (Gregorian YYYY-MM-DD, requested year2000–2100 inclusive), localTime (HH:mm) and timeZone. All three must be bounded own data strings on a plain or null-prototype object. Proxies, accessors, hidden/symbol/extra properties, custom prototypes and hooks deny without execution. Invalid calendar dates deny; leap-day substitution and anniversary policy are separate prerequisites.

Require UTC or a slash-separated named timezone whose spelling exactly equals the pinned Intl.DateTimeFormat resolvedOptions().timeZone identity. Reject numeric offsets, abbreviations, aliases and mixed-case spellings. Explicit canonical Etc/GMT names are valid when Intl resolves the same identity; supportedValuesOf is not the authority for these fixed zones. This deliberately narrow preparation boundary differs from the broader existing workflow timezone metadata validator. A later schedule command must normalize an explicit user choice through a reviewed boundary rather than silently change a saved workflow.

Return a detached frozen timeZone, requestedLocal, effectiveLocal, UTC ISO instant with .000Z and decision. If the local minute maps once, decision is exact. If it maps more than once in a fall overlap, choose the earliest UTC occurrence and record overlap-earlier. If it is skipped, choose the earliest representable local wall minute after the requested minute and then the earlier UTC occurrence of that minute; record gap-first-valid. For a spring transition, 02:30 resolves to03:00 when02:00–02:59 are absent, rather than preserving the missing minutes. A skipped date may advance effectiveLocal.date. Bound resolution to the supplied wall stamp plus/minus48hours and minute precision; unavailable/out-of-bound/unsupported formatter results fail closed.

Use explicit Gregorian calendar, Latin numbering and h23 formatting. Runtime behavior depends on the pinned Node24.19.0 ICU/tzdb data, not the workstation timezone. The current runtime reports ICU78.3/tz2026b; upgrades require timezone regression review. For example this runtime resolves Asia/Kolkata to Asia/Calcutta, so only the latter is accepted by this narrow helper. No universal alias-renaming behavior is claimed. The implementation uses the [ECMA-402 Intl time-zone facilities](https://tc39.es/ecma402/#sec-use-of-the-iana-time-zone-database) supplied by [Node's ICU integration](https://nodejs.org/docs/latest-v24.x/api/intl.html).

Errors expose only fixed calendar_time_invalid or calendar_time_unavailable codes and platform-owned generic messages. Do not include input dates/zones or underlying Intl exceptions in logs/errors. No helper/barrel browser export is added.

## Remaining scheduling prerequisites

The result is a candidate calculation, not a durable schedule or permission to send. A future owner must record the chosen instant and timezone/decision with immutable generation/action identity, explicit anniversary/leap-day and recipient/fallback-timezone policies, quiet-hour eligibility, current tenant/member/contact/consent/suppression/channel/sender/entitlement checks, PostgreSQL leases, recovery and uncertain-provider reconciliation. Recomputing after a runtime data upgrade must not silently move an already accepted action. Quiet-hour ends during an overlap require separate at-or-after execution semantics; this helper's calendar earlier-occurrence decision alone does not establish that eligibility.

Verify exact UTC and non-hour offsets, invalid/leap dates, spring/fall transitions, Lord Howe half-hour transitions, a skipped Apia date, year boundaries, frozen deterministic output and zero-hook hostile inputs. No M4 acceptance or execution is complete from these unit tests alone.
