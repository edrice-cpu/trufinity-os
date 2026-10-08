import { describe, it, expect } from '@jest/globals';
import {
  utcToLocal,
  isWeekend,
  isBusinessHour,
  nextBusinessMoment,
  businessMinutesElapsed,
  type BusinessCalendarConfig,
} from '../../src/modules/google/business-calendar';

// All tests use UTC as the timezone to avoid host-machine timezone dependency.
const UTC_9_17: BusinessCalendarConfig = { timezone: 'UTC', startHour: 9, endHour: 17 };

// Helper: create a UTC Date from ISO string
const d = (iso: string): Date => new Date(iso);

// ---------------------------------------------------------------------------
// utcToLocal
// ---------------------------------------------------------------------------

describe('utcToLocal', () => {
  it('returns correct parts for a known UTC time', () => {
    const parts = utcToLocal(d('2026-06-15T10:30:00Z'), 'UTC');
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(6);
    expect(parts.day).toBe(15);
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(30);
    expect(parts.weekday).toBe(1); // Monday
  });

  it('returns weekday=6 for Saturday', () => {
    const parts = utcToLocal(d('2026-06-13T12:00:00Z'), 'UTC'); // Saturday
    expect(parts.weekday).toBe(6);
  });

  it('returns weekday=0 for Sunday', () => {
    const parts = utcToLocal(d('2026-06-14T12:00:00Z'), 'UTC'); // Sunday
    expect(parts.weekday).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isWeekend / isBusinessHour
// ---------------------------------------------------------------------------

describe('isWeekend', () => {
  it('Monday is not weekend', () => {
    expect(isWeekend(d('2026-06-15T12:00:00Z'), UTC_9_17)).toBe(false);
  });

  it('Saturday is weekend', () => {
    expect(isWeekend(d('2026-06-13T12:00:00Z'), UTC_9_17)).toBe(true);
  });

  it('Sunday is weekend', () => {
    expect(isWeekend(d('2026-06-14T12:00:00Z'), UTC_9_17)).toBe(true);
  });
});

describe('isBusinessHour', () => {
  it('weekday 10:00 UTC is business hour', () => {
    expect(isBusinessHour(d('2026-06-15T10:00:00Z'), UTC_9_17)).toBe(true);
  });

  it('weekday 09:00 UTC (exactly startHour) is business hour', () => {
    expect(isBusinessHour(d('2026-06-15T09:00:00Z'), UTC_9_17)).toBe(true);
  });

  it('weekday 16:59 UTC is business hour', () => {
    expect(isBusinessHour(d('2026-06-15T16:59:00Z'), UTC_9_17)).toBe(true);
  });

  it('weekday 17:00 UTC (endHour) is NOT business hour', () => {
    expect(isBusinessHour(d('2026-06-15T17:00:00Z'), UTC_9_17)).toBe(false);
  });

  it('weekday 08:59 UTC is NOT business hour', () => {
    expect(isBusinessHour(d('2026-06-15T08:59:00Z'), UTC_9_17)).toBe(false);
  });

  it('Saturday is never business hour', () => {
    expect(isBusinessHour(d('2026-06-13T10:00:00Z'), UTC_9_17)).toBe(false);
  });

  it('Sunday is never business hour', () => {
    expect(isBusinessHour(d('2026-06-14T10:00:00Z'), UTC_9_17)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// nextBusinessMoment
// ---------------------------------------------------------------------------

describe('nextBusinessMoment', () => {
  it('returns same date when already in business hours', () => {
    const input = d('2026-06-15T10:00:00Z'); // Monday 10:00 UTC
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe(input.toISOString());
  });

  it('advances from before business hours to startHour on same weekday', () => {
    const input = d('2026-06-15T07:00:00Z'); // Monday 07:00 UTC
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe('2026-06-15T09:00:00.000Z');
  });

  it('advances from after business hours to next business day startHour', () => {
    const input = d('2026-06-15T18:00:00Z'); // Monday 18:00 UTC
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe('2026-06-16T09:00:00.000Z'); // Tuesday 09:00
  });

  it('advances from Saturday to Monday startHour', () => {
    const input = d('2026-06-13T12:00:00Z'); // Saturday
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe('2026-06-15T09:00:00.000Z'); // Monday 09:00
  });

  it('advances from Sunday to Monday startHour', () => {
    const input = d('2026-06-14T12:00:00Z'); // Sunday
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe('2026-06-15T09:00:00.000Z'); // Monday 09:00
  });

  it('Friday after hours → Monday startHour', () => {
    const input = d('2026-06-19T22:00:00Z'); // Friday 22:00 UTC
    const result = nextBusinessMoment(input, UTC_9_17);
    expect(result.toISOString()).toBe('2026-06-22T09:00:00.000Z'); // Monday 09:00
  });
});

// ---------------------------------------------------------------------------
// businessMinutesElapsed — core scenarios
// ---------------------------------------------------------------------------

describe('businessMinutesElapsed', () => {
  it('returns 0 when to <= from', () => {
    const t = d('2026-06-15T10:00:00Z');
    expect(businessMinutesElapsed(t, t, UTC_9_17)).toBe(0);
    expect(businessMinutesElapsed(d('2026-06-15T11:00:00Z'), d('2026-06-15T10:00:00Z'), UTC_9_17)).toBe(0);
  });

  it('counts only business minutes within a single business day', () => {
    // Monday 10:00 → Monday 12:00 = 120 min
    expect(businessMinutesElapsed(
      d('2026-06-15T10:00:00Z'),
      d('2026-06-15T12:00:00Z'),
      UTC_9_17,
    )).toBe(120);
  });

  it('stops counting at endHour', () => {
    // Monday 16:00 → Monday 18:00 = only 60 min (17:00 cap)
    expect(businessMinutesElapsed(
      d('2026-06-15T16:00:00Z'),
      d('2026-06-15T18:00:00Z'),
      UTC_9_17,
    )).toBe(60);
  });

  it('starts counting from startHour when from is before business hours', () => {
    // Monday 07:00 → Monday 10:00 → effective from = 09:00 → 60 min
    expect(businessMinutesElapsed(
      d('2026-06-15T07:00:00Z'),
      d('2026-06-15T10:00:00Z'),
      UTC_9_17,
    )).toBe(60);
  });

  it('returns 0 when from is after business hours and to is the same day', () => {
    // Monday 18:00 → Monday 20:00 → no business time
    expect(businessMinutesElapsed(
      d('2026-06-15T18:00:00Z'),
      d('2026-06-15T20:00:00Z'),
      UTC_9_17,
    )).toBe(0);
  });

  it('spans Monday to Tuesday correctly (8 hours Mon + partial Tue)', () => {
    // Monday 09:00 → Tuesday 11:00 = 480 + 120 = 600 min
    expect(businessMinutesElapsed(
      d('2026-06-15T09:00:00Z'),
      d('2026-06-16T11:00:00Z'),
      UTC_9_17,
    )).toBe(600);
  });

  it('pauses over the weekend (Friday EOD to Monday morning)', () => {
    // Friday 16:00 → Monday 10:00 = 60 min Fri + 60 min Mon = 120 min
    expect(businessMinutesElapsed(
      d('2026-06-19T16:00:00Z'),
      d('2026-06-22T10:00:00Z'),
      UTC_9_17,
    )).toBe(120);
  });

  it('Saturday receipt "starts aging" Monday morning', () => {
    // Received Saturday 12:00. to = Monday 10:00.
    // Effective start = Monday 09:00 → elapsed = 60 min
    expect(businessMinutesElapsed(
      d('2026-06-13T12:00:00Z'),
      d('2026-06-15T10:00:00Z'),
      UTC_9_17,
    )).toBe(60);
  });

  it('full week (Mon–Fri 9–17) = 5 * 8 * 60 = 2400 min', () => {
    // Monday 09:00 → next Monday 09:00
    expect(businessMinutesElapsed(
      d('2026-06-15T09:00:00Z'),
      d('2026-06-22T09:00:00Z'),
      UTC_9_17,
    )).toBe(2400);
  });

  it('threshold check: 240 min = 4 business hours on same day', () => {
    // Monday 09:00 → Monday 13:00 = exactly 240 min
    expect(businessMinutesElapsed(
      d('2026-06-15T09:00:00Z'),
      d('2026-06-15T13:00:00Z'),
      UTC_9_17,
    )).toBe(240);
  });

  it('Sunday evening receipt → Monday afternoon: business hours elapsed correctly', () => {
    // Received Sunday 20:00. "to" = Monday 11:00.
    // Effective from = Monday 09:00 → elapsed = 120 min
    expect(businessMinutesElapsed(
      d('2026-06-14T20:00:00Z'),
      d('2026-06-15T11:00:00Z'),
      UTC_9_17,
    )).toBe(120);
  });
});
