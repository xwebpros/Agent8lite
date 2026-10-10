-- Reviewed additive synthetic capture ledger and serialized routing distribution.
BEGIN;
CREATE TABLE app.crm_routing_state (
  tenant_id uuid PRIMARY KEY REFERENCES app.organization(id),
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.routing_distribution (
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  next_sequence bigint NOT NULL DEFAULT 0 CHECK(next_sequence>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,rule_id),
  FOREIGN KEY(tenant_id,rule_id) REFERENCES app.routing_rule(tenant_id,id)
);
CREATE TABLE app.capture_decision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  source_submission_id uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  lead_id uuid NOT NULL,
  winning_rule_id uuid,
  safe_reason_codes jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(safe_reason_codes)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,source_id,source_submission_id),
  FOREIGN KEY(tenant_id,source_id) REFERENCES app.lead_source(tenant_id,id),
  FOREIGN KEY(tenant_id,lead_id) REFERENCES app.lead(tenant_id,id),
  FOREIGN KEY(tenant_id,winning_rule_id) REFERENCES app.routing_rule(tenant_id,id)
);
ALTER TABLE app.crm_routing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.crm_routing_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.crm_routing_state USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
ALTER TABLE app.routing_distribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routing_distribution FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.routing_distribution USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
ALTER TABLE app.capture_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.capture_decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.capture_decision USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
INSERT INTO app.crm_routing_state(tenant_id) SELECT id FROM app.organization;
GRANT SELECT,INSERT ON app.crm_routing_state,app.routing_distribution,app.capture_decision,app.routing_rule TO estate_runtime;
GRANT UPDATE(row_version,updated_at) ON app.crm_routing_state TO estate_runtime;
GRANT UPDATE(next_sequence,updated_at) ON app.routing_distribution TO estate_runtime;
GRANT UPDATE(priority,enabled,condition,assignment,row_version,updated_at) ON app.routing_rule TO estate_runtime;
COMMIT;
