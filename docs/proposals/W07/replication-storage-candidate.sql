-- PROPOSAL ONLY: coordinator-owned allocation and actual-login verification required.
-- Do not run against the shared estate. This is not a numbered migration or a SQL sink.
-- Baseline: approved 0001-0019, ADR-025, ordered-source.ts fixed seven-operation manifest.
-- No live source, raw provider page, send permission, router or worker registration.
BEGIN;

DO $candidate$
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_roles
      WHERE rolname IN ('estate_runtime','estate_worker')
        AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb) <> 2
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='app' AND r.rolname IN ('estate_runtime','estate_worker')) THEN
    RAISE EXCEPTION 'Non-owner runtime and worker identities required' USING ERRCODE='42501';
  END IF;
END;
$candidate$;

-- Null legacy metadata remains unapproved; no backfill, cursor reset or historical inference.
ALTER TABLE app.mls_feed
  ADD COLUMN replication_policy_version text,
  ADD COLUMN mock_stream_generation uuid,
  ADD COLUMN mock_order_profile text,
  ADD COLUMN replication_identity_retain_until timestamptz,
  ADD COLUMN last_replication_receipt_id text,
  ADD CONSTRAINT mls_replication_profile_shape CHECK (
    (replication_policy_version IS NULL AND mock_stream_generation IS NULL AND mock_order_profile IS NULL
      AND replication_identity_retain_until IS NULL)
    OR (replication_policy_version IS NOT NULL AND mock_stream_generation IS NOT NULL
      AND mock_order_profile IS NOT NULL AND length(btrim(replication_policy_version)) BETWEEN 1 AND 200
      AND mock_stream_generation='5d753531-7ad1-4bc4-87a2-036cf442f527'::uuid
      AND mock_order_profile='ordered-synthetic-v1' AND replication_identity_retain_until IS NOT NULL)),
  ADD CONSTRAINT mls_feed_replication_identity UNIQUE
    (tenant_id,id,replication_policy_version,mock_stream_generation);
ALTER TABLE app.listing ADD CONSTRAINT listing_replication_identity UNIQUE
  (tenant_id,feed_id,source_listing_key,id);
ALTER TABLE app.mls_checkpoint
  ADD COLUMN mock_stream_generation uuid,
  ADD COLUMN last_replication_receipt_id text,
  ADD CONSTRAINT mls_checkpoint_feed_identity UNIQUE(tenant_id,feed_id,id);
ALTER TABLE app.mls_sync_run
  ADD COLUMN job_id uuid,
  ADD COLUMN requesting_member_id uuid,
  ADD COLUMN initiating_actor_id uuid REFERENCES app.user_identity(id),
  ADD COLUMN policy_version text,
  ADD COLUMN stream_generation uuid,
  ADD COLUMN claim_fence uuid,
  ADD COLUMN claim_attempt integer,
  ADD COLUMN claim_lease_until timestamptz,
  ADD COLUMN retry_not_before timestamptz,
  ADD CONSTRAINT mls_run_job UNIQUE(tenant_id,job_id),
  ADD CONSTRAINT mls_run_feed_identity UNIQUE(tenant_id,feed_id,id),
  ADD CONSTRAINT mls_run_job_fk FOREIGN KEY(tenant_id,job_id)
    REFERENCES app.integration_job(tenant_id,id),
  ADD CONSTRAINT mls_run_member_fk FOREIGN KEY(tenant_id,requesting_member_id)
    REFERENCES app.membership(tenant_id,id),
  ADD CONSTRAINT mls_run_profile_fk FOREIGN KEY(tenant_id,feed_id,policy_version,stream_generation)
    REFERENCES app.mls_feed(tenant_id,id,replication_policy_version,mock_stream_generation),
  ADD CONSTRAINT mls_run_binding_shape CHECK (
    (job_id IS NULL AND requesting_member_id IS NULL AND initiating_actor_id IS NULL
      AND policy_version IS NULL AND stream_generation IS NULL AND claim_fence IS NULL
      AND claim_attempt IS NULL AND claim_lease_until IS NULL AND retry_not_before IS NULL)
    OR (job_id IS NOT NULL AND requesting_member_id IS NOT NULL AND initiating_actor_id IS NOT NULL
      AND policy_version IS NOT NULL AND stream_generation IS NOT NULL
      AND ((claim_fence IS NULL AND claim_attempt IS NULL AND claim_lease_until IS NULL)
        OR (claim_fence IS NOT NULL AND claim_attempt IS NOT NULL AND claim_attempt>0 AND claim_lease_until IS NOT NULL))));

CREATE TABLE app.mls_replication_page_receipt (
  tenant_id uuid NOT NULL,
  feed_id uuid NOT NULL,
  resource text NOT NULL DEFAULT 'listing' CHECK(resource='listing'),
  receipt_id text NOT NULL CHECK(receipt_id ~ '^[a-f0-9]{64}$'),
  checkpoint_id uuid NOT NULL,
  run_id uuid NOT NULL,
  initiating_actor_id uuid NOT NULL REFERENCES app.user_identity(id),
  requesting_member_id uuid NOT NULL,
  policy_version text NOT NULL,
  stream_generation uuid NOT NULL,
  claim_fence uuid NOT NULL,
  claim_attempt integer NOT NULL CHECK(claim_attempt>0),
  feed_revision bigint NOT NULL CHECK(feed_revision BETWEEN 1 AND 9007199254740991),
  connection_revision bigint NOT NULL CHECK(connection_revision BETWEEN 1 AND 9007199254740991),
  rights_fingerprint text NOT NULL CHECK(rights_fingerprint ~ '^[a-f0-9]{64}$'),
  expected_sql_version bigint NOT NULL CHECK(expected_sql_version>0),
  next_sql_version bigint NOT NULL CHECK(next_sql_version=expected_sql_version+1),
  expected_revision bigint NOT NULL CHECK(expected_revision BETWEEN 0 AND 9007199254740990),
  next_revision bigint NOT NULL CHECK(next_revision=expected_revision+1),
  expected_checkpoint jsonb NOT NULL CHECK(pg_column_size(expected_checkpoint)<=65536),
  next_checkpoint jsonb NOT NULL CHECK(pg_column_size(next_checkpoint)<=65536),
  source_proof jsonb NOT NULL CHECK(pg_column_size(source_proof)<=65536),
  audit_event_id uuid NOT NULL,
  write_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,feed_id,receipt_id),
  UNIQUE(tenant_id,audit_event_id),
  UNIQUE(tenant_id,write_xid),
  UNIQUE(tenant_id,checkpoint_id,expected_revision),
  UNIQUE(tenant_id,checkpoint_id,expected_sql_version),
  FOREIGN KEY(tenant_id,feed_id,checkpoint_id) REFERENCES app.mls_checkpoint(tenant_id,feed_id,id),
  FOREIGN KEY(tenant_id,feed_id,run_id) REFERENCES app.mls_sync_run(tenant_id,feed_id,id),
  FOREIGN KEY(tenant_id,requesting_member_id) REFERENCES app.membership(tenant_id,id),
  FOREIGN KEY(tenant_id,feed_id,policy_version,stream_generation)
    REFERENCES app.mls_feed(tenant_id,id,replication_policy_version,mock_stream_generation),
  FOREIGN KEY(tenant_id,audit_event_id) REFERENCES app.audit_event(tenant_id,id)
    DEFERRABLE INITIALLY DEFERRED
);

-- Source state is an immutable native-ID reservation, not an independently writable latest-value cache.
-- Latest sequence and sticky tombstones are derived from the immutable ordered-entry ledger.
CREATE TABLE app.mls_replication_source_state (
  tenant_id uuid NOT NULL,
  feed_id uuid NOT NULL,
  source_listing_key text NOT NULL CHECK(length(source_listing_key)<=200 AND source_listing_key LIKE 'SYNTHETIC-%'),
  stream_generation uuid NOT NULL CHECK(stream_generation='5d753531-7ad1-4bc4-87a2-036cf442f527'::uuid),
  listing_id uuid,
  first_change_id text NOT NULL,
  first_receipt_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,feed_id,source_listing_key),
  UNIQUE(tenant_id,feed_id,listing_id),
  UNIQUE(tenant_id,feed_id,source_listing_key,listing_id),
  FOREIGN KEY(tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id),
  FOREIGN KEY(tenant_id,feed_id,source_listing_key,listing_id)
    REFERENCES app.listing(tenant_id,feed_id,source_listing_key,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(tenant_id,feed_id,first_receipt_id)
    REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id)
);
CREATE TABLE app.mls_replication_source_entry (
  tenant_id uuid NOT NULL,
  feed_id uuid NOT NULL,
  stream_generation uuid NOT NULL CHECK(stream_generation='5d753531-7ad1-4bc4-87a2-036cf442f527'::uuid),
  change_id text NOT NULL CHECK(length(change_id)<=200 AND change_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  source_sequence bigint NOT NULL CHECK(source_sequence BETWEEN 1 AND 9007199254740991),
  source_listing_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('upsert','delete')),
  source_state text NOT NULL CHECK(source_state IN ('active','pending','closed','off_market','deleted')),
  observed_at timestamptz NOT NULL,
  source_modified_at timestamptz,
  source_ingested_at timestamptz,
  source_expires_at timestamptz,
  source_content_hash text NOT NULL CHECK(source_content_hash ~ '^[a-f0-9]{64}$'),
  disposition text NOT NULL CHECK(disposition IN ('applied','historical','tombstoned')),
  listing_id uuid,
  resulting_native_version bigint CHECK(resulting_native_version BETWEEN 1 AND 9007199254740991),
  first_receipt_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,feed_id,stream_generation,change_id),
  UNIQUE(tenant_id,feed_id,stream_generation,source_sequence),
  UNIQUE(tenant_id,feed_id,listing_id,resulting_native_version),
  FOREIGN KEY(tenant_id,feed_id,source_listing_key)
    REFERENCES app.mls_replication_source_state(tenant_id,feed_id,source_listing_key),
  FOREIGN KEY(tenant_id,feed_id,source_listing_key,listing_id)
    REFERENCES app.mls_replication_source_state(tenant_id,feed_id,source_listing_key,listing_id),
  FOREIGN KEY(tenant_id,feed_id,first_receipt_id)
    REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id),
  CHECK ((kind='delete' AND source_state='deleted' AND source_modified_at IS NULL
      AND source_ingested_at IS NULL AND source_expires_at IS NULL)
    OR (kind='upsert' AND source_state<>'deleted' AND source_ingested_at IS NOT NULL
      AND source_expires_at IS NOT NULL AND source_expires_at>source_ingested_at AND source_ingested_at<=observed_at)),
  CHECK ((disposition='applied' AND listing_id IS NOT NULL AND resulting_native_version IS NOT NULL)
    OR (disposition<>'applied' AND resulting_native_version IS NULL))
);
ALTER TABLE app.mls_replication_source_state ADD CONSTRAINT mls_state_first_entry_fk
  FOREIGN KEY(tenant_id,feed_id,stream_generation,first_change_id)
  REFERENCES app.mls_replication_source_entry(tenant_id,feed_id,stream_generation,change_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE app.listing
  ADD COLUMN replication_generation uuid,
  ADD COLUMN replication_change_id text,
  ADD COLUMN replication_receipt_id text,
  ADD CONSTRAINT listing_replication_entry_fk
    FOREIGN KEY(tenant_id,feed_id,replication_generation,replication_change_id)
    REFERENCES app.mls_replication_source_entry(tenant_id,feed_id,stream_generation,change_id),
  ADD CONSTRAINT listing_replication_receipt_fk FOREIGN KEY(tenant_id,feed_id,replication_receipt_id)
    REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id);
