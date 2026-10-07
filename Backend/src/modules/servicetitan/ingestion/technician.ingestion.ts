import { db } from '../../../database';
import { env } from '../../../config/env';
import { logger } from '../../../utils/logger';
import { apiClient } from '../api.client';
import { PostgresServiceTitanRawRepository, SyncInProgressError, type RawExportApi, type RawIngestionRepository, type InvalidRawRecord } from './raw-export.ingestion';

const TECHNICIAN_CONFIG = { sourceSystem: 'ServiceTitan', entityType: 'Technician', rawTable: 'raw_st_technicians', exportEndpoint: `/settings/v2/tenant/${env.SERVICETITAN_TENANT_ID}/technicians`, lockKey: 'trufinity:servicetitan:technician-ingestion' } as const;
const PAGE_SIZE = 50;

export interface TechnicianStandardResponse { page: number; pageSize: number; hasMore: boolean; data: unknown[] }
export type TechnicianApi = RawExportApi;
export type InvalidTechnicianRecord = InvalidRawRecord;
export type TechnicianRawRepository = RawIngestionRepository & { getLastSyncedAt(): Promise<Date | null> };
export { SyncInProgressError as TechnicianSyncInProgressError };

export class PostgresTechnicianRawRepository extends PostgresServiceTitanRawRepository implements TechnicianRawRepository {
  public constructor(database = db) { super(TECHNICIAN_CONFIG, database); }
  public async getLastSyncedAt(): Promise<Date | null> {
    const row: unknown = await this.database('raw_sync_metadata').where({ source_system: TECHNICIAN_CONFIG.sourceSystem, entity_type: TECHNICIAN_CONFIG.entityType }).first('last_synced_at');
    if (typeof row !== 'object' || row === null || !('last_synced_at' in row)) return null;
    const value = (row as { last_synced_at?: unknown }).last_synced_at;
    return value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  }
}

function sourceId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === 'number' && Number.isFinite(id) ? String(id) : typeof id === 'string' && id.trim() ? id : null;
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) { const match = /\[(\d{3})\]/.exec(error.message); if (match) return `ServiceTitan technician sync failed (HTTP ${match[1]}).`; }
  return 'ServiceTitan technician sync failed.';
}

function transient(error: unknown): boolean { return error instanceof Error && /\[(429|500|502|503|504)\]/.test(error.message); }

export class ServiceTitanTechnicianIngestionService {
  public constructor(private readonly client: TechnicianApi = apiClient, private readonly repository: TechnicianRawRepository = new PostgresTechnicianRawRepository()) {}

  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> { return this.repository.withExclusiveLock((locked) => this.runLocked(locked as TechnicianRawRepository)); }

  private async runLocked(repository: TechnicianRawRepository): Promise<{ syncRunId: string; recordsProcessed: number }> {
    await repository.recoverInterruptedRuns();
    let syncRunId: string | null = null;
    let processed = 0;
    try {
      syncRunId = await repository.createSyncRun();
      const previous = await repository.getLastSyncedAt();
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const response = await this.fetchPage(page, previous);
        if (!response || !Array.isArray(response.data) || typeof response.hasMore !== 'boolean') throw new Error('Malformed ServiceTitan technician response.');
        const records: { sourceId: string; payload: Record<string, unknown> }[] = [];
        const errors: InvalidTechnicianRecord[] = [];
        for (const payload of response.data) {
          const id = sourceId(payload);
          if (id === null || typeof payload !== 'object' || payload === null) errors.push({ sourceId: id, message: 'Technician payload is missing a valid id.', payload });
          else records.push({ sourceId: id, payload: payload as Record<string, unknown> });
        }
        await repository.commitBatch(syncRunId, records, errors);
        processed += records.length;
        hasMore = response.hasMore;
        page += 1;
      }
      await repository.updateContinuation(null);
      await repository.completeSyncRun(syncRunId, processed);
      return { syncRunId, recordsProcessed: processed };
    } catch (error) {
      const message = safeMessage(error);
      if (syncRunId !== null) await repository.failSyncRun(syncRunId, message);
      logger.error('[ServiceTitan] Technician ingestion failed', { syncRunId, message });
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    }
  }

  private async fetchPage(page: number, modifiedOnOrAfter: Date | null): Promise<TechnicianStandardResponse> {
    const params: Record<string, unknown> = { page, pageSize: PAGE_SIZE };
    if (modifiedOnOrAfter !== null) params.modifiedOnOrAfter = modifiedOnOrAfter.toISOString();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await this.client.get<TechnicianStandardResponse>(TECHNICIAN_CONFIG.exportEndpoint, params); }
      catch (error) { if (!transient(error) || attempt === 3) throw error; await new Promise((resolve) => setTimeout(resolve, 50 * attempt)); }
    }
    throw new Error('ServiceTitan technician sync failed.');
  }
}

export const serviceTitanTechnicianIngestionService = new ServiceTitanTechnicianIngestionService();
