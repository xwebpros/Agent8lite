import { Pool } from "pg";
import { fixtures } from "../../../packages/db/fixtures";
import { assertRuntimeRole } from "../../../packages/db/runtime-role";
import type { VerifiedIdentityContext } from "../../../packages/db/tenant-transaction";
import { dispatchOutbox } from "./outbox";

const synthetic =
  ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true";
const contexts: VerifiedIdentityContext[] = process.env.WORKER_CONTEXTS
  ? JSON.parse(process.env.WORKER_CONTEXTS)
  : synthetic
    ? [
        { userId: fixtures.ownerUser, organizationId: fixtures.orgA },
        { userId: fixtures.ownerUser, organizationId: fixtures.orgB },
        { userId: fixtures.agentUser, organizationId: fixtures.orgA },
      ]
    : [];
if (!contexts.length)
  throw new Error("Trusted worker contexts required; global discovery is not implemented.");
if (!synthetic && !process.env.WORKER_DATABASE_URL)
  throw new Error("Worker database configuration is required outside synthetic local mode.");
const pool = new Pool({
  connectionString:
    process.env.WORKER_DATABASE_URL ??
    (synthetic ? "postgresql://estate_worker:local-worker-only@127.0.0.1:55432/estate" : undefined),
  max: 2,
});
let stopped = false;
process.on("SIGINT", () => {
  stopped = true;
});
process.on("SIGTERM", () => {
  stopped = true;
});
async function run() {
  try {
    await assertRuntimeRole(pool);
    console.log(
      "Synthetic event-ledger worker ready; no external communications or downstream domain effects.",
    );
    do {
      for (const identity of contexts) {
        try {
          const result = await dispatchOutbox(pool, identity);
          if (result.dispatched || result.deferred)
            console.log(JSON.stringify({ ...result, consumer: "synthetic-reference-ledger-v1" }));
        } catch {
          console.error(JSON.stringify({ code: "worker_context_unavailable" }));
        }
      }
      if (!process.argv.includes("--once") && !stopped)
        await new Promise((resolve) => setTimeout(resolve, 5000));
    } while (!stopped && !process.argv.includes("--once"));
  } finally {
    await pool.end();
  }
}
run().catch(() => {
  console.error("Worker failed.");
  process.exitCode = 1;
});
