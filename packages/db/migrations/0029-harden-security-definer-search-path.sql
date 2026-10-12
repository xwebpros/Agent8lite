-- Harden all SECURITY DEFINER functions from 0023–0027 with SET search_path.
-- Without an explicit search_path, a caller could manipulate the session's
-- search_path to redirect unqualified table references inside definer context.
BEGIN;

-- 0023: resolve_published_site
ALTER FUNCTION app.resolve_published_site(uuid) SET search_path = pg_catalog, app;

-- 0024: archive_site
ALTER FUNCTION app.archive_site(uuid) SET search_path = pg_catalog, app;

-- 0025: publish_document
ALTER FUNCTION app.publish_document(uuid, uuid, bigint) SET search_path = pg_catalog, app;

-- 0026: archive_document
ALTER FUNCTION app.archive_document(uuid) SET search_path = pg_catalog, app;

-- 0027: publish_campaign_version, archive_campaign
ALTER FUNCTION app.publish_campaign_version(uuid, uuid) SET search_path = pg_catalog, app;
ALTER FUNCTION app.archive_campaign(uuid) SET search_path = pg_catalog, app;

COMMIT;
