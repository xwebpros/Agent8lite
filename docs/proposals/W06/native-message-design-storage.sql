-- PROPOSAL ONLY: ADR-026; no actual migration number or database application.
-- Requires reviewed 0001--0018. Existing source history is NEVER reconstructed.
BEGIN;

ALTER TABLE app.message_design
  ADD COLUMN subject text,
  ADD COLUMN availability_state text NOT NULL DEFAULT 'draft'
    CHECK (availability_state IN ('draft','archived')),
  ADD COLUMN history_ready boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT native_design_subject_bound CHECK (
    subject IS NULL OR (length(subject)<=200
      AND subject !~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')));
ALTER TABLE app.message_design ALTER COLUMN version SET DEFAULT 1;
ALTER TABLE app.campaign_version
  ADD COLUMN design_bindings_ready boolean NOT NULL DEFAULT false;

CREATE TABLE app.message_design_revision (
  tenant_id uuid NOT NULL,
  message_design_id uuid NOT NULL,
  version integer NOT NULL CHECK (version>0),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_row_version bigint NOT NULL CHECK (source_row_version>0),
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  subject text,
  editor_kind text NOT NULL CHECK (editor_kind='native'),
  design jsonb NOT NULL,
  rendered_content text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,message_design_id,version),
  UNIQUE (tenant_id,message_design_id,version,content_hash),
  FOREIGN KEY (tenant_id,message_design_id) REFERENCES app.message_design(tenant_id,id)
    ON DELETE RESTRICT
);
CREATE TABLE app.campaign_workflow_design_reference (
  tenant_id uuid NOT NULL,
  campaign_version_id uuid NOT NULL,
  node_key text NOT NULL CHECK (node_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  message_design_id uuid NOT NULL,
  design_version integer NOT NULL CHECK (design_version>0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Private INSERT-RETURNING proof provenance. No runtime column grant.
  captured_campaign_id uuid NOT NULL,
  initiating_actor_id uuid NOT NULL,
  capture_transaction xid8 NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (tenant_id,campaign_version_id,node_key),
  FOREIGN KEY (tenant_id,campaign_version_id) REFERENCES app.campaign_version(tenant_id,id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id,message_design_id,design_version,content_hash)
    REFERENCES app.message_design_revision(tenant_id,message_design_id,version,content_hash)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,captured_campaign_id) REFERENCES app.campaign(tenant_id,id)
    ON DELETE RESTRICT,
  FOREIGN KEY (initiating_actor_id) REFERENCES app.user_identity(id) ON DELETE RESTRICT
);
CREATE INDEX native_design_reference_source
  ON app.campaign_workflow_design_reference(tenant_id,message_design_id);

ALTER TABLE app.message_design_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_design_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.message_design_revision
  USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());
ALTER TABLE app.campaign_workflow_design_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_workflow_design_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.campaign_workflow_design_reference
  USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

-- Utility predicates do not expose database data. Explicit ECMAScript trim set
-- matches the reviewed preparation, including NBSP/BOM; PG text rejects NUL.
CREATE FUNCTION app.native_design_nonblank(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT length(btrim(value,E' \t\n\r'||chr(11)||chr(12)
    ||U&'\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
$$;
CREATE FUNCTION app.native_design_static_text(value text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT app.native_design_nonblank(value) AND length(value)<=100000
    AND value !~ '[<>]' AND position('{{' IN value)=0 AND position('${' IN value)=0
    AND value !~ ('['||chr(1)||'-'||chr(8)||chr(11)||'-'||chr(31)||chr(127)||']')
    AND value !~* '(javascript|data|https?|ftp):|www\.'
$$;
CREATE FUNCTION app.native_design_payload_valid(
  p_name text,p_channel text,p_subject text,p_editor text,p_design jsonb,
  p_content text,p_hash text
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE block jsonb; joined text; canonical_design text; canonical_body text;
BEGIN
  IF p_name IS NULL OR NOT app.native_design_nonblank(p_name) OR length(p_name)>120
    OR p_name ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')
    OR p_channel IS NULL OR p_channel NOT IN ('email','sms')
    OR p_editor IS DISTINCT FROM 'native'
    OR p_content IS NULL OR NOT app.native_design_static_text(p_content)
    OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  IF p_subject IS NOT NULL AND (length(p_subject)>200
    OR NOT app.native_design_static_text(p_subject)
    OR p_subject ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']')) THEN RETURN false; END IF;
  IF p_design IS NULL OR jsonb_typeof(p_design) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_design))<>2
    OR p_design->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(p_design->'blocks') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_design->'blocks') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR block IN SELECT value FROM jsonb_array_elements(p_design->'blocks') LOOP
    IF jsonb_typeof(block) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(block))<>2
      OR block->'type' IS DISTINCT FROM '"text"'::jsonb
      OR jsonb_typeof(block->'text') IS DISTINCT FROM 'string'
      OR NOT app.native_design_static_text(block->>'text') THEN RETURN false; END IF;
  END LOOP;
  SELECT string_agg(value->>'text',chr(10) ORDER BY ordinality),
    '{"blocks":['||string_agg('{"text":'||to_jsonb(value->>'text')::text
      ||',"type":"text"}',',' ORDER BY ordinality)||'],"schemaVersion":1}'
    INTO joined,canonical_design FROM jsonb_array_elements(p_design->'blocks') WITH ORDINALITY;
  IF joined IS DISTINCT FROM p_content
    OR encode(sha256(convert_to(p_content,'UTF8')),'hex') IS DISTINCT FROM p_hash THEN RETURN false; END IF;
  canonical_body := '{"channel":'||to_jsonb(p_channel)::text||',"content":'||to_jsonb(p_content)::text
    ||',"design":'||canonical_design||',"editor":"native","name":'||to_jsonb(p_name)::text
    ||CASE WHEN p_subject IS NULL THEN '' ELSE ',"subject":'||to_jsonb(p_subject)::text END||'}';
  RETURN octet_length(convert_to(canonical_body,'UTF8'))<=262144;
END;
$$;

-- Callable only as a safe permission predicate; no ID/content directory.
CREATE FUNCTION app.native_design_context(permission_code text) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
  SELECT session_user='estate_runtime' AND current_user='estate_runtime'
    AND permission_code IN ('campaigns.read','campaigns.write')
    AND app.current_tenant() IS NOT NULL AND app.current_actor() IS NOT NULL
    AND EXISTS (SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
      AND m.status='active' AND o.status='active'
      AND r.permission_grants @> jsonb_build_array(jsonb_build_object('code',permission_code,'scope','organization')))
    AND EXISTS (SELECT 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
      AND e.feature='marketing' AND e.state='enabled'
      AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp()))
