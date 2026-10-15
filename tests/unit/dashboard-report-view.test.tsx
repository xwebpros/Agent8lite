import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VerifiedMetricsView } from "../../apps/web/components/verified-metrics";
import {
  DashboardReportController,
  type DashboardReportState,
} from "../../apps/web/components/verified-metrics-controller";
import type { Schema } from "../../apps/web/lib/api";

const instant = "2026-10-10T12:00:00.123Z";
function report(value = 314159): Schema<"Dashboard"> {
  return {
    period: { from: "2026-10-01T00:00:00.000Z", to: instant, timezone: "UTC" },
    metrics: [
      {
        key: "leads.created",
        definitionVersion: 2,
        value,
        unit: "leads",
        source: "crm-own-utc-month-query-v2",
        state: "available",
        refreshedAt: instant,
      },
      {
        key: "revenue",
        definitionVersion: 1,
        value: null,
        unit: "USD",
        source: "billing-unconfigured",
        state: "unavailable",
        refreshedAt: null,
      },
    ],
    tasks: [],
    notifications: [],
    integrationHealth: [],
  };
}
function render(patch: Partial<DashboardReportState> = {}, userTimezone?: unknown, nowInstant?: unknown) {
  const zone = arguments.length > 1 ? userTimezone : "America/Los_Angeles";
  const clock = arguments.length > 2 ? nowInstant : instant;
  const initial = new DashboardReportController({
    binding: "PRIVATE_MEMBER_REPORT_BINDING",
    online: true,
    canRead: true,
    client: { read: async () => report() },
  }).getSnapshot();
  return renderToStaticMarkup(
    <VerifiedMetricsView
      state={{ ...initial, ...patch }}
      userTimezone={zone}
      nowInstant={clock}
      actions={{ refresh: vi.fn() }}
    />,
  );
}
function button(markup: string, name = "Refresh reporting") {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(
    ([html]) => html.replace(/<[^>]*>/g, "").trim() === name,
  )?.[0];
}
describe("static measured-report presentation (no browser claims)", () => {
  it("makes current member, exact closed UTC period, version, source and measured refresh explicit", () => {
    const markup = render({ snapshot: report(0), phase: "ready", receivedAt: instant });
    for (const text of [
      "Current member only",
      "workspace list selector does not widen",
      "Closed reporting period",
      "including both bounds",
      "UTC timezone (GMT+0)",
      "leads.created",
      "version 2",
      "crm-own-utc-month-query-v2",
      "Measured refresh",
      "Not applicable to this count",
      "Reassignment or archival can change",
      "Report read at",
      "five minutes",
      "not a provider service guarantee",
      "Loaded-list summary",
    ])
      expect(markup).toContain(text);
    expect(markup).toContain(">0</strong>");
    expect(markup).toContain("Available measurement");
    expect(markup).toContain("Measured count: 0");
    expect(markup).toContain('dateTime="2026-10-01T00:00:00.000Z"');
    expect(markup).not.toContain("PRIVATE_MEMBER_REPORT_BINDING");
    expect(button(markup)).not.toContain("disabled");
  });
  it("shows unavailable revenue with no measured currency or inferred engagement", () => {
    const markup = render({ snapshot: report(0) });
    expect(markup).toContain("Revenue measurement");
    expect(markup).toContain("Revenue measurement is not configured");
    expect(markup).toContain("billing-unconfigured");
    expect(markup).toContain("No measured numerator or denominator is available");
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain("Hours saved");
  });
  it("keeps unrequested/loading/unavailable and verified empty measurements distinct", () => {
    const untouched = render();
    expect(untouched).toContain("Refresh reporting to read");
    expect(untouched).not.toContain(">0</strong>");
    const loading = render({ reading: true, snapshot: report() });
    expect(loading).toContain("Loading your current-member report");
    expect(loading).not.toContain("314,159");
    expect(button(loading, "Refreshing reporting…")).toContain("disabled");
    const unavailable = render({ phase: "unavailable", error: "PRIVATE_PROVIDER_EXCEPTION" });
    expect(unavailable).toContain("Reporting is unavailable");
    expect(unavailable).not.toContain("PRIVATE_PROVIDER_EXCEPTION");
    const empty = report();
    empty.metrics = [];
    const verified = render({ snapshot: empty, phase: "ready" });
    expect(verified).toContain("No measured metrics were returned");
    expect(verified).not.toContain(">0</strong>");
  });
  it.each(["offline", "hidden", "denied"] as const)(
    "hides a retained private metric projection while%s and disables refresh",
    (cut) => {
      const markup = render({
        snapshot: report(),
        online: cut !== "offline",
        visible: cut !== "hidden",
        canRead: cut !== "denied",
      });
      expect(markup).not.toContain("314,159");
      expect(markup).not.toContain("crm-own-utc-month-query-v2");
      expect(markup).not.toContain(instant);
      expect(button(markup)).toContain("disabled");
      expect(markup).toContain('role="status"');
    },
  );
  it("explains denied authority recovery independently from a local report retry", () => {
    const markup = render({ canRead: false, phase: "denied" });
    expect(markup).toContain("Refresh workspace");
    expect(markup).toContain("verify current report access");
    expect(markup).not.toContain(">0</strong>");
  });
  it("withholds numeric values at the exact expiry boundary even when state still says ready", () => {
    const markup = render(
      { snapshot: report(), phase: "ready", receivedAt: instant },
      "UTC",
      "2026-10-10T12:05:00.123Z",
    );
    expect(markup).toContain("Values are withheld");
    expect(markup).not.toContain("314,159");
    expect(markup).not.toContain("Available measurement");
    expect(button(markup)).not.toContain("disabled");
  });
  it.each([undefined, "PRIVATE_INVALID_CLOCK", "2026-10-10T11:59:59.999Z"])(
    "fails closed for an unverifiable or backwards client clock%s",
    (now) => {
      const markup = render({ snapshot: report(), phase: "ready" }, "UTC", now);
      expect(markup).not.toContain("314,159");
      expect(markup).not.toContain("Available measurement");
    },
  );
  it.each(["loading", "empty", "unavailable"] as const)(
    "renders%s without positive values or available badges",
    (state) => {
      const source = report();
      source.metrics[0] = { ...source.metrics[0], state, value: null, refreshedAt: null };
      const markup = render({ snapshot: source });
      expect(markup).not.toContain("314,159");
      expect(markup).not.toContain("Available measurement");
      expect(markup).toContain(
        state === "loading"
          ? "Measurement loading"
          : state === "empty"
            ? "Empty · no measurement"
            : "Measurement unavailable",
      );
    },
  );
  it("does not display a numeric contradiction or denominator as a verified count/ratio", () => {
    const source = report();
    source.metrics[0].denominator = 3;
    const markup = render({ snapshot: source });
    expect(markup).not.toContain("314,159");
    expect(markup).not.toContain("Available measurement");
    expect(markup).toContain("Measurement unavailable");
  });
  it("marks unknown definitions unsupported and escapes their metadata while withholding numeric values", () => {
    const source = report();
    source.metrics[0].key = "<script>PRIVATE_CODE</script>";
    source.metrics[0].definitionVersion = 99;
    const markup = render({ snapshot: source });
    expect(markup).toContain("Unsupported definition");
    expect(markup).toContain("&lt;script&gt;PRIVATE_CODE&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("314,159");
  });
  it("independently rejects malformed retained source data instead of trusting a forged ready state", () => {
    const source = report();
    source.period.timezone = "PRIVATE_INVALID_ZONE";
    const markup = render({ snapshot: source, phase: "ready" });
    expect(markup).toContain("Reporting metadata is unavailable");
    expect(markup).not.toContain("PRIVATE_INVALID_ZONE");
    expect(markup).not.toContain("314,159");
  });
  it("supplements the fixed UTC definition with both Los Angeles fall offsets without redefining the period", () => {
    for (const [to, offset] of [
      ["2026-11-01T08:30:00.000Z", "GMT-7"],
      ["2026-11-01T09:30:00.000Z", "GMT-8"],
    ]) {
      const source = report(0);
      source.period = { from: "2026-11-01T00:00:00.000Z", to, timezone: "UTC" };
      source.metrics[0].refreshedAt = to;
      const markup = render({ snapshot: source }, "America/Los_Angeles", to);
      expect(markup).toContain("Your time (America/Los_Angeles)");
      expect(markup).toContain("01:30:00 " + offset);
      expect(markup).toContain("does not change the UTC-month definition");
      expect(markup).toContain(source.period.from);
    }
  });
  it("labels missing/invalid user zones as unavailable while preserving UTC and never exposing invalid text", () => {
    for (const zone of [null, undefined, "PRIVATE_UNSUPPORTED_ZONE"]) {
      const markup = render({ snapshot: report(0) }, zone);
      expect(markup).toContain("Your timezone is unavailable");
      expect(markup).toContain("UTC timezone (GMT+0)");
      expect(markup).not.toContain("PRIVATE_UNSUPPORTED_ZONE");
    }
  });
  it("does not repeat local time when user timezone is exactly UTC", () => {
    const markup = render({ snapshot: report(0) }, "UTC");
    expect(markup).toContain("UTC timezone (GMT+0)");
    expect(markup).not.toContain("Your time (UTC)");
  });
  it("provides a labeled region, native refresh button and status messages without embedding navigation or private persistence", () => {
    const markup = render({ phase: "unavailable" });
    expect(markup).toMatch(/<section[^>]*aria-labelledby=/);
    expect(markup).toContain("<h2");
    expect(button(markup)).toContain('type="button"');
    expect(markup).toContain('role="status"');
    expect(markup).not.toMatch(/<(?:a|input|iframe)\b/);
    expect(markup).toContain("only in this tab");
  });
});
