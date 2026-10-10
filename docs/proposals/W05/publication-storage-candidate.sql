-- PROPOSAL ONLY, 2026-10-10. Not a migration; no sequence is allocated.
-- Companion: publication-storage-review.md. Sources inspected at root b374274.
-- Root must review ports, owners, grants, lock/fence probes and promotion first.
-- The guard and final ROLLBACK are intentional. Never run this file against a DB.
BEGIN;
DO $proposal_only$
BEGIN
  RAISE EXCEPTION 'Review-only CMS storage candidate; promotion is required' USING ERRCODE='55000';
END;
$proposal_only$;
SET LOCAL search_path=pg_catalog,app,pg_temp;

-- A. Shared-owner expand prerequisites: identifiers only, no history rewriting.
-- Preflight indexes/lock time before promotion. Existing same-document revision
-- FK and global site_domain lower(hostname) uniqueness remain unchanged.
ALTER TABLE app.content_document ADD CONSTRAINT cms_document_site_identity
  UNIQUE (tenant_id,site_id,id);
ALTER TABLE app.membership ADD CONSTRAINT cms_member_actor_identity
  UNIQUE (tenant_id,id,user_id);
ALTER TABLE app.integration_job ADD CONSTRAINT cms_job_requester_kind_identity
  UNIQUE (tenant_id,id,requesting_member_id,kind);

