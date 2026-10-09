import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateTechnicianOutlier } from '../../src/modules/detect/rules/o05-technician-outlier.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year not used by other test files/dev data - see d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2086-06-08T00:00:00.000Z'),
  periodEnd: new Date('2086-06-15T00:00:00.000Z'),
  baselineStart: new Date('2086-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2086-06-08T00:00:00.000Z'),
};
const CURRENT_DAY = new Date('2086-06-10T00:00:00.000Z');
const TECH_PREFIX = 'o05-test-tech-';

function completedJobs(technicianId: string, count: number, total: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: count }, () => ({
    source_id: randomUUID(),
    is_latest: true,
    payload: {
      createdOn: CURRENT_DAY.toISOString(),
      completedOn: CURRENT_DAY.toISOString(),
      jobStatus: 'Completed',
      soldById: technicianId,
      total,
      ...extra,
    },
  }));
}

async function technician(id: string, name: string) {
  await db('raw_st_technicians').insert({ source_id: `${TECH_PREFIX}${id}`, is_latest: true, payload: { id, name } });
  return `${TECH_PREFIX}${id}`;
}

describe('evaluateTechnicianOutlier (O-05)', () => {
  const cleanup = async () => {
    await db('raw_st_jobs').whereRaw("(payload->>'completedOn')::timestamptz >= '2086-01-01'").andWhereRaw("(payload->>'completedOn')::timestamptz < '2087-01-01'").delete();
    await db('raw_st_technicians').where('source_id', 'like', `${TECH_PREFIX}%`).delete();
  };

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags technicians below and above the band around their peers', async () => {
    const low = await technician('1', 'Low Ticket');
    const high = await technician('2', 'High Ticket');
    const mid = await technician('3', 'Mid A');
    const mid2 = await technician('4', 'Mid B');
    // Low averages $300 vs peers ~$1,333 (-78%); High averages $2,000 vs peers ~$767 (+161%).
    // Mid A/B: $1,000 vs peers $1,100 (-9%), inside the default +/-40% band.
    await db('raw_st_jobs').insert([
      ...completedJobs(low, 4, 300),
      ...completedJobs(high, 4, 2000),
      ...completedJobs(mid, 4, 1000),
      ...completedJobs(mid2, 4, 1000),
    ]);

    const findings = await evaluateTechnicianOutlier(WINDOW);
    const byDimension = Object.fromEntries(findings.map((f) => [f.dimension, f]));

    expect(findings).toHaveLength(2);
    expect(byDimension[`Low Ticket (#${low})`]).toMatchObject({ ruleCode: 'O-05', metricValue: 300 });
    expect(byDimension[`Low Ticket (#${low})`].baselineValue).toBeCloseTo(16000 / 12);
    expect(byDimension[`Low Ticket (#${low})`].details).toMatchObject({ measure: 'AVERAGE_TICKET', direction: 'BELOW_BAND' });
    expect(byDimension[`High Ticket (#${high})`].details).toMatchObject({ direction: 'ABOVE_BAND' });
  });

  it('does not flag technicians within the band', async () => {
    const t1 = await technician('1', 'Tech 1');
    const t2 = await technician('2', 'Tech 2');
    const t3 = await technician('3', 'Tech 3');
    await db('raw_st_jobs').insert([
      ...completedJobs(t1, 4, 800),
      ...completedJobs(t2, 4, 1000),
      ...completedJobs(t3, 4, 1000),
    ]);

    expect(await evaluateTechnicianOutlier(WINDOW)).toEqual([]);
  });

  it('ignores no-charge jobs and needs enough qualifying technicians', async () => {
    const low = await technician('1', 'Low Ticket');
    const a = await technician('2', 'Peer A');
    const b = await technician('3', 'Peer B');
    // Peer B only has no-charge jobs, so just 2 technicians qualify - below the default minimum of 3.
    await db('raw_st_jobs').insert([
      ...completedJobs(low, 4, 100),
      ...completedJobs(a, 4, 1000),
      ...completedJobs(b, 4, 1000, { noCharge: true }),
    ]);

    expect(await evaluateTechnicianOutlier(WINDOW)).toEqual([]);
  });
});
