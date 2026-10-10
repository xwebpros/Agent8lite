import type { VerifiedIdentityContext } from "../../../packages/db/tenant-transaction";
import type { OutboxRun } from "./outbox";

/** Opaque wakeup only: Redis carries no identity, tenant data, event body or authorization. */
export type WorkerWakeup = { readonly version: 1; readonly contextKey: string };
export type TrustedWorkerContext = Readonly<VerifiedIdentityContext>;
export interface WakeupPublisher {
  /** False means unavailable; PostgreSQL recovery continues independently. */
  enqueue(hint: WorkerWakeup): Promise<boolean>;
}
export type ScopedOutboxDispatch = (identity: TrustedWorkerContext) => Promise<OutboxRun>;
