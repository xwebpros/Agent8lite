/** Internal pure MOD-E calendar resolution; confers no execution or sending authority. */
export type CalendarTimeInputV1 = Readonly<{
  localDate: string;
  localTime: string;
  timeZone: string;
}>;

export type CalendarTimeResolutionV1 = Readonly<{
  timeZone: string;
  requestedLocal: Readonly<{ date: string; time: string }>;
  effectiveLocal: Readonly<{ date: string; time: string }>;
  instant: string;
  decision: "exact" | "overlap-earlier" | "gap-first-valid";
}>;

export type CalendarTimeErrorCode = "calendar_time_invalid" | "calendar_time_unavailable";
