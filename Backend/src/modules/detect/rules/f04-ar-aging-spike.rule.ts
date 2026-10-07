import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const QBO_DIMENSION = 'QUICKBOOKS_TOTAL';
const SERVICETITAN_DIMENSION = 'SERVICETITAN_TOTAL';
const ST_INVOICE_ACTIVE = `COALESCE((payload->>'active')::boolean, true) = true`;

interface CohortCounts {
  total: number;
  overdue: number;
  overdueBalance: number;
}

// Both unified_invoices (QuickBooks) and raw_st_invoices (ServiceTitan) only
// hold the invoice's CURRENT balance/status - there's no historical snapshot
// of what balance looked like 4 weeks ago. So instead of comparing a point-
// in-time AR total, this buckets invoices by their issue date into the same
// current-window / baseline-window cohorts the D-series rules use, and asks "of the
// invoices issued in this cohort, what share are now overdue and still
// unpaid (as observed right now)?" - a valid, comparable collection-health
// metric that doesn't require snapshot history.
async function qboCohort(database: Knex, start: Date, end: Date, now: Date): Promise<CohortCounts> {
  const row: { total: string; overdue: string; overdue_balance: string } = await database('unified_invoices')
    .andWhere('invoice_date', '>=', start)
    .andWhere('invoice_date', '<', end)
    .select(
      database.raw('count(*) as total'),
      database.raw("count(*) filter (where balance > 0 and due_date < ?) as overdue", [now]),
      database.raw("coalesce(sum(balance) filter (where balance > 0 and due_date < ?), 0) as overdue_balance", [now]),
    )
    .first();
  return { total: Number(row.total), overdue: Number(row.overdue), overdueBalance: Number(row.overdue_balance) };
}

async function servicetitanCohort(database: Knex, start: Date, end: Date, now: Date): Promise<CohortCounts> {
  const row: { total: string; overdue: string; overdue_balance: string } = await database('raw_st_invoices')
    .where('is_latest', true)
    .andWhereRaw(ST_INVOICE_ACTIVE)
    .andWhereRaw("(payload->>'invoiceDate')::date >= ?", [start])
    .andWhereRaw("(payload->>'invoiceDate')::date < ?", [end])
    .select(
      database.raw('count(*) as total'),
      database.raw("count(*) filter (where (payload->>'balance')::numeric > 0 and (payload->>'dueDate')::date < ?) as overdue", [now]),
      database.raw("coalesce(sum((payload->>'balance')::numeric) filter (where (payload->>'balance')::numeric > 0 and (payload->>'dueDate')::date < ?), 0) as overdue_balance", [now]),
    )
    .first();
  return { total: Number(row.total), overdue: Number(row.overdue), overdueBalance: Number(row.overdue_balance) };
}

function rate(counts: CohortCounts): number | null {
  return counts.total > 0 ? counts.overdue / counts.total : null;
}

function buildFinding(
  dimension: string,
  window: DetectionWindow,
  current: CohortCounts,
  baseline: CohortCounts,
): DetectedAlertFinding | null {
  if (current.total < env.DETECT_F04_AR_MIN_SAMPLE || baseline.total < env.DETECT_F04_AR_MIN_SAMPLE) return null;

  const currentRate = rate(current);
  const baselineRate = rate(baseline);
  if (currentRate === null || baselineRate === null) return null;

  const increasePoints = (currentRate - baselineRate) * 100;
  if (increasePoints < env.DETECT_F04_AR_OVERDUE_RATE_INCREASE_THRESHOLD_POINTS) return null;

  return {
    ruleCode: 'F-04',
    dimension,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: window.baselineStart,
    baselineEnd: window.baselineEnd,
    metricValue: currentRate,
    baselineValue: baselineRate,
    details: {
      currentOverdueInvoices: current.overdue,
      currentTotalInvoices: current.total,
      currentOverdueBalance: current.overdueBalance,
      baselineOverdueInvoices: baseline.overdue,
      baselineTotalInvoices: baseline.total,
      baselineOverdueBalance: baseline.overdueBalance,
      increasePoints,
      thresholdPoints: env.DETECT_F04_AR_OVERDUE_RATE_INCREASE_THRESHOLD_POINTS,
    },
  };
}

// F-04: flags a rise in the share of recently-issued invoices that are now
// overdue and unpaid, vs the trailing 4-week cohort average - evaluated
// separately for QuickBooks (unified_invoices) and ServiceTitan
// (raw_st_invoices), since they are not yet merged into one AR ledger.
export async function evaluateArAgingSpike(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const now = window.periodEnd;
  const [qboCurrent, qboBaseline, stCurrent, stBaseline] = await Promise.all([
    qboCohort(database, window.periodStart, window.periodEnd, now),
    qboCohort(database, window.baselineStart, window.baselineEnd, now),
    servicetitanCohort(database, window.periodStart, window.periodEnd, now),
    servicetitanCohort(database, window.baselineStart, window.baselineEnd, now),
  ]);

  const findings: DetectedAlertFinding[] = [];

  const qboFinding = buildFinding(QBO_DIMENSION, window, qboCurrent, qboBaseline);
  if (qboFinding) findings.push(qboFinding);

  const stFinding = buildFinding(SERVICETITAN_DIMENSION, window, stCurrent, stBaseline);
  if (stFinding) findings.push(stFinding);

  return findings;
}
