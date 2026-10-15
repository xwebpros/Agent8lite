BEGIN;

CREATE TABLE IF NOT EXISTS app.instance_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.instance_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.instance_config FORCE ROW LEVEL SECURITY;

GRANT SELECT ON app.instance_config TO estate_runtime;

CREATE POLICY instance_config_runtime_read ON app.instance_config
  FOR SELECT TO estate_runtime USING (true);

COMMIT;
