import type { Knex } from 'knex';
import { db } from '../../database';
import { defaultDateRangeFilter, type DateRangeFilter, type ServiceTitanDepartment } from '../../utils/dashboard-filters';
import type {
  CountByLabel,
  Paginated,
  StAppointmentsSummary,
  StArAgingBucket,
  StCustomersSummary,
  StInvoiceListItem,
  StInvoicesSummary,
  StJobListItem,
  StJobsSummary,
  StLeadsBookingsSummary,
  StPaymentsSummary,
  StSyncStatusRow,
  StTechnicianSummaryRow,
} from './servicetitan-reporting.types';

interface RawResult<T> { rows: T[] }

const readRows = async <T>(database: Knex, sql: string, bindings: readonly Knex.RawBinding[] = []): Promise<T[]> => {
  const result = await database.raw(sql, bindings) as unknown as RawResult<T>;
  return Array.isArray(result.rows) ? result.rows : [];
};

const count = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const money = (value: unknown): string => (typeof value === 'string' ? value : '0.00');
const nullableString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const toIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

const toLabelCounts = (rows: Record<string, unknown>[]): CountByLabel[] =>
  rows.map((r) => ({ label: nullableString(r.label) ?? 'UNKNOWN', count: count(r.count) }));

// ServiceTitan payload fields are read straight from the raw jsonb - only the latest version of each record.
const ST_INVOICE_ACTIVE = `COALESCE((payload->>'active')::boolean, true) = true`;

export class KnexServiceTitanReportingRepository {
  public constructor(private readonly database: Knex = db) {}

