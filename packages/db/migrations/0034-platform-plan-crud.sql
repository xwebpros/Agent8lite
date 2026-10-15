-- Migration 0034: Grant INSERT/UPDATE on app.plan to estate_control for platform plan management.
-- app.plan has no RLS (no tenant_id); authorization is enforced in application code via control_authorized().

GRANT INSERT ON app.plan TO estate_control;
GRANT UPDATE(code, name, price_minor, currency, billing_interval, provider_price_id, features, limits, active, row_version, updated_at) ON app.plan TO estate_control;
