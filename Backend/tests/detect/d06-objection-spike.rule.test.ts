import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateObjectionCategorySpikes } from '../../src/modules/detect/rules/d06-objection-spike.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// A year isolated from other test files and real dev data - see d01-booking-rate-decline.rule.test.ts.
const WINDOW: DetectionWindow = {
  periodStart: new Date('2098-06-08T00:00:00.000Z'),
  periodEnd: new Date('2098-06-15T00:00:00.000Z'),
  baselineStart: new Date('2098-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2098-06-08T00:00:00.000Z'),
};

// D-06's metric is a category's share of UNBOOKED calls (SPEC-BI-001 Section
// 5.3), so every fixture row here is an unbooked call; "plain" rows (no
// objections) exist only to control the total-unbooked denominator.
function callRow(receivedAt: Date, objections: string[] | null) {
  const id = randomUUID();
  return {
    lace_call_id: id,
    call_link: `https://www.lace.ai/app/call-center-all-calls/${id}`,
    received_at: receivedAt,
    objections,
    booked: false,
  };
}

describe('evaluateObjectionCategorySpikes (D-06)', () => {
  beforeEach(async () => {
    await db('canonical_lace_calls').where('received_at', '>=', '2098-05-01').andWhere('received_at', '<', '2098-07-01').delete();
  });

  afterAll(async () => {
    await db('canonical_lace_calls').where('received_at', '>=', '2098-05-01').andWhere('received_at', '<', '2098-07-01').delete();
    await db.destroy();
  });

  it('flags a category whose current share of unbooked calls is at least the threshold multiple of its baseline share', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-12T00:00:00.000Z');
    // Baseline: 2 of 8 unbooked calls -> share 0.25. Current: 4 of 4 unbooked calls -> share 1.0 (4x).
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 2 }, () => callRow(baselineDay, ['Value Concerns'])),
      ...Array.from({ length: 6 }, () => callRow(baselineDay, null)),
      ...Array.from({ length: 4 }, () => callRow(currentDay, ['Value Concerns'])),
    ]);

    const findings = await evaluateObjectionCategorySpikes(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'D-06', dimension: 'Value Concerns', metricValue: 1, baselineValue: 0.25 });
  });

  it('does not flag a category below the minimum occurrence count, even at a high share multiplier', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-12T00:00:00.000Z');
    // Baseline: 1 of 10 unbooked -> share 0.1. Current: 2 of 2 unbooked -> share 1.0 (10x), but only 2 occurrences (< min sample 3).
    await db('canonical_lace_calls').insert([
      callRow(baselineDay, ['Rare Category']),
      ...Array.from({ length: 9 }, () => callRow(baselineDay, null)),
      ...Array.from({ length: 2 }, () => callRow(currentDay, ['Rare Category'])),
    ]);

    const findings = await evaluateObjectionCategorySpikes(WINDOW);

    expect(findings).toHaveLength(0);
  });

  it('does not flag a brand-new category with zero baseline occurrences (nothing to compare a share against)', async () => {
    const currentDay = new Date('2098-06-12T00:00:00.000Z');
    await db('canonical_lace_calls').insert(Array.from({ length: 5 }, () => callRow(currentDay, ['New Category'])));

    const findings = await evaluateObjectionCategorySpikes(WINDOW);

    expect(findings).toHaveLength(0);
  });

  it('does not flag a category whose current share is below the threshold multiple', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-12T00:00:00.000Z');
    // Baseline: 8 of 8 -> share 1.0. Current: 3 of 6 -> share 0.5 (0.5x, below 2x default).
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(baselineDay, ['Steady Category'])),
      ...Array.from({ length: 3 }, () => callRow(currentDay, ['Steady Category'])),
      ...Array.from({ length: 3 }, () => callRow(currentDay, null)),
    ]);

    const findings = await evaluateObjectionCategorySpikes(WINDOW);

    expect(findings).toHaveLength(0);
  });

  it('evaluates multiple objection categories on the same call independently', async () => {
    const baselineDay = new Date('2098-05-20T00:00:00.000Z');
    const currentDay = new Date('2098-06-12T00:00:00.000Z');
    // Baseline: A and B each 4 of 8 unbooked -> share 0.5 each. Current: A is 4 of 4 -> share 1.0 (2x); B has 0 current occurrences.
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 4 }, () => callRow(baselineDay, ['Category A', 'Category B'])),
      ...Array.from({ length: 4 }, () => callRow(baselineDay, null)),
      ...Array.from({ length: 4 }, () => callRow(currentDay, ['Category A'])),
    ]);

    const findings = await evaluateObjectionCategorySpikes(WINDOW);

    const dimensions = findings.map((f) => f.dimension).sort();
    expect(dimensions).toEqual(['Category A']);
  });
});