-- B. Hosting-owned fixture evidence. Append-only versions, separate current head.
-- No live-host/DNS/TLS claim. A captured domain ID is historical provenance, not
-- a durable FK that prevents a safely detached site_domain from being replaced.
-- Hosting port must compare the CURRENT domain ID/site/hostname/version on use.
CREATE TABLE app.cms_synthetic_host_sequence (
  hostname text PRIMARY KEY,
  last_generation bigint NOT NULL DEFAULT 0 CHECK (last_generation BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE app.cms_synthetic_binding_version (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  binding_generation bigint NOT NULL CHECK (binding_generation BETWEEN 1 AND 9007199254740991),
  domain_id uuid NOT NULL,
  domain_row_version bigint NOT NULL CHECK (domain_row_version BETWEEN 1 AND 9007199254740991),
  hostname text NOT NULL CHECK (length(hostname) BETWEEN 12 AND 253 AND hostname=lower(hostname)
    AND hostname ~ '^[a-z0-9.-]+$' AND hostname !~ '(\.\.|\.$)'
    AND (hostname='example.test' OR hostname LIKE '%.example.test')),
  origin text NOT NULL CHECK (origin='https://' || hostname),
  mode text NOT NULL DEFAULT 'synthetic' CHECK (mode='synthetic'),
  evidence_code text NOT NULL CHECK (evidence_code='synthetic-fixture-v1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (hostname,binding_generation),
  UNIQUE (tenant_id,site_id,hostname,binding_generation),
  UNIQUE (tenant_id,site_id,id,binding_generation,origin),
  UNIQUE (hostname,tenant_id,site_id,id,binding_generation),
  FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.cms_synthetic_host_current (
  hostname text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  binding_generation bigint NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  FOREIGN KEY (hostname,tenant_id,site_id,binding_id,binding_generation)
    REFERENCES app.cms_synthetic_binding_version(hostname,tenant_id,site_id,id,binding_generation)
    ON DELETE RESTRICT
);
-- The hosting owner allocates generations from a durable per-host counter under
-- an exclusive namespace lock, across tenants and detach/reassignment. Never
-- MAX()+1 under caller RLS, reuse a generation, or delete evidence to reset it.

-- C. Platform policy versions. Actual origin/schema/theme validation stays in
-- the reviewed own-data preparation/policy port. jsonb::text is NOT canonical.
CREATE TABLE app.cms_render_policy_version (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  policy_code text NOT NULL CHECK (policy_code='native-text-links-v1'),
  renderer_version text NOT NULL CHECK (renderer_version='1.0.0'),
  canonical_policy_json text NOT NULL CHECK (octet_length(convert_to(canonical_policy_json,'UTF8'))<=24576),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'
    AND policy_hash=encode(sha256(convert_to(canonical_policy_json,'UTF8')),'hex')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at>created_at),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,site_id,id,policy_hash),
  FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE app.cms_site_publication_state (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  publication_generation bigint NOT NULL DEFAULT 0
    CHECK (publication_generation BETWEEN 0 AND 9007199254740991),
  policy_id uuid NOT NULL,
  policy_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,site_id),
  FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,site_id,policy_id,policy_hash)
    REFERENCES app.cms_render_policy_version(tenant_id,site_id,id,policy_hash) ON DELETE RESTRICT
);

-- D. Immutable initiating command. Immutable provenance is NOT authority.
-- Job owner's same-transaction port must insert a queued matching kind/requester
-- with connection_id NULL, then command + preparation + audit + original202
-- idempotency receipt. No publication pointer/version changes at acceptance.
CREATE TABLE app.cms_publication_command (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('publish','rollback')),
  job_kind text GENERATED ALWAYS AS
    (CASE operation WHEN 'publish' THEN 'cms.publish.v1' ELSE 'cms.rollback.v1' END) STORED,
  requesting_member_id uuid NOT NULL,
  initiating_actor_id uuid NOT NULL,
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  expected_document_version bigint NOT NULL
    CHECK (expected_document_version BETWEEN 1 AND 9007199254740990),
  expected_site_version bigint NOT NULL CHECK (expected_site_version BETWEEN 1 AND 9007199254740990),
  binding_id uuid NOT NULL,
  binding_generation bigint NOT NULL,
  origin text NOT NULL,
  policy_id uuid NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key_hash text NOT NULL CHECK (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,job_id),
  UNIQUE (tenant_id,requesting_member_id,operation,document_id,idempotency_key_hash),
  UNIQUE (tenant_id,job_id,site_id,document_id,revision_id,expected_document_version,
    binding_id,binding_generation,origin,policy_id,policy_hash,content_hash),
  FOREIGN KEY (tenant_id,job_id,requesting_member_id,job_kind)
    REFERENCES app.integration_job(tenant_id,id,requesting_member_id,kind) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,requesting_member_id,initiating_actor_id)
    REFERENCES app.membership(tenant_id,id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,site_id,document_id)
    REFERENCES app.content_document(tenant_id,site_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,document_id,revision_id)
    REFERENCES app.content_revision(tenant_id,document_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,site_id,binding_id,binding_generation,origin)
    REFERENCES app.cms_synthetic_binding_version(tenant_id,site_id,id,binding_generation,origin)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,site_id,policy_id,policy_hash)
    REFERENCES app.cms_render_policy_version(tenant_id,site_id,id,policy_hash) ON DELETE RESTRICT
);

-- E. Private prepared HTML/SEO: no raw revision JSON/profile/session/credentials.
-- Scope and full semantic validation must precede INSERT; SQL bounds supplement
-- prepareCmsPublication, never replace schema/theme/link/CSP/escaping validation.
CREATE TABLE app.cms_prepared_release (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL,
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  expected_document_version bigint NOT NULL,
  next_document_version bigint NOT NULL CHECK (next_document_version=expected_document_version+1),
  binding_id uuid NOT NULL,
  binding_generation bigint NOT NULL,
  origin text NOT NULL,
  route text NOT NULL CHECK (length(route) BETWEEN 2 AND 161
    AND route ~ '^/[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$'
    AND split_part(route,'/',2) NOT IN ('api','v1','dev','staff','preview')),
  canonical_url text NOT NULL CHECK (canonical_url=origin || route),
  title text NOT NULL CHECK (length(title)<=200),
  kind text NOT NULL CHECK (kind IN ('page','landing','blog','community','agent','testimonial')),
  theme_version text NOT NULL CHECK (length(theme_version)<=80),
  seo jsonb NOT NULL CHECK (jsonb_typeof(seo)='object' AND octet_length(seo::text)<=4096),
  policy_id uuid NOT NULL,
  policy_hash text NOT NULL,
  content_hash text NOT NULL,
  html text NOT NULL CHECK (octet_length(convert_to(html,'UTF8')) BETWEEN 1 AND 1048576),
  html_hash text NOT NULL CHECK (html_hash ~ '^[a-f0-9]{64}$'
    AND html_hash=encode(sha256(convert_to(html,'UTF8')),'hex')),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[a-f0-9]{64}$'),
  content_security_policy text NOT NULL CHECK (length(content_security_policy)<=2048),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,job_id),
  UNIQUE (tenant_id,site_id,document_id,id,job_id,revision_id,route,binding_id,binding_generation),
  FOREIGN KEY (tenant_id,job_id,site_id,document_id,revision_id,expected_document_version,
    binding_id,binding_generation,origin,policy_id,policy_hash,content_hash)
    REFERENCES app.cms_publication_command(tenant_id,job_id,site_id,document_id,revision_id,
      expected_document_version,binding_id,binding_generation,origin,policy_id,policy_hash,content_hash)
    ON DELETE RESTRICT
);

