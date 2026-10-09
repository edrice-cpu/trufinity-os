import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

type Kind = 'CREDIT_MEMO' | 'ADJUSTMENT_INVOICE' | 'INVOICE_REDUCTION';
type Source = 'QuickBooks' | 'ServiceTitan';

interface CreditEvent {
  kind: Kind;
  source: Source;
  sourceId: string;
  reference: string | null;
  customerName: string | null;
  occurredAt: Date;
  amount: number;
  previousTotal?: number;
  newTotal?: number;
}

const KIND_LABEL: Record<Kind, string> = {
  CREDIT_MEMO: 'credit memo',
  ADJUSTMENT_INVOICE: 'adjustment invoice',
  INVOICE_REDUCTION: 'invoice reduced',
};

interface EventRow {
  source_id: string;
  reference: string | null;
  customer_name: string | null;
  occurred_at: Date;
  amount: string;
  previous_total?: string;
  new_total?: string;
}

function toEvents(kind: Kind, source: Source, rows: EventRow[]): CreditEvent[] {
  return rows.map((row) => ({
    kind,
    source,
    sourceId: row.source_id,
    reference: row.reference,
    customerName: row.customer_name,
    occurredAt: new Date(row.occurred_at),
    amount: Number(row.amount),
    ...(row.previous_total === undefined ? {} : { previousTotal: Number(row.previous_total), newTotal: Number(row.new_total) }),
  }));
}

// QuickBooks credit memos issued (TxnDate) in the window. Dates are returned
// as UTC-midnight timestamps so they don't shift a day in non-UTC timezones.
async function qboCreditMemos(database: Knex, start: Date, end: Date, minAmount: number): Promise<CreditEvent[]> {
  const result = await database.raw<{ rows: EventRow[] }>(`
    SELECT source_id,
           payload->>'DocNumber' AS reference,
           payload->'CustomerRef'->>'name' AS customer_name,
           (payload->>'TxnDate')::date::timestamp AT TIME ZONE 'UTC' AS occurred_at,
           (payload->>'TotalAmt')::numeric AS amount
    FROM raw_qbo_creditmemos
    WHERE is_latest = true
      AND (payload->>'TxnDate')::date >= ? AND (payload->>'TxnDate')::date < ?
      AND (payload->>'TotalAmt')::numeric >= ?`, [start, end, minAmount]);
  return toEvents('CREDIT_MEMO', 'QuickBooks', result.rows);
}

// ServiceTitan adjustment invoices: an invoice that points at the one it
// adjusts (adjustmentToId) with a negative total - a credit against it.
async function serviceTitanAdjustments(database: Knex, start: Date, end: Date, minAmount: number): Promise<CreditEvent[]> {
  const result = await database.raw<{ rows: EventRow[] }>(`
    SELECT source_id,
           payload->>'referenceNumber' AS reference,
           payload->'customer'->>'name' AS customer_name,
           (payload->>'invoiceDate')::date::timestamp AT TIME ZONE 'UTC' AS occurred_at,
           -((payload->>'total')::numeric) AS amount
    FROM raw_st_invoices
    WHERE is_latest = true
      AND COALESCE((payload->>'active')::boolean, true) = true
      AND payload->>'adjustmentToId' IS NOT NULL
      AND (payload->>'total')::numeric < 0
      AND (payload->>'invoiceDate')::date >= ? AND (payload->>'invoiceDate')::date < ?
      AND -((payload->>'total')::numeric) >= ?`, [start, end, minAmount]);
  return toEvents('ADJUSTMENT_INVOICE', 'ServiceTitan', result.rows);
}

// An invoice whose total dropped between two consecutive raw versions - the
// raw layer is append-only, so every earlier version is still there to
// compare against. occurred_at is when the reduced version was ingested.
async function invoiceReductions(
  database: Knex, table: 'raw_qbo_invoices' | 'raw_st_invoices', source: Source, start: Date, end: Date, minAmount: number,
): Promise<CreditEvent[]> {
  const totalField = source === 'QuickBooks' ? 'TotalAmt' : 'total';
  const referenceExpr = source === 'QuickBooks' ? "payload->>'DocNumber'" : "payload->>'referenceNumber'";
  const customerExpr = source === 'QuickBooks' ? "payload->'CustomerRef'->>'name'" : "payload->'customer'->>'name'";
  const result = await database.raw<{ rows: EventRow[] }>(`
    WITH versions AS (
      SELECT source_id, ingested_at,
             ${referenceExpr} AS reference,
             ${customerExpr} AS customer_name,
             (payload->>'${totalField}')::numeric AS total,
             lag((payload->>'${totalField}')::numeric) OVER (PARTITION BY source_id ORDER BY ingested_at) AS previous_total
      FROM ${table}
    )
    SELECT source_id, reference, customer_name, ingested_at AS occurred_at,
           previous_total - total AS amount, previous_total, total AS new_total
    FROM versions
    WHERE previous_total IS NOT NULL
      AND ingested_at >= ? AND ingested_at < ?
      AND previous_total - total >= ?`, [start, end, minAmount]);
  return toEvents('INVOICE_REDUCTION', source, result.rows);
}

// F-04d (RED): credit memo or write-down issued - any credit, refund, or
// invoice reduction above threshold (SPEC-BI-001 Section 5.1; frequently the
// financial fingerprint of an unhappy customer). One finding per event.
// period_start is the event's own date, so the overlapping daily Detect
// windows update the same alert rather than raising it again. Refunds paid
// out as QuickBooks RefundReceipts aren't ingested yet, so aren't covered.
export async function evaluateCreditOrWriteDown(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const min = env.DETECT_F04D_MIN_AMOUNT;
  const { periodStart: start, periodEnd: end } = window;
  const events = (await Promise.all([
    qboCreditMemos(database, start, end, min),
    serviceTitanAdjustments(database, start, end, min),
    invoiceReductions(database, 'raw_qbo_invoices', 'QuickBooks', start, end, min),
    invoiceReductions(database, 'raw_st_invoices', 'ServiceTitan', start, end, min),
  ])).flat();

  return events.map((event) => ({
    ruleCode: 'F-04d',
    dimension: `${event.source} ${KIND_LABEL[event.kind]} #${event.reference ?? event.sourceId}`,
    periodStart: event.occurredAt,
    periodEnd: end,
    baselineStart: null,
    baselineEnd: null,
    metricValue: event.amount,
    baselineValue: null,
    details: {
      kind: event.kind,
      source: event.source,
      sourceId: event.sourceId,
      reference: event.reference,
      customerName: event.customerName,
      amount: event.amount,
      ...(event.previousTotal === undefined ? {} : { previousTotal: event.previousTotal, newTotal: event.newTotal }),
      thresholdAmount: min,
    },
  }));
}
