-- Candidate only: the shared migration owner reviews/promotes this before consumers.
-- Native metadata only. No campaign-version, publication, enrollment, schedule,
-- delivery, sender readiness or worker authority is introduced.
GRANT SELECT ON app.campaign TO estate_runtime;
GRANT INSERT(tenant_id,id,name,category,state) ON app.campaign TO estate_runtime;
GRANT UPDATE(name,category,row_version,updated_at) ON app.campaign TO estate_runtime;

-- Existing tenant_scope remains the permissive tenant boundary. These restrictive
-- policies prevent a future permissive policy from enabling non-draft mutation.
CREATE POLICY runtime_campaign_draft_select ON app.campaign
  AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND state='draft');
CREATE POLICY runtime_campaign_draft_insert ON app.campaign
  AS RESTRICTIVE FOR INSERT TO estate_runtime
  WITH CHECK (tenant_id=app.current_tenant() AND state='draft');
CREATE POLICY runtime_campaign_draft_update ON app.campaign
  AS RESTRICTIVE FOR UPDATE TO estate_runtime
  USING (tenant_id=app.current_tenant() AND state='draft')
  WITH CHECK (tenant_id=app.current_tenant() AND state='draft');
