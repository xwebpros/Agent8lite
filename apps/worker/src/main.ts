import { Pool } from "pg";
import { fixtures } from "../../../packages/db/fixtures";
import { assertRuntimeRole } from "../../../packages/db/runtime-role";
import type { VerifiedIdentityContext } from "../../../packages/db/tenant-transaction";
import { dispatchOutbox } from "./outbox";
import { recoverCommittedOutbox, RedisWakeups, TrustedContextRegistry } from "./wakeups";

const synthetic =
  ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true";
function configuredContexts(): VerifiedIdentityContext[] {
  try {
    return JSON.parse(process.env.WORKER_CONTEXTS ?? "[]");
  } catch {
    throw new Error("worker_context_configuration_invalid");
  }
}
const contexts: VerifiedIdentityContext[] = process.env.WORKER_CONTEXTS
  ? configuredContexts()
  : synthetic
    ? [
        { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
        { userId: fixtures.ownerUser, organizationId: fixtures.orgB },
        { userId: fixtures.agentUser, organizationId: fixtures.orgA },
      ]
    : [];
if (!contexts.length)
  throw new Error("Trusted worker contexts required; global discovery is not implemented.");
const registry = new TrustedContextRegistry(contexts);
if (!synthetic && !process.env.WORKER_DATABASE_URL)
  throw new Error("Worker database configuration is required outside synthetic local mode.");
const pool = new Pool({
  connectionString:
    process.env.WORKER_DATABASE_URL ??
    (synthetic ? "postgresql://estate_worker:local-worker-only@127.0.0.1:55432/estate" : undefined),
  max: 2,
});
let stopped = false;
let wakeups: RedisWakeups | undefined;
let wakeupStopped = false;
const stopWakeups = () => {
  if (wakeupStopped) return;
  wakeupStopped = true;
  void wakeups?.close();
};
process.on("SIGINT", () => {
  stopped = true;
  stopWakeups();
});
process.on("SIGTERM", () => {
  stopped = true;
  stopWakeups();
});
async function run() {
  try {
    await assertRuntimeRole(pool);
    if (process.env.REDIS_URL && !process.argv.includes("--once")) {
      wakeups = new RedisWakeups(process.env.REDIS_URL, registry, (identity) =>
        dispatchOutbox(pool, identity),
      );
    }
    console.log(
      "Synthetic event-ledger worker ready; no external communications or downstream domain effects.",
    );
    do {
      // Wakeups accelerate eligible work; recovery never waits for queue readiness/acknowledgment.
      if (wakeups) {
        for (const identity of registry.contexts) {
          if (!(await wakeups.enqueue(registry.hintFor(identity)))) break;
        }
      }
      const result = await recoverCommittedOutbox(registry, (identity) => dispatchOutbox(pool, identity));
      if (result.dispatched || result.deferred || result.failedContexts)
        console.log(JSON.stringify({ ...result, consumer: "synthetic-reference-ledger-v1" }));
      if (result.failedContexts && process.argv.includes("--once")) process.exitCode = 1;
      if (!process.argv.includes("--once") && !stopped)
        await new Promise((resolve) => setTimeout(resolve, 5000));
    } while (!stopped && !process.argv.includes("--once"));
  } finally {
    await wakeups?.close();
    await pool.end();
  }
}
run().catch(() => {
  console.error("Worker failed.");
  process.exitCode = 1;
});
