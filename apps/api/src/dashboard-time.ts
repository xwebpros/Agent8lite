import { types } from "node:util";
import type { components } from "../../../packages/contracts/generated/api";
import { AccessError } from "../../../packages/db/tenant-transaction";

type Period = components["schemas"]["Period"];

function unavailable(): never {
  throw new AccessError(503, "dashboard_clock_unavailable", "The reporting clock is unavailable.");
}

/** The database truncates its captured clock before either public bounds or source SQL uses it. */
export function dashboardClockInstant(value: unknown): string {
  try {
    if (types.isProxy(value)) return unavailable();
    let milliseconds: number;
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Date.prototype)
      milliseconds = Date.prototype.getTime.call(value);
    else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
      milliseconds = Date.parse(value);
    else return unavailable();
    if (!Number.isFinite(milliseconds)) return unavailable();
    const instant = new Date(milliseconds).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant)) return unavailable();
    if (typeof value === "string" && instant !== value) return unavailable();
    return instant;
  } catch {
    return unavailable();
  }
}

export function dashboardUtcPeriod(capturedClock: unknown): Readonly<Period> {
  const to = dashboardClockInstant(capturedClock);
  const start = new Date(to);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return Object.freeze({ from: start.toISOString(), to, timezone: "UTC" });
}
