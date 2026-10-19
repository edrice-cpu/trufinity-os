import { afterAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../../src/database';
import { reconcileLaceBookingRates } from '../../src/modules/lace/booking-rate-reconciliation';

// Runs inside a rolled-back transaction: reconciliation reads every latest
// agent-performance row, so rows from other test files must not leak in (and
// ours must not leak out). Sentinel year 2083 keeps the call data isolated too.
async function inRollback(run: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const trx = await db.transaction();
  try {
    await run(trx);
  } finally {
    await trx.rollback();
  }
}

const PERIOD = { start: '2083-09-01 04:00:00', end: '2083-09-30 21:00:00' };
const CALL_DAY = new Date('2083-09-15T12:00:00.000Z');

function reportRow(csr: string, booked: string, qualified: string, successRatio: string) {
  return {
    source_id: `${csr}__${PERIOD.start}__${PERIOD.end}`,
    is_latest: true,
    payload: {
      CSR: csr, 'Period Start': PERIOD.start, 'Period End': PERIOD.end, 'Total Calls': '100',
      'Success Ratio': successRatio, 'Cancellation Rate': '', Booked: booked, Qualified: qualified,
      'Playbook Score': '', 'Most Coaching Needed': '',
    },
  };
}

function calls(csr: string, booked: number, qualifiedNotBooked: number, unqualified = 0) {
  const row = (isBooked: boolean, qualified: boolean) => {
    const id = randomUUID();
    return { lace_call_id: id, call_link: `https://www.lace.ai/app/call-center-all-calls/${id}`, csr, booked: isBooked, qualified, received_at: CALL_DAY };
  };
  return [
    ...Array.from({ length: booked }, () => row(true, true)),
    ...Array.from({ length: qualifiedNotBooked }, () => row(false, true)),
    ...Array.from({ length: unqualified }, () => row(false, false)),
  ];
}

afterAll(async () => {
  await db.destroy();
});

describe('reconcileLaceBookingRates', () => {
  it('classifies each CSR-month against Lace\'s reported Success Ratio', async () => {
    await inRollback(async (trx) => {
      await trx('raw_lace_agent_performance').insert([
        reportRow('Recon Match', '45', '56', '80%'),
        reportRow('Recon Mismatch', '45', '56', '80%'),
        reportRow('Recon Incomplete', '279', '313', '89%'),
        reportRow('Recon Idle', '0', '', '0'),
      ]);
      await trx('canonical_lace_calls').insert([
        // 45 / 56 = 80.4% vs Lace 80% -> MATCH (unqualified calls don't count).
        ...calls('Recon Match', 45, 11, 150),
        // 30 / 56 = 53.6% vs Lace 80% -> MISMATCH.
        ...calls('Recon Mismatch', 30, 26),
        // Only 20 of Lace's 313 qualified calls are in our data -> can't compare.
        ...calls('Recon Incomplete', 18, 2),
      ]);

      const results = await reconcileLaceBookingRates(trx, 3);
      const byCsr = Object.fromEntries(results.filter((r) => r.csr.startsWith('Recon ')).map((r) => [r.csr, r]));

      expect(byCsr['Recon Match']).toMatchObject({ status: 'MATCH', laceSuccessRatioPercent: 80, ourBooked: 45, ourQualified: 56 });
      expect(byCsr['Recon Match']?.differencePoints).toBeCloseTo(0.36, 1);
      expect(byCsr['Recon Mismatch']).toMatchObject({ status: 'MISMATCH', ourBooked: 30, ourQualified: 56 });
      expect(byCsr['Recon Incomplete']).toMatchObject({ status: 'INCOMPLETE_CALL_DATA', differencePoints: null });
      expect(byCsr['Recon Idle']).toMatchObject({ status: 'NO_LACE_ACTIVITY', laceQualified: null, laceSuccessRatioPercent: 0 });
      expect(byCsr['Recon Match']?.periodStart.toISOString()).toBe('2083-09-01T04:00:00.000Z');
    });
  });
});