-- F. Current fenced claim is CMS-owned, not a second job table. The foundation
-- port synchronizes fence=integration_job.attempt_count, state, row_version,
-- lease_until atomically. Expiry is a CURRENT clock check, never a timeless CHECK.
CREATE TABLE app.cms_publication_claim (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  fence integer NOT NULL CHECK (fence>0),
  lease_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  job_row_version bigint NOT NULL CHECK (job_row_version BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (tenant_id,job_id),
  FOREIGN KEY (tenant_id,job_id) REFERENCES app.cms_publication_command(tenant_id,job_id) ON DELETE RESTRICT
);
CREATE TABLE app.cms_publication_release (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  job_id uuid NOT NULL,
  prepared_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  route text NOT NULL,
  binding_id uuid NOT NULL,
  binding_generation bigint NOT NULL,
  publication_generation bigint NOT NULL CHECK (publication_generation BETWEEN 1 AND 9007199254740991),
  execution_fence integer NOT NULL CHECK (execution_fence>0),
  outbox_event_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,job_id),
  UNIQUE (tenant_id,site_id,publication_generation),
  UNIQUE (tenant_id,site_id,document_id,revision_id,id),
  UNIQUE (tenant_id,site_id,document_id,id,route),
  FOREIGN KEY (tenant_id,site_id,document_id,prepared_id,job_id,revision_id,route,binding_id,binding_generation)
    REFERENCES app.cms_prepared_release(tenant_id,site_id,document_id,id,job_id,revision_id,route,binding_id,binding_generation)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,outbox_event_id) REFERENCES app.outbox(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,audit_event_id) REFERENCES app.audit_event(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE app.cms_publication_command ADD COLUMN rollback_source_release_id uuid;
ALTER TABLE app.cms_publication_command ADD CONSTRAINT cms_rollback_completed_source
  CHECK ((operation='rollback' AND rollback_source_release_id IS NOT NULL)
    OR (operation='publish' AND rollback_source_release_id IS NULL));
ALTER TABLE app.cms_publication_command ADD FOREIGN KEY
  (tenant_id,site_id,document_id,revision_id,rollback_source_release_id)
  REFERENCES app.cms_publication_release(tenant_id,site_id,document_id,revision_id,id) ON DELETE RESTRICT;
CREATE TABLE app.cms_public_route (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  document_id uuid NOT NULL,
  route text NOT NULL,
  release_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,site_id,route),
  UNIQUE (tenant_id,site_id,document_id),
  FOREIGN KEY (tenant_id,site_id,document_id,release_id,route)
    REFERENCES app.cms_publication_release(tenant_id,site_id,document_id,id,route) ON DELETE RESTRICT
);

