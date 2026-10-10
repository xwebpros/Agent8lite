import type { components } from "../../../../packages/contracts/generated/api";
import { AccessError } from "../../../../packages/db/tenant-transaction";
import { prepareNativeMessageDesign } from "../../../../packages/marketing/native-design";
import { validateSchema } from "../contract-validation";
import { workflowJson } from "./workflow-json";

export type MessageDesign = components["schemas"]["MessageDesign"];
export type MessageDesignWrite = components["schemas"]["MessageDesignWrite"];
export type MessageDesignPage = components["schemas"]["PageMessageDesign"];
export type MessageDesignMutation = { body: MessageDesign; status: 200 | 201; etag: string };

/** Private row shape; immutable history bodies/provenance are never selected. */
export type MessageDesignRow = {
  id: string;
  name: string;
  channel: MessageDesign["channel"];
  subject: string | null;
  editor_kind: string;
  design: MessageDesign["design"];
  rendered_content: string;
  content_hash: string;
  version: number;
  row_version: string;
  availability_state: string;
  history_ready: boolean;
  revision_version: number | null;
  revision_hash: string | null;
  revision_row_version: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = (): never => {
  throw new AccessError(503, "design_source_unavailable", "Current design metadata is unavailable.");
};

export function messageDesignEtag(version: number): string {
  if (!Number.isInteger(version) || version < 1 || version > 2147483647) unavailable();
  return `"${version}"`;
}

function publicModel(write: Readonly<MessageDesignWrite>, id: string, version: number): MessageDesign {
  if (typeof id !== "string" || !uuid.test(id)) unavailable();
  messageDesignEtag(version);
  const body: MessageDesign = Object.freeze(
    Object.assign(Object.create(null), {
      ...write,
      id: id.toLowerCase(),
      subject: write.subject ?? null,
      version,
    }),
  );
  validateSchema("MessageDesign", body, true);
  return body;
}

/** Verify current safe revision metadata plus the exact approved current native payload. */
export function messageDesignModel(row: MessageDesignRow): MessageDesign {
  if (
    row.availability_state !== "draft" ||
    row.history_ready !== true ||
    row.editor_kind !== "native" ||
    typeof row.row_version !== "string" ||
    !/^[1-9][0-9]*$/.test(row.row_version) ||
    row.row_version.length > 19 ||
    BigInt(row.row_version) > 9223372036854775807n ||
    row.revision_version !== row.version ||
    row.revision_hash !== row.content_hash ||
    row.revision_row_version !== row.row_version
  )
    unavailable();
  try {
    const prepared = prepareNativeMessageDesign({
      name: row.name,
      channel: row.channel,
      editor: "native",
      design: row.design,
      content: row.rendered_content,
      ...(row.subject === null ? {} : { subject: row.subject }),
    });
    if (prepared.contentHash !== row.content_hash) unavailable();
    return publicModel(prepared.body, row.id, row.version);
  } catch {
    return unavailable();
  }
}

/** Historical receipt stays historical; it is never a substitute for current source authorization. */
export function messageDesignReceipt(value: unknown): MessageDesign {
  try {
    const snapshot = JSON.parse(workflowJson(value)) as MessageDesign;
    validateSchema("MessageDesign", snapshot, true);
    if (snapshot.editor !== "native") unavailable();
    const prepared = prepareNativeMessageDesign({
      name: snapshot.name,
      channel: snapshot.channel,
      editor: "native",
      design: snapshot.design,
      content: snapshot.content,
      ...(snapshot.subject == null ? {} : { subject: snapshot.subject }),
    });
    if (typeof snapshot.id !== "string" || !uuid.test(snapshot.id)) unavailable();
    messageDesignEtag(snapshot.version);
    // Preserve optional/null subject and every committed field exactly. The
    // detached native JSON is frozen; no new defaults rewrite a valid receipt.
    const body: MessageDesign = Object.freeze(
      Object.assign(Object.create(null), snapshot, { design: prepared.body.design }),
    );
    return body;
  } catch {
    throw new AccessError(
      503,
      "replay_metadata_unavailable",
      "Historical message-design receipt is unavailable.",
    );
  }
}
