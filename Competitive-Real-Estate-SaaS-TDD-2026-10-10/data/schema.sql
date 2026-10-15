-- DESIGN BASELINE ONLY. Not applied to a database.
-- M1 must validate migrations with PostgreSQL/PostGIS and runtime roles.
-- Organization IDs derive from verified membership; never trust a browser-supplied tenant.
BEGIN;
CREATE SCHEMA IF NOT EXISTS app;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE FUNCTION app.current_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id',true),'')::uuid $$;
CREATE FUNCTION app.current_actor() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.actor_id',true),'')::uuid $$;

CREATE TABLE app.organization (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('provisioning','active','suspended','archived')),
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  locale text NOT NULL DEFAULT 'en-US',
  PRIMARY KEY (id)
);

CREATE TABLE app.user_identity (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY (id),
  UNIQUE (issuer,subject)
);

CREATE TABLE app.plan (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  code text NOT NULL,
  name text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  provider_price_id text,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (code,billing_interval)
);

CREATE TABLE app.staff_principal (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  user_id uuid NOT NULL,
  permission_codes text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (id),
  UNIQUE (user_id)
);

CREATE TABLE app.role_definition (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  permission_grants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(permission_grants)='array'),
  builtin boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,name)
);

CREATE TABLE app.membership (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  user_id uuid NOT NULL,
  role_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('invited','active','disabled')),
  display_name text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,user_id)
);

CREATE TABLE app.member_invitation (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  email text NOT NULL,
  token_hash text NOT NULL,
  role_id uuid NOT NULL,
  invited_by_member_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,token_hash)
);

CREATE TABLE app.office (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,name)
);

CREATE TABLE app.office_member (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  office_id uuid NOT NULL,
  member_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,office_id,member_id)
);

CREATE TABLE app.business_profile (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  brand_tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.subscription (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  plan_id uuid NOT NULL,
  provider_subscription_id text,
  provider_customer_id text,
  status text NOT NULL,
  period_end timestamptz,
  reconciled_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,provider_subscription_id)
);

CREATE TABLE app.entitlement (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  feature text NOT NULL,
  state text NOT NULL CHECK (state IN ('enabled','pending','disabled')),
  limit_value bigint,
  effective_until timestamptz,
  subscription_id uuid,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,feature)
);

CREATE TABLE app.billing_change (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  subscription_id uuid NOT NULL,
  state text NOT NULL,
  preview jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key)
);

CREATE TABLE app.invoice_reference (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  subscription_id uuid NOT NULL,
  provider_invoice_id text NOT NULL,
  total_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,provider_invoice_id)
);

CREATE TABLE app.integration_connection (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  provider text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('mock','sandbox','live')),
  state text NOT NULL,
  secret_ref text,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_success_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.contact (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  display_name text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}'::jsonb,
  birthday date,
  archived_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.contact_channel (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  contact_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('email','phone')),
  normalized_value text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,contact_id,kind,normalized_value)
);

CREATE TABLE app.lead_source (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  code text NOT NULL,
  label text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,code)
);

CREATE TABLE app.pipeline_stage (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  position integer NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,name),
  UNIQUE (tenant_id,position)
);

CREATE TABLE app.lead (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  contact_id uuid NOT NULL,
  source_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  owner_member_id uuid,
  office_id uuid,
  intent text NOT NULL DEFAULT 'unknown' CHECK (intent IN ('buyer','seller','both','unknown')),
  timeline text,
  score numeric(5,2),
  score_version text,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.stage_transition (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  from_stage_id uuid,
  to_stage_id uuid NOT NULL,
  actor_member_id uuid NOT NULL,
  reason text,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.deal (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  name text NOT NULL,
  amount numeric(14,2) CHECK (amount >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  expected_close_date date,
  state text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.task (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid,
  assignee_member_id uuid NOT NULL,
  title text NOT NULL,
  description text,
  due_at timestamptz NOT NULL,
  due_timezone text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low','normal','high')),
  state text NOT NULL CHECK (state IN ('open','done','cancelled')),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.note (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  author_member_id uuid NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.tag (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,name)
);

CREATE TABLE app.lead_tag (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,lead_id,tag_id)
);

CREATE TABLE app.routing_rule (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  priority integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  condition jsonb NOT NULL,
  assignment jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,priority)
);

CREATE TABLE app.activity_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid,
  event_type text NOT NULL,
  source_event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  safe_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,source_event_id)
);

CREATE TABLE app.consent_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  contact_channel_id uuid NOT NULL,
  purpose text NOT NULL,
  action text NOT NULL CHECK (action IN ('grant','withdraw')),
  policy_version text NOT NULL,
  evidence_ref text NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.suppression (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  channel_kind text NOT NULL,
  normalized_destination text NOT NULL,
  purpose text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,channel_kind,normalized_destination,purpose)
);

