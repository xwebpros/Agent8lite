-- Reviewed MOD-A control identity, reasoned support and claimed provisioning boundaries; see ADR-017.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='estate_control')THEN
    CREATE ROLE estate_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='estate_staff_issuer')THEN
    CREATE ROLE estate_staff_issuer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE estate_control NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
ALTER ROLE estate_staff_issuer NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
-- No password here. Only reviewed local bootstrap/deployment tooling configures this distinct identity.
GRANT USAGE ON SCHEMA app TO estate_control;
GRANT SELECT ON app.staff_principal,app.plan TO estate_control;
GRANT SELECT(id,issuer,subject,display_name,email_verified,row_version)ON app.user_identity TO estate_control;
GRANT UPDATE(row_version)ON app.staff_principal TO estate_control;
GRANT USAGE ON SCHEMA app TO estate_staff_issuer;
-- The identity issuance pool is distinct from every request/control/worker pool. NOINHERIT alone
-- is insufficient: a membership can still permit SET ROLE, so reject cross-boundary ancestry.
DO $$ BEGIN
  IF EXISTS(
    WITH RECURSIVE reachable AS (
      SELECT oid AS login_oid,oid FROM pg_roles WHERE rolname IN('estate_runtime','estate_worker','estate_control','estate_staff_issuer')
      UNION
      SELECT reachable.login_oid,membership.roleid FROM reachable JOIN pg_auth_members membership ON membership.member=reachable.oid
    )
    SELECT 1 FROM reachable JOIN pg_roles login_role ON login_role.oid=reachable.login_oid JOIN pg_roles granted_role ON granted_role.oid=reachable.oid
    WHERE login_role.rolname<>granted_role.rolname
      AND((login_role.rolname IN('estate_runtime','estate_worker','estate_control')AND granted_role.rolname='estate_staff_issuer')
        OR(login_role.rolname='estate_staff_issuer'AND granted_role.rolname IN('estate_runtime','estate_worker','estate_control'))
        OR(login_role.rolname IN('estate_runtime','estate_worker')AND granted_role.rolname='estate_control')
        OR(login_role.rolname='estate_control'AND granted_role.rolname IN('estate_runtime','estate_worker')))
  )THEN RAISE EXCEPTION 'Control identity role separation is required'; END IF;
END $$;
-- Existing identity policies contain membership subqueries. Keep those away from the issuer,
-- which must never receive tenant-table reads merely to resolve verified issuer/subject claims.
ALTER POLICY identity_read ON app.user_identity TO estate_runtime,estate_worker,estate_control;
ALTER POLICY identity_write ON app.user_identity TO estate_runtime,estate_worker;
CREATE POLICY issuer_verified_identity_read ON app.user_identity FOR SELECT TO estate_staff_issuer USING(
  issuer=current_setting('app.auth_issuer',true)AND subject=current_setting('app.auth_subject',true)AND email_verified);
CREATE POLICY issuer_verified_identity_guard ON app.user_identity AS RESTRICTIVE FOR SELECT TO estate_staff_issuer USING(
  issuer=current_setting('app.auth_issuer',true)AND subject=current_setting('app.auth_subject',true)AND email_verified);
GRANT SELECT(id,issuer,subject,email_verified,row_version)ON app.user_identity TO estate_staff_issuer;
GRANT SELECT(id,user_id,active,row_version)ON app.staff_principal TO estate_staff_issuer;
GRANT UPDATE(row_version)ON app.staff_principal TO estate_staff_issuer;
-- UPDATE(row_version) permits FOR SHARE with a current-bound lock policy; row changes remain denied.
CREATE POLICY issuer_principal_guard ON app.staff_principal AS RESTRICTIVE FOR SELECT TO estate_staff_issuer USING(
  user_id=app.current_actor()AND active AND EXISTS(SELECT 1 FROM app.user_identity identity_row WHERE identity_row.id=staff_principal.user_id));
CREATE POLICY issuer_principal_lock ON app.staff_principal FOR UPDATE TO estate_staff_issuer USING(
  user_id=app.current_actor()AND active AND EXISTS(SELECT 1 FROM app.user_identity identity_row WHERE identity_row.id=staff_principal.user_id))WITH CHECK(false);
-- FOR SHARE uses UPDATE USING; WITH CHECK(false) prevents the actual principal UPDATE.

