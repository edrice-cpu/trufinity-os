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

const LOCATION_CONFIG = {
  sourceSystem: 'ServiceTitan',
  entityType: 'Location',
  rawTable: 'raw_st_locations',
  exportEndpoint: `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/locations`,
  lockKey: 'trufinity:servicetitan:location-ingestion',
} as const;

export type LocationExportResponse = RawExportResponse;
export type LocationExportApi = RawExportApi;
export type InvalidLocationRecord = InvalidRawRecord;
export type LocationRawRepository = RawIngestionRepository;
export { SyncInProgressError as LocationSyncInProgressError };

export class PostgresLocationRawRepository extends PostgresServiceTitanRawRepository {
  public constructor(database = db) { super(LOCATION_CONFIG, database); }
}

export class ServiceTitanLocationIngestionService extends ServiceTitanRawIngestionService {
  public constructor(client: LocationExportApi = apiClient, repository: LocationRawRepository = new PostgresLocationRawRepository()) {
    super(LOCATION_CONFIG, client, repository);
  }
}

export const serviceTitanLocationIngestionService = new ServiceTitanLocationIngestionService();
