import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import {
  PostgresServiceTitanRawRepository,
  ServiceTitanRawIngestionService,
  SyncInProgressError,
  type RawExportApi,
  type RawExportResponse,
  type RawIngestionRepository,
  type InvalidRawRecord,
} from './raw-export.ingestion';

const BUSINESS_UNIT_CONFIG = {
  sourceSystem: 'ServiceTitan',
  entityType: 'BusinessUnit',
  rawTable: 'raw_st_business_units',
  exportEndpoint: `/settings/v2/tenant/${env.SERVICETITAN_TENANT_ID}/business-units`,
  lockKey: 'trufinity:servicetitan:business-unit-ingestion',
} as const;

const PAGE_SIZE = 200;

// Business Units come from a paginated Settings endpoint (page/pageSize), not
// an Export endpoint (continuation token) - this adapter maps that shape onto
// the RawExportApi contract so the existing ingestion engine (advisory lock,
// sync-run bookkeeping, per-record error handling) can be reused as-is
// instead of duplicated for one small, mostly-static reference list.
class BusinessUnitExportApi implements RawExportApi {
  public async get<T>(_endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const page = typeof params.from === 'string' && params.from.length > 0 ? Number(params.from) : 1;
    const response = await apiClient.get<{ data: unknown[]; hasMore: boolean }>(BUSINESS_UNIT_CONFIG.exportEndpoint, {
      page,
      pageSize: PAGE_SIZE,
    });
    const mapped: RawExportResponse = {
      data: response.data,
      hasMore: response.hasMore,
      continueFrom: response.hasMore ? String(page + 1) : null,
    };
    return mapped as unknown as T;
  }
}

export type BusinessUnitExportResponse = RawExportResponse;
export type InvalidBusinessUnitRecord = InvalidRawRecord;
export type BusinessUnitRawRepository = RawIngestionRepository;
export { SyncInProgressError as BusinessUnitSyncInProgressError };

export class PostgresBusinessUnitRawRepository extends PostgresServiceTitanRawRepository {
  public constructor(database = db) { super(BUSINESS_UNIT_CONFIG, database); }
}

export class ServiceTitanBusinessUnitIngestionService extends ServiceTitanRawIngestionService {
  public constructor(
    client: RawExportApi = new BusinessUnitExportApi(),
    repository: BusinessUnitRawRepository = new PostgresBusinessUnitRawRepository(),
  ) {
    super(BUSINESS_UNIT_CONFIG, client, repository);
  }
}

export const serviceTitanBusinessUnitIngestionService = new ServiceTitanBusinessUnitIngestionService();
