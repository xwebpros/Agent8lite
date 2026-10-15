import { describe, expect, it } from "vitest";
import { prepareTaskCreate } from "../../apps/api/src/task-create-command";
import { requireTaskCreateWrite } from "../../apps/web/components/task-create";
import { validTaskEditTimezone } from "../../apps/web/components/task-edit";

const orgId = "c5000000-0000-4000-8000-000000000001";
const body = (timezone: string) => ({
  assigneeMemberId: "c5000000-0000-4000-8000-000000000002",
  title: "Synthetic parity task",
  dueAt: "2026-11-01T09:30:00.000Z",
  timezone,
});
function server(timezone: string): boolean {
  try {
    prepareTaskCreate(body(timezone), "parity-key", `POST /v1/orgs/${orgId}/tasks`, orgId);
    return true;
  } catch {
    // Only the timezone varies, so any rejection (named-zone check or schema length) is a timezone rejection.
    return false;
  }
}
function clientCreate(timezone: string): boolean {
  try {
    requireTaskCreateWrite(body(timezone));
    return true;
  } catch {
    return false;
  }
}

// Review note from ADR-046: the client accepted a digit or sign in the first zone segment.
describe("Task timezone validation matches the server boundary", () => {
  it.each([
    "UTC",
    "America/Los_Angeles",
    "US/Pacific",
    "Asia/Bangkok",
    "America/Argentina/Buenos_Aires",
    "Etc/GMT+8",
    "Etc/GMT-14",
    "1America/Los_Angeles",
    "+America/Los_Angeles",
    "-Etc/GMT",
    "0/0",
    "PST",
    "EST5EDT",
    "+01:00",
    "Etc/Unknown_Zone",
    " UTC",
    "utc",
    "America/Los_Angeles/",
    `America/${"x".repeat(80)}`,
  ])("client create and edit agree with the server for %j", (zone) => {
    const expected = server(zone);
    expect(clientCreate(zone)).toBe(expected);
    expect(validTaskEditTimezone(zone)).toBe(expected);
  });

  it("rejects a digit- or sign-led first segment on every side", () => {
    for (const zone of ["1America/Los_Angeles", "+America/Los_Angeles", "-Etc/GMT"]) {
      expect(server(zone)).toBe(false);
      expect(clientCreate(zone)).toBe(false);
      expect(validTaskEditTimezone(zone)).toBe(false);
    }
  });
});