CREATE TABLE app.import_job (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  member_id uuid NOT NULL,
  object_key text NOT NULL,
  state text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.site (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  business_profile_id uuid NOT NULL,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','publishing','published','suspended')),
  theme_version text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.site_domain (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  site_id uuid NOT NULL,
  hostname text NOT NULL,
  verification_state text NOT NULL,
  tls_state text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('preview','production')),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,hostname)
);

CREATE TABLE app.content_document (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  site_id uuid NOT NULL,
  slug text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('page','landing','blog','community','agent','testimonial')),
  title text NOT NULL,
  published_revision_id uuid,
  archived_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,site_id,slug)
);

CREATE TABLE app.content_revision (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  document_id uuid NOT NULL,
  author_member_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  block_data jsonb NOT NULL,
  seo jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.media_asset (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  site_id uuid,
  object_key text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  scan_state text NOT NULL,
  alt_text text,
  rights jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,object_key)
);

CREATE TABLE app.form_schema (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  site_id uuid NOT NULL,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,site_id,name,version)
);

CREATE TABLE app.form_entry (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  form_schema_id uuid NOT NULL,
  lead_id uuid,
  submission_key text NOT NULL,
  private_payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,submission_key)
);

CREATE TABLE app.visitor_identity (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  site_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  auth_subject text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,site_id,auth_subject)
);

CREATE TABLE app.mls_feed (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  connection_id uuid NOT NULL,
  market_code text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('mock','sandbox','live')),
  transport text NOT NULL CHECK (transport IN ('mock','reso','custom','proxy','embed')),
  state text NOT NULL,
  display_policy jsonb NOT NULL,
  policy_approved_at timestamptz,
  last_complete_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.listing (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  feed_id uuid NOT NULL,
  source_listing_key text NOT NULL,
  source_listing_id text,
  source_status text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','pending','closed','off_market','unknown')),
  list_price numeric(14,2) CHECK (list_price >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  address jsonb,
  location geography(Point,4326),
  bedrooms integer CHECK (bedrooms >= 0),
  bathrooms numeric(4,1) CHECK (bathrooms >= 0),
  living_area_sqft numeric(12,2) CHECK (living_area_sqft > 0),
  property_type text,
  public_remarks text,
  brokerage_attribution jsonb NOT NULL,
  display_allowed boolean NOT NULL DEFAULT false,
  address_display_allowed boolean NOT NULL DEFAULT false,
  synthetic boolean NOT NULL DEFAULT false,
  source_modified_at timestamptz,
  content_hash text NOT NULL,
  withdrawn_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,feed_id,source_listing_key)
);

CREATE TABLE app.listing_media (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  listing_id uuid NOT NULL,
  source_media_key text NOT NULL,
  source_url text NOT NULL,
  position integer NOT NULL,
  expires_at timestamptz NOT NULL,
  cache_allowed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,listing_id,source_media_key)
);

CREATE TABLE app.mls_sync_run (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  feed_id uuid NOT NULL,
  state text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  cursor_before jsonb,
  cursor_after jsonb,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  safe_error text,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.mls_checkpoint (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  feed_id uuid NOT NULL,
  resource text NOT NULL,
  cursor jsonb NOT NULL,
  metadata_hash text,
  watermark_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,feed_id,resource)
);

CREATE TABLE app.saved_search (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  visitor_id uuid NOT NULL,
  name text NOT NULL,
  filter_version integer NOT NULL DEFAULT 1,
  criteria jsonb NOT NULL,
  alert_frequency text NOT NULL CHECK (alert_frequency IN ('off','instant','daily','weekly')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.favorite (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  visitor_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,visitor_id,listing_id)
);

CREATE TABLE app.listing_alert_match (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  saved_search_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  listing_change_key text NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,saved_search_id,listing_id,listing_change_key)
);

CREATE TABLE app.campaign (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  category text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','active','paused','archived')),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.campaign_version (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  campaign_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','published')),
  published_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,campaign_id,version)
);

