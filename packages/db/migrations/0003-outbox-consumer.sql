BEGIN;
CREATE TABLE app.outbox_consumer_receipt (
  tenant_id uuid NOT NULL,
  event_id uuid NOT NULL,
  consumer_code text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,event_id,consumer_code),
  FOREIGN KEY(tenant_id,event_id) REFERENCES app.outbox(tenant_id,id) ON DELETE RESTRICT
);
ALTER TABLE app.outbox_consumer_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_consumer_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON app.outbox_consumer_receipt USING(tenant_id=app.current_tenant()) WITH CHECK(tenant_id=app.current_tenant());
GRANT SELECT,INSERT ON app.outbox_consumer_receipt TO estate_worker;
GRANT SELECT(tenant_id,id,owner_member_id,archived_at) ON app.lead TO estate_worker;
COMMIT;
