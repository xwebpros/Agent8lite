import type { PoolClient } from "pg";
import type { DraftAppendPlan } from "../../../../packages/cms";
import { AccessError } from "../../../../packages/db/tenant-transaction";

type Lock = "read" | "write";
export type DomainRow = {
  id: string;
  site_id: string;
  hostname: string;
  verification_state: string;
  tls_state: string;
  environment: "preview" | "production";
  archived_at: Date | null;
  row_version: string;
};
export type MediaRow = {
  id: string;
  site_id: string | null;
  object_key: string;
  mime_type: string;
  byte_size: string;
  scan_state: string;
  alt_text: string | null;
  content_sha256: string | null;
  rights: unknown;
  row_version: string;
};
export type FormRow = {
  id: string;
  site_id: string;
  name: string;
  version: number;
  definition: unknown;
  state: string;
  row_version: string;
};
export type SiteRow = {
  id: string;
  business_profile_id: string;
  name: string;
  state: "draft" | "publishing" | "published" | "suspended";
  theme_version: string;
  published_at: Date | null;
  row_version: string;
};
export type DocumentRow = {
  id: string;
  site_id: string;
  slug: string;
  kind: "page" | "landing" | "blog" | "community" | "agent" | "testimonial";
  title: string;
  published_revision_id: string | null;
  archived_at: Date | null;
  row_version: string;
};
export type RevisionRow = {
  id: string;
  document_id: string;
  schema_version: number;
  block_data: unknown;
  seo: unknown;
  content_hash: string;
  created_at: Date;
};
export type RevisionMetadataRow = Pick<RevisionRow, "id" | "document_id" | "schema_version" | "created_at">;

/** Own native CMS tables only. Tenant context/transaction/permission checks belong to the caller. */
export class CmsRepository {
  constructor(private readonly client: PoolClient) {}

  async site(id: string): Promise<SiteRow | undefined> {
    const result = await this.client.query<SiteRow>(
      "SELECT * FROM app.site WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
      [id],
    );
    return result.rows[0];
  }

  async document(id: string, lock?: Lock): Promise<DocumentRow | undefined> {
    const result = await this.client.query<DocumentRow>(
      `SELECT * FROM app.content_document WHERE tenant_id=app.current_tenant() AND id=$1 ${lock ? (lock === "write" ? "FOR UPDATE" : "FOR SHARE") : ""}`,
      [id],
    );
    return result.rows[0];
  }

  async revision(id: string): Promise<RevisionRow | undefined> {
    const result = await this.client.query<RevisionRow>(
      "SELECT * FROM app.content_revision WHERE tenant_id=app.current_tenant() AND id=$1",
      [id],
    );
    return result.rows[0];
  }

  async listSites(after: string | null, limit: number): Promise<SiteRow[]> {
    const result = await this.client.query<SiteRow>(
      "SELECT * FROM app.site WHERE tenant_id=app.current_tenant() AND state IN ('draft','published') AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2 FOR SHARE",
      [after, limit],
    );
    return result.rows;
  }

  async listDocuments(siteId: string, after: string | null, limit: number): Promise<DocumentRow[]> {
    const result = await this.client.query<DocumentRow>(
      "SELECT * FROM app.content_document WHERE tenant_id=app.current_tenant() AND site_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3 FOR SHARE",
      [siteId, after, limit],
    );
    return result.rows;
  }

  async listRevisions(documentId: string, after: string | null, limit: number): Promise<RevisionRow[]> {
    const result = await this.client.query<RevisionRow>(
      "SELECT * FROM app.content_revision WHERE tenant_id=app.current_tenant() AND document_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",
      [documentId, after, limit],
    );
    return result.rows;
  }
  async listRevisionMetadata(
    documentId: string,
    after: string | null,
    limit: number,
  ): Promise<RevisionMetadataRow[]> {
    const result = await this.client.query<RevisionMetadataRow>(
      "SELECT id,document_id,schema_version,created_at FROM app.content_revision WHERE tenant_id=app.current_tenant() AND document_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",
      [documentId, after, limit],
    );
    return result.rows;
  }

  async createSite(profileId: string, name: string, theme: string): Promise<SiteRow> {
    const result = await this.client.query<SiteRow>(
      "INSERT INTO app.site(tenant_id,business_profile_id,name,theme_version) VALUES(app.current_tenant(),$1,$2,$3) RETURNING *",
      [profileId, name, theme],
    );
    return result.rows[0];
  }

  async listDomains(siteId: string): Promise<DomainRow[]> {
    const result = await this.client.query<DomainRow>(
      "SELECT * FROM app.site_domain WHERE tenant_id=app.current_tenant() AND site_id=$1 AND archived_at IS NULL ORDER BY id FOR SHARE",
      [siteId],
    );
    return result.rows;
  }

