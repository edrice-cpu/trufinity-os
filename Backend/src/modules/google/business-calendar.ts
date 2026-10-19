/**
 * Timezone-aware business-hours and coverage-hours calendar utilities.
 *
 * BusinessCalendarConfig — used by R-01 (regular 8 AM–4:30 PM), R-03, R-04, R-05.
 *   Hours are Mon–Fri only; weekends are excluded.
 *
 * CoverageCalendarConfig — used by R-02 (extended coverage including weekends).
 *   Supports different opening hours per weekday group via DayCoverageRule.
 *   Daniel confirmed: Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM, America/Los_Angeles.
 *
 * Holiday calendar: NOT supported — no holiday configuration exists in the project.
 *
 * DST: handled via Intl.DateTimeFormat — Node's built-in IANA database is
 * authoritative. At DST transition boundaries, elapsed-time errors are at
 * most ±1 hour, which is acceptable for responsiveness rules with multi-hour
 * thresholds.
 */

export interface BusinessCalendarConfig {
  /** IANA timezone identifier, e.g. 'America/Los_Angeles'. */
  readonly timezone: string;
  /** Hour (0–23) at which the business day starts (inclusive). */
  readonly startHour: number;
  /**
   * Hour (0–23) at which the business day ends (exclusive).
   * Combined with endMinute: e.g. endHour=16, endMinute=30 → closes at 4:30 PM.
   */
  readonly endHour: number;
  /**
   * Minute (0–59) of the closing hour. Defaults to 0 when omitted.
   * Allows sub-hour close times such as 4:30 PM (endHour=16, endMinute=30).
   */
  readonly endMinute?: number;
}

/**
 * A coverage rule defining which days and hours are considered "active coverage"
 * for one weekday group. Used by CoverageCalendarConfig (R-02).
 *
 * Example (Daniel confirmed):
 *   { weekdays: [1,2,3,4,5], startHour: 8,  endHour: 22 }  Mon–Fri  8 AM–10 PM
 *   { weekdays: [0,6],        startHour: 7,  endHour: 22 }  Sat–Sun  7 AM–10 PM
 *
 * Boundary semantics: startHour:startMinute is INCLUSIVE, endHour:endMinute is EXCLUSIVE.
 */
export interface DayCoverageRule {
  /** Day-of-week numbers covered (0=Sunday … 6=Saturday). */
  readonly weekdays: ReadonlyArray<number>;
  readonly startHour: number;
  readonly startMinute?: number;
  readonly endHour: number;
  readonly endMinute?: number;
}

/**
 * Coverage calendar used by R-02 to compute inactivity in coverage-hours rather
 * than elapsed clock time. Unlike BusinessCalendarConfig, this supports different
 * opening hours per weekday group and includes weekend days.
 */
export interface CoverageCalendarConfig {
  readonly timezone: string;
  readonly rules: ReadonlyArray<DayCoverageRule>;
}

/**
 * A single after-hours coverage window used by R-04.
 *
 * Examples (America/Los_Angeles):
 *   Weekday evenings: weekdays=[1,2,3,4,5], startHour=16, startMinute=30, endHour=22, endMinute=0
 *   Weekend days:     weekdays=[0,6],        startHour=7,  startMinute=0,  endHour=22, endMinute=0
 *
 * Boundary semantics: startHour:startMinute is INCLUSIVE, endHour:endMinute is EXCLUSIVE.
 */
export interface AfterHoursWindow {
  /** Day-of-week numbers covered (0=Sunday … 6=Saturday). */
  readonly weekdays: ReadonlyArray<number>;
  readonly startHour: number;
  readonly startMinute: number;
  readonly endHour: number;
  readonly endMinute: number;
}

/**
 * Returns true when `date` falls within any of the configured after-hours windows.
 * Uses IANA timezone `tz` (DST-aware). Boundary: [start, end).
 */
export const isInAfterHoursWindow = (
  date: Date,
  windows: ReadonlyArray<AfterHoursWindow>,
  tz: string,
): boolean => {
  const { weekday, hour, minute } = utcToLocal(date, tz);
  const totalMinutes = hour * 60 + minute;
  return windows.some((w) => {
    if (!(w.weekdays as number[]).includes(weekday)) return false;
    const start = w.startHour * 60 + w.startMinute;
    const end = w.endHour * 60 + w.endMinute;
    return totalMinutes >= start && totalMinutes < end;
  });
};

