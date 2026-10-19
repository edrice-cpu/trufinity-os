import type { Knex } from 'knex';
import { db } from '../../database';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { laceBookingCountsByCsr, laceBookingRate } from './booking-rate';
import type { LaceAgentPerformanceRow } from './lace.types';

// Guards SPEC-BI-001 4.1 ("two booking-rate numbers in one company is worse
// than none"). D-01 applies Lace's booking-rate definition to Lace's per-call
// classifications daily; Lace separately reports its own monthly Success
// Ratio per CSR. This compares the two for every month Lace has reported, so
// any drift (a definition change on Lace's side, calls missing from the
// export) is caught instead of two different numbers quietly coexisting.
//
// Statuses:
//   MATCH                 - within tolerance
//   MISMATCH              - beyond tolerance (logged as a warning)
//   INCOMPLETE_CALL_DATA  - we hold < 95% of the qualified calls Lace counted
//                           for that CSR/month (e.g. call export started
//                           mid-month), so a comparison would be meaningless
//   NO_LACE_ACTIVITY      - Lace reports no qualified calls for that month
export type ReconciliationStatus = 'MATCH' | 'MISMATCH' | 'INCOMPLETE_CALL_DATA' | 'NO_LACE_ACTIVITY';

export interface BookingRateReconciliation {
  csr: string;
  periodStart: Date;
  periodEnd: Date;
  laceSuccessRatioPercent: number | null;
  laceBooked: number | null;
  laceQualified: number | null;
  ourBooked: number;
  ourQualified: number;
  ourRatePercent: number | null;
  differencePoints: number | null;
  status: ReconciliationStatus;
}

const MIN_CALL_COVERAGE = 0.95;

const toNumber = (value: string | undefined): number | null => {
  const cleaned = value?.trim().replace(/%$/, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

// The report's period timestamps have no zone; Lace's call export labels its
// UTC columns explicitly and these line up with them, so they're read as UTC.
const toUtcDate = (value: string): Date => new Date(`${value.trim().replace(' ', 'T')}Z`);

export async function reconcileLaceBookingRates(
  database: Knex = db,
  tolerancePoints: number = env.LACE_BOOKING_RATE_RECONCILIATION_TOLERANCE_POINTS,
): Promise<BookingRateReconciliation[]> {
  const rows: { payload: LaceAgentPerformanceRow }[] = await database('raw_lace_agent_performance')
    .where({ is_latest: true })
    .select('payload');

  const results: BookingRateReconciliation[] = [];
  for (const { payload } of rows) {
    const periodStart = toUtcDate(payload['Period Start']);
    const periodEnd = toUtcDate(payload['Period End']);
    if (Number.isNaN(periodStart.getTime()) || Number.isNaN(periodEnd.getTime())) continue;

    const laceQualified = toNumber(payload.Qualified);
    const laceBooked = toNumber(payload.Booked);
    const laceSuccessRatioPercent = toNumber(payload['Success Ratio']);

    // Period End is the last moment of the period, so include it.
    const ours = (await laceBookingCountsByCsr(database, periodStart, new Date(periodEnd.getTime() + 1))).get(payload.CSR);
    const ourQualified = ours?.qualified ?? 0;
    const ourBooked = ours?.booked ?? 0;
    const rate = laceBookingRate(ours);
    const ourRatePercent = rate === null ? null : rate * 100;

    let status: ReconciliationStatus;
    let differencePoints: number | null = null;
    if (!laceQualified) {
      status = 'NO_LACE_ACTIVITY';
    } else if (ourQualified < laceQualified * MIN_CALL_COVERAGE || ourRatePercent === null || laceSuccessRatioPercent === null) {
      status = 'INCOMPLETE_CALL_DATA';
    } else {
      differencePoints = ourRatePercent - laceSuccessRatioPercent;
      status = Math.abs(differencePoints) > tolerancePoints ? 'MISMATCH' : 'MATCH';
    }

    results.push({
      csr: payload.CSR, periodStart, periodEnd, laceSuccessRatioPercent, laceBooked, laceQualified,
      ourBooked, ourQualified, ourRatePercent, differencePoints, status,
    });
  }

  const mismatches = results.filter((r) => r.status === 'MISMATCH');
  for (const m of mismatches) {
    logger.warn('[LaceAI] Booking rate differs from Lace\'s reported Success Ratio beyond tolerance', {
      csr: m.csr,
      periodStart: m.periodStart.toISOString(),
      laceSuccessRatioPercent: m.laceSuccessRatioPercent,
      ourRatePercent: m.ourRatePercent,
      differencePoints: m.differencePoints,
      tolerancePoints,
    });
  }
  logger.info('[LaceAI] Booking rate reconciliation completed', {
    compared: results.length,
    match: results.filter((r) => r.status === 'MATCH').length,
    mismatch: mismatches.length,
    incompleteCallData: results.filter((r) => r.status === 'INCOMPLETE_CALL_DATA').length,
    noLaceActivity: results.filter((r) => r.status === 'NO_LACE_ACTIVITY').length,
  });
  return results;
}
