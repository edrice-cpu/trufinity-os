/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import { qboCustomerService } from '../services/customer.service';
import type { QboCustomer, QboQueryResponse } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 3;
interface CustomerApi { getCustomersPage(position: number, maxResults: number): Promise<QboQueryResponse<QboCustomer>>; }

interface SafeErrorDetails {
  message: string;
  postgresCode?: string;
  constraint?: string;
}

const safeErrorDetails = (error: unknown): SafeErrorDetails => {
  if (typeof error !== 'object' || error === null) return { message: 'Unknown error.' };

  const candidate = error as { message?: unknown; code?: unknown; constraint?: unknown; originalError?: unknown; cause?: unknown };
  const nested = typeof candidate.originalError === 'object' && candidate.originalError !== null
    ? candidate.originalError as { message?: unknown; code?: unknown; constraint?: unknown }
    : typeof candidate.cause === 'object' && candidate.cause !== null
      ? candidate.cause as { message?: unknown; code?: unknown; constraint?: unknown }
      : undefined;
  const rawMessage = typeof candidate.message === 'string'
    ? candidate.message
    : typeof nested?.message === 'string' ? nested.message : 'Unknown error.';
  const driverMessage = candidate.code || nested?.code
    ? rawMessage.slice(rawMessage.lastIndexOf(' - ') + 3)
    : rawMessage;

  // Keep diagnostics useful without including SQL bindings, payload values, or likely credentials/PII.
  const message = driverMessage
    .replace(/\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|authorization code|api[_ -]?key)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\+?\d[\d ().-]{7,}\d/g, '[PHONE]')
    .slice(0, 500);

  const postgresCode = typeof candidate.code === 'string' ? candidate.code : typeof nested?.code === 'string' ? nested.code : undefined;
  const constraint = typeof candidate.constraint === 'string' ? candidate.constraint : typeof nested?.constraint === 'string' ? nested.constraint : undefined;
  return {
    message,
    ...(postgresCode ? { postgresCode } : {}),
    ...(constraint ? { constraint } : {}),
  };
};

