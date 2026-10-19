import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';
import { laceBookingCounts, laceBookingCountsByCsr, laceBookingRate, type LaceBookingCounts } from '../../lace/booking-rate';

const TENANT_DIMENSION = 'TENANT_TOTAL';
// Guards a per-CSR rate from being noisy at very low volume (e.g. one
// qualified call -> 0% or 100%). Not a spec-given number - an engineering
// safeguard, same rationale as D-06's minimum occurrence count.
const MIN_CSR_QUALIFIED_CALLS = 5;

// The trigger is the current rolling-7-day rate against the floor alone; the
// trailing 4-week rate is carried along only as context for the narrative.
function buildFinding(
  dimension: string,
  window: DetectionWindow,
  current: LaceBookingCounts,
  baseline: LaceBookingCounts | undefined,
): DetectedAlertFinding | null {
  const currentRate = laceBookingRate(current);
  if (currentRate === null) return null;
  if (currentRate * 100 >= env.DETECT_D01_BOOKING_RATE_FLOOR_PERCENT) return null;

  const baselineRate = laceBookingRate(baseline);
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
      currentQualifiedCalls: current.qualified,
      currentTotalCalls: current.totalCalls,
      ...(baselineRate === null ? {} : {
        baselineBookedCalls: baseline?.booked,
        baselineQualifiedCalls: baseline?.qualified,
        baselineTotalCalls: baseline?.totalCalls,
      }),
      floorPercent: env.DETECT_D01_BOOKING_RATE_FLOOR_PERCENT,
    },
  };
}

// D-01 (RED): booking rate as reported by Lace AI falls below the threshold
// on a rolling 7-day basis, overall or by CSR (SPEC-BI-001 Section 5.3).
// Consumed, not recomputed: the rate is Lace's own definition (booked /
// qualified - see lace/booking-rate.ts) applied to Lace's own per-call
// classifications, and is reconciled monthly against the figure Lace reports.
export async function evaluateBookingRateDecline(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [current, baseline, currentByCsr, baselineByCsr] = await Promise.all([
    laceBookingCounts(database, window.periodStart, window.periodEnd),
    laceBookingCounts(database, window.baselineStart, window.baselineEnd),
    laceBookingCountsByCsr(database, window.periodStart, window.periodEnd),
    laceBookingCountsByCsr(database, window.baselineStart, window.baselineEnd),
  ]);

  const findings: DetectedAlertFinding[] = [];

  const tenantFinding = buildFinding(TENANT_DIMENSION, window, current, baseline);
  if (tenantFinding) findings.push(tenantFinding);

  for (const [csr, csrCurrent] of currentByCsr) {
    if (csrCurrent.qualified < MIN_CSR_QUALIFIED_CALLS) continue;
    const csrFinding = buildFinding(csr, window, csrCurrent, baselineByCsr.get(csr));
    if (csrFinding) findings.push(csrFinding);
  }

  return findings;
}
