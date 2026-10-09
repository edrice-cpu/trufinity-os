import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateArConcentration } from '../../src/modules/detect/rules/f04c-ar-concentration.rule';
import type { DetectedAlertFinding, DetectionWindow } from '../../src/modules/detect/detect.types';

// F-04c is a point-in-time snapshot over ALL outstanding QuickBooks AR (see
// the rule file) - period start/end are stamped but not used as filters. Other
// test files can have small balances in unified_invoices at the same time, so
// these tests assert only on their own customers and use amounts large enough
// that a few hundred foreign dollars can't change the outcome.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2095-06-08T00:00:00.000Z'),
  periodEnd: new Date('2095-06-15T00:00:00.000Z'),
  baselineStart: new Date('2095-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2095-06-08T00:00:00.000Z'),
};

const customerNames = Array.from({ length: 10 }, (_, i) => `F-04c Customer ${i + 1}`);

async function invoiceRow(customerId: string, balance: number) {
  return db('unified_invoices').insert({ unified_customer_id: customerId, total_amount: balance, balance, invoice_date: new Date('2095-06-01') });
}

function byTrigger(findings: DetectedAlertFinding[], trigger: string) {
  return findings.filter((f) => (f.details as { trigger: string }).trigger === trigger);
}

describe('evaluateArConcentration (F-04c)', () => {
  const ids: string[] = [];

  const cleanup = async () => {
    const existing = await db('unified_customers').whereIn('name', customerNames).select('id');
    if (existing.length) await db('unified_invoices').whereIn('unified_customer_id', existing.map((r) => r.id)).delete();
    await db('unified_customers').whereIn('name', customerNames).delete();
  };

  beforeEach(async () => {
    await cleanup();
    ids.length = 0;
    for (const name of customerNames) {
      const [row] = await db('unified_customers').insert({ name }).returning('id');
      ids.push(row.id as string);
    }
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags every single customer balance above the threshold', async () => {
    await invoiceRow(ids[0], 30000);
    await invoiceRow(ids[0], 20000);
    await invoiceRow(ids[1], 12000);
    await invoiceRow(ids[2], 9000);

    const singles = byTrigger(await evaluateArConcentration(WINDOW), 'SINGLE_BALANCE')
      .filter((f) => customerNames.includes(f.dimension));

    expect(singles.map((f) => f.dimension)).toEqual(['F-04c Customer 1', 'F-04c Customer 2']);
    expect(singles[0]).toMatchObject({ ruleCode: 'F-04c', metricValue: 50000 });
    expect(singles[0].details).toMatchObject({ customerId: ids[0], thresholdAmount: 10000 });
  });

  it('flags the top five balances when together they exceed the share threshold', async () => {
    // Five at 9,000 and five at 1,000: top five = 45,000 of 50,000 (90%). None above $10,000 on its own.
    for (const [i, id] of ids.entries()) await invoiceRow(id, i < 5 ? 9000 : 1000);

    const findings = await evaluateArConcentration(WINDOW);
    const topFive = byTrigger(findings, 'TOP_FIVE_SHARE');

    expect(topFive).toHaveLength(1);
    expect(topFive[0]).toMatchObject({ ruleCode: 'F-04c', dimension: 'QuickBooks - top 5 customer balances', metricValue: 45000 });
    expect(byTrigger(findings, 'SINGLE_BALANCE').filter((f) => customerNames.includes(f.dimension))).toEqual([]);
  });

  it('does not flag an evenly spread AR book', async () => {
    // Ten at 5,000: top five = 50% - not above the default 50% threshold.
    for (const id of ids) await invoiceRow(id, 5000);

    expect(byTrigger(await evaluateArConcentration(WINDOW), 'TOP_FIVE_SHARE')).toEqual([]);
  });
});
