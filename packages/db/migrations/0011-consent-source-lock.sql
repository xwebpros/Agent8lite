-- Permit CRM source readers to hold office scope stable until their transaction commits.
-- PostgreSQL row-share locking requires UPDATE privilege on at least one column.
-- Existing runtime office membership mutations already use INSERT/DELETE.
BEGIN;
GRANT UPDATE(office_id) ON app.office_member TO estate_runtime;
COMMIT;
