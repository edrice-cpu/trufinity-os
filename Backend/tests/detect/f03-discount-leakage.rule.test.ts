import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateDiscountLeakage } from '../../src/modules/detect/rules/f03-discount-leakage.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year isolated from other test files/dev data - see the same note
// in d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2096-06-08T00:00:00.000Z'),
  periodEnd: new Date('2096-06-15T00:00:00.000Z'),
  baselineStart: new Date('2096-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2096-06-08T00:00:00.000Z'),
};

let unifiedCustomerId: string;

// totalAmount is QBO's TotalAmt (already net of discount) - gross = totalAmount + discount.
async function invoiceRow(invoiceDate: Date, totalAmount: number, discount: number) {
  return db('unified_invoices').insert({ unified_customer_id: unifiedCustomerId, total_amount: totalAmount, discount, invoice_date: invoiceDate });
}

describe('evaluateDiscountLeakage (F-03)', () => {
  const cleanup = async () => {
    await db('unified_invoices').where('invoice_date', '>=', '2096-05-01').andWhere('invoice_date', '<', '2096-07-01').delete();
    await db('unified_customers').where('name', 'F-03 Test Customer').delete();
  };

  beforeEach(async () => {
    await cleanup();
    const [row] = await db('unified_customers').insert({ name: 'F-03 Test Customer' }).returning('id');
    unifiedCustomerId = row.id as string;
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags a discount-rate increase that meets the threshold', async () => {
    const baselineDay = new Date('2096-05-20T00:00:00.000Z');
    const currentDay = new Date('2096-06-10T00:00:00.000Z');

    // Baseline (5 invoices, gross 500 each = 2500 total): discount 25 each = 5% rate.
    await Promise.all(Array.from({ length: 5 }, () => invoiceRow(baselineDay, 475, 25)));
    // Current (5 invoices, gross 500 each = 2500 total): discount 100 each = 20% rate - a 15-point increase.
    await Promise.all(Array.from({ length: 5 }, () => invoiceRow(currentDay, 400, 100)));

    const findings = await evaluateDiscountLeakage(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'F-03', dimension: 'QUICKBOOKS_TOTAL', metricValue: 0.2, baselineValue: 0.05 });
  });

  it('does not flag a discount-rate increase below the configured threshold', async () => {
    const baselineDay = new Date('2096-05-20T00:00:00.000Z');
    const currentDay = new Date('2096-06-10T00:00:00.000Z');

    await Promise.all(Array.from({ length: 5 }, () => invoiceRow(baselineDay, 475, 25)));
    // 7% rate - only a 2-point increase, below the default 5-point threshold.
    await Promise.all(Array.from({ length: 5 }, () => invoiceRow(currentDay, 465, 35)));

    const findings = await evaluateDiscountLeakage(WINDOW);

    expect(findings).toEqual([]);
  });

  it('does not flag when the invoice sample is below the minimum', async () => {
    const baselineDay = new Date('2096-05-20T00:00:00.000Z');
    const currentDay = new Date('2096-06-10T00:00:00.000Z');

    // Only 3 invoices per cohort - below the default minimum of 5.
    await Promise.all(Array.from({ length: 3 }, () => invoiceRow(baselineDay, 475, 25)));
    await Promise.all(Array.from({ length: 3 }, () => invoiceRow(currentDay, 400, 100)));

    const findings = await evaluateDiscountLeakage(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no data in either window', async () => {
    const findings = await evaluateDiscountLeakage(WINDOW);
    expect(findings).toEqual([]);
  });
});
