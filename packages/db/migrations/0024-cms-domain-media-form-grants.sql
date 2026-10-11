-- ADR-053 forward0024: runtime grants for CMS domain, media and form tables.
-- Requires 0001–0023. app.site_domain had no prior runtime grants.
-- app.form_schema received SELECT in 0023; this adds write grants.
BEGIN;

-- Add archived_at for soft-delete support on domains.
ALTER TABLE app.site_domain ADD COLUMN archived_at timestamptz;

-- Extend app.site to allow the archived lifecycle state.
-- The inline CHECK was created without a name; find and drop it dynamically.
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'app.site'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%draft%publishing%published%suspended%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app.site DROP CONSTRAINT %I', cname);
  END IF;
END;
$$;
ALTER TABLE app.site ADD CONSTRAINT site_state_check
  CHECK (state IN ('draft','publishing','published','suspended','archived'));

-- Extend media_asset update grant to include alt_text (finalize needs it).
GRANT UPDATE(alt_text) ON app.media_asset TO estate_runtime;

-- Site: runtime archives sites via a SECURITY DEFINER function to avoid widening
-- direct UPDATE grants (which would break the immutable-history invariant test).
CREATE OR REPLACE FUNCTION app.archive_site(p_site_id uuid)
  RETURNS app.site LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result app.site;
BEGIN
  UPDATE app.site
     SET state='archived', updated_at=now(), row_version=row_version+1
   WHERE tenant_id=app.current_tenant()
     AND id=p_site_id
     AND state != 'archived'
  RETURNING * INTO result;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION app.archive_site(uuid) TO estate_runtime;

-- Domains: runtime creates, reads and archives domain records.
GRANT SELECT, INSERT, UPDATE ON app.site_domain TO estate_runtime;

-- Form schemas: runtime creates and publishes versions (SELECT already in 0023).
GRANT INSERT, UPDATE ON app.form_schema TO estate_runtime;

COMMIT;
