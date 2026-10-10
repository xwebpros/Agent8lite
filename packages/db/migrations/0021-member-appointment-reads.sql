BEGIN;
-- ADR-035 SELECT-only prerequisite; no appointment producer or provider activation.
CREATE FUNCTION app.appointment_member_read_allowed(p_lead uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT session_user='estate_runtime' AND current_user='estate_runtime'
    AND app.current_tenant() IS NOT NULL AND app.current_actor() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      JOIN app.lead l ON l.tenant_id=m.tenant_id AND l.owner_member_id=m.id
      JOIN app.contact c ON (c.tenant_id,c.id)=(l.tenant_id,l.contact_id)
      WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
        AND m.status='active' AND o.status='active' AND l.id=p_lead
        AND l.archived_at IS NULL AND c.archived_at IS NULL
        AND r.permission_grants @> '[{"code":"appointments.read","scope":"organization"}]'::jsonb
        AND (r.permission_grants @> '[{"code":"crm.leads.read","scope":"organization"}]'::jsonb
          OR r.permission_grants @> '[{"code":"crm.leads.read","scope":"own"}]'::jsonb
          OR (r.permission_grants @> '[{"code":"crm.leads.read","scope":"team"}]'::jsonb
            AND EXISTS(SELECT 1 FROM app.office_member om
              WHERE om.tenant_id=m.tenant_id AND om.member_id=m.id)))
        AND EXISTS(SELECT 1 FROM app.entitlement e WHERE e.tenant_id=m.tenant_id
          AND e.feature='crm' AND e.state='enabled'
          AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
    )
$$;
REVOKE ALL ON FUNCTION app.appointment_member_read_allowed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.appointment_member_read_allowed(uuid) TO estate_runtime;

CREATE POLICY appointment_runtime_member_read ON app.appointment AS RESTRICTIVE
  FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND app.appointment_member_read_allowed(lead_id));
GRANT SELECT(tenant_id,id,lead_id,starts_at,ends_at,timezone,state)
  ON app.appointment TO estate_runtime;
CREATE INDEX idx_appointment_member_lead_page ON app.appointment(tenant_id,lead_id,id);
COMMIT;
