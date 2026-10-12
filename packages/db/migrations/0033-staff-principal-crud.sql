-- Migration 0033: Enable staff principal CRUD for administrators
BEGIN;

-- 1. Widen audit action constraint to allow principal CRUD actions
ALTER TABLE app.control_command_audit
  DROP CONSTRAINT IF EXISTS control_command_audit_action_check;
ALTER TABLE app.control_command_audit
  ADD CONSTRAINT control_command_audit_action_check
  CHECK (action ~ '^staff[_.][\w.]{1,100}$');

-- 2. Column grants for defense-in-depth (SECURITY DEFINER functions bypass these)
GRANT INSERT(user_id, permission_codes, active) ON app.staff_principal TO estate_control;
GRANT UPDATE(permission_codes, active, row_version, updated_at) ON app.staff_principal TO estate_control;

-- 3. SECURITY DEFINER read functions (bypass restrictive control_principal_guard)
CREATE FUNCTION app.control_list_principals(p_limit integer, p_cursor timestamptz DEFAULT NULL)
  RETURNS TABLE(id uuid, user_id uuid, permission_codes text[], active boolean, row_version bigint, created_at timestamptz, updated_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NOT app.control_authorized('platform.orgs.provision') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = 'P0001';
  END IF;
  IF p_cursor IS NULL THEN
    RETURN QUERY SELECT sp.id, sp.user_id, sp.permission_codes, sp.active, sp.row_version, sp.created_at, sp.updated_at
      FROM app.staff_principal sp ORDER BY sp.created_at DESC LIMIT p_limit;
  ELSE
    RETURN QUERY SELECT sp.id, sp.user_id, sp.permission_codes, sp.active, sp.row_version, sp.created_at, sp.updated_at
      FROM app.staff_principal sp WHERE sp.created_at < p_cursor ORDER BY sp.created_at DESC LIMIT p_limit;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app.control_list_principals(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_list_principals(integer, timestamptz) TO estate_control;

CREATE FUNCTION app.control_read_principal(p_id uuid)
  RETURNS TABLE(id uuid, user_id uuid, permission_codes text[], active boolean, row_version bigint, created_at timestamptz, updated_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NOT app.control_authorized('platform.orgs.provision') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT sp.id, sp.user_id, sp.permission_codes, sp.active, sp.row_version, sp.created_at, sp.updated_at
    FROM app.staff_principal sp WHERE sp.id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION app.control_read_principal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_read_principal(uuid) TO estate_control;

-- 4. SECURITY DEFINER write functions (bypass restrictive guard for cross-principal writes)
CREATE FUNCTION app.control_create_principal(p_user_id uuid, p_permission_codes text[])
  RETURNS TABLE(id uuid, user_id uuid, permission_codes text[], active boolean, row_version bigint, created_at timestamptz, updated_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT app.control_authorized('platform.orgs.provision') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = 'P0001';
  END IF;
  IF p_user_id = app.current_actor() THEN
    RAISE EXCEPTION 'self_modification_denied' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS(SELECT 1 FROM app.staff_principal sp WHERE sp.user_id = p_user_id) THEN
    RAISE EXCEPTION 'principal_exists' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.staff_principal(user_id, permission_codes, active)
    VALUES(p_user_id, p_permission_codes, true);
  RETURN QUERY SELECT sp.id, sp.user_id, sp.permission_codes, sp.active, sp.row_version, sp.created_at, sp.updated_at
    FROM app.staff_principal sp WHERE sp.user_id = p_user_id;
END;
$$;
REVOKE ALL ON FUNCTION app.control_create_principal(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_create_principal(uuid, text[]) TO estate_control;

CREATE FUNCTION app.control_update_principal(p_id uuid, p_permission_codes text[], p_active boolean, p_expected_version bigint)
  RETURNS TABLE(id uuid, user_id uuid, permission_codes text[], active boolean, row_version bigint, created_at timestamptz, updated_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE v_target_user uuid; v_count integer;
BEGIN
  IF NOT app.control_authorized('platform.orgs.provision') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = 'P0001';
  END IF;
  SELECT sp.user_id INTO v_target_user FROM app.staff_principal sp WHERE sp.id = p_id;
  IF v_target_user IS NULL THEN
    RAISE EXCEPTION 'principal_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_target_user = app.current_actor() THEN
    RAISE EXCEPTION 'self_modification_denied' USING ERRCODE = 'P0001';
  END IF;
  UPDATE app.staff_principal sp SET
    permission_codes = COALESCE(p_permission_codes, sp.permission_codes),
    active = COALESCE(p_active, sp.active),
    row_version = sp.row_version + 1,
    updated_at = now()
  WHERE sp.id = p_id AND sp.row_version = p_expected_version;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'version_conflict' USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY SELECT sp.id, sp.user_id, sp.permission_codes, sp.active, sp.row_version, sp.created_at, sp.updated_at
    FROM app.staff_principal sp WHERE sp.id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION app.control_update_principal(uuid, text[], boolean, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.control_update_principal(uuid, text[], boolean, bigint) TO estate_control;

-- 5. Restrict the clear-command trigger to only fire for clear actions
DROP TRIGGER control_clear_command_apply ON app.control_command_audit;
CREATE TRIGGER control_clear_command_apply AFTER INSERT ON app.control_command_audit
  FOR EACH ROW WHEN (NEW.action = 'staff.support.selection.clear')
  EXECUTE FUNCTION app.control_clear_command_apply();

-- 6. Audit INSERT policy for principal CRUD commands
CREATE POLICY control_principal_command_insert ON app.control_command_audit FOR INSERT TO estate_control WITH CHECK(
  action LIKE 'staff\_principal.%'
  AND staff_user_id = app.current_actor()
  AND app.control_authorized('platform.orgs.provision')
  AND session_binding = app.control_command_session_binding()
);

COMMIT;
