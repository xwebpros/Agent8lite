-- Reviewed ADR-057 grants: document archive (SECURITY DEFINER) and site name/profile update column grants.
-- archived_at on content_document is denied to estate_runtime (like published_revision_id);
-- a SECURITY DEFINER function is the only path to soft-delete a document.
-- name/business_profile_id/updated_at on site are ordinary business fields; column-level grants suffice.
BEGIN;

CREATE OR REPLACE FUNCTION app.archive_document(
  p_document_id uuid
)
RETURNS app.content_document LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result app.content_document;
BEGIN
  UPDATE app.content_document
     SET archived_at  = now(),
         row_version  = row_version + 1,
         updated_at   = now()
   WHERE tenant_id    = app.current_tenant()
     AND id           = p_document_id
     AND archived_at  IS NULL
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION app.archive_document(uuid) TO estate_runtime;

-- updateSite: allow business-field mutations (name, business_profile_id) via estate_runtime.
-- state, published_at, and theme_version remain excluded from direct runtime UPDATE.
GRANT UPDATE (name, business_profile_id, updated_at) ON app.site TO estate_runtime;

COMMIT;
