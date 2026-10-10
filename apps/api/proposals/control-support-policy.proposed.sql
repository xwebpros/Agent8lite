-- Candidate only: reviewed MOD-A support source locks and exact own-session clear command evidence.
-- Coordinator promotes this expand-only SQL as a forward migration before any phase-2 consumers.
BEGIN;

-- The prior positive CHECK made UPDATE(row_version) a real write privilege, not merely a SHARE lock.
ALTER POLICY control_entitlement_lock ON app.entitlement WITH CHECK(false);

CREATE POLICY control_support_org_read ON app.organization FOR SELECT TO estate_control USING(
  id=app.current_tenant()AND status='active'AND app.control_grant_allows(''));
CREATE POLICY control_support_org_lock ON app.organization FOR UPDATE TO estate_control USING(
  id=app.current_tenant()AND status='active'AND app.control_grant_allows(''))WITH CHECK(false);
-- Permissive USING and CHECK are separately OR-combined: a false CHECK on only the new lock
-- cannot prevent the old current-provision-claim CHECK from lending this lock real write authority.
-- Preserve support SHARE locking with USING(true), but prohibit every actual selected-context write.
CREATE POLICY control_org_unselected_write ON app.organization AS RESTRICTIVE FOR UPDATE TO estate_control
  USING(true)WITH CHECK(EXISTS(SELECT 1 FROM app.staff_session session
    WHERE session.token_hash=current_setting('app.staff_session_hash',true)AND session.staff_user_id=app.current_actor()
      AND session.provenance='synthetic-local'AND session.expires_at>clock_timestamp()
      AND session.selected_tenant_id IS NULL AND session.selected_grant_id IS NULL));

-- Neither helper returns the actual opaque hash; bindings are domain-separated one-way references.
CREATE FUNCTION app.control_command_session_binding()RETURNS text LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path=pg_catalog,app AS $$
  SELECT CASE WHEN current_setting('app.staff_session_hash',true)~'^[0-9a-f]{64}$'
    THEN encode(sha256(convert_to('control-command-session-v1:'||current_setting('app.staff_session_hash',true),'UTF8')),'hex')END
$$;
CREATE FUNCTION app.control_command_context_fingerprint(target_tenant uuid,target_grant uuid)RETURNS text
  LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog,app AS $$
  SELECT CASE WHEN target_tenant IS NULL AND target_grant IS NULL THEN NULL
    ELSE encode(sha256(convert_to('control-command-selection-v1:'||target_tenant::text||':'||target_grant::text,'UTF8')),'hex')END
$$;
REVOKE ALL ON FUNCTION app.control_command_session_binding(),app.control_command_context_fingerprint(uuid,uuid)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_command_session_binding(),app.control_command_context_fingerprint(uuid,uuid)TO estate_control;

CREATE TABLE app.control_command_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES app.staff_principal(user_id),
  staff_principal_id uuid NOT NULL REFERENCES app.staff_principal(id),
  principal_version bigint NOT NULL CHECK(principal_version>0),
  session_binding text NOT NULL CHECK(session_binding~'^[0-9a-f]{64}$'),
  action text NOT NULL CHECK(action='staff.support.selection.clear'),
  command_digest text NOT NULL CHECK(command_digest~'^[0-9a-f]{64}$'),
  trace_id uuid NOT NULL,
  previous_context_fingerprint text CHECK(previous_context_fingerprint IS NULL OR previous_context_fingerprint~'^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(staff_user_id,session_binding,command_digest)
);
ALTER TABLE app.control_command_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.control_command_audit FORCE ROW LEVEL SECURITY;

-- Policy locks the exact current principal, then own session; caller-provided fields never supply authority.
-- Invalid/foreign/expired support selections are merely references in this own identity context.
CREATE FUNCTION app.control_clear_command_matches(target_user uuid,target_principal uuid,target_version bigint,
  target_binding text,target_previous text,target_created timestamptz)RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY INVOKER
  SET search_path=pg_catalog,app AS $$
