import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, ServiceTitanRawIngestionService, SyncInProgressError, type RawExportApi, type RawExportResponse, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const LEAD_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Lead', rawTable: 'raw_st_leads', exportEndpoint: `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/leads`, lockKey: 'trufinity:servicetitan:lead-ingestion' } as const;
export type LeadExportResponse = RawExportResponse;
export type LeadExportApi = RawExportApi;
export type InvalidLeadRecord = InvalidRawRecord;
export type LeadRawRepository = RawIngestionRepository;
export { SyncInProgressError as LeadSyncInProgressError };
export class PostgresLeadRawRepository extends PostgresServiceTitanRawRepository { public constructor(database = db) { super(LEAD_CONFIG, database); } }
export class ServiceTitanLeadIngestionService extends ServiceTitanRawIngestionService { public constructor(client: LeadExportApi = apiClient, repository: LeadRawRepository = new PostgresLeadRawRepository()) { super(LEAD_CONFIG, client, repository); } }
export const serviceTitanLeadIngestionService = new ServiceTitanLeadIngestionService();
