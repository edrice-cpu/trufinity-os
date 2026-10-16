/**
 * Worker integration tests for R-02 rule wiring.
 *
 * All tests use mocked dependencies — no real database, no Gmail API.
 * Covers buildEvaluationCycle, feature flag combinations, and lifecycle.
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  buildEvaluationCycle,
  computeEvalIntervalMs,
  startGoogleResponsivenessWorker,
  type EvaluationCycleOptions,
  type MailboxLoader,
  type ResponsivenessWorkerDependencies,
} from '../../src/workers/google-responsiveness.worker';
import { GoogleResponsivenessScheduler } from '../../src/modules/google/responsiveness.scheduler';
import type { R01Config, R01Rule } from '../../src/modules/google/responsiveness-rule-r01';
import type { R02Config, R02Rule, R02EvalResult } from '../../src/modules/google/responsiveness-rule-r02';
import type { R03Config, R03Rule, R03EvalResult } from '../../src/modules/google/responsiveness-rule-r03';
import type { R04Config, R04Rule, R04EvalResult } from '../../src/modules/google/responsiveness-rule-r04';
import type { BusinessCalendarConfig } from '../../src/modules/google/business-calendar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UTC_CAL: BusinessCalendarConfig = { timezone: 'UTC', startHour: 8, endHour: 16, endMinute: 30 };

const UTC_COVERAGE = {
  timezone: 'UTC',
  rules: [
    { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 22 },
    { weekdays: [0, 6],           startHour: 7, endHour: 22 },
  ],
};

const BASE_R01_CONFIG: R01Config = {
  businessCalendar: UTC_CAL,
  thresholdMinutes: 240,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
  emergencyClassificationEnabled: false,
  emergencyThresholdMinutes: 25,
  emergencyConfidenceThreshold: 0.9,
  emergencyTrustedPromptVersions: ['v2'],
};

const BASE_R02_CONFIG: R02Config = {
  businessCalendar: UTC_CAL,
  coverageCalendar: UTC_COVERAGE,
  inactivityThresholdMinutes: 1440,
  inactivityPolicy: 'ELAPSED',
  conditionAEnabled: true,
  messageCountThreshold: 3,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

const R02_A_DISABLED: R02Config = { ...BASE_R02_CONFIG, conditionAEnabled: false };

const BASE_R03_CONFIG: R03Config = {
  businessCalendar: UTC_CAL,
  defaultThresholdMinutes: 510,
  mailboxThresholds: { 'service@trufinity.ca': 240, 'support@trufinity.ca': 240 },
  excludedMailboxes: ['billing@trufinity.ca', 'careers@trufinity.ca', 'info@trufinity.ca'],
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

const ZERO_R03_RESULT: R03EvalResult = {
  threadsEvaluated: 0,
  repliesMeasured: 0,
  lateRepliesFound: 0,
  onTimeRepliesFound: 0,
};

const BASE_R04_CONFIG: R04Config = {
  businessCalendar: UTC_CAL,
  afterHoursWindows: [
    { weekdays: [1, 2, 3, 4, 5], startHour: 16, startMinute: 30, endHour: 22, endMinute: 0 },
    { weekdays: [0, 6], startHour: 7, startMinute: 0, endHour: 22, endMinute: 0 },
  ],
  graceMinutes: 60,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

const ZERO_R04_RESULT: R04EvalResult = {
  threadsEvaluated: 0,
  alertsOpened: 0,
  alertsClosed: 0,
};

const MAILBOXES = ['support@trufinity.ca', 'service@trufinity.ca'];

const ZERO_R02_RESULT: R02EvalResult = {
  threadsEvaluated: 0,
  conditionAFired: 0, conditionAClosed: 0,
  conditionBFired: 0, conditionBClosed: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;
const mockResolved = <T>(v: T): jest.Mock => {
  const m = jest.fn();
  (m as unknown as { mockResolvedValue(v: unknown): void }).mockResolvedValue(v);
  return m as jest.Mock;
};
const mockRejected = (e: Error): jest.Mock => {
  const m = jest.fn();
  (m as unknown as { mockRejectedValue(e: unknown): void }).mockRejectedValue(e);
  return m as jest.Mock;
};

// Mock R01Rule
const makeR01Rule = (spy?: jest.Mock): R01Rule => ({
  evaluateMailbox: (spy ?? mockResolved(undefined)) as unknown as AnyFn as R01Rule['evaluateMailbox'],
});

// Mock R02Rule
const makeR02Rule = (result: R02EvalResult = ZERO_R02_RESULT, spy?: jest.Mock): R02Rule => ({
  evaluateMailbox: (spy ?? mockResolved(result)) as unknown as AnyFn as R02Rule['evaluateMailbox'],
});

// Mock R03Rule
const makeR03Rule = (result: R03EvalResult = ZERO_R03_RESULT, spy?: jest.Mock): R03Rule => ({
  evaluateMailbox: (spy ?? mockResolved(result)) as unknown as AnyFn as R03Rule['evaluateMailbox'],
});

// Mock R04Rule
const makeR04Rule = (result: R04EvalResult = ZERO_R04_RESULT, spy?: jest.Mock): R04Rule => ({
  evaluateMailbox: (spy ?? mockResolved(result)) as unknown as AnyFn as R04Rule['evaluateMailbox'],
});

// Fake database — returns empty counts for the R-01 before/after query pattern.
const makeDb = (): Parameters<typeof buildEvaluationCycle>[2] => {
  const callable = (_table: string) => {
    const q: Record<string, unknown> = {};
    q['where'] = () => q;
    q['count'] = () => q;
    q['first'] = () => Promise.resolve({ count: '0' });
    q['select'] = (..._cols: unknown[]) => q;
    return q;
  };
  return callable as unknown as Parameters<typeof buildEvaluationCycle>[2];
};

// Standard logger mock.
const makeLogger = () => {
  const calls: string[] = [];
  return {
    calls,
    info: (m: string) => { calls.push(`info:${m}`); },
    warn: (m: string) => { calls.push(`warn:${m}`); },
    error: (m: string) => { calls.push(`error:${m}`); },
  };
};

// Mailbox loaders.
const twoMailboxLoader: MailboxLoader = () => Promise.resolve(MAILBOXES);
const emptyMailboxLoader: MailboxLoader = () => Promise.resolve([]);

// ---------------------------------------------------------------------------
// Helper: build standard cycle opts
// ---------------------------------------------------------------------------

const makeCycleOpts = (overrides: Partial<EvaluationCycleOptions> = {}): EvaluationCycleOptions => ({
  r01Enabled: true,
  r01Rule: makeR01Rule(),
  r01Config: BASE_R01_CONFIG,
  r02Enabled: true,
  r02Rule: makeR02Rule(),
  r02Config: BASE_R02_CONFIG,
  r03Enabled: false,
  r03Rule: makeR03Rule(),
  r03Config: BASE_R03_CONFIG,
  r04Enabled: false,
  r04Rule: makeR04Rule(),
  r04Config: BASE_R04_CONFIG,
  logger: makeLogger(),
  ...overrides,
});

// Minimal worker dependencies for startGoogleResponsivenessWorker tests.
const makeWorkerDeps = (
  overrides: Partial<ResponsivenessWorkerDependencies> = {},
): ResponsivenessWorkerDependencies => ({
  database: {
    raw: () => Promise.resolve({}),
    destroy: () => Promise.resolve(undefined),
  } as unknown as ResponsivenessWorkerDependencies['database'],
  config: { enabled: true, evalIntervalMs: 900_000 },
  runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
  logger: makeLogger(),
  createScheduler: () => ({ start: () => undefined, stop: () => Promise.resolve() }),
  registerShutdown: () => () => undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. R-02 disabled — no execution
// ---------------------------------------------------------------------------

describe('1. R-02 disabled — no R-02 evaluation', () => {
  it('r02Enabled=false: r02Rule.evaluateMailbox is never called', async () => {
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({ r02Enabled: false, r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r02Spy).not.toHaveBeenCalled();
  });

  it('r02Enabled=false: r01Rule still runs normally', async () => {
    const r01Spy = mockResolved(undefined);
    const opts = makeCycleOpts({ r02Enabled: false, r01Rule: makeR01Rule(r01Spy) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r01Spy).toHaveBeenCalledTimes(MAILBOXES.length);
  });
});

// ---------------------------------------------------------------------------
// 2. R-02 enabled — expected rule invocation
// ---------------------------------------------------------------------------

describe('2. R-02 enabled — evaluateMailbox called for each mailbox', () => {
  it('called once per active mailbox', async () => {
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({ r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r02Spy).toHaveBeenCalledTimes(MAILBOXES.length);
  });

  it('correct config is passed to R-02 evaluateMailbox', async () => {
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({ r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r02Spy).toHaveBeenCalledWith(MAILBOXES[0], BASE_R02_CONFIG);
  });
});

// ---------------------------------------------------------------------------
// 3. Condition A disabled — flagged via r02Config.conditionAEnabled
// ---------------------------------------------------------------------------

describe('3. Condition A disabled in config', () => {
  it('r02Rule.evaluateMailbox still called when r02Enabled=true but conditionAEnabled=false', async () => {
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({
      r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
      r02Config: R02_A_DISABLED,
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r02Spy).toHaveBeenCalledWith(MAILBOXES[0], R02_A_DISABLED);
  });
});

// ---------------------------------------------------------------------------
// 4. Condition B enabled — excessive-exchange alerts counted
// ---------------------------------------------------------------------------

describe('4. Condition B fires — alert counts returned', () => {
  it('conditionBFired increments alertsOpened', async () => {
    const r02Result: R02EvalResult = { ...ZERO_R02_RESULT, conditionBFired: 2 };
    const opts = makeCycleOpts({ r01Enabled: false, r02Rule: makeR02Rule(r02Result) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    const result = await cycle();
    expect(result.alertsOpened).toBe(4); // 2 × 2 mailboxes
  });

  it('conditionBClosed increments alertsClosed', async () => {
    const r02Result: R02EvalResult = { ...ZERO_R02_RESULT, conditionBClosed: 1 };
    const opts = makeCycleOpts({ r01Enabled: false, r02Rule: makeR02Rule(r02Result) });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    const result = await cycle();
    expect(result.alertsClosed).toBe(2); // 1 × 2 mailboxes
  });
});

// ---------------------------------------------------------------------------
// 5. Both conditions disabled — no R-02 alert activity
// ---------------------------------------------------------------------------

describe('5. Both Condition A and B produce no alerts', () => {
  it('r02 returns all-zero result → alertsOpened and alertsClosed unchanged from R-01', async () => {
    const opts = makeCycleOpts({
      r01Enabled: false,
      r02Rule: makeR02Rule(ZERO_R02_RESULT),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    const result = await cycle();
    expect(result.alertsOpened).toBe(0);
    expect(result.alertsClosed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. R-01 enabled / R-02 disabled
// ---------------------------------------------------------------------------

describe('6. R-01 enabled, R-02 disabled', () => {
  it('R-01 evaluates; R-02 does not', async () => {
    const r01Spy = mockResolved(undefined);
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({
      r01Enabled: true, r01Rule: makeR01Rule(r01Spy),
      r02Enabled: false, r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r01Spy).toHaveBeenCalledTimes(MAILBOXES.length);
    expect(r02Spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. R-01 disabled / R-02 enabled
// ---------------------------------------------------------------------------

describe('7. R-01 disabled, R-02 enabled', () => {
  it('R-02 evaluates; R-01 does not', async () => {
    const r01Spy = mockResolved(undefined);
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({
      r01Enabled: false, r01Rule: makeR01Rule(r01Spy),
      r02Enabled: true, r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r01Spy).not.toHaveBeenCalled();
    expect(r02Spy).toHaveBeenCalledTimes(MAILBOXES.length);
  });
});

// ---------------------------------------------------------------------------
// 8. Both rules enabled
// ---------------------------------------------------------------------------

describe('8. Both R-01 and R-02 enabled', () => {
  it('both rules evaluate for every mailbox', async () => {
    const r01Spy = mockResolved(undefined);
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({
      r01Rule: makeR01Rule(r01Spy),
      r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r01Spy).toHaveBeenCalledTimes(MAILBOXES.length);
    expect(r02Spy).toHaveBeenCalledTimes(MAILBOXES.length);
  });

  it('alert counts from both rules are summed', async () => {
    const r02Result: R02EvalResult = { ...ZERO_R02_RESULT, conditionAFired: 1, conditionBFired: 1 };
    const opts = makeCycleOpts({
      r01Enabled: false, // exclude R-01 count noise from fake DB
      r02Rule: makeR02Rule(r02Result),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    const result = await cycle();
    // (conditionAFired=1 + conditionBFired=1) × 2 mailboxes = 4 alertsOpened
    expect(result.alertsOpened).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 9. Concurrent scheduler ticks — single-cycle guard
// ---------------------------------------------------------------------------

describe('9. Concurrent scheduler ticks — overlap prevention', () => {
  it('runCycle() deduplicates concurrent calls to the same cycle promise', async () => {
    let resolveEval!: () => void;
    const slowEval = (): Promise<{ alertsOpened: number; alertsClosed: number }> =>
      new Promise((resolve) => { resolveEval = () => resolve({ alertsOpened: 0, alertsClosed: 0 }); });

    const scheduler = new GoogleResponsivenessScheduler({
      runEvaluation: slowEval,
      intervalMs: 300_000,
      logger: makeLogger(),
    });

    // Two concurrent runCycle() calls must return the same promise.
    const p1 = scheduler.runCycle();
    const p2 = scheduler.runCycle();
    expect(p1).toBe(p2);
    resolveEval();
    await Promise.all([p1, p2]);
    await scheduler.stop();
  });
});

// ---------------------------------------------------------------------------
// 10. R-02 execution failure — isolated, does not affect R-01
// ---------------------------------------------------------------------------

describe('10. R-02 execution failure — isolation', () => {
  it('R-02 throws → warn logged, R-01 still completes, cycle returns', async () => {
    const r01Spy = mockResolved(undefined);
    const r02Spy = mockRejected(new Error('R02 boom'));
    const logger = makeLogger();
    const opts = makeCycleOpts({
      r01Rule: makeR01Rule(r01Spy),
      r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
      logger,
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    const result = await cycle();
    expect(result).toBeDefined();
    expect(r01Spy).toHaveBeenCalledTimes(MAILBOXES.length);
    const warns = logger.calls.filter((c) => c.startsWith('warn:[R02]'));
    expect(warns.length).toBe(MAILBOXES.length);
    for (const w of warns) {
      expect(w).not.toMatch(/body|snippet|subject|html/i);
    }
  });

  it('R-01 throws → R-02 still runs for all mailboxes', async () => {
    const r01Spy = mockRejected(new Error('R01 boom'));
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({
      r01Rule: makeR01Rule(r01Spy),
      r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy),
    });
    const cycle = buildEvaluationCycle(twoMailboxLoader, opts, makeDb());
    await cycle();
    expect(r02Spy).toHaveBeenCalledTimes(MAILBOXES.length);
  });
});

// ---------------------------------------------------------------------------
// 11. Graceful shutdown — reuses existing startGoogleResponsivenessWorker tests
// ---------------------------------------------------------------------------

describe('11. Graceful shutdown', () => {
  it('worker starts and shuts down cleanly', async () => {
    let started = 0; let stopped = 0;
    const handle = await startGoogleResponsivenessWorker(makeWorkerDeps({
      createScheduler: () => ({
        start: () => { started++; },
        stop: () => { stopped++; return Promise.resolve(); },
      }),
    }));
    expect(started).toBe(1);
    await handle.shutdown();
    expect(stopped).toBe(1);
  });

  it('database.destroy() is called on shutdown', async () => {
    let destroyCount = 0;
    const handle = await startGoogleResponsivenessWorker(makeWorkerDeps({
      database: {
        raw: () => Promise.resolve({}),
        destroy: () => { destroyCount++; return Promise.resolve(undefined); },
      } as unknown as ResponsivenessWorkerDependencies['database'],
    }));
    await handle.shutdown();
    expect(destroyCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12. No duplicate scheduling — single scheduler instance
// ---------------------------------------------------------------------------

describe('12. No duplicate scheduling', () => {
  it('buildEvaluationCycle returns a plain function', () => {
    const cycle = buildEvaluationCycle(emptyMailboxLoader, makeCycleOpts(), makeDb());
    expect(typeof cycle).toBe('function');
  });

  it('startGoogleResponsivenessWorker calls createScheduler exactly once', async () => {
    let createCount = 0;
    const handle = await startGoogleResponsivenessWorker(makeWorkerDeps({
      createScheduler: () => {
        createCount++;
        return { start: () => undefined, stop: () => Promise.resolve() };
      },
    }));
    expect(createCount).toBe(1);
    await handle.shutdown();
  });
});

// ---------------------------------------------------------------------------
// 13. No production DB or live Gmail access
// ---------------------------------------------------------------------------

describe('13. No production DB or live Gmail access', () => {
  it('worker source does not reference Gmail API clients', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const workerSource = fs.readFileSync(path.resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'), 'utf8') as string;
    expect(workerSource).not.toContain('googleapis');
    expect(workerSource).not.toContain('google.auth');
    expect(workerSource).not.toContain('GmailHistoricalService');
    expect(workerSource).not.toContain('GmailIncrementalService');
  });

  it('R-02 feature flags default to disabled in env.ts', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const envSource = fs.readFileSync(path.resolve(__dirname, '../../src/config/env.ts'), 'utf8') as string;
    expect(envSource).toMatch(/GOOGLE_R02_ENABLED[\s\S]{0,200}default\('false'\)/);
    expect(envSource).toMatch(/GOOGLE_R02_CONDITION_A_ENABLED[\s\S]{0,200}default\('false'\)/);
  });

  it('empty mailbox list → no rule evaluations', async () => {
    const r01Spy = mockResolved(undefined);
    const r02Spy = mockResolved(ZERO_R02_RESULT);
    const opts = makeCycleOpts({ r01Rule: makeR01Rule(r01Spy), r02Rule: makeR02Rule(ZERO_R02_RESULT, r02Spy) });
    const cycle = buildEvaluationCycle(emptyMailboxLoader, opts, makeDb());
    const result = await cycle();
    expect(r01Spy).not.toHaveBeenCalled();
    expect(r02Spy).not.toHaveBeenCalled();
    expect(result.alertsOpened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. F-04 regression — computeEvalIntervalMs selects minimum across enabled rules
// ---------------------------------------------------------------------------

describe('14. F-04 regression — computeEvalIntervalMs', () => {
  const MS = 60_000; // shorthand for 1 minute

  it('only R-01 enabled → returns R-01 interval', () => {
    expect(computeEvalIntervalMs(
      true, 900 * MS,
      false, 600 * MS,
      false, 300 * MS,
      false, 450 * MS,
      900 * MS,
    )).toBe(900 * MS);
  });

  it('only R-04 enabled → returns R-04 interval', () => {
    expect(computeEvalIntervalMs(
      false, 900 * MS,
      false, 900 * MS,
      false, 900 * MS,
      true, 450 * MS,
      900 * MS,
    )).toBe(450 * MS);
  });

  it('R-01 (15 min) and R-04 (5 min) both enabled → returns the shorter R-04 interval', () => {
    expect(computeEvalIntervalMs(
      true, 900 * MS,   // 15 min
      false, 900 * MS,
      false, 900 * MS,
      true, 300 * MS,   // 5 min
      900 * MS,
    )).toBe(300 * MS);
  });

  it('all four rules enabled with different intervals → returns the minimum', () => {
    expect(computeEvalIntervalMs(
      true, 900 * MS,
      true, 600 * MS,
      true, 300 * MS,   // shortest
      true, 450 * MS,
      900 * MS,
    )).toBe(300 * MS);
  });

  it('all rules disabled → returns the fallback', () => {
    expect(computeEvalIntervalMs(
      false, 900 * MS,
      false, 600 * MS,
      false, 300 * MS,
      false, 450 * MS,
      900 * MS,
    )).toBe(900 * MS);
  });

  it('R-01 and R-02 with same interval → returns that interval', () => {
    expect(computeEvalIntervalMs(
      true, 900 * MS,
      true, 900 * MS,
      false, 600 * MS,
      false, 600 * MS,
      900 * MS,
    )).toBe(900 * MS);
  });

  it('worker source uses computeEvalIntervalMs instead of a cascade', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(source).toContain('computeEvalIntervalMs(');
    // The old first-enabled cascade must be gone.
    expect(source).not.toContain('GOOGLE_R01_EVAL_INTERVAL_MS\n      : env.GOOGLE_R02_ENABLED');
  });
});
