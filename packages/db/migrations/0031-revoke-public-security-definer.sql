-- Revoke default PUBLIC execute on SECURITY DEFINER functions from 0023–0027.
-- PostgreSQL grants EXECUTE to PUBLIC by default; these functions run with
-- elevated privileges, so only estate_runtime should be able to call them.
BEGIN;

REVOKE ALL ON FUNCTION app.resolve_published_site(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.archive_site(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_document(uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.archive_document(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.publish_campaign_version(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.archive_campaign(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.resolve_published_site(uuid) TO estate_runtime;
GRANT EXECUTE ON FUNCTION app.archive_site(uuid) TO estate_runtime;
GRANT EXECUTE ON FUNCTION app.publish_document(uuid, uuid, bigint) TO estate_runtime;
GRANT EXECUTE ON FUNCTION app.archive_document(uuid) TO estate_runtime;
GRANT EXECUTE ON FUNCTION app.publish_campaign_version(uuid, uuid) TO estate_runtime;
GRANT EXECUTE ON FUNCTION app.archive_campaign(uuid) TO estate_runtime;

COMMIT;
