-- ADR-052 forward0023: security-definer helper for public site resolution.
-- Requires 0001. The runtime role cannot query app.site without a tenant
-- context because RLS requires app.current_tenant() to be set first.
-- This function runs with the migration-role's privileges (BYPASSRLS) and
-- returns the tenant_id for a published site, bootstrapping tenant context.
BEGIN;

CREATE OR REPLACE FUNCTION app.resolve_published_site(p_site_id uuid)
  RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  AS $$
    SELECT tenant_id FROM app.site WHERE id = p_site_id AND state = 'published' LIMIT 1
  $$;

REVOKE EXECUTE ON FUNCTION app.resolve_published_site(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_published_site(uuid) TO estate_runtime;

COMMIT;
