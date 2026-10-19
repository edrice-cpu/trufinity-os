import type { Knex } from 'knex';
import { db } from '../../database';
import { env } from '../../config/env';
import { SOURCE_SYSTEM, SYNC_RUN_STATUS } from '../../utils/sync-run.constants';

// Per-export health of the Lace AI feed - SPEC-BI-001 Layer 1 ("failed
// extraction must raise an alert, never fail silently") and Section 7 (the
// brief header shows a data-freshness timestamp per source and any extraction
// failure, and never presents a partial picture as complete).
//
// status:
//   NO_DATA  - nothing has ever been ingested for this export
//   FAILING  - the most recent sync run(s) failed
//   STALE    - runs succeed, but no new Lace file has arrived within the
//              export's expected cadence (e.g. Lace stopped sending)
//   OK       - fresh
export type LaceExportType = 'call_analysis' | 'agent_performance';
export type LaceFreshnessStatus = 'OK' | 'STALE' | 'FAILING' | 'NO_DATA';

export interface LaceExportFreshness {
  exportType: LaceExportType;
  status: LaceFreshnessStatus;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunRecordsProcessed: number | null;
  lastSuccessfulSyncAt: string | null;
  consecutiveFailures: number;
  lastFileIngestedAt: string | null;
  // Newest business date in the data: latest call received (call analysis)
  // or latest report period end (agent performance).
  latestDataAt: string | null;
  latestRawRecordCount: number;
  maxFileAgeHours: number;
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string).toISOString());

// Latest data date per export. Calls dated in the future (bad data / test
// fixtures) are ignored so they can't make a stale feed look fresh. Report
// periods are "YYYY-MM-DD HH:MM:SS" read as UTC (see booking-rate-reconciliation.ts).
const LATEST_DATA_SQL: Record<LaceExportType, string> = {
  call_analysis: `SELECT MAX(received_at) AS at FROM canonical_lace_calls WHERE received_at <= ?`,
  agent_performance: `
    SELECT MAX((replace(payload->>'Period End', ' ', 'T') || 'Z')::timestamptz) AS at
    FROM raw_lace_agent_performance
    WHERE is_latest = true AND payload->>'Period End' ~ '^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$'
      AND (replace(payload->>'Period End', ' ', 'T') || 'Z')::timestamptz <= ?`,
};

const RAW_TABLE: Record<LaceExportType, string> = {
  call_analysis: 'raw_lace_call_analysis',
  agent_performance: 'raw_lace_agent_performance',
};

export const maxFileAgeHours = (exportType: LaceExportType): number =>
  exportType === 'call_analysis' ? env.LACE_CALL_ANALYSIS_MAX_AGE_HOURS : env.LACE_AGENT_PERFORMANCE_MAX_AGE_DAYS * 24;

type Row = Record<string, unknown>;
const first = async (database: Knex, sql: string, bindings: readonly Knex.RawBinding[]): Promise<Row | undefined> => {
  const result: { rows: Row[] } = await database.raw(sql, bindings);
  return result.rows[0];
};

async function exportFreshness(database: Knex, exportType: LaceExportType, now: Date): Promise<LaceExportFreshness> {
  const runFilter = `source_system = '${SOURCE_SYSTEM.LACE_AI}' AND entity_type = ?`;
  const [lastRun, lastSuccess, lastFile, latestData, rawCount] = await Promise.all([
    first(database, `SELECT status, started_at, completed_at, records_processed FROM sync_runs WHERE ${runFilter} ORDER BY started_at DESC LIMIT 1`, [exportType]),
    first(database, `SELECT MAX(completed_at) AS completed_at, MAX(started_at) AS started_at FROM sync_runs WHERE ${runFilter} AND status IN ('${SYNC_RUN_STATUS.COMPLETED}', '${SYNC_RUN_STATUS.COMPLETED_WITH_ERRORS}')`, [exportType]),
    first(database, `SELECT MAX(ingested_at) AS at FROM lace_ingested_files WHERE export_type = ?`, [exportType]),
    first(database, LATEST_DATA_SQL[exportType], [now]),
    first(database, `SELECT COUNT(*)::int AS n FROM ${RAW_TABLE[exportType]} WHERE is_latest = true`, []),
  ]);
  const failures = await first(database,
    `SELECT COUNT(*)::int AS n FROM sync_runs WHERE ${runFilter} AND status = '${SYNC_RUN_STATUS.FAILED}' AND started_at > COALESCE(?::timestamptz, '-infinity')`,
    [exportType, (lastSuccess?.started_at as Date | null | undefined) ?? null]);

  const consecutiveFailures = Number(failures?.n ?? 0);
  const lastFileIngestedAt = iso(lastFile?.at);
  const maxAge = maxFileAgeHours(exportType);

  let status: LaceFreshnessStatus;
  if (!lastFileIngestedAt && !lastSuccess?.completed_at) status = 'NO_DATA';
  else if (consecutiveFailures > 0 && lastRun?.status === SYNC_RUN_STATUS.FAILED) status = 'FAILING';
  else if (!lastFileIngestedAt || now.getTime() - new Date(lastFileIngestedAt).getTime() > maxAge * 3_600_000) status = 'STALE';
  else status = 'OK';

  return {
    exportType,
    status,
    lastRunStatus: typeof lastRun?.status === 'string' ? lastRun.status : null,
    lastRunStartedAt: iso(lastRun?.started_at),
    lastRunCompletedAt: iso(lastRun?.completed_at),
    lastRunRecordsProcessed: lastRun ? Number(lastRun.records_processed ?? 0) : null,
    lastSuccessfulSyncAt: iso(lastSuccess?.completed_at),
    consecutiveFailures,
    lastFileIngestedAt,
    latestDataAt: iso(latestData?.at),
    latestRawRecordCount: Number(rawCount?.n ?? 0),
    maxFileAgeHours: maxAge,
  };
}

export async function getLaceFreshness(database: Knex = db, now: Date = new Date()): Promise<LaceExportFreshness[]> {
  return Promise.all((['call_analysis', 'agent_performance'] as const).map((type) => exportFreshness(database, type, now)));
}