  async domain(id: string, lock?: Lock): Promise<DomainRow | undefined> {
    const result = await this.client.query<DomainRow>(
      `SELECT * FROM app.site_domain WHERE tenant_id=app.current_tenant() AND id=$1 AND archived_at IS NULL ${lock === "write" ? "FOR UPDATE" : "FOR SHARE"}`,
      [id],
    );
    return result.rows[0];
  }

  async domainByHostname(hostname: string): Promise<DomainRow | undefined> {
    const result = await this.client.query<DomainRow>(
      "SELECT * FROM app.site_domain WHERE hostname=$1 LIMIT 1",
      [hostname],
    );
    return result.rows[0];
  }

  async createDomain(
    siteId: string,
    hostname: string,
    environment: "preview" | "production",
  ): Promise<DomainRow> {
    const result = await this.client.query<DomainRow>(
      "INSERT INTO app.site_domain(tenant_id,site_id,hostname,verification_state,tls_state,environment) VALUES(app.current_tenant(),$1,$2,'pending','pending',$3) RETURNING *",
      [siteId, hostname, environment],
    );
    return result.rows[0];
  }

  async updateDomainVerification(
    id: string,
    verificationState: string,
    tlsState: string,
    nextVersion: number,
  ): Promise<DomainRow | undefined> {
    const result = await this.client.query<DomainRow>(
      "UPDATE app.site_domain SET verification_state=$1,tls_state=$2,row_version=$3,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$4 AND archived_at IS NULL RETURNING *",
      [verificationState, tlsState, nextVersion, id],
    );
    return result.rows[0];
  }

  async archiveDomain(id: string, nextVersion: number): Promise<DomainRow | undefined> {
    const result = await this.client.query<DomainRow>(
      "UPDATE app.site_domain SET archived_at=now(),row_version=$1,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$2 AND archived_at IS NULL RETURNING *",
      [nextVersion, id],
    );
    return result.rows[0];
  }

  async archiveSite(id: string): Promise<SiteRow | undefined> {
    const result = await this.client.query<SiteRow>(
      "SELECT * FROM app.archive_site($1)",
      [id],
    );
    return result.rows[0] ?? undefined;
  }

  /** Atomically archive a document via SECURITY DEFINER (archived_at grant denied to estate_runtime). */
  async archiveDocument(id: string): Promise<DocumentRow | undefined> {
    const result = await this.client.query<DocumentRow>(
      "SELECT * FROM app.archive_document($1)",
      [id],
    );
    const row = result.rows[0];
    return row?.id != null ? row : undefined;
  }

  async updateSite(id: string, name: string, businessProfileId: string, nextVersion: number): Promise<SiteRow | undefined> {
    const result = await this.client.query<SiteRow>(
      "UPDATE app.site SET name=$1,business_profile_id=$2,row_version=$3,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$4 AND row_version=$5 AND state IN ('draft','published') RETURNING *",
      [name, businessProfileId, nextVersion, id, nextVersion - 1],
    );
    return result.rows[0];
  }

