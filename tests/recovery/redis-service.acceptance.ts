import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { expect, it, vi } from "vitest";
import type { WorkerWakeup } from "../../apps/worker/src/wakeup-contract";
import { RedisWakeups, TrustedContextRegistry } from "../../apps/worker/src/wakeups";
import { fixtures } from "../../packages/db/fixtures";

function dedicatedRedisUrl(): string {
  if (process.env.REQUIRED_REDIS_ISOLATED !== "true" || !process.env.REQUIRED_REDIS)
    throw new Error(
      "A dedicated disposable loopback Redis service is required; this acceptance is never skipped.",
    );
  try {
    const url = new URL(process.env.REQUIRED_REDIS);
    if (
      url.protocol !== "redis:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new Error("Dedicated Redis acceptance configuration is invalid.");
  }
}

it("an actual dedicated Redis queue validates hostile hints and stores only fixed safe failure codes", async () => {
  const url = dedicatedRedisUrl();
  const connection = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 1000,
    connectTimeout: 1000,
    retryStrategy: () => null,
  });
  connection.on("error", () => {});
  let queue: Queue | undefined;
  let wakeups: RedisWakeups | undefined;
  const namespace = `acceptance-${randomUUID().replaceAll("-", "")}`;
  const identity = { organizationId: fixtures.orgA, userId: fixtures.ownerUser };
  const registry = new TrustedContextRegistry([identity]);
  const dispatch = vi.fn(async () => ({ dispatched: 0, deferred: 0 }));
  try {
    try {
      await connection.connect();
    } catch {
      throw new Error("Required dedicated Redis service is unavailable.");
    }
    expect(await connection.ping()).toBe("PONG");
    queue = new Queue("reference-outbox-wakeup-v1", { connection, prefix: namespace });
    wakeups = new RedisWakeups(url, registry, dispatch, namespace);
    await vi.waitFor(async () => expect(await wakeups?.enqueue(registry.hintFor(identity))).toBe(true), {
      timeout: 5000,
      interval: 100,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalled(), { timeout: 5000, interval: 25 });
    dispatch.mockClear();
    const hostile = await queue.add("wake-context", {
      ...registry.hintFor(identity),
      userId: fixtures.otherAgentUser,
      payload: { privateMessage: "never execute or retain as error text" },
    });
    await vi.waitFor(async () => expect(await hostile.getState()).toBe("failed"), {
      timeout: 5000,
      interval: 25,
    });
    expect((await queue.getJob(hostile.id!))?.failedReason).toBe("wakeup_invalid");
    expect(dispatch).not.toHaveBeenCalled();
    dispatch.mockRejectedValueOnce(new Error("private source failure containing a session credential"));
    const rejected = await queue.add("wake-context", registry.hintFor(identity) satisfies WorkerWakeup);
    await vi.waitFor(async () => expect(await rejected.getState()).toBe("failed"), {
      timeout: 5000,
      interval: 25,
    });
    const failed = await queue.getJob(rejected.id!);
    expect(failed?.failedReason).toBe("worker_context_unavailable");
    expect(failed?.stacktrace.join("\n")).not.toContain("session credential");
  } finally {
    await wakeups?.close();
    // Only the freshly generated namespace above belongs to this test invocation.
    if (queue) {
      try {
        await queue.obliterate({ force: true });
      } finally {
        await queue.close();
      }
    }
    connection.disconnect();
  }
});
