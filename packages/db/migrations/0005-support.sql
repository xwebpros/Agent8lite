BEGIN;
GRANT SELECT,INSERT ON app.ticket TO estate_runtime;
GRANT SELECT,INSERT ON app.ticket_event TO estate_runtime;
COMMIT;
