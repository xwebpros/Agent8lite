# W07 replication storage candidate review

Status: **proposal frozen for coordinator review; SQL has never been executed**. Only this new review and `replication-storage-candidate.sql` are delivered. No migration allocation, database/role changes, consumer, worker registration, router, provider access or milestone completion is established.

The candidate follows `replication-persistence.md`, ADR-025 and the internal ordered mock source port. Baseline review includes approved migrations 0001–0019 at coordinator ref `e077b2ce20d476da02ab74190242c98f31033a4e`. Marketing 0017–0019 add no MLS worker authority. Existing native read functions/policies, transaction context, organization-scoped `mls.sync`, current `mls` entitlement and Job/audit/outbox conventions were reconciled explicitly. Marketing `campaigns.write`/`campaigns.send` confer no replication authority.

## Candidate and decisions

Three immutable tables reserve source identities, record ordered entries and bind atomic page receipts. Nullable additions to feed/listing/checkpoint/run/outbox retain legacy data without guessed source history. Tenant/feed composite keys and deferred references prevent cross-feed receipt, listing or checkpoint substitutions. Existing rows/configuration are not backfilled or adopted. An existing feed containing listings/checkpoints needs separately reviewed reconciliation.

Source state is an immutable identity reservation rather than the mutable latest-state row suggested in the earlier prose proposal. Latest order and sticky withdrawal derive from the complete entry ledger, including hidden historical rows. The ledger is named `mls_replication_source_entry`, replacing that proposal's `source_version` name. A first unknown deletion reserves a null native ID; known listings retain their native UUID. Deletes, closed/off-market withdrawal and first unknown tombstones cannot be revived by older/equal/null modification timestamps or an identity replay. New source identities are required for genuine future changes; this fixed profile approves no reactivation.

The page receipt stores closed full expected/next checkpoint JSON rather than only checkpoint digests. Helper revision zero and SQL row version one remain separate. It is inserted first as an uncommitted serialization marker, followed by ordered source/native mutations; deferred validation rejects incomplete dependencies. This reverses the earlier proposed insertion order while preserving atomic publication at transaction commit. Unique `(tenant_id, write_xid)` permits one page in each verified tenant transaction. Receipt reuse never renews ingestion or expiry.

Only the fixed `ordered-synthetic-v1` profile/generation is supported. Seven metadata-only catalog entries bind explicit noncontiguous sequences, observed clocks and canonical source-content hashes. No raw provider page, canonical payload or contact value is stored in these ledgers. Native listings retain the approved fixed USD price/contact projection; content hashing excludes local ingestion/expiry, while those original clocks independently constrain freshness. Unresolved replication/field/retention rights deny writes. Display/search masking remains governed by current native projection rules.

The intended sequence is:

1. A trusted command authorizes the initiating member, creates a queued Job/run and initializes an empty feed's closed checkpoint atomically. A worker claims the bound Job with a fresh database-generated fence/attempt and bounded lease.
2. Read one ordered source page outside the write transaction using a trusted current source binding. Validate the page/proof and immutable plan with the approved Node validators.
3. Within one verified tenant/actor transaction, lock current membership/role/organization/entitlement, claim/run, feed/connection and checkpoint. Recheck clocks and current rights after lock waits; insert the receipt first, then first identities and ordered entries, applying each accepted native mutation.
4. Insert one final reference invalidation per changed known listing and a closed page audit; advance the exact checkpoint by CAS. Only a completed cycle may update feed completion and succeed the Job. Deferred guards require the complete page, final native versions, events and audit before commit.
5. Acknowledge only after a known commit. On ambiguous acknowledgment, reload authoritative state under current authorization. An old receipt is evidence of a historical transaction, never current read/display eligibility.

## Security and existing paths

Runtime/worker must be non-owner NOSUPERUSER/NOBYPASSRLS logins, without administrative attributes or migration-owner reachability. Verified transaction-local tenant and actor context is required before privileged lookups. Current organization, membership, exact organization-scoped sync grant, entitlement, approved mock connection and feed rights are rechecked. Queue/body identities and SQL role names alone are not trusted context sources.

New ledger policies combine FORCE RLS tenant isolation with restrictive actor/feed gates. Existing permissive tenant policies are retained, not treated as sufficient authorization. Feed SELECT gates avoid calling the recursive feed predicate. Worker listing/checkpoint/run/job/outbox paths receive bounded policies and column grants; immutable ledgers have no UPDATE/DELETE/TRUNCATE grant. Metadata UPDATE grants needed for SHARE locking on other authorization tables have restrictive false write checks. No media/CMS/CRM/cache/alert/campaign/control/issuer grants are added.

Trigger helpers use SECURITY DEFINER with `search_path=pg_catalog`, qualified app/PostGIS references, and revoked PUBLIC/runtime/worker EXECUTE. The migration owner must actually see FORCE-RLS hidden rows and be unreachable from ordinary logins. This ownership and ACL premise needs actual-login verification; the candidate creates no bypass role. PostgreSQL's [function security guidance](https://www.postgresql.org/docs/17/sql-createfunction.html) explains the search-path and default-execute risks.

Existing row-version-only native grants no longer permit arbitrary MLS metadata writes. Legacy listing/checkpoint/run maintenance is limited to the actual table owner and an already-unmanaged row; it cannot clear a managed binding. Feed generation/profile/policy identity cannot change once history exists. Existing reference-worker paths are preserved, while MLS event payload mutation/deletion and published acknowledgment are denied pending approved consumers.

## Unresolved prerequisites: do not register a consumer yet

