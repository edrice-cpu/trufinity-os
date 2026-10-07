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

const CUSTOMER_CONFIG = {
  sourceSystem: 'ServiceTitan',
  entityType: 'Customer',
  rawTable: 'raw_st_customers',
  exportEndpoint: `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/customers`,
  lockKey: 'trufinity:servicetitan:customer-ingestion',
} as const;

export type CustomerExportResponse = RawExportResponse;
export type CustomerExportApi = RawExportApi;
export type InvalidCustomerRecord = InvalidRawRecord;
export type CustomerRawRepository = RawIngestionRepository;
export { SyncInProgressError as CustomerSyncInProgressError };

export class PostgresCustomerRawRepository extends PostgresServiceTitanRawRepository {
  public constructor(database = db) { super(CUSTOMER_CONFIG, database); }
}

export class ServiceTitanCustomerIngestionService extends ServiceTitanRawIngestionService {
  public constructor(client: CustomerExportApi = apiClient, repository: CustomerRawRepository = new PostgresCustomerRawRepository()) {
    super(CUSTOMER_CONFIG, client, repository);
  }
}

export const serviceTitanCustomerIngestionService = new ServiceTitanCustomerIngestionService();