$$;

-- Private trigger-only lock/check boundary. Function current_user is its owner;
-- session_user + role setting reject masked/SET ROLE non-runtime callers.
CREATE FUNCTION app.native_design_lock_writer() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF session_user<>'estate_runtime' OR current_setting('role',true) NOT IN ('none','estate_runtime')
    OR app.current_tenant() IS NULL OR app.current_actor() IS NULL THEN
    RAISE EXCEPTION 'Verified native design context required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.membership m
    JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    JOIN app.organization o ON o.id=m.tenant_id
    WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
    AND m.status='active' AND o.status='active'
    AND r.permission_grants @> '[{"code":"campaigns.write","scope":"organization"}]'::jsonb
    FOR SHARE OF m,r,o;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current native design authority unavailable' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
    AND e.feature='marketing' AND e.state='enabled' FOR SHARE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current native design capability unavailable' USING ERRCODE='42501'; END IF;
  -- Reevaluate status/grants/time after every lock wait, not transaction now().
  IF NOT EXISTS (SELECT 1 FROM app.membership m
      JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor()
      AND m.status='active' AND o.status='active'
      AND r.permission_grants @> '[{"code":"campaigns.write","scope":"organization"}]'::jsonb)
    OR NOT EXISTS (SELECT 1 FROM app.entitlement e WHERE e.tenant_id=app.current_tenant()
      AND e.feature='marketing' AND e.state='enabled'
      AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'Current native design authority unavailable' USING ERRCODE='42501';
  END IF;
END;
$$;
CREATE FUNCTION app.native_design_migration_login() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT session_user=(SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid='app.message_design'::regclass)
    AND current_setting('role',true) IN ('none',session_user::text)
$$;

-- Hidden existence check has no runtime EXECUTE grant and reveals no directory.
-- Tenant comes from the locked trigger row, never a browser/caller permission.
CREATE FUNCTION app.native_design_is_referenced(p_tenant uuid,p_id uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM app.campaign_workflow_design_reference b
      WHERE b.tenant_id=p_tenant AND b.message_design_id=p_id)
    OR EXISTS (SELECT 1 FROM app.campaign_version v
      CROSS JOIN LATERAL jsonb_path_query(v.definition,'$.**.messageDesignId') n
      WHERE v.tenant_id=p_tenant AND lower(n#>>'{}')=p_id::text)
    OR EXISTS (SELECT 1 FROM app.campaign_step s WHERE s.tenant_id=p_tenant AND s.message_design_id=p_id)
    OR EXISTS (SELECT 1 FROM app.scheduled_action a WHERE a.tenant_id=p_tenant AND a.message_design_id=p_id)
$$;

CREATE FUNCTION app.guard_native_message_design() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE runtime_login boolean := session_user='estate_runtime';
BEGIN
  IF NOT runtime_login AND NOT app.native_design_migration_login() THEN
    RAISE EXCEPTION 'Verified native design identity required' USING ERRCODE='42501';
  END IF;
  IF runtime_login THEN
    PERFORM app.native_design_lock_writer();
    IF NEW.tenant_id IS DISTINCT FROM app.current_tenant() THEN
      RAISE EXCEPTION 'Verified native design tenant required' USING ERRCODE='42501';
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
      OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.editor_kind IS DISTINCT FROM OLD.editor_kind
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version IS DISTINCT FROM OLD.version OR NEW.row_version IS DISTINCT FROM OLD.row_version
      OR NEW.history_ready IS DISTINCT FROM OLD.history_ready THEN
      RAISE EXCEPTION 'Native design identity is immutable' USING ERRCODE='23514',CONSTRAINT='native_design_identity_immutable';
    END IF;
    -- Only the actual migration owner may archive availability. This is not
    -- PATCH authority; historical content/ordinal are preserved unchanged.
    IF NOT runtime_login AND OLD.availability_state='draft' AND NEW.availability_state='archived'
      AND ROW(NEW.name,NEW.subject,NEW.design,NEW.rendered_content,NEW.content_hash)
        IS NOT DISTINCT FROM ROW(OLD.name,OLD.subject,OLD.design,OLD.rendered_content,OLD.content_hash) THEN
      IF OLD.row_version=9223372036854775807 THEN
        RAISE EXCEPTION 'Native design sequence unavailable' USING ERRCODE='23514',CONSTRAINT='native_design_sequence_available';
      END IF;
      NEW.row_version:=OLD.row_version+1; NEW.updated_at:=clock_timestamp(); RETURN NEW;
    END IF;
    IF NEW.availability_state IS DISTINCT FROM OLD.availability_state OR OLD.availability_state<>'draft'
      OR NOT OLD.history_ready THEN
      RAISE EXCEPTION 'Native design source unavailable' USING ERRCODE='23514',CONSTRAINT='native_design_source_available';
    END IF;
    IF app.native_design_is_referenced(OLD.tenant_id,OLD.id) THEN
      RAISE EXCEPTION 'Referenced native design is immutable' USING ERRCODE='23514',CONSTRAINT='native_design_unreferenced';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM app.message_design_revision r
      WHERE r.tenant_id=OLD.tenant_id AND r.message_design_id=OLD.id AND r.version=OLD.version
      AND r.source_row_version=OLD.row_version
      AND ROW(r.name,r.channel,r.subject,r.editor_kind,r.design,r.rendered_content,r.content_hash)
        IS NOT DISTINCT FROM ROW(OLD.name,OLD.channel,OLD.subject,OLD.editor_kind,OLD.design,OLD.rendered_content,OLD.content_hash)) THEN
      RAISE EXCEPTION 'Native design history unavailable' USING ERRCODE='23514',CONSTRAINT='native_design_history_available';
    END IF;
    IF OLD.version=2147483647 OR OLD.row_version=9223372036854775807 THEN
      RAISE EXCEPTION 'Native design sequence unavailable' USING ERRCODE='23514',CONSTRAINT='native_design_sequence_available';
    END IF;
    NEW.version:=OLD.version+1; NEW.row_version:=OLD.row_version+1;
  ELSE
    IF runtime_login AND (NEW.version<>1 OR NEW.row_version<>1 OR NEW.availability_state<>'draft'
      OR NEW.history_ready) THEN
      RAISE EXCEPTION 'Native design initial version required' USING ERRCODE='23514',CONSTRAINT='native_design_initial_version';
    END IF;
  END IF;
  IF NOT app.native_design_payload_valid(NEW.name,NEW.channel,NEW.subject,NEW.editor_kind,
    NEW.design,NEW.rendered_content,NEW.content_hash) THEN
    IF NOT runtime_login AND TG_OP='INSERT' THEN
      -- Explicit malformed/unlicensed fixture inserts remain unavailable and
      -- do not fabricate a revision. No ordinary runtime command permits this.
      NEW.history_ready:=false; RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Native static design invalid' USING ERRCODE='23514',CONSTRAINT='native_design_payload_valid';
  END IF;
  NEW.history_ready:=true;
  NEW.updated_at:=clock_timestamp();
  IF TG_OP='INSERT' THEN NEW.created_at:=NEW.updated_at; END IF;
  IF runtime_login THEN PERFORM app.native_design_lock_writer(); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_design_native_guard BEFORE INSERT OR UPDATE ON app.message_design
  FOR EACH ROW EXECUTE FUNCTION app.guard_native_message_design();

-- AFTER mutation copies NEW, already validated/locked by the BEFORE guard.
-- No runtime direct snapshot INSERT privilege or callable snapshot API exists.
CREATE FUNCTION app.snapshot_native_message_design() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.history_ready AND (TG_OP='INSERT' OR NEW.version<>OLD.version) THEN
    INSERT INTO app.message_design_revision
      (tenant_id,message_design_id,version,observed_at,source_row_version,name,channel,subject,
       editor_kind,design,rendered_content,content_hash)
    VALUES(NEW.tenant_id,NEW.id,NEW.version,clock_timestamp(),NEW.row_version,NEW.name,NEW.channel,NEW.subject,
      NEW.editor_kind,NEW.design,NEW.rendered_content,NEW.content_hash);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER message_design_native_snapshot AFTER INSERT OR UPDATE ON app.message_design
  FOR EACH ROW EXECUTE FUNCTION app.snapshot_native_message_design();

CREATE FUNCTION app.reject_native_design_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'Native source history is immutable' USING ERRCODE='55000'; END;
$$;
CREATE TRIGGER message_design_revision_immutable BEFORE UPDATE OR DELETE ON app.message_design_revision
  FOR EACH ROW EXECUTE FUNCTION app.reject_native_design_history_mutation();
CREATE TRIGGER campaign_workflow_design_reference_immutable BEFORE UPDATE OR DELETE ON app.campaign_workflow_design_reference
  FOR EACH ROW EXECUTE FUNCTION app.reject_native_design_history_mutation();

-- A safe legacy no-message branch: no unsafe JSON-array expansion in policies.
CREATE FUNCTION app.native_workflow_without_messages(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE node jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR jsonb_typeof(value->'nodes') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'nodes') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  FOR node IN SELECT v FROM jsonb_array_elements(value->'nodes') v LOOP
    IF jsonb_typeof(node) IS DISTINCT FROM 'object'
      OR node->>'kind' IS NULL OR node->>'kind' NOT IN ('wait','task','condition') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- Storage-proof shape guard mirrors the already approved frozen fields and
-- kind-specific semantics. The application still validates the complete DAG
-- and current CRM condition references through its existing service ports.
CREATE FUNCTION app.native_workflow_capture_shape(value jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE node jsonb; edge jsonb; filter jsonb; field text; kind text;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(value) k WHERE k NOT IN ('nodes','edges','timezone','quietHours'))
    OR jsonb_typeof(value->'nodes') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'edges') IS DISTINCT FROM 'array'
    OR jsonb_typeof(value->'timezone') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'nodes') NOT BETWEEN 1 AND 100
    OR jsonb_array_length(value->'edges')>200 OR length(value->>'timezone')>80
    OR (value->>'timezone') !~ '^(UTC|[A-Za-z_+-]+(/[A-Za-z0-9_+-]+)+)$'
    OR NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE lower(z.name)=lower(value->>'timezone')) THEN RETURN false; END IF;
  IF value ? 'quietHours' THEN
    IF jsonb_typeof(value->'quietHours') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(value->'quietHours'))<>2
      OR jsonb_typeof(value->'quietHours'->'start') IS DISTINCT FROM 'string'
      OR jsonb_typeof(value->'quietHours'->'end') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF (value->'quietHours'->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR (value->'quietHours'->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR value->'quietHours'->>'start'=value->'quietHours'->>'end' THEN RETURN false; END IF;
  END IF;
  FOR node IN SELECT n FROM jsonb_array_elements(value->'nodes') n LOOP
    IF jsonb_typeof(node) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(node))<>3
      OR jsonb_typeof(node->'key') IS DISTINCT FROM 'string'
      OR (node->>'key') !~ '^[a-z][a-z0-9_]{0,63}$'
      OR jsonb_typeof(node->'kind') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    kind:=node->>'kind';
    field:=CASE kind WHEN 'wait' THEN 'delaySeconds' WHEN 'email' THEN 'messageDesignId'
      WHEN 'sms' THEN 'messageDesignId' WHEN 'task' THEN 'taskTitle' WHEN 'condition' THEN 'condition' END;
    IF field IS NULL OR NOT (node ? field) OR EXISTS (SELECT 1 FROM jsonb_object_keys(node) k
      WHERE k NOT IN ('key','kind',field)) THEN RETURN false; END IF;
    IF kind='wait' THEN
      IF jsonb_typeof(node->'delaySeconds') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      IF (node->>'delaySeconds')::numeric NOT BETWEEN 0 AND 31536000
        OR trunc((node->>'delaySeconds')::numeric)<>(node->>'delaySeconds')::numeric THEN RETURN false; END IF;
    ELSIF kind IN ('email','sms') THEN
      IF jsonb_typeof(node->'messageDesignId') IS DISTINCT FROM 'string'
        OR (node->>'messageDesignId') !~* uuid_pattern THEN RETURN false; END IF;
    ELSIF kind='task' THEN
      IF jsonb_typeof(node->'taskTitle') IS DISTINCT FROM 'string'
        OR NOT app.native_design_nonblank(node->>'taskTitle') OR length(node->>'taskTitle')>200 THEN RETURN false; END IF;
    ELSE
      filter:=node->'condition';
      IF jsonb_typeof(filter) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(filter)) NOT BETWEEN 1 AND 6
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(filter) k
          WHERE k NOT IN ('stageId','ownerMemberId','sourceId','tagIds','q','intent')) THEN RETURN false; END IF;
      FOREACH field IN ARRAY ARRAY['stageId','ownerMemberId','sourceId'] LOOP
        IF filter ? field AND (jsonb_typeof(filter->field) IS DISTINCT FROM 'string'
          OR (filter->>field) !~* uuid_pattern) THEN RETURN false; END IF;
      END LOOP;
      IF filter ? 'tagIds' THEN
        IF jsonb_typeof(filter->'tagIds') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(filter->'tagIds') NOT BETWEEN 1 AND 20
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(filter->'tagIds') tag
            WHERE jsonb_typeof(tag) IS DISTINCT FROM 'string' OR (tag#>>'{}') !~* uuid_pattern)
          OR (SELECT count(DISTINCT lower(tag#>>'{}')) FROM jsonb_array_elements(filter->'tagIds') tag)
            <>jsonb_array_length(filter->'tagIds') THEN RETURN false; END IF;
      END IF;
      IF filter ? 'q' AND (jsonb_typeof(filter->'q') IS DISTINCT FROM 'string'
        OR NOT app.native_design_nonblank(filter->>'q') OR length(filter->>'q')>200) THEN RETURN false; END IF;
      IF filter ? 'intent' AND (jsonb_typeof(filter->'intent') IS DISTINCT FROM 'string'
        OR filter->>'intent' NOT IN ('buyer','seller','both','unknown')) THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT n->>'key') FROM jsonb_array_elements(value->'nodes') n)
    <>jsonb_array_length(value->'nodes') THEN RETURN false; END IF;
  FOR edge IN SELECT e FROM jsonb_array_elements(value->'edges') e LOOP
    IF jsonb_typeof(edge) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(edge))<>3
      OR jsonb_typeof(edge->'from') IS DISTINCT FROM 'string'
      OR jsonb_typeof(edge->'to') IS DISTINCT FROM 'string'
      OR jsonb_typeof(edge->'branch') IS DISTINCT FROM 'string'
      OR edge->>'branch' NOT IN ('always','true','false')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'nodes') n WHERE n->>'key'=edge->>'from')
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'nodes') n WHERE n->>'key'=edge->>'to') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

