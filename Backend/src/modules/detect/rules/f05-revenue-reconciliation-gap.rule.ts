import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const TENANT_DIMENSION = 'TENANT_TOTAL';
const ST_INVOICE_ACTIVE = `COALESCE((payload->>'active')::boolean, true) = true`;

async function qboRevenueForWindow(database: Knex, start: Date, end: Date): Promise<number> {
  const row: { total: string } = await database('unified_invoices')
    .andWhere('invoice_date', '>=', start)
    .andWhere('invoice_date', '<', end)
    .select(database.raw('coalesce(sum(total_amount), 0) as total'))
    .first();
  return Number(row.total);
}

async function serviceTitanRevenueForWindow(database: Knex, start: Date, end: Date): Promise<number> {
  const row: { total: string } = await database('raw_st_invoices')
    .where('is_latest', true)
    .andWhereRaw(ST_INVOICE_ACTIVE)
    .andWhereRaw("(payload->>'invoiceDate')::date >= ?", [start])
    .andWhereRaw("(payload->>'invoiceDate')::date < ?", [end])
    .select(database.raw("coalesce(sum((payload->>'total')::numeric), 0) as total"))
    .first();
  return Number(row.total);
}

// F-05: flags a gap between ServiceTitan's and QuickBooks' recorded revenue
// for invoices issued in the current 7-day window (SPEC-BI-001 F-05 -
// "revenue reconciliation gap"). ServiceTitan is the operational system of
// record for jobs/invoices; QuickBooks is supposed to reconcile against it
// (see BACKEND_BUILD_GUIDE.md Section 1.2). This is a point-in-time check on
// the current window, not a trend vs. a baseline - the two sources should
// always agree, so any single window with a large gap is itself the finding,
// not a departure from a historical pattern. There is no invoice-level link
// between the two systems yet (only a customer-level identity mapping
// exists - see src/modules/identity/), so this compares aggregate totals
// rather than matching individual transactions.
export async function evaluateRevenueReconciliationGap(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [qboRevenue, stRevenue] = await Promise.all([
    qboRevenueForWindow(database, window.periodStart, window.periodEnd),
    serviceTitanRevenueForWindow(database, window.periodStart, window.periodEnd),
  ]);

  if (stRevenue < env.DETECT_F05_MIN_REVENUE) return [];

  const gapAmount = stRevenue - qboRevenue;
  const gapShare = Math.abs(gapAmount) / stRevenue;
  if (gapShare * 100 < env.DETECT_F05_REVENUE_GAP_THRESHOLD_POINTS) return [];

  return [{
    ruleCode: 'F-05',
    dimension: TENANT_DIMENSION,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: null,
    baselineEnd: null,
    metricValue: gapShare,
    baselineValue: null,
    details: {
      quickbooksRevenue: qboRevenue,
      serviceTitanRevenue: stRevenue,
      gapAmount,
      thresholdPoints: env.DETECT_F05_REVENUE_GAP_THRESHOLD_POINTS,
    },
  }];
}
