import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateCreditMemoSpike } from '../../src/modules/detect/rules/f04d-creditmemo-spike.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year isolated from other test files/dev data - see the same note
// in d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2094-06-08T00:00:00.000Z'),
  periodEnd: new Date('2094-06-15T00:00:00.000Z'),
  baselineStart: new Date('2094-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2094-06-08T00:00:00.000Z'),
};

async function creditMemoRow(txnDate: Date, totalAmt: number) {
  return db('raw_qbo_creditmemos').insert({
    source_id: randomUUID(),
    is_latest: true,
    payload: { TxnDate: txnDate.toISOString().slice(0, 10), TotalAmt: totalAmt },
  });
}

describe('evaluateCreditMemoSpike (F-04d)', () => {
  const cleanup = async () => {
    await db('raw_qbo_creditmemos').whereRaw("(payload->>'TxnDate')::date >= '2094-05-01'").andWhereRaw("(payload->>'TxnDate')::date < '2094-07-01'").delete();
  };

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags a credit-memo dollar spike that meets the threshold', async () => {
    const baselineDay = new Date('2094-05-20T00:00:00.000Z');
    const currentDay = new Date('2094-06-10T00:00:00.000Z');

    // Baseline (4-week total $400 -> weekly average $100). Current week: $300 - a 3x spike.
    await Promise.all([
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
    ]);
    await Promise.all([
      creditMemoRow(currentDay, 100),
      creditMemoRow(currentDay, 100),
      creditMemoRow(currentDay, 100),
    ]);

    const findings = await evaluateCreditMemoSpike(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'F-04d', dimension: 'QUICKBOOKS_TOTAL', metricValue: 300, baselineValue: 100 });
    expect((findings[0].details as { multiplier: number }).multiplier).toBeCloseTo(3);
  });

  it('does not flag a spike below the configured multiplier', async () => {
    const baselineDay = new Date('2094-05-20T00:00:00.000Z');
    const currentDay = new Date('2094-06-10T00:00:00.000Z');

    // Baseline weekly average $100. Current week: $150 - only 1.5x, below the default 2x threshold.
    await Promise.all([
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
      creditMemoRow(baselineDay, 100),
    ]);
    await Promise.all([
      creditMemoRow(currentDay, 50),
      creditMemoRow(currentDay, 50),
      creditMemoRow(currentDay, 50),
    ]);

    const findings = await evaluateCreditMemoSpike(WINDOW);

    expect(findings).toEqual([]);
  });

  it('does not flag when the current-window sample is below the minimum', async () => {
    const baselineDay = new Date('2094-05-20T00:00:00.000Z');
    const currentDay = new Date('2094-06-10T00:00:00.000Z');

    await Promise.all([creditMemoRow(baselineDay, 100), creditMemoRow(baselineDay, 100)]);
    // Only 2 credit memos in the current window - below the default minimum of 3, even though $ multiplier would qualify.
    await Promise.all([creditMemoRow(currentDay, 500), creditMemoRow(currentDay, 500)]);

    const findings = await evaluateCreditMemoSpike(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no baseline activity to compare against', async () => {
    const currentDay = new Date('2094-06-10T00:00:00.000Z');
    await Promise.all([creditMemoRow(currentDay, 100), creditMemoRow(currentDay, 100), creditMemoRow(currentDay, 100)]);

    const findings = await evaluateCreditMemoSpike(WINDOW);

    expect(findings).toEqual([]);
  });
});
