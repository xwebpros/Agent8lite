-- ADR-023 bounded immutable workflow draft prerequisite; candidate before consumers.
BEGIN;

GRANT SELECT ON app.campaign_version TO estate_runtime;
GRANT INSERT(tenant_id,id,campaign_id,version,definition,state) ON app.campaign_version TO estate_runtime;
REVOKE UPDATE,DELETE ON app.campaign_version FROM estate_runtime,estate_worker;

CREATE POLICY runtime_workflow_draft_select ON app.campaign_version
  AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND state='draft' AND published_at IS NULL
    AND EXISTS (SELECT 1 FROM app.campaign c WHERE c.tenant_id=app.current_tenant()
      AND c.id=campaign_id AND c.state='draft'));
CREATE POLICY runtime_workflow_draft_insert ON app.campaign_version
  AS RESTRICTIVE FOR INSERT TO estate_runtime
  WITH CHECK (tenant_id=app.current_tenant() AND state='draft' AND published_at IS NULL
    AND row_version=1 AND EXISTS (SELECT 1 FROM app.campaign c
      WHERE c.tenant_id=app.current_tenant() AND c.id=campaign_id AND c.state='draft'));

CREATE FUNCTION app.reject_campaign_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Campaign versions are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER campaign_version_immutable
  BEFORE UPDATE OR DELETE ON app.campaign_version
  FOR EACH ROW EXECUTE FUNCTION app.reject_campaign_version_mutation();

-- PostgreSQL FOR SHARE requires an UPDATE column privilege; no content writes.
GRANT SELECT ON app.message_design TO estate_runtime;
GRANT UPDATE(row_version) ON app.message_design TO estate_runtime;
CREATE POLICY runtime_workflow_design_source ON app.message_design
  AS RESTRICTIVE TO estate_runtime
  USING (tenant_id=app.current_tenant()) WITH CHECK (false);

-- No campaign lifecycle, steps, enrollment, schedules, sender, worker or delivery grants.
COMMIT;
