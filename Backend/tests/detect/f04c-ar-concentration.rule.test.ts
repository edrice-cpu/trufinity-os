import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateArConcentration } from '../../src/modules/detect/rules/f04c-ar-concentration.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// F-04c is a point-in-time snapshot check (see the rule file) - period
// start/end are stamped but not used as filter criteria, so any window works.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2095-06-08T00:00:00.000Z'),
  periodEnd: new Date('2095-06-15T00:00:00.000Z'),
  baselineStart: new Date('2095-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2095-06-08T00:00:00.000Z'),
};

async function invoiceRow(customerId: string, balance: number) {
  return db('unified_invoices').insert({ unified_customer_id: customerId, total_amount: balance, balance, invoice_date: new Date('2095-06-01') });
}

describe('evaluateArConcentration (F-04c)', () => {
  const customerNames = ['F-04c Whale', 'F-04c Small A', 'F-04c Small B', 'F-04c Small C', 'F-04c Small D'];
  const ids: Record<string, string> = {};

  const cleanup = async () => {
    const existing = await db('unified_customers').whereIn('name', customerNames).select('id');
    if (existing.length) await db('unified_invoices').whereIn('unified_customer_id', existing.map((r) => r.id)).delete();
    await db('unified_customers').whereIn('name', customerNames).delete();
  };

  beforeEach(async () => {
    await cleanup();
    for (const name of customerNames) {
      const [row] = await db('unified_customers').insert({ name }).returning('id');
      ids[name] = row.id as string;
    }
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags a customer whose outstanding balance exceeds the concentration threshold', async () => {
    // Whale: 8000 outstanding. Three small customers: 1000 each. Total = 11000.
    // Whale's share = 8000/11000 = ~72.7%, well above the default 25-point threshold.
    await invoiceRow(ids['F-04c Whale'], 8000);
    await invoiceRow(ids['F-04c Small A'], 1000);
    await invoiceRow(ids['F-04c Small B'], 1000);
    await invoiceRow(ids['F-04c Small C'], 1000);

    const findings = await evaluateArConcentration(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0].ruleCode).toBe('F-04c');
    expect(findings[0].dimension).toBe('QUICKBOOKS_TOTAL');
    expect(findings[0].metricValue).toBeCloseTo(8000 / 11000);
    expect((findings[0].details as { topCustomerId: string }).topCustomerId).toBe(ids['F-04c Whale']);
  });

  it('does not flag a reasonably distributed AR book', async () => {
    // 5 equal customers (20% each) - below the default 25-point threshold.
    await invoiceRow(ids['F-04c Whale'], 1000);
    await invoiceRow(ids['F-04c Small A'], 1000);
    await invoiceRow(ids['F-04c Small B'], 1000);
    await invoiceRow(ids['F-04c Small C'], 1000);
    await invoiceRow(ids['F-04c Small D'], 1000);

    const findings = await evaluateArConcentration(WINDOW);

    expect(findings).toEqual([]);
  });

  it('does not flag when total outstanding AR is below the minimum dollar floor', async () => {
    // Whale holds 100% of outstanding AR, but the total (500) is below the default $1000 floor.
    await invoiceRow(ids['F-04c Whale'], 500);

    const findings = await evaluateArConcentration(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no outstanding AR', async () => {
    const findings = await evaluateArConcentration(WINDOW);
    expect(findings).toEqual([]);
  });
});
