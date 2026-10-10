BEGIN;
-- ADR-033 reviewed forward prerequisite. No notification producer or worker access.
CREATE FUNCTION app.notification_member_allowed(p_member uuid, p_permission text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT session_user='estate_runtime' AND current_user='estate_runtime'
    AND app.current_tenant() IS NOT NULL AND app.current_actor() IS NOT NULL
    AND p_permission IN ('self.notifications.read','self.notifications.write')
    AND EXISTS (
      SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
        AND m.id=p_member AND m.status='active' AND o.status='active'
        AND (r.permission_grants @> jsonb_build_array(jsonb_build_object('code',p_permission,'scope','own'))
          OR r.permission_grants @> jsonb_build_array(jsonb_build_object('code',p_permission,'scope','team'))
          OR r.permission_grants @> jsonb_build_array(jsonb_build_object('code',p_permission,'scope','organization')))
    )
$$;
REVOKE ALL ON FUNCTION app.notification_member_allowed(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notification_member_allowed(uuid,text) TO estate_runtime;

-- Existing tenant_scope remains; restrictive policies add member/permission checks.
CREATE POLICY notification_runtime_read ON app.notification AS RESTRICTIVE
  FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant()
    AND app.notification_member_allowed(member_id,'self.notifications.read'));
CREATE POLICY notification_runtime_update ON app.notification AS RESTRICTIVE
  FOR UPDATE TO estate_runtime
  USING (tenant_id=app.current_tenant()
    AND app.notification_member_allowed(member_id,'self.notifications.read')
    AND app.notification_member_allowed(member_id,'self.notifications.write'))
  WITH CHECK (tenant_id=app.current_tenant()
    AND app.notification_member_allowed(member_id,'self.notifications.read')
    AND app.notification_member_allowed(member_id,'self.notifications.write'));

CREATE FUNCTION app.notification_mark_read_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF session_user='estate_runtime' THEN
    -- Match verified service locking: revocation cannot cross a committed transition.
    PERFORM m.id FROM app.membership m
      JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
        AND m.id=OLD.member_id AND m.status='active' AND o.status='active'
      FOR SHARE OF m,r,o;
    IF NOT FOUND OR NOT app.notification_member_allowed(OLD.member_id,'self.notifications.read')
      OR NOT app.notification_member_allowed(OLD.member_id,'self.notifications.write') THEN
      RAISE EXCEPTION 'Notification access unavailable' USING ERRCODE='42501';
    END IF;
    IF OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.member_id IS DISTINCT FROM OLD.member_id OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.safe_payload IS DISTINCT FROM OLD.safe_payload OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Notification transition unavailable' USING ERRCODE='23514';
    END IF;
    IF OLD.row_version >= 9007199254740991 THEN
      RAISE EXCEPTION 'Notification version exhausted' USING ERRCODE='23514';
    END IF;
    NEW.read_at=clock_timestamp();
    NEW.updated_at=NEW.read_at;
    NEW.row_version=OLD.row_version+1;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.notification_mark_read_guard() FROM PUBLIC;
CREATE TRIGGER notification_mark_read_guard BEFORE UPDATE ON app.notification
  FOR EACH ROW EXECUTE FUNCTION app.notification_mark_read_guard();

GRANT SELECT(tenant_id,id,created_at,updated_at,row_version,member_id,kind,safe_payload,read_at)
  ON app.notification TO estate_runtime;
GRANT UPDATE(read_at,updated_at,row_version) ON app.notification TO estate_runtime;
CREATE INDEX idx_notification_member_page ON app.notification(tenant_id,member_id,id);
COMMIT;
