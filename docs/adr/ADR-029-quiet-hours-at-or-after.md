# ADR-029 — Pure quiet-hours calculation at or after a supplied instant

Accepted bounded MOD-E-004/008 preparation on 2026-10-10, before consumers. The internal declaration is packages/contracts/internal/quiet-hours.ts. Public API/event/workflow schemas, persistence, preview and worker authority remain unchanged. This calculation creates no schedule or permission to send.

## Input and explicit policy

Accept exactly dueInstant, recipientTimeZone, organizationTimeZone and quietHours as own enumerable data on a plain or null-prototype object. Reject proxies, accessors, hidden/symbol/extra properties, custom prototypes and hooks without execution. The nested quiet-hours object has exactly start/end strings in HH:mm. Equal endpoints are invalid, matching current workflow validation. Explicit null disables the interval; omission is invalid.

dueInstant is a canonical UTC ISO timestamp YYYY-MM-DDTHH:mm:ss.sssZ with input year2000–2100 inclusive and an actual valid Gregorian date/time. Reject offsets, omitted precision, leap seconds, impossible dates and Date/string coercion. Preserve seconds/milliseconds when the instant is already allowed or the interval is disabled. A deferred boundary has :00.000 precision.

Both organizationTimeZone and a non-null recipientTimeZone must satisfy ADR-027's bounded UTC-or-slash-name canonical Intl identity rule. Do not normalize aliases or silently replace an invalid known recipient zone. Only explicit recipientTimeZone:null selects the organization fallback. Return timeZoneSource and the selected timezone so a later consumer can show and record the fallback policy. This is a narrow internal boundary; saved workflow timezone metadata remains broader and unchanged.

## Quiet membership and earliest candidate

Treat same-day quiet hours as the half-open local wall interval [start,end). For overnight hours, a local minute is quiet when minute>=start OR minute<end. The start is quiet and the end is allowed. The rule applies independently to each occurrence during an overlap. It does not describe a continuous UTC interval spanning a rollback.

Return the earliest UTC instant t>=dueInstant whose projected local wall minute is outside that recurring interval. If dueInstant is allowed, return it unchanged even if a later rollback re-enters quiet hours. If quiet, inspect successive UTC minute boundaries in increasing order and re-evaluate the wall predicate. Bound the scan to48 elapsed hours after the supplied instant, at most2,881 wall observations including the initial due instant. Fail unavailable when there is no proved eligible candidate inside the bound or when the formatter is unsupported/malformed. No current clock, elapsed wait, retry, injected callback or ambient workstation timezone is used.

For New York's2026-11-01 overlap and quiet00:30–01:30, due05:20Z resolves05:30Z; due06:20Z resolves06:30Z. The earlier05:30Z is not valid for the latter. An already allowed05:45Z remains unchanged. During a spring gap, a skipped end is not assumed eligible: its first valid wall time must satisfy the predicate. Apia's skipped2011-12-30 with quiet22:00–08:00 must advance past the resulting midnight, which remains quiet. ADR-027's overlap-earlier calendar helper cannot directly determine this at-or-after result.

Use explicit Gregorian/Latin/h23 Intl behavior with pinned Node24.19.0/ICU78.3/tz2026b. Observe UTC instants, not reconstructed local dates. Dates projected near input/year/search boundaries may reach1999 or2101; the input year bound and48-hour search still apply. Unsupported subminute offsets deny. Return a detached frozen dueInstant, eligibleInstant, timeZone, timeZoneSource and decision. Expose only fixed quiet_hours_invalid or quiet_hours_unavailable codes/messages, without reflecting supplied values or Intl exceptions.

## Acceptance and remaining gates

Prove same-day/overnight start/end milliseconds, disabled interval, explicit fallback and invalid-known-zone denial, spring/fall transitions in both overlap occurrences, Lord Howe half-hour changes, skipped Apia date, windows entirely inside a gap, leap/year boundaries, deterministic frozen results, bounded failure and zero getter/proxy/hook/current-clock execution. A test that only mirrors the loop is insufficient; verify exact independent expected UTC instants.

Dispatch must re-evaluate current quiet eligibility and every tenant/member/contact/archive/consent/suppression/channel/sender/entitlement/provider condition. Accepted schedules need immutable action/generation identities and persisted chosen instants/policy, PostgreSQL leases, cancellation/recovery and uncertain-provider reconciliation. Anniversary leap-day behavior remains a separate explicit decision. No M4 gate is complete from this helper alone.