-- Runs alphabetically AFTER campaign_version_native_sequence, preserving its
-- parent/member/capability lock order. The flag is inaccessible to runtime DML.
CREATE FUNCTION app.prepare_native_workflow_design_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE design_id uuid; source app.message_design%ROWTYPE;
BEGIN
  IF session_user<>'estate_runtime' THEN
    IF NOT app.native_design_migration_login() THEN
      RAISE EXCEPTION 'Verified workflow identity required' USING ERRCODE='42501';
    END IF;
    -- Explicit migration workflow fixtures remain unresolved if message-bearing;
    -- unlike new design INSERT, a historical workflow's source time is unknown.
    NEW.design_bindings_ready:=false; RETURN NEW;
  END IF;
  PERFORM app.native_design_lock_writer();
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant() OR NEW.state<>'draft' OR NEW.published_at IS NOT NULL
    OR NOT app.native_workflow_capture_shape(NEW.definition) THEN
    RAISE EXCEPTION 'Native workflow source proof unavailable' USING ERRCODE='23514',CONSTRAINT='native_workflow_design_source';
  END IF;
  -- Canonical distinct UUID sort takes one SHARE lock for repeated source nodes.
  FOR design_id IN SELECT DISTINCT (value->>'messageDesignId')::uuid
    FROM jsonb_array_elements(NEW.definition->'nodes') WHERE value->>'kind' IN ('email','sms')
    ORDER BY 1 LOOP
    SELECT * INTO source FROM app.message_design d WHERE d.tenant_id=NEW.tenant_id AND d.id=design_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Native workflow source proof unavailable' USING ERRCODE='23514',CONSTRAINT='native_workflow_design_source';
    END IF;
    -- Post-lock source requery prevents a predicate evaluated before waiting
    -- from authorizing archived, unproven or mismatched current fields.
    SELECT * INTO source FROM app.message_design d WHERE d.tenant_id=NEW.tenant_id AND d.id=design_id
      AND d.availability_state='draft' AND d.history_ready AND d.editor_kind='native';
    IF NOT FOUND OR NOT app.native_design_payload_valid(source.name,source.channel,source.subject,source.editor_kind,
      source.design,source.rendered_content,source.content_hash)
      OR NOT EXISTS (SELECT 1 FROM app.message_design_revision r WHERE r.tenant_id=NEW.tenant_id
        AND r.message_design_id=design_id AND r.version=source.version
        AND r.source_row_version=source.row_version
        AND ROW(r.name,r.channel,r.subject,r.editor_kind,r.design,r.rendered_content,r.content_hash)
          IS NOT DISTINCT FROM ROW(source.name,source.channel,source.subject,source.editor_kind,source.design,source.rendered_content,source.content_hash))
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.definition->'nodes') n
        WHERE CASE WHEN n->>'kind' IN ('email','sms') THEN (n->>'messageDesignId')::uuid END=design_id
        AND n->>'kind'<>source.channel) THEN
      RAISE EXCEPTION 'Native workflow source proof unavailable' USING ERRCODE='23514',CONSTRAINT='native_workflow_design_source';
    END IF;
  END LOOP;
  PERFORM app.native_design_lock_writer();
  -- Source reads additionally need current organization campaigns.read; no
  -- write-only permission is treated as evidence for referenced content use.
  IF NOT EXISTS (SELECT 1 FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    WHERE m.tenant_id=app.current_tenant() AND m.user_id=app.current_actor() AND m.status='active'
    AND r.permission_grants @> '[{"code":"campaigns.read","scope":"organization"}]'::jsonb)
    AND NOT app.native_workflow_without_messages(NEW.definition) THEN
    RAISE EXCEPTION 'Current workflow source authority unavailable' USING ERRCODE='42501';
  END IF;
  -- Source SHARE locks remain held. The deferred parent FK permits atomic
  -- binding insertion before new-row RETURNING evaluates SELECT proof.
  INSERT INTO app.campaign_workflow_design_reference
    (tenant_id,campaign_version_id,node_key,message_design_id,design_version,content_hash,captured_at,
     captured_campaign_id,initiating_actor_id,capture_transaction,definition_hash)
  SELECT NEW.tenant_id,NEW.id,n->>'key',d.id,d.version,d.content_hash,clock_timestamp(),
    NEW.campaign_id,app.current_actor(),pg_current_xact_id(),
    encode(sha256(convert_to(NEW.definition::text,'UTF8')),'hex')
    FROM jsonb_array_elements(NEW.definition->'nodes') n JOIN app.message_design d
    ON d.tenant_id=NEW.tenant_id
    AND d.id=CASE WHEN n->>'kind' IN ('email','sms') THEN (n->>'messageDesignId')::uuid END
    WHERE n->>'kind' IN ('email','sms');
  PERFORM app.native_design_lock_writer();
  NEW.design_bindings_ready:=true; RETURN NEW;
