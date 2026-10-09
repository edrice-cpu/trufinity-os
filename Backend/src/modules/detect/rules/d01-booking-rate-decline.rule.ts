import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const TENANT_DIMENSION = 'TENANT_TOTAL';
// Guards a per-CSR rate from being noisy at very low volume (e.g. one call,
// 0% or 100% "rate"). Not a spec-given number - an engineering safeguard,
// same rationale as D-06's minimum occurrence count.
const MIN_CSR_CALLS = 5;

interface BookingCounts {
  total: number;
  booked: number;
}

async function bookingRateForWindow(database: Knex, start: Date, end: Date): Promise<BookingCounts> {
  const row: { total: string; booked: string } = await database('canonical_lace_calls')
    .whereNotNull('booked')
    .andWhere('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .select(
      database.raw('count(*) as total'),
      database.raw("count(*) filter (where booked = true) as booked"),
    )
    .first();
  return { total: Number(row.total), booked: Number(row.booked) };
}

async function bookingRateByCsrForWindow(database: Knex, start: Date, end: Date): Promise<Map<string, BookingCounts>> {
  const rows: { csr: string; total: string; booked: string }[] = await database('canonical_lace_calls')
    .whereNotNull('booked')
    .whereNotNull('csr')
    .andWhere('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .groupBy('csr')
    .select('csr', database.raw('count(*) as total'), database.raw("count(*) filter (where booked = true) as booked"));
  return new Map(rows.map((r) => [r.csr, { total: Number(r.total), booked: Number(r.booked) }]));
}

function rate(counts: BookingCounts | undefined): number | null {
  return counts && counts.total > 0 ? counts.booked / counts.total : null;
}

// The trigger is the current rolling-7-day rate against the floor alone; the
// trailing 4-week rate is carried along only as context for the narrative.
function buildFinding(
  dimension: string,
  window: DetectionWindow,
  current: BookingCounts,
  baseline: BookingCounts | undefined,
): DetectedAlertFinding | null {
  const currentRate = rate(current);
  if (currentRate === null) return null;
  if (currentRate * 100 >= env.DETECT_D01_BOOKING_RATE_FLOOR_PERCENT) return null;

  const baselineRate = rate(baseline);
  return {
    ruleCode: 'D-01',
    dimension,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: baselineRate === null ? null : window.baselineStart,
    baselineEnd: baselineRate === null ? null : window.baselineEnd,
    metricValue: currentRate,
    baselineValue: baselineRate,
    details: {
      currentBookedCalls: current.booked,
      currentTotalCalls: current.total,
      ...(baselineRate === null ? {} : { baselineBookedCalls: baseline?.booked, baselineTotalCalls: baseline?.total }),
      floorPercent: env.DETECT_D01_BOOKING_RATE_FLOOR_PERCENT,
    },
  };
}

// D-01 (RED): booking rate as reported by Lace AI falls below the threshold
// on a rolling 7-day basis, overall or by CSR (SPEC-BI-001 Section 5.3).
// Consumed, not recomputed: the rate is a count of Lace's own per-call
// `booked` classification - this rule never reclassifies a call.
export async function evaluateBookingRateDecline(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [current, baseline, currentByCsr, baselineByCsr] = await Promise.all([
    bookingRateForWindow(database, window.periodStart, window.periodEnd),
    bookingRateForWindow(database, window.baselineStart, window.baselineEnd),
    bookingRateByCsrForWindow(database, window.periodStart, window.periodEnd),
    bookingRateByCsrForWindow(database, window.baselineStart, window.baselineEnd),
  ]);

  const findings: DetectedAlertFinding[] = [];

  const tenantFinding = buildFinding(TENANT_DIMENSION, window, current, baseline);
  if (tenantFinding) findings.push(tenantFinding);

  for (const [csr, csrCurrent] of currentByCsr) {
    if (csrCurrent.total < MIN_CSR_CALLS) continue;
    const csrFinding = buildFinding(csr, window, csrCurrent, baselineByCsr.get(csr));
    if (csrFinding) findings.push(csrFinding);
  }

  return findings;
}