ALTER TABLE app.mls_checkpoint ADD CONSTRAINT checkpoint_replication_receipt_fk
  FOREIGN KEY(tenant_id,feed_id,last_replication_receipt_id)
  REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id);
ALTER TABLE app.mls_feed ADD CONSTRAINT feed_replication_receipt_fk
  FOREIGN KEY(tenant_id,id,last_replication_receipt_id)
  REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id);
ALTER TABLE app.outbox
  ADD COLUMN mls_replication_feed_id uuid,
  ADD COLUMN mls_replication_receipt_id text,
  ADD CONSTRAINT outbox_replication_receipt_fk FOREIGN KEY(tenant_id,mls_replication_feed_id,mls_replication_receipt_id)
    REFERENCES app.mls_replication_page_receipt(tenant_id,feed_id,receipt_id),
  ADD CONSTRAINT outbox_replication_binding CHECK (
    (mls_replication_feed_id IS NULL)=(mls_replication_receipt_id IS NULL));

-- pg_catalog SHA-256 exists in PostgreSQL17; no new extension/dependency is proposed.
-- This canonicalizer is deliberately bounded to the registered fixture/closed metadata domain.
-- Coordinator must verify numeric/Unicode vectors against Node before approving it.
CREATE FUNCTION app.mls_replication_canonical(j jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      SELECT '{'||coalesce(string_agg(to_jsonb(key)::text||':'||app.mls_replication_canonical(value),
        ',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(j);
    WHEN 'array' THEN
      SELECT '['||coalesce(string_agg(app.mls_replication_canonical(value),',' ORDER BY ordinal),'')||']'
        INTO result FROM jsonb_array_elements(j) WITH ORDINALITY AS items(value,ordinal);
    WHEN 'number' THEN
      result:=j::text;
      IF position('.' IN result)>0 THEN result:=rtrim(rtrim(result,'0'),'.'); END IF;
    ELSE result:=j::text;
  END CASE;
  RETURN result;
END;
$fn$;
CREATE FUNCTION app.mls_replication_hash(j jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $fn$
  SELECT encode(sha256(convert_to(app.mls_replication_canonical(j),'UTF8')),'hex');
$fn$;
CREATE FUNCTION app.mls_replication_object(j jsonb, keys text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
BEGIN
  IF j IS NULL OR jsonb_typeof(j)<>'object' THEN RETURN false; END IF;
  RETURN coalesce((SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(j) key)
    = (SELECT array_agg(key ORDER BY key COLLATE "C") FROM unnest(keys) key),false);
END;
$fn$;
CREATE FUNCTION app.mls_replication_integer(j jsonb, low numeric, high numeric) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE n numeric;
BEGIN
  IF j IS NULL OR jsonb_typeof(j)<>'number' THEN RETURN false; END IF;
  n:=(j#>>'{}')::numeric;
  RETURN n=trunc(n) AND n BETWEEN low AND high;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;
CREATE FUNCTION app.mls_replication_utc(j jsonb) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v text; t timestamptz;
BEGIN
  IF jsonb_typeof(j)='null' THEN RETURN NULL; END IF;
  IF j IS NULL OR jsonb_typeof(j)<>'string' THEN RAISE EXCEPTION 'UTC source time required'; END IF;
  v:=j#>>'{}';
  IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$' THEN
    RAISE EXCEPTION 'UTC source time required';
  END IF;
  t:=v::timestamptz;
  IF v IS DISTINCT FROM to_char(t AT TIME ZONE 'UTC',
      CASE WHEN position('.' IN v)>0 THEN 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"' ELSE 'YYYY-MM-DD"T"HH24:MI:SS"Z"' END) THEN
    RAISE EXCEPTION 'UTC source time required';
  END IF;
  RETURN t;
END;
$fn$;

-- Permission catalog says mls.sync has ONLY organization scope; feature mapping is mls.
-- Actor predicates have no ledger/source-table dependency and are invoker functions.
CREATE FUNCTION app.mls_replication_actor_ok(t uuid, member uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $fn$
  SELECT coalesce(t=app.current_tenant() AND app.current_actor() IS NOT NULL AND EXISTS(
    SELECT 1 FROM app.membership m
    JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    JOIN app.organization o ON o.id=m.tenant_id
    JOIN app.entitlement e ON e.tenant_id=m.tenant_id AND e.feature='mls'
    WHERE m.tenant_id=t AND m.user_id=app.current_actor() AND m.status='active' AND o.status='active'
      AND (member IS NULL OR m.id=member) AND e.state='enabled'
      AND (e.effective_until IS NULL OR e.effective_until>clock_timestamp())
      AND (SELECT count(*) FROM jsonb_array_elements(r.permission_grants) g WHERE g->>'code'='mls.sync')=1
      AND r.permission_grants @> '[{"code":"mls.sync","scope":"organization"}]'::jsonb
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.permission_grants) g
        WHERE g='{"code":"mls.sync","scope":"organization"}'::jsonb)),false);
$fn$;

CREATE FUNCTION app.mls_replication_policy_ok(dp jsonb, nr jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v jsonb; field text;
BEGIN
  IF NOT app.mls_replication_object(dp,ARRAY['version','allowedStatuses','displayFields','maxStaleSeconds',
      'refreshSeconds','rawRetentionSeconds','mediaCacheSeconds','allowAiUse','allowReplication','attributionText','approved'])
    OR NOT app.mls_replication_object(nr,ARRAY['approvalState','rights','allowedFields','addressRule','locationRule',
      'maxDataAgeSeconds','maxCacheAgeSeconds','retentionDays','attributionText','attributionLogoAssetId','disclaimerVersion'])
    OR dp->'approved' IS DISTINCT FROM 'true'::jsonb OR dp->'allowReplication' IS DISTINCT FROM 'true'::jsonb
    OR NOT app.mls_replication_integer(dp->'version',1,9007199254740991)
    OR NOT app.mls_replication_integer(dp->'maxStaleSeconds',1,86400)
    OR NOT app.mls_replication_integer(dp->'refreshSeconds',1,86400)
    OR NOT app.mls_replication_integer(dp->'rawRetentionSeconds',1,31536000)
    OR NOT app.mls_replication_integer(dp->'mediaCacheSeconds',0,31536000)
    OR jsonb_typeof(dp->'allowAiUse') IS DISTINCT FROM 'boolean'
    OR nr->>'approvalState' IS DISTINCT FROM 'approved'
    OR NOT app.mls_replication_object(nr->'rights',ARRAY['display','replicate','cache','storeMedia','alerts','aiUse'])
    OR nr#>>'{rights,replicate}' IS DISTINCT FROM 'allowed'
    OR (nr->>'addressRule'=ANY(ARRAY['visible','hidden','listing_specific'])) IS DISTINCT FROM true
    OR (nr->>'locationRule'=ANY(ARRAY['exact','coarse','hidden','listing_specific'])) IS DISTINCT FROM true
    OR jsonb_typeof(nr->'maxDataAgeSeconds') IS DISTINCT FROM 'number'
    OR jsonb_typeof(nr->'retentionDays') IS DISTINCT FROM 'number'
    OR (nr->>'maxDataAgeSeconds')::numeric<=0 OR (nr->>'retentionDays')::numeric<=0
    OR (nr->>'maxDataAgeSeconds')::numeric>9007199254740991
    OR (nr->>'retentionDays')::numeric>9007199254740991
    OR jsonb_typeof(nr->'allowedFields') IS DISTINCT FROM 'array'
    OR jsonb_typeof(dp->'displayFields') IS DISTINCT FROM 'array'
    OR jsonb_typeof(dp->'allowedStatuses') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(nr->'allowedFields')>100 OR jsonb_array_length(dp->'displayFields')>100
    OR jsonb_array_length(dp->'allowedStatuses')>4 THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_each(nr->'rights') LOOP
    IF jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('allowed','denied','unknown') THEN RETURN false; END IF;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements((nr->'allowedFields')||(dp->'displayFields')) LOOP
    IF jsonb_typeof(v)<>'string' OR length(v#>>'{}')>80 THEN RETURN false; END IF;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(dp->'allowedStatuses') LOOP
    IF jsonb_typeof(v)<>'string' OR v#>>'{}' NOT IN ('active','pending','closed','off_market') THEN RETURN false; END IF;
  END LOOP;
  -- Conservative storage gate for this complete fixed fixture, independent of public projection.
  FOREACH field IN ARRAY ARRAY['status','listPrice','bedrooms','bathrooms','area','address','coordinates',
      'publicRemarks','propertyType','sourceModifiedAt','attribution.brokerage','attribution.agent',
      'attribution.disclaimer','attribution.contact'] LOOP
    IF NOT (nr->'allowedFields') ? field THEN RETURN false; END IF;
  END LOOP;
  FOREACH field IN ARRAY ARRAY['maxCacheAgeSeconds'] LOOP
    IF nr->field<>'null'::jsonb AND (jsonb_typeof(nr->field)<>'number' OR (nr->>field)::numeric<0) THEN RETURN false; END IF;
  END LOOP;
  RETURN jsonb_typeof(dp->'attributionText')='string' AND length(dp->>'attributionText')<=2000
    AND jsonb_typeof(nr->'attributionText')='string' AND length(nr->>'attributionText')<=2000
    AND jsonb_typeof(nr->'disclaimerVersion')='string' AND length(nr->>'disclaimerVersion')<=200
    AND (nr->'attributionLogoAssetId'='null'::jsonb OR
      (jsonb_typeof(nr->'attributionLogoAssetId')='string' AND length(nr->>'attributionLogoAssetId')<=200));
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;

CREATE FUNCTION app.mls_replication_feed_ok(t uuid, feed uuid) RETURNS boolean
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $fn$
  SELECT app.mls_replication_actor_ok(t) AND EXISTS(
    SELECT 1 FROM app.mls_feed f JOIN app.integration_connection c
      ON (c.tenant_id,c.id)=(f.tenant_id,f.connection_id)
    WHERE f.tenant_id=t AND f.id=feed AND f.mode='mock' AND f.transport='mock' AND f.state='ready'
      AND f.mock_order_profile='ordered-synthetic-v1'
      AND f.mock_stream_generation='5d753531-7ad1-4bc4-87a2-036cf442f527'::uuid
      AND length(btrim(f.replication_policy_version)) BETWEEN 1 AND 200
      AND f.replication_identity_retain_until>clock_timestamp()
      AND f.policy_approved_at<=clock_timestamp() AND c.provider='trestle' AND c.mode='mock' AND c.state='mock'
      AND c.secret_ref IS NULL AND c.safe_config->'synthetic'='true'::jsonb
      AND c.safe_config->>'liveFeedRights'='unapproved'
      AND app.mls_replication_policy_ok(f.display_policy,f.native_rights)
      AND (SELECT count(*) FROM app.mls_feed bounded WHERE bounded.tenant_id=t)<=20);
$fn$;

-- Explicit metadata/hash vectors from the owned JSON asset, not array offsets or live configuration.
-- No canonical payload or contact is stored in this catalog; verify all vectors independently.
CREATE FUNCTION app.mls_replication_catalog() RETURNS TABLE(
  change_id text, source_sequence bigint, source_listing_key text, kind text, source_state text,
  observed_at timestamptz, source_ingested_at timestamptz, source_expires_at timestamptz,
  source_modified_at timestamptz, source_content_hash text)
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT id,seq::bigint,key,kind,status,observed::timestamptz,ingested::timestamptz,
    expires::timestamptz,modified::timestamptz,hash FROM (VALUES
    ('SYNTHETIC-CHANGE-A-ACTIVE',10,'SYNTHETIC-ORDERED-A','upsert','active','2026-10-10T00:01:00Z',
      '2026-10-10T00:01:00Z','2026-10-11T00:01:00Z','2026-10-10T00:00:00Z','059cb044d614fd284af7408a24fdad191774be9f981c3d0680e3b5a7ab1a3cc1'),
    ('SYNTHETIC-CHANGE-B-ACTIVE',25,'SYNTHETIC-ORDERED-B','upsert','active','2026-10-10T00:02:00Z',
      '2026-10-10T00:02:00Z','2026-10-11T00:02:00Z',NULL,'d81b14d8622433b4e1dbbc6e5c3470605c46f58dfc21f656dd70b5af5d43c194'),
    ('SYNTHETIC-CHANGE-A-PENDING',60,'SYNTHETIC-ORDERED-A','upsert','pending','2026-10-10T00:03:00Z',
      '2026-10-10T00:03:00Z','2026-10-11T00:03:00Z','2026-10-10T00:00:00Z','083ed742c14911c5e15c26e6aee706175b9d28dc32adc0f94f8828832fae4266'),
    ('SYNTHETIC-CHANGE-A-DELETED',90,'SYNTHETIC-ORDERED-A','delete','deleted','2026-10-10T00:04:00Z',
      NULL,NULL,NULL,'3133106f2b12d7678edf54483f44abb3e784574e6f8533beea583aeadac61de3'),
    ('SYNTHETIC-CHANGE-UNKNOWN-DELETED',130,'SYNTHETIC-ORDERED-NEVER-SEEN','delete','deleted','2026-10-10T00:05:00Z',
      NULL,NULL,NULL,'8f462573bc1bb33668374f18c3d1b509a671d250530de2087533f5082783e17f'),
    ('SYNTHETIC-CHANGE-B-OFF-MARKET',210,'SYNTHETIC-ORDERED-B','upsert','off_market','2026-10-10T00:06:00Z',
      '2026-10-10T00:06:00Z','2026-10-11T00:06:00Z',NULL,'1c00ddb868dfb521801dc4d9b5f328170851e91171856098dc0dd96f3ce8900d'),
    ('SYNTHETIC-CHANGE-C-CLOSED',300,'SYNTHETIC-ORDERED-C','upsert','closed','2026-10-10T00:07:00Z',
      '2026-10-10T00:07:00Z','2026-10-11T00:07:00Z',NULL,'13dfc2170f2cddef177e80becba64ecb7e7c894d1e1f7ea687776228da1d69dd')
  ) catalog(id,seq,key,kind,status,observed,ingested,expires,modified,hash);
$fn$;

CREATE FUNCTION app.mls_replication_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'MLS replication evidence is immutable' USING ERRCODE='55000'; END;
$fn$;
CREATE TRIGGER mls_receipt_immutable BEFORE UPDATE OR DELETE ON app.mls_replication_page_receipt
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_immutable();
CREATE TRIGGER mls_state_immutable BEFORE UPDATE OR DELETE ON app.mls_replication_source_state
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_immutable();
CREATE TRIGGER mls_entry_immutable BEFORE UPDATE OR DELETE ON app.mls_replication_source_entry
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_immutable();

-- Further guarded triggers, policies and narrow grants follow. All trigger functions that inspect
-- hidden history are SECURITY DEFINER, fixed-search-path, trigger-only and revoked from PUBLIC.

CREATE FUNCTION app.mls_replication_checkpoint_ok(c jsonb,t uuid,f uuid,p text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v jsonb;
BEGIN
  IF NOT app.mls_replication_object(c,ARRAY['schemaVersion','context','resource','revision','cursor','watermark',
      'overlapSeconds','limit','pagesInCycle','cursorHashes','cycleBinding'])
    OR NOT app.mls_replication_object(c->'context',ARRAY['organizationId','feedId','policyVersion'])
    OR c->'context' IS DISTINCT FROM jsonb_build_object('organizationId',t::text,'feedId',f::text,'policyVersion',p)
    OR c->'schemaVersion' IS DISTINCT FROM '1'::jsonb OR c->>'resource' IS DISTINCT FROM 'listing'
    OR NOT app.mls_replication_integer(c->'revision',0,9007199254740991)
    OR NOT app.mls_replication_integer(c->'overlapSeconds',0,86400)
    OR NOT app.mls_replication_integer(c->'limit',1,100)
    OR NOT app.mls_replication_integer(c->'pagesInCycle',0,99)
    OR jsonb_typeof(c->'cursorHashes') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF app.mls_replication_utc(c->'watermark')>'2026-10-10T00:10:00Z'::timestamptz
    OR jsonb_array_length(c->'cursorHashes')<>(c->>'pagesInCycle')::integer
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(c->'cursorHashes'))
      <>jsonb_array_length(c->'cursorHashes') THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(c->'cursorHashes') LOOP
    IF jsonb_typeof(v)<>'string' OR v#>>'{}' !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  END LOOP;
  IF c->'cursor'='null'::jsonb THEN
    RETURN c->'cycleBinding'='null'::jsonb AND c->'pagesInCycle'='0'::jsonb
      AND c->'cursorHashes'='[]'::jsonb;
  END IF;
  RETURN jsonb_typeof(c->'cursor')='string' AND octet_length(c->>'cursor') BETWEEN 1 AND 8192
    AND (c->>'pagesInCycle')::integer>0
    AND app.mls_replication_object(c->'cycleBinding',ARRAY['feedRevision','rightsFingerprint'])
    AND app.mls_replication_integer(c#>'{cycleBinding,feedRevision}',1,9007199254740991)
    AND jsonb_typeof(c#>'{cycleBinding,rightsFingerprint}')='string'
    AND c#>>'{cycleBinding,rightsFingerprint}' ~ '^[a-f0-9]{64}$'
    AND c->'cursorHashes'->-1=to_jsonb(app.mls_replication_hash(c->'cursor'));
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;

CREATE FUNCTION app.mls_replication_lock_actor(t uuid,member uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF session_user NOT IN ('estate_runtime','estate_worker') OR t IS DISTINCT FROM app.current_tenant()
    OR t IS NULL OR app.current_actor() IS NULL OR member IS NULL THEN
    RAISE EXCEPTION 'Current MLS authority required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.membership m JOIN app.role_definition r ON (r.tenant_id,r.id)=(m.tenant_id,m.role_id)
    JOIN app.organization o ON o.id=m.tenant_id
    WHERE m.tenant_id=t AND m.id=member AND m.user_id=app.current_actor()
      AND m.status='active' AND o.status='active' FOR SHARE OF m,r,o;
  IF NOT FOUND OR NOT app.mls_replication_actor_ok(t,member) THEN
    RAISE EXCEPTION 'Current MLS authority required' USING ERRCODE='42501';
  END IF;
END;
$fn$;

CREATE FUNCTION app.mls_replication_assert_claim(t uuid,f uuid,run uuid,fence uuid,attempt integer,
    allow_completed boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE r app.mls_sync_run%ROWTYPE; j app.integration_job%ROWTYPE; member uuid;
BEGIN
  IF session_user<>'estate_worker' OR t IS NULL OR t IS DISTINCT FROM app.current_tenant()
    OR app.current_actor() IS NULL THEN
    RAISE EXCEPTION 'Fenced MLS claim required' USING ERRCODE='42501';
  END IF;
  SELECT m.id INTO member FROM app.membership m WHERE m.tenant_id=t AND m.user_id=app.current_actor();
  PERFORM app.mls_replication_lock_actor(t,member);
  SELECT * INTO r FROM app.mls_sync_run WHERE tenant_id=t AND id=run AND feed_id=f FOR UPDATE;
  IF NOT FOUND OR r.initiating_actor_id IS DISTINCT FROM app.current_actor()
    OR r.requesting_member_id IS DISTINCT FROM member OR r.claim_fence IS DISTINCT FROM fence
    OR r.claim_attempt IS DISTINCT FROM attempt THEN
    RAISE EXCEPTION 'Fenced MLS claim required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO j FROM app.integration_job WHERE tenant_id=t AND id=r.job_id FOR UPDATE;
  IF NOT FOUND OR j.kind IS DISTINCT FROM 'native-mock-mls-replication-v1'
    OR j.requesting_member_id IS DISTINCT FROM member OR j.attempt_count IS DISTINCT FROM attempt
    OR j.lease_until IS DISTINCT FROM r.claim_lease_until
    OR (j.state<>'running' AND NOT (allow_completed AND j.state='succeeded' AND EXISTS(
      SELECT 1 FROM app.mls_replication_page_receipt pr WHERE pr.tenant_id=t AND pr.feed_id=f
        AND pr.run_id=run AND pr.claim_fence=fence AND pr.write_xid=pg_current_xact_id()
        AND pr.next_checkpoint->'cursor'='null'::jsonb))) THEN
    RAISE EXCEPTION 'Fenced MLS claim required' USING ERRCODE='42501';
  END IF;
  -- UPDATE the feed lock before touching listings: no SHARE-to-UPDATE upgrade after readers wait.
  PERFORM 1 FROM app.mls_feed mf JOIN app.integration_connection c
    ON (c.tenant_id,c.id)=(mf.tenant_id,mf.connection_id)
    WHERE mf.tenant_id=t AND mf.id=f AND mf.replication_policy_version=r.policy_version
      AND mf.mock_stream_generation=r.stream_generation AND c.id=j.connection_id
    FOR UPDATE OF mf FOR SHARE OF c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current MLS source required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=t AND e.feature='mls' FOR SHARE OF e;
  -- Check clock after every potentially blocked lock; transaction-start now() is insufficient.
  IF j.lease_until IS NULL OR j.lease_until<=clock_timestamp()
    OR (r.retry_not_before IS NOT NULL AND r.retry_not_before>clock_timestamp())
    OR NOT app.mls_replication_actor_ok(t,member) OR NOT app.mls_replication_feed_ok(t,f) THEN
    RAISE EXCEPTION 'Current MLS claim or source unavailable' USING ERRCODE='42501';
  END IF;
END;
$fn$;

CREATE FUNCTION app.mls_replication_receipt_claim(t uuid,f uuid,receipt text,finished boolean DEFAULT false)
RETURNS app.mls_replication_page_receipt
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE;
BEGIN
  -- Context equality is checked before privileged history lookup, even when a row is RLS-hidden.
  IF t IS NULL OR t IS DISTINCT FROM app.current_tenant() OR app.current_actor() IS NULL
    OR session_user<>'estate_worker' THEN RAISE EXCEPTION 'Current MLS page required' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM app.mls_replication_page_receipt
    WHERE tenant_id=t AND feed_id=f AND receipt_id=receipt;
  IF NOT FOUND OR p.write_xid IS DISTINCT FROM pg_current_xact_id()
    OR p.initiating_actor_id IS DISTINCT FROM app.current_actor() THEN
    RAISE EXCEPTION 'Current MLS page required' USING ERRCODE='42501';
  END IF;
  PERFORM app.mls_replication_assert_claim(t,f,p.run_id,p.claim_fence,p.claim_attempt,finished);
  RETURN p;
END;
$fn$;

CREATE FUNCTION app.mls_replication_run_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE j app.integration_job%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.job_id IS NOT NULL THEN RAISE EXCEPTION 'MLS runs cannot be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.job_id IS NULL AND (TG_OP='INSERT' OR OLD.job_id IS NULL)
    AND session_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND session_user NOT IN ('estate_runtime','estate_worker') THEN RETURN NEW; END IF;
  PERFORM app.mls_replication_lock_actor(NEW.tenant_id,NEW.requesting_member_id);
  SELECT * INTO j FROM app.integration_job WHERE tenant_id=NEW.tenant_id AND id=NEW.job_id FOR SHARE;
  IF NOT FOUND OR j.kind IS DISTINCT FROM 'native-mock-mls-replication-v1'
    OR j.requesting_member_id IS DISTINCT FROM NEW.requesting_member_id
    OR NEW.initiating_actor_id IS DISTINCT FROM app.current_actor()
    OR NOT app.mls_replication_feed_ok(NEW.tenant_id,NEW.feed_id) THEN
    RAISE EXCEPTION 'Current initiating MLS job required' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM app.mls_feed mf JOIN app.integration_connection c
    ON (c.tenant_id,c.id)=(mf.tenant_id,mf.connection_id)
    WHERE mf.tenant_id=NEW.tenant_id AND mf.id=NEW.feed_id AND c.id=j.connection_id FOR SHARE OF mf,c;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current MLS source required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM app.entitlement e WHERE e.tenant_id=NEW.tenant_id AND e.feature='mls' FOR SHARE OF e;
  IF NOT app.mls_replication_actor_ok(NEW.tenant_id,NEW.requesting_member_id)
    OR NOT app.mls_replication_feed_ok(NEW.tenant_id,NEW.feed_id) THEN
    RAISE EXCEPTION 'Current MLS capability and source required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF session_user<>'estate_runtime' OR j.state<>'queued' OR j.attempt_count<>0 OR j.lease_until IS NOT NULL
      OR NEW.claim_fence IS NOT NULL OR NEW.claim_attempt IS NOT NULL OR NEW.claim_lease_until IS NOT NULL
      OR NEW.retry_not_before IS NOT NULL THEN
      RAISE EXCEPTION 'Fresh initiating MLS job required' USING ERRCODE='42501';
    END IF;
    NEW.state:='queued'; NEW.started_at:=clock_timestamp(); NEW.finished_at:=NULL;
    NEW.cursor_before:=NULL; NEW.cursor_after:=NULL; NEW.counts:='{}'::jsonb; NEW.safe_error:=NULL;
  ELSE
    IF pg_trigger_depth()<2 OR ROW(NEW.tenant_id,NEW.id,NEW.feed_id,NEW.job_id,NEW.requesting_member_id,
        NEW.initiating_actor_id,NEW.policy_version,NEW.stream_generation,NEW.started_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.feed_id,OLD.job_id,OLD.requesting_member_id,
        OLD.initiating_actor_id,OLD.policy_version,OLD.stream_generation,OLD.started_at) THEN
      RAISE EXCEPTION 'Immutable MLS run binding required' USING ERRCODE='55000';
    END IF;
    IF coalesce(NEW.claim_attempt,0) IS DISTINCT FROM j.attempt_count OR NEW.claim_lease_until IS DISTINCT FROM j.lease_until THEN
      RAISE EXCEPTION 'Current MLS claim binding required' USING ERRCODE='42501';
    END IF;
    NEW.row_version:=OLD.row_version+1; NEW.updated_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_run_binding BEFORE INSERT OR UPDATE OR DELETE ON app.mls_sync_run
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_run_guard();

CREATE FUNCTION app.mls_replication_job_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE r app.mls_sync_run%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.kind='native-mock-mls-replication-v1' THEN RAISE EXCEPTION 'MLS jobs cannot be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.kind<>'native-mock-mls-replication-v1' AND (TG_OP='INSERT' OR OLD.kind<>'native-mock-mls-replication-v1') THEN
    IF session_user='estate_worker' THEN RAISE EXCEPTION 'MLS worker job required' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  PERFORM app.mls_replication_lock_actor(NEW.tenant_id,NEW.requesting_member_id);
  IF TG_OP='INSERT' THEN
    IF session_user<>'estate_runtime' OR NEW.kind<>'native-mock-mls-replication-v1'
      OR NEW.state<>'queued' OR NEW.attempt_count<>0 OR NEW.lease_until IS NOT NULL OR NEW.connection_id IS NULL
      OR NEW.result_ref IS NOT NULL OR NEW.safe_error IS NOT NULL OR NEW.safe_result<>'{}'::jsonb
      OR NEW.row_version<>1 THEN
      RAISE EXCEPTION 'Fresh initiating MLS job required' USING ERRCODE='42501';
    END IF;
    NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at;
    RETURN NEW;
  END IF;
  IF ROW(NEW.tenant_id,NEW.id,NEW.kind,NEW.connection_id,NEW.requesting_member_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.kind,OLD.connection_id,OLD.requesting_member_id,OLD.created_at) THEN
    RAISE EXCEPTION 'Immutable MLS job binding required' USING ERRCODE='55000';
  END IF;
  SELECT * INTO r FROM app.mls_sync_run WHERE tenant_id=NEW.tenant_id AND job_id=NEW.id FOR UPDATE;
  IF NOT FOUND OR r.initiating_actor_id IS DISTINCT FROM app.current_actor()
    OR NOT app.mls_replication_feed_ok(NEW.tenant_id,r.feed_id) THEN
    RAISE EXCEPTION 'Current initiating MLS job required' USING ERRCODE='42501';
  END IF;
  IF session_user='estate_runtime' THEN
    IF NEW.state<>'cancelled' OR OLD.state NOT IN ('queued','running')
      OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.lease_until IS DISTINCT FROM OLD.lease_until THEN
      RAISE EXCEPTION 'MLS runtime cancellation only' USING ERRCODE='42501';
    END IF;
  ELSIF session_user='estate_worker' THEN
    IF NEW.state='running' AND (OLD.state='queued' OR (OLD.state='running' AND OLD.lease_until<=clock_timestamp())) THEN
      IF OLD.attempt_count>=2147483647 OR (r.retry_not_before IS NOT NULL AND r.retry_not_before>clock_timestamp()) THEN
        RAISE EXCEPTION 'MLS claim unavailable' USING ERRCODE='42501';
      END IF;
      NEW.attempt_count:=OLD.attempt_count+1; NEW.lease_until:=clock_timestamp()+interval '30 seconds';
    ELSE
      PERFORM app.mls_replication_assert_claim(NEW.tenant_id,r.feed_id,r.id,r.claim_fence,r.claim_attempt);
      IF NEW.state NOT IN ('running','succeeded','failed','unknown')
        OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
        OR (NEW.state='succeeded' AND NOT EXISTS(SELECT 1 FROM app.mls_replication_page_receipt p
          WHERE p.tenant_id=NEW.tenant_id AND p.feed_id=r.feed_id AND p.run_id=r.id
            AND p.write_xid=pg_current_xact_id() AND p.next_checkpoint->'cursor'='null'::jsonb)) THEN
        RAISE EXCEPTION 'Current MLS job transition required' USING ERRCODE='42501';
      END IF;
    END IF;
  ELSE RAISE EXCEPTION 'MLS login identity required' USING ERRCODE='42501';
  END IF;
  -- Keep messages/results reference-only; a public Job projection is a later reviewed service.
  IF NEW.safe_error IS NOT NULL AND NEW.safe_error NOT IN ('rate_limited','source_unavailable',
      'checkpoint_conflict','commit_unknown','reconciliation_required') THEN
    RAISE EXCEPTION 'Safe MLS job failure required' USING ERRCODE='23514';
  END IF;
  IF NEW.safe_result<>'{}'::jsonb OR NEW.result_ref IS NOT NULL THEN RAISE EXCEPTION 'Safe MLS job result required' USING ERRCODE='23514'; END IF;
  NEW.row_version:=OLD.row_version+1; NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_job_binding BEFORE INSERT OR UPDATE OR DELETE ON app.integration_job
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_job_guard();

CREATE FUNCTION app.mls_replication_job_claim() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF NEW.kind='native-mock-mls-replication-v1' THEN
    UPDATE app.mls_sync_run SET state=NEW.state,
      claim_fence=CASE WHEN NEW.attempt_count<>OLD.attempt_count THEN gen_random_uuid() ELSE claim_fence END,
      claim_attempt=CASE WHEN NEW.attempt_count=0 THEN NULL ELSE NEW.attempt_count END,claim_lease_until=NEW.lease_until,
      finished_at=CASE WHEN NEW.state IN ('succeeded','failed','unknown','cancelled') THEN clock_timestamp() ELSE NULL END
      WHERE tenant_id=NEW.tenant_id AND job_id=NEW.id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Bound MLS run required' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE TRIGGER mls_job_fenced_claim AFTER UPDATE ON app.integration_job
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_job_claim();

CREATE FUNCTION app.mls_replication_receipt_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE r app.mls_sync_run%ROWTYPE; cp app.mls_checkpoint%ROWTYPE; f app.mls_feed%ROWTYPE;
  connection_version bigint; selected text[]; ids text[]; part jsonb; selected_start integer:=1;
  i integer; finish integer; page_limit integer; watermark timestamptz; next_cursor text; boundary text;
  fingerprint text; binding jsonb; expected_next jsonb; seq bigint; member uuid;
BEGIN
  IF NEW.tenant_id IS NULL OR NEW.tenant_id IS DISTINCT FROM app.current_tenant() OR app.current_actor() IS NULL
    OR session_user<>'estate_worker' THEN RAISE EXCEPTION 'Current MLS page required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('W07 replication budget:'||NEW.tenant_id::text,0));
  PERFORM app.mls_replication_assert_claim(NEW.tenant_id,NEW.feed_id,NEW.run_id,NEW.claim_fence,NEW.claim_attempt);
  SELECT * INTO r FROM app.mls_sync_run WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
  SELECT * INTO cp FROM app.mls_checkpoint WHERE tenant_id=NEW.tenant_id AND id=NEW.checkpoint_id
    AND feed_id=NEW.feed_id FOR UPDATE;
  IF NOT FOUND OR cp.mock_stream_generation IS DISTINCT FROM r.stream_generation
    OR NEW.expected_sql_version IS DISTINCT FROM cp.row_version
    OR NEW.expected_checkpoint IS DISTINCT FROM cp.cursor OR NEW.next_sql_version<>cp.row_version+1 THEN
    RAISE EXCEPTION 'MLS checkpoint conflict' USING ERRCODE='40001';
  END IF;
  SELECT * INTO f FROM app.mls_feed WHERE tenant_id=NEW.tenant_id AND id=NEW.feed_id;
  SELECT row_version INTO connection_version FROM app.integration_connection
    WHERE tenant_id=NEW.tenant_id AND id=f.connection_id;
  fingerprint:=app.mls_replication_hash(jsonb_build_object('revision',f.row_version,
    'displayPolicy',f.display_policy,'nativeRights',f.native_rights));
  binding:=jsonb_build_object('feedRevision',f.row_version,'rightsFingerprint',fingerprint);
  IF NEW.initiating_actor_id IS DISTINCT FROM r.initiating_actor_id
    OR NEW.requesting_member_id IS DISTINCT FROM r.requesting_member_id
    OR NEW.policy_version IS DISTINCT FROM r.policy_version OR NEW.stream_generation IS DISTINCT FROM r.stream_generation
    OR NEW.feed_revision IS DISTINCT FROM f.row_version OR NEW.connection_revision IS DISTINCT FROM connection_version
    OR NEW.rights_fingerprint IS DISTINCT FROM fingerprint
    OR app.mls_replication_checkpoint_ok(NEW.expected_checkpoint,NEW.tenant_id,NEW.feed_id,NEW.policy_version) IS DISTINCT FROM true
    OR app.mls_replication_checkpoint_ok(NEW.next_checkpoint,NEW.tenant_id,NEW.feed_id,NEW.policy_version) IS DISTINCT FROM true
    OR NEW.expected_revision IS DISTINCT FROM (cp.cursor->>'revision')::bigint
    OR (cp.cursor->'cycleBinding'<>'null'::jsonb AND cp.cursor->'cycleBinding' IS DISTINCT FROM binding)
    OR NOT app.mls_replication_object(NEW.source_proof,ARRAY['schemaVersion','profile','context','generation','pageDigest','entries'])
    OR NEW.source_proof->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR NEW.source_proof->>'profile' IS DISTINCT FROM 'ordered-synthetic-v1'
    OR NEW.source_proof->'context' IS DISTINCT FROM cp.cursor->'context'
    OR NEW.source_proof->>'generation' IS DISTINCT FROM NEW.stream_generation::text
    OR jsonb_typeof(NEW.source_proof->'pageDigest') IS DISTINCT FROM 'string'
    OR NEW.source_proof->>'pageDigest' !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(NEW.source_proof->'entries') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Registered MLS page proof required' USING ERRCODE='23514';
  END IF;
  page_limit:=(cp.cursor->>'limit')::integer;
  watermark:=app.mls_replication_utc(cp.cursor->'watermark');
  SELECT coalesce(array_agg(c.change_id ORDER BY c.source_sequence),ARRAY[]::text[]) INTO selected
    FROM app.mls_replication_catalog() c WHERE watermark IS NULL
      OR c.observed_at>watermark-make_interval(secs=>(cp.cursor->>'overlapSeconds')::integer);
  IF cp.cursor->'cursor'<>'null'::jsonb THEN
    selected_start:=NULL;
    FOR i IN 1..cardinality(selected) LOOP
      IF i>1 AND (i-1)%page_limit=0 THEN
        boundary:='ordered-synthetic-v1.'||app.mls_replication_hash(jsonb_build_object(
          'context',cp.cursor->'context','generation',NEW.stream_generation::text,
          'watermark',cp.cursor->'watermark','overlapSeconds',cp.cursor->'overlapSeconds','limit',cp.cursor->'limit',
          'previousChangeId',selected[i-1],'nextChangeId',selected[i]));
        IF boundary=cp.cursor->>'cursor' THEN selected_start:=i; EXIT; END IF;
      END IF;
    END LOOP;
    IF selected_start IS NULL THEN RAISE EXCEPTION 'Registered MLS boundary required' USING ERRCODE='23514'; END IF;
  END IF;
  finish:=least(selected_start+page_limit-1,cardinality(selected));
  ids:=coalesce(selected[selected_start:finish],ARRAY[]::text[]);
  IF jsonb_array_length(NEW.source_proof->'entries')<>cardinality(ids) THEN
    RAISE EXCEPTION 'Exact MLS page identities required' USING ERRCODE='23514';
  END IF;
  FOR i IN 1..cardinality(ids) LOOP
    part:=NEW.source_proof->'entries'->(i-1);
    SELECT c.source_sequence INTO seq FROM app.mls_replication_catalog() c WHERE c.change_id=ids[i];
    IF NOT app.mls_replication_object(part,ARRAY['index','changeId','sequence'])
      OR part->'index' IS DISTINCT FROM to_jsonb(i-1)
      OR part->>'changeId' IS DISTINCT FROM ids[i] OR part->'sequence' IS DISTINCT FROM to_jsonb(seq) THEN
      RAISE EXCEPTION 'Exact MLS page identities required' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF finish<cardinality(selected) THEN
    next_cursor:='ordered-synthetic-v1.'||app.mls_replication_hash(jsonb_build_object(
      'context',cp.cursor->'context','generation',NEW.stream_generation::text,
      'watermark',cp.cursor->'watermark','overlapSeconds',cp.cursor->'overlapSeconds','limit',cp.cursor->'limit',
      'previousChangeId',selected[finish],'nextChangeId',selected[finish+1]));
  END IF;
  expected_next:=cp.cursor||jsonb_build_object('revision',NEW.expected_revision+1,'cursor',next_cursor,
    'watermark',CASE WHEN next_cursor IS NULL THEN '"2026-10-10T00:10:00Z"'::jsonb ELSE cp.cursor->'watermark' END,
    'pagesInCycle',CASE WHEN next_cursor IS NULL THEN 0 ELSE (cp.cursor->>'pagesInCycle')::integer+1 END,
    'cursorHashes',CASE WHEN next_cursor IS NULL THEN '[]'::jsonb ELSE cp.cursor->'cursorHashes'
      ||jsonb_build_array(app.mls_replication_hash(to_jsonb(next_cursor))) END,
    'cycleBinding',CASE WHEN next_cursor IS NULL THEN 'null'::jsonb ELSE binding END);
  IF NEW.next_checkpoint IS DISTINCT FROM expected_next OR NEW.next_revision<>NEW.expected_revision+1
    OR NEW.next_sql_version>9007199254740991
    OR (SELECT count(*) FROM app.mls_replication_page_receipt WHERE tenant_id=NEW.tenant_id)>=1000 THEN
    RAISE EXCEPTION 'MLS checkpoint progression unavailable' USING ERRCODE='23514';
  END IF;
  NEW.write_xid:=pg_current_xact_id(); NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_receipt_bound_page BEFORE INSERT ON app.mls_replication_page_receipt
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_receipt_guard();

CREATE FUNCTION app.mls_replication_checkpoint_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE f app.mls_feed%ROWTYPE; p app.mls_replication_page_receipt%ROWTYPE; member uuid;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MLS checkpoints cannot be deleted' USING ERRCODE='55000'; END IF;
  IF NEW.mock_stream_generation IS NULL AND (TG_OP='INSERT' OR OLD.mock_stream_generation IS NULL)
    AND session_user=(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND session_user NOT IN ('estate_runtime','estate_worker') THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    SELECT m.id INTO member FROM app.membership m WHERE m.tenant_id=NEW.tenant_id AND m.user_id=app.current_actor();
    PERFORM app.mls_replication_lock_actor(NEW.tenant_id,member);
    SELECT * INTO f FROM app.mls_feed WHERE tenant_id=NEW.tenant_id AND id=NEW.feed_id FOR UPDATE;
    IF session_user<>'estate_runtime' OR NOT app.mls_replication_feed_ok(NEW.tenant_id,NEW.feed_id)
      OR NEW.resource<>'listing' OR NEW.mock_stream_generation IS DISTINCT FROM f.mock_stream_generation
      OR app.mls_replication_checkpoint_ok(NEW.cursor,NEW.tenant_id,NEW.feed_id,f.replication_policy_version) IS DISTINCT FROM true
      OR NEW.cursor->'revision' IS DISTINCT FROM '0'::jsonb OR NEW.cursor->'cursor' IS DISTINCT FROM 'null'::jsonb
      OR NEW.cursor->'watermark' IS DISTINCT FROM 'null'::jsonb OR NEW.row_version<>1
      OR NEW.last_replication_receipt_id IS NOT NULL OR NEW.watermark_at IS NOT NULL OR NEW.metadata_hash IS NOT NULL
      OR EXISTS(SELECT 1 FROM app.listing l WHERE l.tenant_id=NEW.tenant_id AND l.feed_id=NEW.feed_id)
      OR EXISTS(SELECT 1 FROM app.mls_replication_source_state s WHERE s.tenant_id=NEW.tenant_id AND s.feed_id=NEW.feed_id)
      OR NOT EXISTS(SELECT 1 FROM app.mls_sync_run r WHERE r.tenant_id=NEW.tenant_id AND r.feed_id=NEW.feed_id
        AND r.initiating_actor_id=app.current_actor() AND r.state='queued') THEN
      RAISE EXCEPTION 'Fresh bound MLS checkpoint required' USING ERRCODE='42501';
    END IF;
  ELSE
    p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.feed_id,NEW.last_replication_receipt_id);
    IF ROW(NEW.tenant_id,NEW.id,NEW.feed_id,NEW.resource,NEW.mock_stream_generation,NEW.metadata_hash,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.feed_id,OLD.resource,OLD.mock_stream_generation,OLD.metadata_hash,OLD.created_at)
      OR p.checkpoint_id IS DISTINCT FROM NEW.id OR p.expected_checkpoint IS DISTINCT FROM OLD.cursor
      OR p.next_checkpoint IS DISTINCT FROM NEW.cursor OR p.expected_sql_version IS DISTINCT FROM OLD.row_version
      OR NEW.row_version IS DISTINCT FROM p.next_sql_version
      OR NEW.watermark_at IS DISTINCT FROM app.mls_replication_utc(NEW.cursor->'watermark') THEN
      RAISE EXCEPTION 'Atomic MLS checkpoint receipt required' USING ERRCODE='23514';
    END IF;
    NEW.updated_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_checkpoint_atomic BEFORE INSERT OR UPDATE OR DELETE ON app.mls_checkpoint
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_checkpoint_guard();

CREATE FUNCTION app.mls_replication_state_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; c record;
BEGIN
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.feed_id,NEW.first_receipt_id);
  SELECT * INTO c FROM app.mls_replication_catalog() WHERE change_id=NEW.first_change_id;
  IF NOT FOUND OR NEW.stream_generation IS DISTINCT FROM p.stream_generation
    OR c.source_listing_key IS DISTINCT FROM NEW.source_listing_key
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_proof->'entries') e WHERE e->>'changeId'=NEW.first_change_id)
    OR (c.kind='delete' AND NEW.listing_id IS NOT NULL)
    OR (c.kind='upsert' AND NEW.listing_id IS NULL)
    OR EXISTS(SELECT 1 FROM app.listing l WHERE l.tenant_id=NEW.tenant_id AND l.feed_id=NEW.feed_id
      AND (l.source_listing_key=NEW.source_listing_key OR l.id=NEW.listing_id))
    OR (SELECT count(*) FROM app.mls_replication_source_state WHERE tenant_id=NEW.tenant_id)>=500 THEN
    RAISE EXCEPTION 'Fresh stable MLS identity required' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_state_stable_identity BEFORE INSERT ON app.mls_replication_source_state
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_state_guard();

CREATE FUNCTION app.mls_replication_entry_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; s app.mls_replication_source_state%ROWTYPE;
  c record; highest bigint; tombstone boolean; native_version bigint;
BEGIN
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.feed_id,NEW.first_receipt_id);
  SELECT * INTO c FROM app.mls_replication_catalog() WHERE change_id=NEW.change_id;
  IF NOT FOUND OR NEW.stream_generation IS DISTINCT FROM p.stream_generation
    OR ROW(NEW.source_sequence,NEW.source_listing_key,NEW.kind,NEW.source_state,NEW.observed_at,
      NEW.source_modified_at,NEW.source_ingested_at,NEW.source_expires_at,NEW.source_content_hash)
      IS DISTINCT FROM ROW(c.source_sequence,c.source_listing_key,c.kind,c.source_state,c.observed_at,
        c.source_modified_at,c.source_ingested_at,c.source_expires_at,c.source_content_hash)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_proof->'entries') e WHERE e->>'changeId'=NEW.change_id) THEN
    RAISE EXCEPTION 'Registered MLS identity and clocks required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM app.mls_replication_source_state
    WHERE tenant_id=NEW.tenant_id AND feed_id=NEW.feed_id AND source_listing_key=NEW.source_listing_key;
  IF NOT FOUND OR NEW.listing_id IS DISTINCT FROM s.listing_id
    OR s.stream_generation IS DISTINCT FROM NEW.stream_generation THEN
    RAISE EXCEPTION 'Stable MLS native identity required' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(max(e.source_sequence),0),coalesce(bool_or(e.kind='delete' OR e.source_state IN ('closed','off_market')),false)
    INTO highest,tombstone FROM app.mls_replication_source_entry e
    WHERE e.tenant_id=NEW.tenant_id AND e.feed_id=NEW.feed_id AND e.source_listing_key=NEW.source_listing_key;
  -- Process unseen operations in this page's source order; historical replay is already in the ledger.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_proof->'entries') pe
      JOIN app.mls_replication_catalog() pc ON pc.change_id=pe->>'changeId'
      WHERE pc.source_sequence<NEW.source_sequence AND NOT EXISTS(SELECT 1 FROM app.mls_replication_source_entry prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.feed_id=NEW.feed_id
          AND prior.stream_generation=NEW.stream_generation AND prior.change_id=pc.change_id)) THEN
    RAISE EXCEPTION 'Ordered MLS page application required' USING ERRCODE='23514';
  END IF;
  IF tombstone OR s.listing_id IS NULL THEN NEW.disposition:='tombstoned';
  ELSIF NEW.kind='upsert' AND NEW.source_state IN ('active','pending') AND NEW.source_sequence<highest THEN
    NEW.disposition:='historical';
  ELSE NEW.disposition:='applied';
  END IF;
  IF NEW.disposition='applied' THEN
    SELECT l.row_version INTO native_version FROM app.listing l
      WHERE l.tenant_id=NEW.tenant_id AND l.feed_id=NEW.feed_id AND l.id=s.listing_id FOR UPDATE;
    NEW.resulting_native_version:=coalesce(native_version,0)+1;
  ELSE NEW.resulting_native_version:=NULL;
  END IF;
  IF (SELECT count(*) FROM app.mls_replication_source_entry WHERE tenant_id=NEW.tenant_id)>=10000 THEN
    RAISE EXCEPTION 'Bounded MLS identity ledger required' USING ERRCODE='23514';
  END IF;
  NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_entry_source_identity BEFORE INSERT ON app.mls_replication_source_entry
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_entry_guard();

CREATE FUNCTION app.mls_replication_listing_hash(l app.listing) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT app.mls_replication_hash(jsonb_build_object('kind','upsert','sourceListingKey',l.source_listing_key,
    'listing',jsonb_build_object('sourceListingKey',l.source_listing_key,'sourceStatus',l.source_status,
      'status',l.status,'sourceModifiedAt',CASE WHEN l.source_modified_at IS NULL THEN NULL
        ELSE to_char(l.source_modified_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') END,
      'listPrice',l.list_price,'bedrooms',l.bedrooms,'bathrooms',l.bathrooms,
      'area',CASE WHEN l.living_area_sqft IS NULL THEN NULL ELSE jsonb_build_object('value',l.living_area_sqft,'unit','sqft') END,
      'address',l.address->'displayAddress',
      'coordinates',CASE WHEN l.location IS NULL THEN NULL
        ELSE jsonb_build_array(public.ST_X(l.location::public.geometry),public.ST_Y(l.location::public.geometry)) END,
      'publicRemarks',l.public_remarks,'propertyType',l.property_type,'displayAllowed',l.display_allowed,
      'addressAllowed',l.address_display_allowed,'attribution',l.brokerage_attribution,'synthetic',l.synthetic)));
$fn$;

CREATE FUNCTION app.mls_replication_listing_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; e app.mls_replication_source_entry%ROWTYPE;
  s app.mls_replication_source_state%ROWTYPE; f app.mls_feed%ROWTYPE; expiry timestamptz; hash text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Use durable MLS withdrawal, never listing deletion' USING ERRCODE='55000'; END IF;
  -- Preserve migration-owned legacy fixture operations; no ordinary role gets this escape.
  IF NEW.replication_receipt_id IS NULL AND (TG_OP='INSERT' OR OLD.replication_receipt_id IS NULL)
    AND session_user=(
      SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND session_user NOT IN ('estate_runtime','estate_worker') THEN RETURN NEW; END IF;
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.feed_id,NEW.replication_receipt_id);
  SELECT * INTO e FROM app.mls_replication_source_entry WHERE tenant_id=NEW.tenant_id AND feed_id=NEW.feed_id
    AND stream_generation=NEW.replication_generation AND change_id=NEW.replication_change_id;
  IF NOT FOUND OR e.first_receipt_id IS DISTINCT FROM p.receipt_id OR e.disposition<>'applied'
    OR e.source_listing_key IS DISTINCT FROM NEW.source_listing_key OR e.listing_id IS DISTINCT FROM NEW.id
    OR e.resulting_native_version IS DISTINCT FROM NEW.row_version THEN
    RAISE EXCEPTION 'New ordered MLS entry required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM app.mls_replication_source_state WHERE tenant_id=NEW.tenant_id AND feed_id=NEW.feed_id
    AND source_listing_key=NEW.source_listing_key;
  IF NOT FOUND OR s.listing_id IS DISTINCT FROM NEW.id OR NEW.replication_generation IS DISTINCT FROM p.stream_generation
    OR NEW.synthetic IS DISTINCT FROM true OR NEW.currency IS DISTINCT FROM 'USD'
    OR NEW.source_listing_id IS NOT NULL THEN
    RAISE EXCEPTION 'Fixed synthetic MLS identity and pricing required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.tenant_id,NEW.id,NEW.feed_id,NEW.source_listing_key,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.feed_id,OLD.source_listing_key,OLD.created_at)
    OR OLD.replication_generation IS DISTINCT FROM NEW.replication_generation OR NEW.row_version<>OLD.row_version+1) THEN
    RAISE EXCEPTION 'Stable MLS listing version required' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (e.kind='delete' OR NEW.row_version<>1
      OR (SELECT count(*) FROM app.listing WHERE tenant_id=NEW.tenant_id)>=500) THEN
    RAISE EXCEPTION 'Bounded new MLS listing required' USING ERRCODE='23514';
  END IF;
  IF e.kind='delete' THEN
    IF TG_OP<>'UPDATE' OR (to_jsonb(NEW)-ARRAY['source_status','status','display_allowed','address_display_allowed',
        'withdrawn_at','content_hash','row_version','updated_at','replication_generation','replication_change_id','replication_receipt_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['source_status','status','display_allowed','address_display_allowed',
        'withdrawn_at','content_hash','row_version','updated_at','replication_generation','replication_change_id','replication_receipt_id']) THEN
      RAISE EXCEPTION 'Conservative MLS withdrawal required' USING ERRCODE='23514';
    END IF;
    NEW.source_status:='deleted'; NEW.status:='off_market'; NEW.display_allowed:=false;
    NEW.address_display_allowed:=false; NEW.withdrawn_at:=clock_timestamp(); NEW.content_hash:=e.source_content_hash;
  ELSE
    IF NEW.status IS DISTINCT FROM e.source_state OR NEW.ingested_at IS DISTINCT FROM e.source_ingested_at
      OR NEW.source_modified_at IS DISTINCT FROM e.source_modified_at
      OR NOT app.mls_replication_object(NEW.address,ARRAY['displayAddress'])
      OR app.mls_replication_listing_hash(NEW) IS DISTINCT FROM e.source_content_hash
      OR NEW.content_hash IS DISTINCT FROM e.source_content_hash
      OR EXISTS(SELECT 1 FROM app.mls_replication_source_entry prior
        WHERE prior.tenant_id=NEW.tenant_id AND prior.feed_id=NEW.feed_id AND prior.source_listing_key=NEW.source_listing_key
          AND prior.change_id<>e.change_id AND (prior.kind='delete' OR prior.source_state IN ('closed','off_market'))) THEN
      RAISE EXCEPTION 'Original licensed MLS content and clocks required' USING ERRCODE='23514';
    END IF;
    SELECT * INTO f FROM app.mls_feed WHERE tenant_id=NEW.tenant_id AND id=NEW.feed_id;
    expiry:=least(e.source_expires_at,e.source_ingested_at+make_interval(secs=>
      least((f.display_policy->>'maxStaleSeconds')::numeric,(f.display_policy->>'rawRetentionSeconds')::numeric,
        (f.native_rights->>'maxDataAgeSeconds')::numeric,(f.native_rights->>'retentionDays')::numeric*86400)::double precision));
    IF NEW.expires_at IS DISTINCT FROM expiry OR NEW.ingested_at>clock_timestamp()
      OR expiry<=clock_timestamp() THEN RAISE EXCEPTION 'Unrenewed MLS freshness required' USING ERRCODE='23514'; END IF;
    NEW.withdrawn_at:=CASE WHEN e.source_state IN ('closed','off_market') THEN clock_timestamp() ELSE NULL END;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_listing_ordered_write BEFORE INSERT OR UPDATE OR DELETE ON app.listing
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_listing_guard();

CREATE FUNCTION app.mls_replication_feed_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.mock_stream_generation IS NOT NULL THEN RAISE EXCEPTION 'MLS stream cannot be deleted' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.replication_policy_version,NEW.mock_stream_generation,NEW.mock_order_profile,NEW.replication_identity_retain_until)
    IS DISTINCT FROM ROW(OLD.replication_policy_version,OLD.mock_stream_generation,OLD.mock_order_profile,OLD.replication_identity_retain_until)
    AND EXISTS(SELECT 1 FROM app.mls_replication_page_receipt WHERE tenant_id=OLD.tenant_id AND feed_id=OLD.id) THEN
    RAISE EXCEPTION 'Stopped-stream reconciliation required' USING ERRCODE='55000';
  END IF;
  IF session_user=(
      SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
    AND session_user NOT IN ('estate_runtime','estate_worker') THEN RETURN NEW; END IF;
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.id,NEW.last_replication_receipt_id);
  IF (to_jsonb(NEW)-ARRAY['last_complete_at','last_replication_receipt_id','row_version','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['last_complete_at','last_replication_receipt_id','row_version','updated_at'])
    OR p.feed_revision IS DISTINCT FROM OLD.row_version OR NEW.row_version<>OLD.row_version+1
    OR p.next_checkpoint->'cursor' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Atomic completed MLS page required' USING ERRCODE='23514';
  END IF;
  NEW.last_complete_at:=clock_timestamp(); NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_feed_completion_binding BEFORE UPDATE OR DELETE ON app.mls_feed
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_feed_guard();

CREATE FUNCTION app.mls_replication_outbox_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; l app.listing%ROWTYPE; event_type text; code text; at timestamptz;
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.mls_replication_receipt_id IS NOT NULL OR OLD.event_type IN ('listing.changed','listing.withdrawn') THEN
      IF TG_OP='DELETE' OR NEW.published_at IS DISTINCT FROM OLD.published_at
        OR (to_jsonb(NEW)-ARRAY['lease_until','attempt_count','updated_at','row_version'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['lease_until','attempt_count','updated_at','row_version']) THEN
        RAISE EXCEPTION 'MLS invalidation evidence is immutable and undispatched' USING ERRCODE='55000';
      END IF;
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF NEW.event_type NOT IN ('listing.changed','listing.withdrawn') AND NEW.mls_replication_receipt_id IS NULL THEN RETURN NEW; END IF;
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.mls_replication_feed_id,NEW.mls_replication_receipt_id);
  SELECT * INTO l FROM app.listing WHERE tenant_id=NEW.tenant_id AND feed_id=NEW.mls_replication_feed_id
    AND id::text=NEW.aggregate_id AND replication_receipt_id=p.receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current MLS invalidation resource required' USING ERRCODE='23514'; END IF;
  event_type:=CASE WHEN l.withdrawn_at IS NOT NULL OR l.status NOT IN ('active','pending') THEN 'listing.withdrawn' ELSE 'listing.changed' END;
  code:=CASE WHEN event_type='listing.withdrawn' THEN 'synthetic_listing_withdrawn' ELSE 'synthetic_listing_changed' END;
  IF NEW.event_type IS DISTINCT FROM event_type OR NEW.initiating_actor_id IS DISTINCT FROM p.initiating_actor_id
    OR NEW.published_at IS NOT NULL OR NEW.lease_until IS NOT NULL OR NEW.attempt_count<>0
    OR NOT app.mls_replication_object(NEW.payload,ARRAY['eventId','type','version','tenantId','occurredAt','ingestedAt',
      'producer','aggregateType','aggregateId','correlationId','payload'])
    OR NEW.payload->>'eventId' IS DISTINCT FROM NEW.id::text OR NEW.payload->>'type' IS DISTINCT FROM event_type
    OR NEW.payload->'version' IS DISTINCT FROM '1'::jsonb OR NEW.payload->>'tenantId' IS DISTINCT FROM NEW.tenant_id::text
    OR NEW.payload->>'producer' IS DISTINCT FROM 'native-mock-mls' OR NEW.payload->>'aggregateType' IS DISTINCT FROM 'listing'
    OR NEW.payload->>'aggregateId' IS DISTINCT FROM l.id::text OR NEW.payload->>'correlationId' IS DISTINCT FROM p.run_id::text
    OR NEW.payload->'payload' IS DISTINCT FROM jsonb_build_object('resourceId',l.id::text,'resourceVersion',l.row_version,
      'relatedResourceIds',jsonb_build_array(l.feed_id::text),'safeCode',code)
    OR NEW.payload->'occurredAt' IS DISTINCT FROM NEW.payload->'ingestedAt' THEN
    RAISE EXCEPTION 'Closed MLS invalidation required' USING ERRCODE='23514';
  END IF;
  at:=app.mls_replication_utc(NEW.payload->'occurredAt');
  IF at IS NULL OR at<p.recorded_at-interval '1 second' OR at>clock_timestamp()+interval '1 second' THEN
    RAISE EXCEPTION 'Current MLS invalidation clock required' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_outbox_closed_invalidation BEFORE INSERT OR UPDATE OR DELETE ON app.outbox
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_outbox_guard();
CREATE UNIQUE INDEX mls_outbox_one_final_listing ON app.outbox
  (tenant_id,mls_replication_feed_id,mls_replication_receipt_id,aggregate_id)
  WHERE mls_replication_receipt_id IS NOT NULL;

CREATE FUNCTION app.mls_replication_page_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; applied integer; touched integer; replayed integer; ignored integer;
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF OLD.action='mls.replication.page_committed' THEN RAISE EXCEPTION 'MLS audit evidence is immutable' USING ERRCODE='55000'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF NEW.action<>'mls.replication.page_committed' THEN RETURN NEW; END IF;
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant() OR app.current_actor() IS NULL THEN
    RAISE EXCEPTION 'Current MLS audit required' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM app.mls_replication_page_receipt WHERE tenant_id=NEW.tenant_id AND audit_event_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Current MLS audit page required' USING ERRCODE='42501'; END IF;
  p:=app.mls_replication_receipt_claim(p.tenant_id,p.feed_id,p.receipt_id);
  SELECT count(*) FILTER(WHERE e.disposition='applied'),count(DISTINCT e.source_listing_key) FILTER(WHERE e.disposition='applied'),
      count(*) FILTER(WHERE e.disposition<>'applied') INTO applied,touched,ignored
    FROM app.mls_replication_source_entry e WHERE e.tenant_id=p.tenant_id AND e.feed_id=p.feed_id
      AND e.first_receipt_id=p.receipt_id;
  SELECT count(*) INTO replayed FROM jsonb_array_elements(p.source_proof->'entries') pe
    JOIN app.mls_replication_source_entry e ON e.tenant_id=p.tenant_id AND e.feed_id=p.feed_id
      AND e.stream_generation=p.stream_generation AND e.change_id=pe->>'changeId' AND e.first_receipt_id<>p.receipt_id;
  IF NEW.actor_ref IS DISTINCT FROM app.current_actor()::text OR NEW.resource_type<>'mls_sync_run'
    OR NEW.resource_id IS DISTINCT FROM p.run_id::text OR NEW.trace_id IS DISTINCT FROM p.receipt_id
    OR NEW.safe_diff IS DISTINCT FROM jsonb_build_object('changes',jsonb_array_length(p.source_proof->'entries'),
      'applied',applied,'touched',touched,'replayed',replayed,'ignored',ignored) THEN
    RAISE EXCEPTION 'Closed MLS page audit required' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp(); NEW.updated_at:=NEW.created_at;
  RETURN NEW;
END;
$fn$;
CREATE TRIGGER mls_page_safe_audit BEFORE INSERT OR UPDATE OR DELETE ON app.audit_event
  FOR EACH ROW EXECUTE FUNCTION app.mls_replication_page_audit();

CREATE FUNCTION app.mls_replication_page_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE p app.mls_replication_page_receipt%ROWTYPE; cp app.mls_checkpoint%ROWTYPE; f app.mls_feed%ROWTYPE;
  c app.integration_connection%ROWTYPE; a app.audit_event%ROWTYPE; required_events integer;
  actual_events integer; applied integer; ignored integer; replayed integer; r app.mls_sync_run%ROWTYPE;
BEGIN
  p:=app.mls_replication_receipt_claim(NEW.tenant_id,NEW.feed_id,NEW.receipt_id,true);
  SELECT * INTO cp FROM app.mls_checkpoint WHERE tenant_id=p.tenant_id AND id=p.checkpoint_id;
  IF NOT FOUND OR cp.cursor IS DISTINCT FROM p.next_checkpoint OR cp.row_version IS DISTINCT FROM p.next_sql_version
    OR cp.last_replication_receipt_id IS DISTINCT FROM p.receipt_id
    OR cp.mock_stream_generation IS DISTINCT FROM p.stream_generation
    OR cp.watermark_at IS DISTINCT FROM app.mls_replication_utc(p.next_checkpoint->'watermark') THEN
    RAISE EXCEPTION 'Atomic MLS checkpoint dependency required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO f FROM app.mls_feed WHERE tenant_id=p.tenant_id AND id=p.feed_id;
  SELECT * INTO c FROM app.integration_connection WHERE tenant_id=p.tenant_id AND id=f.connection_id;
  IF c.row_version IS DISTINCT FROM p.connection_revision
    OR app.mls_replication_hash(jsonb_build_object('revision',p.feed_revision,
      'displayPolicy',f.display_policy,'nativeRights',f.native_rights)) IS DISTINCT FROM p.rights_fingerprint
    OR (p.next_checkpoint->'cursor'<>'null'::jsonb AND f.row_version IS DISTINCT FROM p.feed_revision)
    OR (p.next_checkpoint->'cursor'='null'::jsonb AND
      (f.row_version IS DISTINCT FROM p.feed_revision+1 OR f.last_replication_receipt_id IS DISTINCT FROM p.receipt_id
        OR f.last_complete_at IS NULL OR f.last_complete_at<p.recorded_at)) THEN
    RAISE EXCEPTION 'Atomic current MLS source dependency required' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_proof->'entries') pe
      WHERE NOT EXISTS(SELECT 1 FROM app.mls_replication_source_entry e WHERE e.tenant_id=p.tenant_id
        AND e.feed_id=p.feed_id AND e.stream_generation=p.stream_generation AND e.change_id=pe->>'changeId'))
    OR EXISTS(SELECT 1 FROM app.mls_replication_source_entry e WHERE e.tenant_id=p.tenant_id AND e.feed_id=p.feed_id
      AND e.first_receipt_id=p.receipt_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.source_proof->'entries') pe
        WHERE pe->>'changeId'=e.change_id)) THEN
    RAISE EXCEPTION 'Complete MLS identity ledger required' USING ERRCODE='23514';
  END IF;
  -- Hidden prior tombstones cannot be bypassed by RLS or a later actor's page.
  IF EXISTS(SELECT 1 FROM app.mls_replication_source_entry e WHERE e.tenant_id=p.tenant_id AND e.feed_id=p.feed_id
      AND e.first_receipt_id=p.receipt_id AND e.disposition='applied'
      AND e.resulting_native_version=(SELECT max(last.resulting_native_version) FROM app.mls_replication_source_entry last
        WHERE last.tenant_id=e.tenant_id AND last.feed_id=e.feed_id AND last.first_receipt_id=p.receipt_id
          AND last.source_listing_key=e.source_listing_key AND last.disposition='applied')
      AND NOT EXISTS(SELECT 1 FROM app.listing l WHERE l.tenant_id=e.tenant_id AND l.feed_id=e.feed_id AND l.id=e.listing_id
        AND l.source_listing_key=e.source_listing_key AND l.replication_generation=e.stream_generation
        AND l.replication_change_id=e.change_id AND l.replication_receipt_id=p.receipt_id
        AND l.row_version=e.resulting_native_version AND l.content_hash=e.source_content_hash
        AND (l.withdrawn_at IS NOT NULL OR l.expires_at>clock_timestamp()))) THEN
    RAISE EXCEPTION 'Atomic MLS native projection required' USING ERRCODE='23514';
  END IF;
  SELECT count(*),count(DISTINCT source_listing_key) INTO applied,required_events
    FROM app.mls_replication_source_entry WHERE tenant_id=p.tenant_id AND feed_id=p.feed_id
      AND first_receipt_id=p.receipt_id AND disposition='applied';
  SELECT count(*) INTO ignored FROM app.mls_replication_source_entry WHERE tenant_id=p.tenant_id AND feed_id=p.feed_id
    AND first_receipt_id=p.receipt_id AND disposition<>'applied';
  SELECT count(*) INTO replayed FROM jsonb_array_elements(p.source_proof->'entries') pe
    JOIN app.mls_replication_source_entry e ON e.tenant_id=p.tenant_id AND e.feed_id=p.feed_id
      AND e.stream_generation=p.stream_generation AND e.change_id=pe->>'changeId' AND e.first_receipt_id<>p.receipt_id;
  SELECT count(*) INTO actual_events FROM app.outbox WHERE tenant_id=p.tenant_id
    AND mls_replication_feed_id=p.feed_id AND mls_replication_receipt_id=p.receipt_id;
  IF actual_events<>required_events OR EXISTS(SELECT 1 FROM app.listing l WHERE l.tenant_id=p.tenant_id AND l.feed_id=p.feed_id
      AND l.replication_receipt_id=p.receipt_id AND NOT EXISTS(SELECT 1 FROM app.outbox o
        WHERE o.tenant_id=p.tenant_id AND o.mls_replication_feed_id=p.feed_id AND o.mls_replication_receipt_id=p.receipt_id
          AND o.aggregate_id=l.id::text AND o.payload#>'{payload,resourceVersion}'=to_jsonb(l.row_version))) THEN
    RAISE EXCEPTION 'Atomic final MLS invalidations required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO a FROM app.audit_event WHERE tenant_id=p.tenant_id AND id=p.audit_event_id;
  IF NOT FOUND OR a.action<>'mls.replication.page_committed' OR a.actor_ref IS DISTINCT FROM p.initiating_actor_id::text
    OR a.resource_type<>'mls_sync_run' OR a.resource_id IS DISTINCT FROM p.run_id::text OR a.trace_id IS DISTINCT FROM p.receipt_id
    OR a.safe_diff IS DISTINCT FROM jsonb_build_object('changes',jsonb_array_length(p.source_proof->'entries'),
      'applied',applied,'touched',required_events,'replayed',replayed,'ignored',ignored) THEN
    RAISE EXCEPTION 'Atomic safe MLS audit required' USING ERRCODE='23514';
  END IF;
  SELECT * INTO r FROM app.mls_sync_run WHERE tenant_id=p.tenant_id AND id=p.run_id;
  UPDATE app.mls_sync_run SET cursor_before=coalesce(cursor_before,p.expected_checkpoint),cursor_after=p.next_checkpoint,
    counts=jsonb_build_object('pages',coalesce((counts->>'pages')::integer,0)+1,
      'applied',coalesce((counts->>'applied')::integer,0)+applied,
      'replayed',coalesce((counts->>'replayed')::integer,0)+replayed,
      'ignored',coalesce((counts->>'ignored')::integer,0)+ignored)
    WHERE tenant_id=p.tenant_id AND id=p.run_id;
  -- This is the final checked authorization/fence decision, not a PostgreSQL COMMIT-time clock hook.
  PERFORM app.mls_replication_assert_claim(p.tenant_id,p.feed_id,p.run_id,p.claim_fence,p.claim_attempt,true);
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER mls_page_atomic_dependencies AFTER INSERT ON app.mls_replication_page_receipt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.mls_replication_page_complete();

CREATE FUNCTION app.mls_replication_job_complete_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF NEW.kind='native-mock-mls-replication-v1' THEN
    PERFORM app.mls_replication_lock_actor(NEW.tenant_id,NEW.requesting_member_id);
    IF NOT EXISTS(
      SELECT 1 FROM app.mls_sync_run r JOIN app.mls_checkpoint cp ON (cp.tenant_id,cp.feed_id)=(r.tenant_id,r.feed_id)
        JOIN app.mls_feed mf ON (mf.tenant_id,mf.id)=(r.tenant_id,r.feed_id)
      WHERE r.tenant_id=NEW.tenant_id AND r.job_id=NEW.id AND cp.resource='listing'
        AND mf.connection_id=NEW.connection_id AND app.mls_replication_feed_ok(r.tenant_id,r.feed_id)
        AND cp.mock_stream_generation=r.stream_generation AND cp.cursor->'context'
          =jsonb_build_object('organizationId',r.tenant_id::text,'feedId',r.feed_id::text,'policyVersion',r.policy_version)) THEN
      RAISE EXCEPTION 'Atomic initiating MLS run and checkpoint required' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER mls_job_atomic_binding AFTER INSERT ON app.integration_job
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.mls_replication_job_complete_binding();

-- New tables: tenant permissive base PLUS restrictive authority/feed guards, never replacing tenant_scope.
ALTER TABLE app.mls_replication_page_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_replication_page_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE app.mls_replication_source_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_replication_source_state FORCE ROW LEVEL SECURITY;
ALTER TABLE app.mls_replication_source_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_replication_source_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.mls_replication_page_receipt USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
CREATE POLICY tenant_scope ON app.mls_replication_source_state USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
CREATE POLICY tenant_scope ON app.mls_replication_source_entry USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
CREATE POLICY mls_receipt_read ON app.mls_replication_page_receipt AS RESTRICTIVE FOR SELECT TO estate_runtime,estate_worker
  USING(tenant_id=app.current_tenant() AND initiating_actor_id=app.current_actor()
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id) AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_receipt_insert ON app.mls_replication_page_receipt AS RESTRICTIVE FOR INSERT TO estate_worker
  WITH CHECK(tenant_id=app.current_tenant() AND initiating_actor_id=app.current_actor()
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id) AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_state_authority ON app.mls_replication_source_state AS RESTRICTIVE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id))
  WITH CHECK(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_entry_authority ON app.mls_replication_source_entry AS RESTRICTIVE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id))
  WITH CHECK(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_run_authority ON app.mls_sync_run AS RESTRICTIVE TO estate_runtime,estate_worker
  USING(tenant_id=app.current_tenant() AND initiating_actor_id=app.current_actor()
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id) AND app.mls_replication_feed_ok(tenant_id,feed_id))
  WITH CHECK(tenant_id=app.current_tenant() AND initiating_actor_id=app.current_actor()
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id) AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_checkpoint_authority ON app.mls_checkpoint AS RESTRICTIVE TO estate_runtime,estate_worker
  USING(tenant_id=app.current_tenant() AND mock_stream_generation IS NOT NULL AND app.mls_replication_feed_ok(tenant_id,feed_id))
  WITH CHECK(tenant_id=app.current_tenant() AND mock_stream_generation IS NOT NULL AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_worker_job ON app.integration_job AS RESTRICTIVE TO estate_worker
  USING(tenant_id=app.current_tenant() AND kind='native-mock-mls-replication-v1'
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id))
  WITH CHECK(tenant_id=app.current_tenant() AND kind='native-mock-mls-replication-v1'
    AND app.mls_replication_actor_ok(tenant_id,requesting_member_id));
CREATE POLICY mls_worker_feed_read ON app.mls_feed AS RESTRICTIVE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.mls_replication_actor_ok(tenant_id))
  WITH CHECK(tenant_id=app.current_tenant() AND app.mls_replication_actor_ok(tenant_id));
