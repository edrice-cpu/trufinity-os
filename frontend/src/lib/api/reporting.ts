import { cache } from "react";
import { apiGet } from "./client";
import type { DateRange } from "../filters";

/** Money values arrive as decimal strings, e.g. "12345.67". Format with formatMoney, never parse. */
export type DecimalString = string;

export interface InvoiceSummary {
  totalActiveInvoices: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
  zeroValueCount: number;
  unsupportedCount: number;
  invoiceTotal: DecimalString;
  outstandingAr: DecimalString;
  totalTax: DecimalString;
  totalDiscount: DecimalString;
  brokenTargetCount: number;
}

export interface PaymentSummary {
  paymentCount: number;
  paymentTotal: DecimalString;
  unappliedTotal: DecimalString;
  mappedApplicationTotal: DecimalString;
  reconciledPaymentCount: number;
  unreconciledPaymentCount: number;
  netReconciliationDifference: DecimalString;
  paymentsWithoutInvoiceApplications: number;
}

export interface EntityCompleteness {
  latestNonDeletedRawCount: number;
  activeIdentityCount: number;
  unifiedTargetCount: number;
  brokenTargetCount: number;
  duplicateSourceIdentityCount: number;
  mappingErrorCount: number;
}

export interface QboCompleteness {
  Customer: EntityCompleteness;
  Invoice: EntityCompleteness;
  Payment: EntityCompleteness;
}

export interface CustomerIdentityQuality {
  serviceTitanCustomerIdentityCount: number;
  verifiedTierACount: number;
  unresolvedCount: number;
  mergedCount: number;
  brokenUnifiedTargetCount: number;
  tierAWithoutSharedQboTarget: number;
  unresolvedSharingQboTarget: number;
}

export interface PaymentApplicationIntegrity {
  totalApplicationRows: number;
  orphanPaymentReferences: number;
  orphanInvoiceReferences: number;
  duplicatePaymentInvoicePairs: number;
  applicationsWithInactiveOrDeletedQboIdentity: number;
}

export interface QuickbooksSummary {
  invoices: InvoiceSummary;
  payments: PaymentSummary;
  qboCompleteness: QboCompleteness;
  customerIdentityQuality: CustomerIdentityQuality;
  paymentApplicationIntegrity: PaymentApplicationIntegrity;
}

const BASE = "/api/reporting/quickbooks";

// Combined call for the dashboard's initial load; memoized per request.
export const getQuickbooksSummary = cache(() => apiGet<QuickbooksSummary>(`${BASE}/summary`));

// Date-filterable (omitting the range = month-to-date). Memoized per request; `cache` needs
// primitive args to hit, hence from/to rather than a range object.
const invoiceSummary = cache((from?: string, to?: string) =>
  apiGet<InvoiceSummary>(`${BASE}/invoices/summary`, { from, to }),
);
const paymentSummary = cache((from?: string, to?: string) =>
  apiGet<PaymentSummary>(`${BASE}/payments/summary`, { from, to }),
);
export const getInvoiceSummary = (range: DateRange = {}) => invoiceSummary(range.from, range.to);
export const getPaymentSummary = (range: DateRange = {}) => paymentSummary(range.from, range.to);
export const getQboCompleteness = () => apiGet<QboCompleteness>(`${BASE}/completeness`);
export const getCustomerIdentityQuality = () =>
  apiGet<CustomerIdentityQuality>(`${BASE}/customer-identity-quality`);
export const getPaymentApplicationIntegrity = () =>
  apiGet<PaymentApplicationIntegrity>(`${BASE}/payment-application-integrity`);
