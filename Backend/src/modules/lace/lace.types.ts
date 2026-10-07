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

export interface LaceAgentPerformanceRow {
  'Agent name': string;
  'Agent id': string;
  Company: string;
  Period: string;
  'Period start': string;
  'Period end': string;
  'Total calls': string;
  'Analyzed calls': string;
  'Qualified calls': string;
  'Qualified %': string;
  'Booked calls': string;
  'Booking rate %': string;
  'Target booking rate %': string;
  'Variance vs target': string;
  'Qualified & unbooked': string;
  'Avg playbook score': string;
  'Avg handle time (sec)': string;
  'Transferred calls': string;
  'Transfer rate %': string;
  'Jobs created': string;
  'Jobs completed': string;
  'Jobs cancelled': string;
  'Invoice subtotal (USD)': string;
  'Revenue per booked call (USD)': string;
}
