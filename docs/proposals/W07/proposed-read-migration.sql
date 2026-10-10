-- PROPOSAL ONLY: coordinator assigns the next available number after MOD-A 0012.
-- No permissive rights/time backfill, no feed writes, no worker/public grants.
BEGIN;
ALTER TABLE app.mls_feed ADD COLUMN native_rights jsonb;
ALTER TABLE app.listing ADD COLUMN ingested_at timestamptz;
COMMENT ON COLUMN app.mls_feed.native_rights IS
  'Current server-only MlsPolicy rights; null or malformed denies all native display.';
COMMENT ON COLUMN app.listing.ingested_at IS
  'Actual adapter ingestion time; null denies native display and cannot use row update time as refresh.';
GRANT SELECT ON app.mls_feed, app.listing TO estate_runtime;
-- Minimal metadata privilege allows current-rights/withdrawal SHARE locks, never business writes.
GRANT UPDATE (row_version) ON app.mls_feed, app.listing, app.integration_connection TO estate_runtime;
COMMIT;
