/**
 * Consent-owned set-based form of ConsentService.readEligibility for one channel row alias:
 * a granted state proven by its last grant event and verified synthetic evidence (only in
 * explicit synthetic mode), no withdrawal for the same destination, and no blocking suppression.
 * Callers pass SQL placeholders, never values; keep this in step with readEligibility.
 */
export function eligibleDestinationSql(channel: string, purpose: string, synthetic: string): string {
  return `(EXISTS(SELECT 1 FROM app.consent_state s
      JOIN app.consent_event e ON(e.tenant_id,e.id)=(s.tenant_id,s.last_event_id)
      JOIN app.consent_evidence v ON(v.tenant_id,v.id)=(s.tenant_id,s.verified_evidence_id)
      WHERE s.tenant_id=${channel}.tenant_id AND s.contact_channel_id=${channel}.id AND s.purpose=${purpose}
        AND s.state='granted' AND e.evidence_id=v.id AND e.contact_channel_id=${channel}.id
        AND e.purpose=${purpose} AND e.action='grant' AND v.provenance='synthetic-local'
        AND v.policy_version='synthetic-communication-v1' AND ${synthetic})
    AND NOT EXISTS(SELECT 1 FROM app.consent_state ws
      JOIN app.contact_channel wc ON(wc.tenant_id,wc.id)=(ws.tenant_id,ws.contact_channel_id)
      WHERE ws.tenant_id=${channel}.tenant_id AND wc.kind=${channel}.kind
        AND wc.normalized_value=${channel}.normalized_value AND ws.purpose=${purpose} AND ws.state='withdrawn')
    AND NOT EXISTS(SELECT 1 FROM app.suppression sp
      WHERE sp.tenant_id=${channel}.tenant_id AND sp.channel_kind=${channel}.kind
        AND sp.normalized_destination=${channel}.normalized_value AND sp.purpose=${purpose}
        AND (sp.expires_at IS NULL OR sp.expires_at>clock_timestamp())))`;
}
