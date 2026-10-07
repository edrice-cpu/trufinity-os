import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateArAgingSpike } from '../../src/modules/detect/rules/f04-ar-aging-spike.rule';
import type { DetectedAlertFinding, DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year not used by other test files/dev data - see the same note in
// d01-booking-rate-decline.rule.test.ts for why this matters under parallel
// Jest workers sharing one database.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2098-06-08T00:00:00.000Z'),
  periodEnd: new Date('2098-06-15T00:00:00.000Z'),
  baselineStart: new Date('2098-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2098-06-08T00:00:00.000Z'),
};

let unifiedCustomerId: string;

async function qboInvoice(invoiceDate: string, totalAmount: number, balance: number, dueDate: string | null) {
  const [row] = await db('unified_invoices')
    .insert({ unified_customer_id: unifiedCustomerId, total_amount: totalAmount, balance, invoice_date: invoiceDate, due_date: dueDate })
    .returning('id');
  return row.id as string;
}

async function stInvoice(invoiceDate: string, dueDate: string, balance: number) {
  await db('raw_st_invoices').insert({
    source_id: randomUUID(),
    is_latest: true,
    payload: { invoiceDate, dueDate, balance, total: balance, referenceNumber: 'ST-1', customer: { id: 1, name: 'ST Customer' } },
  });
}

function byTrigger(findings: DetectedAlertFinding[], trigger: string) {
  return findings.filter((f) => (f.details as { trigger: string }).trigger === trigger);
}

describe('evaluateArAgingSpike (F-04)', () => {
  const cleanup = async () => {
    const invoices = await db('unified_invoices').where('invoice_date', '>=', '2098-01-01').andWhere('invoice_date', '<', '2099-01-01').select('id');
    const invoiceIds = invoices.map((r) => r.id as string);
    if (invoiceIds.length) await db('unified_payment_applications').whereIn('invoice_id', invoiceIds).delete();
    await db('unified_payments').where('payment_date', '>=', '2098-01-01').andWhere('payment_date', '<', '2099-01-01').delete();
    await db('unified_invoices').whereIn('id', invoiceIds).delete();
    await db('raw_st_invoices').whereRaw("(payload->>'invoiceDate')::date >= '2098-01-01'").andWhereRaw("(payload->>'invoiceDate')::date < '2099-01-01'").delete();
    await db('unified_customers').where('name', 'F-04 Test Customer').delete();
  };

  beforeEach(async () => {
    await cleanup();
    const [row] = await db('unified_customers').insert({ name: 'F-04 Test Customer' }).returning('id');
    unifiedCustomerId = row.id as string;
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags open balances crossing the 30, 60 and 90-day brackets during the window', async () => {
    // QuickBooks: due 2098-05-10 -> 30 days past due on 06-09.
    await qboInvoice('2098-04-10', 400, 400, '2098-05-10');
    await qboInvoice('2098-04-10', 300, 300, '2098-05-10');
    // QuickBooks: due 2098-04-10 -> 60 days past due on 06-09.
    await qboInvoice('2098-03-10', 900, 900, '2098-04-10');
    // QuickBooks: crosses 30 on 06-09 too, but already paid - not flagged.
    await qboInvoice('2098-04-10', 500, 0, '2098-05-10');
    // ServiceTitan: due 2098-03-12 -> 90 days past due on 06-10.
    await stInvoice('2098-02-10', '2098-03-12', 750);

    const crossings = byTrigger(await evaluateArAgingSpike(WINDOW), 'BRACKET_CROSSING');
    const byDimension = Object.fromEntries(crossings.map((f) => [f.dimension, f]));

    expect(Object.keys(byDimension).sort()).toEqual([
      'QuickBooks - crossed 30 days past due',
      'QuickBooks - crossed 60 days past due',
      'ServiceTitan - crossed 90 days past due',
    ]);
    expect(byDimension['QuickBooks - crossed 30 days past due']).toMatchObject({
      ruleCode: 'F-04',
      periodStart: new Date('2098-06-09T00:00:00.000Z'),
      metricValue: 700,
    });
    expect(byDimension['QuickBooks - crossed 30 days past due'].details).toMatchObject({ bracketDays: 30, crossedOn: '2098-06-09', invoiceCount: 2 });
    expect(byDimension['ServiceTitan - crossed 90 days past due']).toMatchObject({ periodStart: new Date('2098-06-10T00:00:00.000Z'), metricValue: 750 });
  });

  it('does not flag balances whose bracket day falls outside the window', async () => {
    // 30 days past due on 06-20 - after the window.
    await qboInvoice('2098-04-21', 400, 400, '2098-05-21');

    expect(byTrigger(await evaluateArAgingSpike(WINDOW), 'BRACKET_CROSSING')).toEqual([]);
  });

  // AR growth sums every QuickBooks invoice dated before each point, so other
  // test files' rows can be present concurrently - fixtures are large enough
  // that a few thousand dollars of foreign rows can't change the outcome.
  // Their current `balance` is left at 0 (growth is rebuilt from totals and
  // payments, not balance) so they don't leak into F-04c's snapshot tests.
  it('flags QuickBooks AR growth over the window beyond the threshold', async () => {
    // AR at 06-08: 100,000. Then +60,000 invoiced and 10,000 paid -> 150,000 at 06-15 (+50%).
    const existing = await qboInvoice('2098-06-01', 100000, 0, null);
    await qboInvoice('2098-06-10', 60000, 0, null);
    const [payment] = await db('unified_payments')
      .insert({ unified_customer_id: unifiedCustomerId, total_amount: 10000, payment_date: '2098-06-12' })
      .returning('id');
    await db('unified_payment_applications').insert({ payment_id: payment.id, invoice_id: existing, applied_amount: 10000 });

    const growth = byTrigger(await evaluateArAgingSpike(WINDOW), 'AR_GROWTH');

    expect(growth).toHaveLength(1);
    expect(growth[0]).toMatchObject({ ruleCode: 'F-04', dimension: 'QuickBooks - total AR growth' });
    expect((growth[0].details as { growthAmount: number }).growthAmount).toBeCloseTo(50000);
  });

  it('does not flag AR growth below the threshold', async () => {
    // 100,000 -> 105,000 (+5%), below the default 15%.
    await qboInvoice('2098-06-01', 100000, 0, null);
    await qboInvoice('2098-06-10', 5000, 0, null);

    expect(byTrigger(await evaluateArAgingSpike(WINDOW), 'AR_GROWTH')).toEqual([]);
  });
});
