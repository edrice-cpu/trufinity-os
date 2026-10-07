import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateArAgingSpike } from '../../src/modules/detect/rules/f04-ar-aging-spike.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

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

async function qboInvoiceRow(invoiceDate: Date, balance: number, dueDate: Date | null) {
  return db('unified_invoices').insert({
    unified_customer_id: unifiedCustomerId,
    total_amount: 100,
    balance,
    invoice_date: invoiceDate,
    due_date: dueDate,
  });
}

async function stInvoiceRow(invoiceDate: Date, balance: number, dueDate: Date | null) {
  const sourceId = randomUUID();
  return db('raw_st_invoices').insert({
    source_id: sourceId,
    is_latest: true,
    payload: {
      invoiceDate: invoiceDate.toISOString().slice(0, 10),
      dueDate: dueDate ? dueDate.toISOString().slice(0, 10) : null,
      balance,
      total: 100,
    },
  });
}

describe('evaluateArAgingSpike (F-04)', () => {
  const cleanup = async () => {
    await db('unified_invoices').where('invoice_date', '>=', '2098-05-01').andWhere('invoice_date', '<', '2098-07-01').delete();
    await db('raw_st_invoices').whereRaw("(payload->>'invoiceDate')::date >= '2098-05-01'").andWhereRaw("(payload->>'invoiceDate')::date < '2098-07-01'").delete();
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

  it('flags a QuickBooks overdue-rate increase that meets the threshold', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-10T00:00:00.000Z');
    const longPastDue = new Date('2098-01-01T00:00:00.000Z');
    const notDue = new Date('2099-01-01T00:00:00.000Z');

    // Baseline cohort (5 invoices): 1 overdue (20%).
    await Promise.all([
      qboInvoiceRow(baselineDay, 50, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
    ]);
    // Current cohort (5 invoices): 4 overdue (80%) - a 60-point increase.
    await Promise.all([
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 0, notDue),
    ]);

    const findings = await evaluateArAgingSpike(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'F-04', dimension: 'QUICKBOOKS_TOTAL', metricValue: 0.8, baselineValue: 0.2 });
  });

  it('flags a ServiceTitan overdue-rate increase independently of QuickBooks', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-10T00:00:00.000Z');
    const longPastDue = new Date('2098-01-01T00:00:00.000Z');

    await Promise.all(Array.from({ length: 5 }, () => stInvoiceRow(baselineDay, 0, longPastDue)));
    await Promise.all(Array.from({ length: 5 }, () => stInvoiceRow(currentDay, 50, longPastDue)));

    const findings = await evaluateArAgingSpike(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'F-04', dimension: 'SERVICETITAN_TOTAL', metricValue: 1, baselineValue: 0 });
  });

  it('does not flag when the cohort sample is below the minimum', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-10T00:00:00.000Z');
    const longPastDue = new Date('2098-01-01T00:00:00.000Z');

    // Only 3 invoices per cohort - below the default minimum of 5.
    await Promise.all([
      qboInvoiceRow(baselineDay, 0, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
      qboInvoiceRow(baselineDay, 0, longPastDue),
    ]);
    await Promise.all([
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 50, longPastDue),
      qboInvoiceRow(currentDay, 50, longPastDue),
    ]);

    const findings = await evaluateArAgingSpike(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no data in either window', async () => {
    const findings = await evaluateArAgingSpike(WINDOW);
    expect(findings).toEqual([]);
  });
});
