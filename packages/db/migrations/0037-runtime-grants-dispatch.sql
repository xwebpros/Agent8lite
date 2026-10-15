-- Grant runtime role access to dispatch and retention tables
GRANT SELECT, INSERT, UPDATE ON app.scheduled_action TO estate_runtime;
GRANT SELECT, INSERT ON app.delivery_attempt TO estate_runtime;
GRANT DELETE ON app.idempotency_record TO estate_runtime;
GRANT SELECT, DELETE ON app.outbox_consumer_receipt TO estate_runtime;
