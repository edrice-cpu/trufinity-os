import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';

const MAX_TRANSIENT_ATTEMPTS = 3;

export interface RawExportResponse {
  hasMore: boolean;
  continueFrom?: string | null;
  data: unknown[];
}

export interface RawExportApi {
  get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T>;
}

export interface InvalidRawRecord {
  sourceId: string | null;
  message: string;
  payload: unknown;
}

export interface RawIngestionConfig {
  sourceSystem: string;
  entityType: string;
  rawTable: string;
  exportEndpoint: string;
  lockKey: string;
}

export interface RawIngestionRepository {
  withExclusiveLock<T>(work: (repository: RawIngestionRepository) => Promise<T>): Promise<T>;
  recoverInterruptedRuns(): Promise<void>;
  createSyncRun(): Promise<string>;
  getContinuation(): Promise<string | null>;
  commitBatch(syncRunId: string, records: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidRawRecord[]): Promise<void>;
  updateContinuation(continuation: string | null): Promise<void>;
  completeSyncRun(syncRunId: string, recordsProcessed: number): Promise<void>;
  failSyncRun(syncRunId: string, safeMessage: string): Promise<void>;
}

export class SyncInProgressError extends Error {
  public constructor(entityType = 'Customer') {
    super(`ServiceTitan ${entityType.toLowerCase()} ingestion is already running.`);
    this.name = 'SyncInProgressError';
  }
}

export class PostgresServiceTitanRawRepository implements RawIngestionRepository {
  public constructor(private readonly config: RawIngestionConfig, protected readonly database: Knex = db) {}

  public async withExclusiveLock<T>(work: (repository: RawIngestionRepository) => Promise<T>): Promise<T> {
    // Knex exposes pool connection acquisition through its client API.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const connection = await this.database.client.acquireConnection();
    let acquired = false;
    let connectionShouldBeDestroyed = false;
    try {
      const result: unknown = await this.database
        .raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [this.config.lockKey])
        .connection(connection);
      const rows = typeof result === 'object' && result !== null && 'rows' in result ? (result as { rows?: unknown }).rows : null;
      acquired = Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null && (rows[0] as { locked?: unknown }).locked === true;
      if (!acquired) throw new SyncInProgressError(this.config.entityType);
      return await work(this);
    } finally {
      try {
        if (acquired) {
          await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [this.config.lockKey]).connection(connection);
        }
      } catch {
        connectionShouldBeDestroyed = true;
        logger.error('[ServiceTitan] Advisory lock release failed; closing lock connection.');
      } finally {
        if (connectionShouldBeDestroyed) {
          // A failed unlock may leave a session-level lock behind. Destroy the
          // physical PostgreSQL connection before returning it to the pool.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          await this.database.client.destroyRawConnection(connection).catch(() => undefined);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await this.database.client.releaseConnection(connection);
      }
    }
  }

  public async recoverInterruptedRuns(): Promise<void> {
    await this.database('sync_runs').where({ source_system: this.config.sourceSystem, entity_type: this.config.entityType, status: 'RUNNING' }).update({
      status: 'FAILED', error_message: `Recovered interrupted ServiceTitan ${this.config.entityType.toLowerCase()} sync run.`, completed_at: this.database.fn.now(),
    });
  }

  public async createSyncRun(): Promise<string> {
    const rows: unknown = await this.database('sync_runs').insert({ source_system: this.config.sourceSystem, entity_type: this.config.entityType, status: 'RUNNING' }).returning('id');
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object' || rows[0] === null || !('id' in rows[0])) throw new Error('Unable to create ServiceTitan sync run.');
    const id = (rows[0] as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error('Unable to create ServiceTitan sync run.');
    return id;
  }

  public async getContinuation(): Promise<string | null> {
    const row: unknown = await this.database('raw_sync_metadata').where({ source_system: this.config.sourceSystem, entity_type: this.config.entityType }).first('continuation_token');
    if (typeof row !== 'object' || row === null || !('continuation_token' in row)) return null;
    const continuation = (row as { continuation_token?: unknown }).continuation_token;
    return typeof continuation === 'string' ? continuation : null;
  }

  public async commitBatch(syncRunId: string, records: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidRawRecord[]): Promise<void> {
    await this.database.transaction(async (trx) => {
      for (const record of records) {
        await trx(this.config.rawTable).where({ source_id: record.sourceId, is_latest: true }).update({ is_latest: false });
        await trx(this.config.rawTable).insert({ source_id: record.sourceId, payload: record.payload, is_latest: true, sync_run_id: syncRunId });
      }
      if (errors.length > 0) await trx('sync_errors').insert(errors.map((error) => ({ sync_run_id: syncRunId, source_id: error.sourceId, error_message: error.message, payload: error.payload })));
    });
  }

  public async updateContinuation(continuation: string | null): Promise<void> {
    await this.database('raw_sync_metadata').insert({ source_system: this.config.sourceSystem, entity_type: this.config.entityType, continuation_token: continuation, last_synced_at: this.database.fn.now() }).onConflict(['source_system', 'entity_type']).merge({ continuation_token: continuation, last_synced_at: this.database.fn.now() });
  }

  public async completeSyncRun(syncRunId: string, recordsProcessed: number): Promise<void> { await this.database('sync_runs').where({ id: syncRunId }).update({ status: 'COMPLETED', records_processed: recordsProcessed, completed_at: this.database.fn.now() }); }
  public async failSyncRun(syncRunId: string, safeMessage: string): Promise<void> { await this.database('sync_runs').where({ id: syncRunId }).update({ status: 'FAILED', error_message: safeMessage, completed_at: this.database.fn.now() }); }
}

function sourceIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return null;
  const id = (payload as { id?: unknown }).id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim().length > 0) return id;
  return null;
}

function safeFailureMessage(error: unknown, entityType: string): string {
  if (error instanceof Error) { const match = /\[(\d{3})\]/.exec(error.message); if (match) return `ServiceTitan ${entityType.toLowerCase()} export failed (HTTP ${match[1]}).`; }
  return `ServiceTitan ${entityType.toLowerCase()} export failed.`;
}

function isTransientError(error: unknown): boolean { return error instanceof Error && /\[(429|500|502|503|504)\]/.test(error.message); }

export class ServiceTitanRawIngestionService {
  public constructor(private readonly config: RawIngestionConfig, private readonly client: RawExportApi, private readonly repository: RawIngestionRepository) {}

  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> { return this.repository.withExclusiveLock((lockedRepository) => this.runLocked(lockedRepository)); }

  private async runLocked(repository: RawIngestionRepository): Promise<{ syncRunId: string; recordsProcessed: number }> {
    await repository.recoverInterruptedRuns();
    let syncRunId: string | null = null;
    let processed = 0;
    try {
      syncRunId = await repository.createSyncRun();
      let continuation = await repository.getContinuation();
      let hasMore = true;
      while (hasMore) {
        const response = await this.fetchBatch(continuation);
        if (!response || !Array.isArray(response.data) || typeof response.hasMore !== 'boolean') throw new Error('Malformed ServiceTitan export response.');
        if (response.hasMore && (!response.continueFrom || response.continueFrom.trim().length === 0)) throw new Error('Malformed ServiceTitan export continuation response.');
        const records: { sourceId: string; payload: Record<string, unknown> }[] = [];
        const errors: InvalidRawRecord[] = [];
        for (const payload of response.data) {
          const sourceId = sourceIdFromPayload(payload);
          if (sourceId === null || typeof payload !== 'object' || payload === null) errors.push({ sourceId, message: `${this.config.entityType} payload is missing a valid id.`, payload });
          else records.push({ sourceId, payload: payload as Record<string, unknown> });
        }
        hasMore = response.hasMore;
        continuation = hasMore ? response.continueFrom ?? null : null;
        await repository.commitBatch(syncRunId, records, errors);
        await repository.updateContinuation(continuation);
        processed += records.length;
      }
      await repository.completeSyncRun(syncRunId, processed);
      return { syncRunId, recordsProcessed: processed };
    } catch (error) {
      const message = safeFailureMessage(error, this.config.entityType);
      if (syncRunId !== null) await repository.failSyncRun(syncRunId, message);
      logger.error(`[ServiceTitan] ${this.config.entityType} ingestion failed`, { syncRunId, message });
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    }
  }

  private async fetchBatch(continuation: string | null): Promise<RawExportResponse> {
    const params = continuation === null ? {} : { from: continuation };
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      try { return await this.client.get<RawExportResponse>(this.config.exportEndpoint, params); }
      catch (error) { if (!isTransientError(error) || attempt === MAX_TRANSIENT_ATTEMPTS) throw error; await new Promise((resolve) => setTimeout(resolve, 50 * attempt)); }
    }
    throw new Error('ServiceTitan export failed.');
  }
}