END;
$$;
CREATE TRIGGER campaign_version_zz_native_design_prepare BEFORE INSERT ON app.campaign_version
  FOR EACH ROW EXECUTE FUNCTION app.prepare_native_workflow_design_bindings();

-- Narrow scoped Boolean proof avoids recursive RLS (binding reads in this
-- function execute under its owner) and exposes no history content/directory.
CREATE FUNCTION app.native_workflow_reference_proof(p_tenant uuid,p_version uuid,p_definition jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE node jsonb; source_id uuid; message_count integer:=0; valid_count integer;
  stored app.campaign_version%ROWTYPE; new_capture boolean:=false; graph_hash text;
BEGIN
  IF session_user<>'estate_runtime' OR current_setting('role',true) NOT IN ('none','estate_runtime')
    OR p_tenant IS DISTINCT FROM app.current_tenant() OR app.current_actor() IS NULL
    OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition->'nodes') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_definition->'nodes') NOT BETWEEN 1 AND 100 THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
      JOIN app.organization o ON o.id=m.tenant_id
      WHERE m.tenant_id=p_tenant AND m.user_id=app.current_actor() AND m.status='active' AND o.status='active'
      AND (r.permission_grants @> '[{"code":"campaigns.read","scope":"organization"}]'::jsonb
        OR r.permission_grants @> '[{"code":"campaigns.write","scope":"organization"}]'::jsonb))
    OR NOT EXISTS (SELECT 1 FROM app.entitlement e WHERE e.tenant_id=p_tenant AND e.feature='marketing'
      AND e.state='enabled' AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())) THEN RETURN false; END IF;
  graph_hash:=encode(sha256(convert_to(p_definition::text,'UTF8')),'hex');
  -- Existing rows must actually be readable drafts. Privileged lookup is only
  -- inside the already verified current tenant; hidden published/history rows
  -- return false even when a caller supplies their exact remembered graph.
  SELECT * INTO stored FROM app.campaign_version v
    WHERE v.tenant_id=p_tenant AND v.id=p_version;
  IF FOUND THEN
    IF stored.state IS DISTINCT FROM 'draft' OR stored.published_at IS NOT NULL
      OR NOT stored.design_bindings_ready OR stored.definition IS DISTINCT FROM p_definition
      OR NOT EXISTS (SELECT 1 FROM app.campaign c WHERE c.tenant_id=p_tenant
        AND c.id=stored.campaign_id AND c.state='draft') THEN RETURN false; END IF;
  ELSE
    -- INSERT RETURNING checks SELECT WCOs before the tuple exists. Only private
    -- BEFORE-trigger proof from this exact transaction/actor/graph may pass;
    -- the deferred workflow FK requires that same new row before COMMIT.
    new_capture:=true;
    IF NOT EXISTS (SELECT 1 FROM app.campaign_workflow_design_reference b
      JOIN app.campaign c ON (c.tenant_id,c.id)=(b.tenant_id,b.captured_campaign_id)
      WHERE b.tenant_id=p_tenant AND b.campaign_version_id=p_version
      AND b.initiating_actor_id=app.current_actor() AND b.capture_transaction=pg_current_xact_id()
      AND b.definition_hash=graph_hash AND c.state='draft') THEN RETURN false; END IF;
  END IF;
  FOR node IN SELECT value FROM jsonb_array_elements(p_definition->'nodes') LOOP
    IF jsonb_typeof(node) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF node->>'kind' NOT IN ('email','sms') THEN CONTINUE; END IF;
    IF jsonb_typeof(node->'messageDesignId') IS DISTINCT FROM 'string'
      OR (node->>'messageDesignId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(node->'key') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    source_id:=(node->>'messageDesignId')::uuid; message_count:=message_count+1;
    IF NOT EXISTS (SELECT 1 FROM app.campaign_workflow_design_reference b
      JOIN app.message_design d ON (d.tenant_id,d.id)=(b.tenant_id,b.message_design_id)
      JOIN app.message_design_revision r ON (r.tenant_id,r.message_design_id,r.version,r.content_hash)
        =(b.tenant_id,b.message_design_id,b.design_version,b.content_hash)
      WHERE b.tenant_id=p_tenant AND b.campaign_version_id=p_version AND b.node_key=node->>'key'
        AND b.message_design_id=source_id AND d.channel=node->>'kind'
        AND d.availability_state='draft' AND d.history_ready AND d.editor_kind='native'
        AND d.version=b.design_version AND d.content_hash=b.content_hash
        AND d.row_version=r.source_row_version
        AND b.definition_hash=graph_hash
        AND (NOT new_capture OR (b.initiating_actor_id=app.current_actor()
          AND b.capture_transaction=pg_current_xact_id()
          AND EXISTS (SELECT 1 FROM app.campaign c WHERE c.tenant_id=p_tenant
            AND c.id=b.captured_campaign_id AND c.state='draft')))
        AND (new_capture OR b.captured_campaign_id=stored.campaign_id)
        AND ROW(d.name,d.channel,d.subject,d.editor_kind,d.design,d.rendered_content,d.content_hash)
          IS NOT DISTINCT FROM ROW(r.name,r.channel,r.subject,r.editor_kind,r.design,r.rendered_content,r.content_hash)) THEN RETURN false; END IF;
  END LOOP;
  SELECT count(*) INTO valid_count FROM app.campaign_workflow_design_reference b
    WHERE b.tenant_id=p_tenant AND b.campaign_version_id=p_version;
  RETURN message_count>0 AND valid_count=message_count;
END;
$$;

-- Forward replacement is explicit. Keep source FOR SHARE possible through
-- UPDATE USING, while real mutations require write scope and BEFORE guards.
DROP POLICY runtime_workflow_design_source ON app.message_design;
CREATE POLICY runtime_native_design_select ON app.message_design AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND availability_state='draft' AND history_ready AND editor_kind='native'
    AND (app.native_design_context('campaigns.read') OR app.native_design_context('campaigns.write')));