  // Date filters on createdOn (when the job entered the pipeline, not when it
  // closed) - this is a dashboard "activity this period" view. Department is
  // optional (omitted = all jobs, no department filter); when given, it
  // resolves payload->>'businessUnitId' against raw_st_business_units.name.
  // A job whose business unit hasn't been ingested yet (or has none) is
  // excluded from every department slice rather than silently miscounted
  // into "Company" - see business-unit.ingestion.ts.
  public async getJobsSummary(
    dateRange: DateRangeFilter = defaultDateRangeFilter(),
    department?: ServiceTitanDepartment,
  ): Promise<StJobsSummary> {
    const scoped = `
      SELECT j.payload AS payload
      FROM raw_st_jobs j
      ${department ? `JOIN raw_st_business_units bu ON bu.is_latest = true AND bu.source_id = j.payload->>'businessUnitId'` : ''}
      WHERE j.is_latest = true
        AND (j.payload->>'createdOn')::timestamptz >= ? AND (j.payload->>'createdOn')::timestamptz < ?
        ${department ? `AND bu.payload->>'name' = ?` : ''}
    `;
    const bindings: Knex.RawBinding[] = [dateRange.from.toISOString(), dateRange.to.toISOString(), ...(department ? [department] : [])];
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      WITH scoped AS (${scoped})
      SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE payload->>'jobStatus' = 'Completed')::int AS completed_jobs,
        COUNT(*) FILTER (WHERE payload->>'jobStatus' = 'Completed'
          AND (payload->>'completedOn')::timestamptz >= now() - interval '30 days')::int AS completed_last_30_days,
        COUNT(*) FILTER (WHERE (payload->>'createdOn')::timestamptz >= now() - interval '30 days')::int AS created_last_30_days,
        COUNT(*) FILTER (WHERE COALESCE((payload->>'noCharge')::boolean, false))::int AS no_charge_jobs,
        COUNT(*) FILTER (WHERE payload->>'recallForId' IS NOT NULL)::int AS recall_jobs,
        COUNT(*) FILTER (WHERE payload->>'jobStatus' = 'Completed' AND payload->>'invoiceId' IS NULL
          AND NOT COALESCE((payload->>'noCharge')::boolean, false))::int AS completed_not_invoiced,
        COALESCE(SUM((payload->>'total')::numeric), 0)::numeric AS jobs_total_value
      FROM scoped
    `, bindings);
    const byStatus = await readRows<Record<string, unknown>>(this.database, `
      WITH scoped AS (${scoped})
      SELECT COALESCE(payload->>'jobStatus', 'UNKNOWN') AS label, COUNT(*)::int AS count
      FROM scoped GROUP BY 1 ORDER BY 2 DESC
    `, bindings);
    return {
      totalJobs: count(row?.total_jobs),
      completedJobs: count(row?.completed_jobs),
      completedLast30Days: count(row?.completed_last_30_days),
      createdLast30Days: count(row?.created_last_30_days),
      noChargeJobs: count(row?.no_charge_jobs),
      recallJobs: count(row?.recall_jobs),
      completedNotInvoiced: count(row?.completed_not_invoiced),
      jobsTotalValue: money(row?.jobs_total_value),
      byStatus: toLabelCounts(byStatus),
    };
  }

  public async getInvoicesSummary(): Promise<StInvoicesSummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        COUNT(*)::int AS total_active_invoices,
        COUNT(*) FILTER (WHERE (payload->>'total')::numeric > 0 AND (payload->>'balance')::numeric = 0)::int AS paid_count,
        COUNT(*) FILTER (WHERE (payload->>'total')::numeric > 0 AND (payload->>'balance')::numeric > 0
          AND (payload->>'balance')::numeric < (payload->>'total')::numeric)::int AS partially_paid_count,
        COUNT(*) FILTER (WHERE (payload->>'total')::numeric > 0 AND (payload->>'balance')::numeric >= (payload->>'total')::numeric)::int AS unpaid_count,
        COALESCE(SUM((payload->>'total')::numeric), 0)::numeric AS invoice_total,
        COALESCE(SUM((payload->>'balance')::numeric) FILTER (WHERE (payload->>'balance')::numeric > 0), 0)::numeric AS outstanding_balance,
        COALESCE(SUM((payload->>'discountTotal')::numeric), 0)::numeric AS total_discount,
        COALESCE(SUM((payload->>'salesTax')::numeric), 0)::numeric AS total_sales_tax,
        COALESCE(SUM((payload->>'total')::numeric) FILTER (WHERE (payload->>'invoiceDate')::date >= current_date - 30), 0)::numeric AS invoiced_last_30_days,
        COUNT(*) FILTER (WHERE (payload->>'balance')::numeric > 0 AND (payload->>'dueDate')::date < current_date)::int AS overdue_count
      FROM raw_st_invoices WHERE is_latest = true AND ${ST_INVOICE_ACTIVE}
    `);
    return {
      totalActiveInvoices: count(row?.total_active_invoices),
      paidCount: count(row?.paid_count),
      partiallyPaidCount: count(row?.partially_paid_count),
      unpaidCount: count(row?.unpaid_count),
      invoiceTotal: money(row?.invoice_total),
      outstandingBalance: money(row?.outstanding_balance),
      totalDiscount: money(row?.total_discount),
      totalSalesTax: money(row?.total_sales_tax),
      invoicedLast30Days: money(row?.invoiced_last_30_days),
      overdueCount: count(row?.overdue_count),
    };
  }

  public async getArAging(): Promise<StArAgingBucket[]> {
    const rows = await readRows<Record<string, unknown>>(this.database, `
      WITH open AS (
        SELECT (payload->>'balance')::numeric AS balance,
               current_date - COALESCE((payload->>'dueDate')::date, (payload->>'invoiceDate')::date) AS days_past_due
        FROM raw_st_invoices
        WHERE is_latest = true AND ${ST_INVOICE_ACTIVE} AND (payload->>'balance')::numeric > 0
      )
      SELECT bucket, COUNT(*)::int AS invoice_count, COALESCE(SUM(balance), 0)::numeric AS balance FROM (
        SELECT balance, CASE
          WHEN days_past_due IS NULL OR days_past_due <= 0 THEN 'CURRENT'
          WHEN days_past_due <= 30 THEN 'DAYS_1_30'
          WHEN days_past_due <= 60 THEN 'DAYS_31_60'
          WHEN days_past_due <= 90 THEN 'DAYS_61_90'
          ELSE 'DAYS_90_PLUS' END AS bucket FROM open
      ) b GROUP BY bucket
    `);
    const order: StArAgingBucket['bucket'][] = ['CURRENT', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'DAYS_90_PLUS'];
    return order.map((bucket) => {
      const found = rows.find((r) => r.bucket === bucket);
      return { bucket, invoiceCount: count(found?.invoice_count), balance: money(found?.balance) };
    });
  }

  public async getPaymentsSummary(): Promise<StPaymentsSummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        COUNT(*)::int AS payment_count,
        COALESCE(SUM((payload->>'total')::numeric), 0)::numeric AS payment_total,
        COALESCE(SUM((payload->>'unappliedAmount')::numeric), 0)::numeric AS unapplied_total,
        COALESCE(SUM((payload->>'total')::numeric) FILTER (WHERE (payload->>'date')::date >= current_date - 30), 0)::numeric AS received_last_30_days
      FROM raw_st_payments WHERE is_latest = true AND COALESCE((payload->>'active')::boolean, true) = true
    `);
    const byType = await readRows<Record<string, unknown>>(this.database, `
      SELECT COALESCE(payload->>'type', 'UNKNOWN') AS label, COUNT(*)::int AS count,
             COALESCE(SUM((payload->>'total')::numeric), 0)::numeric AS total
      FROM raw_st_payments WHERE is_latest = true AND COALESCE((payload->>'active')::boolean, true) = true
      GROUP BY 1 ORDER BY 3 DESC
    `);
    return {
      paymentCount: count(row?.payment_count),
      paymentTotal: money(row?.payment_total),
      unappliedTotal: money(row?.unapplied_total),
      receivedLast30Days: money(row?.received_last_30_days),
      byType: byType.map((r) => ({ label: nullableString(r.label) ?? 'UNKNOWN', count: count(r.count), total: money(r.total) })),
    };
  }

  public async getLeadsBookingsSummary(): Promise<StLeadsBookingsSummary> {
    const [leads] = await readRows<Record<string, unknown>>(this.database, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE (payload->>'createdOn')::timestamptz >= now() - interval '30 days')::int AS last_30
      FROM raw_st_leads WHERE is_latest = true
    `);
    const leadsByStatus = await readRows<Record<string, unknown>>(this.database, `
      SELECT COALESCE(payload->>'status', 'UNKNOWN') AS label, COUNT(*)::int AS count
      FROM raw_st_leads WHERE is_latest = true GROUP BY 1 ORDER BY 2 DESC
    `);
    const [bookings] = await readRows<Record<string, unknown>>(this.database, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE (payload->>'createdOn')::timestamptz >= now() - interval '30 days')::int AS last_30,
             COUNT(*) FILTER (WHERE payload->>'jobId' IS NOT NULL)::int AS converted
      FROM raw_st_bookings WHERE is_latest = true
    `);
    const bookingsByStatus = await readRows<Record<string, unknown>>(this.database, `
      SELECT COALESCE(payload->>'status', 'UNKNOWN') AS label, COUNT(*)::int AS count
      FROM raw_st_bookings WHERE is_latest = true GROUP BY 1 ORDER BY 2 DESC
    `);
    return {
      totalLeads: count(leads?.total),
      leadsLast30Days: count(leads?.last_30),
      leadsByStatus: toLabelCounts(leadsByStatus),
      totalBookings: count(bookings?.total),
      bookingsLast30Days: count(bookings?.last_30),
      bookingsByStatus: toLabelCounts(bookingsByStatus),
      bookingsConvertedToJob: count(bookings?.converted),
    };
  }

  public async getAppointmentsSummary(): Promise<StAppointmentsSummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (payload->>'start')::timestamptz >= now() AND COALESCE((payload->>'active')::boolean, true))::int AS upcoming,
        COUNT(*) FILTER (WHERE (payload->>'start')::timestamptz >= now() AND COALESCE((payload->>'active')::boolean, true)
          AND NOT COALESCE((payload->>'isConfirmed')::boolean, false))::int AS unconfirmed_upcoming
      FROM raw_st_appointments WHERE is_latest = true
    `);
    const byStatus = await readRows<Record<string, unknown>>(this.database, `
      SELECT COALESCE(payload->>'status', 'UNKNOWN') AS label, COUNT(*)::int AS count
      FROM raw_st_appointments WHERE is_latest = true GROUP BY 1 ORDER BY 2 DESC
    `);
    return {
      totalAppointments: count(row?.total),
      upcomingAppointments: count(row?.upcoming),
      unconfirmedUpcoming: count(row?.unconfirmed_upcoming),
      byStatus: toLabelCounts(byStatus),
    };
  }

  public async getCustomersSummary(): Promise<StCustomersSummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE COALESCE((payload->>'active')::boolean, true))::int AS active,
        COUNT(*) FILTER (WHERE COALESCE((payload->>'balance')::numeric, 0) > 0)::int AS with_balance,
        COALESCE(SUM((payload->>'balance')::numeric) FILTER (WHERE (payload->>'balance')::numeric > 0), 0)::numeric AS total_balance,
        COUNT(*) FILTER (WHERE (payload->>'createdOn')::timestamptz >= now() - interval '30 days')::int AS created_last_30
      FROM raw_st_customers WHERE is_latest = true
    `);
    return {
      totalCustomers: count(row?.total),
      activeCustomers: count(row?.active),
      customersWithBalance: count(row?.with_balance),
      totalCustomerBalance: money(row?.total_balance),
      createdLast30Days: count(row?.created_last_30),
    };
  }

  public async getTechnicianSummary(): Promise<StTechnicianSummaryRow[]> {
    const rows = await readRows<Record<string, unknown>>(this.database, `
      WITH sold AS (
        SELECT payload->>'soldById' AS tech_id, COUNT(*)::int AS jobs_sold,
               COALESCE(SUM((payload->>'total')::numeric), 0)::numeric AS jobs_sold_value
        FROM raw_st_jobs WHERE is_latest = true AND payload->>'soldById' IS NOT NULL
        GROUP BY 1
      )
      SELECT t.source_id AS technician_id, t.payload->>'name' AS name,
             (t.payload->>'active')::boolean AS active,
             COALESCE(s.jobs_sold, 0)::int AS jobs_sold, COALESCE(s.jobs_sold_value, 0)::numeric AS jobs_sold_value
      FROM raw_st_technicians t
      LEFT JOIN sold s ON s.tech_id = t.source_id
      WHERE t.is_latest = true
      ORDER BY jobs_sold_value DESC, name ASC
    `);
    return rows.map((r) => ({
      technicianId: String(r.technician_id),
      name: nullableString(r.name),
      active: typeof r.active === 'boolean' ? r.active : null,
      jobsSold: count(r.jobs_sold),
      jobsSoldValue: money(r.jobs_sold_value),
    }));
  }

  public async getSyncStatus(): Promise<StSyncStatusRow[]> {
    const entities: [string, string][] = [
      ['Customer', 'raw_st_customers'], ['Location', 'raw_st_locations'], ['Job', 'raw_st_jobs'],
      ['Appointment', 'raw_st_appointments'], ['Lead', 'raw_st_leads'], ['Booking', 'raw_st_bookings'],
      ['Invoice', 'raw_st_invoices'], ['Payment', 'raw_st_payments'], ['Technician', 'raw_st_technicians'],
    ];
    return Promise.all(entities.map(async ([entityType, table]) => {
      const [run] = await readRows<Record<string, unknown>>(this.database, `
        SELECT status, started_at, completed_at, records_processed FROM sync_runs
        WHERE source_system = 'ServiceTitan' AND entity_type = ? ORDER BY started_at DESC LIMIT 1
      `, [entityType]);
      const [ok] = await readRows<Record<string, unknown>>(this.database, `
        SELECT MAX(completed_at) AS at FROM sync_runs
        WHERE source_system = 'ServiceTitan' AND entity_type = ? AND status IN ('COMPLETED', 'COMPLETED_WITH_ERRORS')
      `, [entityType]);
      const [raw] = await readRows<Record<string, unknown>>(this.database, `SELECT COUNT(*)::int AS n FROM ${table} WHERE is_latest = true`);
      return {
        entityType,
        lastRunStatus: nullableString(run?.status),
        lastRunStartedAt: toIso(run?.started_at),
        lastRunCompletedAt: toIso(run?.completed_at),
        lastRunRecordsProcessed: run ? count(run.records_processed) : null,
        lastSuccessfulSyncAt: toIso(ok?.at),
        latestRawRecordCount: count(raw?.n),
      };
    }));
  }

  public async listJobs(page: number, pageSize: number, status?: string): Promise<Paginated<StJobListItem>> {
    const filter = status ? `AND payload->>'jobStatus' = ?` : '';
    const filterBindings = status ? [status] : [];
    const [total] = await readRows<Record<string, unknown>>(this.database,
      `SELECT COUNT(*)::int AS n FROM raw_st_jobs WHERE is_latest = true ${filter}`, filterBindings);
    const rows = await readRows<Record<string, unknown>>(this.database, `
      SELECT source_id, payload->>'jobNumber' AS job_number, payload->>'jobStatus' AS status,
             payload->>'customerId' AS customer_id, payload->>'locationId' AS location_id,
             payload->>'soldById' AS sold_by_id, payload->>'total' AS total,
             payload->>'createdOn' AS created_on, payload->>'completedOn' AS completed_on,
             payload->>'invoiceId' AS invoice_id,
             COALESCE((payload->>'noCharge')::boolean, false) AS no_charge,
             (payload->>'recallForId' IS NOT NULL) AS is_recall
      FROM raw_st_jobs WHERE is_latest = true ${filter}
      ORDER BY (payload->>'createdOn')::timestamptz DESC NULLS LAST, source_id DESC
      LIMIT ? OFFSET ?
    `, [...filterBindings, pageSize, (page - 1) * pageSize]);
    return {
      page, pageSize, totalCount: count(total?.n),
      data: rows.map((r) => ({
        id: String(r.source_id), jobNumber: nullableString(r.job_number), status: nullableString(r.status),
        customerId: nullableString(r.customer_id), locationId: nullableString(r.location_id),
        soldById: nullableString(r.sold_by_id), total: nullableString(r.total),
        createdOn: nullableString(r.created_on), completedOn: nullableString(r.completed_on),
        invoiceId: nullableString(r.invoice_id), noCharge: r.no_charge === true, isRecall: r.is_recall === true,
      })),
    };
  }

  public async listInvoices(page: number, pageSize: number, classification?: StInvoiceListItem['classification']): Promise<Paginated<StInvoiceListItem>> {
    const classified = `
      SELECT source_id, payload->>'referenceNumber' AS reference_number, payload->>'invoiceDate' AS invoice_date,
             payload->>'dueDate' AS due_date, payload->>'total' AS total, payload->>'balance' AS balance,
             payload->'customer'->>'id' AS customer_id, payload->'job'->>'id' AS job_id, payload->>'paidOn' AS paid_on,
             CASE
               WHEN COALESCE((payload->>'total')::numeric, 0) = 0 THEN 'ZERO_VALUE'
               WHEN COALESCE((payload->>'balance')::numeric, 0) <= 0 THEN 'PAID'
               WHEN (payload->>'balance')::numeric < (payload->>'total')::numeric THEN 'PARTIALLY_PAID'
               ELSE 'UNPAID' END AS classification
      FROM raw_st_invoices WHERE is_latest = true AND ${ST_INVOICE_ACTIVE}`;
    const filter = classification ? 'WHERE classification = ?' : '';
    const filterBindings = classification ? [classification] : [];
    const [total] = await readRows<Record<string, unknown>>(this.database,
      `SELECT COUNT(*)::int AS n FROM (${classified}) c ${filter}`, filterBindings);
    const rows = await readRows<Record<string, unknown>>(this.database, `
      SELECT * FROM (${classified}) c ${filter}
      ORDER BY invoice_date DESC NULLS LAST, source_id DESC LIMIT ? OFFSET ?
    `, [...filterBindings, pageSize, (page - 1) * pageSize]);
    return {
      page, pageSize, totalCount: count(total?.n),
      data: rows.map((r) => ({
        id: String(r.source_id), referenceNumber: nullableString(r.reference_number),
        invoiceDate: nullableString(r.invoice_date), dueDate: nullableString(r.due_date),
        total: nullableString(r.total), balance: nullableString(r.balance),
        customerId: nullableString(r.customer_id), jobId: nullableString(r.job_id), paidOn: nullableString(r.paid_on),
        classification: r.classification as StInvoiceListItem['classification'],
      })),
    };
  }
}

export const serviceTitanReportingRepository = new KnexServiceTitanReportingRepository();