CREATE TABLE app.message_design (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','sms')),
  version integer NOT NULL CHECK (version > 0),
  editor_kind text NOT NULL,
  design jsonb NOT NULL,
  rendered_content text NOT NULL,
  content_hash text NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.campaign_step (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  version_id uuid NOT NULL,
  node_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wait','email','sms','condition','task')),
  message_design_id uuid,
  delay_seconds integer NOT NULL DEFAULT 0 CHECK (delay_seconds BETWEEN 0 AND 31536000),
  config jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,version_id,node_key)
);

CREATE TABLE app.automation_rule (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  name text NOT NULL,
  trigger_type text NOT NULL,
  campaign_version_id uuid NOT NULL,
  condition jsonb NOT NULL,
  restart_policy text NOT NULL CHECK (restart_policy IN ('once','after_completion','after_inactivity')),
  inactivity_seconds integer,
  active boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.enrollment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  campaign_version_id uuid NOT NULL,
  source_event_id text NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  state text NOT NULL CHECK (state IN ('active','paused','completed','cancelled')),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,lead_id,campaign_version_id,source_event_id)
);

CREATE TABLE app.scheduled_action (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  enrollment_id uuid,
  lead_id uuid NOT NULL,
  message_design_id uuid,
  campaign_step_id uuid,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  kind text NOT NULL CHECK (kind IN ('email','sms','task')),
  message_snapshot jsonb,
  due_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','claimed','submitted','unknown','done','failed','cancelled')),
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  CHECK (kind='task' OR message_snapshot IS NOT NULL)
);

CREATE TABLE app.delivery_attempt (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  scheduled_action_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_message_id text,
  request_key text NOT NULL,
  state text NOT NULL,
  safe_error text,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_key)
);

CREATE TABLE app.appointment (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  lead_id uuid NOT NULL,
  connection_id uuid,
  provider_event_id text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  state text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,provider_event_id),
  CHECK (ends_at > starts_at)
);

CREATE TABLE app.notification (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  member_id uuid NOT NULL,
  kind text NOT NULL,
  safe_payload jsonb NOT NULL,
  read_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.metric_definition (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  key text NOT NULL,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,key,version)
);

CREATE TABLE app.metric_snapshot (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  definition_id uuid NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  dimensions jsonb NOT NULL,
  values jsonb NOT NULL,
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  CHECK (period_end > period_start)
);

CREATE TABLE app.ai_job (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  requester_member_id uuid NOT NULL,
  purpose text NOT NULL,
  state text NOT NULL,
  context_refs jsonb NOT NULL,
  model_config_version text NOT NULL,
  prompt_version text NOT NULL,
  output jsonb,
  usage jsonb,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.business_entity (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  business_profile_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_entity_id text NOT NULL,
  profile jsonb NOT NULL,
  last_sync_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,connection_id,provider_entity_id)
);

CREATE TABLE app.publisher_listing (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  business_entity_id uuid NOT NULL,
  publisher_key text NOT NULL,
  state text NOT NULL,
  last_verified_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_entity_id,publisher_key)
);

CREATE TABLE app.review_reference (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  business_entity_id uuid NOT NULL,
  provider_review_id text NOT NULL,
  rating numeric(2,1),
  body_ref text,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,business_entity_id,provider_review_id)
);

