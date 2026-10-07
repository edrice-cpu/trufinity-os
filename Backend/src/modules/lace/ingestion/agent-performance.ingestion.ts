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

// Natural key = Agent id + Period start + Period end. The export also includes a
// tenant-level "TOTAL / TENANT" rollup row with a blank Agent id
// (SAMPLE_AgentPerformanceReport_MONTHLY_*.csv) - that row is kept, not discarded,
// under a synthetic TENANT_TOTAL id since it's a legitimate distinct fact for a period.
const AGENT_PERFORMANCE_CONFIG: LaceIngestionConfig = {
  exportType: 'agent_performance',
  rawTable: 'raw_lace_agent_performance',
  s3Prefix: env.LACE_S3_AGENT_PERFORMANCE_PREFIX,
  lockKey: 'trufinity:lace:agent-performance-ingestion',
  extractSourceId: (row) => {
    const periodStart = row['Period start'];
    const periodEnd = row['Period end'];
    if (typeof periodStart !== 'string' || typeof periodEnd !== 'string' || periodStart.trim().length === 0 || periodEnd.trim().length === 0) {
      return null;
    }
    const agentId = typeof row['Agent id'] === 'string' && row['Agent id'].trim().length > 0 ? row['Agent id'].trim() : 'TENANT_TOTAL';
    return `${agentId}__${periodStart.trim()}__${periodEnd.trim()}`;
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
