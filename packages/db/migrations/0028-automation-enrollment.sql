-- ADR-060 automation rules and lead enrollment runtime access.
-- Tables already exist from the blueprint (0001). This migration adds:
--   - version tracking columns needed for optimistic locking and ETags
--   - current_step column for enrollment progress tracking
--   - RESTRICTIVE RLS policies scoped to estate_runtime
--   - Column-level GRANT privileges for estate_runtime
BEGIN;

ALTER TABLE app.automation_rule ADD COLUMN IF NOT EXISTS
  version int NOT NULL DEFAULT 1 CHECK (version >= 1);

ALTER TABLE app.enrollment ADD COLUMN IF NOT EXISTS
  current_step text CHECK (char_length(current_step) <= 64);
ALTER TABLE app.enrollment ADD COLUMN IF NOT EXISTS
  version int NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE POLICY runtime_automation_select ON app.automation_rule
  AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id = app.current_tenant());

CREATE POLICY runtime_automation_insert ON app.automation_rule
  AS RESTRICTIVE FOR INSERT TO estate_runtime
  WITH CHECK (tenant_id = app.current_tenant());

CREATE POLICY runtime_automation_update ON app.automation_rule
  AS RESTRICTIVE FOR UPDATE TO estate_runtime
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

CREATE POLICY runtime_enrollment_select ON app.enrollment
  AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id = app.current_tenant());

CREATE POLICY runtime_enrollment_insert ON app.enrollment
  AS RESTRICTIVE FOR INSERT TO estate_runtime
  WITH CHECK (tenant_id = app.current_tenant() AND state = 'active');

CREATE POLICY runtime_enrollment_cancel ON app.enrollment
  AS RESTRICTIVE FOR UPDATE TO estate_runtime
  USING (tenant_id = app.current_tenant() AND state NOT IN ('completed','cancelled'))
  WITH CHECK (tenant_id = app.current_tenant() AND state = 'cancelled');

GRANT SELECT, INSERT ON app.automation_rule TO estate_runtime;
GRANT UPDATE(name, trigger_type, condition, campaign_version_id, restart_policy,
             inactivity_seconds, active, version, row_version, updated_at)
  ON app.automation_rule TO estate_runtime;

GRANT SELECT, INSERT ON app.enrollment TO estate_runtime;
GRANT UPDATE(state, current_step, version, row_version, updated_at)
  ON app.enrollment TO estate_runtime;

COMMIT;
