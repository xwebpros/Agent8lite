import type { Pool, PoolClient } from "pg";
import type { components } from "../../../../packages/contracts/generated/api";
import { AccessError } from "../../../../packages/db/tenant-transaction";

export interface IdxTemplateBindingRow {
  id: string;
  tenant_id: string;
  site_id: string;
  origin: string;
  domain_id: string | null;
  document_id: string;
  form_id: string;
  source_id: string;
  capture_member_id: string;
  business_profile_id: string;
  agent_member_id: string | null;
  brokerage_office_id: string | null;
  feed_id: string;
  template_code: "las-vegas-idx-agent" | "las-vegas-idx-brokerage";
  template_version: string;
  mode: "mock" | "live";
  policy_version: string;
  policy_sha256: string;
  policy_expires_at: Date;
  state: string;
  expires_at: Date;
  row_version: string;
  site_state: string;
  site_theme_version: string;
  site_profile_id: string;
  document_site_id: string;
  document_archived_at: Date | null;
  published_revision_id: string;
  form_site_id: string;
  form_state: string;
  form_version: number;
  form_definition: unknown;
  capture_user_id: string;
  capture_status: string;
  capture_issuer: string;
  capture_subject: string;
}

export interface IdxFeedRow {
  id: string;
  mode: string;
  transport: string;
  state: string;
  display_policy: unknown;
  native_rights: unknown;
  policy_approved_at: Date | null;
  row_version: string;
  connection_id: string;
  connection_provider: string;
  connection_mode: string;
  connection_state: string;
  connection_secret_ref: string | null;
  connection_config: unknown;
}

export interface IdxListingRow {
  source_listing_key: string;
  source_listing_id: string | null;
  status: string;
  display_allowed: boolean;
  address_display_allowed: boolean;
  withdrawn_at: Date | null;
  expires_at: Date;
  ingested_at: Date | null;
  synthetic: boolean;
  row_version: string;
}

/** Bootstrap contains no request-provided tenant/member or human role selection. */
export async function resolveIdxTemplateBinding(pool: Pool, siteId: string, origin: string) {
  const result = await pool.query<{
    binding_id: string;
    tenant_id: string;
    capture_user_id: string;
    binding_version: string;
  }>("SELECT * FROM app.resolve_idx_template_binding($1::uuid,$2::text)", [siteId, origin]);
  if (result.rowCount !== 1)
    throw new AccessError(404, "idx_site_unavailable", "The published site is unavailable.");
  return result.rows[0];
}

/** Bound to the caller's verified tenant transaction; does not commit or dispatch. */
export class IdxTemplateRepository {
  constructor(readonly client: PoolClient) {}

  async binding(bindingId: string): Promise<IdxTemplateBindingRow | undefined> {
    const result = await this.client.query<IdxTemplateBindingRow>(
      `SELECT b.*,s.state AS site_state,s.theme_version AS site_theme_version,
       s.business_profile_id AS site_profile_id,d.site_id AS document_site_id,
       d.archived_at AS document_archived_at,d.published_revision_id,
       f.site_id AS form_site_id,f.state AS form_state,f.version AS form_version,f.definition AS form_definition,
       m.user_id AS capture_user_id,m.status AS capture_status,u.issuer AS capture_issuer,u.subject AS capture_subject
       FROM app.idx_template_binding b
       JOIN app.site s ON (s.tenant_id,s.id)=(b.tenant_id,b.site_id)
       JOIN app.content_document d ON (d.tenant_id,d.id)=(b.tenant_id,b.document_id)
       JOIN app.form_schema f ON (f.tenant_id,f.id)=(b.tenant_id,b.form_id)
       JOIN app.lead_source source ON (source.tenant_id,source.id)=(b.tenant_id,b.source_id)
       JOIN app.business_profile profile ON (profile.tenant_id,profile.id)=(b.tenant_id,b.business_profile_id)
       JOIN app.membership m ON (m.tenant_id,m.id)=(b.tenant_id,b.capture_member_id)
       JOIN app.user_identity u ON u.id=m.user_id
       WHERE b.tenant_id=app.current_tenant() AND b.id=$1
       FOR SHARE OF b,s,d,f,source,profile,m,u`,
      [bindingId],
    );
    return result.rows[0];
  }

  async domain(id: string) {
    const result = await this.client.query<{
      site_id: string;
      hostname: string;
      archived_at: Date | null;
      verification_state: string;
      tls_state: string;
    }>(
      "SELECT site_id,hostname,archived_at,verification_state,tls_state FROM app.site_domain WHERE tenant_id=app.current_tenant() AND id=$1 FOR SHARE",
      [id],
    );
    return result.rows[0];
  }

  async revision(
    id: string,
    documentId: string,
  ): Promise<components["schemas"]["RevisionWrite"] | undefined> {
    // Immutable revisions have no runtime UPDATE/DELETE; no lock privilege is broadened.
    const result = await this.client.query<{
      schema_version: number;
      block_data: components["schemas"]["Block"][];
      seo: components["schemas"]["Seo"];
    }>(
      "SELECT schema_version,block_data,seo FROM app.content_revision WHERE tenant_id=app.current_tenant() AND id=$1 AND document_id=$2",
      [id, documentId],
    );
    const row = result.rows[0];
    return row ? { schemaVersion: row.schema_version, blocks: row.block_data, seo: row.seo } : undefined;
  }

