// No real database connection — all repository calls are served by the mock below.
// The rule's Knex implementation (KnexD02Repository) is never instantiated in these tests.
import { describe, expect, it, beforeEach } from '@jest/globals';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';
import type {
  D02Repository,
  D02DayResult,
  D02HourlyBucket,
} from '../../src/modules/detect/rules/d02-abandoned-call-threshold.rule';
import { evaluateAbandonedCallThreshold } from '../../src/modules/detect/rules/d02-abandoned-call-threshold.rule';

// ─── Env helpers ──────────────────────────────────────────────────────────────

// Reach into the env module to temporarily override D-02 config for each test.
// Tests restore original values in beforeEach to ensure isolation.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const envModule = require('../../src/config/env') as { env: Record<string, unknown> };

const D02_DEFAULTS = {
  DETECT_D02_ENABLED: false,
  DETECT_D02_DAILY_THRESHOLD: 0,
  DETECT_D02_TIMEZONE: 'America/Toronto',
  DETECT_D02_SYNC_BUFFER_HOURS: 2,
  SERVICETITAN_TENANT_ID: envModule.env['SERVICETITAN_TENANT_ID'] ?? 'test-tenant',
};

function setEnv(overrides: Partial<typeof D02_DEFAULTS>): void {
  Object.assign(envModule.env, { ...D02_DEFAULTS, ...overrides });
}

beforeEach(() => {
  setEnv({});
});

// ─── Test window ──────────────────────────────────────────────────────────────

// 7-day trailing window ending at a fixed future instant to avoid real-data interference
const WINDOW_END = new Date('2099-11-15T12:00:00.000Z');
const WINDOW: DetectionWindow = {
  periodStart: new Date('2099-11-08T12:00:00.000Z'),
  periodEnd: WINDOW_END,
  baselineStart: new Date('2099-10-11T12:00:00.000Z'),
  baselineEnd: new Date('2099-11-08T12:00:00.000Z'),
};

// ─── Mock repository factory ──────────────────────────────────────────────────

function makeRepo(
  days: D02DayResult[] = [],
  byHour: D02HourlyBucket[] = [],
): D02Repository {
  return {
    getDailyAbandonedCounts: async () => days,
    getHourlyBreakdown: async () => byHour,
  };
}

function dayResult(localDate: string, count: number): D02DayResult {
  // America/Toronto in November is EST (UTC-5).
  const startUtc = new Date(`${localDate}T05:00:00.000Z`); // midnight EST = 05:00 UTC
  const endUtc = new Date(startUtc.getTime() + 24 * 3_600_000);
  return { localDate, totalCount: count, dayStartUtc: startUtc, dayEndUtc: endUtc };
}

// ─── Kill-switch tests ────────────────────────────────────────────────────────

describe('D-02 — disabled by default', () => {
  it('returns [] when DETECT_D02_ENABLED is false', async () => {
    setEnv({ DETECT_D02_ENABLED: false, DETECT_D02_DAILY_THRESHOLD: 10 });
    const repo = makeRepo([dayResult('2099-11-10', 15)]);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });

  it('returns [] when DETECT_D02_DAILY_THRESHOLD is 0 (unconfigured)', async () => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 0 });
    const repo = makeRepo([dayResult('2099-11-10', 50)]);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });
});

// ─── Below / at / above threshold ────────────────────────────────────────────

describe('D-02 — threshold logic', () => {
  beforeEach(() => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 10 });
  });

  it('returns [] when no days exceed the threshold', async () => {
    // Repository returns empty (threshold not exceeded) — the rule passes threshold down to the repo
    const repo = makeRepo([], []);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });

  it('does NOT fire when the repository returns no days (count at-or-below threshold)', async () => {
    // The SQL layer uses HAVING COUNT(*) > ? — when count equals the threshold, the
    // repository returns []. The rule itself maps whatever the repository returns;
    // this test confirms the rule produces no findings when the repo returns empty.
    const repo = makeRepo([], []);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });

  it('fires a finding when count strictly exceeds the threshold', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 25)], [{ hour: 10, count: 25 }]);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metricValue).toBe(25);
  });
});

