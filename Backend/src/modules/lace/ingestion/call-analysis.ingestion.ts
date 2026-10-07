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

// Natural key: the trailing path segment of "Call link", e.g.
// https://www.lace.ai/app/call-center-all-calls/85a301f5dc6fbb39 -> 85a301f5dc6fbb39.
// The scheduled-export module has no standalone "Lace call id" column (confirmed
// against the real live bucket export, 11,738 rows, 0 missing/duplicate) - Svet's
// warning that field names drift between the live Call Center app and the export
// module applies here. "CRM call id" is not used as the key because it can be
// blank for calls that never became a ServiceTitan job.
const CALL_ANALYSIS_CONFIG: LaceIngestionConfig = {
  exportType: 'call_analysis',
  rawTable: 'raw_lace_call_analysis',
  s3Prefix: env.LACE_S3_CALL_ANALYSIS_PREFIX,
  lockKey: 'trufinity:lace:call-analysis-ingestion',
  extractSourceId: (row) => {
    const link = row['Call link'];
    if (typeof link !== 'string' || link.trim().length === 0) return null;
    const id = link.trim().split('/').pop();
    return id !== undefined && id.length > 0 ? id : null;
  },
};

export type CallAnalysisRawRepository = LaceIngestionRepository;
export type CallAnalysisRawRecord = LaceRawRecord;
export type InvalidCallAnalysisRecord = InvalidLaceRecord;
export { LaceSyncInProgressError as CallAnalysisSyncInProgressError };

export class PostgresCallAnalysisRawRepository extends PostgresLaceRawRepository {
  public constructor(database = db) {
    super(CALL_ANALYSIS_CONFIG, database);
  }
}

export class LaceCallAnalysisIngestionService extends LaceFileIngestionService {
  public constructor(
    objectStore: LaceObjectStore = laceObjectStore,
    repository: CallAnalysisRawRepository = new PostgresCallAnalysisRawRepository(),
  ) {
    super(CALL_ANALYSIS_CONFIG, objectStore, repository);
  }
}

export const laceCallAnalysisIngestionService = new LaceCallAnalysisIngestionService();
