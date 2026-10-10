-- PROPOSAL ONLY, 2026-10-10. Not a migration; no sequence is allocated.
-- Companion: publication-storage-review.md. Follow-up to root review9a95e93.
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
  hostname text PRIMARY KEY CHECK (length(hostname)<=253 AND hostname=lower(hostname)
    AND hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*example\.test$'),
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
  UNIQUE (id),
  UNIQUE (hostname,binding_generation),
  UNIQUE (tenant_id,site_id,hostname,binding_generation),
  UNIQUE (tenant_id,site_id,id,binding_generation,origin),
  UNIQUE (hostname,tenant_id,site_id,id,binding_generation),
  FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (hostname) REFERENCES app.cms_synthetic_host_sequence(hostname) ON DELETE RESTRICT
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
-- Head DELETE also consumes a generation. No disabled historical head is restored.
-- A separate owner-only permit proves that this transaction has acquired the
-- namespace/counter -> head -> domain prefix. Triggers must NEVER acquire that
-- prefix backwards after their statement has implicitly locked a row.
CREATE TABLE app.cms_synthetic_namespace_permit (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  minter_role name NOT NULL DEFAULT current_user,
  hostname text NOT NULL,
  action text NOT NULL CHECK (action IN ('bind','detach','domain_write')),
  domain_operation text CHECK (domain_operation IN ('INSERT','UPDATE','DELETE')),
  expected_generation bigint NOT NULL CHECK (expected_generation BETWEEN 0 AND 9007199254740990),
  next_generation bigint NOT NULL CHECK (next_generation=expected_generation+1),
  old_binding_id uuid,
  old_binding_generation bigint,
  old_tenant_id uuid,
  old_site_id uuid,
  old_enabled boolean,
  next_binding_id uuid,
  target_tenant_id uuid,
  target_site_id uuid,
  domain_id uuid,
  domain_row_version bigint,
  binding_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz NOT NULL,
  consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (backend_pid,transaction_id,nonce),
  CHECK (valid_until>created_at AND valid_until<=created_at+interval '5 seconds'),
  CHECK ((action IN ('bind','detach') AND minter_role='estate_cms_namespace_owner')
    OR (action='domain_write' AND minter_role='estate_cms_domain_source_owner')),
  CHECK ((action='domain_write' AND domain_operation IS NOT NULL AND domain_id IS NOT NULL
      AND target_tenant_id IS NOT NULL AND target_site_id IS NOT NULL
      AND old_binding_id IS NULL AND old_binding_generation IS NULL
      AND old_tenant_id IS NULL AND old_site_id IS NULL AND old_enabled IS NULL
      AND next_binding_id IS NULL AND binding_expires_at IS NULL)
    OR (action<>'domain_write' AND domain_operation IS NULL)),
  CHECK (action<>'domain_write'
    OR (domain_operation='INSERT' AND domain_row_version IS NULL)
    OR (domain_operation IN ('UPDATE','DELETE') AND domain_row_version IS NOT NULL AND domain_row_version>0)),
  CHECK (action<>'bind' OR (next_binding_id IS NOT NULL AND target_tenant_id IS NOT NULL
    AND target_site_id IS NOT NULL AND domain_id IS NOT NULL AND domain_row_version IS NOT NULL
    AND domain_row_version BETWEEN 1 AND 9007199254740991 AND binding_expires_at IS NOT NULL)),
  CHECK (action<>'detach' OR old_binding_id IS NOT NULL)
);

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
-- Retain this row after completion/expiry: DELETE/reinsert cannot reset a fence.
-- First claim is fence1; reclaim advances exactly once after lease retirement.
CREATE TABLE app.cms_publication_claim (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  fence integer NOT NULL CHECK (fence>0),
  lease_owner uuid NOT NULL,
  lease_until timestamptz NOT NULL CHECK (isfinite(lease_until)),
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
  CHECK (isfinite(created_at) AND isfinite(valid_until)),
  CHECK (valid_until>created_at AND valid_until<=created_at+interval '5 seconds'),
  CHECK (fence IS NULL OR fence>0),
  CHECK ((binding_id IS NULL)=(binding_generation IS NULL)),
  CHECK (binding_generation IS NULL OR binding_generation BETWEEN 1 AND 9007199254740991),
  CHECK (purpose<>'public' OR (actor_id IS NULL AND job_id IS NULL AND fence IS NULL
    AND authority IS NOT NULL AND route IS NOT NULL AND binding_id IS NOT NULL AND binding_generation IS NOT NULL
    AND release_id IS NOT NULL AND prepared_id IS NOT NULL)),
  CHECK (purpose<>'public_lookup' OR (actor_id IS NULL AND job_id IS NULL AND fence IS NULL
    AND authority IS NOT NULL AND route IS NOT NULL AND binding_id IS NOT NULL AND binding_generation IS NOT NULL
    AND release_id IS NULL AND prepared_id IS NULL)),
  CHECK (purpose<>'command' OR actor_id IS NOT NULL),
  CHECK (purpose<>'execution' OR (actor_id IS NOT NULL AND job_id IS NOT NULL AND fence IS NOT NULL AND fence>0))
);
-- Lifecycle/provenance only: source rights and exact owner roles remain CLOSED
-- shared prerequisites. No grant, minting entry point or eligibility decision.
-- Only a lookup capsule can advance once to public; preserve every scope field
-- and the original mint clock, narrowing expiry to current source limits.
-- Command/execution capsules are immutable; a new authorized attempt mints a
-- new nonce rather than rewriting actor/job/fence or renewing an old capsule.
CREATE FUNCTION app.guard_cms_publication_context() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $context_lifecycle$
DECLARE checked_clock timestamptz:=clock_timestamp(); expected app.cms_publication_context;
BEGIN
  IF NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.nonce IS NULL
    OR NEW.created_at IS NULL OR NEW.valid_until IS NULL
    OR NOT isfinite(NEW.created_at) OR NOT isfinite(NEW.valid_until)
    OR NEW.created_at>checked_clock OR NEW.valid_until<=checked_clock THEN
    RAISE EXCEPTION 'CMS publication context unavailable' USING ERRCODE='42501';
  END IF;
  IF NEW.valid_until<=NEW.created_at OR NEW.valid_until>NEW.created_at+interval '5 seconds' THEN
    RAISE EXCEPTION 'CMS publication context unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.purpose IS NOT DISTINCT FROM 'public' THEN
      RAISE EXCEPTION 'CMS public lookup context required' USING ERRCODE='42501';
    END IF;
  ELSE
    IF OLD.purpose IS DISTINCT FROM 'public_lookup' OR NEW.purpose IS DISTINCT FROM 'public'
      OR NEW.release_id IS NULL OR NEW.prepared_id IS NULL
      OR NEW.valid_until>OLD.valid_until THEN
      RAISE EXCEPTION 'CMS publication context transition unavailable' USING ERRCODE='42501';
    END IF;
    expected:=OLD;
    expected.purpose:='public';
    expected.release_id:=NEW.release_id;
    expected.prepared_id:=NEW.prepared_id;
    expected.valid_until:=NEW.valid_until;
    IF NEW IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'CMS publication context scope is immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$context_lifecycle$;
REVOKE ALL ON FUNCTION app.guard_cms_publication_context() FROM PUBLIC;
CREATE TRIGGER cms_publication_context_guard BEFORE INSERT OR UPDATE ON app.cms_publication_context
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_publication_context();
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
-- Claim shape/lifecycle only. The foundation's CLOSED job ports must still
-- authorize the holder and atomically prove actual job attempt/version/state.
-- Inspect only this row and clock: no job/source lookup or inverted row lock.
CREATE FUNCTION app.guard_cms_publication_claim() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $claim_lifecycle$
DECLARE checked_clock timestamptz:=clock_timestamp(); expected app.cms_publication_claim;
BEGIN
  IF NEW.lease_until IS NULL OR NOT isfinite(NEW.lease_until) THEN
    RAISE EXCEPTION 'CMS publication claim unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.fence IS DISTINCT FROM 1 OR NEW.lease_until<=checked_clock THEN
      RAISE EXCEPTION 'CMS initial publication claim unavailable' USING ERRCODE='42501';
    END IF;
  ELSE
    IF OLD.job_row_version>=9007199254740991 THEN
      RAISE EXCEPTION 'CMS publication claim version exhausted' USING ERRCODE='55000';
    END IF;
    IF NEW.job_row_version IS NULL OR NEW.job_row_version<=OLD.job_row_version THEN
      RAISE EXCEPTION 'CMS publication claim version changed' USING ERRCODE='40001';
    END IF;
    IF NEW.fence IS NOT DISTINCT FROM OLD.fence THEN
      IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
        OR (NEW.lease_until>OLD.lease_until AND OLD.lease_until<=checked_clock) THEN
        RAISE EXCEPTION 'CMS publication claim holder or lease changed' USING ERRCODE='42501';
      END IF;
    ELSE
      -- A standalone check rejects integer overflow BEFORE evaluating +1.
      IF OLD.fence>=2147483647 THEN
        RAISE EXCEPTION 'CMS publication claim fence exhausted' USING ERRCODE='55000';
      END IF;
      IF NEW.fence IS DISTINCT FROM OLD.fence+1 OR OLD.lease_until>checked_clock
        OR NEW.lease_until<=checked_clock THEN
        RAISE EXCEPTION 'CMS publication reclaim unavailable' USING ERRCODE='42501';
      END IF;
    END IF;
    expected:=OLD;
    expected.fence:=NEW.fence;
    expected.lease_owner:=NEW.lease_owner;
    expected.lease_until:=NEW.lease_until;
    expected.job_row_version:=NEW.job_row_version;
    IF NEW IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'CMS publication claim identity is immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$claim_lifecycle$;
REVOKE ALL ON FUNCTION app.guard_cms_publication_claim() FROM PUBLIC;
CREATE TRIGGER cms_publication_claim_guard BEFORE INSERT OR UPDATE ON app.cms_publication_claim
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_publication_claim();
CREATE TRIGGER cms_publication_claim_retained BEFORE DELETE ON app.cms_publication_claim
  FOR EACH ROW EXECUTE FUNCTION app.reject_cms_publication_history_change();
CREATE TRIGGER cms_publication_claim_no_reset BEFORE TRUNCATE ON app.cms_publication_claim
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_cms_publication_history_change();
-- Permit provenance is immutable after minting. Its only UPDATE is one current
-- false -> true consumption; callers cannot extend expiry or rewrite a proof.
-- No source/prefix lookup or lock is acquired from this private-row trigger.
CREATE FUNCTION app.guard_cms_synthetic_namespace_permit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $permit_provenance$
DECLARE checked_clock timestamptz:=clock_timestamp(); expected app.cms_synthetic_namespace_permit;
BEGIN
  IF current_user NOT IN ('estate_cms_namespace_owner','estate_cms_domain_source_owner')
    OR NEW.minter_role IS DISTINCT FROM current_user
    OR NEW.backend_pid IS DISTINCT FROM pg_backend_pid()
    OR NEW.transaction_id IS DISTINCT FROM pg_current_xact_id() OR NEW.nonce IS NULL
    OR ((current_user='estate_cms_namespace_owner' AND NEW.action IN ('bind','detach'))
      OR (current_user='estate_cms_domain_source_owner' AND NEW.action='domain_write')) IS DISTINCT FROM true
    OR NEW.created_at IS NULL OR NEW.created_at>checked_clock
    OR NEW.valid_until IS NULL OR NEW.valid_until<=checked_clock THEN
    RAISE EXCEPTION 'Synthetic namespace permit provenance unavailable' USING ERRCODE='42501';
  END IF;
  -- Validate timestamps before interval arithmetic; no future/expired proof.
  IF NEW.valid_until<=NEW.created_at OR NEW.valid_until>NEW.created_at+interval '5 seconds' THEN
    RAISE EXCEPTION 'Synthetic namespace permit provenance unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.consumed IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Synthetic namespace permit provenance unavailable' USING ERRCODE='42501';
    END IF;
  ELSE
    expected:=OLD;
    expected.consumed:=true;
    IF OLD.consumed IS DISTINCT FROM false OR NEW IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'Synthetic namespace permit provenance is immutable' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$permit_provenance$;
REVOKE ALL ON FUNCTION app.guard_cms_synthetic_namespace_permit() FROM PUBLIC;
CREATE TRIGGER cms_synthetic_namespace_permit_guard BEFORE INSERT OR UPDATE ON app.cms_synthetic_namespace_permit
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_synthetic_namespace_permit();

-- Hosting-private receipt reader. No prefix locks here: a BEFORE row trigger
-- already owns its statement's implicit row lock. A GUC alone is not a permit.
CREATE FUNCTION app.cms_current_namespace_permit(p_hostname text)
RETURNS app.cms_synthetic_namespace_permit LANGUAGE plpgsql VOLATILE
SET search_path=pg_catalog,app,pg_temp AS $permit$
DECLARE receipt app.cms_synthetic_namespace_permit; selector uuid;
BEGIN
  IF current_user NOT IN ('estate_cms_namespace_owner','estate_cms_domain_source_owner') THEN
    RAISE EXCEPTION 'Synthetic namespace command required' USING ERRCODE='42501';
  END IF;
  BEGIN
    selector:=NULLIF(current_setting('app.cms_namespace_nonce',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Synthetic namespace command required' USING ERRCODE='42501';
  END;
  SELECT p.* INTO receipt FROM app.cms_synthetic_namespace_permit p
    WHERE p.backend_pid=pg_backend_pid() AND p.transaction_id=pg_current_xact_id()
      AND p.nonce=selector AND p.hostname=p_hostname AND p.minter_role=current_user
      AND ((current_user='estate_cms_namespace_owner' AND p.action IN ('bind','detach'))
        OR (current_user='estate_cms_domain_source_owner' AND p.action='domain_write'))
      AND NOT p.consumed AND p.created_at<=clock_timestamp() AND p.valid_until>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic namespace command required' USING ERRCODE='42501';
  END IF;
  RETURN receipt;
END;
$permit$;
REVOKE ALL ON FUNCTION app.cms_current_namespace_permit(text) FROM PUBLIC;

CREATE FUNCTION app.guard_cms_synthetic_binding_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $binding_insert$
DECLARE receipt app.cms_synthetic_namespace_permit; actual_generation bigint;
BEGIN
  receipt:=app.cms_current_namespace_permit(NEW.hostname);
  SELECT s.last_generation INTO actual_generation FROM app.cms_synthetic_host_sequence s
    WHERE s.hostname=NEW.hostname;
  IF receipt.action<>'bind' OR actual_generation IS DISTINCT FROM receipt.next_generation
    OR (NEW.id,NEW.tenant_id,NEW.site_id,NEW.binding_generation,NEW.domain_id,NEW.domain_row_version,
      NEW.created_at,NEW.expires_at)
      IS DISTINCT FROM (receipt.next_binding_id,receipt.target_tenant_id,receipt.target_site_id,
        receipt.next_generation,receipt.domain_id,receipt.domain_row_version,receipt.created_at,receipt.binding_expires_at)
    OR NEW.expires_at<=clock_timestamp()
    OR NOT EXISTS (SELECT 1 FROM app.site_domain d WHERE d.id=NEW.domain_id AND d.tenant_id=NEW.tenant_id
      AND d.site_id=NEW.site_id AND d.hostname=NEW.hostname AND d.row_version=NEW.domain_row_version) THEN
    RAISE EXCEPTION 'Current synthetic binding source unavailable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$binding_insert$;
REVOKE ALL ON FUNCTION app.guard_cms_synthetic_binding_insert() FROM PUBLIC;
CREATE TRIGGER cms_synthetic_binding_insert_guard BEFORE INSERT ON app.cms_synthetic_binding_version
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_synthetic_binding_insert();

CREATE FUNCTION app.guard_cms_synthetic_head_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $head$
DECLARE receipt app.cms_synthetic_namespace_permit; actual_generation bigint; matched boolean;
BEGIN
  IF TG_OP='TRUNCATE' THEN
    RAISE EXCEPTION 'Synthetic namespace command required' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    receipt:=app.cms_current_namespace_permit(NEW.hostname);
    IF receipt.old_binding_id IS NOT NULL THEN
      RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001';
    END IF;
  ELSE
    receipt:=app.cms_current_namespace_permit(OLD.hostname);
    IF (OLD.tenant_id,OLD.site_id,OLD.binding_id,OLD.binding_generation,OLD.enabled)
      IS DISTINCT FROM (receipt.old_tenant_id,receipt.old_site_id,receipt.old_binding_id,
        receipt.old_binding_generation,receipt.old_enabled)
      OR OLD.binding_generation<>receipt.expected_generation THEN
      RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001';
    END IF;
  END IF;
  -- Plain reads only. The command already holds counter/head/domain locks.
  SELECT s.last_generation INTO actual_generation FROM app.cms_synthetic_host_sequence s
    WHERE s.hostname=receipt.hostname;
  IF actual_generation IS DISTINCT FROM receipt.next_generation THEN
    RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001';
  END IF;
  IF receipt.action='detach' AND TG_OP='DELETE' THEN
    UPDATE app.cms_synthetic_namespace_permit SET consumed=true
      WHERE backend_pid=receipt.backend_pid AND transaction_id=receipt.transaction_id AND nonce=receipt.nonce
        AND minter_role=current_user AND NOT consumed AND valid_until>clock_timestamp();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Synthetic namespace permit unavailable' USING ERRCODE='42501';
    END IF;
    RETURN OLD;
  END IF;
  IF receipt.action<>'bind' OR TG_OP NOT IN ('INSERT','UPDATE') THEN
    RAISE EXCEPTION 'Synthetic namespace command required' USING ERRCODE='42501';
  END IF;
  IF (NEW.hostname,NEW.tenant_id,NEW.site_id,NEW.binding_id,NEW.binding_generation,NEW.enabled)
    IS DISTINCT FROM (receipt.hostname,receipt.target_tenant_id,receipt.target_site_id,
      receipt.next_binding_id,receipt.next_generation,true) THEN
    RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001';
  END IF;
  SELECT EXISTS (SELECT 1 FROM app.cms_synthetic_binding_version b
    JOIN app.site_domain d ON d.id=b.domain_id AND d.tenant_id=b.tenant_id AND d.site_id=b.site_id
      AND d.hostname=b.hostname AND d.row_version=b.domain_row_version
    WHERE b.id=receipt.next_binding_id AND b.hostname=receipt.hostname
      AND b.tenant_id=receipt.target_tenant_id AND b.site_id=receipt.target_site_id
      AND b.binding_generation=receipt.next_generation AND b.domain_id=receipt.domain_id
      AND b.domain_row_version=receipt.domain_row_version AND b.origin='https://' || receipt.hostname
      AND b.mode='synthetic' AND b.evidence_code='synthetic-fixture-v1'
      AND b.expires_at=receipt.binding_expires_at AND b.expires_at>clock_timestamp()) INTO matched;
  IF NOT matched THEN
    RAISE EXCEPTION 'Current synthetic domain unavailable' USING ERRCODE='40001';
  END IF;
  UPDATE app.cms_synthetic_namespace_permit SET consumed=true
    WHERE backend_pid=receipt.backend_pid AND transaction_id=receipt.transaction_id AND nonce=receipt.nonce
      AND minter_role=current_user AND NOT consumed AND valid_until>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic namespace permit unavailable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$head$;
REVOKE ALL ON FUNCTION app.guard_cms_synthetic_head_change() FROM PUBLIC;
CREATE TRIGGER cms_synthetic_head_guard BEFORE INSERT OR UPDATE OR DELETE ON app.cms_synthetic_host_current
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_synthetic_head_change();
CREATE TRIGGER cms_synthetic_head_no_reset BEFORE TRUNCATE ON app.cms_synthetic_host_current
  FOR EACH STATEMENT EXECUTE FUNCTION app.guard_cms_synthetic_head_change();

-- Existing domain-source writes touching ANY reserved example.test hostname must
-- join the SAME prefix before their implicit domain row lock. This trigger only
-- validates an already minted domain_write permit; it never locks the counter.
-- Root's domain owner command/minting port is not implemented by this candidate.
-- Recognize the reserved suffix directly, BEFORE consulting RLS-hidden rows.
-- Even unregistered fixture domains require the owner to bootstrap/lock a counter
-- before source DML. Missing visibility/permit cannot mean "not registered".
CREATE FUNCTION app.guard_cms_synthetic_domain_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $domain_guard$
DECLARE old_name text; new_name text; namespace_name text; receipt app.cms_synthetic_namespace_permit;
  actual_generation bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN old_name:=OLD.hostname; END IF;
  IF TG_OP<>'DELETE' THEN new_name:=NEW.hostname; END IF;
  IF lower(old_name)='example.test' OR lower(old_name) LIKE '%.example.test' THEN
    namespace_name:=lower(old_name);
  ELSIF lower(new_name)='example.test' OR lower(new_name) LIKE '%.example.test' THEN
    namespace_name:=lower(new_name);
  END IF;
  IF namespace_name IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='UPDATE' AND old_name IS DISTINCT FROM new_name THEN
    RAISE EXCEPTION 'Fixture hostname rename requires separate commands' USING ERRCODE='55000';
  END IF;
  receipt:=app.cms_current_namespace_permit(namespace_name);
  SELECT s.last_generation INTO actual_generation FROM app.cms_synthetic_host_sequence s
    WHERE s.hostname=namespace_name;
  IF receipt.action<>'domain_write' OR receipt.domain_operation IS DISTINCT FROM TG_OP
    OR actual_generation IS DISTINCT FROM receipt.next_generation
    OR EXISTS (SELECT 1 FROM app.cms_synthetic_host_current h WHERE h.hostname=namespace_name) THEN
    RAISE EXCEPTION 'Synthetic domain must be detached first' USING ERRCODE='42501';
  END IF;
  IF TG_OP='INSERT' THEN
    IF (NEW.id,NEW.tenant_id,NEW.site_id,NEW.hostname,NEW.row_version)
      IS DISTINCT FROM (receipt.domain_id,receipt.target_tenant_id,receipt.target_site_id,namespace_name,1::bigint) THEN
      RAISE EXCEPTION 'Synthetic domain source changed' USING ERRCODE='40001';
    END IF;
  ELSE
    IF (OLD.id,OLD.tenant_id,OLD.site_id,OLD.hostname,OLD.row_version)
      IS DISTINCT FROM (receipt.domain_id,receipt.target_tenant_id,receipt.target_site_id,
        namespace_name,receipt.domain_row_version) THEN
      RAISE EXCEPTION 'Synthetic domain source changed' USING ERRCODE='40001';
    END IF;
    IF TG_OP='UPDATE' THEN
      -- Separate statements reject even a legacy bigint maximum BEFORE +1;
      -- Boolean expression evaluation order is not an overflow safeguard.
      IF OLD.row_version>=9007199254740991 THEN
        RAISE EXCEPTION 'Synthetic domain source version exhausted' USING ERRCODE='55000';
      END IF;
      IF (NEW.id,NEW.tenant_id,NEW.site_id,NEW.hostname,NEW.row_version)
        IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.site_id,OLD.hostname,OLD.row_version+1) THEN
        RAISE EXCEPTION 'Synthetic domain source version unavailable' USING ERRCODE='40001';
      END IF;
    END IF;
  END IF;
  UPDATE app.cms_synthetic_namespace_permit SET consumed=true
    WHERE backend_pid=receipt.backend_pid AND transaction_id=receipt.transaction_id AND nonce=receipt.nonce
      AND minter_role=current_user AND NOT consumed AND valid_until>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic namespace permit unavailable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$domain_guard$;
REVOKE ALL ON FUNCTION app.guard_cms_synthetic_domain_change() FROM PUBLIC;
CREATE TRIGGER cms_synthetic_domain_guard BEFORE INSERT OR UPDATE OR DELETE ON app.site_domain
  FOR EACH ROW EXECUTE FUNCTION app.guard_cms_synthetic_domain_change();
CREATE TRIGGER cms_synthetic_domain_no_reset BEFORE TRUNCATE ON app.site_domain
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_cms_publication_history_change();

-- Exact proposed bind/detach command. Source/fixture authorization remains an
-- UNIMPLEMENTED shared prerequisite; false means this cannot change a namespace.
-- Domain-write permit minting stays with root's separately reviewed domain owner.
CREATE FUNCTION app.cms_synthetic_namespace_source_allowed(
  p_hostname text,p_action text,p_domain_id uuid,p_domain_version bigint
) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=pg_catalog,app,pg_temp
AS $namespace_source_closed$ SELECT false $namespace_source_closed$;
REVOKE ALL ON FUNCTION app.cms_synthetic_namespace_source_allowed(text,text,uuid,bigint) FROM PUBLIC;
CREATE FUNCTION app.cms_synthetic_namespace_command(
  p_hostname text,p_action text,p_expected_generation bigint,
  p_domain_id uuid DEFAULT NULL,p_expected_domain_version bigint DEFAULT NULL,
  p_valid_for_seconds integer DEFAULT 30
) RETURNS TABLE (generation bigint,binding_id uuid,enabled boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,app,pg_temp
AS $namespace_command$
DECLARE counter_value bigint; next_value bigint; old_head app.cms_synthetic_host_current;
  domain_source record; selected_domain uuid; selected_version bigint;
  next_binding uuid; selector uuid; proof_expires timestamptz; checked_clock timestamptz;
BEGIN
  IF current_user<>'estate_cms_namespace_owner' THEN
    RAISE EXCEPTION 'Synthetic namespace unavailable' USING ERRCODE='42501';
  END IF;
  IF p_hostname IS NULL OR length(p_hostname)>253 OR p_hostname<>lower(p_hostname)
    OR p_hostname !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*example\.test$'
    OR p_action IS NULL OR p_action NOT IN ('bind','detach')
    OR p_expected_generation IS NULL OR p_expected_generation NOT BETWEEN 0 AND 9007199254740991
    OR p_valid_for_seconds IS NULL OR p_valid_for_seconds NOT BETWEEN 1 AND 300
    OR (p_action='bind' AND (p_domain_id IS NULL OR p_expected_domain_version IS NULL
      OR p_expected_domain_version NOT BETWEEN 1 AND 9007199254740991))
    OR (p_action='detach' AND (p_domain_id IS NOT NULL OR p_expected_domain_version IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid synthetic namespace command' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.cms_namespace_nonce','',true);
  -- Fixed platform advisory key, independent of tenant. Hash collisions only
  -- serialize unrelated hosts. Bootstrap INSERT/uniqueness locks are inside it.
  PERFORM pg_advisory_xact_lock(hashtextextended('cms-synthetic-v1:' || p_hostname,0));
  INSERT INTO app.cms_synthetic_host_sequence(hostname,last_generation)
    VALUES(p_hostname,0) ON CONFLICT(hostname) DO NOTHING;
  SELECT s.last_generation INTO counter_value FROM app.cms_synthetic_host_sequence s
    WHERE s.hostname=p_hostname FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic namespace unavailable' USING ERRCODE='42501';
  END IF;
  SELECT h.* INTO old_head FROM app.cms_synthetic_host_current h
    WHERE h.hostname=p_hostname FOR UPDATE;
  IF p_action='bind' THEN selected_domain:=p_domain_id;
  ELSE
    SELECT b.domain_id INTO selected_domain FROM app.cms_synthetic_binding_version b
      WHERE b.id=old_head.binding_id AND b.hostname=p_hostname;
  END IF;
  -- Source tuple lock comes LAST in the host prefix. No tenant ID is an argument.
  SELECT d.id,d.tenant_id,d.site_id,d.hostname,d.row_version INTO domain_source
    FROM app.site_domain d WHERE d.id=selected_domain AND d.hostname=p_hostname FOR SHARE;
  IF FOUND THEN selected_version:=domain_source.row_version; END IF;
  -- Shared source owner must hold/recheck current operator/configuration rights
  -- after this prefix, and deny unknown fixture/TLS/environment interpretation.
  IF app.cms_synthetic_namespace_source_allowed(p_hostname,p_action,selected_domain,selected_version) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Synthetic namespace unavailable' USING ERRCODE='42501';
  END IF;
  IF counter_value<>p_expected_generation OR
    (old_head.binding_id IS NOT NULL AND old_head.binding_generation<>counter_value) THEN
    RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001';
  END IF;
  IF counter_value>=9007199254740991 THEN
    RAISE EXCEPTION 'Synthetic namespace generation exhausted' USING ERRCODE='55000';
  END IF;
  IF p_action='bind' AND (selected_version IS NULL OR selected_version<>p_expected_domain_version) THEN
    RAISE EXCEPTION 'Current synthetic domain unavailable' USING ERRCODE='40001';
  END IF;
  IF p_action='detach' AND old_head.binding_id IS NULL THEN
    RAISE EXCEPTION 'Current synthetic head unavailable' USING ERRCODE='40001';
  END IF;
  next_value:=counter_value+1;
  checked_clock:=clock_timestamp();
  IF p_action='bind' THEN next_binding:=gen_random_uuid();
    proof_expires:=checked_clock+make_interval(secs=>p_valid_for_seconds);
  END IF;
  selector:=gen_random_uuid();
  INSERT INTO app.cms_synthetic_namespace_permit(backend_pid,transaction_id,nonce,hostname,action,
    expected_generation,next_generation,old_binding_id,old_binding_generation,old_tenant_id,old_site_id,old_enabled,
    next_binding_id,target_tenant_id,target_site_id,domain_id,domain_row_version,binding_expires_at,created_at,valid_until)
  VALUES(pg_backend_pid(),pg_current_xact_id(),selector,p_hostname,p_action,counter_value,next_value,
    old_head.binding_id,old_head.binding_generation,old_head.tenant_id,old_head.site_id,old_head.enabled,
    next_binding,domain_source.tenant_id,domain_source.site_id,selected_domain,selected_version,proof_expires,
    checked_clock,checked_clock+interval '5 seconds');
  PERFORM set_config('app.cms_namespace_nonce',selector::text,true);
  UPDATE app.cms_synthetic_host_sequence SET last_generation=next_value
    WHERE hostname=p_hostname AND last_generation=counter_value;
  IF NOT FOUND THEN RAISE EXCEPTION 'Synthetic namespace changed' USING ERRCODE='40001'; END IF;
  IF p_action='bind' THEN
    INSERT INTO app.cms_synthetic_binding_version(tenant_id,id,site_id,binding_generation,domain_id,
      domain_row_version,hostname,origin,evidence_code,created_at,expires_at)
    VALUES(domain_source.tenant_id,next_binding,domain_source.site_id,next_value,selected_domain,
      selected_version,p_hostname,'https://' || p_hostname,'synthetic-fixture-v1',checked_clock,proof_expires);
    IF old_head.binding_id IS NULL THEN
      INSERT INTO app.cms_synthetic_host_current(hostname,tenant_id,site_id,binding_id,binding_generation,enabled)
        VALUES(p_hostname,domain_source.tenant_id,domain_source.site_id,next_binding,next_value,true);
    ELSE
      UPDATE app.cms_synthetic_host_current SET tenant_id=domain_source.tenant_id,site_id=domain_source.site_id,
        binding_id=next_binding,binding_generation=next_value,enabled=true WHERE hostname=p_hostname;
    END IF;
  ELSE
    DELETE FROM app.cms_synthetic_host_current WHERE hostname=p_hostname;
  END IF;
  IF app.cms_synthetic_namespace_source_allowed(p_hostname,p_action,selected_domain,selected_version) IS DISTINCT FROM true
    OR (p_action='bind' AND proof_expires<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Current synthetic source unavailable' USING ERRCODE='42501';
  END IF;
  DELETE FROM app.cms_synthetic_namespace_permit
    WHERE backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND nonce=selector
      AND minter_role=current_user AND consumed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Synthetic namespace permit cleanup unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('app.cms_namespace_nonce','',true);
  RETURN QUERY SELECT next_value,next_binding,p_action='bind';
  -- Errors abort the statement: no counter-only/head-only success or TTL reset.
END;
$namespace_command$;
REVOKE ALL ON FUNCTION app.cms_synthetic_namespace_command(text,text,bigint,uuid,bigint,integer) FROM PUBLIC;

CREATE FUNCTION app.guard_cms_publication_counter_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,app,pg_temp AS $counter$
DECLARE receipt app.cms_synthetic_namespace_permit;
BEGIN
  IF TG_TABLE_NAME='cms_synthetic_host_sequence' THEN
    receipt:=app.cms_current_namespace_permit(OLD.hostname);
    IF NEW.hostname IS DISTINCT FROM OLD.hostname
      OR NEW.last_generation IS DISTINCT FROM OLD.last_generation+1
      OR OLD.last_generation IS DISTINCT FROM receipt.expected_generation
      OR NEW.last_generation IS DISTINCT FROM receipt.next_generation THEN
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
    'cms_synthetic_namespace_permit','cms_render_policy_version','cms_site_publication_state','cms_publication_command',
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
