import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const BRACKETS = [30, 60, 90];
const MAX_LISTED_INVOICES = 20;
const ST_INVOICE_ACTIVE = `COALESCE((payload->>'active')::boolean, true) = true`;

type Source = 'QuickBooks' | 'ServiceTitan';

interface BracketCrossing {
  source: Source;
  bracket: number;
  crossedOn: Date;
  invoiceId: string;
  reference: string | null;
  customerName: string | null;
  balance: number;
}

// Dates come back as UTC midnight timestamps (not bare DATEs, which node-pg
// turns into local-midnight Dates that shift a day in non-UTC timezones).
// An open invoice "crosses" bracket N on the day it becomes N days past due:
// due date + N (invoice date when there is no due date). Only invoices that
// still carry a balance today count - one paid before it aged doesn't.
async function qboCrossings(database: Knex, start: Date, end: Date): Promise<BracketCrossing[]> {
  const result = await database.raw<{ rows: { bracket: number; crossed_on: Date; invoice_id: string; reference: string | null; customer_name: string | null; balance: string }[] }>(`
    SELECT b.bracket,
           ((COALESCE(i.due_date, i.invoice_date) + b.bracket)::timestamp AT TIME ZONE 'UTC') AS crossed_on,
           i.id AS invoice_id,
           i.source_specific_data->'quickbooks'->>'DocNumber' AS reference,
           c.name AS customer_name,
           i.balance
    FROM unified_invoices i
    CROSS JOIN unnest(?::int[]) AS b(bracket)
    LEFT JOIN unified_customers c ON c.id = i.unified_customer_id
    WHERE i.balance > 0
      AND COALESCE(i.due_date, i.invoice_date) + b.bracket >= ?
      AND COALESCE(i.due_date, i.invoice_date) + b.bracket < ?`, [BRACKETS, start, end]);
  return result.rows.map((row) => ({
    source: 'QuickBooks' as const,
    bracket: Number(row.bracket),
    crossedOn: new Date(row.crossed_on),
    invoiceId: row.invoice_id,
    reference: row.reference,
    customerName: row.customer_name,
    balance: Number(row.balance),
  }));
}

async function serviceTitanCrossings(database: Knex, start: Date, end: Date): Promise<BracketCrossing[]> {
  const result = await database.raw<{ rows: { bracket: number; crossed_on: Date; invoice_id: string; reference: string | null; customer_name: string | null; balance: string }[] }>(`
    SELECT b.bracket,
           ((COALESCE((payload->>'dueDate')::date, (payload->>'invoiceDate')::date) + b.bracket)::timestamp AT TIME ZONE 'UTC') AS crossed_on,
           source_id AS invoice_id,
           payload->>'referenceNumber' AS reference,
           payload->'customer'->>'name' AS customer_name,
           (payload->>'balance')::numeric AS balance
    FROM raw_st_invoices
    CROSS JOIN unnest(?::int[]) AS b(bracket)
    WHERE is_latest = true
      AND ${ST_INVOICE_ACTIVE}
      AND (payload->>'balance')::numeric > 0
      AND COALESCE((payload->>'dueDate')::date, (payload->>'invoiceDate')::date) + b.bracket >= ?
      AND COALESCE((payload->>'dueDate')::date, (payload->>'invoiceDate')::date) + b.bracket < ?`, [BRACKETS, start, end]);
  return result.rows.map((row) => ({
    source: 'ServiceTitan' as const,
    bracket: Number(row.bracket),
    crossedOn: new Date(row.crossed_on),
    invoiceId: row.invoice_id,
    reference: row.reference,
    customerName: row.customer_name,
    balance: Number(row.balance),
  }));
}

