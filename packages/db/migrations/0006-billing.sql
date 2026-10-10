BEGIN;
ALTER TABLE app.billing_change ADD COLUMN requesting_member_id uuid;
ALTER TABLE app.billing_change ADD FOREIGN KEY(tenant_id,requesting_member_id) REFERENCES app.membership(tenant_id,id);
ALTER TABLE app.billing_change ADD COLUMN subscription_version bigint, ADD COLUMN entitlement_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE app.billing_change ADD COLUMN request_body jsonb NOT NULL DEFAULT '{}', ADD COLUMN terms_version text NOT NULL DEFAULT 'synthetic-v1';
ALTER TABLE app.billing_change ADD COLUMN job_id uuid;
ALTER TABLE app.billing_change ADD FOREIGN KEY(tenant_id,job_id) REFERENCES app.integration_job(tenant_id,id);
GRANT SELECT ON app.plan,app.subscription,app.billing_change,app.invoice_reference,app.webhook_inbox TO estate_runtime;
GRANT INSERT,UPDATE ON app.billing_change TO estate_runtime;
GRANT UPDATE(plan_id,status,period_end,reconciled_at,updated_at,row_version) ON app.subscription TO estate_runtime;
GRANT UPDATE(state,limit_value,effective_until,updated_at,row_version) ON app.entitlement TO estate_runtime;
GRANT UPDATE(state,safe_error,safe_result,updated_at,row_version) ON app.integration_job TO estate_runtime;
GRANT INSERT ON app.webhook_inbox TO estate_runtime;
-- Inbox evidence stays append-only. Processing status is held by billing_change/job.
CREATE UNIQUE INDEX one_subscription_per_organization ON app.subscription(tenant_id);
COMMIT;
