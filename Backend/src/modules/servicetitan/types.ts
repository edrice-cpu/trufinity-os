/* eslint-disable @typescript-eslint/no-explicit-any */
// ServiceTitan Type Definitions

export interface PaginatedResponse<T> {
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCount?: number;
  data: T[];
}

export interface ExportResponse<T> {
  hasMore: boolean;
  continueFrom: string;
  data: T[];
}

export interface Customer {
  id: number;
  active: boolean;
  name: string;
  type: string;
  address?: Record<string, any> | null;
  customFields?: any[];
  balance?: number;
  taxExempt?: boolean;
  tagTypeIds?: number[];
  doNotMail?: boolean;
  doNotService?: boolean;
  nationalAccount?: boolean;
  createdOn?: string;
  modifiedOn?: string;
  mergedToId?: number | null;
  paymentTermId?: number | null;
  creditLimit?: number | null;
  externalData?: any;
}

export interface Location {
  id: number;
  customerId: number;
  name?: string;
  address?: Record<string, any> | null;
  customFields?: any[];
  zoneId?: number | null;
  taxZoneId?: number | null;
  taxExempt?: boolean;
  tagTypeIds?: number[];
  createdOn?: string;
  modifiedOn?: string;
  externalData?: any;
}

export interface Booking {
  id: number;
  source?: string;
  createdOn?: string;
  name?: string;
  address?: Record<string, any> | null;
  start?: string;
  campaignId?: number | null;
  businessUnitId?: number | null;
  isFirstTimeClient?: boolean;
  uploadedImages?: string[];
  isSendConfirmationEmail?: boolean;
  status?: string;
  priority?: string;
  jobId?: number | null;
  externalId?: string | null;
  jobTypeId?: number | null;
  bookingProviderId?: number | null;
  modifiedOn?: string;
  summary?: string;
}

export interface Lead {
  id: number;
  summary?: string;
  callReasonId?: number | null;
  callId?: number | null;
  bookingId?: number | null;
  leadCustomerName?: string;
  leadPhone?: string;
  leadEmail?: string;
  leadStreet?: string;
  leadUnit?: string;
  leadCity?: string;
  leadState?: string;
  leadZip?: string;
  leadCountry?: string;
  captureSource?: string;
  status?: string;
  priority?: string;
  customerId?: number | null;
  locationId?: number | null;
  businessUnitId?: number | null;
  jobTypeId?: number | null;
  campaignId?: number | null;
  followUpDate?: string | null;
  createdById?: number | null;
  createdOn?: string;
  modifiedOn?: string;
  tagTypeIds?: number[];
  dismissingReasonId?: number | null;
}

export interface Job {
  id: number;
  jobNumber?: string;
  summary?: string;
  summaryOfWork?: string;
  customerId: number;
  locationId: number;
  projectId?: number | null;
  jobStatus?: string;
  completedOn?: string | null;
  businessUnitId?: number | null;
  jobTypeId?: number | null;
  priority?: string;
  campaignId?: number | null;
  appointmentCount?: number;
  firstAppointmentId?: number | null;
  lastAppointmentId?: number | null;
  recallForId?: number | null;
  warrantyId?: number | null;
  noCharge?: boolean;
  notificationsEnabled?: boolean;
  createdOn?: string;
  createdById?: number | null;
  modifiedOn?: string;
  tagTypeIds?: number[];
  leadCallId?: number | null;
  partnerLeadCallId?: number | null;
  bookingId?: number | null;
  soldById?: number | null;
  customerPo?: string;
  invoiceId?: number | null;
  membershipId?: number | null;
  total?: number;
  estimateIds?: number[];
  equipmentIds?: number[];
  isAutoDispatched?: boolean;
}

export interface Appointment {
  id: number;
  jobId: number;
  appointmentNumber?: string;
  start?: string;
  end?: string;
  arrivalWindowStart?: string | null;
  arrivalWindowEnd?: string | null;
  status?: string;
  specialInstructions?: string;
  createdOn?: string;
  modifiedOn?: string;
  customerId?: number | null;
  createdById?: number | null;
  isConfirmed?: boolean;
  active?: boolean;
}

export interface Invoice {
  id: number;
  summary?: string;
  active?: boolean;
  discountTotal?: number;
  membershipId?: number | null;
  paidOn?: string | null;
  invoiceConfiguration?: any;
  referenceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  subTotal?: number;
  salesTax?: number;
  total?: number;
  balance?: number;
  invoiceType?: string;
  customer?: { id: number; [key: string]: any };
  location?: { id: number; [key: string]: any };
  job?: { id: number; [key: string]: any };
  createdOn?: string;
  modifiedOn?: string;
}

export interface Payment {
  id: number;
  active?: boolean;
  total?: number;
  type?: string;
  typeId?: number | null;
  date?: string;
  customer?: any;
  appliedTo?: any;
  unappliedAmount?: number;
  createdOn?: string;
  modifiedOn?: string;
}
