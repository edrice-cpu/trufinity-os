import type { QboCustomer, QboInvoice, QboPayment } from '../types';

export const QBO_MAPPING_PAGE_SIZE = 250;
export const QBO_MAPPING_LOCK_KEYS = [
  'QuickBooks:UnifiedMapping',
  // Hold the source locks so the mapper reads a stable QBO snapshot while it runs.
  'QuickBooks:Customer', 'QuickBooks:Invoice', 'QuickBooks:Payment',
  'QuickBooks:Customers', 'QuickBooks:Invoices', 'QuickBooks:Payments',
] as const;

export type QboMappingEntity = 'Customer' | 'Invoice' | 'Payment' | 'PaymentApplication';
export type QboRawEntity = 'Customers' | 'Invoices' | 'Payments';

export type QboMappingSkipReason =
  | 'INVALID_SOURCE_RECORD'
  | 'INVALID_SOURCE_ID'
  | 'SOURCE_ID_MISMATCH'
  | 'INVALID_DISPLAY_NAME'
  | 'MISSING_CUSTOMER_REF'
  | 'INVALID_TOTAL_AMOUNT'
  | 'INVALID_BALANCE'
  | 'INVALID_TAX'
  | 'INVALID_TXN_DATE'
  | 'INVALID_DUE_DATE'
  | 'MALFORMED_INVOICE_LINES'
  | 'MALFORMED_INVOICE_LINE'
  | 'INVALID_DISCOUNT_AMOUNT'
  | 'INVALID_UNAPPLIED_AMOUNT'
  | 'MALFORMED_PAYMENT_LINES'
  | 'MALFORMED_PAYMENT_LINE'
  | 'MALFORMED_LINKED_TXN'
  | 'MISSING_LINKED_TXN_ID'
  | 'INVALID_APPLICATION_AMOUNT'
  | 'AMBIGUOUS_MULTIPLE_INVOICE_LINKS'
  | 'CUSTOMER_IDENTITY_NOT_FOUND'
  | 'INVOICE_IDENTITY_NOT_FOUND'
  | 'PAYMENT_IDENTITY_NOT_FOUND';

export interface RawQboRecord {
  source_id: string;
  payload: unknown;
  is_deleted: boolean;
}

export interface MappingIssue {
  entity: QboMappingEntity;
  sourceId: string | null;
  reason: QboMappingSkipReason;
}

export interface QboCustomerProjection {
  sourceId: string;
  name: string | null;
  sourceSpecificData: Record<string, unknown>;
}

export interface QboInvoiceProjection {
  sourceId: string;
  customerSourceId: string;
  totalAmount: string;
  balance: string;
  tax: string;
  discount: string;
  invoiceDate: string | null;
  dueDate: string | null;
  sourceSpecificData: Record<string, unknown>;
}

export interface QboPaymentApplicationProjection {
  invoiceSourceId: string;
  appliedAmount: string;
}

export interface QboPaymentProjection {
  sourceId: string;
  customerSourceId: string;
  totalAmount: string;
  unappliedAmount: string;
  paymentDate: string;
  sourceSpecificData: Record<string, unknown>;
  applications: QboPaymentApplicationProjection[];
  applicationIssues: MappingIssue[];
}

export type ParsedSource<T> =
  | { kind: 'mapped'; value: T }
  | { kind: 'deleted'; sourceId: string }
  | { kind: 'skipped'; issue: MappingIssue };

export interface QboMappingBatchResult {
  mapped: number;
  deleted: number;
  skipped: number;
  applicationMapped?: number;
  applicationSkipped?: number;
  issues: MappingIssue[];
}

export interface QboMappingCounts {
  mapped: number;
  deleted: number;
  skipped: number;
}

export interface QboUnifiedMappingResult {
  syncRunId: string;
  recordsProcessed: number;
  customers: QboMappingCounts;
  invoices: QboMappingCounts;
  payments: QboMappingCounts;
  paymentApplications: { mapped: number; skipped: number };
  skippedByReason: Partial<Record<QboMappingSkipReason, number>>;
}

export interface QboUnifiedMappingStore {
  acquireLocks(): Promise<(() => Promise<void>) | null>;
  recoverStaleRuns(): Promise<void>;
  createRun(): Promise<string>;
  loadLatestBatch(entity: QboRawEntity, afterSourceId: string | null, limit: number): Promise<RawQboRecord[]>;
  persistCustomers(runId: string, records: QboCustomerProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult>;
  persistInvoices(runId: string, records: QboInvoiceProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult>;
  persistPayments(runId: string, records: QboPaymentProjection[], deletedIds: string[], issues: MappingIssue[]): Promise<QboMappingBatchResult>;
  persistPaymentApplications(runId: string, records: QboPaymentProjection[]): Promise<QboMappingBatchResult>;
  completeRun(runId: string, recordsProcessed: number): Promise<void>;
  failRun(runId: string, message: string, recordsProcessed: number): Promise<void>;
}

export type QboCustomerPayload = QboCustomer;
export type QboInvoicePayload = QboInvoice;
export type QboPaymentPayload = QboPayment;
