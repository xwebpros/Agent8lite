import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020";
import { Queue, Worker } from "bullmq";
import Redis, { type RedisOptions } from "ioredis";
import wakeupSchema from "../../../packages/contracts/internal/worker-wakeup-v1.schema.json";
import type {
  ScopedOutboxDispatch,
  TrustedWorkerContext,
  WakeupPublisher,
  WorkerWakeup,
} from "./wakeup-contract";

const validateWakeup = new Ajv2020({ strict: true }).compile<WorkerWakeup>(wakeupSchema);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUEUE = "reference-outbox-wakeup-v1";

export class WakeupError extends Error {
  constructor(readonly code: "worker_context_invalid" | "wakeup_invalid" | "wakeup_unknown") {
    super(code);
  }
}

function keyFor(identity: TrustedWorkerContext): string {
  return createHash("sha256")
    .update(JSON.stringify([identity.organizationId, identity.userId]))
    .digest("hex");
}

/** Trusted configuration is a lookup, never cached permission evidence. */
export class TrustedContextRegistry {
  readonly contexts: readonly TrustedWorkerContext[];
  private readonly identities = new Map<string, TrustedWorkerContext>();

  constructor(configuration: unknown) {
    if (!Array.isArray(configuration) || !configuration.length || configuration.length > 100)
      throw new WakeupError("worker_context_invalid");
    const contexts: TrustedWorkerContext[] = [];
    for (const candidate of configuration) {
      if (
        !candidate ||
        Object.getPrototypeOf(candidate) !== Object.prototype ||
        Object.keys(candidate).length !== 2 ||
        typeof candidate.userId !== "string" ||
        typeof candidate.organizationId !== "string" ||
        !UUID.test(candidate.userId) ||
        !UUID.test(candidate.organizationId)
      )
        throw new WakeupError("worker_context_invalid");
      const identity = Object.freeze({
        userId: candidate.userId,
        organizationId: candidate.organizationId,
      });
      const key = keyFor(identity);
      if (this.identities.has(key)) throw new WakeupError("worker_context_invalid");
      this.identities.set(key, identity);
      contexts.push(identity);
    }
    this.contexts = Object.freeze(contexts);
  }

  hintFor(identity: TrustedWorkerContext): WorkerWakeup {
    const hint: WorkerWakeup = Object.freeze({ version: 1, contextKey: keyFor(identity) });
    this.resolve(hint);
    return hint;
  }

  resolve(hint: unknown): TrustedWorkerContext {
    if (!validateWakeup(hint)) throw new WakeupError("wakeup_invalid");
    const identity = this.identities.get(hint.contextKey);
    if (!identity) throw new WakeupError("wakeup_unknown");
    return identity;
  }
}

export async function processWakeup(
  registry: TrustedContextRegistry,
  hint: unknown,
  dispatch: ScopedOutboxDispatch,
) {
  return dispatch(registry.resolve(hint));
}

/** Independent of Redis: a lost wakeup cannot remove committed PostgreSQL work. */
export async function recoverCommittedOutbox(
  registry: TrustedContextRegistry,
  dispatch: ScopedOutboxDispatch,
): Promise<{ contexts: number; failedContexts: number; dispatched: number; deferred: number }> {
  let failedContexts = 0;
  let dispatched = 0;
  let deferred = 0;
  for (const identity of registry.contexts) {
    try {
      const result = await dispatch(identity);
      dispatched += result.dispatched;
      deferred += result.deferred;
    } catch {
      // No raw database error or private context is returned to queue/log metadata.
      failedContexts++;
    }
  }
  return { contexts: registry.contexts.length, failedContexts, dispatched, deferred };
}

function redisOptions(value: string): RedisOptions {
  try {
    const url = new URL(value);
    if (
      value.length > 4096 ||
      !["redis:", "rediss:"].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      (url.pathname && !/^\/\d{1,2}$/.test(url.pathname))
    )
      throw new Error();
    const db = Number(url.pathname.slice(1) || 0);
    const port = Number(url.port || 6379);
    if (db > 15 || port < 1 || port > 65535) throw new Error();
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port,
      db,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
      tls: url.protocol === "rediss:" ? {} : undefined,
      connectTimeout: 1000,
      retryStrategy: (attempt) => Math.min(2000, 100 * attempt),
    };
  } catch {
    throw new Error("worker_redis_configuration_invalid");
  }
}

/** Owned BullMQ connections; no schedules or authoritative job state live in Redis. */
export class RedisWakeups implements WakeupPublisher {
  private readonly producer: Redis;
  private readonly consumer: Redis;
  private readonly queue: Queue<WorkerWakeup>;
  private readonly worker: Worker<WorkerWakeup>;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(
    url: string,
    private readonly registry: TrustedContextRegistry,
    dispatch: ScopedOutboxDispatch,
    namespace = "estate-synthetic-reference-v1",
  ) {
    if (!/^[a-z0-9-]{1,100}$/.test(namespace)) throw new Error("worker_queue_namespace_invalid");
    const connection = redisOptions(url);
    this.producer = new Redis({
      ...connection,
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      enableOfflineQueue: false,
    });
    this.consumer = new Redis({ ...connection, maxRetriesPerRequest: null });
    this.producer.on("error", () => {});
    this.consumer.on("error", () => {});
    this.queue = new Queue<WorkerWakeup>(QUEUE, {
      connection: this.producer,
      prefix: namespace,
      skipWaitingForReady: true,
      streams: { events: { maxLen: 100 } },
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: { age: 3600, count: 100 },
      },
    });
    this.queue.on("error", () => {});
    this.worker = new Worker<WorkerWakeup>(
      QUEUE,
      async (job) => {
        try {
          if (this.closed || job.name !== "wake-context") throw new WakeupError("wakeup_invalid");
          await processWakeup(this.registry, job.data, dispatch);
        } catch (error) {
          // BullMQ stores error messages. Retain only fixed safe codes, never source errors.
          throw new Error(error instanceof WakeupError ? error.code : "worker_context_unavailable");
        }
      },
      {
        connection: this.consumer,
        prefix: namespace,
        concurrency: 2,
        lockDuration: 10000,
        maxStalledCount: 1,
        removeOnComplete: { count: 0 },
        removeOnFail: { age: 3600, count: 100 },
      },
    );
    this.worker.on("error", () => {});
  }

  async enqueue(hint: WorkerWakeup): Promise<boolean> {
    this.registry.resolve(hint);
    if (this.closed || this.producer.status !== "ready") return false;
    try {
      await this.queue.add("wake-context", hint, { jobId: hint.contextKey });
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const stopped = this.worker.close(true);
      this.producer.disconnect();
      this.consumer.disconnect();
      await Promise.allSettled([stopped, this.queue.close()]);
    })();
    return this.closing;
  }
}