CREATE POLICY mls_worker_listing ON app.listing AS RESTRICTIVE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id))
  WITH CHECK(tenant_id=app.current_tenant() AND app.mls_replication_feed_ok(tenant_id,feed_id));
CREATE POLICY mls_worker_invalidation_insert ON app.outbox AS RESTRICTIVE FOR INSERT TO estate_worker
  WITH CHECK(tenant_id=app.current_tenant() AND initiating_actor_id=app.current_actor()
    AND event_type IN ('listing.changed','listing.withdrawn') AND mls_replication_feed_id IS NOT NULL
    AND mls_replication_receipt_id IS NOT NULL AND app.mls_replication_feed_ok(tenant_id,mls_replication_feed_id));

-- Required lock privileges do not grant authority to change actor/capability/configuration rows.
GRANT UPDATE(row_version) ON app.organization,app.membership,app.role_definition,app.entitlement,app.integration_connection TO estate_worker;
CREATE POLICY mls_worker_org_lock ON app.organization AS RESTRICTIVE FOR UPDATE TO estate_worker
  USING(id=app.current_tenant() AND app.current_actor() IS NOT NULL) WITH CHECK(false);
CREATE POLICY mls_worker_member_lock ON app.membership AS RESTRICTIVE FOR UPDATE TO estate_worker
  USING(tenant_id=app.current_tenant() AND user_id=app.current_actor()) WITH CHECK(false);