CREATE POLICY runtime_native_design_insert ON app.message_design AS RESTRICTIVE FOR INSERT TO estate_runtime
  WITH CHECK (tenant_id=app.current_tenant() AND availability_state='draft' AND history_ready AND editor_kind='native'
    AND version=1 AND row_version=1 AND app.native_design_context('campaigns.write'));
CREATE POLICY runtime_native_design_update ON app.message_design AS RESTRICTIVE FOR UPDATE TO estate_runtime
  USING (tenant_id=app.current_tenant() AND availability_state='draft' AND history_ready AND editor_kind='native'
    AND (app.native_design_context('campaigns.read') OR app.native_design_context('campaigns.write')))
  WITH CHECK (tenant_id=app.current_tenant() AND availability_state='draft' AND history_ready AND editor_kind='native'
    AND app.native_design_context('campaigns.write'));
CREATE POLICY runtime_native_design_delete ON app.message_design AS RESTRICTIVE FOR DELETE TO estate_runtime USING (false);
CREATE POLICY runtime_workflow_source_proof ON app.campaign_version AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING ((app.native_design_context('campaigns.read') OR app.native_design_context('campaigns.write'))
    AND (app.native_workflow_without_messages(definition)
      OR (design_bindings_ready AND app.native_workflow_reference_proof(tenant_id,id,definition))));