export class QboCustomerIngestionService {
  public constructor(private readonly api: CustomerApi = qboCustomerService, private readonly database: Knex = db) {}
  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    let connection: object | undefined;
    let locked = false; let runId: string | null = null; let processed = 0;
    let position: number | null = null;
    let stage = 'acquire_connection';
    try {
      connection = await this.database.client.acquireConnection();
      stage = 'acquire_advisory_lock';
      const lockResult = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['QuickBooks:Customers']).connection(connection);
      locked = Array.isArray(lockResult.rows) && lockResult.rows[0]?.locked === true;
      if (!locked) throw new Error('QuickBooks Customers ingestion is already running.');
      stage = 'recover_interrupted_runs';
      await this.database('sync_runs').where({ source_system: 'QuickBooks', entity_type: 'Customers', status: 'RUNNING' }).update({ status: 'FAILED', error_message: 'Recovered interrupted QuickBooks Customers sync run.', completed_at: this.database.fn.now() });
      stage = 'create_sync_run';
      const inserted = await this.database('sync_runs').insert({ source_system: 'QuickBooks', entity_type: 'Customers', status: 'RUNNING' }).returning('id'); runId = inserted[0].id as string;
      stage = 'load_pagination_metadata';
      const metadata = await this.database('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Customers' }).first('continuation_token');
      const storedPosition = metadata?.continuation_token ? Number(metadata.continuation_token) : 1;
      position = Number.isInteger(storedPosition) && storedPosition > 0 ? storedPosition : 1;
      let hasMore = true;
      while (hasMore) {
        stage = 'fetch_page';
        const response = await this.fetchPage(position);
        stage = 'validate_page';
        const page = response.QueryResponse;
        if (!isRecord(page)) throw new Error('Malformed QuickBooks Customer response.');
        const customerValue = page.Customer;
        if (customerValue === undefined) {
          const allowedEmptyPageKeys = new Set(['startPosition', 'maxResults', 'totalCount']);
          if (Object.keys(page).some((key) => !allowedEmptyPageKeys.has(key))) throw new Error('Malformed QuickBooks Customer response.');
          hasMore = false;
          stage = 'advance_pagination_metadata';
          await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Customers', continuation_token: null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: null, last_synced_at: this.database.fn.now() });
          continue;
        }
        if (!Array.isArray(customerValue)) throw new Error('Malformed QuickBooks Customer response.');
        const customers = customerValue as QboCustomer[];
        const valid: { id: string; payload: QboCustomer }[] = []; const invalid: unknown[] = [];
        for (const payload of customers) { const id = payload && typeof payload.Id === 'string' && payload.Id.trim() ? payload.Id : null; if (id) valid.push({ id, payload }); else invalid.push(payload); }
        stage = 'persist_page_transaction';
        await this.database.transaction(async (trx) => {
          for (const record of valid) { await trx('raw_qbo_customers').where({ source_id: record.id, is_latest: true }).update({ is_latest: false }); await trx('raw_qbo_customers').insert({ source_id: record.id, payload: record.payload, is_latest: true, sync_run_id: runId }); }
          if (invalid.length) await trx('sync_errors').insert(invalid.map((payload) => ({ sync_run_id: runId, source_id: null, error_message: 'Customer payload is missing a valid Id.', payload })));
        });
        processed += valid.length; const max = page.maxResults ?? PAGE_SIZE; const pageWasFull = customers.length === max; hasMore = pageWasFull && max === PAGE_SIZE ? true : page.totalCount !== undefined ? position + customers.length <= page.totalCount : pageWasFull;
        position += customers.length;
        stage = 'advance_pagination_metadata';
        await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Customers', continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() });
      }
      stage = 'complete_sync_run';
      await this.database('sync_runs').where({ id: runId }).update({ status: 'COMPLETED', records_processed: processed, completed_at: this.database.fn.now() }); return { syncRunId: runId, recordsProcessed: processed };
    } catch (error) {
      const details = safeErrorDetails(error);
      const diagnostic = {
        stage,
        paginationPosition: position,
        syncRunId: runId,
        errorMessage: details.message,
        ...(details.postgresCode ? { postgresCode: details.postgresCode } : {}),
        ...(details.constraint ? { constraint: details.constraint } : {}),
      };
      const safeErrorMessage = `QuickBooks Customers ingestion failed at ${stage}: ${details.message}${details.postgresCode ? ` (PostgreSQL ${details.postgresCode})` : ''}${details.constraint ? ` [constraint ${details.constraint}]` : ''}`;
      if (runId) {
        try {
          await this.database('sync_runs').where({ id: runId }).update({ status: 'FAILED', records_processed: processed, error_message: safeErrorMessage, completed_at: this.database.fn.now() });
        } catch (statusError) {
          const statusDetails = safeErrorDetails(statusError);
          logger.error(`[QuickBooks] Customers failed-run status update also failed: ${JSON.stringify({ syncRunId: runId, postgresCode: statusDetails.postgresCode, constraint: statusDetails.constraint, errorMessage: statusDetails.message })}`);
        }
      }
      logger.error(`[QuickBooks] Customers ingestion failed: ${JSON.stringify(diagnostic)}`);
      throw new Error('QuickBooks Customers ingestion failed.', { cause: error });
    }
    finally {
      try { if (locked && connection) await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', ['QuickBooks:Customers']).connection(connection); }
      catch (unlockError) { const details = safeErrorDetails(unlockError); logger.error(`[QuickBooks] Customers advisory lock release failed: ${JSON.stringify({ postgresCode: details.postgresCode, constraint: details.constraint, errorMessage: details.message })}`); }
      finally { if (connection) await this.database.client.releaseConnection(connection); }
    }
  }
  private async fetchPage(position: number): Promise<QboQueryResponse<QboCustomer>> { let last: unknown; for (let i = 1; i <= MAX_ATTEMPTS; i += 1) { try { return await this.api.getCustomersPage(position, PAGE_SIZE); } catch (error) { last = error; if (i < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 50 * i)); } } throw last instanceof Error ? last : new Error('QuickBooks Customer request failed.'); }
}
export const qboCustomerIngestionService = new QboCustomerIngestionService();
