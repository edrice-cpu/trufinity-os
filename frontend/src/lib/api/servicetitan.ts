import { cache } from "react";
import { apiGet, apiGetPage } from "./client";
import type { DecimalString } from "./reporting";
import type { DateRange, Department } from "../filters";

export interface CountByLabel {
  label: string;
  count: number;
}

export interface StJobsSummary {
  totalJobs: number;
  completedJobs: number;
  completedLast30Days: number;
  createdLast30Days: number;
  noChargeJobs: number;
  recallJobs: number;
  /** O-06: completed jobs with no invoice. */
  completedNotInvoiced: number;
  jobsTotalValue: DecimalString;
  byStatus: CountByLabel[];
}

export interface StInvoicesSummary {
  totalActiveInvoices: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
  invoiceTotal: DecimalString;
  outstandingBalance: DecimalString;
  totalDiscount: DecimalString;
  totalSalesTax: DecimalString;
  invoicedLast30Days: DecimalString;
  overdueCount: number;
}

export type StArAgingBucketId = "CURRENT" | "DAYS_1_30" | "DAYS_31_60" | "DAYS_61_90" | "DAYS_90_PLUS";

export interface StArAgingBucket {
  bucket: StArAgingBucketId;
  invoiceCount: number;
  balance: DecimalString;
}

export interface StPaymentsSummary {
  paymentCount: number;
  paymentTotal: DecimalString;
  unappliedTotal: DecimalString;
  receivedLast30Days: DecimalString;
  byType: { label: string; count: number; total: DecimalString }[];
}

export interface StLeadsBookingsSummary {
  totalLeads: number;
  leadsLast30Days: number;
  leadsByStatus: CountByLabel[];
  totalBookings: number;
  bookingsLast30Days: number;
  bookingsByStatus: CountByLabel[];
  bookingsConvertedToJob: number;
}

export interface StAppointmentsSummary {
  totalAppointments: number;
  upcomingAppointments: number;
  unconfirmedUpcoming: number;
  byStatus: CountByLabel[];
}

export interface StCustomersSummary {
  totalCustomers: number;
  activeCustomers: number;
  customersWithBalance: number;
  totalCustomerBalance: DecimalString;
  createdLast30Days: number;
}

/** Confidential — only render for roles allowed by canViewConfidential(). */
export interface StTechnicianSummaryRow {
  technicianId: string;
  name: string | null;
  active: boolean | null;
  jobsSold: number;
  jobsSoldValue: DecimalString;
}

export interface StSyncStatusRow {
  entityType: string;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunRecordsProcessed: number | null;
  lastSuccessfulSyncAt: string | null;
  latestRawRecordCount: number;
}

export interface StReportingSnapshot {
  jobs: StJobsSummary;
  invoices: StInvoicesSummary;
  arAging: StArAgingBucket[];
  payments: StPaymentsSummary;
  leadsBookings: StLeadsBookingsSummary;
  appointments: StAppointmentsSummary;
  customers: StCustomersSummary;
  technicians: StTechnicianSummaryRow[];
  syncStatus: StSyncStatusRow[];
}

export interface StJobListItem {
  id: string;
  jobNumber: string | null;
  status: string | null;
  customerId: string | null;
  locationId: string | null;
  soldById: string | null;
  total: DecimalString | null;
  createdOn: string | null;
  completedOn: string | null;
  invoiceId: string | null;
  noCharge: boolean;
  isRecall: boolean;
}

export const ST_INVOICE_CLASSIFICATIONS = ["PAID", "PARTIALLY_PAID", "UNPAID", "ZERO_VALUE"] as const;
export type StInvoiceClassification = (typeof ST_INVOICE_CLASSIFICATIONS)[number];

export interface StInvoiceListItem {
  id: string;
  referenceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  total: DecimalString | null;
  balance: DecimalString | null;
  customerId: string | null;
  jobId: string | null;
  paidOn: string | null;
  classification: StInvoiceClassification;
}

export const ST_MAX_PAGE_SIZE = 100;

const BASE = "/api/reporting/servicetitan";

// Combined call for initial page loads; memoized per request so several sections share one fetch.
export const getServiceTitanSummary = cache(() => apiGet<StReportingSnapshot>(`${BASE}/summary`));

/** Date + department filterable; omitted date = month-to-date, omitted department = all departments. */
export const getStJobsSummary = (filters: DateRange & { department?: Department } = {}) =>
  apiGet<StJobsSummary>(`${BASE}/jobs/summary`, {
    from: filters.from,
    to: filters.to,
    department: filters.department,
  });
export const getStInvoicesSummary = () => apiGet<StInvoicesSummary>(`${BASE}/invoices/summary`);
export const getStArAging = () => apiGet<StArAgingBucket[]>(`${BASE}/invoices/ar-aging`);
export const getStPaymentsSummary = () => apiGet<StPaymentsSummary>(`${BASE}/payments/summary`);
export const getStLeadsBookingsSummary = () => apiGet<StLeadsBookingsSummary>(`${BASE}/leads-bookings/summary`);
export const getStAppointmentsSummary = () => apiGet<StAppointmentsSummary>(`${BASE}/appointments/summary`);
export const getStCustomersSummary = () => apiGet<StCustomersSummary>(`${BASE}/customers/summary`);
export const getStTechnicianSummary = () => apiGet<StTechnicianSummaryRow[]>(`${BASE}/technicians/summary`);
export const getStSyncStatus = cache(() => apiGet<StSyncStatusRow[]>(`${BASE}/sync-status`));

export const listStJobs = (params: { page?: number; pageSize?: number; status?: string }) =>
  apiGetPage<StJobListItem>(`${BASE}/jobs`, params);

export const listStInvoices = (params: { page?: number; pageSize?: number; classification?: StInvoiceClassification }) =>
  apiGetPage<StInvoiceListItem>(`${BASE}/invoices`, params);
