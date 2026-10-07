import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { evaluateRepeatVisit } from '../../src/modules/detect/rules/o07-repeat-visit.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Sentinel year not used by other test files/dev data - see d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2090-06-08T00:00:00.000Z'),
  periodEnd: new Date('2090-06-15T00:00:00.000Z'),
  baselineStart: new Date('2090-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2090-06-08T00:00:00.000Z'),
};
const PREFIX = 'o07-test-';

async function job(number: string, locationId: string, createdOn: string, extra: Record<string, unknown> = {}) {
  await db('raw_st_jobs').insert({
    source_id: `${PREFIX}${number}`,
    is_latest: true,
    payload: { jobNumber: number, locationId: `${PREFIX}${locationId}`, createdOn, jobStatus: 'Scheduled', ...extra },
  });
}

function completed(on: string, extra: Record<string, unknown> = {}) {
  return { jobStatus: 'Completed', completedOn: on, ...extra };
}

describe('evaluateRepeatVisit (O-07)', () => {
  const cleanup = async () => {
    await db('raw_st_jobs').where('source_id', 'like', `${PREFIX}%`).delete();
  };

  beforeEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await db.destroy();
  });

  it('flags each second visit to the same address inside the repeat window', async () => {
    // Address match only (no equipment recorded): prior completed 10 days before.
    await job('A1', 'loc-a', '2090-05-29T00:00:00.000Z', completed('2090-05-31T00:00:00.000Z'));
    await job('A2', 'loc-a', '2090-06-10T00:00:00.000Z');
    // Same equipment on both jobs; already tagged as a recall - still flagged, marked as such.
    await job('B1', 'loc-b', '2090-06-01T00:00:00.000Z', completed('2090-06-02T00:00:00.000Z', { equipmentIds: [7, 8] }));
    await job('B2', 'loc-b', '2090-06-12T00:00:00.000Z', { equipmentIds: [8], recallForId: `${PREFIX}B1` });

    const findings = await evaluateRepeatVisit(WINDOW);
    const byDimension = Object.fromEntries(findings.map((f) => [f.dimension, f]));

    expect(Object.keys(byDimension).sort()).toEqual(['Job #A2', 'Job #B2']);
    expect(byDimension['Job #A2']).toMatchObject({ ruleCode: 'O-07', metricValue: 10, periodStart: new Date('2090-06-10T00:00:00.000Z') });
    expect(byDimension['Job #A2'].details).toMatchObject({ priorJobNumber: 'A1', matchBasis: 'SAME_ADDRESS', taggedCallback: false });
    expect(byDimension['Job #B2'].details).toMatchObject({ priorJobNumber: 'B1', matchBasis: 'SAME_EQUIPMENT', taggedCallback: true });
  });

  it('does not flag different equipment at the same address, visits outside 30 days, or canceled jobs', async () => {
    // Both jobs record equipment, but different systems.
    await job('C1', 'loc-c', '2090-06-01T00:00:00.000Z', completed('2090-06-02T00:00:00.000Z', { equipmentIds: [1] }));
    await job('C2', 'loc-c', '2090-06-10T00:00:00.000Z', { equipmentIds: [2] });
    // Prior job completed 45 days earlier.
    await job('D1', 'loc-d', '2090-04-20T00:00:00.000Z', completed('2090-04-26T00:00:00.000Z'));
    await job('D2', 'loc-d', '2090-06-10T00:00:00.000Z');
    // New job was canceled.
    await job('E1', 'loc-e', '2090-06-01T00:00:00.000Z', completed('2090-06-02T00:00:00.000Z'));
    await job('E2', 'loc-e', '2090-06-10T00:00:00.000Z', { jobStatus: 'Canceled' });

    expect(await evaluateRepeatVisit(WINDOW)).toEqual([]);
  });
});
