BEGIN;
-- Allow estate_runtime to create notifications for active members via a
-- SECURITY DEFINER function that validates the target member belongs to
-- the current tenant and is active.
CREATE FUNCTION app.create_notification(
  p_tenant_id uuid,
  p_member_id uuid,
  p_kind text,
  p_safe_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_id uuid;
BEGIN
  IF session_user<>'estate_runtime' THEN
    RAISE EXCEPTION 'Notification creation requires estate_runtime' USING ERRCODE='42501';
  END IF;
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_kind IS NULL OR p_safe_payload IS NULL THEN
    RAISE EXCEPTION 'All notification parameters are required' USING ERRCODE='23502';
  END IF;
  IF length(p_kind)>255 OR p_kind='' THEN
    RAISE EXCEPTION 'Notification kind must be 1-255 characters' USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM app.membership m
    JOIN app.organization o ON o.id=m.tenant_id
    WHERE m.tenant_id=p_tenant_id AND m.id=p_member_id
      AND m.status='active' AND o.status='active';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO app.notification(tenant_id,id,member_id,kind,safe_payload)
    VALUES(p_tenant_id,v_id,p_member_id,p_kind,p_safe_payload);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_notification(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_notification(uuid,uuid,text,jsonb) TO estate_runtime;
COMMIT;
