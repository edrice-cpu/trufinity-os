import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { randomUUID } from 'crypto';
import { db } from '../../src/database';
import { evaluateBookingRateDecline } from '../../src/modules/detect/rules/d01-booking-rate-decline.rule';
import type { DetectionWindow } from '../../src/modules/detect/detect.types';

// Dates are deliberately parked in a year no other test/dev data ever uses
// (Jest runs test files concurrently against the same shared dev database,
// and detect rules aggregate by date range - a real year would pick up rows
// from other test files or from real ingested data running at the same time).
const WINDOW: DetectionWindow = {
  periodStart: new Date('2099-06-08T00:00:00.000Z'),
  periodEnd: new Date('2099-06-15T00:00:00.000Z'),
  baselineStart: new Date('2099-05-11T00:00:00.000Z'),
  baselineEnd: new Date('2099-06-08T00:00:00.000Z'),
};

function callRow(receivedAt: Date, booked: boolean, csr: string | null = null) {
  const id = randomUUID();
  return {
    lace_call_id: id,
    call_link: `https://www.lace.ai/app/call-center-all-calls/${id}`,
    booked,
    csr,
    received_at: receivedAt,
  };
}

describe('evaluateBookingRateDecline (D-01)', () => {
  beforeEach(async () => {
    await db('canonical_lace_calls').where('received_at', '>=', '2099-05-01').andWhere('received_at', '<', '2099-07-01').delete();
  });

  afterAll(async () => {
    await db('canonical_lace_calls').where('received_at', '>=', '2099-05-01').andWhere('received_at', '<', '2099-07-01').delete();
    await db.destroy();
  });

  it('flags a tenant-wide decline that meets the threshold, with the current and baseline rates as metric/baseline values', async () => {
    const baselineDay = new Date('2099-05-20T00:00:00.000Z');
    const currentDay = new Date('2099-06-12T00:00:00.000Z');
    // Baseline: 8/10 booked (80%). Current: 5/10 booked (50%) - a 30-point drop.
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(baselineDay, true)),
      ...Array.from({ length: 2 }, () => callRow(baselineDay, false)),
      ...Array.from({ length: 5 }, () => callRow(currentDay, true)),
      ...Array.from({ length: 5 }, () => callRow(currentDay, false)),
    ]);

    const findings = await evaluateBookingRateDecline(WINDOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleCode: 'D-01', dimension: 'TENANT_TOTAL', metricValue: 0.5, baselineValue: 0.8 });
    expect((findings[0].details as { dropPoints: number }).dropPoints).toBeCloseTo(30);
  });

  it('does not flag a decline below the configured threshold', async () => {
    const baselineDay = new Date('2099-05-20T00:00:00.000Z');
    const currentDay = new Date('2099-06-12T00:00:00.000Z');
    // Baseline: 80%. Current: 75% - only a 5-point drop, below the default 10-point threshold.
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(baselineDay, true)),
      ...Array.from({ length: 2 }, () => callRow(baselineDay, false)),
      ...Array.from({ length: 3 }, () => callRow(currentDay, true)),
      ...Array.from({ length: 1 }, () => callRow(currentDay, false)),
    ]);

    const findings = await evaluateBookingRateDecline(WINDOW);

    expect(findings).toEqual([]);
  });

  it('returns no findings when there is no data in either window (nothing to compare)', async () => {
    const findings = await evaluateBookingRateDecline(WINDOW);
    expect(findings).toEqual([]);
  });

  it('ignores calls with an unknown (null) booked status', async () => {
    const currentDay = new Date('2099-06-12T00:00:00.000Z');
    const baselineDay = new Date('2099-05-20T00:00:00.000Z');
    await db('canonical_lace_calls').insert([
      { lace_call_id: randomUUID(), call_link: 'https://x/unknown-1', booked: null, received_at: currentDay },
      ...Array.from({ length: 5 }, () => callRow(baselineDay, true)),
    ]);

    const findings = await evaluateBookingRateDecline(WINDOW);

    // Current window has zero calls with a known booked status - no rate to compare.
    expect(findings).toEqual([]);
  });

  it('flags a per-CSR decline independently of the tenant-wide rate (SPEC-BI-001: "overall or by CSR")', async () => {
    const baselineDay = new Date('2099-05-20T00:00:00.000Z');
    const currentDay = new Date('2099-06-12T00:00:00.000Z');
    // Tenant-wide stays flat (mixing both CSRs), but "Alex" alone drops from 80% to 40%.
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(baselineDay, true, 'Alex')),
      ...Array.from({ length: 2 }, () => callRow(baselineDay, false, 'Alex')),
      ...Array.from({ length: 2 }, () => callRow(baselineDay, true, 'Sam')),
      ...Array.from({ length: 8 }, () => callRow(baselineDay, false, 'Sam')),
      ...Array.from({ length: 4 }, () => callRow(currentDay, true, 'Alex')),
      ...Array.from({ length: 6 }, () => callRow(currentDay, false, 'Alex')),
      ...Array.from({ length: 8 }, () => callRow(currentDay, true, 'Sam')),
      ...Array.from({ length: 2 }, () => callRow(currentDay, false, 'Sam')),
    ]);

    const findings = await evaluateBookingRateDecline(WINDOW);

    const dimensions = findings.map((f) => f.dimension).sort();
    expect(dimensions).toEqual(['Alex']);
    expect(findings[0]).toMatchObject({ metricValue: 0.4, baselineValue: 0.8 });
  });

  it('does not flag a CSR with fewer than the minimum call volume in either window', async () => {
    const baselineDay = new Date('2099-05-20T00:00:00.000Z');
    const currentDay = new Date('2099-06-12T00:00:00.000Z');
    // Only 3 calls for "Jordan" in the current window - below the 5-call minimum.
    await db('canonical_lace_calls').insert([
      ...Array.from({ length: 8 }, () => callRow(baselineDay, true, 'Jordan')),
      ...Array.from({ length: 2 }, () => callRow(baselineDay, false, 'Jordan')),
      ...Array.from({ length: 1 }, () => callRow(currentDay, true, 'Jordan')),
      ...Array.from({ length: 2 }, () => callRow(currentDay, false, 'Jordan')),
    ]);

    const findings = await evaluateBookingRateDecline(WINDOW);

    // Tenant-wide may still flag on this small fixture (no min-volume floor
    // at that level) - what this test checks is that "Jordan" specifically
    // doesn't, since its own volume is below the per-CSR minimum.
    expect(findings.map((f) => f.dimension)).not.toContain('Jordan');
  });
});
