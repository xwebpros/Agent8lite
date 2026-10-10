/** Pure MOD-E quiet-hours candidate calculation; grants no execution or sending authority. */
export type QuietHoursInputV1 = Readonly<{
  dueInstant: string;
  recipientTimeZone: string | null;
  organizationTimeZone: string;
  quietHours: Readonly<{ start: string; end: string }> | null;
}>;

export type QuietHoursResolutionV1 = Readonly<{
  dueInstant: string;
  eligibleInstant: string;
  timeZone: string;
  timeZoneSource: "recipient" | "organization-fallback";
  decision: "quiet-hours-disabled" | "unchanged" | "quiet-hours-deferred";
}>;

export type QuietHoursErrorCode = "quiet_hours_invalid" | "quiet_hours_unavailable";
