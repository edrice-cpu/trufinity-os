import type { DateRangeFilter } from '../../utils/dashboard-filters';

export interface InvoiceSummary {
  totalActiveInvoices: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
  zeroValueCount: number;
  unsupportedCount: number;
  invoiceTotal: string;
  outstandingAr: string;
  totalTax: string;
  totalDiscount: string;
  brokenTargetCount: number;
}

export interface PaymentSummary {
  paymentCount: number;
  paymentTotal: string;
  unappliedTotal: string;
  mappedApplicationTotal: string;
  reconciledPaymentCount: number;
  unreconciledPaymentCount: number;
  netReconciliationDifference: string;
  paymentsWithoutInvoiceApplications: number;
}

export interface QboCompletenessSummary {
  latestNonDeletedRawCount: number;
  activeIdentityCount: number;
  unifiedTargetCount: number;
  brokenTargetCount: number;
  duplicateSourceIdentityCount: number;
  mappingErrorCount: number;
}

export type QboCompletenessReport = Record<'Customer' | 'Invoice' | 'Payment', QboCompletenessSummary>;

export interface CustomerIdentityQualitySummary {
  serviceTitanCustomerIdentityCount: number;
  verifiedTierACount: number;
  unresolvedCount: number;
  mergedCount: number;
  brokenUnifiedTargetCount: number;
  tierAWithoutSharedQboTarget: number;
  unresolvedSharingQboTarget: number;
}

export interface PaymentApplicationIntegritySummary {
  totalApplicationRows: number;
  orphanPaymentReferences: number;
  orphanInvoiceReferences: number;
  duplicatePaymentInvoicePairs: number;
  applicationsWithInactiveOrDeletedQboIdentity: number;
}

export interface ReportingRepository {
  getInvoiceSummary(dateRange?: DateRangeFilter): Promise<InvoiceSummary>;
  getPaymentSummary(dateRange?: DateRangeFilter): Promise<PaymentSummary>;
  getQboCompleteness(): Promise<QboCompletenessReport>;
  getCustomerIdentityQuality(): Promise<CustomerIdentityQualitySummary>;
  getPaymentApplicationIntegrity(): Promise<PaymentApplicationIntegritySummary>;
}

export interface ReportingSnapshot {
  invoices: InvoiceSummary;
  payments: PaymentSummary;
  qboCompleteness: QboCompletenessReport;
  customerIdentityQuality: CustomerIdentityQualitySummary;
  paymentApplicationIntegrity: PaymentApplicationIntegritySummary;
}
