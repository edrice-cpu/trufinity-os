import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateRevenueReconciliationGap } from '../../src/modules/detect/rules/f05-revenue-reconciliation-gap.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// F-05 is a point-in-time check on the current window only - no baseline
// window is used (see the rule file), so baselineStart/End here are unused.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2093-06-08T00:00:00.000Z'),
  periodEnd: new Date('2093-06-15T00:00:00.000Z'),
  baselineStart: new Date('2093-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2093-06-08T00:00:00.000Z'),
};

let unifiedCustomerId: string;

async function qboInvoiceRow(invoiceDate: Date, totalAmount: number) {
  return db('unified_invoices').insert({ unified_customer_id: unifiedCustomerId, total_amount: totalAmount, invoice_date: invoiceDate });
}

async function stInvoiceRow(invoiceDate: Date, total: number) {
  return db('raw_st_invoices').insert({
    source_id: randomUUID(),
    is_latest: true,
    payload: { invoiceDate: invoiceDate.toISOString().slice(0, 10), total },
  });
}

describe('evaluateRevenueReconciliationGap (F-05)', () => {
  const cleanup = async () => {
    await db('unified_invoices').where('invoice_date', '>=', '2093-05-01').andWhere('invoice_date', '<', '2093-07-01').delete();
    await db('raw_st_invoices').whereRaw("(payload->>'invoiceDate')::date >= '2093-05-01'").andWhereRaw("(payload->>'invoiceDate')::date < '2093-07-01'").delete();
    await db('unified_customers').where('name', 'F-05 Test Customer').delete();
  };

  beforeEach(async () => {
    await cleanup();
    const [row] = await db('unified_customers').insert({ name: 'F-05 Test Customer' }).returning('id');
    unifiedCustomerId = row.id as string;
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags a revenue gap between ServiceTitan and QuickBooks that meets the threshold', async () => {
    const day = new Date('2093-06-10T00:00:00.000Z');
    // ServiceTitan recorded $10,000; QuickBooks only shows $8,000 - a 20% gap.
    await stInvoiceRow(day, 10000);
    await qboInvoiceRow(day, 8000);

    const findings = await evaluateRevenueReconciliationGap(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'F-05', dimension: 'TENANT_TOTAL', baselineValue: null });
    expect(findings[0].metricValue).toBeCloseTo(0.2);
    expect((findings[0].details as { gapAmount: number }).gapAmount).toBeCloseTo(2000);
  });

  it('does not flag a gap below the configured threshold', async () => {
    const day = new Date('2093-06-10T00:00:00.000Z');
    // Only a 5% gap, below the default 10-point threshold.
    await stInvoiceRow(day, 10000);
    await qboInvoiceRow(day, 9500);

    const findings = await evaluateRevenueReconciliationGap(WINDOW);

    expect(findings).toEqual([]);
  });

  it('does not flag when ServiceTitan revenue is below the minimum floor', async () => {
    const day = new Date('2093-06-10T00:00:00.000Z');
    // 100% gap, but total ServiceTitan revenue (500) is below the default $1000 floor.
    await stInvoiceRow(day, 500);

    const findings = await evaluateRevenueReconciliationGap(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no invoice data in the window', async () => {
    const findings = await evaluateRevenueReconciliationGap(WINDOW);
    expect(findings).toEqual([]);
  });
});
