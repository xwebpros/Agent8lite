-- ADR-023 narrow sequence allocation across unreadable historical published versions.
BEGIN;

CREATE FUNCTION app.assign_native_workflow_sequence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous_version integer;
BEGIN
  -- Migration fixtures preserve explicit legacy sequences. Other non-runtime
  -- identities still have no INSERT grant. Runtime is always an actual login.
  IF session_user <> 'estate_runtime' THEN RETURN NEW; END IF;
  IF app.current_tenant() IS NULL OR app.current_actor() IS NULL
    OR NEW.tenant_id IS DISTINCT FROM app.current_tenant()
    OR NEW.state IS DISTINCT FROM 'draft' OR NEW.published_at IS NOT NULL
    OR NEW.row_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Verified workflow context required' USING ERRCODE='42501';
  END IF;

  -- Explicit current-tenant predicate precedes any privileged source read.
  PERFORM 1 FROM app.campaign c WHERE c.tenant_id=app.current_tenant()
    AND c.id=NEW.campaign_id AND c.state='draft' FOR UPDATE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current workflow parent unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.membership m
    JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    JOIN app.organization o ON o.id=m.tenant_id
    WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
    AND m.status='active' AND o.status='active'
    AND r.permission_grants @> '[{"code":"campaigns.write","scope":"organization"}]'::jsonb
    FOR SHARE OF m,r,o;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current workflow authority unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
    AND e.feature='marketing' AND e.state='enabled' FOR SHARE OF e;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current workflow capability unavailable' USING ERRCODE='42501';
  END IF;
  -- Recheck database time after all waits, including direct runtime INSERT.
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
    AND e.feature='marketing' AND e.state='enabled'
    AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Current workflow capability unavailable' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(MAX(v.version),0) INTO previous_version FROM app.campaign_version v
    WHERE v.tenant_id=app.current_tenant() AND v.campaign_id=NEW.campaign_id;
  IF previous_version >= 2147483647 THEN
    RAISE EXCEPTION 'Workflow sequence unavailable'
      USING ERRCODE='23514',CONSTRAINT='native_workflow_sequence_available';
  END IF;
  NEW.version := previous_version+1;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.assign_native_workflow_sequence() FROM PUBLIC;
CREATE TRIGGER campaign_version_native_sequence
  BEFORE INSERT ON app.campaign_version
  FOR EACH ROW EXECUTE FUNCTION app.assign_native_workflow_sequence();

COMMIT;
