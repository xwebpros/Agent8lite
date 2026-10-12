-- ADR-059 campaign lifecycle: publishCampaign + archiveCampaign.
-- Extends the campaign_version immutability trigger to allow the supervised draft→published
-- transition, then provides SECURITY DEFINER functions for publication and archive so the
-- restrictive RLS policies on app.campaign are never widened for estate_runtime directly.
BEGIN;

-- Allow exactly one mutation: state 'draft' → 'published', published_at NULL → non-null,
-- no other content column changes (updated_at may change). All other updates are still blocked.
CREATE OR REPLACE FUNCTION app.reject_campaign_version_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'draft' AND NEW.state = 'published'
    AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
    AND OLD.id = NEW.id AND OLD.tenant_id = NEW.tenant_id
    AND OLD.campaign_id = NEW.campaign_id AND OLD.version = NEW.version
    AND OLD.definition = NEW.definition AND OLD.row_version = NEW.row_version
    AND OLD.created_at = NEW.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Campaign versions are immutable' USING ERRCODE='55000';
END;
$$;

-- Atomically publishes a campaign_version and activates its parent campaign.
-- Owned by the migration role (postgres/superuser), so it bypasses RLS and may UPDATE
-- campaign_version via the updated trigger above. Returns the published version row,
-- or an empty result set if the version or parent campaign is not in the expected state
-- (caller interprets empty as a lifecycle conflict / 409).
CREATE FUNCTION app.publish_campaign_version(p_version_id uuid, p_campaign_id uuid)
RETURNS TABLE(id uuid, campaign_id uuid, version int, state text, definition jsonb)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Lock parent campaign for update; confirm it is still a draft.
  PERFORM app.campaign.id FROM app.campaign
  WHERE app.campaign.tenant_id = app.current_tenant()
    AND app.campaign.id = p_campaign_id
    AND app.campaign.state = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN RETURN; END IF;

  -- Confirm the version belongs to this campaign and is still an unpublished draft.
  PERFORM app.campaign_version.id FROM app.campaign_version
  WHERE app.campaign_version.tenant_id = app.current_tenant()
    AND app.campaign_version.id = p_version_id
    AND app.campaign_version.campaign_id = p_campaign_id
    AND app.campaign_version.state = 'draft'
    AND app.campaign_version.published_at IS NULL;

  IF NOT FOUND THEN RETURN; END IF;

  -- Publish the version (trigger now permits this specific transition).
  UPDATE app.campaign_version
  SET state = 'published', published_at = now(), updated_at = now()
  WHERE app.campaign_version.tenant_id = app.current_tenant()
    AND app.campaign_version.id = p_version_id;

  -- Activate the parent campaign.
  UPDATE app.campaign
  SET state = 'active', row_version = row_version + 1, updated_at = now()
  WHERE app.campaign.tenant_id = app.current_tenant()
    AND app.campaign.id = p_campaign_id;

  RETURN QUERY
  SELECT v.id, v.campaign_id, v.version::int, v.state, v.definition
  FROM app.campaign_version v
  WHERE v.tenant_id = app.current_tenant() AND v.id = p_version_id;
END;
$$;

GRANT EXECUTE ON FUNCTION app.publish_campaign_version(uuid, uuid) TO estate_runtime;

-- Archives a campaign (any non-archived state). Returns the updated campaign row,
-- or NULL if the campaign was already archived or does not exist for this tenant.
CREATE FUNCTION app.archive_campaign(p_campaign_id uuid)
RETURNS app.campaign LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  result app.campaign;
BEGIN
  UPDATE app.campaign
  SET state = 'archived', row_version = row_version + 1, updated_at = now()
  WHERE app.campaign.tenant_id = app.current_tenant()
    AND app.campaign.id = p_campaign_id
    AND app.campaign.state != 'archived'
  RETURNING * INTO result;
  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION app.archive_campaign(uuid) TO estate_runtime;

COMMIT;
