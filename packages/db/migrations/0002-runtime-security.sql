BEGIN;
-- Reviewed additive implementation corrections. Baseline contract/schema stays frozen.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='estate_runtime') THEN
    CREATE ROLE estate_runtime LOGIN PASSWORD 'local-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='estate_worker') THEN
    CREATE ROLE estate_worker LOGIN PASSWORD 'local-worker-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE estate_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE estate_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT USAGE ON SCHEMA app TO estate_runtime,estate_worker;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER TABLE app.user_identity ADD COLUMN phone text, ADD COLUMN timezone text NOT NULL DEFAULT 'America/Los_Angeles';
ALTER TABLE app.contact ADD COLUMN created_by_member_id uuid;
ALTER TABLE app.contact ADD FOREIGN KEY (tenant_id,created_by_member_id) REFERENCES app.membership(tenant_id,id);
ALTER TABLE app.contact_channel ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE app.idempotency_record ADD COLUMN response_body jsonb, ADD COLUMN status_code integer;
ALTER TABLE app.outbox ADD COLUMN initiating_actor_id uuid REFERENCES app.user_identity(id);
CREATE POLICY own_membership_lookup ON app.membership FOR SELECT USING (user_id=app.current_actor());
CREATE TABLE app.login_session (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES app.user_identity(id),
 active_org_id uuid NOT NULL REFERENCES app.organization(id),
 csrf_token text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.login_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.login_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_token_read ON app.login_session FOR SELECT USING (token_hash=current_setting('app.session_hash',true));
CREATE POLICY session_actor_insert ON app.login_session FOR INSERT WITH CHECK (user_id=app.current_actor());
CREATE POLICY session_token_update ON app.login_session FOR UPDATE USING (token_hash=current_setting('app.session_hash',true)) WITH CHECK (token_hash=current_setting('app.session_hash',true));
CREATE POLICY session_token_delete ON app.login_session FOR DELETE USING (token_hash=current_setting('app.session_hash',true));
GRANT SELECT ON app.organization,app.user_identity,app.role_definition,app.membership,app.office,app.office_member,app.business_profile,app.entitlement,app.integration_connection,app.lead_source,app.pipeline_stage,app.contact,app.contact_channel,app.lead,app.task,app.note,app.activity_event,app.stage_transition,app.audit_event,app.outbox,app.idempotency_record,app.member_invitation TO estate_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.login_session TO estate_runtime;
GRANT INSERT,UPDATE ON app.contact,app.contact_channel,app.lead,app.task,app.idempotency_record,app.membership TO estate_runtime;
GRANT UPDATE (display_name,phone,timezone,updated_at,row_version) ON app.user_identity TO estate_runtime;
GRANT INSERT ON app.note,app.activity_event,app.stage_transition,app.audit_event,app.outbox,app.member_invitation TO estate_runtime;
GRANT SELECT ON app.membership,app.role_definition,app.organization,app.outbox,app.integration_connection,app.entitlement TO estate_worker;
GRANT UPDATE (published_at,lease_until,attempt_count,updated_at,row_version) ON app.outbox TO estate_worker;
GRANT INSERT ON app.audit_event TO estate_worker;
CREATE INDEX idx_contact_creator ON app.contact(tenant_id,created_by_member_id);
CREATE INDEX idx_session_expiry ON app.login_session(expires_at);
COMMIT;
