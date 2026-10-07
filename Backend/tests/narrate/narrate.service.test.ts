import { describe, expect, it, beforeEach, afterAll, jest } from '@jest/globals';
import { db } from '../../src/database';
import {
  NarrateService,
  buildNarrationPayload,
  findUnverifiedNumbers,
  type DetectedAlertRow,
  type NarrationClient,
} from '../../src/modules/narrate/narrate.service';

// A year isolated from other test files and real dev data - matches the
// convention in tests/detect (Jest runs test files concurrently against the
// same shared dev database).
const PERIOD_START = new Date('2096-06-08T00:00:00.000Z');
const PERIOD_END = new Date('2096-06-15T00:00:00.000Z');

function insertAlert(overrides: Partial<Record<string, unknown>> = {}) {
  return db('detected_alerts').insert({
    rule_code: 'D-01',
    dimension: 'TENANT_TOTAL',
    period_start: PERIOD_START,
    period_end: PERIOD_END,
    baseline_start: new Date('2096-05-11T00:00:00.000Z'),
    baseline_end: PERIOD_START,
    metric_value: 0.5,
    baseline_value: 0.8,
    details: { dropPoints: 30 },
    ...overrides,
  }).returning('id');
}

function extractId(row: unknown): string {
  return typeof row === 'object' && row !== null && 'id' in row ? String((row as { id: unknown }).id) : String(row);
}

// File-level so it runs once, after every describe block below.
afterAll(async () => {
  await db('detected_alerts').where('period_start', '>=', '2096-01-01').andWhere('period_start', '<', '2097-01-01').delete();
  await db.destroy();
});

// NarrateService.run() defaults to narrating every pending alert in the
// table (production never scopes it) - but every call below passes an
// explicit `ids` filter so it can NEVER touch another test file's rows, or
// (if this process is ever accidentally pointed at a real database) any
// real alert. A prior version of this file called run() unscoped, relying
// only on this file's own year-bounded cleanup for isolation; that was the
// proximate cause of a real incident where an unscoped run() narrated live
// production alerts with this file's own mock text - see
// tests/db-isolation.guard.test.ts and the `ids` option on NarrateService.run().
describe('NarrateService', () => {
  beforeEach(async () => {
    // Bounded to this file's own year: other test files share this table concurrently.
    await db('detected_alerts').where('period_start', '>=', '2096-01-01').andWhere('period_start', '<', '2097-01-01').delete();
  });

  it('narrates an alert missing a narrative and persists the result', async () => {
    const [row] = await insertAlert();
    const id = extractId(row);
    const fakeClient: NarrationClient = { narrate: jest.fn<(alert: DetectedAlertRow) => Promise<string>>().mockResolvedValue('Booking rate dropped from 80% to 50%.') };

    await new NarrateService(fakeClient).run({ ids: [id] });

    const updated = await db('detected_alerts').where({ id }).first();
    expect(updated.narrative).toBe('Booking rate dropped from 80% to 50%.');
    expect(updated.narrated_at).not.toBeNull();
  });

  it('skips alerts that already have a narrative', async () => {
    const [row] = await insertAlert({ narrative: 'Already narrated.', narrated_at: new Date() });
    const id = extractId(row);
    const narrateMock = jest.fn<(alert: DetectedAlertRow) => Promise<string>>().mockResolvedValue('should not be called for this row');

    await new NarrateService({ narrate: narrateMock }).run({ ids: [id] });

    const unchanged = await db('detected_alerts').where({ id }).first();
    expect(unchanged.narrative).toBe('Already narrated.');
    expect(narrateMock).not.toHaveBeenCalled();
  });

  it('counts a failure without blocking other alerts, and leaves the failed row unnarrated', async () => {
    const [failingRow] = await insertAlert({ dimension: 'A' });
    const [okRow] = await insertAlert({ dimension: 'B', rule_code: 'D-06' });
    const failingId = extractId(failingRow);
    const okId = extractId(okRow);
    const narrateMock = jest.fn<(alert: DetectedAlertRow) => Promise<string>>()
      .mockImplementation(async (alert) => {
        if (alert.id === failingId) throw new Error('model error');
        return 'Objection category spiked.';
      });

    await new NarrateService({ narrate: narrateMock }).run({ ids: [failingId, okId] });

    const failedRow = await db('detected_alerts').where({ id: failingId }).first();
    expect(failedRow.narrative).toBeNull();
    const okRowAfter = await db('detected_alerts').where({ id: okId }).first();
    expect(okRowAfter.narrative).toBe('Objection category spiked.');
  });

  it('passes only the stored numbers to the narration client (no recomputation surface)', async () => {
    const [row] = await insertAlert({ metric_value: 0.42, baseline_value: 0.77, details: { dropPoints: 35 } });
    const id = extractId(row);
    let captured: DetectedAlertRow | undefined;
    const fakeClient: NarrationClient = {
      narrate: jest.fn<(alert: DetectedAlertRow) => Promise<string>>().mockImplementation(async (alert) => {
        if (alert.id === id) captured = alert;
        return 'narrated';
      }),
    };

    await new NarrateService(fakeClient).run({ ids: [id] });

    expect(captured?.details).toEqual({ dropPoints: 35 });
    expect(Number(captured?.metric_value)).toBeCloseTo(0.42);
    expect(Number(captured?.baseline_value)).toBeCloseTo(0.77);
  });

  it('blocks delivery (SPEC-BI-001 Section 9) when the model writes a number absent from the source payload', async () => {
    const [row] = await insertAlert();
    const id = extractId(row);
    // 99 does not appear anywhere in this row's payload (metric 50%, baseline 80%, dropPoints 30) - an invented figure.
    const fakeClient: NarrationClient = {
      narrate: jest.fn<(alert: DetectedAlertRow) => Promise<string>>().mockImplementation(async (alert) =>
        alert.id === id ? 'Booking rate dropped 99% this week.' : 'narrated',
      ),
    };

    await new NarrateService(fakeClient).run({ ids: [id] });

    const updated = await db('detected_alerts').where({ id }).first();
    expect(updated.narrative).toBeNull();
  });
});

