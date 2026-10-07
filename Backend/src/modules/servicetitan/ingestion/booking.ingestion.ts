import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, ServiceTitanRawIngestionService, SyncInProgressError, type RawExportApi, type RawExportResponse, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const BOOKING_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Booking', rawTable: 'raw_st_bookings', exportEndpoint: `/crm/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/bookings`, lockKey: 'trufinity:servicetitan:booking-ingestion' } as const;
export type BookingExportResponse = RawExportResponse;
export type BookingExportApi = RawExportApi;
export type InvalidBookingRecord = InvalidRawRecord;
export type BookingRawRepository = RawIngestionRepository;
export { SyncInProgressError as BookingSyncInProgressError };
export class PostgresBookingRawRepository extends PostgresServiceTitanRawRepository { public constructor(database = db) { super(BOOKING_CONFIG, database); } }
export class ServiceTitanBookingIngestionService extends ServiceTitanRawIngestionService { public constructor(client: BookingExportApi = apiClient, repository: BookingRawRepository = new PostgresBookingRawRepository()) { super(BOOKING_CONFIG, client, repository); } }
export const serviceTitanBookingIngestionService = new ServiceTitanBookingIngestionService();
