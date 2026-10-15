import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { TrustedContextRegistry, RedisWakeups, recoverCommittedOutbox } from "../../apps/worker/src/wakeups";
import { fixtures } from "../../packages/db/fixtures";

const identity = { organizationId: fixtures.orgA, userId: fixtures.ownerUser };
const identityB = { organizationId: fixtures.orgB, userId: fixtures.agentUser };

describe("PostgreSQL-authoritative outbox recovery", () => {
  it("recovers all committed work without Redis", async () => {
    const registry = new TrustedContextRegistry([identity]);
    const dispatch = vi.fn(async () => ({ dispatched: 3, deferred: 1 }));
    const result = await recoverCommittedOutbox(registry, dispatch);
    expect(result.contexts).toBe(1);
    expect(result.failedContexts).toBe(0);
    expect(result.dispatched).toBe(3);
    expect(result.deferred).toBe(1);
    expect(dispatch).toHaveBeenCalledWith(identity);
  });

  it("aggregates across multiple tenant contexts", async () => {
    const registry = new TrustedContextRegistry([identity, identityB]);
    const dispatch = vi.fn(async (ctx: { organizationId: string }) =>
      ctx.organizationId === fixtures.orgA ? { dispatched: 2, deferred: 0 } : { dispatched: 1, deferred: 1 },
    );
    const result = await recoverCommittedOutbox(registry, dispatch);
    expect(result.contexts).toBe(2);
    expect(result.dispatched).toBe(3);
    expect(result.deferred).toBe(1);
    expect(result.failedContexts).toBe(0);
  });

  it("continues past failed contexts without leaking errors", async () => {
    const registry = new TrustedContextRegistry([identity, identityB]);
    let callCount = 0;
    const dispatch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("private database credential in message");
      return { dispatched: 1, deferred: 0 };
    });
    const result = await recoverCommittedOutbox(registry, dispatch);
    expect(result.failedContexts).toBe(1);
    expect(result.dispatched).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe("RedisWakeups resilience", () => {
  it("enqueue returns false when Redis is unreachable", async () => {
    const registry = new TrustedContextRegistry([identity]);
    const dispatch = vi.fn(async () => ({ dispatched: 0, deferred: 0 }));
    const wakeups = new RedisWakeups(
      "redis://127.0.0.1:1",
      registry,
      dispatch,
      `test-${randomUUID().replaceAll("-", "")}`,
    );
    try {
      const result = await wakeups.enqueue(registry.hintFor(identity));
      expect(result).toBe(false);
    } finally {
      await wakeups.close();
    }
  });

  it("close is idempotent", async () => {
    const registry = new TrustedContextRegistry([identity]);
    const dispatch = vi.fn(async () => ({ dispatched: 0, deferred: 0 }));
    const wakeups = new RedisWakeups(
      "redis://127.0.0.1:1",
      registry,
      dispatch,
      `test-${randomUUID().replaceAll("-", "")}`,
    );
    await wakeups.close();
    await wakeups.close();
  });
});

describe("TrustedContextRegistry validation", () => {
  it("rejects empty configuration", () => {
    expect(() => new TrustedContextRegistry([])).toThrow("worker_context_invalid");
  });

  it("rejects non-UUID identifiers", () => {
    expect(
      () => new TrustedContextRegistry([{ organizationId: "not-a-uuid", userId: fixtures.ownerUser }]),
    ).toThrow("worker_context_invalid");
  });

  it("rejects duplicate contexts", () => {
    expect(() => new TrustedContextRegistry([identity, identity])).toThrow("worker_context_invalid");
  });

  it("rejects extra properties", () => {
    expect(() => new TrustedContextRegistry([{ ...identity, malicious: "payload" }])).toThrow(
      "worker_context_invalid",
    );
  });

  it("hintFor round-trips through resolve", () => {
    const registry = new TrustedContextRegistry([identity]);
    const hint = registry.hintFor(identity);
    const resolved = registry.resolve(hint);
    expect(resolved).toStrictEqual(identity);
  });

  it("resolve rejects unknown context keys", () => {
    const registry = new TrustedContextRegistry([identity]);
    expect(() => registry.resolve({ version: 1, contextKey: "0".repeat(64) })).toThrow("wakeup_unknown");
  });
});