// ─── Threshold boundary — SQL contract ───────────────────────────────────────
// The SQL uses HAVING COUNT(*) > ? (strictly exceeds).
// These tests verify the rule passes the threshold value to the repo and maps
// results faithfully — the SQL boundary itself is enforced in the Knex layer.

describe('D-02 — threshold boundary', () => {
  beforeEach(() => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 10 });
  });

  it('passes the configured threshold value down to getDailyAbandonedCounts', async () => {
    let capturedThreshold: number | undefined;
    const repo: D02Repository = {
      getDailyAbandonedCounts: async (_ss, _tz, _from, _to, threshold) => {
        capturedThreshold = threshold;
        return [];
      },
      getHourlyBreakdown: async () => [],
    };
    await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(capturedThreshold).toBe(10);
  });

  it('fires when repo returns a day with count above threshold (SQL used > filter)', async () => {
    // Simulates: real repo returned this day because count 11 > threshold 10.
    const repo = makeRepo([dayResult('2099-11-10', 11)], [{ hour: 9, count: 11 }]);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.metricValue).toBe(11);
  });

  it('fires nothing when repo returns empty (count <= threshold filtered by SQL)', async () => {
    // Simulates: real repo returned [] because no day had count > threshold.
    const repo = makeRepo([], []);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });
});

// ─── Multiple days ────────────────────────────────────────────────────────────

describe('D-02 — multiple exceeding days', () => {
  beforeEach(() => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 5 });
  });

  it('fires one finding per exceeding local calendar day', async () => {
    const repo = makeRepo(
      [dayResult('2099-11-09', 8), dayResult('2099-11-10', 12)],
      [{ hour: 9, count: 4 }, { hour: 10, count: 4 }],
    );
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(2);
    expect(findings[0]!.dimension).toBe('2099-11-09');
    expect(findings[1]!.dimension).toBe('2099-11-10');
  });

  it('each finding has the correct day-scoped period_start and period_end', async () => {
    const d1 = dayResult('2099-11-09', 8);
    const d2 = dayResult('2099-11-10', 12);
    const repo = makeRepo([d1, d2], []);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);

    expect(findings[0]!.periodStart).toEqual(d1.dayStartUtc);
    expect(findings[0]!.periodEnd).toEqual(d1.dayEndUtc);
    expect(findings[1]!.periodStart).toEqual(d2.dayStartUtc);
    expect(findings[1]!.periodEnd).toEqual(d2.dayEndUtc);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('D-02 — idempotency keys', () => {
  beforeEach(() => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 5 });
  });

  it('produces the same (ruleCode, dimension, periodStart) on repeated calls with same data', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 15)], [{ hour: 9, count: 15 }]);
    const first = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    const second = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);

    expect(first[0]!.ruleCode).toBe('D-02');
    expect(second[0]!.ruleCode).toBe('D-02');
    expect(first[0]!.dimension).toBe(second[0]!.dimension);
    expect(first[0]!.periodStart).toEqual(second[0]!.periodStart);
    expect(first[0]!.metricValue).toBe(second[0]!.metricValue);
  });
});

// ─── Sync buffer / incomplete sync guard ─────────────────────────────────────

describe('D-02 — incomplete sync guard', () => {
  it('returns [] when the sync buffer pushes cutoff past the window start', async () => {
    setEnv({
      DETECT_D02_ENABLED: true,
      DETECT_D02_DAILY_THRESHOLD: 5,
      // Buffer larger than the window duration (7 days = 168h)
      DETECT_D02_SYNC_BUFFER_HOURS: 200,
    });
    const repo = makeRepo([dayResult('2099-11-10', 20)]);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toHaveLength(0);
  });

  it('passes the sync-buffered cutoff (not raw periodEnd) to the repository', async () => {
    setEnv({
      DETECT_D02_ENABLED: true,
      DETECT_D02_DAILY_THRESHOLD: 5,
      DETECT_D02_SYNC_BUFFER_HOURS: 2,
    });
    let capturedTo: Date | undefined;
    const repo: D02Repository = {
      getDailyAbandonedCounts: async (_ss, _tz, _from, to) => {
        capturedTo = to;
        return [];
      },
      getHourlyBreakdown: async () => [],
    };
    await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    // cutoff = periodEnd - 2h
    const expectedCutoff = new Date(WINDOW.periodEnd.getTime() - 2 * 3_600_000);
    expect(capturedTo).toEqual(expectedCutoff);
  });
});

