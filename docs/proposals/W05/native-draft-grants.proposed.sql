-- REVIEW ONLY: outside packages/db/migrations; not run by W05.
-- Coordinator assigns a forward migration sequence after review and disposable DB acceptance.
BEGIN;

ALTER TABLE app.site ALTER COLUMN state SET DEFAULT 'draft';

GRANT SELECT ON app.site,app.content_document,app.content_revision TO estate_runtime;
GRANT INSERT (tenant_id,id,business_profile_id,name,theme_version)
  ON app.site TO estate_runtime;
GRANT INSERT (tenant_id,id,site_id,slug,kind,title)
  ON app.content_document TO estate_runtime;
GRANT INSERT (tenant_id,id,document_id,author_member_id,schema_version,block_data,seo,content_hash)
  ON app.content_revision TO estate_runtime;
GRANT UPDATE (slug,kind,title,row_version,updated_at)
  ON app.content_document TO estate_runtime;
-- No site state/publication timestamp, document publication pointer, archive,
-- history mutation, worker, domain, media or form grants in the bounded slice.
REVOKE UPDATE,DELETE ON app.content_revision FROM estate_runtime,estate_worker;

CREATE FUNCTION app.reject_content_revision_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Content revisions are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER content_revision_immutable
  BEFORE UPDATE OR DELETE ON app.content_revision
  FOR EACH ROW EXECUTE FUNCTION app.reject_content_revision_mutation();

COMMIT;
