-- ADR-061: reviewed forward migration from guarded W11 IDX template proposal.
-- Coordinator and independent review accepted the tenant binding/lock model.
-- Preserves every existing row and introduces no seed,
-- secret, default public authorization, outbound request or production activation.
BEGIN;

CREATE TABLE app.idx_template_binding (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 8 AND 256),
  domain_id uuid,
  document_id uuid NOT NULL,
  form_id uuid NOT NULL,
  source_id uuid NOT NULL,
  capture_member_id uuid NOT NULL,
  business_profile_id uuid NOT NULL,
  agent_member_id uuid,
  brokerage_office_id uuid,
  feed_id uuid NOT NULL,
  template_code text NOT NULL CHECK (template_code IN ('las-vegas-idx-agent','las-vegas-idx-brokerage')),
  template_version text NOT NULL CHECK (char_length(template_version) BETWEEN 1 AND 40),
  mode text NOT NULL CHECK (mode IN ('mock','live')),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  policy_sha256 text NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  policy_expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','active','revoked')),
  expires_at timestamptz NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,site_id),
  FOREIGN KEY (tenant_id) REFERENCES app.organization(id),
  FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id),
  FOREIGN KEY (tenant_id,domain_id) REFERENCES app.site_domain(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES app.content_document(tenant_id,id),
  FOREIGN KEY (tenant_id,form_id) REFERENCES app.form_schema(tenant_id,id),
  FOREIGN KEY (tenant_id,source_id) REFERENCES app.lead_source(tenant_id,id),
  FOREIGN KEY (tenant_id,capture_member_id) REFERENCES app.membership(tenant_id,id),
  FOREIGN KEY (tenant_id,business_profile_id) REFERENCES app.business_profile(tenant_id,id),
  FOREIGN KEY (tenant_id,agent_member_id) REFERENCES app.membership(tenant_id,id),
  FOREIGN KEY (tenant_id,brokerage_office_id) REFERENCES app.office(tenant_id,id),
  FOREIGN KEY (tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id),
  CHECK (template_code <> 'las-vegas-idx-agent' OR agent_member_id IS NOT NULL),
  CHECK (mode <> 'live' OR domain_id IS NOT NULL),
  CHECK (origin=lower(origin)),
  CHECK (
    (mode='mock' AND domain_id IS NULL AND origin ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$')
    OR (domain_id IS NOT NULL AND origin ~ '^https://[a-z0-9][a-z0-9.-]*$')
  )
);

-- Path-scoped synthetic galleries may host several explicitly bound sites on
-- one loopback origin. Active verified-domain origins identify exactly one site.
CREATE UNIQUE INDEX idx_template_active_verified_origin ON app.idx_template_binding(origin)
  WHERE domain_id IS NOT NULL AND state='active';
-- A public UUID/origin pair must never bootstrap two tenant identities, even
-- when different tenants have deliberately chosen identical UUID values.
CREATE UNIQUE INDEX idx_template_active_site_origin ON app.idx_template_binding(site_id,origin)
  WHERE state='active';

-- Trusted listing-key mappings are provisioning data, never a public-body claim
-- or a match of MLS display names/email addresses to platform identities.
CREATE TABLE app.idx_template_listing_assignment (
  tenant_id uuid NOT NULL,
  binding_id uuid NOT NULL,
  feed_id uuid NOT NULL,
  source_listing_key text NOT NULL CHECK (char_length(source_listing_key) BETWEEN 1 AND 200),
  member_id uuid NOT NULL,
  office_id uuid,
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 80),
  state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','active','revoked')),
  expires_at timestamptz NOT NULL,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,binding_id,source_listing_key),
  FOREIGN KEY (tenant_id,binding_id) REFERENCES app.idx_template_binding(tenant_id,id),
  FOREIGN KEY (tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id),
  FOREIGN KEY (tenant_id,member_id) REFERENCES app.membership(tenant_id,id),
  FOREIGN KEY (tenant_id,office_id) REFERENCES app.office(tenant_id,id)
);

ALTER TABLE app.idx_template_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idx_template_binding FORCE ROW LEVEL SECURITY;
CREATE POLICY idx_template_binding_tenant ON app.idx_template_binding
  USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());
