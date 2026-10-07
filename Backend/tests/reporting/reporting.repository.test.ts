import { describe, expect, it } from '@jest/globals';
import type { Knex } from 'knex';
import { KnexReportingRepository } from '../../src/modules/reporting/reporting.repository';
import { ReportingService } from '../../src/modules/reporting/reporting.service';
import type { ReportingRepository } from '../../src/modules/reporting/reporting.types';

class ReadOnlyDatabase {
  public readonly queries: string[] = [];
  private readonly responses: Array<{ rows: Array<Record<string, unknown>> }>;

  public constructor(...responses: Array<Array<Record<string, unknown>>>) {
    this.responses = responses.map((rows) => ({ rows }));
  }

  public raw(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.queries.push(sql);
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(sql)) {
      throw new Error('Reporting queries must be read-only.');
    }
    return Promise.resolve(this.responses.shift() ?? { rows: [] });
  }
}

describe('Knex reporting repository', () => {
  it('returns invoice measures and classification counts without duplicate identity joins', async () => {
    // Two queries now: a standing (date-unscoped) broken-target-mapping
    // count, then the date-scoped financial summary - see getInvoiceSummary.
    const database = new ReadOnlyDatabase(
      [{ broken_target_count: '0' }],
      [{
        total_active_invoices: '4',
        paid_count: '1',
        partially_paid_count: '1',
        unpaid_count: '1',
        zero_value_count: '1',
        unsupported_count: '0',
        invoice_total: '400.00',
        outstanding_ar: '125.50',
        total_tax: '20.00',
        total_discount: '5.00',
      }],
    );
    const result = await new KnexReportingRepository(database as unknown as Knex).getInvoiceSummary();
    expect(result).toEqual({
      totalActiveInvoices: 4,
      paidCount: 1,
      partiallyPaidCount: 1,
      unpaidCount: 1,
      zeroValueCount: 1,
      unsupportedCount: 0,
      invoiceTotal: '400.00',
      outstandingAr: '125.50',
      totalTax: '20.00',
      totalDiscount: '5.00',
      brokenTargetCount: 0,
    });
    expect(database.queries[0]).toContain('DISTINCT ON (source_id)');
  });

  it('keeps authoritative payment measures separate and exposes unreconciled differences', async () => {
    const database = new ReadOnlyDatabase([{
      payment_count: '2',
      payment_total: '150.00',
      unapplied_total: '10.00',
      mapped_application_total: '165.00',
      reconciled_payment_count: '1',
      unreconciled_payment_count: '1',
      net_reconciliation_difference: '-25.00',
      payments_without_invoice_applications: '0',
    }]);
    const result = await new KnexReportingRepository(database as unknown as Knex).getPaymentSummary();
    expect(result).toEqual({
      paymentCount: 2,
      paymentTotal: '150.00',
      unappliedTotal: '10.00',
      mappedApplicationTotal: '165.00',
      reconciledPaymentCount: 1,
      unreconciledPaymentCount: 1,
      netReconciliationDifference: '-25.00',
      paymentsWithoutInvoiceApplications: 0,
    });
  });

  it('reports completeness, customer identity quality, and application integrity', async () => {
    const database = new ReadOnlyDatabase(
      [{ latest_non_deleted_raw_count: '10', active_identity_count: '9', unified_target_count: '8', broken_target_count: '1', duplicate_source_identity_count: '0', mapping_error_count: '1' }],
      [{ latest_non_deleted_raw_count: '20', active_identity_count: '19', unified_target_count: '19', broken_target_count: '0', duplicate_source_identity_count: '0', mapping_error_count: '2' }],
      [{ latest_non_deleted_raw_count: '30', active_identity_count: '29', unified_target_count: '28', broken_target_count: '1', duplicate_source_identity_count: '0', mapping_error_count: '3' }],
      [{ servicetitan_customer_identity_count: '10', verified_tier_a_count: '6', unresolved_count: '3', merged_count: '1', broken_unified_target_count: '0', tier_a_without_shared_qbo_target: '1', unresolved_sharing_qbo_target: '0' }],
      [{ total_application_rows: '12', orphan_payment_references: '1', orphan_invoice_references: '2', duplicate_payment_invoice_pairs: '0', applications_with_inactive_or_deleted_qbo_identity: '1' }],
    );
    const repository = new KnexReportingRepository(database as unknown as Knex);
    await expect(repository.getQboCompleteness()).resolves.toEqual({
      Customer: { latestNonDeletedRawCount: 10, activeIdentityCount: 9, unifiedTargetCount: 8, brokenTargetCount: 1, duplicateSourceIdentityCount: 0, mappingErrorCount: 1 },
      Invoice: { latestNonDeletedRawCount: 20, activeIdentityCount: 19, unifiedTargetCount: 19, brokenTargetCount: 0, duplicateSourceIdentityCount: 0, mappingErrorCount: 2 },
      Payment: { latestNonDeletedRawCount: 30, activeIdentityCount: 29, unifiedTargetCount: 28, brokenTargetCount: 1, duplicateSourceIdentityCount: 0, mappingErrorCount: 3 },
    });
    await expect(repository.getCustomerIdentityQuality()).resolves.toMatchObject({ verifiedTierACount: 6, unresolvedCount: 3 });
    await expect(repository.getPaymentApplicationIntegrity()).resolves.toMatchObject({ orphanPaymentReferences: 1, orphanInvoiceReferences: 2 });
    expect(database.queries).toHaveLength(5);
    expect(database.queries.join('\n')).toContain('HAVING COUNT(*) > 1');
    expect(database.queries.every((query) => !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(query))).toBe(true);
  });

  it('provides a reusable read-only snapshot service', async () => {
    const value = {
      invoices: {} as never,
      payments: {} as never,
      qboCompleteness: {} as never,
      customerIdentityQuality: {} as never,
      paymentApplicationIntegrity: {} as never,
    };
    const repository: ReportingRepository = {
      getInvoiceSummary: async () => value.invoices,
      getPaymentSummary: async () => value.payments,
      getQboCompleteness: async () => value.qboCompleteness,
      getCustomerIdentityQuality: async () => value.customerIdentityQuality,
      getPaymentApplicationIntegrity: async () => value.paymentApplicationIntegrity,
    };
    await expect(new ReportingService(repository).getSnapshot()).resolves.toEqual(value);
  });
});
