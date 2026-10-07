import { db } from '../../../database';
import { env } from '../../../config/env';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, ServiceTitanRawIngestionService, SyncInProgressError, type RawExportApi, type RawExportResponse, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const INVOICE_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Invoice', rawTable: 'raw_st_invoices', exportEndpoint: `/accounting/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/invoices`, lockKey: 'trufinity:servicetitan:invoice-ingestion' } as const;
export type InvoiceExportResponse = RawExportResponse;
export type InvoiceExportApi = RawExportApi;
export type InvalidInvoiceRecord = InvalidRawRecord;
export type InvoiceRawRepository = RawIngestionRepository;
export { SyncInProgressError as InvoiceSyncInProgressError };
export class PostgresInvoiceRawRepository extends PostgresServiceTitanRawRepository { public constructor(database = db) { super(INVOICE_CONFIG, database); } }
export class ServiceTitanInvoiceIngestionService extends ServiceTitanRawIngestionService { public constructor(client: InvoiceExportApi = apiClient, repository: InvoiceRawRepository = new PostgresInvoiceRawRepository()) { super(INVOICE_CONFIG, client, repository); } }
export const serviceTitanInvoiceIngestionService = new ServiceTitanInvoiceIngestionService();
