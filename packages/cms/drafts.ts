import { createHash } from "node:crypto";
import type { components } from "../contracts/generated/api";
import { inspectDraft, type PublishPolicy, validateForPublication } from "../templates/registry";

export type CmsDocument = components["schemas"]["Document"];
export type DraftWrite = components["schemas"]["RevisionWrite"];
export type DraftRevision = components["schemas"]["Revision"];

export class DraftConflictError extends Error {
  constructor(
    readonly status: 400 | 409 | 412,
    readonly code: string,
  ) {
    super(
      code === "revision_changed"
        ? "The document changed. Reload its version and keep the unsaved draft for review."
        : "A valid document revision is required.",
    );
  }
}

function documentVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new DraftConflictError(409, "document_version_invalid");
  return version;
}

/** Strong ETags refer to the document version, never the immutable revision ID. */
export function documentEtag(version: number): string {
  return `"${documentVersion(version)}"`;
}

/** Missing, weak, wildcard and list preconditions cannot protect an editor's draft. */
export function requireDraftVersion(currentVersion: number, ifMatch: string | undefined): number {
  documentVersion(currentVersion);
  if (!ifMatch) throw new DraftConflictError(400, "revision_required");
  const match = ifMatch.length <= 100 ? /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/.exec(ifMatch) : null;
  if (!match) throw new DraftConflictError(400, "revision_invalid");
  const expected = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(expected)) throw new DraftConflictError(400, "revision_invalid");
  if (expected !== currentVersion) throw new DraftConflictError(412, "revision_changed");
  if (currentVersion === Number.MAX_SAFE_INTEGER)
    throw new DraftConflictError(409, "document_version_exhausted");
  return currentVersion + 1;
}

// Called only on a detached, strictly validated JSON document. Array order remains semantic.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Strict new saves accept only registered v1 blocks and trusted policy-approved links. */
export function prepareDraft(value: unknown, trustedPolicy: PublishPolicy) {
  const document = validateForPublication(value, trustedPolicy);
  return {
    document,
    contentHash: createHash("sha256").update(canonicalJson(document)).digest("hex"),
  };
}

/** Recovery preserves all bounded original JSON. It never makes unsupported content writable/public. */
export function recoverDraft(value: unknown, trustedPolicy: PublishPolicy) {
  const inspected = inspectDraft(value, trustedPolicy);
  return {
    ...inspected,
    canSave: inspected.issues.length === 0,
    canPublish: false as const,
  };
}

export type DraftAppendPlan = {
  revision: DraftRevision;
  insert: {
    document_id: string;
    schema_version: number;
    block_data: DraftWrite["blocks"];
    seo: DraftWrite["seo"];
    content_hash: string;
  };
  documentUpdate: { id: string; expectedVersion: number; nextVersion: number };
  etag: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Pure plan for app.content_revision INSERT + conditional document-version UPDATE.
 * Caller supplies a currently authorized native document and server-generated revision identity/time.
 * Caller must atomically compare expectedVersion, insert immutable history, and audit/idempotency-record.
 * This function performs no persistence, authorizes no identity, and changes no publication pointer.
 */
export function planDraftAppend(
  current: Pick<CmsDocument, "id" | "version">,
  ifMatch: string | undefined,
  value: unknown,
  trustedPolicy: PublishPolicy,
  metadata: { revisionId: string; createdAt: string },
): DraftAppendPlan {
  const nextVersion = requireDraftVersion(current.version, ifMatch);
  if (
    !uuid.test(current.id) ||
    !uuid.test(metadata.revisionId) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(metadata.createdAt) ||
    !Number.isFinite(Date.parse(metadata.createdAt)) ||
    new Date(metadata.createdAt).toISOString() !== metadata.createdAt
  )
    throw new DraftConflictError(409, "revision_identity_invalid");
  const { document, contentHash } = prepareDraft(value, trustedPolicy);
  return {
    revision: {
      id: metadata.revisionId,
      documentId: current.id,
      createdAt: metadata.createdAt,
      ...structuredClone(document),
    },
    insert: {
      document_id: current.id,
      schema_version: document.schemaVersion,
      block_data: document.blocks,
      seo: document.seo,
      content_hash: contentHash,
    },
    documentUpdate: { id: current.id, expectedVersion: current.version, nextVersion },
    etag: documentEtag(nextVersion),
  };
}
