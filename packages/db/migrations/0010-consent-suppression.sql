-- Reviewed forward migration: bounded synthetic consent ownership and immutable evidence.
BEGIN;
CREATE TABLE app.consent_evidence (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  contact_channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN('email_marketing','sms_marketing','listing_alert')),
  action text NOT NULL DEFAULT 'grant' CHECK(action='grant'),
  policy_version text NOT NULL CHECK(policy_version='synthetic-communication-v1'),
  provenance text NOT NULL CHECK(provenance='synthetic-local'),
  state_version bigint NOT NULL CHECK(state_version>0),
  channel_version bigint NOT NULL CHECK(channel_version>0),
  contact_version bigint NOT NULL CHECK(contact_version>0),
  initiating_member_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes'),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,contact_channel_id)REFERENCES app.contact_channel(tenant_id,id),
  FOREIGN KEY(tenant_id,initiating_member_id)REFERENCES app.membership(tenant_id,id)
);
ALTER TABLE app.consent_event ADD COLUMN consent_sequence bigint;
ALTER TABLE app.consent_event ADD COLUMN initiating_member_id uuid;
ALTER TABLE app.consent_event ADD COLUMN evidence_id uuid;
WITH ordered AS (
  SELECT tenant_id,id,row_number()OVER(PARTITION BY tenant_id,contact_channel_id,purpose ORDER BY occurred_at,created_at,id) AS sequence
  FROM app.consent_event
)
UPDATE app.consent_event event SET consent_sequence=ordered.sequence FROM ordered
WHERE(event.tenant_id,event.id)=(ordered.tenant_id,ordered.id);
ALTER TABLE app.consent_event ALTER COLUMN consent_sequence SET NOT NULL;
ALTER TABLE app.consent_event ADD CHECK(consent_sequence>0);
ALTER TABLE app.consent_event ADD UNIQUE(tenant_id,contact_channel_id,purpose,consent_sequence);
ALTER TABLE app.consent_event ADD UNIQUE(tenant_id,evidence_id);
ALTER TABLE app.consent_event ADD FOREIGN KEY(tenant_id,initiating_member_id)REFERENCES app.membership(tenant_id,id);
ALTER TABLE app.consent_event ADD FOREIGN KEY(tenant_id,evidence_id)REFERENCES app.consent_evidence(tenant_id,id);
CREATE TABLE app.consent_state (
  tenant_id uuid NOT NULL,
  contact_channel_id uuid NOT NULL,
  purpose text NOT NULL CHECK(purpose IN('email_marketing','sms_marketing','listing_alert')),
  state text NOT NULL DEFAULT 'unknown' CHECK(state IN('unknown','granted','withdrawn')),
  row_version bigint NOT NULL DEFAULT 1 CHECK(row_version>0),
  last_event_id uuid,
  verified_evidence_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,contact_channel_id,purpose),
  FOREIGN KEY(tenant_id,contact_channel_id)REFERENCES app.contact_channel(tenant_id,id),
  FOREIGN KEY(tenant_id,last_event_id)REFERENCES app.consent_event(tenant_id,id),
  FOREIGN KEY(tenant_id,verified_evidence_id)REFERENCES app.consent_evidence(tenant_id,id),
  CHECK(state<>'granted' OR verified_evidence_id IS NOT NULL)
);
-- Unverified legacy grants never override a recorded withdrawal.
INSERT INTO app.consent_state(tenant_id,contact_channel_id,purpose,state,row_version,last_event_id)
SELECT tenant_id,contact_channel_id,purpose,
  CASE WHEN bool_or(action='withdraw')THEN 'withdrawn' ELSE 'unknown' END,
  max(consent_sequence)+1,
  (array_agg(id ORDER BY(action='withdraw')DESC,consent_sequence DESC))[1]
FROM app.consent_event WHERE purpose IN('email_marketing','sms_marketing','listing_alert')
GROUP BY tenant_id,contact_channel_id,purpose;
INSERT INTO app.suppression(tenant_id,channel_kind,normalized_destination,purpose,reason)
SELECT DISTINCT state.tenant_id,channel.kind,channel.normalized_value,state.purpose,'consent_withdrawal'
FROM app.consent_state state JOIN app.contact_channel channel
ON(channel.tenant_id,channel.id)=(state.tenant_id,state.contact_channel_id)WHERE state.state='withdrawn'
ON CONFLICT(tenant_id,channel_kind,normalized_destination,purpose)DO UPDATE
SET expires_at=NULL,row_version=app.suppression.row_version+1,updated_at=now();
ALTER TABLE app.consent_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consent_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.consent_evidence USING(tenant_id=app.current_tenant())WITH CHECK(tenant_id=app.current_tenant());
ALTER TABLE app.consent_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.consent_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.consent_state USING(tenant_id=app.current_tenant())WITH CHECK(tenant_id=app.current_tenant());
GRANT SELECT,INSERT ON app.consent_event,app.consent_evidence,app.consent_state,app.suppression TO estate_runtime;
GRANT UPDATE(state,row_version,last_event_id,verified_evidence_id,updated_at)ON app.consent_state TO estate_runtime;
GRANT UPDATE(reason,expires_at,row_version,updated_at)ON app.suppression TO estate_runtime;
-- No worker privileges, ledger/evidence updates, or deletion rights in this slice.
COMMIT;