// One finding per source + bracket + crossing day. period_start is that day,
// so the daily Detect run (whose trailing window overlaps the previous day's)
// updates the same rows instead of re-raising yesterday's crossings.
function crossingFindings(crossings: BracketCrossing[], window: DetectionWindow): DetectedAlertFinding[] {
  const groups = new Map<string, BracketCrossing[]>();
  for (const crossing of crossings) {
    const key = `${crossing.source}|${crossing.bracket}|${crossing.crossedOn.toISOString()}`;
    groups.set(key, [...(groups.get(key) ?? []), crossing]);
  }

  return [...groups.values()].map((group) => {
    const { source, bracket, crossedOn } = group[0];
    const sorted = [...group].sort((a, b) => b.balance - a.balance || a.invoiceId.localeCompare(b.invoiceId));
    const totalBalance = group.reduce((sum, crossing) => sum + crossing.balance, 0);
    return {
      ruleCode: 'F-04',
      dimension: `${source} - crossed ${bracket} days past due`,
      periodStart: crossedOn,
      periodEnd: window.periodEnd,
      baselineStart: null,
      baselineEnd: null,
      metricValue: totalBalance,
      baselineValue: null,
      details: {
        trigger: 'BRACKET_CROSSING',
        source,
        bracketDays: bracket,
        crossedOn: crossedOn.toISOString().slice(0, 10),
        invoiceCount: group.length,
        totalBalance,
        invoices: sorted.slice(0, MAX_LISTED_INVOICES).map((crossing) => ({
          invoiceId: crossing.invoiceId,
          reference: crossing.reference,
          customerName: crossing.customerName,
          balance: crossing.balance,
        })),
      },
    };
  });
}

// QuickBooks AR as it stood at `asOf`: everything invoiced before then, less
// payments dated before then that were applied to those invoices. Rebuilt
// from history because unified_invoices only holds today's balance. Credit
// memos applied against invoices aren't in unified_payment_applications, so
// this slightly overstates AR - the same way at both points being compared.
async function qboArAsOf(database: Knex, asOf: Date): Promise<number> {
  const result = await database.raw<{ rows: { ar: string }[] }>(`
    SELECT
      (SELECT COALESCE(SUM(total_amount), 0) FROM unified_invoices WHERE invoice_date < ?)
      -
      (SELECT COALESCE(SUM(a.applied_amount), 0)
         FROM unified_payment_applications a
         JOIN unified_payments p ON p.id = a.payment_id
         JOIN unified_invoices i ON i.id = a.invoice_id
        WHERE p.payment_date < ? AND i.invoice_date < ?) AS ar`, [asOf, asOf, asOf]);
  return Number(result.rows[0].ar);
}

async function arGrowthFinding(database: Knex, window: DetectionWindow): Promise<DetectedAlertFinding | null> {
  const [arAtStart, arAtEnd] = await Promise.all([
    qboArAsOf(database, window.periodStart),
    qboArAsOf(database, window.periodEnd),
  ]);
  if (arAtStart <= 0) return null;

  const growthAmount = arAtEnd - arAtStart;
  const growthPercent = (growthAmount / arAtStart) * 100;
  if (growthPercent < env.DETECT_F04_AR_GROWTH_THRESHOLD_PERCENT) return null;

  return {
    ruleCode: 'F-04',
    dimension: 'QuickBooks - total AR growth',
    periodStart: window.periodStart,
    periodEnd: window.periodEnd,
    baselineStart: null,
    baselineEnd: null,
    metricValue: arAtEnd,
    baselineValue: arAtStart,
    details: {
      trigger: 'AR_GROWTH',
      source: 'QuickBooks',
      arAtPeriodStart: arAtStart,
      arAtPeriodEnd: arAtEnd,
      growthAmount,
      growthPercent,
      thresholdPercent: env.DETECT_F04_AR_GROWTH_THRESHOLD_PERCENT,
    },
  };
}

// F-04 (AMBER): AR aging deterioration - any balance crossing a 30 / 60 /
// 90-day bracket, or total AR growth beyond threshold (SPEC-BI-001 Section
// 5.1). Bracket crossings are checked in both QuickBooks (unified_invoices)
// and ServiceTitan (raw_st_invoices), since they are not merged into one AR
// ledger yet; AR growth is QuickBooks only (the financial truth, and the one
// with payment history to rebuild a prior-date balance from).
export async function evaluateArAgingSpike(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [qbo, st, growth] = await Promise.all([
    qboCrossings(database, window.periodStart, window.periodEnd),
    serviceTitanCrossings(database, window.periodStart, window.periodEnd),
    arGrowthFinding(database, window),
  ]);

  return [...crossingFindings([...qbo, ...st], window), ...(growth ? [growth] : [])];
}
