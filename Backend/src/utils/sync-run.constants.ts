// Shared constants for the sync_runs / sync_errors tracking tables, used by
// every raw-ingestion module (Lace, ServiceTitan, QuickBooks). Centralized so
// table/status names aren't repeated as magic strings at every call site.
export const SYNC_RUNS_TABLE = 'sync_runs';
export const SYNC_ERRORS_TABLE = 'sync_errors';

export const SYNC_RUN_STATUS = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  COMPLETED_WITH_ERRORS: 'COMPLETED_WITH_ERRORS',
  FAILED: 'FAILED',
} as const;

export type SyncRunStatus = (typeof SYNC_RUN_STATUS)[keyof typeof SYNC_RUN_STATUS];

export const SOURCE_SYSTEM = {
  LACE_AI: 'LaceAI',
  SERVICE_TITAN: 'ServiceTitan',
  QUICKBOOKS: 'QuickBooks',
} as const;
