/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import { qboCompanyInfoService } from '../services/companyinfo.service';

export interface CompanyInfoApi { getCompanyInfo(): Promise<unknown>; }

export class QboCompanyInfoIngestionService {
  public constructor(private readonly api: CompanyInfoApi = qboCompanyInfoService, private readonly database: Knex = db) {}

  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    const connection = await this.database.client.acquireConnection();
    let locked = false;
    let runId: string | null = null;
    try {
      const result = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['QuickBooks:CompanyInfo']).connection(connection);
      locked = Array.isArray(result.rows) && result.rows[0]?.locked === true;
      if (!locked) throw new Error('QuickBooks CompanyInfo ingestion is already running.');
      const rows = await this.database('sync_runs').insert({ source_system: 'QuickBooks', entity_type: 'CompanyInfo', status: 'RUNNING' }).returning('id');
      runId = rows[0].id as string;
      const payload = await this.api.getCompanyInfo();
      const sourceId = typeof payload === 'object' && payload !== null && 'Id' in payload && typeof (payload as { Id?: unknown }).Id === 'string' && (payload as { Id: string }).Id.trim() ? (payload as { Id: string }).Id : null;
      await this.database.transaction(async (trx) => {
        if (!sourceId) {
          await trx('sync_errors').insert({ sync_run_id: runId, source_id: null, error_message: 'CompanyInfo payload is missing a valid Id.', payload });
          return;
        }
        await trx('raw_qbo_companyinfo').where({ source_id: sourceId, is_latest: true }).update({ is_latest: false });
        await trx('raw_qbo_companyinfo').insert({ source_id: sourceId, payload: payload as Record<string, unknown>, is_latest: true, sync_run_id: runId });
      });
      await this.database('raw_sync_metadata').insert({ source_system: 'QuickBooks', entity_type: 'CompanyInfo', continuation_token: null, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: null, last_synced_at: this.database.fn.now() });
      await this.database('sync_runs').where({ id: runId }).update({ status: 'COMPLETED', records_processed: sourceId ? 1 : 0, completed_at: this.database.fn.now() });
      return { syncRunId: runId, recordsProcessed: sourceId ? 1 : 0 };
    } catch (error) {
      if (runId) await this.database('sync_runs').where({ id: runId }).update({ status: 'FAILED', error_message: 'QuickBooks CompanyInfo ingestion failed.', completed_at: this.database.fn.now() });
      logger.error('[QuickBooks] CompanyInfo ingestion failed', { syncRunId: runId });
      throw error instanceof Error ? new Error('QuickBooks CompanyInfo ingestion failed.') : new Error('QuickBooks CompanyInfo ingestion failed.');
    } finally {
      try { if (locked) await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', ['QuickBooks:CompanyInfo']).connection(connection); }
      catch { logger.error('[QuickBooks] CompanyInfo advisory lock release failed'); }
      finally { await this.database.client.releaseConnection(connection); }
    }
  }
}

export const qboCompanyInfoIngestionService = new QboCompanyInfoIngestionService();
