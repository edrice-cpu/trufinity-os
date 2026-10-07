import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const QBO_DIMENSION = 'QUICKBOOKS_TOTAL';
// Baseline window is 4 weeks (see trailingWeekWindow) - divide its total by 4
// to get a comparable per-week average against the current 7-day total.
const BASELINE_WEEKS = 4;

interface CreditMemoTotals {
  count: number;
  totalAmount: number;
}

async function creditMemoTotalsForWindow(database: Knex, start: Date, end: Date): Promise<CreditMemoTotals> {
  const row: { count: string; total_amount: string } = await database('raw_qbo_creditmemos')
    .where('is_latest', true)
    .andWhereRaw("(payload->>'TxnDate')::date >= ?", [start])
    .andWhereRaw("(payload->>'TxnDate')::date < ?", [end])
    .select(
      database.raw('count(*) as count'),
      database.raw("coalesce(sum((payload->>'TotalAmt')::numeric), 0) as total_amount"),
    )
    .first();
  return { count: Number(row.count), totalAmount: Number(row.total_amount) };
}

// F-04d: flags a spike in the total dollar amount of QuickBooks credit memos
// issued in the current 7-day window vs the trailing 4-week weekly average
// (SPEC-BI-001 F-04d). A sudden rise in credit memos can mean undisclosed
// refunds, pricing disputes, or write-offs eating into recognized revenue.
export async function evaluateCreditMemoSpike(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [current, baseline] = await Promise.all([
    creditMemoTotalsForWindow(database, window.periodStart, window.periodEnd),
    creditMemoTotalsForWindow(database, window.baselineStart, window.baselineEnd),
  ]);

  if (current.count < env.DETECT_F04D_CREDITMEMO_MIN_SAMPLE) return [];

  const baselineWeeklyAverage = baseline.totalAmount / BASELINE_WEEKS;
  // No baseline activity at all is a new pattern appearing, not a measurable
  // spike multiplier - skip rather than divide by zero.
  if (baselineWeeklyAverage <= 0) return [];

  const multiplier = current.totalAmount / baselineWeeklyAverage;
  if (multiplier < env.DETECT_F04D_CREDITMEMO_SPIKE_MULTIPLIER) return [];

  return [{
    ruleCode: 'F-04d',
    dimension: QBO_DIMENSION,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: window.baselineStart,
    baselineEnd: window.baselineEnd,
    metricValue: current.totalAmount,
    baselineValue: baselineWeeklyAverage,
    details: {
      currentCreditMemoCount: current.count,
      currentTotalAmount: current.totalAmount,
      baselineTotalAmount: baseline.totalAmount,
      baselineWeeklyAverage,
      multiplier,
      thresholdMultiplier: env.DETECT_F04D_CREDITMEMO_SPIKE_MULTIPLIER,
    },
  }];
}