| Boundary | Required coordinator decision/evidence |
| --- | --- |
| Control authorization | No MLS configuration service port is approved. Initial generation/profile/policy/identity-retention deadline configuration remains migration-owned. Define current source approval, revocation, pause, stop and reconciliation authority. Define lawful identity-ledger cleanup before the finite retention deadline; hashes and tombstones do not justify indefinite retention. No reset or guessed historical backfill is proposed. |
| Job command/read | Approve the public frozen Job projection, command/idempotency/CSRF receipt, requesting-member/current-actor binding, safe error/count mapping and trusted registry context. Wakeups contain only approved hints. No route, idempotency port or worker registration is implemented. `retry_not_before` is reserved and checked, but no approved 429 backoff writer/scheduler exists. |
| Source fingerprint/proof | The helper's feed revision/rights fingerprint does not itself bind connection revision or source generation/proof. A reviewed private service closure must capture those before the read and compare them in the transaction. SQL checks the fixed metadata catalog/page boundaries, but does **not** compute the full Node page digest or plan receipt digest; pattern-valid hashes alone cannot authenticate either. Keep exact Node proof/plan validation mandatory. Verify PostgreSQL/Node canonical numbers, Unicode, timestamp and PostGIS coordinate vectors. Built-in [SHA-256 bytea functions](https://www.postgresql.org/docs/17/functions-binarystring.html) avoid a new extension, but do not establish cross-runtime canonical compatibility. |
| Rights interpretation | Review the conservative requirement that this complete fixture's stored fields all appear in current native allowedFields. This is a storage gate independent of displayFields/status masking, with positive finite retention/age bounds. Confirm the policy meaning, expiry cap and current licensed source mapping rather than infer a general live-provider rule. |
| Checkpoint/recovery | Approve SQL/helper revision mapping, empty-feed initialization, authoritative lost-ack reload, completed feed revision increment/fingerprint recapture, unfinished-cycle policy-change handling and explicit legacy reconciliation. A new generation, cursor reset or changed original options cannot silently adopt old history. |
| Invalidation | Approve the type-specific closed internal envelope and consumers for index/cache/alert/property-block surfaces, unknown source tombstones, whole-feed revocation/expiry and older untracked derived data. Known listing events are coalesced to final page versions; unknown deletion emits no invented native ID. Until consumers/purge receipts exist, MLS events cannot be marked published. No alert, autosend or public publication authority follows. |
| Transaction/fence timing | Guards recheck database time after lock waits and hold claim locks, but deferred checks are **not a commit-time clock hook**. A SQL caller can request immediate constraint evaluation; a long transaction can outlast a lease after its last check. PostgreSQL documents this behavior for [constraint triggers](https://www.postgresql.org/docs/17/sql-createtrigger.html). Approve a bounded trusted transaction service, SQL caller restrictions and fence linearization semantics before claiming lease-at-physical-COMMIT enforcement. Verify global lock order against existing readers/claimers. |

## Coordinator acceptance work

These are required future probes, not tests executed here:

- Apply the exact candidate to a disposable PostgreSQL 17/PostGIS database on actual 0001–0019. Exercise actual runtime/worker/control/issuer non-owner logins; check role graph, owners, function ACLs, safe search path, FORCE-RLS hidden history and unrelated privileges. Missing context, pooled reuse, malformed/cross-tenant/cross-feed context, forged actor/class/scope and hidden identity/version collisions must deny.
- Exercise held-lock member/organization/grant revocation, entitlement expiry, changed feed/native rights/connection, superseded/expired fences and concurrent claims/CAS. Test database-clock checks after waits and the declared deferred-timing limitation without weakening guards.
- Persist all seven operations and replay overlap across pages/process restarts. Verify tied/null clocks, A-to-B-to-historical-A replay, sticky known/unknown tombstones, stable native IDs, unchanged original ingestion/expiry, source identity/sequence conflicts and protected opaque tokens. Verify SQL canonical fixture vectors and Node plan/page/proof validators together.
- Fail every cut point before/after receipt, ordered mutation, event, audit, checkpoint and final completion. Missing/extra/wrong-version ledger entries/events/audit, duplicate final invalidations and stale current bindings must roll back. Lost acknowledgments must reload without new effects or expiry renewal. Include empty completed boundaries and deny existing-data bootstrap/generation reset.
- Check tenant budgets, finite retention pause/recovery, retry/cancellation rules, old read-path behavior, no non-MLS Job/event regression and no MLS acknowledgment without approved purge consumers.

## Static evidence and exact artifacts

Offline inspection confirms three new tables, 28 functions, balanced quoted/dollar bodies and parentheses, and no role creation/alteration. This is lexical inspection, **not a PostgreSQL parse, migration, transaction or actual-role test**. All seven catalog hashes were independently recomputed from the committed source fixture using sorted-key canonical JSON with ingestion/expiry fields removed. No existing source, exports, tests, dependencies or status files changed.

| Artifact | SHA-256 |
| --- | --- |
| `replication-storage-candidate.sql` (LF UTF-8) | `c905ce55498e5b669f8918ba5d0968e015d8ab376180c9a52b92d19f469f9e4f` |
| Existing `packages/mls/fixtures/ordered-synthetic-v1.json` | `33277c2b57da5dc417a9379315755e07b65ad45889bb58888f77619b1be16ddc` |
| Baseline actual `0019-native-message-design-drafts.sql` | `44787253330b9eb2fd141719f4232b221b353950247f0e04f14f20cc63be4730` |

Prior source implementation `a832648` was imported as coordinator `fd836e7`; its recorded 89/89 targeted and 451/451 owned pure/provider checks belong to that implementation, not this SQL. Coordinator's later proof correction/review is separate evidence. No database, shared roles, browser or live provider was accessed for this proposal. Coordinator review, shared prerequisite decisions and independent actual-role probes precede any numbered migration or persistence consumer.
