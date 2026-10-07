import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, ServiceTitanRawIngestionService, SyncInProgressError, type RawExportApi, type RawExportResponse, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const JOB_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Job', rawTable: 'raw_st_jobs', exportEndpoint: `/jpm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/jobs`, lockKey: 'trufinity:servicetitan:job-ingestion' } as const;
export type JobExportResponse = RawExportResponse;
export type JobExportApi = RawExportApi;
export type InvalidJobRecord = InvalidRawRecord;
export type JobRawRepository = RawIngestionRepository;
export { SyncInProgressError as JobSyncInProgressError };
export class PostgresJobRawRepository extends PostgresServiceTitanRawRepository { public constructor(database = db) { super(JOB_CONFIG, database); } }
export class ServiceTitanJobIngestionService extends ServiceTitanRawIngestionService { public constructor(client: JobExportApi = apiClient, repository: JobRawRepository = new PostgresJobRawRepository()) { super(JOB_CONFIG, client, repository); } }
export const serviceTitanJobIngestionService = new ServiceTitanJobIngestionService();
