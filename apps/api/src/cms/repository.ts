import type { PoolClient } from "pg";
import type { DraftAppendPlan } from "../../../../packages/cms";
import { AccessError } from "../../../../packages/db/tenant-transaction";

type Lock = "read" | "write";
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

  async createSite(profileId: string, name: string, theme: string): Promise<SiteRow> {
    const result = await this.client.query<SiteRow>(
      "INSERT INTO app.site(tenant_id,business_profile_id,name,theme_version) VALUES(app.current_tenant(),$1,$2,$3) RETURNING *",
      [profileId, name, theme],
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
