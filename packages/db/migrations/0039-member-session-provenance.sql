-- ADR-062: preserve old sessions without inferring production identity provenance.
BEGIN;
ALTER TABLE app.login_session
  ADD COLUMN identity_provenance text NOT NULL DEFAULT 'legacy-unknown',
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_client_id text,
  ADD COLUMN oidc_subject text,
  ADD CONSTRAINT member_session_provenance_valid CHECK (
    identity_provenance IN ('legacy-unknown','synthetic-local','oidc')
    AND CASE WHEN identity_provenance='oidc' THEN
      oidc_issuer IS NOT NULL AND length(oidc_issuer) BETWEEN 1 AND 2048
      AND oidc_client_id IS NOT NULL AND length(oidc_client_id) BETWEEN 1 AND 512
      AND oidc_subject IS NOT NULL AND length(oidc_subject) BETWEEN 1 AND 512
    ELSE oidc_issuer IS NULL AND oidc_client_id IS NULL AND oidc_subject IS NULL END
  );

CREATE FUNCTION app.preserve_member_session_origin() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF ROW(NEW.token_hash,NEW.user_id,NEW.identity_provenance,NEW.oidc_issuer,
         NEW.oidc_client_id,NEW.oidc_subject,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.token_hash,OLD.user_id,OLD.identity_provenance,OLD.oidc_issuer,
         OLD.oidc_client_id,OLD.oidc_subject,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'Member session origin and expiry are immutable' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.preserve_member_session_origin() FROM PUBLIC;
CREATE TRIGGER member_session_origin_immutable BEFORE UPDATE ON app.login_session
  FOR EACH ROW EXECUTE FUNCTION app.preserve_member_session_origin();
REVOKE UPDATE ON app.login_session FROM estate_runtime;
GRANT UPDATE(active_org_id) ON app.login_session TO estate_runtime;
COMMIT;
