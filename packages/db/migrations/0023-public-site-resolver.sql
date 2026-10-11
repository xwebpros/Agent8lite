-- ADR-052 forward0023: public site runtime grants and security-definer resolver.
-- Requires 0001–0022. Grants SELECT/write on public-site tables that have never
-- been used by the runtime before and therefore had no runtime GRANTs.
BEGIN;

-- SELECT grant for app.site so the runtime can read published site config.
GRANT SELECT ON app.site TO estate_runtime;

-- Form schema and entries: runtime needs to read the schema and insert entries.
GRANT SELECT ON app.form_schema TO estate_runtime;
GRANT SELECT, INSERT ON app.form_entry TO estate_runtime;

-- Visitor identity: runtime creates, reads and updates challenge/verified records.
GRANT SELECT, INSERT, UPDATE ON app.visitor_identity TO estate_runtime;

-- Saved searches and favorites: runtime reads and writes visitor preferences.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.saved_search TO estate_runtime;
GRANT SELECT, INSERT, DELETE ON app.favorite TO estate_runtime;

-- SECURITY DEFINER helper to resolve a published site's tenant_id before the
-- tenant context is established. The runtime role cannot query app.site directly
-- via RLS (app.current_tenant() is NULL at that point); this function runs as its
-- owner (postgres, who has BYPASSRLS) and returns only the tenant_id.
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
