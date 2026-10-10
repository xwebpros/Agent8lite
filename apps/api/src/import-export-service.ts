import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { components } from "../../../packages/contracts/generated/api";
import { requireEntitlement } from "../../../packages/auth/entitlements";
import { AccessError, requirePermission, type TenantContext } from "../../../packages/db/tenant-transaction";
import { PrivateLocalObjectStore } from "../../../packages/storage/private-local";
import { StorageError, type UploadGrantBinding } from "../../../packages/storage/port";
import { jobModel } from "./admin-service";
import { validateSchema } from "./contract-validation";
import { assertUuid, CrmService, stable } from "./crm-service";
import { formatCsv, parseCsv } from "./csv";

type Schemas = components["schemas"];
type Row = Record<string, any>;
type ImportRow = {
  row: number;
  contact: Schemas["ContactWrite"];
  lead?: { intent: Schemas["LeadCreate"]["intent"]; timeline?: string; sourceId: string };
  duplicate: boolean;
  candidateRefs: string[];
};
const enabled =
  ["development", "test"].includes(process.env.APP_ENV ?? "") && process.env.DEV_AUTH_ENABLED === "true";
const objects = enabled
  ? new PrivateLocalObjectStore({
      mode: process.env.APP_ENV === "test" ? "test" : "development",
      signingSecret: process.env.STORAGE_SIGNING_KEY,
      baseDirectory: process.env.PRIVATE_OBJECT_DIRECTORY,
    })
  : null;
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const unavailable = (): never => {
  throw new AccessError(404, "resource_unavailable", "Resource unavailable or out of scope.");
};
function storage() {
  if (!objects)
    throw new AccessError(503, "private_storage_unconfigured", "Approved private storage is required.");
  return objects;
}
function downloadUrl(jobId: string) {
  const configured = (process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000").split(",")[0];
  const url = new URL(configured);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname))
    throw new AccessError(
      503,
      "local_storage_origin_invalid",
      "Synthetic storage requires a loopback web origin.",
    );
  return new URL(`/api/dev/exports/${jobId}`, url).toString();
}
export function storageFailure(error: unknown): never {
  if (error instanceof StorageError)
    throw new AccessError(
      error.code.includes("conflict") ? 409 : 422,
      error.code,
      "Private object request was rejected.",
    );
  throw error;
}