CREATE POLICY mls_worker_role_lock ON app.role_definition AS RESTRICTIVE FOR UPDATE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.current_actor() IS NOT NULL) WITH CHECK(false);
CREATE POLICY mls_worker_entitlement_lock ON app.entitlement AS RESTRICTIVE FOR UPDATE TO estate_worker
  USING(tenant_id=app.current_tenant() AND feature='mls') WITH CHECK(false);
CREATE POLICY mls_worker_connection_lock ON app.integration_connection AS RESTRICTIVE FOR UPDATE TO estate_worker
  USING(tenant_id=app.current_tenant() AND app.current_actor() IS NOT NULL) WITH CHECK(false);

-- Proposed exact grants: no tablewide UPDATE, source DELETE, TRUNCATE, role membership or send rights.
GRANT SELECT ON app.mls_feed,app.listing,app.mls_checkpoint,app.mls_sync_run,app.integration_job TO estate_worker;
GRANT SELECT ON app.mls_checkpoint,app.mls_sync_run,app.mls_replication_page_receipt TO estate_runtime;
GRANT SELECT ON app.mls_replication_page_receipt,app.mls_replication_source_state,app.mls_replication_source_entry TO estate_worker;
GRANT INSERT(tenant_id,id,feed_id,state,started_at,job_id,requesting_member_id,initiating_actor_id,policy_version,stream_generation)
  ON app.mls_sync_run TO estate_runtime;