describe('buildNarrationPayload', () => {
  it('pre-converts a percentage rule\'s fraction values to rounded percentages, so the model never does the conversion itself', () => {
    const alert = {
      id: 'a1',
      rule_code: 'D-01',
      dimension: 'TENANT_TOTAL',
      period_start: new Date('2096-06-15T00:00:00.000Z'),
      period_end: new Date('2096-06-22T00:00:00.000Z'),
      baseline_start: null,
      baseline_end: null,
      metric_value: '0.503',
      baseline_value: '0.8',
      details: {},
    } as unknown as DetectedAlertRow;

    const payload = buildNarrationPayload(alert);

    expect(payload).toMatchObject({ metricValuePercent: 50.3, baselineValuePercent: 80 });
    expect(payload).not.toHaveProperty('metricValue');
  });

  it('leaves a non-percentage rule\'s values as plain numbers', () => {
    const alert = {
      id: 'a2',
      rule_code: 'X-99',
      dimension: 'Value Concerns',
      period_start: new Date('2096-06-15T00:00:00.000Z'),
      period_end: new Date('2096-06-22T00:00:00.000Z'),
      baseline_start: null,
      baseline_end: null,
      metric_value: '4',
      baseline_value: '1',
      details: {},
    } as unknown as DetectedAlertRow;

    const payload = buildNarrationPayload(alert);

    expect(payload).toMatchObject({ metricValue: 4, baselineValue: 1 });
    expect(payload).not.toHaveProperty('metricValuePercent');
  });
});

describe('findUnverifiedNumbers', () => {
  it('returns an empty list when every number in the narrative appears in the payload', () => {
    const payload = { metricValuePercent: 50, baselineValuePercent: 80, details: { dropPoints: 30 } };
    const narrative = 'Booking rate dropped from 80% to 50%, a 30-point decline.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([]);
  });

  it('flags a number that does not appear anywhere in the payload', () => {
    const payload = { metricValuePercent: 50, baselineValuePercent: 80, details: { dropPoints: 30 } };
    const narrative = 'Booking rate dropped from 80% to 50%, a 42-point decline.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([42]);
  });

  it('does not flag date components (day/month/year) mentioned in prose', () => {
    const payload = {
      periodStart: new Date('2096-06-15T00:00:00.000Z'),
      periodEnd: new Date('2096-06-22T00:00:00.000Z'),
      metricValuePercent: 50,
    };
    const narrative = 'For the week of June 15 to June 22, 2096, the rate was 50%.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([]);
  });

  it('tolerates minor floating-point/rounding noise without flagging it', () => {
    const payload = { metricValuePercent: 50.3 };
    const narrative = 'The rate was 50.32%.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([]);
  });

  it('does not flag a number embedded in a descriptive string field (e.g. ruleDescription) that the model echoes back', () => {
    // Reproduces a real failure: ruleDescription says "...trailing 4-week
    // average" - "4" was invisible to the validator (only the whole-string
    // value was checked as one number, never its embedded digits), so a
    // model that wrote "4-week" instead of "four-week" was wrongly rejected.
    const payload = {
      ruleDescription: 'Tenant-wide call booking rate has declined compared to the trailing 4-week average.',
      metricValuePercent: 50,
      baselineValuePercent: 80,
    };
    const narrative = 'Booking rate fell to 50%, down from the trailing 4-week average of 80%.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([]);
  });

  it('reads a thousands-grouped number whole instead of splitting it on the comma', () => {
    // Reproduces a real failure: D-06's baselineTotalUnbooked = 1091 rendered
    // as "1,091" in the narrative. The old number regex matched "1" and "91"
    // as two separate numbers - neither exists in the payload, so a valid
    // narrative was wrongly rejected every day Detect wrote a new row.
    const payload = { currentCount: 3, baselineCount: 4, currentTotalUnbooked: 195, baselineTotalUnbooked: 1091 };
    const narrative = 'That is 3 mentions out of 195 calls, versus 4 out of 1,091 in the baseline.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([]);
  });

  it('still flags a thousands-grouped number that does not appear in the payload', () => {
    const payload = { baselineTotalUnbooked: 1091 };
    const narrative = 'Out of 2,500 calls.';

    expect(findUnverifiedNumbers(narrative, payload)).toEqual([2500]);
  });
});
