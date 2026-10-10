-- Reviewed ADR-021 native campaign draft metadata prerequisite.
-- Candidate c254ea5017f9a346bca6d4fb7a7ab1aa3aa14546487f55570f51fe88f0f3ba92
-- passed13 actual-login policy probe groups before consumers.
BEGIN;

GRANT SELECT ON app.campaign TO estate_runtime;
GRANT INSERT(tenant_id,id,name,category,state) ON app.campaign TO estate_runtime;
GRANT UPDATE(name,category,row_version,updated_at) ON app.campaign TO estate_runtime;

-- Restrictive guards compose with the existing verified tenant policy.
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

-- No lifecycle/state, workflow version, enrollment, schedule, provider,
-- deletion, worker, control or issuer authority is introduced.
COMMIT;
