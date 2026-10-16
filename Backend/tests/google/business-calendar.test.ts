import { describe, it, expect } from '@jest/globals';
import {
  utcToLocal,
  isWeekend,
  isBusinessHour,
  nextBusinessMoment,
  businessMinutesElapsed,
  createBusinessMinutesCalculator,
  isCoverageHour,
  nextCoverageMoment,
  coverageMinutesElapsed,
  type BusinessCalendarConfig,
  type CoverageCalendarConfig,
} from '../../src/modules/google/business-calendar';

// All tests use UTC as the timezone to avoid host-machine timezone dependency.
const UTC_9_17: BusinessCalendarConfig = { timezone: 'UTC', startHour: 9, endHour: 17 };

// Half-hour boundary: 8:00 AM – 4:30 PM UTC (mirrors Daniel's Pacific config).
const UTC_8_16_30: BusinessCalendarConfig = { timezone: 'UTC', startHour: 8, endHour: 16, endMinute: 30 };

// Pacific timezone config used to verify DST-aware behaviour.
const LA_8_16_30: BusinessCalendarConfig = { timezone: 'America/Los_Angeles', startHour: 8, endHour: 16, endMinute: 30 };

// Helper: create a UTC Date from ISO string
const d = (iso: string): Date => new Date(iso);

describe('createBusinessMinutesCalculator', () => {
  it.each([
    [UTC_8_16_30, '2026-01-09T16:00:00Z', '2026-01-12T09:00:00Z'],
    [LA_8_16_30, '2026-03-06T16:00:00Z', '2026-03-09T16:00:00Z'],
    [LA_8_16_30, '2026-11-01T15:00:00Z', '2026-11-03T17:00:00Z'],
  ])('matches the reference calculation across calendar boundaries', (config, fromIso, toIso) => {
    const from = d(fromIso);
    const to = d(toIso);
    const calculate = createBusinessMinutesCalculator(to, config, from);
    expect(calculate(from)).toBe(businessMinutesElapsed(from, to, config));
  });
});

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

// ---------------------------------------------------------------------------
// endMinute — half-hour boundary support (UTC_8_16_30 = 8:00–16:30 UTC)
// ---------------------------------------------------------------------------

describe('isBusinessHour — half-hour boundary (UTC 8:00–16:30)', () => {
  // Test case 1: Monday 8:00 AM opening
  it('Monday 8:00 AM exactly is business hour (opening boundary)', () => {
    expect(isBusinessHour(d('2026-06-15T08:00:00Z'), UTC_8_16_30)).toBe(true);
  });

  it('Monday 7:59 AM is NOT business hour (before opening)', () => {
    expect(isBusinessHour(d('2026-06-15T07:59:00Z'), UTC_8_16_30)).toBe(false);
  });

  // Test case 2: Monday 4:29 PM within regular hours
  it('Monday 4:29 PM is business hour (last full minute before close)', () => {
    expect(isBusinessHour(d('2026-06-15T16:29:00Z'), UTC_8_16_30)).toBe(true);
  });

  // Test case 3: Monday 4:30 PM closing boundary (exclusive)
  it('Monday 4:30 PM is NOT business hour (closing boundary, exclusive)', () => {
    expect(isBusinessHour(d('2026-06-15T16:30:00Z'), UTC_8_16_30)).toBe(false);
  });

  // Test case 4: Monday 4:31 PM outside regular hours
  it('Monday 4:31 PM is NOT business hour', () => {
    expect(isBusinessHour(d('2026-06-15T16:31:00Z'), UTC_8_16_30)).toBe(false);
  });

  // Test case 6 (weekend): Saturday is never business hour under 8:00–16:30 config
  it('Saturday is never business hour', () => {
    expect(isBusinessHour(d('2026-06-13T10:00:00Z'), UTC_8_16_30)).toBe(false);
  });

  it('Sunday is never business hour', () => {
    expect(isBusinessHour(d('2026-06-14T10:00:00Z'), UTC_8_16_30)).toBe(false);
  });
});

