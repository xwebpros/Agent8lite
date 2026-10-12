-- Runtime grants for push subscription management (MOD-K Web Push).
-- Member-scoped: a member manages only their own devices.
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.push_subscription TO estate_runtime;

COMMIT;
