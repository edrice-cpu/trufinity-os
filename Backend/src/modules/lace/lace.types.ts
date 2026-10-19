export interface LaceS3Object {
  key: string;
  eTag: string;
  lastModified: Date | null;
  size: number;
}

// Column names match the real scheduled export delivered to the S3 bucket
// (verified against report_Lace_CcCallAnalysisExport_DAILY_*.csv, Sept 2026),
// NOT the earlier sample CSVs Lace originally sent - those had a standalone
// "Lace call id" column that the live export module does not produce. Svet's
// warning that field names drift between the live app and the export module
// applies here; the call's unique id is now only available embedded in the
// trailing path segment of "Call link" (see call-analysis.ingestion.ts).
// Values are kept as raw strings here - the immutable raw layer stores
// exactly what the vendor sent; type coercion happens in the canonical layer.
export interface LaceCallAnalysisRow {
  CRM: string;
  CSR: string;
  Tags: string;
  Booked: string;
  Company: string;
  Campaign: string;
  'Call link': string;
  Qualified: string;
  'Job number': string;
  Objections: string;
  'CRM call id': string;
  'CRM tenant id': string;
  'Customer name': string;
  'Short summary': string;
  'Call direction': string;
  'Customer phone': string;
  'Duration (sec)': string;
  'Playbook score': string;
  'Unbooked reason': string;
  'Existing customer': string;
  'Cancellation reason': string;
  'Date received (UTC)': string;
  'Time received (UTC)': string;
  'Date received (Local)': string;
  'Qualification details': string;
  'Time received (Local)': string;
}

// Lace's "Monthly Agent Performance Report" (e.g. report_20261011.csv), as
// actually delivered: one row per CSR per calendar month, emailed to
// lace-report@trufinity.ca. Replaces an earlier guessed format (Agent id,
// Booking rate %, Jobs created, ...) that the real export never had.
// "Success Ratio" is Lace's booking rate = Booked / Qualified (see
// lace/booking-rate.ts). Period Start/End carry no timezone; they are read as
// UTC. A CSR with no calls that month still gets a row, with blanks
// (e.g. "0,0,,0,,"). Playbook Score and Most Coaching Needed are Lace's CSR
// coaching output - stored raw only, never surfaced here (SPEC-BI-001 2.2:
// this system does not grade employees).
export interface LaceAgentPerformanceRow {
  CSR: string;
  'Period Start': string;
  'Period End': string;
  'Total Calls': string;
  'Success Ratio': string;
  'Cancellation Rate': string;
  Booked: string;
  Qualified: string;
  'Playbook Score': string;
  'Most Coaching Needed': string;
}
