import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateJobHeldOpen } from '../../src/modules/detect/rules/o06-job-held-open.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// O-06 is evaluated as of periodEnd (see the rule file).
// Sentinel year not used by other test files/dev data - see d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2088-06-08T00:00:00.000Z'),
  periodEnd: new Date('2088-06-15T00:00:00.000Z'),
  baselineStart: new Date('2088-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2088-06-08T00:00:00.000Z'),
};
const PREFIX = 'o06-test-';

async function job(number: string, completedOn: string | null, extra: Record<string, unknown> = {}) {
  await db('raw_st_jobs').insert({
    source_id: `${PREFIX}job-${number}`,
    is_latest: true,
    payload: { jobNumber: number, jobStatus: 'Completed', completedOn, total: 750, invoiceId: `${PREFIX}inv-${number}`, ...extra },
  });
}

async function invoice(number: string, syncStatus: string) {
  await db('raw_st_invoices').insert({ source_id: `${PREFIX}inv-${number}`, is_latest: true, payload: { syncStatus } });
}

describe('evaluateJobHeldOpen (O-06)', () => {
  const cleanup = async () => {
    await db('raw_st_jobs').where('source_id', 'like', `${PREFIX}%`).delete();
    await db('raw_st_invoices').where('source_id', 'like', `${PREFIX}%`).delete();
  };

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags each completed job whose invoice is still pending or missing after the threshold', async () => {
    // Flagged: completed 10 days ago, invoice still Pending.
    await job('1001', '2088-06-05T00:00:00.000Z');
    await invoice('1001', 'Pending');
    // Flagged: completed 5 days ago, invoice never ingested.
    await job('1002', '2088-06-10T00:00:00.000Z');
    // Not flagged: invoice exported / posted.
    await job('1003', '2088-06-05T00:00:00.000Z');
    await invoice('1003', 'Exported');
    await job('1004', '2088-06-05T00:00:00.000Z');
    await invoice('1004', 'Posted');
    // Not flagged: completed 1 day ago - inside the default 3-day threshold.
    await job('1005', '2088-06-14T00:00:00.000Z');
    // Not flagged: no-charge job, still in progress, or completed before the 90-day lookback.
    await job('1006', '2088-06-05T00:00:00.000Z', { noCharge: true });
    await job('1007', null, { jobStatus: 'InProgress' });
    await job('1008', '2088-01-01T00:00:00.000Z');

    const findings = await evaluateJobHeldOpen(WINDOW);

    expect(findings.map((f) => f.dimension)).toEqual(['Job #1001', 'Job #1002']);
    expect(findings[0]).toMatchObject({
      ruleCode: 'O-06',
      periodStart: new Date('2088-06-05T00:00:00.000Z'),
      metricValue: 750,
      baselineValue: null,
    });
    expect(findings[0].details).toMatchObject({ jobNumber: '1001', invoiceStatus: 'Pending', thresholdDays: 3 });
    expect(findings[1].details).toMatchObject({ invoiceStatus: 'NOT_INGESTED' });
  });

  it('keeps period_start stable across runs so the same job updates one alert', async () => {
    await job('2001', '2088-06-05T00:00:00.000Z');
    const first = await evaluateJobHeldOpen(WINDOW);
    const nextDay = await evaluateJobHeldOpen({ ...WINDOW, periodEnd: new Date('2088-06-16T00:00:00.000Z') });

    expect(first[0].periodStart).toEqual(nextDay[0].periodStart);
    expect(first[0].dimension).toEqual(nextDay[0].dimension);
  });
});