export class UploadService {
  readonly foundation: CrmService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
  }
  async grant(body: Schemas["UploadRequest"]) {
    requirePermission(this.context, "media.write");
    requirePermission(this.context, "crm.import");
    requirePermission(this.context, "crm.contacts.write");
    await requireEntitlement(this.client, "crm.import");
    if (body.purpose !== "contact_import" || body.mimeType !== "text/csv" || !/\.csv$/i.test(body.filename))
      throw new AccessError(
        422,
        "upload_purpose_unavailable",
        "Only private UTF-8 contact CSV imports are enabled.",
      );
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const objectKey = `${this.context.organizationId}/uploads/${id}.csv`;
    await this.client.query(
      `INSERT INTO app.media_asset(tenant_id,id,object_key,mime_type,byte_size,scan_state,rights,requesting_member_id,purpose,upload_expires_at)VALUES($1,$2,$3,$4,$5,'awaiting_upload',$6,$7,'contact_import',$8)`,
      [
        this.context.organizationId,
        id,
        objectKey,
        body.mimeType,
        body.bytes,
        JSON.stringify({ synthetic: true, private: true, noPublication: true }),
        this.context.memberId,
        expiresAt,
      ],
    );
    await this.foundation.audit("upload.granted", "media_asset", id, 1);
    return { body: await this.grantForAsset(id), status: 201 };
  }
  async asset(id: string, lock = false) {
    assertUuid(id);
    const result = await this.client.query(
      `SELECT * FROM app.media_asset WHERE tenant_id=app.current_tenant() AND id=$1 AND requesting_member_id=$2 AND purpose='contact_import' ${lock ? "FOR UPDATE" : ""}`,
      [id, this.context.memberId],
    );
    return result.rows[0] ?? unavailable();
  }
  private binding(asset: Row): UploadGrantBinding {
    return {
      tenantId: this.context.organizationId,
      memberId: this.context.memberId,
      assetId: asset.id,
      objectKey: asset.object_key,
      mimeType: asset.mime_type,
      bytes: Number(asset.byte_size),
      expiresAt: new Date(asset.upload_expires_at).toISOString(),
    };
  }
  async grantForAsset(id: string): Promise<Schemas["UploadGrant"]> {
    requirePermission(this.context, "crm.import");
    requirePermission(this.context, "crm.contacts.write");
    await requireEntitlement(this.client, "crm.import");
    const asset = await this.asset(id);
    const binding = this.binding(asset);
    let signature: string;
    try {
      signature = storage().issueUploadGrant(binding).signature;
    } catch (error) {
      return storageFailure(error);
    }
    const url = new URL(downloadUrl(id));
    url.pathname = `/api/dev/storage/uploads/${id}`;
    return {
      assetId: id,
      url: url.toString(),
      method: "PUT",
      expiresAt: binding.expiresAt,
      requiredHeaders: { "Content-Type": "text/csv", "X-Upload-Grant": signature },
    };
  }
  async put(id: string, signature: string, mimeType: string, bytes: Buffer) {
    requirePermission(this.context, "media.write");
    requirePermission(this.context, "crm.import");
    requirePermission(this.context, "crm.contacts.write");
    const asset = await this.asset(id, true);
    const binding = this.binding(asset);
    try {
      storage().verifyUploadGrant(signature, binding);
    } catch (error) {
      storageFailure(error);
    }
    if (mimeType !== binding.mimeType || !Buffer.isBuffer(bytes) || bytes.length !== binding.bytes)
      throw new AccessError(
        422,
        "upload_binding_mismatch",
        "Upload content type and byte count must match the grant.",
      );
    parseCsv(bytes);
    const hash = digest(bytes);
    if (asset.content_sha256 && asset.content_sha256 !== hash)
      throw new AccessError(409, "upload_content_changed", "An uploaded object cannot be replaced.");
    try {
      await storage().putOnce(this.context.organizationId, asset.object_key, bytes);
    } catch (error) {
      storageFailure(error);
    }
    if (!asset.content_sha256) {
      const updated = await this.client.query(
        `UPDATE app.media_asset SET content_sha256=$1,scan_state='csv_validated_unscanned',updated_at=now(),row_version=row_version+1 WHERE tenant_id=app.current_tenant() AND id=$2 RETURNING row_version`,
        [hash, id],
      );
      await this.foundation.audit(
        "upload.csv_validated_unscanned",
        "media_asset",
        id,
        Number(updated.rows[0].row_version),
      );
    }
  }
  async readCsv(id: string) {
    const asset = await this.asset(id);
    if (asset.scan_state !== "csv_validated_unscanned" || !asset.content_sha256)
      throw new AccessError(
        409,
        "upload_incomplete",
        "Upload and validate the private CSV before creating a preview.",
      );
    let bytes: Buffer;
    try {
      bytes = await storage().read(this.context.organizationId, asset.object_key);
    } catch (error) {
      return storageFailure(error);
    }
    if (digest(bytes) !== asset.content_sha256)
      throw new AccessError(
        409,
        "upload_content_changed",
        "Uploaded input changed. Create a fresh upload and preview.",
      );
    return { asset, bytes };
  }
}

