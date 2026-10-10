// Browser-safe validation of the approved metadata-only index, independent of frozen PageRevision.
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import schema from "../contracts/internal/native-cms-revision-history-v1.schema.json";
import { boundedCmsJson } from "./json";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const validateDocumentId = ajv.compile(schema.properties.items.items.properties.documentId);
export type RevisionHistory = {
  items: { id: string; documentId: string; schemaVersion: number; createdAt: string }[];
  hasMore: boolean;
  nextCursor: string | null;
};
export class HistoryEnvelopeError extends Error {
  constructor() {
    super("The revision history response is unavailable.");
  }
}

/** Every caller supplies the authorized path document; metadata never confers edit permission. */
export function requireRevisionHistory(value: unknown, documentId: string): RevisionHistory {
  try {
    if (!validateDocumentId(documentId)) throw new HistoryEnvelopeError();
    // At most 100 five-node items plus root/array/hasMore/cursor; bound before schema validation.
    const json = boundedCmsJson(value, { maxDepth: 3, maxNodes: 504, maxBytes: 64 * 1024 });
    const detached: unknown = JSON.parse(json);
    if (!validate(detached)) throw new HistoryEnvelopeError();
    const body = detached as RevisionHistory;
    if (
      body.items.some((item) => item.documentId !== documentId) ||
      new Set(body.items.map((item) => item.id)).size !== body.items.length
    )
      throw new HistoryEnvelopeError();
    return body;
  } catch {
    throw new HistoryEnvelopeError();
  }
}
