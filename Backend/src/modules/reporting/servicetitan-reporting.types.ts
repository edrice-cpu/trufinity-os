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
  completedNotInvoiced: number;
  jobsTotalValue: string;
  byStatus: CountByLabel[];
}

export interface StInvoicesSummary {
  totalActiveInvoices: number;
  paidCount: number;
  partiallyPaidCount: number;
  unpaidCount: number;
  invoiceTotal: string;
  outstandingBalance: string;
  totalDiscount: string;
  totalSalesTax: string;
  invoicedLast30Days: string;
  overdueCount: number;
}

export interface StArAgingBucket {
  bucket: 'CURRENT' | 'DAYS_1_30' | 'DAYS_31_60' | 'DAYS_61_90' | 'DAYS_90_PLUS';
  invoiceCount: number;
  balance: string;
}

export interface StPaymentsSummary {
  paymentCount: number;
  paymentTotal: string;
  unappliedTotal: string;
  receivedLast30Days: string;
  byType: { label: string; count: number; total: string }[];
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
  totalCustomerBalance: string;
  createdLast30Days: number;
}

export interface StTechnicianSummaryRow {
  technicianId: string;
  name: string | null;
  active: boolean | null;
  jobsSold: number;
  jobsSoldValue: string;
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

export interface Paginated<T> {
  page: number;
  pageSize: number;
  totalCount: number;
  data: T[];
}

export interface StJobListItem {
  id: string;
  jobNumber: string | null;
  status: string | null;
  customerId: string | null;
  locationId: string | null;
  soldById: string | null;
  total: string | null;
  createdOn: string | null;
  completedOn: string | null;
  invoiceId: string | null;
  noCharge: boolean;
  isRecall: boolean;
}

export interface StInvoiceListItem {
  id: string;
  referenceNumber: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  total: string | null;
  balance: string | null;
  customerId: string | null;
  jobId: string | null;
  paidOn: string | null;
  classification: 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'ZERO_VALUE';
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