export class ImportExportService {
  readonly foundation: CrmService;
  private readonly uploads: UploadService;
  constructor(
    private readonly client: PoolClient,
    readonly context: TenantContext,
    readonly traceId: string,
  ) {
    this.foundation = new CrmService(client, context, traceId);
    this.uploads = new UploadService(client, context, traceId);
  }
  private scopeFingerprint(kind: string, filter: unknown) {
    return digest(
      stable({
        tenant: this.context.organizationId,
        actor: this.context.userId,
        member: this.context.memberId,
        role: this.context.roleId,
        permissions: [...this.context.permissions].sort((a, b) => a.code.localeCompare(b.code)),
        kind,
        filter,
      }),
    );
  }
  private async records(kind: "contacts" | "leads", filter: Schemas["LeadFilter"]) {
    requirePermission(this.context, `crm.${kind}.read`);
    await requireEntitlement(this.client, `crm.${kind}.read`);
    const items: Row[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.foundation.list(kind, {
        limit: 100,
        filter: JSON.stringify(filter),
        ...(cursor ? { cursor } : {}),
      });
      items.push(...(page.items as Row[]));
      cursor = page.nextCursor;
      if (items.length >= 1000 && cursor)
        throw new AccessError(
          422,
          "operation_size_exceeded",
          "This local operation supports at most 1,000 authorized records.",
        );
    } while (cursor);
    return items;
  }
  private async evaluate(bytes: Buffer, columnMap: Schemas["ImportPreviewRequest"]["columnMap"]) {
    const csv = parseCsv(bytes);
    const headers = csv[0];
    const fields = Object.values(columnMap);
    if (
      !fields.includes("displayName") ||
      new Set(fields).size !== fields.length ||
      Object.keys(columnMap).some((key) => !headers.includes(key))
    )
      throw new AccessError(
        422,
        "column_mapping_invalid",
        "Map a display name and use each supported field once from an existing CSV header.",
      );
    const existing = await this.records("contacts", {});
    const existingChannels = new Map<string, string[]>();
    for (const contact of existing)
      for (const channel of [...contact.emails, ...contact.phones])
        existingChannels.set(channel, [
          ...(existingChannels.get(channel) ?? []),
          `contact:${contact.id}:${contact.version}`,
        ]);
    const seen = new Map<string, number>();
    const sourceRows = await this.client.query(
      "SELECT id,code FROM app.lead_source WHERE tenant_id=app.current_tenant()",
    );
    const sources = new Map<string, string>(sourceRows.rows.map((row) => [row.code, row.id]));
    const rows: ImportRow[] = [];
    const errors: Schemas["ImportPreview"]["sampleErrors"] = [];
    let invalidRows = 0;
    let duplicates = 0;
    for (let index = 1; index < csv.length; index++) {
      const values = csv[index];
      const mapped: Record<string, string> = {};
      for (const [header, field] of Object.entries(columnMap))
        mapped[field] = (values[headers.indexOf(header)] ?? "").trim();
      const rowNumber = index + 1;
      try {
        if (values.length !== headers.length)
          throw new AccessError(422, "column_count_invalid", "Invalid row.");
        const email = (mapped.email ?? "").toLowerCase();
        const phone = (mapped.phone ?? "").replace(/[\s().-]/g, "");
        if (!mapped.displayName || (phone && !/^\+?[0-9]{7,15}$/.test(phone)))
          throw new AccessError(422, "row_values_invalid", "Invalid row.");
        const contact: Schemas["ContactWrite"] = {
          displayName: mapped.displayName,
          emails: email ? [email] : [],
          phones: phone ? [phone] : [],
        };
        validateSchema("ContactWrite", contact);
        let lead: ImportRow["lead"];
        if (mapped.intent || mapped.timeline || mapped.sourceCode) {
          requirePermission(this.context, "crm.leads.write");
          const sourceId = sources.get(mapped.sourceCode);
          if (!sourceId) throw new AccessError(422, "source_code_invalid", "Invalid row.");
          const intent = (mapped.intent || "unknown") as Schemas["LeadCreate"]["intent"];
          validateSchema("LeadCreate", {
            contactId: randomUUID(),
            sourceId,
            ownerMemberId: this.context.memberId,
            intent,
            timeline: mapped.timeline || null,
          });
          lead = { sourceId, intent, ...(mapped.timeline ? { timeline: mapped.timeline } : {}) };
        }
        const channels = [email, phone].filter(Boolean);
        const candidateRefs = [
          ...new Set(
            channels.flatMap((value) => [
              ...(existingChannels.get(value) ?? []),
              ...(seen.has(value) ? [`csv-row:${seen.get(value)}`] : []),
            ]),
          ),
        ].sort();
        const duplicate = candidateRefs.length > 0;
        channels.forEach((value) => {
          if (!seen.has(value)) seen.set(value, rowNumber);
        });
        if (duplicate) duplicates++;
        rows.push({ row: rowNumber, contact, lead, duplicate, candidateRefs });
      } catch (error) {
        if (!(error instanceof AccessError)) throw error;
        invalidRows++;
        if (errors.length < 50) errors.push({ row: rowNumber, field: "row", code: error.code });
      }
    }
    return { rows, validRows: rows.length, invalidRows, duplicates, sampleErrors: errors };
  }
  async preview(body: Schemas["ImportPreviewRequest"]) {
    requirePermission(this.context, "crm.import");
    requirePermission(this.context, "crm.contacts.write");
    const { asset, bytes } = await this.uploads.readCsv(body.assetId);
    const evaluation = await this.evaluate(bytes, body.columnMap);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const summary = {
      validRows: evaluation.validRows,
      invalidRows: evaluation.invalidRows,
      duplicates: evaluation.duplicates,
      sampleErrors: evaluation.sampleErrors,
      snapshotHash: digest(stable(evaluation.rows)),
      scopeFingerprint: this.scopeFingerprint("import", {}),
    };
    await this.client.query(
      `INSERT INTO app.import_job(tenant_id,id,member_id,object_key,state,summary,expires_at,asset_id,content_sha256,column_map)VALUES($1,$2,$3,$4,'previewed',$5,$6,$7,$8,$9)`,
      [
        this.context.organizationId,
        id,
        this.context.memberId,
        asset.object_key,
        JSON.stringify(summary),
        expiresAt,
        asset.id,
        asset.content_sha256,
        JSON.stringify(body.columnMap),
      ],
    );
    await this.foundation.audit("contact_import.previewed", "import_job", id, 1);
    return {
      body: {
        id,
        validRows: evaluation.validRows,
        invalidRows: evaluation.invalidRows,
        duplicates: evaluation.duplicates,
        sampleErrors: evaluation.sampleErrors,
        expiresAt,
      },
      status: 201,
    };
  }
  async commit(body: Schemas["ImportCommit"]) {
    requirePermission(this.context, "crm.import");
    requirePermission(this.context, "crm.contacts.write");
    assertUuid(body.previewId);
    if (body.duplicatePolicy !== "skip")
      throw new AccessError(
        422,
        "merge_review_required",
        "Reviewed candidate-level merging requires an approved review contract. Choose explicit duplicate skipping.",
      );
    const found = await this.client.query(
      `SELECT * FROM app.import_job WHERE tenant_id=app.current_tenant() AND id=$1 AND member_id=$2 FOR UPDATE`,
      [body.previewId, this.context.memberId],
    );
    const preview = found.rows[0] ?? unavailable();
    if (preview.state !== "previewed")
      throw new AccessError(409, "import_already_committed", "This preview was already committed.");
    if (new Date(preview.expires_at).getTime() <= Date.now())
      throw new AccessError(409, "import_preview_expired", "Create a fresh import preview.");
    if (preview.summary.scopeFingerprint !== this.scopeFingerprint("import", {}))
      throw new AccessError(409, "import_scope_changed", "Access changed. Create a fresh preview.");
    const { asset, bytes } = await this.uploads.readCsv(preview.asset_id);
    if (asset.content_sha256 !== preview.content_sha256)
      throw new AccessError(409, "import_input_changed", "Import input changed.");
    // Serialize overlapping imports before the second duplicate evaluation; no blind duplicate creation.
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `${this.context.organizationId}:contact-import`,
    ]);
    const evaluation = await this.evaluate(bytes, preview.column_map);
    if (
      digest(stable(evaluation.rows)) !== preview.summary.snapshotHash ||
      evaluation.validRows !== body.confirmedRowCount
    )
      throw new AccessError(
        409,
        "import_preview_changed",
        "Input or duplicate candidates changed. Create a fresh preview and confirm its valid-row count.",
      );
    let imported = 0;
    for (const row of evaluation.rows) {
      if (row.duplicate) continue;
      const created = await this.foundation.create("contacts", row.contact);
      if (row.lead)
        await this.foundation.create("leads", {
          contactId: (created.body as Schemas["Contact"]).id,
          ...row.lead,
          ownerMemberId: this.context.memberId,
        });
      imported++;
    }
    const job = await this.client.query(
      `INSERT INTO app.integration_job(tenant_id,requesting_member_id,kind,state,result_ref,safe_result)VALUES($1,$2,'contacts.import','succeeded',$3,$4)RETURNING *`,
      [
        this.context.organizationId,
        this.context.memberId,
        preview.id,
        JSON.stringify({
          imported,
          skipped: evaluation.duplicates,
          invalid: evaluation.invalidRows,
          previewId: preview.id,
          synthetic: true,
        }),
      ],
    );
    await this.client.query(
      `UPDATE app.import_job SET state='committed',accepted_job_id=$1,row_version=row_version+1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$2`,
      [job.rows[0].id, preview.id],
    );
    await this.foundation.audit(
      "contact_import.committed",
      "import_job",
      preview.id,
      Number(preview.row_version) + 1,
    );
    return { body: jobModel(job.rows[0]), status: 202 };
  }
  async export(body: Schemas["ExportRequest"]) {
    requirePermission(this.context, "data.export");
    if (body.kind === "report")
      throw new AccessError(
        422,
        "report_export_unavailable",
        "Versioned report exports are not implemented yet.",
      );
    const records = await this.records(body.kind, body.filter);
    const headings =
      body.kind === "contacts"
        ? ["SYNTHETIC DEMO DATA", "contactId", "displayName", "emails", "phones"]
        : [
            "SYNTHETIC DEMO DATA",
            "leadId",
            "contactId",
            "intent",
            "timeline",
            "ownerMemberId",
            "stageId",
            "sourceId",
          ];
    const lines = records.map((row) =>
      body.kind === "contacts"
        ? ["SYNTHETIC DEMO DATA", row.id, row.displayName, row.emails.join("; "), row.phones.join("; ")]
        : [
            "SYNTHETIC DEMO DATA",
            row.id,
            row.contactId,
            row.intent,
            row.timeline,
            row.ownerMemberId,
            row.stageId,
            row.sourceId,
          ],
    );
    const bytes = formatCsv([headings, ...lines]);
    const id = randomUUID();
    const objectKey = `${this.context.organizationId}/exports/${id}.csv`;
    try {
      await storage().putPrivateResult(this.context.organizationId, objectKey, bytes);
    } catch (error) {
      storageFailure(error);
    }
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const safeResult = {
      kind: body.kind,
      filter: body.filter,
      scopeFingerprint: this.scopeFingerprint(body.kind, body.filter),
      resources: records.map((row) => ({ id: row.id, version: row.version })),
      objectKey,
      sha256: digest(bytes),
      expiresAt,
      resultUrl: downloadUrl(id),
      synthetic: true,
    };
    const job = await this.client.query(
      `INSERT INTO app.integration_job(tenant_id,id,requesting_member_id,kind,state,result_ref,safe_result)VALUES($1,$2,$3,'data.export','succeeded',$4,$5)RETURNING *`,
      [this.context.organizationId, id, this.context.memberId, objectKey, JSON.stringify(safeResult)],
    );
    await this.foundation.audit("data.exported", "integration_job", id, 1);
    return { body: jobModel(job.rows[0]), status: 202 };
  }
  async download(id: string) {
    assertUuid(id);
    requirePermission(this.context, "data.export");
    const found = await this.client.query(
      `SELECT * FROM app.integration_job WHERE tenant_id=app.current_tenant() AND id=$1 AND requesting_member_id=$2 AND kind='data.export' AND state='succeeded'`,
      [id, this.context.memberId],
    );
    const job = found.rows[0] ?? unavailable();
    const result = job.safe_result;
    if (new Date(result.expiresAt).getTime() <= Date.now())
      throw new AccessError(410, "export_expired", "Request a fresh export.");
    if (result.scopeFingerprint !== this.scopeFingerprint(result.kind, result.filter))
      throw new AccessError(403, "export_access_changed", "Export access changed. Request a fresh export.");
    requirePermission(this.context, `crm.${result.kind}.read`);
    await requireEntitlement(this.client, `crm.${result.kind}.read`);
    for (const resource of result.resources) {
      const row = await this.foundation.row(result.kind, resource.id);
      if (Number(row.row_version) !== resource.version)
        throw new AccessError(
          409,
          "export_source_changed",
          "An exported record changed. Request a fresh export.",
        );
    }
    let bytes: Buffer;
    try {
      bytes = await storage().read(this.context.organizationId, result.objectKey);
    } catch (error) {
      return storageFailure(error);
    }
    if (digest(bytes) !== result.sha256)
      throw new AccessError(
        409,
        "export_content_changed",
        "Export contents changed. Request a fresh export.",
      );
    return { bytes, filename: `synthetic-${result.kind}-${id}.csv` };
  }
}
