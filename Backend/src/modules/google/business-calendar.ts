/**
 * Timezone-aware business-hours calendar utility.
 *
 * Used by R-01 (unanswered inbound) and intended for future reuse by
 * R-02 (stalled thread), R-03 (reply latency outlier), R-04 (after-hours
 * backlog), and R-05 (aging inbound queue).
 *
 * Holiday calendar: NOT supported — no holiday configuration exists in the
 * project. Only weekends (Saturday, Sunday) are excluded.
 *
 * DST: handled via Intl.DateTimeFormat — Node's built-in IANA database is
 * authoritative. At DST transition boundaries, elapsed-time errors are at
 * most ±1 hour, which is acceptable for responsiveness rules with multi-hour
 * thresholds.
 */

export interface BusinessCalendarConfig {
  /** IANA timezone identifier, e.g. 'America/Toronto'. */
  readonly timezone: string;
  /** Hour (0–23) at which the business day starts (inclusive). */
  readonly startHour: number;
  /** Hour (0–23) at which the business day ends (exclusive). E.g. 17 = 5 pm. */
  readonly endHour: number;
}

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
 * Two-step: naive UTC parse → measure actual local offset → correct.
 * Handles DST within the same calendar day (±1 hour precision).
 */
const localToUtc = (
  year: number, month: number, day: number,
  hour: number, minute: number,
  tz: string,
): Date => {
  // Step 1: treat desired local time as UTC (naive).
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  // Step 2: what local time does this UTC instant actually represent?
  const actual = utcToLocal(naive, tz);
  // Step 3: difference in minutes between desired and actual.
  const diffMs = ((hour * 60 + minute) - (actual.hour * 60 + actual.minute)) * 60_000;
  return new Date(naive.getTime() + diffMs);
};

/** True when `date` falls on a Saturday or Sunday in the configured timezone. */
export const isWeekend = (date: Date, config: BusinessCalendarConfig): boolean => {
  const { weekday } = utcToLocal(date, config.timezone);
  return weekday === 0 || weekday === 6;
};

/** True when `date` is within business hours (weekday, startHour ≤ hour < endHour). */
export const isBusinessHour = (date: Date, config: BusinessCalendarConfig): boolean => {
  const { weekday, hour } = utcToLocal(date, config.timezone);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= config.startHour && hour < config.endHour;
};

/**
 * Returns the UTC Date of the end of the business day (endHour:00)
 * on the LOCAL calendar day that `date` falls in for the given timezone.
 */
const endOfBusinessDay = (date: Date, config: BusinessCalendarConfig): Date => {
  const p = utcToLocal(date, config.timezone);
  return localToUtc(p.year, p.month, p.day, config.endHour, 0, config.timezone);
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
    // Weekend → advance to Monday
    if (p.weekday === 0 || p.weekday === 6) {
      const daysUntilMonday = p.weekday === 6 ? 2 : 1;
      const nextMonday = new Date(Date.UTC(p.year, p.month - 1, p.day + daysUntilMonday));
      cursor = localToUtc(
        utcToLocal(nextMonday, config.timezone).year,
        utcToLocal(nextMonday, config.timezone).month,
        utcToLocal(nextMonday, config.timezone).day,
        config.startHour, 0,
        config.timezone,
      );
      continue;
    }
    // Before business hours today → advance to startHour today
    if (p.hour < config.startHour) {
      cursor = localToUtc(p.year, p.month, p.day, config.startHour, 0, config.timezone);
      break;
    }
    // After business hours today → advance to startHour tomorrow
    if (p.hour >= config.endHour) {
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