-- G. Private authority capsule. No runtime/worker/anonymous direct INSERT/SELECT.
-- Minted solely inside reviewed source/host resolver entry points; GUC nonce is
-- only a selector. It grants nothing without this same backend/transaction row.
-- Public capsule: actor/job NULL, exact resolved host/binding/release/prepared ID.
-- Execution capsule: initiating actor/current job/fence, never serialized grants.
CREATE TABLE app.cms_publication_context (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  purpose text NOT NULL CHECK (purpose IN ('command','execution','public_lookup','public')),
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  actor_id uuid,
  job_id uuid,
  fence integer,
  authority text,
  route text,
  binding_id uuid,
  binding_generation bigint,
  release_id uuid,
  prepared_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  PRIMARY KEY (backend_pid,transaction_id,nonce),
  CHECK (valid_until>created_at AND valid_until<=created_at+interval '5 seconds'),
  CHECK (purpose<>'public' OR (actor_id IS NULL AND job_id IS NULL AND fence IS NULL
    AND authority IS NOT NULL AND route IS NOT NULL AND binding_id IS NOT NULL AND binding_generation IS NOT NULL
    AND release_id IS NOT NULL AND prepared_id IS NOT NULL)),
  CHECK (purpose<>'public_lookup' OR (actor_id IS NULL AND job_id IS NULL AND fence IS NULL
    AND authority IS NOT NULL AND route IS NOT NULL AND binding_id IS NOT NULL AND binding_generation IS NOT NULL)),
  CHECK (purpose<>'command' OR actor_id IS NOT NULL),
  CHECK (purpose<>'execution' OR (actor_id IS NOT NULL AND job_id IS NOT NULL AND fence IS NOT NULL AND fence>0))
);
-- Resolver deletes its capsule before return; ROLLBACK/connection reset removes
-- authority. Owner-only bounded TTL cleanup handles exceptional committed rows.

-- H. Immutability includes statement TRUNCATE; no application can rewrite history.
CREATE FUNCTION app.reject_cms_publication_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $immutable$
BEGIN
  RAISE EXCEPTION 'CMS publication history is immutable' USING ERRCODE='55000';
END;
$immutable$;
REVOKE ALL ON FUNCTION app.reject_cms_publication_history_change() FROM PUBLIC;
CREATE FUNCTION app.guard_cms_publication_counter_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $counter$
BEGIN
  IF TG_TABLE_NAME='cms_synthetic_host_sequence' THEN
    IF NEW.hostname IS DISTINCT FROM OLD.hostname
      OR NEW.last_generation IS DISTINCT FROM OLD.last_generation+1 THEN
      RAISE EXCEPTION 'Invalid host generation transition' USING ERRCODE='55000';
    END IF;
  ELSE
    IF (NEW.tenant_id,NEW.site_id) IS DISTINCT FROM (OLD.tenant_id,OLD.site_id)
      OR (NEW.publication_generation IS DISTINCT FROM OLD.publication_generation
        AND NEW.publication_generation IS DISTINCT FROM OLD.publication_generation+1) THEN
      RAISE EXCEPTION 'Invalid publication generation transition' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$counter$;
REVOKE ALL ON FUNCTION app.guard_cms_publication_counter_change() FROM PUBLIC;
CREATE TRIGGER cms_host_counter_monotonic BEFORE UPDATE ON app.cms_synthetic_host_sequence
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_publication_counter_change();
CREATE TRIGGER cms_host_counter_retained BEFORE DELETE ON app.cms_synthetic_host_sequence
  FOR EACH ROW EXECUTE FUNCTION app.reject_cms_publication_history_change();
CREATE TRIGGER cms_host_counter_no_reset BEFORE TRUNCATE ON app.cms_synthetic_host_sequence
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_cms_publication_history_change();
CREATE TRIGGER cms_site_counter_monotonic BEFORE UPDATE ON app.cms_site_publication_state
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_publication_counter_change();
CREATE TRIGGER cms_site_counter_retained BEFORE DELETE ON app.cms_site_publication_state
  FOR EACH ROW EXECUTE FUNCTION app.reject_cms_publication_history_change();