GRANT INSERT(tenant_id,id,feed_id,resource,cursor,mock_stream_generation) ON app.mls_checkpoint TO estate_runtime;
GRANT INSERT(tenant_id,feed_id,resource,receipt_id,checkpoint_id,run_id,initiating_actor_id,requesting_member_id,policy_version,
  stream_generation,claim_fence,claim_attempt,feed_revision,connection_revision,rights_fingerprint,expected_sql_version,
  next_sql_version,expected_revision,next_revision,expected_checkpoint,next_checkpoint,source_proof,audit_event_id)
  ON app.mls_replication_page_receipt TO estate_worker;
GRANT INSERT(tenant_id,feed_id,source_listing_key,stream_generation,listing_id,first_change_id,first_receipt_id)
  ON app.mls_replication_source_state TO estate_worker;
GRANT INSERT(tenant_id,feed_id,stream_generation,change_id,source_sequence,source_listing_key,kind,source_state,observed_at,
  source_modified_at,source_ingested_at,source_expires_at,source_content_hash,disposition,listing_id,first_receipt_id)
  ON app.mls_replication_source_entry TO estate_worker;
GRANT INSERT(tenant_id,id,feed_id,source_listing_key,source_listing_id,source_status,status,list_price,currency,address,location,
  bedrooms,bathrooms,living_area_sqft,property_type,public_remarks,brokerage_attribution,display_allowed,address_display_allowed,
  synthetic,source_modified_at,content_hash,withdrawn_at,ingested_at,expires_at,replication_generation,replication_change_id,replication_receipt_id)
  ON app.listing TO estate_worker;
