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

function rate(counts: BookingCounts): number | null {
  return counts.total > 0 ? counts.booked / counts.total : null;
}

function buildFinding(
  dimension: string,
  window: DetectionWindow,
  current: BookingCounts,
  baseline: BookingCounts,
): DetectedAlertFinding | null {
  const currentRate = rate(current);
  const baselineRate = rate(baseline);
  if (currentRate === null || baselineRate === null) return null;

  const dropPoints = (baselineRate - currentRate) * 100;
  if (dropPoints < env.DETECT_D01_BOOKING_RATE_DROP_THRESHOLD_POINTS) return null;

  return {
    ruleCode: 'D-01',
    dimension,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: window.baselineStart,
    baselineEnd: window.baselineEnd,
    metricValue: currentRate,
    baselineValue: baselineRate,
    details: {
      currentBookedCalls: current.booked,
      currentTotalCalls: current.total,
      baselineBookedCalls: baseline.booked,
      baselineTotalCalls: baseline.total,
      dropPoints,
      thresholdPoints: env.DETECT_D01_BOOKING_RATE_DROP_THRESHOLD_POINTS,
    },
  };
}

// D-01: flags a booking rate decline vs. the trailing 4-week average, both
// tenant-wide and per CSR (SPEC-BI-001 Section 5.3: "overall or by CSR").
// Exact threshold TBD from the spec - see DETECT_D01_BOOKING_RATE_DROP_THRESHOLD_POINTS.
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
    const csrBaseline = baselineByCsr.get(csr);
    if (!csrBaseline || csrBaseline.total < MIN_CSR_CALLS) continue;

    const csrFinding = buildFinding(csr, window, csrCurrent, csrBaseline);
    if (csrFinding) findings.push(csrFinding);
  }

  return findings;
}