CREATE POLICY runtime_native_revision_current ON app.message_design_revision AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND EXISTS (SELECT 1 FROM app.message_design d
    WHERE d.tenant_id=app.current_tenant() AND d.id=message_design_id AND d.version=message_design_revision.version));
CREATE POLICY runtime_native_binding_read ON app.campaign_workflow_design_reference AS RESTRICTIVE FOR SELECT TO estate_runtime
  USING (tenant_id=app.current_tenant() AND app.native_design_context('campaigns.read')
    AND EXISTS (SELECT 1 FROM app.campaign_version v WHERE v.tenant_id=app.current_tenant()
      AND v.id=campaign_version_id AND v.design_bindings_ready AND v.state='draft')
    AND EXISTS (SELECT 1 FROM app.message_design d WHERE d.tenant_id=app.current_tenant()
      AND d.id=message_design_id AND d.version=design_version AND d.content_hash=campaign_workflow_design_reference.content_hash));

GRANT INSERT(tenant_id,id,name,channel,subject,editor_kind,design,rendered_content,content_hash)
  ON app.message_design TO estate_runtime;
GRANT UPDATE(name,subject,design,rendered_content,content_hash,row_version) ON app.message_design TO estate_runtime;
-- No source-body history directory: only current snapshot identifiers/hash.
GRANT SELECT(tenant_id,message_design_id,version,content_hash,source_row_version)
  ON app.message_design_revision TO estate_runtime;
