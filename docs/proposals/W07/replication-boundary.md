# W07 mock incremental replication boundary proposal

MOD-F-005 and MOD-F-AC-2/3 require opaque paging, equal timestamps, overlap, durable checkpoints and recovery. This proposal precedes the owned helper and its tests. It adds no public DTO, provider interface, router, worker, database migration or grant. Frozen Listing bodies and current projection rights/expiry rules remain unchanged. Root reviews any persistence/service consumer separately.

## Owned preparation

Add a server-only, mock-only one-page state machine in `packages/mls`. Use the existing `ReplicationAdapter` port and `MockMlsAdapter`, with scripted failures/pages in tests only. Require `mock-synthetic`, replication mode, incremental and deletion capabilities, a ready mock feed, approved DisplayPolicy replication and approved native replication rights. Unknown rights deny. A trusted `authorize` service callback must verify current tenant/job actor permission and capability before each page; the helper independently checks its returned tenant/feed/policy provenance. Recheck current feed revision/rights after the provider read. No credential or network call belongs to this helper.

The internal versioned checkpoint binds tenant, feed, policy version, resource, overlap and page size. It keeps the last **completed** watermark while a cycle is in progress, forwards cursor and watermark verbatim and never subtracts overlap or filters records by their timestamps. The provider owns overlap interpretation. Equal completed watermarks are valid; a regressing/invalid watermark fails. Only the final durably processed page replaces the completed watermark. Bounded cursor hashes detect loops without interpreting tokens; at most 100 pages, 100 changes per page and 8 KiB per opaque cursor are supported by this mock preparation. Bounds fail explicitly.

Return one safe result per invocation. No automatic loop, sleep or blind retry. A local mock-only read-error envelope distinguishes a bounded 429 retry delay, expired access credential and expired paging cursor. It does not extend the shared provider contract or inspect arbitrary exception text/response bodies. Unknown exceptions become a generic safe failure. A 429 or read failure retains the last durable boundary. Credential expiry requires a fresh approved credential outside this helper; cursor expiry requires reviewed restart/reconciliation from the last completed watermark, never skipping to a newer one.

## Proposed atomic persistence/service port (not registered)

`commitPage` receives an immutable page plan: expected checkpoint, next checkpoint, ordered canonical changes, expected current feed revision/rights fingerprint and a deterministic receipt hash. It must execute **one transaction**, under verified tenant/worker RLS, that:

1. Rechecks and locks current job identity/permission/capability, feed/connection provenance and approved replication rights. Checks expected feed revision and checkpoint revision/context with compare-and-swap. Serializes concurrent syncs for that tenant/feed/resource.
2. Processes **every** change in provider order, preserving stable native IDs for `(tenant, feed, source key)`. A failed change rolls back the entire page. Identical-content replay preserves original ingestion/expiry; reading a replay is not a freshness renewal. Equal timestamps cannot discard a different record or change.
3. Marks deletions/off-market withdrawals unavailable and atomically records versioned invalidation work for any future caches, indexes and alert matches. No real alert/inquiry/contact creation or outbound delivery is part of ingestion. Durable consumers deduplicate invalidations and recheck current rights, listing state and expiry at use time.
4. Saves the next checkpoint and the receipt only **after all changes and invalidations are durable in that same transaction**. Acknowledges only after transaction commit. Never expose a separate checkpoint-write callback.

The helper accepts only a matching committed receipt and exact next checkpoint. Conflict, thrown/ambiguous commit, or mismatched receipt requires reloading the authoritative durable checkpoint before another invocation. A lost acknowledgement may mean the page already committed; do not blindly replay with a newly assumed revision. A stale plan cannot overwrite a newer checkpoint or tenant/feed context. A unique receipt supports idempotent recovery alongside checkpoint CAS.

The existing `app.mls_checkpoint`, `app.mls_sync_run` and stable listing key are candidates for root integration. The preparation does not assume runtime ingestion/checkpoint grants, write to those tables, allocate a migration, or claim PostgreSQL durability. Root must approve the checkpoint JSON envelope, transaction implementation, RLS/grants, job execution identity/capability, invalidation outbox and recovery audit before registration.

## Replay and withdrawal limits

The existing mock is an append-only synthetic change log: it ignores watermark/overlap and replays the log when cursor is null. Tests explicitly distinguish that behavior from scripted overlap pages. Checkpoints cannot manufacture provider source ordering/change IDs. The test transaction keeps stable IDs and tombstones; historical mock upserts cannot revive a deleted key. Reactivation without a source generation/order proof requires separately reviewed reconciliation. Production ordering, retention and replay identity must be settled with the approved provider at M6; timestamp-only deduplication is insufficient when timestamps tie or deletions lack timestamps.

The in-memory transactional test sink proves page atomicity, checkpoint acknowledgement ordering, CAS, lost-ack recovery, replay without duplicate native IDs/invalidation work, original freshness and current projection withdrawal/rights/expiry. It is test infrastructure, not a production repository. Browser/device gates and actual cache/index/alert integration remain pending.

## Acceptance packet

Use actual synthetic canonical fixtures and the existing mock for paging/withdrawal. Script opaque tokens, equal timestamps/overlap, empty advancing pages, partial read failure, 429, expired credential/cursor, malformed/non-synthetic pages, capability and current-policy denial, mid-page rollback, before/after-commit crash, concurrent CAS conflict, lost acknowledgement, and replay/tombstone/freshness. Run owned unit/static suites, TypeScript, formatting, frozen contracts and the in-memory browser-source bundle check. No live provider, shared estate, server port or browser automation is needed.
