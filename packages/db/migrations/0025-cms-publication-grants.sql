-- Reviewed CMS document publication grants for estate_runtime (ADR-055 / MOD-C-003).
-- Direct UPDATE(published_revision_id) on content_document is kept denied for estate_runtime
-- to preserve the immutable-history security invariant (42501 test at line 633 of native-drafts).
-- Instead we use a SECURITY DEFINER function so the pointer can only move via validated command.
BEGIN;

CREATE OR REPLACE FUNCTION app.publish_document(
  p_document_id uuid,
  p_revision_id uuid,
  p_expected_version bigint
)
RETURNS app.content_document LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result app.content_document;
BEGIN
  UPDATE app.content_document
     SET published_revision_id = p_revision_id,
         row_version            = p_expected_version + 1,
         updated_at             = now()
   WHERE tenant_id   = app.current_tenant()
     AND id          = p_document_id
     AND row_version = p_expected_version
     AND archived_at IS NULL
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION app.publish_document(uuid, uuid, bigint) TO estate_runtime;

COMMIT;
