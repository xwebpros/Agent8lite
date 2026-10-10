import { describe, expect, it, vi } from "vitest";
import {
  processWakeup,
  recoverCommittedOutbox,
  RedisWakeups,
  TrustedContextRegistry,
} from "../../apps/worker/src/wakeups";
import { fixtures } from "../../packages/db/fixtures";
import type { VerifiedIdentityContext } from "../../packages/db/tenant-transaction";

const identity = { userId: fixtures.ownerUser, organizationId: fixtures.orgA };
const other = { userId: fixtures.agentUser, organizationId: fixtures.orgA };

describe("opaque worker wakeups and trusted configuration", () => {
  it("detaches and freezes identities, registry entries and hints without caching permissions", () => {
    const configuration: VerifiedIdentityContext[] = [{ ...identity }];
    const registry = new TrustedContextRegistry(configuration);
    const hint = registry.hintFor(identity);
    configuration[0].userId = fixtures.otherAgentUser;
    configuration.push(other);
    expect(registry.contexts).toEqual([identity]);
    expect(Object.isFrozen(registry.contexts)).toBe(true);
    expect(Object.isFrozen(registry.contexts[0])).toBe(true);
    expect(Object.isFrozen(hint)).toBe(true);
    expect(Reflect.set(registry.contexts[0], "userId", fixtures.otherAgentUser)).toBe(false);
    expect(registry.resolve(hint)).toEqual(identity);
    expect(Object.keys(hint).sort()).toEqual(["contextKey", "version"]);
    expect(hint.contextKey).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(hint)).not.toMatch(/userId|organizationId|permission|tenant|session/);
  });

  it("rejects malformed, repeated, noncanonical or authority-bearing server configuration", () => {
    for (const configuration of [
      null,
      {},
      [],
      [identity, identity],
      Array(101).fill(identity),
      [{ ...identity, userId: "not-a-uuid" }],
      [{ ...identity, memberId: fixtures.ownerMemberA }],
      [{ ...identity, permissions: [{ code: "crm.leads.read", scope: "organization" }] }],
      [Object.assign(Object.create(null), identity)],
    ])
      expect(() => new TrustedContextRegistry(configuration)).toThrow("worker_context_invalid");
  });

  it("rejects malformed, unknown and forged identity-bearing hints before dispatch", async () => {
    const registry = new TrustedContextRegistry([identity]);
    const hint = registry.hintFor(identity);
    const dispatch = vi.fn(async () => ({ dispatched: 1, deferred: 0 }));
    for (const forged of [
      null,
      [],
      "hint",
      {},
      { ...hint, version: 2 },
      { ...hint, version: "1" },
      { ...hint, contextKey: "0".repeat(64) },
      { ...hint, contextKey: hint.contextKey.toUpperCase() },
      { ...hint, organizationId: fixtures.orgB },
      { ...hint, userId: fixtures.otherAgentUser },
      { ...hint, payload: { resourceId: fixtures.leadB } },
      { ...hint, permissions: ["crm.leads.read"] },
    ]) {
      await expect(processWakeup(registry, forged, dispatch)).rejects.toMatchObject({
        code:
          forged &&
          typeof forged === "object" &&
          "contextKey" in forged &&
          forged.contextKey === "0".repeat(64)
            ? "wakeup_unknown"
            : "wakeup_invalid",
      });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(() => registry.hintFor(other)).toThrow("wakeup_unknown");
    await expect(processWakeup(registry, hint, dispatch)).resolves.toEqual({ dispatched: 1, deferred: 0 });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("recovery covers every trusted context after a failure and exposes only safe totals", async () => {
    const registry = new TrustedContextRegistry([identity, other]);
    const dispatch = vi.fn(async (actor) => {
      if (actor.userId === identity.userId) throw new Error("private database detail and session token");
      return { dispatched: 2, deferred: 3 };
    });
    expect(await recoverCommittedOutbox(registry, dispatch)).toEqual({
      contexts: 2,
      failedContexts: 1,
      dispatched: 2,
      deferred: 3,
    });
    expect(dispatch.mock.calls.map(([actor]) => actor)).toEqual([identity, other]);
  });

  it("duplicate hints invoke current dispatch rather than retaining permission or completion evidence", async () => {
    const registry = new TrustedContextRegistry([identity]);
    const hint = registry.hintFor(identity);
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ dispatched: 1, deferred: 0 })
      .mockRejectedValueOnce(new Error("current membership revoked"));
    await expect(processWakeup(registry, hint, dispatch)).resolves.toEqual({ dispatched: 1, deferred: 0 });
    await expect(processWakeup(registry, hint, dispatch)).rejects.toThrow("current membership revoked");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("rejects Redis configuration and namespace errors before creating connections", () => {
    const registry = new TrustedContextRegistry([identity]);
    const dispatch = vi.fn(async () => ({ dispatched: 0, deferred: 0 }));
    for (const url of [
      "https://127.0.0.1",
      "redis://127.0.0.1/16",
      "redis://127.0.0.1/1?secret=private",
      "redis://127.0.0.1/1#private",
      "redis://127.0.0.1/not-a-db",
      "redis://127.0.0.1:0",
    ])
      expect(() => new RedisWakeups(url, registry, dispatch)).toThrow("worker_redis_configuration_invalid");
    expect(() => new RedisWakeups("redis://127.0.0.1:6379", registry, dispatch, "shared:unsafe")).toThrow(
      "worker_queue_namespace_invalid",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