CREATE TABLE app.ticket (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  requester_member_id uuid NOT NULL,
  subject text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','waiting','resolved','closed')),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.ticket_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  ticket_id uuid NOT NULL,
  actor_ref text NOT NULL,
  kind text NOT NULL,
  body text,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.support_access_grant (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  staff_user_id uuid NOT NULL,
  permission_codes text[] NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.audit_event (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  actor_ref text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  trace_id text NOT NULL,
  safe_diff jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.webhook_inbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  connection_id uuid NOT NULL,
  provider_event_id text NOT NULL,
  payload_ref text NOT NULL,
  signature_verified boolean NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,connection_id,provider_event_id)
);

CREATE TABLE app.outbox (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  published_at timestamptz,
  lease_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.idempotency_record (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  actor_ref text NOT NULL,
  route_key text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_ref text,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,actor_ref,route_key,key)
);

CREATE TABLE app.integration_job (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  connection_id uuid,
  kind text NOT NULL,
  state text NOT NULL,
  result_ref text,
  safe_error text,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE app.push_subscription (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  member_id uuid NOT NULL,
  endpoint_hash text NOT NULL,
  encrypted_subscription text NOT NULL,
  device_label text NOT NULL,
  topics jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text NOT NULL CHECK (state IN ('active','revoked','expired')),
  last_success_at timestamptz,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,member_id,endpoint_hash)
);

ALTER TABLE app.staff_principal ADD FOREIGN KEY (user_id) REFERENCES app.user_identity(id) ON DELETE RESTRICT;

CREATE INDEX idx_staff_principal_user_id ON app.staff_principal (user_id);

ALTER TABLE app.role_definition ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.membership ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.membership ADD FOREIGN KEY (user_id) REFERENCES app.user_identity(id) ON DELETE RESTRICT;

CREATE INDEX idx_membership_user_id ON app.membership (user_id);

ALTER TABLE app.membership ADD FOREIGN KEY (tenant_id,role_id) REFERENCES app.role_definition(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_membership_role_id ON app.membership (tenant_id,role_id);

ALTER TABLE app.member_invitation ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.member_invitation ADD FOREIGN KEY (tenant_id,role_id) REFERENCES app.role_definition(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_member_invitation_role_id ON app.member_invitation (tenant_id,role_id);

ALTER TABLE app.member_invitation ADD FOREIGN KEY (tenant_id,invited_by_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_member_invitation_invited_by_member_id ON app.member_invitation (tenant_id,invited_by_member_id);

ALTER TABLE app.office ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.office_member ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.office_member ADD FOREIGN KEY (tenant_id,office_id) REFERENCES app.office(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_office_member_office_id ON app.office_member (tenant_id,office_id);

ALTER TABLE app.office_member ADD FOREIGN KEY (tenant_id,member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_office_member_member_id ON app.office_member (tenant_id,member_id);

ALTER TABLE app.business_profile ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.subscription ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.subscription ADD FOREIGN KEY (plan_id) REFERENCES app.plan(id) ON DELETE RESTRICT;

CREATE INDEX idx_subscription_plan_id ON app.subscription (plan_id);

ALTER TABLE app.entitlement ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.entitlement ADD FOREIGN KEY (tenant_id,subscription_id) REFERENCES app.subscription(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_entitlement_subscription_id ON app.entitlement (tenant_id,subscription_id);

ALTER TABLE app.billing_change ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.billing_change ADD FOREIGN KEY (tenant_id,subscription_id) REFERENCES app.subscription(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_billing_change_subscription_id ON app.billing_change (tenant_id,subscription_id);

ALTER TABLE app.invoice_reference ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.invoice_reference ADD FOREIGN KEY (tenant_id,subscription_id) REFERENCES app.subscription(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_invoice_reference_subscription_id ON app.invoice_reference (tenant_id,subscription_id);

ALTER TABLE app.integration_connection ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.contact ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.contact_channel ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.contact_channel ADD FOREIGN KEY (tenant_id,contact_id) REFERENCES app.contact(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_contact_channel_contact_id ON app.contact_channel (tenant_id,contact_id);

ALTER TABLE app.lead_source ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.pipeline_stage ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id,contact_id) REFERENCES app.contact(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_contact_id ON app.lead (tenant_id,contact_id);

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id,source_id) REFERENCES app.lead_source(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_source_id ON app.lead (tenant_id,source_id);

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id,stage_id) REFERENCES app.pipeline_stage(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_stage_id ON app.lead (tenant_id,stage_id);

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id,owner_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_owner_member_id ON app.lead (tenant_id,owner_member_id);

ALTER TABLE app.lead ADD FOREIGN KEY (tenant_id,office_id) REFERENCES app.office(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_office_id ON app.lead (tenant_id,office_id);

ALTER TABLE app.stage_transition ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.stage_transition ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_stage_transition_lead_id ON app.stage_transition (tenant_id,lead_id);

ALTER TABLE app.stage_transition ADD FOREIGN KEY (tenant_id,from_stage_id) REFERENCES app.pipeline_stage(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_stage_transition_from_stage_id ON app.stage_transition (tenant_id,from_stage_id);

ALTER TABLE app.stage_transition ADD FOREIGN KEY (tenant_id,to_stage_id) REFERENCES app.pipeline_stage(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_stage_transition_to_stage_id ON app.stage_transition (tenant_id,to_stage_id);

ALTER TABLE app.stage_transition ADD FOREIGN KEY (tenant_id,actor_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_stage_transition_actor_member_id ON app.stage_transition (tenant_id,actor_member_id);

ALTER TABLE app.deal ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.deal ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_deal_lead_id ON app.deal (tenant_id,lead_id);

ALTER TABLE app.task ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.task ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_task_lead_id ON app.task (tenant_id,lead_id);

ALTER TABLE app.task ADD FOREIGN KEY (tenant_id,assignee_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_task_assignee_member_id ON app.task (tenant_id,assignee_member_id);

ALTER TABLE app.note ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.note ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_note_lead_id ON app.note (tenant_id,lead_id);

ALTER TABLE app.note ADD FOREIGN KEY (tenant_id,author_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_note_author_member_id ON app.note (tenant_id,author_member_id);

ALTER TABLE app.tag ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.lead_tag ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.lead_tag ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_tag_lead_id ON app.lead_tag (tenant_id,lead_id);

ALTER TABLE app.lead_tag ADD FOREIGN KEY (tenant_id,tag_id) REFERENCES app.tag(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_lead_tag_tag_id ON app.lead_tag (tenant_id,tag_id);

ALTER TABLE app.routing_rule ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.activity_event ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.activity_event ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_activity_event_lead_id ON app.activity_event (tenant_id,lead_id);

ALTER TABLE app.consent_event ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.consent_event ADD FOREIGN KEY (tenant_id,contact_channel_id) REFERENCES app.contact_channel(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_consent_event_contact_channel_id ON app.consent_event (tenant_id,contact_channel_id);

ALTER TABLE app.suppression ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.import_job ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.import_job ADD FOREIGN KEY (tenant_id,member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_import_job_member_id ON app.import_job (tenant_id,member_id);

ALTER TABLE app.site ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.site ADD FOREIGN KEY (tenant_id,business_profile_id) REFERENCES app.business_profile(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_site_business_profile_id ON app.site (tenant_id,business_profile_id);

ALTER TABLE app.site_domain ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.site_domain ADD FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_site_domain_site_id ON app.site_domain (tenant_id,site_id);

ALTER TABLE app.content_document ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.content_document ADD FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_content_document_site_id ON app.content_document (tenant_id,site_id);

ALTER TABLE app.content_revision ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.content_revision ADD FOREIGN KEY (tenant_id,document_id) REFERENCES app.content_document(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_content_revision_document_id ON app.content_revision (tenant_id,document_id);

ALTER TABLE app.content_revision ADD FOREIGN KEY (tenant_id,author_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_content_revision_author_member_id ON app.content_revision (tenant_id,author_member_id);

ALTER TABLE app.media_asset ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.media_asset ADD FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_media_asset_site_id ON app.media_asset (tenant_id,site_id);

ALTER TABLE app.form_schema ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.form_schema ADD FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_form_schema_site_id ON app.form_schema (tenant_id,site_id);

ALTER TABLE app.form_entry ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.form_entry ADD FOREIGN KEY (tenant_id,form_schema_id) REFERENCES app.form_schema(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_form_entry_form_schema_id ON app.form_entry (tenant_id,form_schema_id);

ALTER TABLE app.form_entry ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_form_entry_lead_id ON app.form_entry (tenant_id,lead_id);

ALTER TABLE app.visitor_identity ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.visitor_identity ADD FOREIGN KEY (tenant_id,site_id) REFERENCES app.site(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_visitor_identity_site_id ON app.visitor_identity (tenant_id,site_id);

ALTER TABLE app.visitor_identity ADD FOREIGN KEY (tenant_id,contact_id) REFERENCES app.contact(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_visitor_identity_contact_id ON app.visitor_identity (tenant_id,contact_id);

ALTER TABLE app.mls_feed ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.mls_feed ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_mls_feed_connection_id ON app.mls_feed (tenant_id,connection_id);

ALTER TABLE app.listing ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.listing ADD FOREIGN KEY (tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_listing_feed_id ON app.listing (tenant_id,feed_id);

ALTER TABLE app.listing_media ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.listing_media ADD FOREIGN KEY (tenant_id,listing_id) REFERENCES app.listing(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_listing_media_listing_id ON app.listing_media (tenant_id,listing_id);

ALTER TABLE app.mls_sync_run ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.mls_sync_run ADD FOREIGN KEY (tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_mls_sync_run_feed_id ON app.mls_sync_run (tenant_id,feed_id);

ALTER TABLE app.mls_checkpoint ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.mls_checkpoint ADD FOREIGN KEY (tenant_id,feed_id) REFERENCES app.mls_feed(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_mls_checkpoint_feed_id ON app.mls_checkpoint (tenant_id,feed_id);

ALTER TABLE app.saved_search ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.saved_search ADD FOREIGN KEY (tenant_id,visitor_id) REFERENCES app.visitor_identity(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_saved_search_visitor_id ON app.saved_search (tenant_id,visitor_id);

ALTER TABLE app.favorite ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.favorite ADD FOREIGN KEY (tenant_id,visitor_id) REFERENCES app.visitor_identity(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_favorite_visitor_id ON app.favorite (tenant_id,visitor_id);

ALTER TABLE app.favorite ADD FOREIGN KEY (tenant_id,listing_id) REFERENCES app.listing(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_favorite_listing_id ON app.favorite (tenant_id,listing_id);

ALTER TABLE app.listing_alert_match ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.listing_alert_match ADD FOREIGN KEY (tenant_id,saved_search_id) REFERENCES app.saved_search(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_listing_alert_match_saved_search_id ON app.listing_alert_match (tenant_id,saved_search_id);

ALTER TABLE app.listing_alert_match ADD FOREIGN KEY (tenant_id,listing_id) REFERENCES app.listing(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_listing_alert_match_listing_id ON app.listing_alert_match (tenant_id,listing_id);

ALTER TABLE app.campaign ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.campaign_version ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.campaign_version ADD FOREIGN KEY (tenant_id,campaign_id) REFERENCES app.campaign(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_campaign_version_campaign_id ON app.campaign_version (tenant_id,campaign_id);

ALTER TABLE app.message_design ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.campaign_step ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.campaign_step ADD FOREIGN KEY (tenant_id,version_id) REFERENCES app.campaign_version(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_campaign_step_version_id ON app.campaign_step (tenant_id,version_id);

ALTER TABLE app.campaign_step ADD FOREIGN KEY (tenant_id,message_design_id) REFERENCES app.message_design(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_campaign_step_message_design_id ON app.campaign_step (tenant_id,message_design_id);

ALTER TABLE app.automation_rule ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.automation_rule ADD FOREIGN KEY (tenant_id,campaign_version_id) REFERENCES app.campaign_version(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_automation_rule_campaign_version_id ON app.automation_rule (tenant_id,campaign_version_id);

ALTER TABLE app.enrollment ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.enrollment ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_enrollment_lead_id ON app.enrollment (tenant_id,lead_id);

ALTER TABLE app.enrollment ADD FOREIGN KEY (tenant_id,campaign_version_id) REFERENCES app.campaign_version(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_enrollment_campaign_version_id ON app.enrollment (tenant_id,campaign_version_id);

ALTER TABLE app.scheduled_action ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.scheduled_action ADD FOREIGN KEY (tenant_id,enrollment_id) REFERENCES app.enrollment(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_scheduled_action_enrollment_id ON app.scheduled_action (tenant_id,enrollment_id);

ALTER TABLE app.scheduled_action ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_scheduled_action_lead_id ON app.scheduled_action (tenant_id,lead_id);

ALTER TABLE app.scheduled_action ADD FOREIGN KEY (tenant_id,message_design_id) REFERENCES app.message_design(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_scheduled_action_message_design_id ON app.scheduled_action (tenant_id,message_design_id);

ALTER TABLE app.scheduled_action ADD FOREIGN KEY (tenant_id,campaign_step_id) REFERENCES app.campaign_step(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_scheduled_action_campaign_step_id ON app.scheduled_action (tenant_id,campaign_step_id);

ALTER TABLE app.delivery_attempt ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.delivery_attempt ADD FOREIGN KEY (tenant_id,scheduled_action_id) REFERENCES app.scheduled_action(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_delivery_attempt_scheduled_action_id ON app.delivery_attempt (tenant_id,scheduled_action_id);

ALTER TABLE app.delivery_attempt ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_delivery_attempt_connection_id ON app.delivery_attempt (tenant_id,connection_id);

ALTER TABLE app.appointment ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.appointment ADD FOREIGN KEY (tenant_id,lead_id) REFERENCES app.lead(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_appointment_lead_id ON app.appointment (tenant_id,lead_id);

ALTER TABLE app.appointment ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_appointment_connection_id ON app.appointment (tenant_id,connection_id);

ALTER TABLE app.notification ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.notification ADD FOREIGN KEY (tenant_id,member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_notification_member_id ON app.notification (tenant_id,member_id);

ALTER TABLE app.metric_definition ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.metric_snapshot ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.metric_snapshot ADD FOREIGN KEY (tenant_id,definition_id) REFERENCES app.metric_definition(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_metric_snapshot_definition_id ON app.metric_snapshot (tenant_id,definition_id);

ALTER TABLE app.ai_job ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.ai_job ADD FOREIGN KEY (tenant_id,requester_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_ai_job_requester_member_id ON app.ai_job (tenant_id,requester_member_id);

ALTER TABLE app.business_entity ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.business_entity ADD FOREIGN KEY (tenant_id,business_profile_id) REFERENCES app.business_profile(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_business_entity_business_profile_id ON app.business_entity (tenant_id,business_profile_id);

ALTER TABLE app.business_entity ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_business_entity_connection_id ON app.business_entity (tenant_id,connection_id);

ALTER TABLE app.publisher_listing ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.publisher_listing ADD FOREIGN KEY (tenant_id,business_entity_id) REFERENCES app.business_entity(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_publisher_listing_business_entity_id ON app.publisher_listing (tenant_id,business_entity_id);

ALTER TABLE app.review_reference ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.review_reference ADD FOREIGN KEY (tenant_id,business_entity_id) REFERENCES app.business_entity(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_review_reference_business_entity_id ON app.review_reference (tenant_id,business_entity_id);

ALTER TABLE app.ticket ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.ticket ADD FOREIGN KEY (tenant_id,requester_member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_ticket_requester_member_id ON app.ticket (tenant_id,requester_member_id);

ALTER TABLE app.ticket_event ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.ticket_event ADD FOREIGN KEY (tenant_id,ticket_id) REFERENCES app.ticket(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_ticket_event_ticket_id ON app.ticket_event (tenant_id,ticket_id);

ALTER TABLE app.support_access_grant ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.support_access_grant ADD FOREIGN KEY (staff_user_id) REFERENCES app.user_identity(id) ON DELETE RESTRICT;

CREATE INDEX idx_support_access_grant_staff_user_id ON app.support_access_grant (staff_user_id);

ALTER TABLE app.audit_event ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.webhook_inbox ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.webhook_inbox ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_webhook_inbox_connection_id ON app.webhook_inbox (tenant_id,connection_id);

ALTER TABLE app.outbox ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.idempotency_record ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.integration_job ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.integration_job ADD FOREIGN KEY (tenant_id,connection_id) REFERENCES app.integration_connection(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_integration_job_connection_id ON app.integration_job (tenant_id,connection_id);

ALTER TABLE app.push_subscription ADD FOREIGN KEY (tenant_id) REFERENCES app.organization(id) ON DELETE RESTRICT;

ALTER TABLE app.push_subscription ADD FOREIGN KEY (tenant_id,member_id) REFERENCES app.membership(tenant_id,id) ON DELETE RESTRICT;

CREATE INDEX idx_push_subscription_member_id ON app.push_subscription (tenant_id,member_id);

-- The revision pointer must reference a revision of the SAME document.
ALTER TABLE app.content_revision ADD UNIQUE (tenant_id,document_id,id);
ALTER TABLE app.content_document ADD FOREIGN KEY (tenant_id,id,published_revision_id) REFERENCES app.content_revision(tenant_id,document_id,id) DEFERRABLE INITIALLY DEFERRED;
-- Hostnames must have one active owner across tenants, not merely tenant-scoped uniqueness.
CREATE UNIQUE INDEX site_domain_hostname_global ON app.site_domain(lower(hostname));
CREATE INDEX lead_cursor ON app.lead(tenant_id,created_at DESC,id DESC);
CREATE INDEX lead_owner_stage ON app.lead(tenant_id,owner_member_id,stage_id) WHERE archived_at IS NULL;
CREATE INDEX contact_channel_lookup ON app.contact_channel(tenant_id,kind,normalized_value);
CREATE INDEX tasks_due ON app.task(tenant_id,assignee_member_id,due_at) WHERE state='open';
CREATE INDEX listing_filter ON app.listing(tenant_id,feed_id,status,list_price,id) WHERE display_allowed AND withdrawn_at IS NULL;
CREATE INDEX listing_geo ON app.listing USING gist(location);
CREATE INDEX listing_terms ON app.listing USING gin(to_tsvector('english',coalesce(public_remarks,'')));
CREATE INDEX activity_cursor ON app.activity_event(tenant_id,lead_id,occurred_at DESC,id DESC);
CREATE INDEX actions_due ON app.scheduled_action(due_at,tenant_id,id) WHERE state='pending';
CREATE INDEX outbox_ready ON app.outbox(created_at,tenant_id,id) WHERE published_at IS NULL;
-- Dispatch indexes do not confer cross-tenant access; the scheduler enumerates
-- approved organizations through the control plane, then processes each tenant context.


ALTER TABLE app.role_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.role_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.role_definition USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_select ON app.membership FOR SELECT USING (tenant_id=app.current_tenant() OR user_id=app.current_actor());
CREATE POLICY membership_write ON app.membership FOR ALL USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.member_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.member_invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.member_invitation USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.office ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.office FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.office USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.office_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.office_member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.office_member USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.business_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.business_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.business_profile USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.subscription USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.entitlement FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.entitlement USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.billing_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.billing_change FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.billing_change USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.invoice_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.invoice_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.invoice_reference USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.integration_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_connection FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.integration_connection USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contact FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.contact USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.contact_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.contact_channel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.contact_channel USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.lead_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lead_source FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.lead_source USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.pipeline_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pipeline_stage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.pipeline_stage USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.lead ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lead FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.lead USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.stage_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.stage_transition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.stage_transition USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.deal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.deal FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.deal USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.task FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.task USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.note ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.note FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.note USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.tag USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.lead_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.lead_tag FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.lead_tag USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.routing_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.routing_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.routing_rule USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.activity_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.activity_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.activity_event USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.consent_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consent_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.consent_event USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.suppression USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.import_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.import_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.import_job USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.site ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.site FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.site USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.site_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.site_domain FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.site_domain USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.content_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.content_document FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.content_document USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.content_revision ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.content_revision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.content_revision USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.media_asset ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.media_asset FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.media_asset USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.form_schema ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_schema FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.form_schema USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.form_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.form_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.form_entry USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.visitor_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.visitor_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.visitor_identity USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.mls_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_feed FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.mls_feed USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.listing USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.listing_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.listing_media USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.mls_sync_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_sync_run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.mls_sync_run USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.mls_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.mls_checkpoint FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.mls_checkpoint USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.saved_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.saved_search FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.saved_search USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.favorite ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.favorite FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.favorite USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.listing_alert_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing_alert_match FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.listing_alert_match USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.campaign USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.campaign_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.campaign_version USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.message_design ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.message_design FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.message_design USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.campaign_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.campaign_step FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.campaign_step USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.automation_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.automation_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.automation_rule USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.enrollment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.enrollment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.enrollment USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.scheduled_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scheduled_action FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.scheduled_action USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.delivery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.delivery_attempt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.delivery_attempt USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.appointment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.appointment USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notification FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.notification USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.metric_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.metric_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.metric_definition USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.metric_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.metric_snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.metric_snapshot USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.ai_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.ai_job USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.business_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.business_entity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.business_entity USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.publisher_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.publisher_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.publisher_listing USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.review_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.review_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.review_reference USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.ticket USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.ticket_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ticket_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.ticket_event USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.support_access_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.support_access_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.support_access_grant USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.audit_event USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.webhook_inbox USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.outbox USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_record FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.idempotency_record USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.integration_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_job FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.integration_job USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscription FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.push_subscription USING (tenant_id=app.current_tenant()) WITH CHECK (tenant_id=app.current_tenant());

ALTER TABLE app.organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.organization FORCE ROW LEVEL SECURITY;
CREATE POLICY org_select ON app.organization FOR SELECT USING (id=app.current_tenant() OR EXISTS (SELECT 1 FROM app.membership m WHERE m.tenant_id=organization.id AND m.user_id=app.current_actor() AND m.status='active'));
CREATE POLICY org_write ON app.organization FOR ALL USING (id=app.current_tenant()) WITH CHECK (id=app.current_tenant());
ALTER TABLE app.user_identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_identity FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_read ON app.user_identity FOR SELECT USING (id=app.current_actor() OR (issuer=current_setting('app.auth_issuer',true) AND subject=current_setting('app.auth_subject',true)) OR EXISTS (SELECT 1 FROM app.membership m WHERE m.user_id=user_identity.id AND m.tenant_id=app.current_tenant()));
CREATE POLICY identity_write ON app.user_identity FOR ALL USING (id=app.current_actor()) WITH CHECK (issuer=current_setting('app.auth_issuer',true) AND subject=current_setting('app.auth_subject',true));
ALTER TABLE app.staff_principal ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.staff_principal FORCE ROW LEVEL SECURITY;
CREATE POLICY own_staff_record ON app.staff_principal FOR SELECT USING (user_id=app.current_actor());
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
COMMIT;
-- Role provisioning is a separate reviewed infrastructure migration: create NOLOGIN
-- app_runtime/app_worker roles with NOSUPERUSER NOBYPASSRLS; grant only required DML.
-- They MUST NOT own tables, create policies, TRUNCATE, or have migration credentials.
-- Append-only consent/activity/audit/history/inbox records require per-table grants:
-- ordinary request roles receive no UPDATE/DELETE on immutable evidence columns.
-- Login identities inherit the relevant role through managed secret/identity configuration.
-- Global plan administration and staff provisioning use a distinct control-plane role.