GRANT UPDATE(source_status,status,list_price,address,location,bedrooms,bathrooms,living_area_sqft,property_type,public_remarks,
  brokerage_attribution,display_allowed,address_display_allowed,source_modified_at,content_hash,withdrawn_at,ingested_at,
  expires_at,row_version,updated_at,replication_change_id,replication_receipt_id) ON app.listing TO estate_worker;
GRANT UPDATE(cursor,watermark_at,last_replication_receipt_id,row_version,updated_at) ON app.mls_checkpoint TO estate_worker;
GRANT UPDATE(last_complete_at,last_replication_receipt_id,row_version,updated_at) ON app.mls_feed TO estate_worker;
GRANT UPDATE(state,attempt_count,lease_until,safe_error,safe_result,row_version,updated_at) ON app.integration_job TO estate_worker;
GRANT INSERT(tenant_id,id,event_type,aggregate_id,payload,initiating_actor_id,mls_replication_feed_id,mls_replication_receipt_id)
  ON app.outbox TO estate_worker;
-- Existing audit INSERT remains; run claim/progress updates occur only in revoked trigger functions.
REVOKE UPDATE,DELETE,TRUNCATE ON app.mls_replication_page_receipt,app.mls_replication_source_state,app.mls_replication_source_entry
  FROM estate_runtime,estate_worker;
REVOKE DELETE,TRUNCATE ON app.mls_checkpoint,app.mls_sync_run,app.listing FROM estate_runtime,estate_worker;

-- Default EXECUTE must be revoked atomically. No public/internal caller invokes privileged helpers.
DO $candidate$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='app' AND left(p.proname,length('mls_replication_'))='mls_replication_' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,estate_runtime,estate_worker',fn);
  END LOOP;
END;
$candidate$;
-- These invoker/pure predicates are needed by RLS; they neither discover tenants nor bypass policies.
GRANT EXECUTE ON FUNCTION app.mls_replication_actor_ok(uuid,uuid),app.mls_replication_feed_ok(uuid,uuid),
  app.mls_replication_policy_ok(jsonb,jsonb),app.mls_replication_object(jsonb,text[]),
  app.mls_replication_integer(jsonb,numeric,numeric) TO estate_runtime,estate_worker;

-- No worker bootstrap/discovery from untrusted IDs. No configuration, media, cache, CRM, campaign,
-- enrollment, CMS, consent, delivery, control or issuer privileges are added.
-- Source/plan digests still require the trusted Node source/helper validators before a SQL consumer.
-- Candidate owner must prove hidden-row trigger visibility and every actual-login gate before allocation.
COMMIT;
