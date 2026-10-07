/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import { qboPaymentService } from '../services/payment.service';
import type { QboPayment, QboQueryResponse } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const PAGE_SIZE = 1000; const MAX_ATTEMPTS = 3;
interface PaymentApi { getPaymentsPage(position: number, maxResults: number): Promise<QboQueryResponse<QboPayment>>; }

export class QboPaymentIngestionService {
  public constructor(private readonly api: PaymentApi = qboPaymentService, private readonly database: Knex = db) {}
  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    const connection = await this.database.client.acquireConnection(); let locked = false; let runId: string | null = null; let processed = 0;
    try {
      const lockResult = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['QuickBooks:Payments']).connection(connection); locked = Array.isArray(lockResult.rows) && lockResult.rows[0]?.locked === true; if (!locked) throw new Error('QuickBooks Payments ingestion is already running.');
      await this.database('sync_runs').where({ source_system: 'QuickBooks', entity_type: 'Payments', status: 'RUNNING' }).update({ status: 'FAILED', error_message: 'Recovered interrupted QuickBooks Payments sync run.', completed_at: this.database.fn.now() });
      const inserted = await this.database('sync_runs').insert({ source_system: 'QuickBooks', entity_type: 'Payments', status: 'RUNNING' }).returning('id'); runId = inserted[0].id as string;
      const metadata = await this.database('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'Payments' }).first('continuation_token'); const stored = metadata?.continuation_token ? Number(metadata.continuation_token) : 1; let position = Number.isInteger(stored) && stored > 0 ? stored : 1; let hasMore = true;
      while (hasMore) {
        const response = await this.fetchPage(position); const page = response.QueryResponse; if (!isRecord(page)) throw new Error('Malformed QuickBooks Payment response.'); const paymentValue = page.Payment; if (paymentValue === undefined) { const allowedEmptyPageKeys = new Set(['startPosition', 'maxResults', 'totalCount']); if (Object.keys(page).some((key) => !allowedEmptyPageKeys.has(key))) throw new Error('Malformed QuickBooks Payment response.'); hasMore = false; await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Payments', continuation_token: null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: null, last_synced_at: this.database.fn.now() }); continue; } if (!Array.isArray(paymentValue)) throw new Error('Malformed QuickBooks Payment response.'); const payments = paymentValue;
        const valid: { id: string; payload: QboPayment }[] = []; const invalid: unknown[] = []; for (const payload of payments) { const id = payload && typeof payload.Id === 'string' && payload.Id.trim() ? payload.Id : null; if (id) valid.push({ id, payload }); else invalid.push(payload); }
        await this.database.transaction(async (trx) => { for (const record of valid) { await trx('raw_qbo_payments').where({ source_id: record.id, is_latest: true }).update({ is_latest: false }); await trx('raw_qbo_payments').insert({ source_id: record.id, payload: record.payload, is_latest: true, sync_run_id: runId }); } if (invalid.length) await trx('sync_errors').insert(invalid.map((payload) => ({ sync_run_id: runId, source_id: null, error_message: 'Payment payload is missing a valid Id.', payload }))); });
        processed += valid.length; const max = page.maxResults ?? PAGE_SIZE; const pageWasFull = payments.length === max; hasMore = pageWasFull && max === PAGE_SIZE ? true : page.totalCount !== undefined ? position + payments.length <= page.totalCount : pageWasFull; position += payments.length;
        await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'Payments', continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() });
      }
      await this.database('sync_runs').where({ id: runId }).update({ status: 'COMPLETED', records_processed: processed, completed_at: this.database.fn.now() }); return { syncRunId: runId, recordsProcessed: processed };
    } catch { if (runId) await this.database('sync_runs').where({ id: runId }).update({ status: 'FAILED', error_message: 'QuickBooks Payments ingestion failed.', completed_at: this.database.fn.now() }); logger.error('[QuickBooks] Payments ingestion failed', { syncRunId: runId }); throw new Error('QuickBooks Payments ingestion failed.'); }
    finally { try { if (locked) await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', ['QuickBooks:Payments']).connection(connection); } catch { logger.error('[QuickBooks] Payments advisory lock release failed'); } finally { await this.database.client.releaseConnection(connection); } }
  }
  private async fetchPage(position: number): Promise<QboQueryResponse<QboPayment>> { let last: unknown; for (let i = 1; i <= MAX_ATTEMPTS; i += 1) { try { return await this.api.getPaymentsPage(position, PAGE_SIZE); } catch (error) { last = error; if (i < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 50 * i)); } } throw last instanceof Error ? last : new Error('QuickBooks Payment request failed.'); }
}
export const qboPaymentIngestionService = new QboPaymentIngestionService();
