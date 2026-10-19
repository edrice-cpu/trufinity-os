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

// Sync health states for Telecom V2/V3 rows. Not populated for regular entities.
//
//   HEALTHY      — checkpoint advanced within the last TELECOM_SYNC_STALE_HOURS (6h)
//   STALE        — checkpoint older than 6h and last run did not fail
//   FAILED       — most recent sync_run has status FAILED
//   NEVER_SYNCED — no raw_sync_metadata checkpoint exists (historical ingestion not run)
//   DISABLED     — scheduler feature flag is off (safe: may still have old data)
//   UNKNOWN      — ambiguous state (checkpoint row exists but last_synced_at is null)
export type TelecomSyncHealth = 'HEALTHY' | 'STALE' | 'FAILED' | 'NEVER_SYNCED' | 'DISABLED' | 'UNKNOWN';

// Stale threshold in hours — matches TELECOM_CHECKPOINT_STALE_HOURS in servicetitan.scheduler.ts.
// Exposed here so tests can reference the same value without importing the scheduler.
export const TELECOM_SYNC_STALE_HOURS = 6;

export interface StSyncStatusRow {
  entityType: string;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunRecordsProcessed: number | null;
  lastSuccessfulSyncAt: string | null;
  latestRawRecordCount: number;
  // Optional telecom-only fields — absent for regular entities (Customer, Job, etc.)
  schedulerEnabled?: boolean;
  checkpointAt?: string | null;
  syncHealth?: TelecomSyncHealth;
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

// ─── Telecom: Abandoned Calls ─────────────────────────────────────────────────
//
// Source: st_calls_v3_enrichment WHERE call_type = 'Abandoned' AND direction = 'Inbound'
// These are ServiceTitan-classified abandoned inbound calls — callers who reached
// the phone system but disconnected before being answered. This is NOT equivalent
// to all missed-call scenarios (e.g. ring-with-no-answer requires Dialpad integration).

export interface AbandonedCallItem {
  callId: string;
  receivedOn: string;           // ISO timestamp — leadCall.receivedOn
  duration: string | null;      // ISO-8601 duration string
  agentId: string | null;       // null for the ~99% of abandoned calls with no agent
  agentName: string | null;
  customerId: string | null;    // ST customer ID from raw_st_calls (null if not linked)
  jobId: string | null;         // ST job ID from raw_st_calls (null if not job-related)
  hasVoicemail: boolean;        // true when a voicemail was left
  v2Linked: boolean;            // false only for calls not yet in raw_st_calls (rare)
}

export interface AbandonedCallsDaySummary {
  date: string;                 // YYYY-MM-DD in UTC
  count: number;
}

export interface AbandonedCallsHourSummary {
  hour: number;                 // 0–23 UTC hour
  count: number;
}

export interface AbandonedCallsAggregate {
  totalCount: number;
  withVoicemail: number;
  withCustomerId: number;
  byDay: AbandonedCallsDaySummary[];
  byHour: AbandonedCallsHourSummary[];
}

// ─── Telecom: D-02a Voicemail Callback Alerts ────────────────────────────────
//
// Source: telecom_voicemail_callback_alerts (migration 023)
// Populated by the D-02a rule in telecom-voicemail-callback.rule.ts.
// No PII is exposed — no phone numbers, recording URLs, or raw payloads.

export type VoicemailCallbackAlertStatus = 'OPEN' | 'RESOLVED' | 'UNVERIFIABLE';

export const VOICEMAIL_CALLBACK_ALERT_STATUSES: readonly VoicemailCallbackAlertStatus[] = [
  'OPEN',
  'RESOLVED',
  'UNVERIFIABLE',
];

export interface VoicemailCallbackAlertItem {
  sourceId: string;
  status: VoicemailCallbackAlertStatus;
  voicemailAt: string;                  // ISO timestamp — when the voicemail was left
  thresholdMinutes: number;             // configured SLA threshold at alert creation time
  businessMinutesElapsed: number;       // business minutes since voicemail at last evaluation
  thresholdExceededAt: string | null;   // ISO timestamp — when SLA was first breached; null = within SLA
  callbackAt: string | null;            // ISO timestamp — when outbound callback was found; null for OPEN/UNVERIFIABLE
  updatedAt: string;                    // ISO timestamp — last evaluation timestamp
}

// ─── Telecom: Agent Metrics ───────────────────────────────────────────────────
//
// Source: st_calls_v3_enrichment (one row per call; unique on source_system+source_id).
// No join to raw_st_calls is required — all needed columns exist in V3.
// agent_id = null means the call had no agent attribution in ST (e.g. abandoned
// calls that were never answered). These are reported as a separate NULL group.
//
// Duration: stored as ISO-8601 duration string (e.g. "PT5M30S"). Converted to
// seconds in SQL via EXTRACT(EPOCH FROM duration::interval). NULL or empty
// duration strings are excluded from SUM/AVG — totalDurationSeconds = 0 if none.
//
// Limitations:
//   - No live availability or occupancy data (requires Dialpad integration).
//   - Booking rate and revenue-per-agent cannot be reliably computed from call
//     data alone without a confirmed call→job→booking linkage (Dialpad limitation).
//   - abandonedCalls counts ST-classified 'Abandoned' calls where the agent_id
//     was still populated (rare — most abandoned calls have agent_id = null).

export interface AgentMetricsItem {
  agentId: string | null;         // null = calls with no agent attribution in ST
  agentName: string | null;
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  abandonedCalls: number;         // ST call_type = 'Abandoned' (caller disconnected before answer)
  bookedCalls: number;            // ST call_type = 'Booked'
  unbookedCalls: number;          // ST call_type = 'Unbooked'
  excusedCalls: number;           // ST call_type = 'Excused'
  notLeadCalls: number;           // ST call_type = 'NotLead'
  classifiedCalls: number;        // call_type IS NOT NULL (any ST classification)
  unclassifiedCalls: number;      // call_type IS NULL (no ST classification recorded)
  totalDurationSeconds: number;   // SUM of ISO-8601 duration fields converted to seconds
  avgDurationSeconds: number;     // AVG rounded to nearest second; 0 if no duration data
  firstCallAt: string | null;     // ISO timestamp of earliest call in the window
  lastCallAt: string | null;      // ISO timestamp of most recent call in the window
}

// ─── Telecom: Call-to-Revenue Attribution ────────────────────────────────────
//
// Attribution chain: raw_st_calls.st_job_id → raw_st_invoices payload->'job'->>'id'
// Customer ID is returned as context only — customer-level revenue is NOT
// attributed to a call (a customer may have many jobs and many invoices).
//
// Attribution statuses:
//   JOB_LINKED  — call has a job ID; invoice(s) found via job→invoice join
//   NO_JOB      — call has a customer ID but no job ID; no revenue can be attributed
//   NO_LINKAGE  — call has neither customer nor job ID (anonymous or unmatched)

export type CallRevenueAttributionStatus = 'JOB_LINKED' | 'NO_JOB' | 'NO_LINKAGE';
export type CallRevenueAttributionMethod = 'call_job_invoice' | 'none';

export interface CallRevenueAttribution {
  callId: string;
  attributionStatus: CallRevenueAttributionStatus;
  attributionMethod: CallRevenueAttributionMethod;
  customerId: string | null;          // st_customer_id — context only, not revenue basis
  jobId: string | null;               // st_job_id — the linkage anchor
  linkedInvoiceCount: number;         // 0 when no job or no invoices found
  invoicedAmount: string | null;      // SUM(invoice.total) for job's invoices; null when no job
  outstandingBalance: string | null;  // SUM(invoice.balance) for unpaid invoices; null when no job
  currency: 'USD' | null;             // null when no invoices; ServiceTitan is USD-only
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