interface LocalParts {
  year: number;
  month: number;   // 1-based
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=Sunday, 1=Monday … 6=Saturday
}

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

/** Returns wall-clock parts for a UTC instant in the given IANA timezone. */
export const utcToLocal = (date: Date, tz: string): LocalParts => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, weekday: 'long',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    // Some Intl implementations emit '24' for midnight; normalise to 0.
    hour: parts.hour === '24' ? 0 : parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
    weekday: WEEKDAY_INDEX[parts.weekday.toLowerCase()] ?? 0,
  };
};

/**
 * Converts a local wall-clock time in a given timezone to a UTC Date.
 *
 * Uses full calendar-date arithmetic (not hour-only arithmetic) to avoid
 * day-boundary errors at large timezone offsets (e.g. UTC-8 producing a
 * negative diff that moves the result to the previous calendar day).
 *
 * Two correction passes handle DST transitions where the first pass lands on
 * the wrong side of the spring-forward or fall-back boundary.
 */
const localToUtc = (
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): Date => {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Pass 1: treat local time as UTC, then measure the full calendar-aware offset.
  const naive = new Date(targetMs);
  const actual1 = utcToLocal(naive, tz);
  const actual1Ms = Date.UTC(actual1.year, actual1.month - 1, actual1.day, actual1.hour, actual1.minute);
  const corrected = new Date(naive.getTime() + (targetMs - actual1Ms));
  // Pass 2: one more correction for DST boundary cases where pass 1 crosses
  // into a different offset region (spring-forward or fall-back).
  const actual2 = utcToLocal(corrected, tz);
  const actual2Ms = Date.UTC(actual2.year, actual2.month - 1, actual2.day, actual2.hour, actual2.minute);
  return new Date(corrected.getTime() + (targetMs - actual2Ms));
};

/** True when `date` falls on a Saturday or Sunday in the configured timezone. */
export const isWeekend = (date: Date, config: BusinessCalendarConfig): boolean => {
  const { weekday } = utcToLocal(date, config.timezone);
  return weekday === 0 || weekday === 6;
};

/** True when `date` is within business hours (weekday, start ≤ time < end, both in minutes). */
export const isBusinessHour = (date: Date, config: BusinessCalendarConfig): boolean => {
  const { weekday, hour, minute } = utcToLocal(date, config.timezone);
  if (weekday === 0 || weekday === 6) return false;
  const totalMinutes = hour * 60 + minute;
  const endMinute = config.endMinute ?? 0;
  return totalMinutes >= config.startHour * 60 && totalMinutes < config.endHour * 60 + endMinute;
};

/**
 * Returns the UTC Date of the end of the business day (endHour:endMinute)
 * on the LOCAL calendar day that `date` falls in for the given timezone.
 */
const endOfBusinessDay = (date: Date, config: BusinessCalendarConfig): Date => {
  const p = utcToLocal(date, config.timezone);
  return localToUtc(p.year, p.month, p.day, config.endHour, config.endMinute ?? 0, config.timezone);
};

/**
 * Advances `date` to the next UTC instant that is within business hours.
 * If `date` is already within business hours, returns `date` unchanged.
 *
 * Skips weekends: a Saturday or Sunday advances to the following Monday's
 * business opening.
 */
