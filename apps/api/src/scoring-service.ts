import type { PoolClient } from "pg";

const SCORING_VERSION = "v1";

const EVENT_WEIGHTS: Record<string, number> = {
  "lead.captured": 10,
  "lead.assigned": 5,
  "lead.stage_changed": 8,
  "task.created": 3,
  "task.completed": 5,
  "deal.created": 15,
  "deal.stage_changed": 10,
  "form.submitted": 12,
  "listing.viewed": 2,
  "listing.favorited": 6,
  "listing.inquiry": 15,
  "email.opened": 3,
  "email.clicked": 5,
};

const MAX_SCORE = 100;

interface ScoringResult {
  score: number;
  version: string;
  reasons: Array<{ eventType: string; points: number; count: number }>;
}

export function computeScore(
  events: Array<{ event_type: string; occurred_at: string }>,
): ScoringResult {
  const grouped = new Map<string, number>();
  for (const e of events) {
    grouped.set(e.event_type, (grouped.get(e.event_type) ?? 0) + 1);
  }
  let raw = 0;
  const reasons: ScoringResult["reasons"] = [];
  for (const [eventType, count] of grouped) {
    const weight = EVENT_WEIGHTS[eventType] ?? 1;
    const points = weight * count;
    raw += points;
    reasons.push({ eventType, points, count });
  }
  reasons.sort((a, b) => b.points - a.points);
  return { score: Math.min(raw, MAX_SCORE), version: SCORING_VERSION, reasons };
}

export async function rescoreLead(client: PoolClient, tenantId: string, leadId: string): Promise<ScoringResult> {
  const result = await client.query<{ event_type: string; occurred_at: string }>(
    `SELECT event_type, occurred_at FROM app.activity_event
     WHERE tenant_id=$1 AND lead_id=$2 ORDER BY occurred_at`,
    [tenantId, leadId],
  );
  const scoring = computeScore(result.rows);
  await client.query(
    `UPDATE app.lead SET score=$3, score_version=$4, updated_at=now()
     WHERE tenant_id=$1 AND id=$2`,
    [tenantId, leadId, scoring.score, scoring.version],
  );
  return scoring;
}
