# Coordinator review of unregistered MLS storage

Reviewed the native ddd074e proposal and correction c1dea57609b989c359c36e05949d505a0c144eeb against actual0001–0019. Imported as57882b5/71df668. Current candidate SHA25629b02ca6df3467f53e4f962657bad199f1aa8f330bc39927555e0b399c93849f is verified unchanged. This accepts guarded archival outside migrations only: no SQL execution/parser evidence, allocation, role change, feed configuration, persistence consumer, worker registration or live access.

Independent bounded review identified opposing Job/run locks and a claim lease minted before blocking source locks. The correction resolves an immutable qualified Job binding without acquiring the run lock, locks Job before run and rechecks the locked actor/member/fence/attempt binding. Direct managed-run UPDATE rejects before Job lookup. The receipt budget lock follows claim/source locks. A nested running claim must still have its matching live lease according to fresh database time after feed/connection/entitlement waits; an expired acquisition raises and rolls back Job/run changes. These are source corrections, not executed concurrency proof.

The earlier candidate ended COMMIT and lacked an unconditional review guard. The current file raises55000 immediately afterBEGIN, retains the independent role-safety preflight and endsROLLBACK. Guard removal alone approves no proposed grant or runtime authority.

Prerequisites before promotion remain:

1. Foundation must define exact approved authorization-prefix and Job→run→feed/connection→entitlement→budget→checkpoint→listing command ports. UPDATE implicitly locks its target before BEFORE triggers. The corrected SQL does not make arbitrary direct DML deadlock-free; requester-bound Job creation/read/claim/cancel/finalize, current idempotency/CSRF and safe results need owner ports.
2. Execute two-client actual-role regression probes in both page/claim/reclaim/cancel directions, current source/native-reader contention, held source/entitlement waits beyond the lease, revocation, stale fences and full rollback. No failure/grant/clock gate may be weakened to make those tests pass.
3. Bind approved configuration/connection revision/source generation before outside-transaction page reads. Validate exact closed Node page/proof/plan values and full canonical digests, then compare the current binding inside the write transaction. Pattern-shaped SHA values are not proof; cross-runtime fixture vectors remain required.
4. Define authoritative receipt/checkpoint lost-ack recovery, finite identity retention and pause/stop/reconciliation/cleanup. One page and all native mutations/audit/outbox/checkpoint effects must commit together. Existing feed rows are never implicitly adopted or renewed from replay.
5. Establish withdrawal/revocation/expiry invalidation and purge consumers for every derived surface. An outbox reference acknowledgment is not a cache/search/media/alert purge receipt. Marketing authority confers no MLS synchronization or sending rights.
6. Deferred checks and fresh lease assertions do not prove physical-COMMIT-time validity; SETCONSTRAINTSIMMEDIATE or later transaction delay can precede commit. Review explicit bounded service/fence linearization and cutpoints before any such guarantee.

The fixed synthetic source, permission/rights gates and no-delivery restriction remain mandatory. Current LVR rights and owner credentials do not activate this candidate. A reviewed next candidate and exact ports must precede independent disposable PostgreSQL/PostGIS probes and any numbered migration.