ALTER TABLE app.support_access_grant ADD COLUMN issuing_staff_user_id uuid REFERENCES app.staff_principal(user_id);
ALTER TABLE app.support_access_grant ADD COLUMN provenance text CHECK(provenance IS NULL OR provenance='synthetic-local');
ALTER TABLE app.support_access_grant ADD CHECK(provenance IS NULL OR(expires_at>created_at AND expires_at<=created_at+interval '1 hour'));
-- Legacy rows remain preserved but consumers deny missing issuer/provenance.

CREATE TABLE app.staff_session (
  token_hash text PRIMARY KEY CHECK(token_hash~'^[0-9a-f]{64}$'),
  staff_user_id uuid NOT NULL REFERENCES app.staff_principal(user_id),
  csrf_token text NOT NULL CHECK(csrf_token~'^[0-9a-f]{64}$'),
  provenance text NOT NULL CHECK(provenance='synthetic-local'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '8 hours'),
  selected_tenant_id uuid,
  selected_grant_id uuid,
  CHECK((selected_tenant_id IS NULL)=(selected_grant_id IS NULL)),
  FOREIGN KEY(selected_tenant_id,selected_grant_id)REFERENCES app.support_access_grant(tenant_id,id)
);
ALTER TABLE app.staff_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_session FORCE ROW LEVEL SECURITY;
CREATE POLICY session_hash_read ON app.staff_session FOR SELECT TO estate_control USING(token_hash=current_setting('app.staff_session_hash',true));
CREATE POLICY staff_session_insert ON app.staff_session FOR INSERT TO estate_staff_issuer WITH CHECK(
  staff_user_id=app.current_actor()AND provenance='synthetic-local'
  AND selected_tenant_id IS NULL AND selected_grant_id IS NULL
  AND created_at BETWEEN clock_timestamp()-interval '30 seconds'AND clock_timestamp()+interval '5 seconds'
  AND expires_at>clock_timestamp()AND expires_at<=clock_timestamp()+interval '8 hours'
  AND EXISTS(SELECT 1 FROM app.staff_principal principal WHERE principal.user_id=app.current_actor()AND principal.active)
  AND EXISTS(SELECT 1 FROM app.user_identity identity_row WHERE identity_row.id=staff_user_id));
CREATE POLICY staff_session_update ON app.staff_session FOR UPDATE TO estate_control USING(token_hash=current_setting('app.staff_session_hash',true) AND staff_user_id=app.current_actor())WITH CHECK(token_hash=current_setting('app.staff_session_hash',true) AND staff_user_id=app.current_actor());
CREATE POLICY staff_session_delete ON app.staff_session FOR DELETE TO estate_control USING(token_hash=current_setting('app.staff_session_hash',true));
GRANT SELECT,DELETE ON app.staff_session TO estate_control;
GRANT UPDATE(selected_tenant_id,selected_grant_id)ON app.staff_session TO estate_control;
GRANT INSERT(token_hash,staff_user_id,csrf_token,provenance,created_at,expires_at)ON app.staff_session TO estate_staff_issuer;
-- Issuer has no SELECT/UPDATE/DELETE on sessions and no platform/tenant table or function grants.
-- Control cannot INSERT a session even after forging app.actor_id or authentication claim GUCs.
CREATE POLICY control_principal_guard ON app.staff_principal AS RESTRICTIVE FOR SELECT TO estate_control USING(
  user_id=app.current_actor()AND active AND EXISTS(SELECT 1 FROM app.staff_session session
    WHERE session.token_hash=current_setting('app.staff_session_hash',true)AND session.staff_user_id=staff_principal.user_id
      AND session.staff_user_id=app.current_actor()AND session.expires_at>clock_timestamp()AND session.provenance='synthetic-local'));
-- Direct session binding avoids recursively calling principal authorization from its own policy.

CREATE FUNCTION app.control_authorized(permission_code text)RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT EXISTS(SELECT 1 FROM app.staff_principal principal JOIN app.staff_session session ON session.staff_user_id=principal.user_id
    WHERE principal.user_id=app.current_actor() AND principal.active AND session.token_hash=current_setting('app.staff_session_hash',true)
      AND session.expires_at>clock_timestamp() AND session.provenance='synthetic-local'
      AND(permission_code='' OR permission_code=ANY(principal.permission_codes)))
