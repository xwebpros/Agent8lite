-- ADR-061 integration review: preserve applied0035; harden its internal producer port.
BEGIN;
CREATE OR REPLACE FUNCTION app.create_notification(
  p_tenant_id uuid,p_member_id uuid,p_kind text,p_safe_payload jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  v_id uuid;
  v_grants jsonb;
  v_permission text;
BEGIN
  IF session_user<>'estate_runtime' OR app.current_actor() IS NULL
    OR app.current_tenant() IS NULL OR p_tenant_id IS DISTINCT FROM app.current_tenant() THEN
    RAISE EXCEPTION 'Current verified notification context required' USING ERRCODE='42501';
  END IF;
  IF p_member_id IS NULL OR p_kind IS NULL OR p_safe_payload IS NULL THEN
    RAISE EXCEPTION 'Notification input required' USING ERRCODE='23502';
  END IF;
  v_permission := CASE p_kind
    WHEN 'lead.assigned' THEN 'crm.leads.write'
    WHEN 'lead.stage_changed' THEN 'crm.leads.write'
    WHEN 'task.assigned' THEN 'crm.tasks.write'
    ELSE NULL END;
  IF v_permission IS NULL OR jsonb_typeof(p_safe_payload) IS DISTINCT FROM 'object'
    OR NOT (p_safe_payload ?& ARRAY['title','href'])
    OR (p_safe_payload - 'title' - 'href') <> '{}'::jsonb
    OR jsonb_typeof(p_safe_payload->'title') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_safe_payload->'href') IS DISTINCT FROM 'string'
    OR length(p_safe_payload->>'title') NOT BETWEEN 1 AND 160
    OR p_safe_payload->>'href' IS DISTINCT FROM
      CASE WHEN p_kind='task.assigned' THEN '/tasks' ELSE '/pipeline' END THEN
    RAISE EXCEPTION 'Safe notification input required' USING ERRCODE='23514';
  END IF;
  -- This internal port runs only after the CRM command authorizes its entity scope.
  -- Recheck actor, permission and entitlement after every blocking source lock.
  SELECT r.permission_grants INTO v_grants FROM app.membership m
    JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    JOIN app.organization o ON o.id=m.tenant_id
    WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
      AND m.status='active' AND o.status='active' FOR SHARE OF m,r,o;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_grants) grant_row
    WHERE grant_row->>'code'=v_permission AND grant_row->>'scope' IN ('own','team','organization')) THEN
    RAISE EXCEPTION 'Current notification producer permission required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
    AND e.feature='crm' AND e.state='enabled' FOR SHARE OF e;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current CRM entitlement required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.membership m WHERE m.tenant_id=app.current_tenant()
    AND m.id=p_member_id AND m.status='active' FOR SHARE OF m;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
    AND e.feature='crm' AND e.state='enabled'
    AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current CRM entitlement required' USING ERRCODE='42501';
  END IF;
  v_id := gen_random_uuid();
  INSERT INTO app.notification(tenant_id,id,member_id,kind,safe_payload)
    VALUES(app.current_tenant(),v_id,p_member_id,p_kind,p_safe_payload);
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION app.create_notification(uuid,uuid,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.create_notification(uuid,uuid,text,jsonb) TO estate_runtime;
DO $$ BEGIN RAISE EXCEPTION 'Unreviewed notification context candidate' USING ERRCODE='55000'; END $$;
ROLLBACK;
