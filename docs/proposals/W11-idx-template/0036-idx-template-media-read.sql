-- ADR-061: current tenant media projection and read locks, no runtime mutations.
BEGIN;
GRANT SELECT (tenant_id,id,listing_id,source_url,position,expires_at) ON app.listing_media TO estate_runtime;
GRANT UPDATE (row_version) ON app.listing_media TO estate_runtime;
CREATE POLICY idx_template_media_read_lock ON app.listing_media
  AS RESTRICTIVE FOR UPDATE TO estate_runtime
  USING (tenant_id=app.current_tenant()) WITH CHECK (false);
COMMENT ON POLICY idx_template_media_read_lock ON app.listing_media IS
  'Permits tenant read locks for policy-aware IDX projection; all runtime updates remain denied.';
DO $$ BEGIN RAISE EXCEPTION 'Unreviewed IDX media grant candidate' USING ERRCODE='55000'; END $$;
ROLLBACK;
