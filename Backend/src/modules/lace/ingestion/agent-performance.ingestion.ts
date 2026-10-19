import { db } from '../../../database';
import { env } from '../../../config/env';
import { laceObjectStore, type LaceObjectStore } from '../s3.client';
import {
  PostgresLaceRawRepository,
  LaceFileIngestionService,
  LaceSyncInProgressError,
  type LaceIngestionConfig,
  type LaceIngestionRepository,
  type LaceRawRecord,
  type InvalidLaceRecord,
} from './lace-raw.ingestion';

// Natural key = CSR + Period Start + Period End (the real Monthly Agent
// Performance Report has no agent id column - see LaceAgentPerformanceRow). A
// re-sent report for the same CSR and month supersedes the earlier row via
// is_latest, as everywhere else in the raw layer.
const AGENT_PERFORMANCE_CONFIG: LaceIngestionConfig = {
  exportType: 'agent_performance',
  rawTable: 'raw_lace_agent_performance',
  s3Prefix: env.LACE_S3_AGENT_PERFORMANCE_PREFIX,
  lockKey: 'trufinity:lace:agent-performance-ingestion',
  extractSourceId: (row) => {
    const csr = row.CSR?.trim();
    const periodStart = row['Period Start']?.trim();
    const periodEnd = row['Period End']?.trim();
    if (!csr || !periodStart || !periodEnd) return null;
    return `${csr}__${periodStart}__${periodEnd}`;
  },
};

export type AgentPerformanceRawRepository = LaceIngestionRepository;
export type AgentPerformanceRawRecord = LaceRawRecord;
export type InvalidAgentPerformanceRecord = InvalidLaceRecord;
export { LaceSyncInProgressError as AgentPerformanceSyncInProgressError };

export class PostgresAgentPerformanceRawRepository extends PostgresLaceRawRepository {
  public constructor(database = db) {
    super(AGENT_PERFORMANCE_CONFIG, database);
  }
}

export class LaceAgentPerformanceIngestionService extends LaceFileIngestionService {
  public constructor(
    objectStore: LaceObjectStore = laceObjectStore,
    repository: AgentPerformanceRawRepository = new PostgresAgentPerformanceRawRepository(),
  ) {
    super(AGENT_PERFORMANCE_CONFIG, objectStore, repository);
  }
}

export const laceAgentPerformanceIngestionService = new LaceAgentPerformanceIngestionService();
