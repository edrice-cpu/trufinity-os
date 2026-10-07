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

const APPOINTMENT_CONFIG = {
  sourceSystem: 'ServiceTitan',
  entityType: 'Appointment',
  rawTable: 'raw_st_appointments',
  exportEndpoint: `/jpm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/appointments`,
  lockKey: 'trufinity:servicetitan:appointment-ingestion',
} as const;

export type AppointmentExportResponse = RawExportResponse;
export type AppointmentExportApi = RawExportApi;
export type InvalidAppointmentRecord = InvalidRawRecord;
export type AppointmentRawRepository = RawIngestionRepository;
export { SyncInProgressError as AppointmentSyncInProgressError };

export class PostgresAppointmentRawRepository extends PostgresServiceTitanRawRepository {
  public constructor(database = db) { super(APPOINTMENT_CONFIG, database); }
}

export class ServiceTitanAppointmentIngestionService extends ServiceTitanRawIngestionService {
  public constructor(client: AppointmentExportApi = apiClient, repository: AppointmentRawRepository = new PostgresAppointmentRawRepository()) {
    super(APPOINTMENT_CONFIG, client, repository);
  }
}

export const serviceTitanAppointmentIngestionService = new ServiceTitanAppointmentIngestionService();
