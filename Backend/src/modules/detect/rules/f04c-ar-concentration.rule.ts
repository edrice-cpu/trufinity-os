import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const TOP_N = 5;

interface CustomerBalance {
  customerId: string;
  customerName: string | null;
  balance: number;
}

// Outstanding QuickBooks AR per customer, largest first.
async function customerBalances(database: Knex): Promise<CustomerBalance[]> {
  const rows: { unified_customer_id: string; name: string | null; balance: string }[] = await database('unified_invoices as i')
    .leftJoin('unified_customers as c', 'c.id', 'i.unified_customer_id')
    .where('i.balance', '>', 0)
    .groupBy('i.unified_customer_id', 'c.name')
    .select('i.unified_customer_id', 'c.name', database.raw('sum(i.balance) as balance'))
    .orderBy([{ column: 'balance', order: 'desc' }, { column: 'i.unified_customer_id', order: 'asc' }]);
  return rows.map((row) => ({ customerId: row.unified_customer_id, customerName: row.name, balance: Number(row.balance) }));
}

// F-04c (AMBER): large-balance concentration - any single customer balance
// above threshold, OR the top five balances exceeding a set share of total AR
// (SPEC-BI-001 Section 5.1). A point-in-time snapshot of who holds the
// outstanding AR today, so there's no baseline window; periodStart/End are
// stamped for the detected_alerts schema, not used as filters. QuickBooks
// only - it's the financial truth for AR, and alerting the same debt from
// ServiceTitan too would double-report the same customer.
export async function evaluateArConcentration(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const balances = await customerBalances(database);
  const totalOutstanding = balances.reduce((sum, customer) => sum + customer.balance, 0);
  const findings: DetectedAlertFinding[] = [];

  for (const customer of balances) {
    if (customer.balance <= env.DETECT_F04C_SINGLE_BALANCE_THRESHOLD) break;
    findings.push({
      ruleCode: 'F-04c',
      dimension: customer.customerName ?? customer.customerId,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      baselineStart: null,
      baselineEnd: null,
      metricValue: customer.balance,
      baselineValue: null,
      details: {
        trigger: 'SINGLE_BALANCE',
        customerId: customer.customerId,
        customerName: customer.customerName,
        customerBalance: customer.balance,
        totalOutstandingBalance: totalOutstanding,
        thresholdAmount: env.DETECT_F04C_SINGLE_BALANCE_THRESHOLD,
      },
    });
  }

  // With TOP_N customers or fewer the "top five" is the whole book (always
  // 100%) - only meaningful once there are more customers than that.
  if (balances.length > TOP_N && totalOutstanding >= env.DETECT_F04C_AR_MIN_OUTSTANDING) {
    const top = balances.slice(0, TOP_N);
    const topBalance = top.reduce((sum, customer) => sum + customer.balance, 0);
    const topSharePercent = (topBalance / totalOutstanding) * 100;
    if (topSharePercent > env.DETECT_F04C_TOP5_SHARE_THRESHOLD_PERCENT) {
      findings.push({
        ruleCode: 'F-04c',
        dimension: 'QuickBooks - top 5 customer balances',
        periodStart: window.periodStart,
        periodEnd: window.periodEnd,
        baselineStart: null,
        baselineEnd: null,
        metricValue: topBalance,
        baselineValue: totalOutstanding,
        details: {
          trigger: 'TOP_FIVE_SHARE',
          topCustomerCount: top.length,
          topCustomers: top.map((customer) => ({ customerId: customer.customerId, customerName: customer.customerName, balance: customer.balance })),
          topBalance,
          totalOutstandingBalance: totalOutstanding,
          topSharePercent,
          thresholdPercent: env.DETECT_F04C_TOP5_SHARE_THRESHOLD_PERCENT,
        },
      });
    }
  }

  return findings;
}