  async activeDomainCount(siteId: string): Promise<number> {
    const result = await this.client.query<{ count: string }>(
      "SELECT count(*) FROM app.site_domain WHERE tenant_id=app.current_tenant() AND site_id=$1 AND archived_at IS NULL AND verification_state='verified'",
      [siteId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listMedia(after: string | null, limit: number): Promise<MediaRow[]> {
    const result = await this.client.query<MediaRow>(
      "SELECT * FROM app.media_asset WHERE tenant_id=app.current_tenant() AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2 FOR SHARE",
      [after, limit],
    );
    return result.rows;
  }

  async media(id: string, lock?: Lock): Promise<MediaRow | undefined> {
    const result = await this.client.query<MediaRow>(
      `SELECT * FROM app.media_asset WHERE tenant_id=app.current_tenant() AND id=$1 ${lock === "write" ? "FOR UPDATE" : "FOR SHARE"}`,
      [id],
    );
    return result.rows[0];
  }

  async finalizeMedia(
    id: string,
    checksum: string,
    altText: string | null,
    nextVersion: number,
  ): Promise<MediaRow | undefined> {
    const result = await this.client.query<MediaRow>(
      "UPDATE app.media_asset SET scan_state='clean',content_sha256=$1,alt_text=$2,row_version=$3,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$4 AND scan_state='pending' RETURNING *",
      [checksum, altText, nextVersion, id],
    );
    return result.rows[0];
  }

  async listForms(siteId: string, after: string | null, limit: number): Promise<FormRow[]> {
    // Select the latest version per form name, then paginate by name cursor.
    const result = await this.client.query<FormRow>(
      `SELECT DISTINCT ON (name) * FROM app.form_schema
       WHERE tenant_id=app.current_tenant() AND site_id=$1
         AND ($2::text IS NULL OR name>$2)
       ORDER BY name, version DESC LIMIT $3`,
      [siteId, after, limit],
    );
    return result.rows;
  }

  async form(id: string): Promise<FormRow | undefined> {
    const result = await this.client.query<FormRow>(
      "SELECT * FROM app.form_schema WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
      [id],
    );
    return result.rows[0];
  }

  async createMediaUploadSlot(
    assetId: string,
    mimeType: string,
    byteSize: number,
    purpose: "media" | "contact_import",
  ): Promise<MediaRow> {
    const result = await this.client.query<MediaRow>(
      "INSERT INTO app.media_asset(tenant_id,id,object_key,mime_type,byte_size,scan_state,purpose,rights,upload_expires_at) VALUES(app.current_tenant(),$1,$2,$3,$4,'pending',$5,'{}',now()+interval '1 hour') RETURNING *",
      [assetId, assetId, mimeType, byteSize, purpose],
    );
    return result.rows[0];
  }

  async createForm(siteId: string, name: string, definition: unknown, state: string): Promise<FormRow> {
    const result = await this.client.query<FormRow>(
      "INSERT INTO app.form_schema(tenant_id,site_id,name,version,definition,state) VALUES(app.current_tenant(),$1,$2,1,$3,$4) RETURNING *",
      [siteId, name, JSON.stringify(definition), state],
    );
    return result.rows[0];
  }

  async maxFormVersion(siteId: string, name: string): Promise<number> {
    const result = await this.client.query<{ max: string | null }>(
      "SELECT max(version) FROM app.form_schema WHERE tenant_id=app.current_tenant() AND site_id=$1 AND name=$2",
      [siteId, name],
    );
    return Number(result.rows[0]?.max ?? 0);
  }

  async insertFormVersion(
    siteId: string,
    name: string,
    version: number,
    definition: unknown,
    state: string,
  ): Promise<FormRow> {
    const result = await this.client.query<FormRow>(
      "INSERT INTO app.form_schema(tenant_id,site_id,name,version,definition,state) VALUES(app.current_tenant(),$1,$2,$3,$4,$5) RETURNING *",
      [siteId, name, version, JSON.stringify(definition), state],
    );
    return result.rows[0];
  }

  async createDocument(
    siteId: string,
    slug: string,
    kind: DocumentRow["kind"],
    title: string,
  ): Promise<DocumentRow> {
    const result = await this.client.query<DocumentRow>(
      "INSERT INTO app.content_document(tenant_id,site_id,slug,kind,title) VALUES(app.current_tenant(),$1,$2,$3,$4) RETURNING *",
      [siteId, slug, kind, title],
    );
    return result.rows[0];
  }

  async updateDocument(
    current: DocumentRow,
    nextVersion: number,
    body?: { slug: string; kind: DocumentRow["kind"]; title: string },
  ): Promise<DocumentRow> {
    const result = await this.client.query<DocumentRow>(
      "UPDATE app.content_document SET slug=$1,kind=$2,title=$3,row_version=$4,updated_at=now() WHERE tenant_id=app.current_tenant() AND id=$5 AND row_version=$6 AND archived_at IS NULL RETURNING *",
      [
        body?.slug ?? current.slug,
        body?.kind ?? current.kind,
        body?.title ?? current.title,
        nextVersion,
        current.id,
        current.row_version,
      ],
    );
    if (!result.rowCount)
      throw new AccessError(
        412,
        "revision_changed",
        "The document changed. Keep the unsaved draft and reload.",
      );
    return result.rows[0];
  }

  /** Atomically set published_revision_id via SECURITY DEFINER (direct UPDATE grant remains denied).
   * Composite-returning PG functions yield a null-field row (not 0 rows) when the WHERE finds no match;
   * we check id!=null to distinguish a real update from the null-composite no-op. */
  async setPublishedRevision(
    documentId: string,
    revisionId: string,
    expectedVersion: number,
  ): Promise<DocumentRow | undefined> {
    const result = await this.client.query<DocumentRow>(
      "SELECT * FROM app.publish_document($1, $2, $3)",
      [documentId, revisionId, expectedVersion],
    );
    const row = result.rows[0];
    return row?.id != null ? row : undefined;
  }

  async insertRevision(plan: DraftAppendPlan, authorMemberId: string): Promise<RevisionRow> {
    const result = await this.client.query<RevisionRow>(
      "INSERT INTO app.content_revision(tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash) VALUES(app.current_tenant(),$1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [
        plan.revision.id,
        plan.insert.document_id,
        authorMemberId,
        plan.insert.schema_version,
        JSON.stringify(plan.insert.block_data),
        JSON.stringify(plan.insert.seo),
        plan.insert.content_hash,
      ],
    );
    return result.rows[0];
  }
}
