import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const QBO_DIMENSION = 'QUICKBOOKS_TOTAL';

interface DiscountCohort {
  invoiceCount: number;
  grossAmount: number;
  discountAmount: number;
}

// unified_invoices.total_amount is QuickBooks' TotalAmt, which is already
// net of any DiscountLineDetail lines - so "gross" (pre-discount) has to be
// reconstructed as total_amount + discount. See invoice.mapper.ts.
async function discountCohortForWindow(database: Knex, start: Date, end: Date): Promise<DiscountCohort> {
  const row: { invoice_count: string; gross_amount: string; discount_amount: string } = await database('unified_invoices')
    .andWhere('invoice_date', '>=', start)
    .andWhere('invoice_date', '<', end)
    .select(
      database.raw('count(*) as invoice_count'),
      database.raw('coalesce(sum(total_amount + discount), 0) as gross_amount'),
      database.raw('coalesce(sum(discount), 0) as discount_amount'),
    )
    .first();
  return {
    invoiceCount: Number(row.invoice_count),
    grossAmount: Number(row.gross_amount),
    discountAmount: Number(row.discount_amount),
  };
}

function discountRate(cohort: DiscountCohort): number | null {
  return cohort.grossAmount > 0 ? cohort.discountAmount / cohort.grossAmount : null;
}

// F-03: flags a rise in the aggregate discount-to-gross-revenue rate on
// QuickBooks invoices issued in the current 7-day window vs the trailing
// 4-week average - a proxy for discount leakage (SPEC-BI-001 F-03). Scoped to
// QuickBooks only: discount line-item detail comes from the QBO invoice
// mapper (DiscountLineDetail), ServiceTitan has no equivalent field ingested.
export async function evaluateDiscountLeakage(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [current, baseline] = await Promise.all([
    discountCohortForWindow(database, window.periodStart, window.periodEnd),
    discountCohortForWindow(database, window.baselineStart, window.baselineEnd),
  ]);

  if (current.invoiceCount < env.DETECT_F03_DISCOUNT_MIN_SAMPLE || baseline.invoiceCount < env.DETECT_F03_DISCOUNT_MIN_SAMPLE) return [];

  const currentRate = discountRate(current);
  const baselineRate = discountRate(baseline);
  if (currentRate === null || baselineRate === null) return [];

  const increasePoints = (currentRate - baselineRate) * 100;
  if (increasePoints < env.DETECT_F03_DISCOUNT_RATE_INCREASE_THRESHOLD_POINTS) return [];

  return [{
    ruleCode: 'F-03',
    dimension: QBO_DIMENSION,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: window.baselineStart,
    baselineEnd: window.baselineEnd,
    metricValue: currentRate,
    baselineValue: baselineRate,
    details: {
      currentInvoiceCount: current.invoiceCount,
      currentGrossAmount: current.grossAmount,
      currentDiscountAmount: current.discountAmount,
      baselineInvoiceCount: baseline.invoiceCount,
      baselineGrossAmount: baseline.grossAmount,
      baselineDiscountAmount: baseline.discountAmount,
      increasePoints,
      thresholdPoints: env.DETECT_F03_DISCOUNT_RATE_INCREASE_THRESHOLD_POINTS,
    },
  }];
}