$$;
REVOKE ALL ON FUNCTION app.control_authorized(text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_authorized(text)TO estate_control;
CREATE POLICY control_bootstrap_identity_guard ON app.user_identity AS RESTRICTIVE FOR SELECT TO estate_control USING(
  app.control_authorized('platform.orgs.provision')AND id='20000000-0000-4000-8000-000000000001'::uuid
    AND issuer='urn:estate:synthetic'AND subject='owner'AND email_verified);
-- Local-only approved initial-owner binding, not a staff/customer identity directory or a browser selector.
GRANT UPDATE(row_version)ON app.user_identity TO estate_control;
CREATE POLICY control_bootstrap_identity_lock ON app.user_identity FOR UPDATE TO estate_control USING(
  app.control_authorized('platform.orgs.provision')AND id='20000000-0000-4000-8000-000000000001'::uuid
    AND issuer='urn:estate:synthetic'AND subject='owner'AND email_verified)WITH CHECK(false);
-- Existing identity_write excludes control, so its permissive WITH CHECK cannot enable real updates.
-- The provisioning owner row remains SHARE-locked through policy verification and activation.
CREATE POLICY control_principal_lock ON app.staff_principal FOR UPDATE TO estate_control USING(
  user_id=app.current_actor()AND active AND app.control_authorized(''))WITH CHECK(false);

-- A narrowly reviewed boolean/row-lock helper avoids recursive staff-directory RLS policies.
-- No identity, permission array, reason or session data is returned; PUBLIC cannot execute it.
CREATE FUNCTION app.control_staff_recipient_active(target_user_id uuid)RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
  IF session_user<>'estate_control' OR NOT app.control_authorized('platform.support.grant')THEN RETURN false; END IF;
  PERFORM id FROM app.staff_principal WHERE user_id=target_user_id AND active FOR SHARE;
  RETURN FOUND;
END
$$;
REVOKE ALL ON FUNCTION app.control_staff_recipient_active(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_staff_recipient_active(uuid)TO estate_control;

CREATE TABLE app.control_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES app.organization(id),
  requesting_staff_user_id uuid NOT NULL REFERENCES app.staff_principal(user_id),
  kind text NOT NULL CHECK(kind IN('organization.provision','staff.support.grant','staff.support.revoke')),
  state text NOT NULL CHECK(state IN('queued','running','succeeded','failed','cancelled','unknown')),
  bootstrap_owner_user_id uuid REFERENCES app.user_identity(id),
  bootstrap_policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(bootstrap_policy)='object'),
  result_ref uuid,
  safe_error text CHECK(safe_error IS NULL OR safe_error~'^[a-z][a-z0-9_]{0,79}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  claim_id uuid,
  lease_until timestamptz,
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(kind<>'organization.provision' OR bootstrap_owner_user_id IS NOT NULL),
  CHECK((claim_id IS NULL)=(lease_until IS NULL))
);
CREATE UNIQUE INDEX one_provisioning_job_per_org ON app.control_job(organization_id)WHERE kind='organization.provision';
CREATE INDEX control_job_due ON app.control_job(state,lease_until,id);
ALTER TABLE app.control_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.control_job FORCE ROW LEVEL SECURITY;
CREATE POLICY control_job_read ON app.control_job FOR SELECT TO estate_control USING(app.control_authorized('')AND(requesting_staff_user_id=app.current_actor()OR app.control_authorized('platform.health.read')));
CREATE POLICY control_job_insert ON app.control_job FOR INSERT TO estate_control WITH CHECK(requesting_staff_user_id=app.current_actor()AND app.control_authorized(CASE WHEN kind='organization.provision'THEN 'platform.orgs.provision' ELSE 'platform.support.grant' END)
  AND(kind<>'organization.provision'OR(state='queued'AND claim_id IS NULL AND lease_until IS NULL AND attempt_count=0
    AND EXISTS(SELECT 1 FROM app.organization organization_row WHERE organization_row.id=organization_id AND organization_row.status='provisioning'))));
CREATE POLICY control_job_update ON app.control_job FOR UPDATE TO estate_control USING(requesting_staff_user_id=app.current_actor()AND app.control_authorized(CASE WHEN kind='organization.provision'THEN 'platform.orgs.provision' ELSE 'platform.support.grant' END)
  AND(kind<>'organization.provision'OR state<>'succeeded'))WITH CHECK(requesting_staff_user_id=app.current_actor()AND app.control_authorized(CASE WHEN kind='organization.provision'THEN 'platform.orgs.provision' ELSE 'platform.support.grant' END)
  AND(kind<>'organization.provision'OR state<>'succeeded'OR(claim_id=NULLIF(current_setting('app.provision_claim',true),'')::uuid
    AND lease_until>clock_timestamp()AND EXISTS(SELECT 1 FROM app.organization organization_row WHERE organization_row.id=organization_id AND organization_row.status='active'))));
GRANT SELECT,INSERT ON app.control_job TO estate_control;
GRANT UPDATE(state,result_ref,safe_error,attempt_count,claim_id,lease_until,row_version,updated_at)ON app.control_job TO estate_control;

CREATE TABLE app.control_idempotency (
  staff_user_id uuid NOT NULL REFERENCES app.staff_principal(user_id),
  route_key text NOT NULL CHECK(length(route_key)<=255),
  key text NOT NULL CHECK(length(key)BETWEEN 1 AND 100),
  request_hash text NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
  response_body jsonb NOT NULL,
  status_code smallint NOT NULL CHECK(status_code BETWEEN 200 AND 299),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(staff_user_id,route_key,key)
);
ALTER TABLE app.control_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.control_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY own_control_command ON app.control_idempotency TO estate_control USING(staff_user_id=app.current_actor()AND app.control_authorized(''))WITH CHECK(staff_user_id=app.current_actor()AND app.control_authorized(''));
GRANT SELECT,INSERT ON app.control_idempotency TO estate_control;
-- Durable command/evidence rows have no UPDATE/DELETE or expiration-based duplicate path.

CREATE FUNCTION app.control_provision_claim_current(target_tenant uuid)RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT app.control_authorized('platform.orgs.provision')AND EXISTS(SELECT 1 FROM app.control_job job
    WHERE job.organization_id=target_tenant AND job.requesting_staff_user_id=app.current_actor()AND job.kind='organization.provision'
      AND job.state='running'AND job.claim_id=NULLIF(current_setting('app.provision_claim',true),'')::uuid AND job.lease_until>clock_timestamp())
$$;
CREATE FUNCTION app.control_can_seed(target_tenant uuid)RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT app.control_provision_claim_current(target_tenant)AND EXISTS(SELECT 1 FROM app.organization organization_row
    WHERE organization_row.id=target_tenant AND organization_row.status='provisioning')
$$;
CREATE FUNCTION app.control_owned_job(target_tenant uuid)RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT EXISTS(SELECT 1 FROM app.control_job job WHERE job.organization_id=target_tenant AND job.requesting_staff_user_id=app.current_actor()
    AND app.control_authorized(CASE WHEN job.kind='organization.provision'THEN 'platform.orgs.provision' ELSE 'platform.support.grant' END))
$$;
REVOKE ALL ON FUNCTION app.control_provision_claim_current(uuid),app.control_can_seed(uuid),app.control_owned_job(uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_provision_claim_current(uuid),app.control_can_seed(uuid),app.control_owned_job(uuid)TO estate_control;

-- Existing tenant identities retain their policies. Control has separate metadata authority.
ALTER POLICY org_select ON app.organization TO estate_runtime,estate_worker;
ALTER POLICY org_write ON app.organization TO estate_runtime,estate_worker;
CREATE POLICY control_org_read ON app.organization FOR SELECT TO estate_control USING(app.control_authorized('platform.orgs.read')OR app.control_authorized('platform.health.read')OR app.control_authorized('platform.orgs.provision')OR app.control_authorized('platform.support.grant'));
CREATE POLICY control_org_insert ON app.organization FOR INSERT TO estate_control WITH CHECK(app.control_authorized('platform.orgs.provision')AND status='provisioning');
CREATE POLICY control_org_update ON app.organization FOR UPDATE TO estate_control USING(app.control_can_seed(id)AND status='provisioning')WITH CHECK(app.control_provision_claim_current(id)AND status IN('provisioning','active'));
-- Only the initial transition can activate a provisioning organization. No seed authority remains
-- after activation, even while its running claim is retained solely for conditional Job completion.
GRANT SELECT,INSERT ON app.organization TO estate_control;
GRANT UPDATE(status,row_version,updated_at)ON app.organization TO estate_control;

ALTER POLICY tenant_scope ON app.support_access_grant TO estate_runtime,estate_worker;
CREATE POLICY control_grant_read ON app.support_access_grant FOR SELECT TO estate_control USING(app.control_authorized('')AND(staff_user_id=app.current_actor()OR app.control_authorized('platform.support.grant')));
CREATE POLICY control_grant_insert ON app.support_access_grant FOR INSERT TO estate_control WITH CHECK(
  app.control_authorized('platform.support.grant')AND issuing_staff_user_id=app.current_actor()AND provenance='synthetic-local'
  AND app.control_staff_recipient_active(staff_user_id)AND btrim(reason)<>''AND revoked_at IS NULL
  AND created_at BETWEEN clock_timestamp()-interval '30 seconds'AND clock_timestamp()+interval '5 seconds'
  AND expires_at>clock_timestamp()AND expires_at<=clock_timestamp()+interval '1 hour'
  AND cardinality(permission_codes)>0 AND cardinality(permission_codes)<=7
  AND cardinality(permission_codes)=(SELECT count(DISTINCT code)FROM unnest(permission_codes)AS code)
  AND permission_codes<@ARRAY['crm.contacts.read','crm.leads.read','crm.tasks.read','crm.deals.read','crm.pipeline.read','crm.sources.read','crm.tags.read']::text[]);
CREATE POLICY control_grant_update ON app.support_access_grant FOR UPDATE TO estate_control USING(
  app.control_authorized('platform.support.grant')AND revoked_at IS NULL)WITH CHECK(
  app.control_authorized('platform.support.grant')AND revoked_at IS NOT NULL
  AND revoked_at BETWEEN clock_timestamp()-interval '30 seconds'AND clock_timestamp()+interval '5 seconds');
GRANT SELECT,INSERT ON app.support_access_grant TO estate_control;
GRANT UPDATE(revoked_at,row_version,updated_at)ON app.support_access_grant TO estate_control;

CREATE FUNCTION app.control_grant_allows(permission_code text)RETURNS boolean LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT app.control_authorized('')AND EXISTS(SELECT 1 FROM app.support_access_grant grant_row
    JOIN app.staff_session session ON(session.selected_tenant_id,session.selected_grant_id)=(grant_row.tenant_id,grant_row.id)
    WHERE session.token_hash=current_setting('app.staff_session_hash',true)AND session.staff_user_id=app.current_actor()
      AND grant_row.tenant_id=app.current_tenant()AND grant_row.staff_user_id=app.current_actor()
      AND grant_row.id=NULLIF(current_setting('app.support_grant_id',true),'')::uuid
      AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()AND grant_row.provenance='synthetic-local'
      AND grant_row.issuing_staff_user_id IS NOT NULL AND btrim(grant_row.reason)<>''AND cardinality(grant_row.permission_codes)>0
      AND grant_row.permission_codes<@ARRAY['crm.contacts.read','crm.leads.read','crm.tasks.read','crm.deals.read','crm.pipeline.read','crm.sources.read','crm.tags.read']::text[]
      AND(permission_code='' OR permission_code=ANY(grant_row.permission_codes)))
$$;
REVOKE ALL ON FUNCTION app.control_grant_allows(text)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_grant_allows(text)TO estate_control;
CREATE POLICY control_grant_lock ON app.support_access_grant FOR UPDATE TO estate_control USING(
  staff_user_id=app.current_actor()AND revoked_at IS NULL AND app.control_grant_allows(''))WITH CHECK(false);
-- Recipient support readers can lock their current selected grant, but cannot revoke or alter it.

-- Control may only seed an owned, currently claimed provisioning job. It gets no tenant writes otherwise.
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['role_definition','membership','business_profile','entitlement','subscription','pipeline_stage','lead_source','crm_routing_state','routing_rule']LOOP
    EXECUTE format('GRANT SELECT,INSERT ON app.%I TO estate_control',table_name);
    EXECUTE format('CREATE POLICY control_seed_insert ON app.%I AS RESTRICTIVE FOR INSERT TO estate_control WITH CHECK(app.control_can_seed(tenant_id))',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['role_definition','membership','business_profile','subscription','crm_routing_state','routing_rule']LOOP
    EXECUTE format('CREATE POLICY control_seed_read ON app.%I AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_can_seed(tenant_id))',table_name);
  END LOOP;
END $$;
GRANT INSERT ON app.integration_connection TO estate_control;
GRANT SELECT(tenant_id,id,provider,mode,state,last_success_at,row_version,created_at,updated_at)ON app.integration_connection TO estate_control;
CREATE POLICY control_provider_seed ON app.integration_connection AS RESTRICTIVE FOR INSERT TO estate_control WITH CHECK(app.control_can_seed(tenant_id));
CREATE POLICY control_provider_metadata ON app.integration_connection FOR SELECT TO estate_control USING(app.control_authorized('platform.health.read'));
CREATE POLICY control_provider_guard ON app.integration_connection AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_can_seed(tenant_id)OR app.control_authorized('platform.health.read'));
-- Provider secret_ref, safe_config and complete capability payload are not selectable by control.
CREATE POLICY control_entitlement_read ON app.entitlement AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_can_seed(tenant_id)OR app.control_grant_allows(''));
GRANT UPDATE(row_version)ON app.entitlement TO estate_control;
CREATE POLICY control_entitlement_lock ON app.entitlement AS RESTRICTIVE FOR UPDATE TO estate_control USING(app.control_grant_allows(''))WITH CHECK(app.control_grant_allows(''));
-- The sole entitlement UPDATE column enables source FOR SHARE; it cannot alter capability state.
-- Retry defaults are insert-only and transactional; no destructive overwrite/reset grants.

GRANT SELECT ON app.contact,app.contact_channel,app.lead,app.task,app.deal,app.tag,app.lead_tag TO estate_control;
CREATE POLICY control_contact_read ON app.contact AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.contacts.read'));
CREATE POLICY control_channel_read ON app.contact_channel AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.contacts.read'));
CREATE POLICY control_lead_read ON app.lead AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.leads.read')AND app.control_grant_allows('crm.contacts.read'));
CREATE POLICY control_task_read ON app.task AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.tasks.read')AND(lead_id IS NULL OR(app.control_grant_allows('crm.leads.read')AND app.control_grant_allows('crm.contacts.read'))));
CREATE POLICY control_deal_read ON app.deal AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.deals.read')AND app.control_grant_allows('crm.leads.read')AND app.control_grant_allows('crm.contacts.read'));
CREATE POLICY control_tag_read ON app.tag AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.tags.read'));
CREATE POLICY control_lead_tag_read ON app.lead_tag AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_grant_allows('crm.tags.read')AND app.control_grant_allows('crm.leads.read')AND app.control_grant_allows('crm.contacts.read'));
CREATE POLICY control_stage_read ON app.pipeline_stage AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_can_seed(tenant_id)OR app.control_grant_allows('crm.pipeline.read'));
CREATE POLICY control_source_read ON app.lead_source AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_can_seed(tenant_id)OR app.control_grant_allows('crm.sources.read'));
-- No contact/lead/task/deal/tag/channel UPDATE/INSERT, notes or exports for control.

GRANT INSERT ON app.audit_event,app.outbox TO estate_control;
CREATE POLICY control_audit_insert ON app.audit_event AS RESTRICTIVE FOR INSERT TO estate_control WITH CHECK(app.control_owned_job(tenant_id)OR app.control_grant_allows(''));
CREATE POLICY control_outbox_insert ON app.outbox AS RESTRICTIVE FOR INSERT TO estate_control WITH CHECK(app.control_owned_job(tenant_id));
-- Redacted platform audit projection is enforceable by column privileges; safe_diff is unavailable.
GRANT SELECT(tenant_id,id,actor_ref,action,resource_type,resource_id,trace_id,created_at)ON app.audit_event TO estate_control;
CREATE POLICY control_audit_read ON app.audit_event FOR SELECT TO estate_control USING(app.control_authorized('platform.audit.read'));
CREATE POLICY control_audit_guard ON app.audit_event AS RESTRICTIVE FOR SELECT TO estate_control USING(app.control_authorized('platform.audit.read'));
-- No ordinary runtime/worker privileges on new control tables; no existing role gains control authority.
COMMIT;