DECLARE principal_row record; session_row record;
BEGIN
  IF session_user<>'estate_control'OR target_user IS DISTINCT FROM app.current_actor()OR NOT app.control_authorized('')THEN RETURN false; END IF;
  SELECT id,row_version INTO principal_row FROM app.staff_principal WHERE user_id=app.current_actor()AND active FOR SHARE;
  IF NOT FOUND OR principal_row.id IS DISTINCT FROM target_principal OR principal_row.row_version IS DISTINCT FROM target_version THEN RETURN false; END IF;
  SELECT selected_tenant_id,selected_grant_id INTO session_row FROM app.staff_session
    WHERE token_hash=current_setting('app.staff_session_hash',true)AND staff_user_id=app.current_actor()
      AND provenance='synthetic-local'AND expires_at>clock_timestamp()FOR UPDATE;
  IF NOT FOUND OR NOT app.control_authorized('')THEN RETURN false; END IF;
  RETURN target_binding IS NOT DISTINCT FROM app.control_command_session_binding()
    AND target_previous IS NOT DISTINCT FROM app.control_command_context_fingerprint(session_row.selected_tenant_id,session_row.selected_grant_id)
    AND target_created BETWEEN clock_timestamp()-interval '30 seconds'AND clock_timestamp()+interval '5 seconds';
END
$$;
REVOKE ALL ON FUNCTION app.control_clear_command_matches(uuid,uuid,bigint,text,text,timestamptz)FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_clear_command_matches(uuid,uuid,bigint,text,text,timestamptz)TO estate_control;

CREATE POLICY control_clear_command_insert ON app.control_command_audit FOR INSERT TO estate_control WITH CHECK(
  app.control_clear_command_matches(staff_user_id,staff_principal_id,principal_version,session_binding,previous_context_fingerprint,created_at));
CREATE POLICY control_clear_command_read ON app.control_command_audit FOR SELECT TO estate_control USING(
  session_user='estate_control'AND app.control_authorized('')AND staff_user_id=app.current_actor()
    AND session_binding=app.control_command_session_binding());
GRANT SELECT,INSERT ON app.control_command_audit TO estate_control;
-- No UPDATE/DELETE/TRUNCATE for any request role; issuer/runtime/worker receive no table/function privileges.

CREATE FUNCTION app.control_clear_command_apply()RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
  SET search_path=pg_catalog,app AS $$
BEGIN
  -- Recheck clock-sensitive source validity after policy locks and bind exactly the row being recorded.
  IF NOT app.control_clear_command_matches(NEW.staff_user_id,NEW.staff_principal_id,NEW.principal_version,
    NEW.session_binding,NEW.previous_context_fingerprint,NEW.created_at)THEN
    RAISE EXCEPTION 'Current own staff session required' USING ERRCODE='42501';
  END IF;
  UPDATE app.staff_session SET selected_tenant_id=NULL,selected_grant_id=NULL
    WHERE token_hash=current_setting('app.staff_session_hash',true)AND staff_user_id=NEW.staff_user_id
      AND provenance='synthetic-local'AND expires_at>clock_timestamp()
      AND app.control_command_context_fingerprint(selected_tenant_id,selected_grant_id)IS NOT DISTINCT FROM NEW.previous_context_fingerprint;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current own staff session required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION app.control_clear_command_apply()FROM PUBLIC;
CREATE TRIGGER control_clear_command_apply AFTER INSERT ON app.control_command_audit
  FOR EACH ROW EXECUTE FUNCTION app.control_clear_command_apply();
-- INSERT is the bounded clear command, so an evidence row cannot commit without its exact own clear.
-- Application replay must lookup the session-bound key under session FOR UPDATE before INSERT;
-- it resolves current Session/409 and never executes the trigger again for a previously used key.
COMMIT;
