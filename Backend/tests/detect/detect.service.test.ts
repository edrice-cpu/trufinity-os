import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { DetectService } from '../../src/modules/detect/detect.service';

// A year isolated from other test files and real dev data - see d01-booking-rate-decline.rule.test.ts.
const NOW = new Date('2097-06-15T00:00:00.000Z');
const BASELINE_DAY = new Date('2097-05-20T00:00:00.000Z');
const CURRENT_DAY = new Date('2097-06-12T00:00:00.000Z');

function callRow(receivedAt: Date, booked: boolean, objections: string[] | null = null) {
  const id = randomUUID();
  return {
    lace_call_id: id,
    call_link: `https://www.lace.ai/app/call-center-all-calls/${id}`,
    booked,
    objections,
    received_at: receivedAt,
  };
}

describe('DetectService', () => {
  beforeEach(async () => {
    // Bounded to this file's own year: other test files share this table concurrently.
    await db('detected_alerts').where('period_start', '>=', '2097-01-01').andWhere('period_start', '<', '2098-01-01').delete();
    await db('canonical_lace_calls').where('received_at', '>=', '2097-05-01').andWhere('received_at', '<', '2097-07-01').delete();
  });

  afterAll(async () => {
    await db('detected_alerts').where('period_start', '>=', '2097-01-01').andWhere('period_start', '<', '2098-01-01').delete();
    await db('canonical_lace_calls').where('received_at', '>=', '2097-05-01').andWhere('received_at', '<', '2097-07-01').delete();
    await db.destroy();
  });

  it('persists findings from both rules and returns them', async () => {
    // Baseline: booking rate 8/10 = 80%, 'Value Concerns' share of unbooked = 2/4 = 50%.
    // Current: booking rate 2/8 = 25% (a 55-point drop -> D-01), share of unbooked = 6/6 = 100% (2x baseline -> D-06).
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(BASELINE_DAY, true)),
      ...Array.from({ length: 2 }, () => callRow(BASELINE_DAY, false)),
      ...Array.from({ length: 2 }, () => callRow(BASELINE_DAY, false, ['Value Concerns'])),
      ...Array.from({ length: 2 }, () => callRow(CURRENT_DAY, true)),
      ...Array.from({ length: 6 }, () => callRow(CURRENT_DAY, false, ['Value Concerns'])),
    ]);

    const result = await new DetectService().run(NOW);

    const ruleCodes = result.findings.map((f) => f.ruleCode).sort();
    expect(ruleCodes).toEqual(['D-01', 'D-06']);

    const stored = await db('detected_alerts').where('period_start', '>=', '2097-01-01').andWhere('period_start', '<', '2098-01-01');
    expect(stored).toHaveLength(2);
  });

  it('replaces (does not duplicate) a finding for the same rule, dimension and period on re-run', async () => {
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(BASELINE_DAY, true)),
      ...Array.from({ length: 2 }, () => callRow(BASELINE_DAY, false)),
      ...Array.from({ length: 5 }, () => callRow(CURRENT_DAY, true)),
      ...Array.from({ length: 5 }, () => callRow(CURRENT_DAY, false)),
    ]);

    await new DetectService().run(NOW);
    await new DetectService().run(NOW);

    const stored = await db('detected_alerts').where({ rule_code: 'D-01' }).andWhere('period_start', '>=', '2097-01-01').andWhere('period_start', '<', '2098-01-01');
    expect(stored).toHaveLength(1);
  });

  it('persists no rows when no rule finds anything', async () => {
    const result = await new DetectService().run(NOW);

    expect(result.findings).toHaveLength(0);
    const stored = await db('detected_alerts').where('period_start', '>=', '2097-01-01').andWhere('period_start', '<', '2098-01-01');
    expect(stored).toHaveLength(0);
  });
});