ALTER TABLE app.idx_template_listing_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idx_template_listing_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY idx_template_assignment_tenant ON app.idx_template_listing_assignment
  USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

-- Runtime can read and acquire row locks, but cannot provision/activate bindings.
GRANT SELECT ON app.idx_template_binding,app.idx_template_listing_assignment TO estate_runtime;
GRANT UPDATE(row_version) ON app.idx_template_binding,app.idx_template_listing_assignment TO estate_runtime;
CREATE POLICY idx_template_binding_lock ON app.idx_template_binding
  AS RESTRICTIVE FOR UPDATE TO estate_runtime USING (tenant_id=app.current_tenant()) WITH CHECK (false);
CREATE POLICY idx_template_assignment_lock ON app.idx_template_listing_assignment
  AS RESTRICTIVE FOR UPDATE TO estate_runtime USING (tenant_id=app.current_tenant()) WITH CHECK (false);

-- Bootstrap returns only server authority references, never public content or
-- credentials. The service subsequently uses withTenantTransaction and retains
-- SHARE locks/current-clock checks on every referenced source before effects.
-- An explicitly provisioned non-login identity replaces human Owner selection.
CREATE FUNCTION app.resolve_idx_template_binding(p_site_id uuid,p_origin text)
RETURNS TABLE (binding_id uuid,tenant_id uuid,capture_user_id uuid,binding_version bigint)
LANGUAGE sql SECURITY DEFINER
SET search_path=pg_catalog,app
AS $$
  SELECT b.id,b.tenant_id,m.user_id,b.row_version
  FROM app.idx_template_binding b
  JOIN app.site s ON (s.tenant_id,s.id)=(b.tenant_id,b.site_id)
  JOIN app.organization o ON o.id=b.tenant_id
  JOIN app.membership m ON (m.tenant_id,m.id)=(b.tenant_id,b.capture_member_id)
  JOIN app.user_identity u ON u.id=m.user_id
  JOIN app.content_document d ON (d.tenant_id,d.id)=(b.tenant_id,b.document_id)
  JOIN app.form_schema f ON (f.tenant_id,f.id)=(b.tenant_id,b.form_id)
  JOIN app.business_profile profile ON (profile.tenant_id,profile.id)=(b.tenant_id,b.business_profile_id)
  LEFT JOIN app.site_domain domain ON (domain.tenant_id,domain.id)=(b.tenant_id,b.domain_id)
  WHERE b.site_id=p_site_id AND b.origin=p_origin
    AND b.state='active' AND b.expires_at>clock_timestamp()
    AND s.state='published' AND s.theme_version=b.template_code || '@' || b.template_version
    AND s.business_profile_id=b.business_profile_id AND o.status='active'
    AND m.status='active' AND u.issuer='urn:estate:idx-template-capture'
    AND u.subject=b.site_id::text
    AND d.site_id=b.site_id AND d.archived_at IS NULL AND d.published_revision_id IS NOT NULL
    AND f.site_id=b.site_id AND f.state='published'
    AND (
      (b.mode='mock' AND b.domain_id IS NULL AND p_origin ~ '^http://(localhost|127[.]0[.]0[.]1)(:[0-9]{1,5})?$')
      OR (b.domain_id IS NOT NULL AND domain.site_id=b.site_id
        AND domain.archived_at IS NULL AND domain.verification_state='verified'
        AND domain.tls_state='active' AND p_origin='https://' || domain.hostname)
    )
$$;
REVOKE ALL ON FUNCTION app.resolve_idx_template_binding(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_idx_template_binding(uuid,text) TO estate_runtime;

COMMENT ON TABLE app.idx_template_binding IS 'Server-provisioned IDX template authorization; runtime cannot activate or replace it.';
COMMENT ON TABLE app.idx_template_listing_assignment IS 'Explicit feed/site listing attribution; display names never establish membership.';
COMMENT ON FUNCTION app.resolve_idx_template_binding(uuid,text) IS 'Static published-site bootstrap only; trusted edge origin/current source reauthorization required. Listing/status/inquiry additionally require current feed/mode/policy/rights and expiry; outages yield unavailable data, not hidden static content.';


COMMIT;