CREATE TRIGGER cms_site_counter_no_reset BEFORE TRUNCATE ON app.cms_site_publication_state
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_cms_publication_history_change();
DO $history$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['cms_synthetic_binding_version','cms_render_policy_version',
    'cms_publication_command','cms_prepared_release','cms_publication_release'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.reject_cms_publication_history_change()',relation_name);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON app.%I FOR EACH STATEMENT EXECUTE FUNCTION app.reject_cms_publication_history_change()',relation_name);
  END LOOP;
END;
$history$;

-- I. RLS expand defaults: FORCED and zero accessible rows until ports are approved.
-- Deliberately NO author tenant_scope or public policy on private native tables.
-- Role creation/ownership assignment/activation grants are NOT in this candidate.
DO $rls$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['cms_synthetic_host_sequence','cms_synthetic_binding_version','cms_synthetic_host_current',
    'cms_render_policy_version','cms_site_publication_state','cms_publication_command',
    'cms_prepared_release','cms_publication_claim','cms_publication_release','cms_public_route',
    'cms_publication_context'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',relation_name);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC,estate_runtime,estate_worker',relation_name);
  END LOOP;
END;
$rls$;

-- J. Port placeholders are review signatures, not implementations. These always
-- deny; no caller can mint capsules, resolve a directory or commit a release.
-- Shared owners must replace them AFTER exact declarations and actual-role probes.
CREATE FUNCTION app.cms_publication_row_allowed(
  row_tenant uuid,row_site uuid,row_job uuid,row_release uuid,row_prepared uuid,row_route text,purpose text
) RETURNS boolean LANGUAGE sql VOLATILE
SET search_path=pg_catalog,app,pg_temp AS $denied$ SELECT false $denied$;
REVOKE ALL ON FUNCTION app.cms_publication_row_allowed(uuid,uuid,uuid,uuid,uuid,text,text) FROM PUBLIC;
CREATE FUNCTION app.cms_resolve_synthetic_public_page(authority text,route text)
RETURNS TABLE (canonical_url text,title text,seo jsonb,html text,html_hash text,content_security_policy text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp
AS $no_public_read$
  SELECT NULL::text,NULL::text,NULL::jsonb,NULL::text,NULL::text,NULL::text WHERE false
$no_public_read$;
REVOKE ALL ON FUNCTION app.cms_resolve_synthetic_public_page(text,text) FROM PUBLIC;

-- Prospective public policies on NEW projection tables only (still always false).
-- Named non-login owner roles and EXECUTE grants are separately reviewed; current_user
-- checks are additional boundaries, never replacements for private capsule/current gates.
CREATE POLICY cms_public_prepared_projection ON app.cms_prepared_release FOR SELECT
  USING (current_user='estate_cms_public_resolver' AND
    app.cms_publication_row_allowed(tenant_id,site_id,NULL,NULL,id,route,'public'));
CREATE POLICY cms_public_release_projection ON app.cms_publication_release FOR SELECT
  USING (current_user='estate_cms_public_resolver' AND
    (app.cms_publication_row_allowed(tenant_id,site_id,NULL,id,prepared_id,route,'public_lookup')
      OR app.cms_publication_row_allowed(tenant_id,site_id,NULL,id,prepared_id,route,'public')));
CREATE POLICY cms_public_active_route ON app.cms_public_route FOR SELECT
  USING (current_user='estate_cms_public_resolver' AND
    (app.cms_publication_row_allowed(tenant_id,site_id,NULL,release_id,NULL,route,'public_lookup')
      OR app.cms_publication_row_allowed(tenant_id,site_id,NULL,release_id,NULL,route,'public')));

-- Minimal activation grant/port matrix is specified in the companion review.
-- No GRANT/role provisioning or native-table/public tenant policies occur here.
-- Bound integration_job kind/requester/connection identity must also become
-- immutable and runtime/worker CMS transitions restricted by its OWNER port;
-- existing permissive tenant_scope and runtime billing job UPDATE are insufficient.
ROLLBACK;