describe('nextBusinessMoment — half-hour boundary (UTC 8:00–16:30)', () => {
  // Test case 5: Friday 4:30 PM closes → next Monday 8:00 AM
  it('Friday 4:30 PM → Monday 8:00 AM (weekend skip preserves endMinute boundary)', () => {
    const input = d('2026-06-19T16:30:00Z'); // Friday 16:30 UTC — exactly at close
    const result = nextBusinessMoment(input, UTC_8_16_30);
    expect(result.toISOString()).toBe('2026-06-22T08:00:00.000Z');
  });

  it('Friday 4:29 PM is within hours — returns same moment', () => {
    const input = d('2026-06-19T16:29:00Z');
    const result = nextBusinessMoment(input, UTC_8_16_30);
    expect(result.toISOString()).toBe(input.toISOString());
  });

  it('Monday 7:00 AM before open → Monday 8:00 AM', () => {
    const input = d('2026-06-15T07:00:00Z');
    const result = nextBusinessMoment(input, UTC_8_16_30);
    expect(result.toISOString()).toBe('2026-06-15T08:00:00.000Z');
  });

  it('Monday 4:30 PM → Tuesday 8:00 AM (minute-level after-hours advance)', () => {
    const input = d('2026-06-15T16:30:00Z');
    const result = nextBusinessMoment(input, UTC_8_16_30);
    expect(result.toISOString()).toBe('2026-06-16T08:00:00.000Z');
  });
});