export const nextBusinessMoment = (date: Date, config: BusinessCalendarConfig): Date => {
  let cursor = date;
  for (let i = 0; i < 10; i++) {
    const p = utcToLocal(cursor, config.timezone);
    // Weekend → advance to Monday.
    // Use the LOCAL date (p.year/month/day) directly to avoid a UTC-midnight
    // offset issue where Date.UTC(year, month-1, day+N) at T00:00Z converts
    // back to the previous local calendar day in UTC-7/UTC-8 zones.
    if (p.weekday === 0 || p.weekday === 6) {
      const daysUntilMonday = p.weekday === 6 ? 2 : 1;
      cursor = localToUtc(p.year, p.month, p.day + daysUntilMonday, config.startHour, 0, config.timezone);
      continue;
    }
    // Before business hours today → advance to startHour today
    if (p.hour < config.startHour) {
      cursor = localToUtc(p.year, p.month, p.day, config.startHour, 0, config.timezone);
      break;
    }
    // After business hours today → advance to startHour tomorrow
    if (p.hour * 60 + p.minute >= config.endHour * 60 + (config.endMinute ?? 0)) {
      // Add 1 calendar day
      const tomorrow = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      const tp = utcToLocal(tomorrow, config.timezone);
      cursor = localToUtc(tp.year, tp.month, tp.day, config.startHour, 0, config.timezone);
      continue;
    }
    // Within business hours
    break;
  }
  return cursor;
};

/**
 * Computes the number of business MINUTES elapsed between two UTC timestamps.
 *
 * Semantics:
 * - `from` is clamped to the next business moment if it falls outside business hours.
 *   This means a message received at 11 pm "starts aging" at the next morning's opening.
 * - Weekends are skipped entirely.
 * - The result is zero when `to ≤ from` or when `from` is after the last business
 *   moment before `to`.
 * - Does NOT account for holidays (no holiday calendar is configured).
 *
 * Future rules R-02–R-05 can use this function directly.
 */
export const businessMinutesElapsed = (
  from: Date,
  to: Date,
  config: BusinessCalendarConfig,
): number => {
  if (to <= from) return 0;

  let cursor = nextBusinessMoment(from, config);
  if (cursor >= to) return 0;

  let totalMs = 0;
  // Safety cap: a single call should not iterate more than 365 days.
  const maxIterations = 365 * 2;
  let iterations = 0;

  while (cursor < to && iterations++ < maxIterations) {
    const dayEnd = endOfBusinessDay(cursor, config);
    const segmentEnd = dayEnd < to ? dayEnd : to;

    if (segmentEnd > cursor) {
      totalMs += segmentEnd.getTime() - cursor.getTime();
    }

    if (dayEnd >= to) break;

    // Advance past end of this business day to the next business opening.
    cursor = nextBusinessMoment(new Date(dayEnd.getTime() + 60_000), config);
  }

  return Math.floor(totalMs / 60_000);
};

/**
 * Builds a request-scoped calculator for one fixed `to` instant. It
 * precomputes the DST-aware business windows across the bounded source range,
 * avoiding repeated Intl/date conversions for every thread while preserving
 * the same interval semantics as businessMinutesElapsed.
 */
export const createBusinessMinutesCalculator = (
  to: Date,
  config: BusinessCalendarConfig,
  earliestFrom: Date,
): ((from: Date) => number) => {
  const first = utcToLocal(earliestFrom, config.timezone);
  const last = utcToLocal(to, config.timezone);
  const firstDay = Date.UTC(first.year, first.month - 1, first.day - 1);
  const lastDay = Date.UTC(last.year, last.month - 1, last.day + 1);
  const windows: Array<{ start: Date; end: Date }> = [];
  for (let marker = firstDay; marker <= lastDay; marker += 24 * 60 * 60 * 1000) {
    const date = new Date(marker);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    windows.push({
      start: localToUtc(year, month, day, config.startHour, 0, config.timezone),
      end: localToUtc(year, month, day, config.endHour, config.endMinute ?? 0, config.timezone),
    });
  }

  return (from: Date): number => {
    if (to <= from) return 0;
    let totalMs = 0;
    for (const window of windows) {
      const start = from > window.start ? from : window.start;
      const end = to < window.end ? to : window.end;
      if (end > start) totalMs += end.getTime() - start.getTime();
    }
    return Math.floor(totalMs / 60_000);
  };
};

// ---------------------------------------------------------------------------
// Coverage-hours functions (R-02)
// ---------------------------------------------------------------------------

/** Returns the DayCoverageRule matching `weekday`, or null if no rule covers that day. */
const getCoverageRule = (weekday: number, config: CoverageCalendarConfig): DayCoverageRule | null =>
  config.rules.find((r) => (r.weekdays as number[]).includes(weekday)) ?? null;

