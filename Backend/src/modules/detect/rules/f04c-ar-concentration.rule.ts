import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const QBO_DIMENSION = 'QUICKBOOKS_TOTAL';

interface TopCustomerBalance {
  customerId: string;
  balance: number;
}

interface ConcentrationResult {
  totalOutstanding: number;
  topCustomer: TopCustomerBalance | null;
}

// F-04c is a point-in-time concentration check (unlike F-04/AR-aging, which
// is cohort-based) - there's no "baseline window" to compare against, since
// concentration is a snapshot of who currently holds the outstanding AR, not
// an event that happens within a date range. Evaluated once per Detect run,
// independent of the trailing-week window (periodStart/periodEnd are stamped
// for consistency with the detected_alerts schema, but aren't filter criteria).
async function qboConcentration(database: Knex): Promise<ConcentrationResult> {
  const totalRow: { total: string } = await database('unified_invoices')
    .where('balance', '>', 0)
    .select(database.raw('coalesce(sum(balance), 0) as total'))
    .first();
  const totalOutstanding = Number(totalRow.total);
  if (totalOutstanding <= 0) return { totalOutstanding: 0, topCustomer: null };

  const topRow: { unified_customer_id: string; balance: string } | undefined = await database('unified_invoices')
    .where('balance', '>', 0)
    .groupBy('unified_customer_id')
    .select('unified_customer_id', database.raw('sum(balance) as balance'))
    .orderBy('balance', 'desc')
    .first();
  if (!topRow) return { totalOutstanding, topCustomer: null };

  return { totalOutstanding, topCustomer: { customerId: topRow.unified_customer_id, balance: Number(topRow.balance) } };
}

// F-04c: flags when a single customer's outstanding QuickBooks receivable
// balance makes up an outsized share of total outstanding AR (SPEC-BI-001
// F-04c - AR concentration). ServiceTitan is not included: raw_st_invoices
// stores the customer as an opaque payload field with no FK, so "largest
// debtor" can't be grouped the same way without an extra join/ingestion step.
export async function evaluateArConcentration(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const { totalOutstanding, topCustomer } = await qboConcentration(database);
  if (!topCustomer || totalOutstanding < env.DETECT_F04C_AR_MIN_OUTSTANDING) return [];

  const concentrationShare = topCustomer.balance / totalOutstanding;
  if (concentrationShare * 100 < env.DETECT_F04C_AR_CONCENTRATION_THRESHOLD_POINTS) return [];

  return [{
    ruleCode: 'F-04c',
    dimension: QBO_DIMENSION,
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: null,
    baselineEnd: null,
    metricValue: concentrationShare,
    baselineValue: null,
    details: {
      topCustomerId: topCustomer.customerId,
      topCustomerBalance: topCustomer.balance,
      totalOutstandingBalance: totalOutstanding,
      thresholdPoints: env.DETECT_F04C_AR_CONCENTRATION_THRESHOLD_POINTS,
    },
  }];
}
