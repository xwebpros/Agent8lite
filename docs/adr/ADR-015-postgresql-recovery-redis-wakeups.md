# ADR-015 — PostgreSQL recovery and opaque Redis wakeups

Accepted implementation boundary for the synthetic M1 reference consumer. Implements normative ADR-005 and INV-01/02/03. This does not implement campaign scheduling, provider submission or production job discovery.

Committed PostgreSQL outbox rows and immutable consumer receipts remain authoritative. A bounded recovery pass invokes the existing transaction-bound dispatch for server-configured trusted actor/organization pairs. Each dispatch reloads active membership, permissions, source state and entitlement. Missing context denies. Recovery runs on startup and every polling interval regardless of Redis availability; no Redis Job acknowledgment establishes business completion.

BullMQ uses the closed `worker-wakeup-v1` internal schema. A hint contains only version 1 and a SHA-256 context key derived from the canonical configured organization/actor pair. The key looks up a frozen server-held registry; it never grants access. Unknown keys, extra fields and unsupported versions deny before dispatch. Never store tenant IDs, contact data, session tokens, event payloads or serialized authority in Redis. Queue result/error metadata is generic. The hint can be duplicated or deleted without changing the durable command.

The registry accepts a bounded list of canonical UUID pairs from trusted server configuration, with no global tenant discovery. Synthetic fallback contexts remain explicit development/test mode only. This is an acknowledged deployment limit; production cannot infer authority from a tenant ID or borrow browser sessions.

Producer connection/command timeouts are bounded, offline command buffering is disabled and unavailable enqueue returns false. Worker connections reconnect independently while PostgreSQL recovery continues. Redis keys use a dedicated queue namespace; completed hints are removed and failed metadata retention is bounded. Shutdown stops new work and closes only connections owned by this process.

Required verification: malformed/forged hints cannot select identity; lost/unavailable/duplicate wakeups and process restart preserve one PostgreSQL receipt/audit/acknowledgment; revoked membership, scope or entitlement is rechecked; real Redis loss/restart is tested against a dedicated disposable service before claiming the remaining recovery gate. In-memory adapters and disconnected-Redis tests prove only their stated boundaries.
