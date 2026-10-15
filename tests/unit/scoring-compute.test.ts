import { describe, expect, it } from "vitest";
import { computeScore } from "../../apps/api/src/scoring-service";

describe("computeScore pure function", () => {
  it("returns zero for empty events", () => {
    const result = computeScore([]);
    expect(result.score).toBe(0);
    expect(result.version).toBe("v1");
    expect(result.reasons).toEqual([]);
  });

  it("applies known event weights", () => {
    const result = computeScore([
      { event_type: "lead.captured", occurred_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(result.score).toBe(10);
    expect(result.reasons).toEqual([{ eventType: "lead.captured", points: 10, count: 1 }]);
  });

  it("assigns weight 1 to unknown event types", () => {
    const result = computeScore([
      { event_type: "custom.unknown", occurred_at: "2026-01-01T00:00:00Z" },
    ]);
    expect(result.score).toBe(1);
    expect(result.reasons[0].points).toBe(1);
  });

  it("aggregates multiple events of the same type", () => {
    const result = computeScore([
      { event_type: "email.clicked", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "email.clicked", occurred_at: "2026-01-02T00:00:00Z" },
      { event_type: "email.clicked", occurred_at: "2026-01-03T00:00:00Z" },
    ]);
    expect(result.score).toBe(15);
    expect(result.reasons).toEqual([{ eventType: "email.clicked", points: 15, count: 3 }]);
  });

  it("sums across different event types", () => {
    const result = computeScore([
      { event_type: "lead.captured", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-02T00:00:00Z" },
    ]);
    expect(result.score).toBe(25);
    expect(result.reasons).toHaveLength(2);
  });

  it("caps at 100", () => {
    const events = Array.from({ length: 20 }, (_, i) => ({
      event_type: "listing.inquiry",
      occurred_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    const result = computeScore(events);
    expect(result.score).toBe(100);
  });

  it("sorts reasons by points descending", () => {
    const result = computeScore([
      { event_type: "listing.viewed", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-02T00:00:00Z" },
      { event_type: "email.opened", occurred_at: "2026-01-03T00:00:00Z" },
    ]);
    expect(result.reasons[0].eventType).toBe("deal.created");
    expect(result.reasons[1].eventType).toBe("email.opened");
    expect(result.reasons[2].eventType).toBe("listing.viewed");
  });

  it("handles all 13 known event types", () => {
    const types = [
      "lead.captured", "lead.assigned", "lead.stage_changed",
      "task.created", "task.completed", "deal.created", "deal.stage_changed",
      "form.submitted", "listing.viewed", "listing.favorited", "listing.inquiry",
      "email.opened", "email.clicked",
    ];
    const events = types.map((t) => ({ event_type: t, occurred_at: "2026-01-01T00:00:00Z" }));
    const result = computeScore(events);
    expect(result.reasons).toHaveLength(13);
    expect(result.score).toBe(Math.min(10 + 5 + 8 + 3 + 5 + 15 + 10 + 12 + 2 + 6 + 15 + 3 + 5, 100));
  });

  it("boundary: exactly 100 is not exceeded", () => {
    const result = computeScore([
      { event_type: "deal.created", occurred_at: "2026-01-01T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-02T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-03T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-04T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-05T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-06T00:00:00Z" },
      { event_type: "deal.created", occurred_at: "2026-01-07T00:00:00Z" },
    ]);
    expect(result.score).toBe(100);
  });
});
