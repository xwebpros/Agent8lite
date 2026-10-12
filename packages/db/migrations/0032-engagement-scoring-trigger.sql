-- Rescore lead engagement after every activity event insert.
-- Deterministic: sums event weights from the versioned rules table, capped at 100.

CREATE TABLE app.scoring_rule (
  version text NOT NULL,
  event_type text NOT NULL,
  weight smallint NOT NULL CHECK (weight > 0),
  PRIMARY KEY (version, event_type)
);
ALTER TABLE app.scoring_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.scoring_rule FORCE ROW LEVEL SECURITY;
-- Global read-only table; runtime can read, only migration identity can write.
CREATE POLICY read_scoring_rules ON app.scoring_rule FOR SELECT USING (true);

INSERT INTO app.scoring_rule (version, event_type, weight) VALUES
  ('v1', 'lead.captured', 10),
  ('v1', 'lead.assigned', 5),
  ('v1', 'lead.stage_changed', 8),
  ('v1', 'task.created', 3),
  ('v1', 'task.completed', 5),
  ('v1', 'deal.created', 15),
  ('v1', 'deal.stage_changed', 10),
  ('v1', 'form.submitted', 12),
  ('v1', 'listing.viewed', 2),
  ('v1', 'listing.favorited', 6),
  ('v1', 'listing.inquiry', 15),
  ('v1', 'email.opened', 3),
  ('v1', 'email.clicked', 5);

CREATE OR REPLACE FUNCTION app.rescore_lead()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $$
DECLARE
  raw_score numeric;
BEGIN
  IF NEW.lead_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(sr.weight), 0) INTO raw_score
  FROM app.activity_event ae
  JOIN app.scoring_rule sr ON sr.event_type = ae.event_type AND sr.version = 'v1'
  WHERE ae.tenant_id = NEW.tenant_id AND ae.lead_id = NEW.lead_id;
  UPDATE app.lead
  SET score = LEAST(raw_score, 100),
      score_version = 'v1',
      updated_at = now()
  WHERE tenant_id = NEW.tenant_id AND id = NEW.lead_id;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.rescore_lead() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.rescore_lead() TO estate_runtime;

CREATE TRIGGER trg_rescore_lead
  AFTER INSERT ON app.activity_event
  FOR EACH ROW
  EXECUTE FUNCTION app.rescore_lead();

GRANT SELECT ON app.scoring_rule TO estate_runtime;
GRANT SELECT ON app.scoring_rule TO estate_worker;