  async feed(id: string): Promise<IdxFeedRow | undefined> {
    const result = await this.client.query<IdxFeedRow>(
      `SELECT f.*,c.provider AS connection_provider,c.mode AS connection_mode,c.state AS connection_state,
       c.secret_ref AS connection_secret_ref,c.safe_config AS connection_config
       FROM app.mls_feed f JOIN app.integration_connection c ON (c.tenant_id,c.id)=(f.tenant_id,f.connection_id)
       WHERE f.tenant_id=app.current_tenant() AND f.id=$1 FOR SHARE OF f,c`,
      [id],
    );
    return result.rows[0];
  }

  async listing(feedId: string, key: string): Promise<IdxListingRow | undefined> {
    const result = await this.client.query<IdxListingRow>(
      `SELECT source_listing_key,source_listing_id,status,display_allowed,address_display_allowed,withdrawn_at,expires_at,ingested_at,synthetic,row_version
       FROM app.listing WHERE tenant_id=app.current_tenant() AND feed_id=$1 AND source_listing_key=$2 FOR SHARE`,
      [feedId, key],
    );
    if (result.rowCount! > 1)
      throw new AccessError(503, "listing_source_ambiguous", "The listing source is unavailable.");
    return result.rows[0];
  }

  async listingAssignment(bindingId: string, feedId: string, key: string, policy: string) {
    const result = await this.client.query<{ member_id: string; office_id: string | null; expires_at: Date }>(
      `SELECT member_id,office_id,expires_at FROM app.idx_template_listing_assignment
       WHERE tenant_id=app.current_tenant() AND binding_id=$1 AND feed_id=$2 AND source_listing_key=$3
       AND policy_version=$4 AND state='active' FOR SHARE`,
      [bindingId, feedId, key, policy],
    );
    return result.rows[0];
  }

  async member(id: string, officeId: string | null) {
    const rows = await this.client.query<{
      id: string;
      permission_grants: Array<{ code: string; scope: string }>;
    }>(
      `SELECT m.id,r.permission_grants FROM app.membership m JOIN app.role_definition r
       ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
       WHERE m.tenant_id=app.current_tenant() AND m.id=$1 AND m.status='active' FOR SHARE OF m,r`,
      [id],
    );
    const row = rows.rows[0];
    if (!row) return false;
    if (
      !["crm.leads.read", "crm.leads.write"].every((code) =>
        row.permission_grants.some(
          (grant) => grant.code === code && ["own", "team", "organization"].includes(grant.scope),
        ),
      )
    )
      return false;
    if (
      officeId ||
      row.permission_grants.some(
        (grant) => ["crm.leads.read", "crm.leads.write"].includes(grant.code) && grant.scope === "team",
      )
    ) {
      const office = await this.client.query(
        `SELECT om.member_id FROM app.office_member om JOIN app.office o ON (o.tenant_id,o.id)=(om.tenant_id,om.office_id)
         WHERE om.tenant_id=app.current_tenant() AND om.member_id=$1 AND ($2::uuid IS NULL OR om.office_id=$2) FOR SHARE OF om,o`,
        [id, officeId],
      );
      if (!office.rowCount) return false;
    }
    return true;
  }

  async now(): Promise<Date> {
    const row = (await this.client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0];
    if (!(row?.now instanceof Date) || !Number.isFinite(row.now.getTime()))
      throw new AccessError(503, "idx_clock_unavailable", "The site clock is unavailable.");
    return row.now;
  }

  async receipt(actor: string, route: string, key: string) {
    const result = await this.client.query<{
      request_hash: string;
      response_body: unknown;
      expires_at: Date;
    }>(
      "SELECT request_hash,response_body,expires_at FROM app.idempotency_record WHERE tenant_id=app.current_tenant() AND actor_ref=$1 AND route_key=$2 AND key=$3",
      [actor, route, key],
    );
    return result.rows[0];
  }

  async saveReceipt(
    actor: string,
    route: string,
    key: string,
    hash: string,
    body: components["schemas"]["SubmissionReceipt"],
  ) {
    await this.client.query(
      `INSERT INTO app.idempotency_record(tenant_id,actor_ref,route_key,key,request_hash,response_body,status_code,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,$5,200,'infinity'::timestamptz)`,
      [actor, route, key, hash, JSON.stringify(body)],
    );
  }

  async saveEntry(formId: string, leadId: string, key: string, payload: unknown): Promise<string> {
    const row = (
      await this.client.query<{ id: string }>(
        `INSERT INTO app.form_entry(tenant_id,form_schema_id,lead_id,submission_key,private_payload,expires_at)
       VALUES(app.current_tenant(),$1,$2,$3,$4,clock_timestamp()+interval '90 days') RETURNING id`,
        [formId, leadId, key, JSON.stringify(payload)],
      )
    ).rows[0];
    return row.id;
  }
}
