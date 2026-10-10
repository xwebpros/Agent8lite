// Browser-safe reader for the coordinator-approved internal envelope; no provider or server renderer.
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../contracts/internal/native-cms-recovery-v1.schema.json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

/** Internal schema above remains the authority; every value crossing this boundary is validated. */
export type RevisionRecovery = {
  id: string;
  documentId: string;
  data: { schemaVersion: number; blocks: unknown; seo: unknown };
  issues: { path: string; code: string }[];
  canSave: false;
  canPublish: false;
};
export class RecoveryEnvelopeError extends Error {
  constructor() {
    super("The original revision cannot be recovered within the supported limits.");
  }
}

function boundedJson(value: unknown, maxDepth: number, maxNodes: number, maxBytes: number): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function check(item: unknown, depth: number) {
    if (++nodes > maxNodes || depth > maxDepth) throw new RecoveryEnvelopeError();
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new RecoveryEnvelopeError();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw new RecoveryEnvelopeError();
    ancestors.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || descriptor.get || descriptor.set)
        throw new RecoveryEnvelopeError();
      check(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  check(value, 0);
  const json = JSON.stringify(value);
  if (!json || new TextEncoder().encode(json).byteLength > maxBytes) throw new RecoveryEnvelopeError();
  return json;
}

/** Bound before recursive schema validation; reject excess data/diagnostics rather than truncate. */
export function requireRevisionRecovery(value: unknown): RevisionRecovery {
  try {
    // Original data: 20,000 nodes; up to 2,000 three-node issues plus the envelope's fixed fields.
    const json = boundedJson(value, 33, 26_010, 1024 * 1024);
    const detached: unknown = JSON.parse(json);
    if (!validate(detached)) throw new RecoveryEnvelopeError();
    const response = detached as RevisionRecovery;
    boundedJson(response.data, 32, 20_000, 256 * 1024);
    return response;
  } catch {
    // No original values, validator internals or untrusted exception messages escape this boundary.
    throw new RecoveryEnvelopeError();
  }
}

export function revisionRecovery(
  id: string,
  documentId: string,
  data: unknown,
  issues: { path: string; code: string }[],
): RevisionRecovery {
  return requireRevisionRecovery({ id, documentId, data, issues, canSave: false, canPublish: false });
}
