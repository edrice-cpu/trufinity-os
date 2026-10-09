import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const QBO_DIMENSION = 'QUICKBOOKS_TOTAL';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

// F-03 (AMBER): discounts as a percentage of gross revenue exceed the
// threshold, week over week (SPEC-BI-001 Section 5.1) - evaluated on each
// week's invoices against a fixed ceiling. The previous week's rate rides
// along as the baseline for context only; it doesn't change whether the rule
// fires. Scoped to QuickBooks: discount line-item detail comes from the QBO
// invoice mapper (DiscountLineDetail).
export async function evaluateDiscountLeakage(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const previousWeekStart = new Date(window.periodStart.getTime() - WEEK_MS);
  const [current, previousWeek] = await Promise.all([
    discountCohortForWindow(database, window.periodStart, window.periodEnd),
    discountCohortForWindow(database, previousWeekStart, window.periodStart),
  ]);

  if (current.invoiceCount < env.DETECT_F03_DISCOUNT_MIN_SAMPLE) return [];

  const currentRate = discountRate(current);
  if (currentRate === null) return [];
  if (currentRate * 100 <= env.DETECT_F03_DISCOUNT_RATE_THRESHOLD_PERCENT) return [];

  const previousRate = discountRate(previousWeek);
  return [{
    ruleCode: 'F-03',
    dimension: QBO_DIMENSION,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: previousRate === null ? null : previousWeekStart,
    baselineEnd: previousRate === null ? null : window.periodStart,
    metricValue: currentRate,
    baselineValue: previousRate,
    details: {
      currentInvoiceCount: current.invoiceCount,
      currentGrossAmount: current.grossAmount,
      currentDiscountAmount: current.discountAmount,
      previousWeekInvoiceCount: previousWeek.invoiceCount,
      previousWeekGrossAmount: previousWeek.grossAmount,
      previousWeekDiscountAmount: previousWeek.discountAmount,
      thresholdPercent: env.DETECT_F03_DISCOUNT_RATE_THRESHOLD_PERCENT,
    },
  }];
}
