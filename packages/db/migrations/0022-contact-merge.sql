BEGIN;
-- ADR-049 Contact merge: merged_into pointer, channel combine pointer, and merge result table.
-- All tables and columns: FORCE RLS; runtime role receives SELECT, INSERT only.

ALTER TABLE app.contact
  ADD COLUMN merged_into_contact_id uuid,
  ADD CONSTRAINT contact_merged_into_fk
    FOREIGN KEY (tenant_id, merged_into_contact_id) REFERENCES app.contact(tenant_id, id);
GRANT UPDATE(merged_into_contact_id) ON app.contact TO estate_runtime;

ALTER TABLE app.contact_channel
  ADD COLUMN combined_into_channel_id uuid,
  ADD CONSTRAINT contact_channel_combined_into_fk
    FOREIGN KEY (tenant_id, combined_into_channel_id) REFERENCES app.contact_channel(tenant_id, id);
GRANT UPDATE(combined_into_channel_id) ON app.contact_channel TO estate_runtime;

CREATE TABLE app.contact_merge (
  tenant_id             uuid        NOT NULL REFERENCES app.organization(id),
  id                    uuid        NOT NULL,
  actor_member_id       uuid        NOT NULL,
  survivor_contact_id   uuid        NOT NULL,
  merged_contact_id     uuid        NOT NULL,
  survivor_version      integer     NOT NULL CHECK (survivor_version >= 1),
  merged_version        integer     NOT NULL CHECK (merged_version >= 1),
  channels_moved        integer     NOT NULL DEFAULT 0,
  channels_combined     integer     NOT NULL DEFAULT 0,
  leads_moved           integer     NOT NULL DEFAULT 0,
  consent_outcomes      jsonb       NOT NULL DEFAULT '[]',
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT contact_merge_pk PRIMARY KEY (tenant_id, id),
  CONSTRAINT contact_merge_survivor_fk
    FOREIGN KEY (tenant_id, survivor_contact_id) REFERENCES app.contact(tenant_id, id),
  CONSTRAINT contact_merge_merged_fk
    FOREIGN KEY (tenant_id, merged_contact_id) REFERENCES app.contact(tenant_id, id)
);
ALTER TABLE app.contact_merge FORCE ROW LEVEL SECURITY;
ALTER TABLE app.contact_merge ENABLE ROW LEVEL SECURITY;

CREATE POLICY contact_merge_runtime ON app.contact_merge
  FOR ALL TO estate_runtime
  USING (tenant_id = app.current_tenant())
  WITH CHECK (tenant_id = app.current_tenant());

REVOKE ALL ON app.contact_merge FROM PUBLIC;
GRANT SELECT, INSERT ON app.contact_merge TO estate_runtime;

CREATE INDEX idx_contact_merge_tenant_created ON app.contact_merge(tenant_id, created_at, id);
CREATE INDEX idx_contact_merge_survivor ON app.contact_merge(tenant_id, survivor_contact_id);
CREATE INDEX idx_contact_merge_merged ON app.contact_merge(tenant_id, merged_contact_id);
COMMIT;