// ─── Finding shape and privacy ────────────────────────────────────────────────

describe('D-02 — finding shape', () => {
  beforeEach(() => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 5, DETECT_D02_TIMEZONE: 'America/Toronto' });
  });

  it('sets ruleCode to D-02', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 8)], []);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(finding!.ruleCode).toBe('D-02');
  });

  it('sets dimension to local YYYY-MM-DD date', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 8)], []);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(finding!.dimension).toBe('2099-11-10');
  });

  it('sets baselineStart and baselineEnd to null (threshold-based, not trend-based)', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 8)], []);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(finding!.baselineStart).toBeNull();
    expect(finding!.baselineEnd).toBeNull();
  });

  it('includes byHour breakdown in details', async () => {
    const byHour = [{ hour: 9, count: 3 }, { hour: 10, count: 5 }];
    const repo = makeRepo([dayResult('2099-11-10', 8)], byHour);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(finding!.details['byHour']).toEqual(byHour);
  });

  it('includes timezone, threshold, and scope note in details', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 8)], []);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(finding!.details['timezone']).toBe('America/Toronto');
    expect(finding!.details['dailyThreshold']).toBe(5);
    expect(finding!.details['dataSource']).toBe('ServiceTitan:Telecom:Abandoned');
    expect(finding!.details['scopeNote']).toMatch(/Dialpad/);
  });

  it('does not include any sensitive PII in the finding', async () => {
    const repo = makeRepo([dayResult('2099-11-10', 8)], [{ hour: 9, count: 8 }]);
    const [finding] = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    const raw = JSON.stringify(finding);
    expect(raw).not.toMatch(/phone/i);
    expect(raw).not.toMatch(/recordingUrl/i);
    expect(raw).not.toMatch(/voiceMailUrl/i);
    expect(raw).not.toMatch(/customer.*name/i);
    expect(raw).not.toMatch(/payload/i);
  });
});

// ─── Timezone handling ────────────────────────────────────────────────────────

describe('D-02 — timezone', () => {
  it('passes the configured IANA timezone to the repository', async () => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 5, DETECT_D02_TIMEZONE: 'America/Vancouver' });
    let capturedTz: string | undefined;
    const repo: D02Repository = {
      getDailyAbandonedCounts: async (_ss, tz) => { capturedTz = tz; return []; },
      getHourlyBreakdown: async () => [],
    };
    await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(capturedTz).toBe('America/Vancouver');
  });

  it('passes the configured timezone to getHourlyBreakdown', async () => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 5, DETECT_D02_TIMEZONE: 'America/New_York' });
    let hourlyTz: string | undefined;
    const repo: D02Repository = {
      getDailyAbandonedCounts: async () => [dayResult('2099-11-10', 8)],
      getHourlyBreakdown: async (_ss, tz) => { hourlyTz = tz; return []; },
    };
    await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(hourlyTz).toBe('America/New_York');
  });
});

// ─── Source system ────────────────────────────────────────────────────────────

describe('D-02 — source system', () => {
  it('scopes queries to ServiceTitan:{TENANT_ID}', async () => {
    setEnv({
      DETECT_D02_ENABLED: true,
      DETECT_D02_DAILY_THRESHOLD: 5,
      SERVICETITAN_TENANT_ID: 'tenant-abc',
    });
    let capturedSourceSystem: string | undefined;
    const repo: D02Repository = {
      getDailyAbandonedCounts: async (ss) => { capturedSourceSystem = ss; return []; },
      getHourlyBreakdown: async () => [],
    };
    await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(capturedSourceSystem).toBe('ServiceTitan:tenant-abc');
  });
});

// ─── Empty results ────────────────────────────────────────────────────────────

describe('D-02 — no exceeding days', () => {
  it('returns empty array when repository returns no exceeding days', async () => {
    setEnv({ DETECT_D02_ENABLED: true, DETECT_D02_DAILY_THRESHOLD: 50 });
    const repo = makeRepo([], []);
    const findings = await evaluateAbandonedCallThreshold(WINDOW, undefined as never, repo);
    expect(findings).toEqual([]);
  });
});