describe('businessMinutesElapsed — half-hour boundary (UTC 8:00–16:30)', () => {
  // Test case 7: 240 business minutes spanning the 4:30 PM boundary
  it('240 business minutes ending exactly at the 4:30 PM close', () => {
    // 12:30 → 16:30 UTC = 240 min (entirely within the 8:00–16:30 window)
    expect(businessMinutesElapsed(
      d('2026-06-15T12:30:00Z'),
      d('2026-06-15T16:30:00Z'),
      UTC_8_16_30,
    )).toBe(240);
  });

  it('from exactly at close → no business minutes on same day', () => {
    expect(businessMinutesElapsed(
      d('2026-06-15T16:30:00Z'),
      d('2026-06-15T17:00:00Z'),
      UTC_8_16_30,
    )).toBe(0);
  });

  it('full business day = 8.5 hours = 510 minutes', () => {
    expect(businessMinutesElapsed(
      d('2026-06-15T08:00:00Z'),
      d('2026-06-15T16:30:00Z'),
      UTC_8_16_30,
    )).toBe(510);
  });

  it('two full business days = 1020 minutes', () => {
    expect(businessMinutesElapsed(
      d('2026-06-15T08:00:00Z'),
      d('2026-06-16T16:30:00Z'),
      UTC_8_16_30,
    )).toBe(1020);
  });

  it('Friday 16:00 → Monday 08:30: only 30 min Fri + 30 min Mon = 60 min', () => {
    expect(businessMinutesElapsed(
      d('2026-06-19T16:00:00Z'),
      d('2026-06-22T08:30:00Z'),
      UTC_8_16_30,
    )).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Test case 8: Pacific DST-aware behaviour
// ---------------------------------------------------------------------------

describe('isBusinessHour — Pacific DST transitions (America/Los_Angeles, 8:00–16:30)', () => {
  // PST (UTC-8): 8:00 AM PST = 16:00 UTC; 16:30 PST = 00:30 next day UTC
  it('PST: Monday 8:00 AM local (16:00 UTC) is business hour', () => {
    // 2026-01-05 is Monday; PST (UTC-8) in January
    expect(isBusinessHour(new Date('2026-01-05T16:00:00Z'), LA_8_16_30)).toBe(true);
  });

  it('PST: Monday 7:59 AM local (15:59 UTC) is NOT business hour', () => {
    expect(isBusinessHour(new Date('2026-01-05T15:59:00Z'), LA_8_16_30)).toBe(false);
  });

  it('PST: Monday 4:29 PM local (00:29 UTC next day) is business hour', () => {
    expect(isBusinessHour(new Date('2026-01-06T00:29:00Z'), LA_8_16_30)).toBe(true);
  });

  it('PST: Monday 4:30 PM local (00:30 UTC next day) is NOT business hour', () => {
    expect(isBusinessHour(new Date('2026-01-06T00:30:00Z'), LA_8_16_30)).toBe(false);
  });

  // PDT (UTC-7): 8:00 AM PDT = 15:00 UTC; 4:30 PM PDT = 23:30 UTC
  it('PDT: Monday 8:00 AM local (15:00 UTC) is business hour', () => {
    // 2026-06-15 is Monday; PDT (UTC-7) in June
    expect(isBusinessHour(new Date('2026-06-15T15:00:00Z'), LA_8_16_30)).toBe(true);
  });

  it('PDT: Monday 7:59 AM local (14:59 UTC) is NOT business hour', () => {
    expect(isBusinessHour(new Date('2026-06-15T14:59:00Z'), LA_8_16_30)).toBe(false);
  });

  it('PDT: Monday 4:29 PM local (23:29 UTC) is business hour', () => {
    expect(isBusinessHour(new Date('2026-06-15T23:29:00Z'), LA_8_16_30)).toBe(true);
  });

  it('PDT: Monday 4:30 PM local (23:30 UTC) is NOT business hour', () => {
    expect(isBusinessHour(new Date('2026-06-15T23:30:00Z'), LA_8_16_30)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test case 9: backward compatibility — endMinute omitted
// ---------------------------------------------------------------------------

describe('backward compatibility — endMinute omitted defaults to :00', () => {
  const NO_END_MINUTE: BusinessCalendarConfig = { timezone: 'UTC', startHour: 9, endHour: 17 };

  it('16:59 is business hour when endMinute is omitted', () => {
    expect(isBusinessHour(d('2026-06-15T16:59:00Z'), NO_END_MINUTE)).toBe(true);
  });

  it('17:00 is NOT business hour when endMinute is omitted', () => {
    expect(isBusinessHour(d('2026-06-15T17:00:00Z'), NO_END_MINUTE)).toBe(false);
  });

  it('full business day without endMinute = 8 hours = 480 minutes', () => {
    expect(businessMinutesElapsed(
      d('2026-06-15T09:00:00Z'),
      d('2026-06-15T17:00:00Z'),
      NO_END_MINUTE,
    )).toBe(480);
  });

  it('nextBusinessMoment after close advances to next opening', () => {
    const result = nextBusinessMoment(d('2026-06-15T17:00:00Z'), NO_END_MINUTE);
    expect(result.toISOString()).toBe('2026-06-16T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Coverage-hours utilities (R-02 Daniel-confirmed schedule)
// Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM, UTC (no DST to simplify arithmetic)
// ---------------------------------------------------------------------------

// UTC coverage calendar: weekdays 8–22, weekends 7–22.
const UTC_COVERAGE: CoverageCalendarConfig = {
  timezone: 'UTC',
  rules: [
    { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 22 },
    { weekdays: [0, 6],           startHour: 7, endHour: 22 },
  ],
};

// America/Los_Angeles coverage calendar for DST tests.
const LA_COVERAGE: CoverageCalendarConfig = {
  timezone: 'America/Los_Angeles',
  rules: [
    { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 22 },
    { weekdays: [0, 6],           startHour: 7, endHour: 22 },
  ],
};

describe('isCoverageHour', () => {
  it('Monday 10:00 UTC is within weekday coverage (8–22)', () => {
    expect(isCoverageHour(d('2026-06-15T10:00:00Z'), UTC_COVERAGE)).toBe(true);
  });

  it('Monday 8:00 UTC exactly at weekday start is within coverage', () => {
    expect(isCoverageHour(d('2026-06-15T08:00:00Z'), UTC_COVERAGE)).toBe(true);
  });

  it('Monday 7:59 UTC is NOT within weekday coverage (before 8 AM)', () => {
    expect(isCoverageHour(d('2026-06-15T07:59:00Z'), UTC_COVERAGE)).toBe(false);
  });

  it('Monday 22:00 UTC is NOT within weekday coverage (exclusive end)', () => {
    expect(isCoverageHour(d('2026-06-15T22:00:00Z'), UTC_COVERAGE)).toBe(false);
  });

  it('Monday 21:59 UTC is within weekday coverage (last minute before close)', () => {
    expect(isCoverageHour(d('2026-06-15T21:59:00Z'), UTC_COVERAGE)).toBe(true);
  });

  it('Saturday 9:00 UTC is within weekend coverage (7–22)', () => {
    // 2026-06-13 is Saturday
    expect(isCoverageHour(d('2026-06-13T09:00:00Z'), UTC_COVERAGE)).toBe(true);
  });

  it('Saturday 7:00 UTC exactly at weekend start is within coverage', () => {
    expect(isCoverageHour(d('2026-06-13T07:00:00Z'), UTC_COVERAGE)).toBe(true);
  });

  it('Saturday 6:59 UTC is NOT within weekend coverage (before 7 AM)', () => {
    expect(isCoverageHour(d('2026-06-13T06:59:00Z'), UTC_COVERAGE)).toBe(false);
  });

  it('Sunday 22:00 UTC is NOT within weekend coverage (exclusive end)', () => {
    // 2026-06-14 is Sunday
    expect(isCoverageHour(d('2026-06-14T22:00:00Z'), UTC_COVERAGE)).toBe(false);
  });
});

describe('nextCoverageMoment', () => {
  it('returns date unchanged when already within weekday coverage hours', () => {
    const input = d('2026-06-15T10:00:00Z'); // Monday 10:00 UTC
    expect(nextCoverageMoment(input, UTC_COVERAGE).toISOString()).toBe(input.toISOString());
  });

  it('advances Monday 6:00 UTC to Monday 8:00 UTC (before weekday open)', () => {
    expect(nextCoverageMoment(d('2026-06-15T06:00:00Z'), UTC_COVERAGE).toISOString())
      .toBe('2026-06-15T08:00:00.000Z');
  });

  it('advances Monday 22:30 UTC to Tuesday 8:00 UTC (after weekday close)', () => {
    expect(nextCoverageMoment(d('2026-06-15T22:30:00Z'), UTC_COVERAGE).toISOString())
      .toBe('2026-06-16T08:00:00.000Z');
  });

  it('advances Friday 22:30 UTC to Saturday 7:00 UTC (Fri close → Sat weekend open)', () => {
    // Friday June 19, 22:30 UTC → Saturday June 20, 7:00 UTC
    expect(nextCoverageMoment(d('2026-06-19T22:30:00Z'), UTC_COVERAGE).toISOString())
      .toBe('2026-06-20T07:00:00.000Z');
  });

  it('returns date unchanged when already within weekend coverage hours', () => {
    const input = d('2026-06-13T09:00:00Z'); // Saturday 9:00 UTC
    expect(nextCoverageMoment(input, UTC_COVERAGE).toISOString()).toBe(input.toISOString());
  });

  it('advances Saturday 6:00 UTC to Saturday 7:00 UTC (before weekend open)', () => {
    expect(nextCoverageMoment(d('2026-06-13T06:00:00Z'), UTC_COVERAGE).toISOString())
      .toBe('2026-06-13T07:00:00.000Z');
  });

  it('advances Sunday 22:30 UTC to Monday 8:00 UTC (Sun close → Mon weekday open)', () => {
    // Sunday June 14, 22:30 UTC → Monday June 15, 8:00 UTC
    expect(nextCoverageMoment(d('2026-06-14T22:30:00Z'), UTC_COVERAGE).toISOString())
      .toBe('2026-06-15T08:00:00.000Z');
  });
});

describe('coverageMinutesElapsed', () => {
  it('returns 0 when to <= from', () => {
    const t = d('2026-06-15T10:00:00Z');
    expect(coverageMinutesElapsed(t, t, UTC_COVERAGE)).toBe(0);
    expect(coverageMinutesElapsed(d('2026-06-15T11:00:00Z'), t, UTC_COVERAGE)).toBe(0);
  });

  it('counts coverage minutes within a single weekday (Mon 10:00–12:00 = 120 min)', () => {
    expect(coverageMinutesElapsed(
      d('2026-06-15T10:00:00Z'),
      d('2026-06-15T12:00:00Z'),
      UTC_COVERAGE,
    )).toBe(120);
  });

  it('stops counting at weekday coverage end (22:00, exclusive)', () => {
    // Mon 20:00 → Mon 23:00: only 20:00–22:00 = 120 min
    expect(coverageMinutesElapsed(
      d('2026-06-15T20:00:00Z'),
      d('2026-06-15T23:00:00Z'),
      UTC_COVERAGE,
    )).toBe(120);
  });

  it('returns 0 when from is after coverage end on the same day', () => {
    // Mon 22:00 → Mon 23:00: no coverage
    expect(coverageMinutesElapsed(
      d('2026-06-15T22:00:00Z'),
      d('2026-06-15T23:00:00Z'),
      UTC_COVERAGE,
    )).toBe(0);
  });

  it('counts weekend coverage minutes (Sat 9:00–11:00 = 120 min)', () => {
    expect(coverageMinutesElapsed(
      d('2026-06-13T09:00:00Z'),
      d('2026-06-13T11:00:00Z'),
      UTC_COVERAGE,
    )).toBe(120);
  });

  it('24 coverage hours starting Monday 8:00 UTC = Mon(840) + Tue partial', () => {
    // Mon 8:00–22:00 = 840 min. Need 1440-840 = 600 more on Tue. Tue 8:00 + 600 min = 18:00.
    expect(coverageMinutesElapsed(
      d('2026-06-15T08:00:00Z'),
      d('2026-06-16T18:00:00Z'),
      UTC_COVERAGE,
    )).toBe(1440);
  });

  it('just below 24 coverage hours (1439 min) starting Monday 8:00 UTC', () => {
    // Mon 8:00–22:00 = 840. Tue 8:00 + 599 min = Tue 17:59.
    expect(coverageMinutesElapsed(
      d('2026-06-15T08:00:00Z'),
      d('2026-06-16T17:59:00Z'),
      UTC_COVERAGE,
    )).toBe(1439);
  });

  it('Friday-to-Saturday transition: 24 coverage hours spanning the weekend boundary', () => {
    // Fri Jun 19 14:00 UTC.
    // Fri 14:00–22:00 = 480 min. Sat 7:00–22:00 = 900 min (total 1380).
    // Need 60 more on Sun: Sun 7:00 + 60 = 8:00 UTC.
    expect(coverageMinutesElapsed(
      d('2026-06-19T14:00:00Z'),
      d('2026-06-21T08:00:00Z'),
      UTC_COVERAGE,
    )).toBe(1440);
  });

  it('Sunday-to-Monday transition: coverage accumulates across the boundary', () => {
    // Sun Jun 14 22:30 UTC (after close) → Mon Jun 15 18:00 UTC.
    // nextCoverageMoment(Sun 22:30) = Mon 8:00. Mon 8:00–18:00 = 600 min.
    expect(coverageMinutesElapsed(
      d('2026-06-14T22:30:00Z'),
      d('2026-06-15T18:00:00Z'),
      UTC_COVERAGE,
    )).toBe(600);
  });

  it('full week from Mon 8:00 to next Mon 8:00: 5 weekdays + 2 weekend days', () => {
    // Weekdays: 5 × 840 = 4200. Weekends: 2 × 900 = 1800. Total = 6000 min.
    expect(coverageMinutesElapsed(
      d('2026-06-15T08:00:00Z'),
      d('2026-06-22T08:00:00Z'),
      UTC_COVERAGE,
    )).toBe(6000);
  });

  it('from before weekday open is clamped to open time', () => {
    // Mon 6:00 → Mon 10:00: effective from = Mon 8:00 → 120 min
    expect(coverageMinutesElapsed(
      d('2026-06-15T06:00:00Z'),
      d('2026-06-15T10:00:00Z'),
      UTC_COVERAGE,
    )).toBe(120);
  });

  it('from before weekend open is clamped to weekend open time', () => {
    // Sat 5:00 → Sat 9:00: effective from = Sat 7:00 → 120 min
    expect(coverageMinutesElapsed(
      d('2026-06-13T05:00:00Z'),
      d('2026-06-13T09:00:00Z'),
      UTC_COVERAGE,
    )).toBe(120);
  });
});

describe('coverageMinutesElapsed — Pacific DST transitions', () => {
  // Spring forward 2025: Sun Mar 9, 2025 2:00 AM PST → 3:00 AM PDT (day is 23 hours).
  it('PDT spring forward: 60 minutes within the spring-forward Sunday remain 60 coverage minutes', () => {
    // 14:00 UTC = 7:00 AM PDT exactly (coverage opens). 15:00 UTC = 8:00 AM PDT.
    expect(coverageMinutesElapsed(
      new Date('2025-03-09T14:00:00Z'),
      new Date('2025-03-09T15:00:00Z'),
      LA_COVERAGE,
    )).toBe(60);
  });

  it('PDT spring forward: coverage within the same PST Saturday before spring-forward counts correctly', () => {
    // Sat Mar 8 2025: 15:00 UTC = 7:00 AM PST (coverage opens). 18:00 UTC = 10:00 AM PST.
    // 15:00–18:00 UTC = 3 hours = 180 coverage min; no DST boundary crossed within this window.
    expect(coverageMinutesElapsed(
      new Date('2025-03-08T15:00:00Z'),
      new Date('2025-03-08T18:00:00Z'),
      LA_COVERAGE,
    )).toBe(180);
  });

  it('PDT spring forward: coverage spanning Saturday evening into spring-forward Sunday morning (cross-midnight)', () => {
    // Sat Mar 8 2025 21:00 UTC = Sat 13:00 PST (coverage open, 7–22).
    // Sat coverage closes at 22:00 PST = Mar 9 06:00 UTC.
    // Sun Mar 9 coverage starts at 07:00 PDT = 14:00 UTC. `to` = 14:00 UTC (start of Sun coverage).
    // Expected: Sat segment = 9h = 540 min; Sun segment = 0 min (to == coverage start).
    expect(coverageMinutesElapsed(
      new Date('2025-03-08T21:00:00Z'),
      new Date('2025-03-09T14:00:00Z'),
      LA_COVERAGE,
    )).toBe(540);
  });

  // Fall back 2025: Sun Nov 2, 2025 2:00 AM PDT → 1:00 AM PST (day is 25 hours).
  it('PST fall back: 60 minutes within the fall-back Sunday remain 60 coverage minutes', () => {
    // On Nov 2, fall-back happens at 09:00 UTC. At 15:00 UTC = 7:00 AM PST (after fall-back).
    expect(coverageMinutesElapsed(
      new Date('2025-11-02T15:00:00Z'),
      new Date('2025-11-02T16:00:00Z'),
      LA_COVERAGE,
    )).toBe(60);
  });

  it('PST fall back: coverage spanning Saturday evening into fall-back Sunday morning (cross-midnight)', () => {
    // Sat Nov 1 2025 21:00 UTC = 14:00 PDT (coverage open, 7–22).
    // Sat coverage closes at 22:00 PDT = Nov 2 05:00 UTC (fall-back not yet; PDT until 09:00 UTC Nov 2).
    // Sun Nov 2 coverage starts at 07:00 PST = Nov 2 15:00 UTC (after fall-back at 09:00 UTC).
    // `to` = 15:00 UTC (start of Sun coverage).
    // Expected: Sat segment = 8h = 480 min; Sun segment = 0 min.
    expect(coverageMinutesElapsed(
      new Date('2025-11-01T21:00:00Z'),
      new Date('2025-11-02T15:00:00Z'),
      LA_COVERAGE,
    )).toBe(480);
  });
});
