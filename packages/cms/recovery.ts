// Browser-safe reader for the coordinator-approved internal envelope; no provider or server renderer.
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../contracts/internal/native-cms-recovery-v1.schema.json";
import { boundedCmsJson } from "./json";

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

/** Bound before recursive schema validation; reject excess data/diagnostics rather than truncate. */
export function requireRevisionRecovery(value: unknown): RevisionRecovery {
  try {
    // Original data: 20,000 nodes; up to 2,000 three-node issues plus the envelope's fixed fields.
    const json = boundedCmsJson(value, { maxDepth: 33, maxNodes: 26_010, maxBytes: 1024 * 1024 });
    const detached: unknown = JSON.parse(json);
    if (!validate(detached)) throw new RecoveryEnvelopeError();
    const response = detached as RevisionRecovery;
    boundedCmsJson(response.data, { maxDepth: 32, maxNodes: 20_000, maxBytes: 256 * 1024 });
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