GRANT SELECT(tenant_id,campaign_version_id,node_key,message_design_id,design_version,content_hash)
  ON app.campaign_workflow_design_reference TO estate_runtime;
REVOKE ALL ON app.message_design_revision,app.campaign_workflow_design_reference FROM estate_worker,estate_control,estate_staff_issuer;
REVOKE INSERT,UPDATE,DELETE ON app.message_design_revision,app.campaign_workflow_design_reference FROM estate_runtime;

REVOKE ALL ON FUNCTION app.native_design_nonblank(text),app.native_design_static_text(text),
  app.native_design_payload_valid(text,text,text,text,jsonb,text,text),app.native_design_context(text),
  app.native_design_lock_writer(),app.native_design_migration_login(),app.native_design_is_referenced(uuid,uuid),
  app.guard_native_message_design(),app.snapshot_native_message_design(),app.reject_native_design_history_mutation(),
  app.native_workflow_without_messages(jsonb),app.prepare_native_workflow_design_bindings(),
  app.native_workflow_capture_shape(jsonb),
  app.native_workflow_reference_proof(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_design_context(text),app.native_workflow_without_messages(jsonb),
  app.native_workflow_reference_proof(uuid,uuid,jsonb) TO estate_runtime;

-- No snapshot/binding backfill, legacy UPDATE, trigger disabling, public history
-- endpoint, lifecycle/publish/step/schedule/enrollment/provider/worker grants.
COMMIT;
