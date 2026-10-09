import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateCallbackWarrantySpike } from '../../src/modules/detect/rules/o02-callback-warranty-spike.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year not used by other test files/dev data - see d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2084-06-08T00:00:00.000Z'),
  periodEnd: new Date('2084-06-15T00:00:00.000Z'),
  baselineStart: new Date('2084-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2084-06-08T00:00:00.000Z'),
};
const BASELINE_DAY = new Date('2084-05-20T00:00:00.000Z');
const CURRENT_DAY = new Date('2084-06-10T00:00:00.000Z');
const PREFIX = 'o02-test-';

interface JobOptions {
  businessUnitId?: string;
  soldById?: string;
  jobStatus?: string;
  completedOn?: Date;
  recallForId?: string;
  warrantyId?: string;
}

function jobRows(createdOn: Date, count: number, options: JobOptions = {}) {
  return Array.from({ length: count }, () => ({
    source_id: `${PREFIX}${randomUUID()}`,
    is_latest: true,
    payload: {
      createdOn: createdOn.toISOString(),
      jobStatus: options.jobStatus ?? 'Completed',
      completedOn: (options.completedOn ?? createdOn).toISOString(),
      businessUnitId: options.businessUnitId ?? null,
      soldById: options.soldById ?? null,
      recallForId: options.recallForId ?? null,
      warrantyId: options.warrantyId ?? null,
    },
  }));
}

describe('evaluateCallbackWarrantySpike (O-02)', () => {
  const cleanup = async () => {
    await db('raw_st_jobs').where('source_id', 'like', `${PREFIX}%`).delete();
    await db('raw_st_business_units').where('source_id', 'like', `${PREFIX}%`).delete();
    await db('raw_st_technicians').where('source_id', 'like', `${PREFIX}%`).delete();
  };

  beforeEach(async () => {
    await cleanup();
    await db('raw_st_business_units').insert([
      { source_id: `${PREFIX}bu-hvac`, is_latest: true, payload: { name: 'HVAC Service' } },
      { source_id: `${PREFIX}bu-plumb`, is_latest: true, payload: { name: 'Plumbing Service' } },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags the department whose callback rate rose above its own baseline, not the stable one', async () => {
    const hvac = `${PREFIX}bu-hvac`;
    const plumb = `${PREFIX}bu-plumb`;
    await db('raw_st_jobs').insert([
      // HVAC: baseline 1/20 = 5%, current 3/10 = 30%.
      ...jobRows(BASELINE_DAY, 19, { businessUnitId: hvac }),
      ...jobRows(BASELINE_DAY, 1, { businessUnitId: hvac, recallForId: 'x' }),
      ...jobRows(CURRENT_DAY, 7, { businessUnitId: hvac }),
      ...jobRows(CURRENT_DAY, 2, { businessUnitId: hvac, recallForId: 'x' }),
      ...jobRows(CURRENT_DAY, 1, { businessUnitId: hvac, warrantyId: 'x' }),
      // Plumbing: 10% in both windows.
      ...jobRows(BASELINE_DAY, 18, { businessUnitId: plumb }),
      ...jobRows(BASELINE_DAY, 2, { businessUnitId: plumb, recallForId: 'x' }),
      ...jobRows(CURRENT_DAY, 9, { businessUnitId: plumb }),
      ...jobRows(CURRENT_DAY, 1, { businessUnitId: plumb, recallForId: 'x' }),
      // Canceled callbacks never count.
      ...jobRows(CURRENT_DAY, 5, { businessUnitId: plumb, recallForId: 'x', jobStatus: 'Canceled' }),
    ]);

    const findings = await evaluateCallbackWarrantySpike(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'O-02', dimension: 'HVAC Service' });
    expect(findings[0].metricValue).toBeCloseTo(0.3);
    expect(findings[0].baselineValue).toBeCloseTo(0.05);
    expect(findings[0].details).toMatchObject({ breakdown: 'DEPARTMENT', currentCallbackJobs: 3, currentTotalJobs: 10 });
  });

  it('charges callbacks to the technician on the original job', async () => {
    const tech = `${PREFIX}tech-1`;
    await db('raw_st_technicians').insert({ source_id: tech, is_latest: true, payload: { name: 'Alex Tech' } });
    const [original] = jobRows(new Date('2084-04-01T00:00:00.000Z'), 1, { soldById: tech });
    await db('raw_st_jobs').insert([
      original,
      // Technician completes 10 jobs in each window.
      ...jobRows(BASELINE_DAY, 10, { soldById: tech }),
      ...jobRows(CURRENT_DAY, 10, { soldById: tech }),
      // 3 callbacks this week point back to the technician's original job (sold by someone else
      // on the callback itself, so only the original job's technician can be blamed).
      ...jobRows(CURRENT_DAY, 3, { recallForId: original.source_id, jobStatus: 'Scheduled' }),
    ]);

    const findings = await evaluateCallbackWarrantySpike(WINDOW);
    const techFinding = findings.find((f) => (f.details as { breakdown: string }).breakdown === 'TECHNICIAN');

    expect(techFinding).toMatchObject({ ruleCode: 'O-02', dimension: `Alex Tech (#${tech})`, baselineValue: 0 });
    expect(techFinding?.metricValue).toBeCloseTo(0.3);
  });

  it('skips departments below the minimum sample', async () => {
    await db('raw_st_jobs').insert([
      ...jobRows(BASELINE_DAY, 20, { businessUnitId: `${PREFIX}bu-hvac` }),
      ...jobRows(CURRENT_DAY, 5, { businessUnitId: `${PREFIX}bu-hvac`, recallForId: 'x' }),
    ]);

    expect(await evaluateCallbackWarrantySpike(WINDOW)).toEqual([]);
  });
});
