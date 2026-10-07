import type { Knex } from 'knex';
import { db } from '../../database';
import { defaultDateRangeFilter, type DateRangeFilter } from '../../utils/dashboard-filters';
import type {
  CustomerIdentityQualitySummary,
  InvoiceSummary,
  PaymentApplicationIntegritySummary,
  PaymentSummary,
  QboCompletenessReport,
  ReportingRepository,
} from './reporting.types';

interface RawResult<T> { rows: T[] }

const readRows = async <T>(database: Knex, sql: string, bindings: readonly Knex.RawBinding[] = []): Promise<T[]> => {
  const result = await database.raw(sql, bindings) as unknown as RawResult<T>;
  return Array.isArray(result.rows) ? result.rows : [];
};

const count = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const money = (value: unknown): string => {
  if (typeof value === 'string') return value;
  return '0.00';
};

const COMPLETENESS_TABLES = {
  Customer: { raw: 'raw_qbo_customers', unified: 'unified_customers' },
  Invoice: { raw: 'raw_qbo_invoices', unified: 'unified_invoices' },
  Payment: { raw: 'raw_qbo_payments', unified: 'unified_payments' },
} as const;

export class KnexReportingRepository implements ReportingRepository {
  public constructor(private readonly database: Knex = db) {}

  // Date filters on invoice_date (default month-to-date). A row with no
  // invoice_date is excluded from a filtered view rather than silently
  // always included, since "which period is this in" would be undefined.
  public async getInvoiceSummary(dateRange: DateRangeFilter = defaultDateRangeFilter()): Promise<InvoiceSummary> {
    const active = `
      SELECT DISTINCT ON (source_id) source_id, unified_entity_id
      FROM identity_mappings
      WHERE source_system = 'QuickBooks' AND entity_type = 'Invoice' AND status = 'ACTIVE'
      ORDER BY source_id, modified_on DESC, id DESC
    `;
    // A broken mapping (identity active, no unified row) has no invoice_date
    // to place in any period, so it's tracked as a standing data-quality
    // count, not scoped by the date filter (it wouldn't ever appear in a
    // filtered period otherwise, silently hiding it whenever a filter is applied).
    const [brokenRow] = await readRows<Record<string, unknown>>(this.database, `
      WITH active AS (${active})
      SELECT COUNT(*) FILTER (WHERE u.id IS NULL)::int AS broken_target_count
      FROM active a LEFT JOIN unified_invoices u ON u.id = a.unified_entity_id
    `);
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      WITH active AS (${active})
      SELECT
        COUNT(*)::int AS total_active_invoices,
        COUNT(*) FILTER (WHERE u.total_amount > 0 AND u.balance = 0)::int AS paid_count,
        COUNT(*) FILTER (WHERE u.total_amount > 0 AND u.balance > 0 AND u.balance < u.total_amount)::int AS partially_paid_count,
        COUNT(*) FILTER (WHERE u.total_amount > 0 AND u.balance = u.total_amount)::int AS unpaid_count,
        COUNT(*) FILTER (WHERE u.total_amount = 0 AND u.balance = 0)::int AS zero_value_count,
        COUNT(*) FILTER (WHERE NOT (
          (u.total_amount > 0 AND u.balance = 0) OR
          (u.total_amount > 0 AND u.balance > 0 AND u.balance < u.total_amount) OR
          (u.total_amount > 0 AND u.balance = u.total_amount) OR
          (u.total_amount = 0 AND u.balance = 0)
        ))::int AS unsupported_count,
        COALESCE(SUM(u.total_amount), 0)::numeric AS invoice_total,
        COALESCE(SUM(u.balance) FILTER (WHERE u.balance >= 0), 0)::numeric AS outstanding_ar,
        COALESCE(SUM(u.tax), 0)::numeric AS total_tax,
        COALESCE(SUM(u.discount), 0)::numeric AS total_discount
      FROM active a
      JOIN unified_invoices u ON u.id = a.unified_entity_id
      WHERE u.invoice_date >= ? AND u.invoice_date < ?
    `, [dateRange.from.toISOString(), dateRange.to.toISOString()]);
    return {
      totalActiveInvoices: count(row?.total_active_invoices),
      paidCount: count(row?.paid_count),
      partiallyPaidCount: count(row?.partially_paid_count),
      unpaidCount: count(row?.unpaid_count),
      zeroValueCount: count(row?.zero_value_count),
      unsupportedCount: count(row?.unsupported_count),
      invoiceTotal: money(row?.invoice_total),
      outstandingAr: money(row?.outstanding_ar),
      totalTax: money(row?.total_tax),
      totalDiscount: money(row?.total_discount),
      brokenTargetCount: count(brokenRow?.broken_target_count),
    };
  }

  // Date filter on payment_date (default month-to-date). A payment with no
  // payment_date is excluded, same reasoning as getInvoiceSummary.
  public async getPaymentSummary(dateRange: DateRangeFilter = defaultDateRangeFilter()): Promise<PaymentSummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      WITH active AS (
        SELECT DISTINCT ON (source_id) source_id, unified_entity_id
        FROM identity_mappings
        WHERE source_system = 'QuickBooks' AND entity_type = 'Payment' AND status = 'ACTIVE'
        ORDER BY source_id, modified_on DESC, id DESC
      ), applications AS (
        SELECT payment_id, COUNT(*)::int AS application_count, SUM(applied_amount)::numeric AS applied_amount
        FROM unified_payment_applications
        GROUP BY payment_id
      )
      SELECT
        COUNT(*)::int AS payment_count,
        COALESCE(SUM(p.total_amount), 0)::numeric AS payment_total,
        COALESCE(SUM(p.unapplied_amount), 0)::numeric AS unapplied_total,
        COALESCE(SUM(COALESCE(a.applied_amount, 0)), 0)::numeric AS mapped_application_total,
        COUNT(*) FILTER (WHERE p.total_amount = COALESCE(a.applied_amount, 0) + p.unapplied_amount)::int AS reconciled_payment_count,
        COUNT(*) FILTER (WHERE p.total_amount <> COALESCE(a.applied_amount, 0) + p.unapplied_amount)::int AS unreconciled_payment_count,
        COALESCE(SUM(p.total_amount - COALESCE(a.applied_amount, 0) - p.unapplied_amount), 0)::numeric AS net_reconciliation_difference,
        COUNT(*) FILTER (WHERE a.payment_id IS NULL)::int AS payments_without_invoice_applications
      FROM active i
      JOIN unified_payments p ON p.id = i.unified_entity_id
      LEFT JOIN applications a ON a.payment_id = p.id
      WHERE p.payment_date >= ? AND p.payment_date < ?
    `, [dateRange.from.toISOString(), dateRange.to.toISOString()]);
    return {
      paymentCount: count(row?.payment_count),
      paymentTotal: money(row?.payment_total),
      unappliedTotal: money(row?.unapplied_total),
      mappedApplicationTotal: money(row?.mapped_application_total),
      reconciledPaymentCount: count(row?.reconciled_payment_count),
      unreconciledPaymentCount: count(row?.unreconciled_payment_count),
      netReconciliationDifference: money(row?.net_reconciliation_difference),
      paymentsWithoutInvoiceApplications: count(row?.payments_without_invoice_applications),
    };
  }

  public async getQboCompleteness(): Promise<QboCompletenessReport> {
    const entries = await Promise.all((Object.entries(COMPLETENESS_TABLES) as [
      keyof typeof COMPLETENESS_TABLES, (typeof COMPLETENESS_TABLES)[keyof typeof COMPLETENESS_TABLES]
    ][]).map(async ([entity, tables]) => {
      const [row] = await readRows<Record<string, unknown>>(this.database, `
        WITH active AS (
          SELECT DISTINCT ON (source_id) source_id, unified_entity_id
          FROM identity_mappings
          WHERE source_system = 'QuickBooks' AND entity_type = ? AND status = 'ACTIVE'
          ORDER BY source_id, modified_on DESC, id DESC
        )
        SELECT
          (SELECT COUNT(*)::int FROM ${tables.raw} WHERE is_latest = true AND is_deleted = false) AS latest_non_deleted_raw_count,
          (SELECT COUNT(*)::int FROM active) AS active_identity_count,
          (SELECT COUNT(DISTINCT unified_entity_id)::int FROM active WHERE unified_entity_id IS NOT NULL) AS unified_target_count,
          (SELECT COUNT(*)::int FROM active a LEFT JOIN ${tables.unified} u ON u.id = a.unified_entity_id WHERE u.id IS NULL) AS broken_target_count,
          (SELECT COUNT(*)::int FROM (
            SELECT source_id FROM identity_mappings
            WHERE source_system = 'QuickBooks' AND entity_type = ?
            GROUP BY source_id HAVING COUNT(*) > 1
          ) duplicates) AS duplicate_source_identity_count,
          (SELECT COUNT(*)::int FROM sync_errors WHERE error_message LIKE ?) AS mapping_error_count
      `, [entity, entity, 'QBO_MAPPING:' + entity + ':%']);
      return [entity, {
        latestNonDeletedRawCount: count(row?.latest_non_deleted_raw_count),
        activeIdentityCount: count(row?.active_identity_count),
        unifiedTargetCount: count(row?.unified_target_count),
        brokenTargetCount: count(row?.broken_target_count),
        duplicateSourceIdentityCount: count(row?.duplicate_source_identity_count),
        mappingErrorCount: count(row?.mapping_error_count),
      }] as const;
    }));
    return Object.fromEntries(entries) as QboCompletenessReport;
  }

  public async getCustomerIdentityQuality(): Promise<CustomerIdentityQualitySummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      WITH st AS (
        SELECT im.* FROM identity_mappings im
        WHERE im.source_system = 'ServiceTitan' AND im.entity_type = 'Customer'
      ), qbo_targets AS (
        SELECT DISTINCT unified_entity_id FROM identity_mappings
        WHERE source_system = 'QuickBooks' AND entity_type = 'Customer'
          AND status = 'ACTIVE' AND unified_entity_id IS NOT NULL
      )
      SELECT
        COUNT(*)::int AS servicetitan_customer_identity_count,
        COUNT(*) FILTER (WHERE confidence_level = 'VERIFIED' AND matching_method = 'DETERMINISTIC_NAME_ZIP_ADDRESS_TIER_A')::int AS verified_tier_a_count,
        COUNT(*) FILTER (WHERE confidence_level = 'UNRESOLVED')::int AS unresolved_count,
        COUNT(*) FILTER (WHERE status = 'MERGED')::int AS merged_count,
        COUNT(*) FILTER (WHERE st.unified_entity_id IS NOT NULL AND u.id IS NULL)::int AS broken_unified_target_count,
        COUNT(*) FILTER (WHERE confidence_level = 'VERIFIED' AND matching_method = 'DETERMINISTIC_NAME_ZIP_ADDRESS_TIER_A' AND NOT EXISTS (
          SELECT 1 FROM qbo_targets q WHERE q.unified_entity_id = st.unified_entity_id
        ))::int AS tier_a_without_shared_qbo_target,
        COUNT(*) FILTER (WHERE confidence_level = 'UNRESOLVED' AND EXISTS (
          SELECT 1 FROM qbo_targets q WHERE q.unified_entity_id = st.unified_entity_id
        ))::int AS unresolved_sharing_qbo_target
      FROM st
      LEFT JOIN unified_customers u ON u.id = st.unified_entity_id
    `);
    return {
      serviceTitanCustomerIdentityCount: count(row?.servicetitan_customer_identity_count),
      verifiedTierACount: count(row?.verified_tier_a_count),
      unresolvedCount: count(row?.unresolved_count),
      mergedCount: count(row?.merged_count),
      brokenUnifiedTargetCount: count(row?.broken_unified_target_count),
      tierAWithoutSharedQboTarget: count(row?.tier_a_without_shared_qbo_target),
      unresolvedSharingQboTarget: count(row?.unresolved_sharing_qbo_target),
    };
  }

  public async getPaymentApplicationIntegrity(): Promise<PaymentApplicationIntegritySummary> {
    const [row] = await readRows<Record<string, unknown>>(this.database, `
      SELECT
        COUNT(*)::int AS total_application_rows,
        COUNT(*) FILTER (WHERE p.id IS NULL)::int AS orphan_payment_references,
        COUNT(*) FILTER (WHERE i.id IS NULL)::int AS orphan_invoice_references,
        (SELECT COUNT(*)::int FROM (
          SELECT payment_id, invoice_id FROM unified_payment_applications
          GROUP BY payment_id, invoice_id HAVING COUNT(*) > 1
        ) duplicates) AS duplicate_payment_invoice_pairs,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM identity_mappings pm
          WHERE pm.source_system = 'QuickBooks' AND pm.entity_type = 'Payment'
            AND pm.unified_entity_id = a.payment_id AND pm.status <> 'ACTIVE'
        ) OR EXISTS (
          SELECT 1 FROM identity_mappings im
          WHERE im.source_system = 'QuickBooks' AND im.entity_type = 'Invoice'
            AND im.unified_entity_id = a.invoice_id AND im.status <> 'ACTIVE'
        ))::int AS applications_with_inactive_or_deleted_qbo_identity
      FROM unified_payment_applications a
      LEFT JOIN unified_payments p ON p.id = a.payment_id
      LEFT JOIN unified_invoices i ON i.id = a.invoice_id
    `);
    return {
      totalApplicationRows: count(row?.total_application_rows),
      orphanPaymentReferences: count(row?.orphan_payment_references),
      orphanInvoiceReferences: count(row?.orphan_invoice_references),
      duplicatePaymentInvoicePairs: count(row?.duplicate_payment_invoice_pairs),
      applicationsWithInactiveOrDeletedQboIdentity: count(row?.applications_with_inactive_or_deleted_qbo_identity),
    };
  }
}

export const qboReportingRepository = new KnexReportingRepository();
