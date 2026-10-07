import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateCreditOrWriteDown } from '../../src/modules/detect/rules/f04d-credit-or-write-down.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year isolated from other test files/dev data - see the same note
// in d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2094-06-08T00:00:00.000Z'),
  periodEnd: new Date('2094-06-15T00:00:00.000Z'),
  baselineStart: new Date('2094-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2094-06-08T00:00:00.000Z'),
};
const PREFIX = 'f04d-test-';

async function creditMemo(id: string, txnDate: string, totalAmt: number) {
  await db('raw_qbo_creditmemos').insert({
    source_id: `${PREFIX}${id}`,
    is_latest: true,
    payload: { DocNumber: id, TxnDate: txnDate, TotalAmt: totalAmt, CustomerRef: { value: '1', name: 'Jane Doe' } },
  });
}

async function stInvoice(id: string, payload: Record<string, unknown>, ingestedAt = '2094-06-01T00:00:00.000Z', isLatest = true) {
  await db('raw_st_invoices').insert({ source_id: `${PREFIX}${id}`, is_latest: isLatest, ingested_at: ingestedAt, payload: { referenceNumber: id, ...payload } });
}

async function qboInvoiceVersion(id: string, totalAmt: number, ingestedAt: string, isLatest: boolean) {
  await db('raw_qbo_invoices').insert({ source_id: `${PREFIX}${id}`, is_latest: isLatest, ingested_at: ingestedAt, payload: { DocNumber: id, TotalAmt: totalAmt } });
}

describe('evaluateCreditOrWriteDown (F-04d)', () => {
  const cleanup = async () => {
    await db('raw_qbo_creditmemos').where('source_id', 'like', `${PREFIX}%`).delete();
    await db('raw_st_invoices').where('source_id', 'like', `${PREFIX}%`).delete();
    await db('raw_qbo_invoices').where('source_id', 'like', `${PREFIX}%`).delete();
  };

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags a single QuickBooks credit memo at or above the threshold, and ignores small ones', async () => {
    await creditMemo('CM-1', '2094-06-10', 400);
    await creditMemo('CM-2', '2094-06-10', 100);
    // Outside the window.
    await creditMemo('CM-3', '2094-05-20', 5000);

    const findings = await evaluateCreditOrWriteDown(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleCode: 'F-04d',
      dimension: 'QuickBooks credit memo #CM-1',
      periodStart: new Date('2094-06-10T00:00:00.000Z'),
      metricValue: 400,
      baselineValue: null,
    });
    expect(findings[0].details).toMatchObject({ kind: 'CREDIT_MEMO', customerName: 'Jane Doe', thresholdAmount: 250 });
  });

  it('flags a ServiceTitan adjustment invoice that credits a prior invoice', async () => {
    await stInvoice('ADJ-1', { invoiceDate: '2094-06-11', adjustmentToId: 999, total: -600, customer: { id: 1, name: 'John Roe' } });
    // A normal positive invoice is not a credit.
    await stInvoice('INV-1', { invoiceDate: '2094-06-11', total: 600 });

    const findings = await evaluateCreditOrWriteDown(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ dimension: 'ServiceTitan adjustment invoice #ADJ-1', metricValue: 600 });
    expect(findings[0].details).toMatchObject({ kind: 'ADJUSTMENT_INVOICE', customerName: 'John Roe' });
  });

  it('flags an invoice whose total was reduced between raw versions, in either source', async () => {
    // QuickBooks: 1,000 -> 600 (reduced by 400) re-ingested inside the window.
    await qboInvoiceVersion('Q-1', 1000, '2094-06-01T00:00:00.000Z', false);
    await qboInvoiceVersion('Q-1', 600, '2094-06-12T00:00:00.000Z', true);
    // ServiceTitan: 800 -> 700 (only 100 - below threshold).
    await stInvoice('S-1', { invoiceDate: '2094-05-01', total: 800 }, '2094-06-01T00:00:00.000Z', false);
    await stInvoice('S-1', { invoiceDate: '2094-05-01', total: 700 }, '2094-06-12T00:00:00.000Z', true);
    // QuickBooks: total went UP - not a reduction.
    await qboInvoiceVersion('Q-2', 500, '2094-06-01T00:00:00.000Z', false);
    await qboInvoiceVersion('Q-2', 900, '2094-06-12T00:00:00.000Z', true);

    const findings = await evaluateCreditOrWriteDown(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      dimension: 'QuickBooks invoice reduced #Q-1',
      periodStart: new Date('2094-06-12T00:00:00.000Z'),
      metricValue: 400,
    });
    expect(findings[0].details).toMatchObject({ kind: 'INVOICE_REDUCTION', previousTotal: 1000, newTotal: 600 });
  });
});
