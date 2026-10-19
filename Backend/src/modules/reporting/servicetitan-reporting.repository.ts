import type { Knex } from 'knex';
import { db } from '../../database';
import { env } from '../../config/env';
import { defaultDateRangeFilter, type DateRangeFilter, type ServiceTitanDepartment } from '../../utils/dashboard-filters';
import type {
  AbandonedCallItem,
  AbandonedCallsAggregate,
  AbandonedCallsDaySummary,
  AbandonedCallsHourSummary,
  AgentMetricsItem,
  CallRevenueAttribution,
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
  TelecomSyncHealth,
  VoicemailCallbackAlertItem,
  VoicemailCallbackAlertStatus,
} from './servicetitan-reporting.types';
import { TELECOM_SYNC_STALE_HOURS } from './servicetitan-reporting.types';

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

// Computes a human-readable health state for Telecom V2/V3 syncs.
// Priority: DISABLED > NEVER_SYNCED > FAILED > STALE > HEALTHY > UNKNOWN
function computeTelecomSyncHealth(
  schedulerEnabled: boolean,
  lastRunStatus: string | null,
  lastSyncedAt: unknown,
): TelecomSyncHealth {
  if (!schedulerEnabled) return 'DISABLED';
  if (lastSyncedAt === null || lastSyncedAt === undefined) return 'NEVER_SYNCED';
  // lastSyncedAt exists — check if it's parseable
  const syncDate = lastSyncedAt instanceof Date ? lastSyncedAt : new Date(String(lastSyncedAt));
  if (isNaN(syncDate.getTime())) return 'UNKNOWN';
  if (lastRunStatus === 'FAILED') return 'FAILED';
  const staleMs = TELECOM_SYNC_STALE_HOURS * 3_600_000;
  return Date.now() - syncDate.getTime() > staleMs ? 'STALE' : 'HEALTHY';
}

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
    const regular = await Promise.all(entities.map(async ([entityType, table]) => {
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

    const telecom = await this.getTelecomSyncRows();
    return [...regular, ...telecom];
  }

  // Builds sync status rows for the two Telecom syncs (V2 and V3).
  // These differ from regular entities in several ways:
  //   - source_system includes the tenant ID (e.g. 'ServiceTitan:12345')
  //   - V3 sync_runs uses lowercase status values — normalized to uppercase here
  //   - lastSuccessfulSyncAt comes from raw_sync_metadata.last_synced_at (checkpoint),
  //     not from sync_runs.completed_at, because the checkpoint advance is atomic with
  //     the completion write (see telecom-calls-v3.ingestion.ts:completeRun)
  //   - syncHealth is computed from scheduler flag + checkpoint age (6h stale threshold)
  private async getTelecomSyncRows(): Promise<StSyncStatusRow[]> {
    const tenantSourceSystem = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

    const telecomEntities = [
      {
        entityType: 'TelecomCall',
        schedulerEnabled: env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED,
        rawTable: 'raw_st_calls WHERE is_latest = true',
      },
      {
        entityType: 'TelecomCallV3',
        schedulerEnabled: env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED,
        rawTable: 'st_calls_v3_enrichment',
      },
    ];

    return Promise.all(telecomEntities.map(async (tc) => {
      // Last run from sync_runs — V3 uses lowercase statuses; normalize to uppercase.
      const [run] = await readRows<Record<string, unknown>>(this.database,
        `SELECT status, started_at, completed_at, records_processed
         FROM sync_runs
         WHERE source_system = ? AND entity_type = ?
         ORDER BY started_at DESC LIMIT 1`,
        [tenantSourceSystem, tc.entityType],
      );

      // Checkpoint from raw_sync_metadata (most reliable last-success indicator).
      const [checkpoint] = await readRows<Record<string, unknown>>(this.database,
        `SELECT last_synced_at FROM raw_sync_metadata
         WHERE source_system = ? AND entity_type = ?`,
        [tenantSourceSystem, tc.entityType],
      );

      // Raw record count (no is_latest on st_calls_v3_enrichment; V2 filters it).
      const [rawRow] = await readRows<Record<string, unknown>>(this.database,
        `SELECT COUNT(*)::int AS n FROM ${tc.rawTable}`,
      );

      const lastRunStatus = run?.status ? String(run.status).toUpperCase() : null;
      const checkpointAt = toIso(checkpoint?.last_synced_at);

      const syncHealth = computeTelecomSyncHealth(
        tc.schedulerEnabled,
        lastRunStatus,
        checkpoint?.last_synced_at ?? null,
      );

      return {
        entityType: tc.entityType,
        lastRunStatus,
        lastRunStartedAt: toIso(run?.started_at),
        lastRunCompletedAt: toIso(run?.completed_at),
        lastRunRecordsProcessed: run ? count(run.records_processed) : null,
        // lastSuccessfulSyncAt = checkpoint advance timestamp (atomic with sync completion)
        lastSuccessfulSyncAt: checkpointAt,
        latestRawRecordCount: count(rawRow?.n),
        schedulerEnabled: tc.schedulerEnabled,
        checkpointAt,
        syncHealth,
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
  // ─── Abandoned Calls ────────────────────────────────────────────────────────
  //
  // Source: st_calls_v3_enrichment (V3) joined to raw_st_calls (V2) for customer/job IDs.
  // Only returns direction='Inbound', call_type='Abandoned'.
  // Phones/recording URLs are never selected — only structured metadata.
  //
  // Date filter is applied to call_received_on (the actual ring timestamp from V3).
  // Rows with call_received_on IS NULL are excluded — this never occurs in practice
  // (100% populated) but is a defensive guard.
  //
  // Indexes used:
  //   - idx_st_calls_v3_enrichment_call_type (call_type)
  //   - idx_st_calls_v3_enrichment_received_on (call_received_on)
  //   - idx_st_calls_v3_enrichment_call (source_system, source_id) for the join
  //   - idx_raw_st_calls_latest (source_system, source_id WHERE is_latest) for the join
  public async listAbandonedCalls(
    from: Date,
    to: Date,
    page: number,
    pageSize: number,
    sortDir: 'asc' | 'desc',
    sourceSystem: string,
  ): Promise<Paginated<AbandonedCallItem>> {
    const baseFilter = `
      v3.source_system = ?
      AND v3.call_type = 'Abandoned'
      AND v3.direction = 'Inbound'
      AND v3.call_received_on IS NOT NULL
      AND v3.call_received_on >= ?
      AND v3.call_received_on < ?
    `;
    const bindings: Knex.RawBinding[] = [sourceSystem, from.toISOString(), to.toISOString()];

    const [totalRow] = await readRows<Record<string, unknown>>(this.database, `
      SELECT COUNT(*)::int AS n
      FROM st_calls_v3_enrichment v3
      WHERE ${baseFilter}
    `, bindings);

    const sortSql = sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        v3.source_id          AS call_id,
        v3.call_received_on   AS received_on,
        v3.duration           AS duration,
        v3.agent_id           AS agent_id,
        v3.agent_name         AS agent_name,
        r.st_customer_id      AS customer_id,
        r.st_job_id           AS job_id,
        v3.v2_linked          AS v2_linked,
        (v3.v3_payload->'leadCall'->>'voiceMailUrl' IS NOT NULL
          AND v3.v3_payload->'leadCall'->>'voiceMailUrl' <> '') AS has_voicemail
      FROM st_calls_v3_enrichment v3
      LEFT JOIN raw_st_calls r
        ON r.source_system = v3.source_system
       AND r.source_id     = v3.source_id
       AND r.is_latest     = true
      WHERE ${baseFilter}
      ORDER BY v3.call_received_on ${sortSql} NULLS LAST, v3.source_id ${sortSql}
      LIMIT ? OFFSET ?
    `, [...bindings, pageSize, (page - 1) * pageSize]);

    return {
      page, pageSize, totalCount: count(totalRow?.n),
      data: rows.map((r) => ({
        callId: String(r.call_id),
        receivedOn: toIso(r.received_on) ?? '',
        duration: nullableString(r.duration),
        agentId: nullableString(r.agent_id),
        agentName: nullableString(r.agent_name),
        customerId: nullableString(r.customer_id),
        jobId: nullableString(r.job_id),
        hasVoicemail: r.has_voicemail === true,
        v2Linked: r.v2_linked === true,
      })),
    };
  }

  public async getAbandonedCallsAggregate(
    from: Date,
    to: Date,
    sourceSystem: string,
  ): Promise<AbandonedCallsAggregate> {
    const bindings: Knex.RawBinding[] = [sourceSystem, from.toISOString(), to.toISOString()];
    const baseFilter = `
      source_system = ?
      AND call_type = 'Abandoned'
      AND direction = 'Inbound'
      AND call_received_on IS NOT NULL
      AND call_received_on >= ?
      AND call_received_on < ?
    `;

    const [totals] = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        COUNT(*)::int AS total_count,
        COUNT(*) FILTER (WHERE v3_payload->'leadCall'->>'voiceMailUrl' IS NOT NULL
          AND v3_payload->'leadCall'->>'voiceMailUrl' <> '')::int AS with_voicemail,
        COUNT(*) FILTER (WHERE source_id IN (
          SELECT source_id FROM raw_st_calls
          WHERE is_latest = true AND st_customer_id IS NOT NULL AND source_system = ?
        ))::int AS with_customer_id
      FROM st_calls_v3_enrichment WHERE ${baseFilter}
    `, [sourceSystem, ...bindings]);

    const dayRows = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        to_char(call_received_on AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COUNT(*)::int AS count
      FROM st_calls_v3_enrichment
      WHERE ${baseFilter}
      GROUP BY 1 ORDER BY 1
    `, bindings);

    const hourRows = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        EXTRACT(HOUR FROM call_received_on AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::int AS count
      FROM st_calls_v3_enrichment
      WHERE ${baseFilter}
      GROUP BY 1 ORDER BY 1
    `, bindings);

    return {
      totalCount: count(totals?.total_count),
      withVoicemail: count(totals?.with_voicemail),
      withCustomerId: count(totals?.with_customer_id),
      byDay: dayRows.map((r): AbandonedCallsDaySummary => ({ date: String(r.date), count: count(r.count) })),
      byHour: hourRows.map((r): AbandonedCallsHourSummary => ({ hour: count(r.hour), count: count(r.count) })),
    };
  }

  // ─── D-02a: Voicemail Callback Alerts ─────────────────────────────────────
  //
  // Source: telecom_voicemail_callback_alerts (migration 023).
  // Filters: optional status, optional ISO timestamp range on voicemail_at.
  // Sort: voicemail_at DESC with source_id DESC as a stable tie-breaker.
  // No PII columns are selected — source_id is the ST call ID (numeric string),
  // not a phone number or customer-identifiable value.
  public async listVoicemailCallbackAlerts(
    page: number,
    pageSize: number,
    sourceSystem: string,
    status?: VoicemailCallbackAlertStatus,
    from?: Date,
    to?: Date,
  ): Promise<Paginated<VoicemailCallbackAlertItem>> {
    const bindings: Knex.RawBinding[] = [sourceSystem];
    let whereClause = 'source_system = ?';

    if (status) {
      whereClause += ' AND status = ?';
      bindings.push(status);
    }
    if (from) {
      whereClause += ' AND voicemail_at >= ?';
      bindings.push(from.toISOString());
    }
    if (to) {
      whereClause += ' AND voicemail_at < ?';
      bindings.push(to.toISOString());
    }

    const [totalRow] = await readRows<Record<string, unknown>>(
      this.database,
      `SELECT COUNT(*)::int AS n FROM telecom_voicemail_callback_alerts WHERE ${whereClause}`,
      bindings,
    );

    const rows = await readRows<Record<string, unknown>>(
      this.database,
      `SELECT
        source_id,
        status,
        voicemail_at,
        threshold_minutes,
        business_minutes_elapsed,
        threshold_exceeded_at,
        callback_at,
        updated_at
       FROM telecom_voicemail_callback_alerts
       WHERE ${whereClause}
       ORDER BY voicemail_at DESC, source_id DESC
       LIMIT ? OFFSET ?`,
      [...bindings, pageSize, (page - 1) * pageSize],
    );

    return {
      page,
      pageSize,
      totalCount: count(totalRow?.n),
      data: rows.map((r) => ({
        sourceId: String(r.source_id),
        status: r.status as VoicemailCallbackAlertStatus,
        voicemailAt: toIso(r.voicemail_at) ?? '',
        thresholdMinutes: count(r.threshold_minutes),
        businessMinutesElapsed: count(r.business_minutes_elapsed),
        thresholdExceededAt: toIso(r.threshold_exceeded_at),
        callbackAt: toIso(r.callback_at),
        updatedAt: toIso(r.updated_at) ?? '',
      })),
    };
  }
  // ─── Telecom Agent Metrics ────────────────────────────────────────────────
  //
  // Aggregates per-agent call metrics from st_calls_v3_enrichment.
  // That table has a unique index on (source_system, source_id) so each call
  // contributes exactly once — no deduplication or join to raw_st_calls needed.
  //
  // NULL agent_id rows are kept as a distinct group ("unattributed") so that
  // calls never assigned to an agent are visible rather than silently dropped.
  //
  // Duration: ISO-8601 strings (e.g. "PT5M30S") are parsed via PostgreSQL's
  // interval type. Empty strings and NULLs are excluded from aggregates.
  //
  // Sorting: agent_id ASC NULLS LAST for deterministic pagination. The NULL
  // group always appears last regardless of page/pageSize.
  public async getAgentMetrics(
    from: Date,
    to: Date,
    page: number,
    pageSize: number,
    sourceSystem: string,
    agentId?: string,
  ): Promise<Paginated<AgentMetricsItem>> {
    const bindings: Knex.RawBinding[] = [sourceSystem, from.toISOString(), to.toISOString()];
    let whereClause = `
      source_system = ?
      AND call_received_on IS NOT NULL
      AND call_received_on >= ?
      AND call_received_on < ?
    `;

    if (agentId !== undefined) {
      whereClause += ` AND agent_id = ?`;
      bindings.push(agentId);
    }

    // Count distinct agent groups (including the NULL group) matching the filter.
    const [countRow] = await readRows<{ n: number }>(
      this.database,
      `SELECT COUNT(*)::int AS n
       FROM (
         SELECT agent_id
         FROM st_calls_v3_enrichment
         WHERE ${whereClause}
         GROUP BY agent_id
       ) sub`,
      bindings,
    );

    const rows = await readRows<Record<string, unknown>>(
      this.database,
      `SELECT
         agent_id,
         MAX(agent_name)                                                              AS agent_name,
         COUNT(*)::int                                                                AS total_calls,
         COUNT(*) FILTER (WHERE direction = 'Inbound')::int                          AS inbound_calls,
         COUNT(*) FILTER (WHERE direction = 'Outbound')::int                         AS outbound_calls,
         COUNT(*) FILTER (WHERE call_type = 'Abandoned')::int                        AS abandoned_calls,
         COUNT(*) FILTER (WHERE call_type = 'Booked')::int                           AS booked_calls,
         COUNT(*) FILTER (WHERE call_type = 'Unbooked')::int                         AS unbooked_calls,
         COUNT(*) FILTER (WHERE call_type = 'Excused')::int                          AS excused_calls,
         COUNT(*) FILTER (WHERE call_type = 'NotLead')::int                          AS not_lead_calls,
         COUNT(*) FILTER (WHERE call_type IS NOT NULL)::int                          AS classified_calls,
         COUNT(*) FILTER (WHERE call_type IS NULL)::int                              AS unclassified_calls,
         COALESCE(
           SUM(EXTRACT(EPOCH FROM NULLIF(duration, '')::interval))::bigint, 0
         )                                                                            AS total_duration_seconds,
         COALESCE(
           ROUND(AVG(EXTRACT(EPOCH FROM NULLIF(duration, '')::interval)))::bigint, 0
         )                                                                            AS avg_duration_seconds,
         MIN(call_received_on)                                                        AS first_call_at,
         MAX(call_received_on)                                                        AS last_call_at
       FROM st_calls_v3_enrichment
       WHERE ${whereClause}
       GROUP BY agent_id
       ORDER BY agent_id ASC NULLS LAST
       LIMIT ? OFFSET ?`,
      [...bindings, pageSize, (page - 1) * pageSize],
    );

    return {
      page,
      pageSize,
      totalCount: count(countRow?.n),
      data: rows.map((r): AgentMetricsItem => ({
        agentId: nullableString(r.agent_id),
        agentName: nullableString(r.agent_name),
        totalCalls: count(r.total_calls),
        inboundCalls: count(r.inbound_calls),
        outboundCalls: count(r.outbound_calls),
        abandonedCalls: count(r.abandoned_calls),
        bookedCalls: count(r.booked_calls),
        unbookedCalls: count(r.unbooked_calls),
        excusedCalls: count(r.excused_calls),
        notLeadCalls: count(r.not_lead_calls),
        classifiedCalls: count(r.classified_calls),
        unclassifiedCalls: count(r.unclassified_calls),
        totalDurationSeconds: count(r.total_duration_seconds),
        avgDurationSeconds: count(r.avg_duration_seconds),
        firstCallAt: toIso(r.first_call_at),
        lastCallAt: toIso(r.last_call_at),
      })),
    };
  }

  // ─── Call-to-Revenue Attribution ──────────────────────────────────────────
  //
  // Attribution chain (the ONLY defensible path):
  //   raw_st_calls.st_job_id  →  raw_st_invoices WHERE payload->'job'->>'id' = st_job_id
  //
  // If the call has no st_job_id the call cannot be attributed to revenue.
  // st_customer_id is returned as context only — a customer may have many jobs
  // and many invoices, so customer-level revenue cannot be attributed to a call.
  //
  // Financial fields: payload->>'total' (invoiced), payload->>'balance' (outstanding).
  // Active filter: COALESCE((payload->>'active')::boolean, true) = true.
  // Only is_latest = true rows are considered (deduplication guard).
  public async getCallRevenueAttribution(
    callId: string,
    sourceSystem: string,
  ): Promise<CallRevenueAttribution> {
    // Step 1: Fetch the call row to get st_job_id and st_customer_id.
    const [callRow] = await readRows<{ st_job_id: string | null; st_customer_id: string | null }>(
      this.database,
      `SELECT st_job_id, st_customer_id
       FROM raw_st_calls
       WHERE source_id = ? AND source_system = ? AND is_latest = true
       LIMIT 1`,
      [callId, sourceSystem],
    );

    if (!callRow) {
      // Call ID not found in raw_st_calls — not ingested yet or wrong source system.
      return {
        callId,
        attributionStatus: 'NO_LINKAGE',
        attributionMethod: 'none',
        customerId: null,
        jobId: null,
        linkedInvoiceCount: 0,
        invoicedAmount: null,
        outstandingBalance: null,
        currency: null,
      };
    }

    const jobId = callRow.st_job_id ?? null;
    const customerId = callRow.st_customer_id ?? null;

    if (!jobId) {
      // Call exists but has no job linkage — customer context returned; no revenue.
      return {
        callId,
        attributionStatus: 'NO_JOB',
        attributionMethod: 'none',
        customerId,
        jobId: null,
        linkedInvoiceCount: 0,
        invoicedAmount: null,
        outstandingBalance: null,
        currency: null,
      };
    }

    // Step 2: Aggregate all active, latest invoices linked to this job.
    const [aggRow] = await readRows<{
      invoice_count: number;
      total_sum: string | null;
      balance_sum: string | null;
    }>(
      this.database,
      `SELECT
         COUNT(*)::int                              AS invoice_count,
         SUM((payload->>'total')::numeric)::text    AS total_sum,
         SUM((payload->>'balance')::numeric)::text  AS balance_sum
       FROM raw_st_invoices
       WHERE source_system = ?
         AND is_latest = true
         AND payload->'job'->>'id' = ?
         AND COALESCE((payload->>'active')::boolean, true) = true`,
      [sourceSystem, jobId],
    );

    const invoiceCount = aggRow?.invoice_count ?? 0;

    return {
      callId,
      attributionStatus: 'JOB_LINKED',
      attributionMethod: 'call_job_invoice',
      customerId,
      jobId,
      linkedInvoiceCount: invoiceCount,
      invoicedAmount: invoiceCount > 0 ? (aggRow?.total_sum ?? '0') : null,
      outstandingBalance: invoiceCount > 0 ? (aggRow?.balance_sum ?? '0') : null,
      currency: invoiceCount > 0 ? 'USD' : null,
    };
  }
}

export const serviceTitanReportingRepository = new KnexServiceTitanReportingRepository();
