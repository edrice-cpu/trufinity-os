import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, ServiceTitanRawIngestionService, SyncInProgressError, type RawExportApi, type RawExportResponse, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const PAYMENT_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Payment', rawTable: 'raw_st_payments', exportEndpoint: `/accounting/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/payments`, lockKey: 'trufinity:servicetitan:payment-ingestion' } as const;
export type PaymentExportResponse = RawExportResponse;
export type PaymentExportApi = RawExportApi;
export type InvalidPaymentRecord = InvalidRawRecord;
export type PaymentRawRepository = RawIngestionRepository;
export { SyncInProgressError as PaymentSyncInProgressError };
export class PostgresPaymentRawRepository extends PostgresServiceTitanRawRepository { public constructor(database = db) { super(PAYMENT_CONFIG, database); } }
export class ServiceTitanPaymentIngestionService extends ServiceTitanRawIngestionService { public constructor(client: PaymentExportApi = apiClient, repository: PaymentRawRepository = new PostgresPaymentRawRepository()) { super(PAYMENT_CONFIG, client, repository); } }
export const serviceTitanPaymentIngestionService = new ServiceTitanPaymentIngestionService();
