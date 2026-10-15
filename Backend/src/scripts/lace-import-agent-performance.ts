import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { env } from '../config/env';
import { db } from '../database';
import { googleWorkspaceAuthService } from '../modules/google/google-auth.service';
import { LaceAgentPerformanceIngestionService } from '../modules/lace/ingestion/agent-performance.ingestion';
import { reconcileLaceBookingRates } from '../modules/lace/booking-rate-reconciliation';
import { LocalFileObjectStore } from '../modules/lace/local-file.store';
import { LaceReportMailboxStore } from '../modules/lace/report-mailbox.store';
import type { LaceObjectStore } from '../modules/lace/s3.client';

// Imports Lace "Monthly Agent Performance Report" CSVs into
// raw_lace_agent_performance through the same ingestion service the S3 path
// uses, then reconciles our booking rate against Lace's reported Success
// Ratio. Safe to re-run: anything already ingested is skipped.
//
// From a downloaded file:
//   npm run lace:import-agent-performance -- --file "C:/path/report_20261011.csv"
// From the report inbox now (same as the daily job; needs LACE_REPORT_MAILBOX):
//   npm run lace:import-agent-performance -- --from-mailbox
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { file: { type: 'string' }, 'from-mailbox': { type: 'boolean' } } });

  let store: LaceObjectStore;
  if (values['from-mailbox']) {
    if (!env.LACE_REPORT_MAILBOX) throw new Error('LACE_REPORT_MAILBOX is not set.');
    store = new LaceReportMailboxStore(googleWorkspaceAuthService.getLaceReportGmailClient(env.LACE_REPORT_MAILBOX), env.LACE_REPORT_GMAIL_QUERY);
  } else if (values.file) {
    const filePath = resolve(values.file);
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    store = new LocalFileObjectStore(filePath);
  } else {
    throw new Error('Usage: npm run lace:import-agent-performance -- (--file <path-to-csv> | --from-mailbox)');
  }

  const result = await new LaceAgentPerformanceIngestionService(store).run();
  console.log(result.filesProcessed === 0
    ? 'Nothing new to ingest (already imported, or no matching report found).'
    : `Imported ${result.recordsProcessed} row(s) from ${result.filesProcessed} file(s) (sync run ${result.syncRunId}).`);

  const reconciliation = await reconcileLaceBookingRates();
  console.table(reconciliation.map((r) => ({
    csr: r.csr,
    month: r.periodStart.toISOString().slice(0, 7),
    laceSuccessRatio: r.laceSuccessRatioPercent,
    ourRate: r.ourRatePercent === null ? null : Number(r.ourRatePercent.toFixed(1)),
    laceQualified: r.laceQualified,
    ourQualified: r.ourQualified,
    status: r.status,
  })));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Lace agent performance import failed.');
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
