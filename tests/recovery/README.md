The default unit suite verifies closed wakeup hints and frozen server configuration. The default disposable PostgreSQL suite verifies recovery with no Redis listener, duplicate/lost/restarted hints, current scope/grants/membership/capability checks, and one durable receipt/audit/acknowledgment. These tests do not establish real Redis service restart or data-loss acceptance.

The opt-in queue acceptance requires a dedicated disposable Redis instance on loopback. It fails, rather than skips, when `REQUIRED_REDIS` is missing/unavailable or `REQUIRED_REDIS_ISOLATED=true` is absent. The supplied service must be isolated from interactive application traffic. It creates and removes only one generated `acceptance-<uuid>` queue namespace. Run:

```powershell
$env:REQUIRED_REDIS='redis://127.0.0.1:6379'
$env:REQUIRED_REDIS_ISOLATED='true'
node node_modules/vitest/vitest.mjs run --config tests/recovery/redis-service.vitest.config.mts
```

That queue test proves actual BullMQ transport and worker-side hostile-hint/error redaction. It does not restart the Redis process, drop its persisted data, or prove production schedule recovery. Dedicated service stop/restart/loss with PostgreSQL receipts, campaign leases/generations, and send-provider reconciliation remain separate exit gates. No real messages are sent.
