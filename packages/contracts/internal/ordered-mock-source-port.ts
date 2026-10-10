import type { ChangePage, FeedContext } from "../../providers/mls/port";

/** Server-only ordered fixture proof. Hashes bind content; they confer no permission or live-feed rights. */
export type OrderedMockSourceProofV1 = Readonly<{
  schemaVersion: 1;
  profile: "ordered-synthetic-v1";
  context: Readonly<FeedContext>;
  generation: string;
  pageDigest: string;
  entries: readonly Readonly<{ index: number; changeId: string; sequence: number }>[];
}>;

export type OrderedMockSourceInput = Readonly<{
  cursor: string | null;
  watermark: string | null;
  overlapSeconds: number;
  limit: number;
}>;

/** A trusted service binds this port to a current feed; the wakeup/browser never supplies source proof. */
export interface OrderedMockSourcePort {
  readonly profile: "ordered-synthetic-v1";
  readonly generation: string;
  readOrderedChanges(
    context: FeedContext,
    input: OrderedMockSourceInput,
  ): Promise<Readonly<{ page: ChangePage; proof: OrderedMockSourceProofV1 }>>;
}
