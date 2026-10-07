/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import { qboCreditMemoService } from '../services/creditmemo.service';
import type { QboCreditMemo, QboQueryResponse } from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const PAGE_SIZE = 1000; const MAX_ATTEMPTS = 3;
interface CreditMemoApi { getCreditMemosPage(position: number, maxResults: number): Promise<QboQueryResponse<QboCreditMemo>>; }

export class QboCreditMemoIngestionService {
  public constructor(private readonly api: CreditMemoApi = qboCreditMemoService, private readonly database: Knex = db) {}
  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    const connection = await this.database.client.acquireConnection(); let locked = false; let runId: string | null = null; let processed = 0;
    try {
      const lockResult = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['QuickBooks:CreditMemos']).connection(connection); locked = Array.isArray(lockResult.rows) && lockResult.rows[0]?.locked === true; if (!locked) throw new Error('QuickBooks CreditMemos ingestion is already running.');
      await this.database('sync_runs').where({ source_system: 'QuickBooks', entity_type: 'CreditMemos', status: 'RUNNING' }).update({ status: 'FAILED', error_message: 'Recovered interrupted QuickBooks CreditMemos sync run.', completed_at: this.database.fn.now() });
      const inserted = await this.database('sync_runs').insert({ source_system: 'QuickBooks', entity_type: 'CreditMemos', status: 'RUNNING' }).returning('id'); runId = inserted[0].id as string;
      const metadata = await this.database('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: 'CreditMemos' }).first('continuation_token'); const stored = metadata?.continuation_token ? Number(metadata.continuation_token) : 1; let position = Number.isInteger(stored) && stored > 0 ? stored : 1; let hasMore = true;
      while (hasMore) {
        const response = await this.fetchPage(position); const page = response.QueryResponse; if (!isRecord(page)) throw new Error('Malformed QuickBooks CreditMemo response.'); const creditMemoValue = page.CreditMemo; if (creditMemoValue === undefined) { const allowedEmptyPageKeys = new Set(['startPosition', 'maxResults', 'totalCount']); if (Object.keys(page).some((key) => !allowedEmptyPageKeys.has(key))) throw new Error('Malformed QuickBooks CreditMemo response.'); hasMore = false; await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'CreditMemos', continuation_token: null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: null, last_synced_at: this.database.fn.now() }); continue; } if (!Array.isArray(creditMemoValue)) throw new Error('Malformed QuickBooks CreditMemo response.'); const creditMemos = creditMemoValue;
        const valid: { id: string; payload: QboCreditMemo }[] = []; const invalid: unknown[] = []; for (const payload of creditMemos) { const id = payload && typeof payload.Id === 'string' && payload.Id.trim() ? payload.Id : null; if (id) valid.push({ id, payload }); else invalid.push(payload); }
        await this.database.transaction(async (trx) => { for (const record of valid) { await trx('raw_qbo_creditmemos').where({ source_id: record.id, is_latest: true }).update({ is_latest: false }); await trx('raw_qbo_creditmemos').insert({ source_id: record.id, payload: record.payload, is_latest: true, sync_run_id: runId }); } if (invalid.length) await trx('sync_errors').insert(invalid.map((payload) => ({ sync_run_id: runId, source_id: null, error_message: 'CreditMemo payload is missing a valid Id.', payload }))); });
        processed += valid.length; const max = page.maxResults ?? PAGE_SIZE; const pageWasFull = creditMemos.length === max; hasMore = pageWasFull && max === PAGE_SIZE ? true : page.totalCount !== undefined ? position + creditMemos.length <= page.totalCount : pageWasFull; position += creditMemos.length;
        await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'CreditMemos', continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: hasMore ? String(position) : null, last_synced_at: this.database.fn.now() });
      }
      await this.database('sync_runs').where({ id: runId }).update({ status: 'COMPLETED', records_processed: processed, completed_at: this.database.fn.now() }); return { syncRunId: runId, recordsProcessed: processed };
    } catch { if (runId) await this.database('sync_runs').where({ id: runId }).update({ status: 'FAILED', error_message: 'QuickBooks CreditMemos ingestion failed.', completed_at: this.database.fn.now() }); logger.error('[QuickBooks] CreditMemos ingestion failed', { syncRunId: runId }); throw new Error('QuickBooks CreditMemos ingestion failed.'); }
    finally { try { if (locked) await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', ['QuickBooks:CreditMemos']).connection(connection); } catch { logger.error('[QuickBooks] CreditMemos advisory lock release failed'); } finally { await this.database.client.releaseConnection(connection); } }
  }
  private async fetchPage(position: number): Promise<QboQueryResponse<QboCreditMemo>> { let last: unknown; for (let i = 1; i <= MAX_ATTEMPTS; i += 1) { try { return await this.api.getCreditMemosPage(position, PAGE_SIZE); } catch (error) { last = error; if (i < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 50 * i)); } } throw last instanceof Error ? last : new Error('QuickBooks CreditMemo request failed.'); }
}
export const qboCreditMemoIngestionService = new QboCreditMemoIngestionService();