/** True when `date` falls within any coverage rule window. Boundary: [start, end). */
export const isCoverageHour = (date: Date, config: CoverageCalendarConfig): boolean => {
  const { weekday, hour, minute } = utcToLocal(date, config.timezone);
  const rule = getCoverageRule(weekday, config);
  if (!rule) return false;
  const totalMin = hour * 60 + minute;
  return totalMin >= rule.startHour * 60 + (rule.startMinute ?? 0) &&
         totalMin <  rule.endHour   * 60 + (rule.endMinute   ?? 0);
};

/**
 * Advances `date` to the next UTC instant that is within coverage hours.
 * If `date` is already within coverage hours, returns `date` unchanged.
 * Days with no matching coverage rule are skipped entirely.
 */
export const nextCoverageMoment = (date: Date, config: CoverageCalendarConfig): Date => {
  let cursor = date;
  // At most 14 iterations: no valid coverage schedule spans more than 7 days.
  for (let i = 0; i < 14; i++) {
    const p = utcToLocal(cursor, config.timezone);
    const rule = getCoverageRule(p.weekday, config);
    if (!rule) {
      // No coverage on this weekday — advance to midnight of the next calendar day.
      const next = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      const np = utcToLocal(next, config.timezone);
      cursor = localToUtc(np.year, np.month, np.day, 0, 0, config.timezone);
      continue;
    }
    const startMin = rule.startHour * 60 + (rule.startMinute ?? 0);
    const endMin   = rule.endHour   * 60 + (rule.endMinute   ?? 0);
    const curMin   = p.hour * 60 + p.minute;
    if (curMin < startMin) {
      // Before today's coverage window opens.
      cursor = localToUtc(p.year, p.month, p.day, rule.startHour, rule.startMinute ?? 0, config.timezone);
      break;
    }
    if (curMin >= endMin) {
      // After today's coverage window closes — advance to midnight of the next calendar day.
      const next = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
      const np = utcToLocal(next, config.timezone);
      cursor = localToUtc(np.year, np.month, np.day, 0, 0, config.timezone);
      continue;
    }
    // Within coverage hours.
    break;
  }
  return cursor;
};

/**
 * Returns the UTC Date of the end of the coverage window (endHour:endMinute)
 * on the LOCAL calendar day that `date` falls in. `date` must already be within
 * a coverage day (i.e. returned by nextCoverageMoment).
 */
const endOfCoverageDay = (date: Date, config: CoverageCalendarConfig): Date => {
  const p = utcToLocal(date, config.timezone);
  const rule = getCoverageRule(p.weekday, config);
  if (!rule) throw new Error('endOfCoverageDay: date does not fall on a coverage day');
  return localToUtc(p.year, p.month, p.day, rule.endHour, rule.endMinute ?? 0, config.timezone);
};

/**
 * Computes the number of coverage MINUTES elapsed between two UTC timestamps.
 *
 * Semantics:
 * - `from` is clamped to the next coverage moment if it falls outside coverage hours.
 * - Days with no coverage rule are skipped entirely.
 * - Weekend vs. weekday opening hours are handled by the per-rule startHour.
 * - The result is zero when `to ≤ from` or when `from` is past the last coverage
 *   moment before `to`.
 * - Does NOT account for holidays.
 *
 * Used by R-02 Condition A for 24-coverage-hour inactivity detection.
 */
export const coverageMinutesElapsed = (
  from: Date,
  to: Date,
  config: CoverageCalendarConfig,
): number => {
  if (to <= from) return 0;

  let cursor = nextCoverageMoment(from, config);
  if (cursor >= to) return 0;

  let totalMs = 0;
  const maxIterations = 365 * 2;
  let iterations = 0;

  while (cursor < to && iterations++ < maxIterations) {
    const dayEnd = endOfCoverageDay(cursor, config);
    const segmentEnd = dayEnd < to ? dayEnd : to;

    if (segmentEnd > cursor) {
      totalMs += segmentEnd.getTime() - cursor.getTime();
    }

    if (dayEnd >= to) break;

    // Advance past end of this coverage day to the next coverage opening.
    cursor = nextCoverageMoment(new Date(dayEnd.getTime() + 60_000), config);
  }

  return Math.floor(totalMs / 60_000);
};
