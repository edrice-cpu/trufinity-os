/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import type { Knex } from 'knex';
import { db } from '../../../database';
import { logger } from '../../../utils/logger';
import { QboApiError } from '../api.client';
import { qboCdcService } from '../services/cdc.service';
import { QBO_CDC_ENTITIES, type QboCdcEntity } from '../types';

const MAX_CDC_OBJECTS = 1000;
const MAX_ATTEMPTS = 3;
const MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 2 * 60 * 1000;
const RAW_TABLES: Record<QboCdcEntity, string> = {
  Customer: 'raw_qbo_customers', Account: 'raw_qbo_accounts', Invoice: 'raw_qbo_invoices', Payment: 'raw_qbo_payments',
};

export interface QboCdcEvent {
  entity: QboCdcEntity;
  sourceId: string;
  payload: Record<string, unknown>;
  lastUpdatedTime: string;
  isDeleted: boolean;
}

export interface QboCdcCheckpoint { checkpointAt: Date; origin: 'cdc' | 'historical'; }
export interface QboCdcCheckpointWrite {
  entity: QboCdcEntity; checkpointAt: Date; requestSince: Date; providerTime: Date; recordsProcessed: number; syncRunId: string;
}

export type QboCdcValidationReason =
  | 'INVALID_ENVELOPE'
  | 'INVALID_PROVIDER_TIME'
  | 'INVALID_GROUP'
  | 'INVALID_QUERY_RESPONSE'
  | 'INVALID_START_POSITION'
  | 'INVALID_MAX_RESULTS'
  | 'INVALID_TOTAL_COUNT'
  | 'UNEXPECTED_ENTITY'
  | 'INVALID_ENTITY_ARRAY'
  | 'MISSING_ID'
  | 'INVALID_LAST_UPDATED_TIME'
  | 'UNSUPPORTED_QUERY_FIELD'
  | 'OBJECT_LIMIT_REACHED'
  | 'PROVIDER_TIME_BEFORE_CHECKPOINT';

export interface QboCdcValidationDetails {
  groupIndex?: number;
  queryIndex?: number;
  field?: string;
  entity?: QboCdcEntity;
  sourceId?: string;
  objectCount?: number;
}

export interface QboCdcRunRuntime {
  acquireLocks(entities: QboCdcEntity[]): Promise<(() => Promise<void>) | null>;
  recoverStaleRuns(): Promise<void>;
  createRun(scope: string): Promise<string>;
  getCheckpoint(entity: QboCdcEntity): Promise<QboCdcCheckpoint | null>;
  recordValidationError(syncRunId: string, entity: QboCdcEntity, sourceId: string | null, message: string): Promise<void>;
  commitSuccess(syncRunId: string, events: QboCdcEvent[], checkpoints: QboCdcCheckpointWrite[], recordsProcessed: number): Promise<void>;
  failRun(syncRunId: string, message: string, recordsProcessed: number): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class QboCdcResponseError extends Error {
  public readonly entity: QboCdcEntity | undefined;
  public readonly sourceId: string | undefined;

  public constructor(
    message: string,
    public readonly reason: QboCdcValidationReason,
    public readonly details: QboCdcValidationDetails = {},
  ) {
    super(message);
    this.name = 'QboCdcResponseError';
    this.entity = details.entity;
    this.sourceId = details.sourceId;
  }
}

export class QboCdcLimitError extends Error {
  public readonly reason = 'OBJECT_LIMIT_REACHED' as const;
  public constructor(public readonly objectCount: number) {
    super('QuickBooks CDC response reached the 1000-object safety limit; checkpoint was not advanced.');
    this.name = 'QboCdcLimitError';
  }
}

export class QboCdcProviderBoundaryError extends Error {
  public readonly reason = 'PROVIDER_TIME_BEFORE_CHECKPOINT' as const;
  public constructor() {
    super('CDC provider boundary precedes the stored checkpoint.');
    this.name = 'QboCdcProviderBoundaryError';
  }
}

const safeDiagnosticValue = (value: string): string => {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
  return sanitized || 'unknown';
};

export const formatQboCdcValidationDiagnostic = (error: unknown): string | null => {
  if (error instanceof QboCdcLimitError) return `reason=${error.reason}, objectCount=${error.objectCount}`;
  if (error instanceof QboCdcProviderBoundaryError) return `reason=${error.reason}, providerBeforeCheckpoint=true`;
  if (!(error instanceof QboCdcResponseError)) return null;
  const parts = [`reason=${error.reason}`];
  if (error.details.entity) parts.push(`entity=${error.details.entity}`);
  if (error.details.groupIndex !== undefined) parts.push(`groupIndex=${error.details.groupIndex}`);
  if (error.details.queryIndex !== undefined) parts.push(`queryIndex=${error.details.queryIndex}`);
  if (error.details.field) parts.push(`field=${safeDiagnosticValue(error.details.field)}`);
  return parts.join(', ');
};

export const parseQboCdcResponse = (input: unknown, requestedEntities: QboCdcEntity[]): { providerTime: Date; events: QboCdcEvent[] } => {
  if (!isRecord(input) || !Array.isArray(input.CDCResponse) || typeof input.time !== 'string') throw new QboCdcResponseError('Malformed QuickBooks CDC response envelope.', 'INVALID_ENVELOPE');
  const providerTime = new Date(input.time);
  if (!Number.isFinite(providerTime.getTime())) throw new QboCdcResponseError('Malformed QuickBooks CDC provider time.', 'INVALID_PROVIDER_TIME');
  const allowed = new Set<string>(requestedEntities);
  const events: QboCdcEvent[] = [];
  for (const [groupIndex, group] of input.CDCResponse.entries()) {
    if (!isRecord(group) || !Array.isArray(group.QueryResponse)) throw new QboCdcResponseError('Malformed QuickBooks CDC query group.', 'INVALID_GROUP', { groupIndex });
    for (const [queryIndex, query] of group.QueryResponse.entries()) {
      const position = { groupIndex, queryIndex };
      if (!isRecord(query)) throw new QboCdcResponseError('Malformed QuickBooks CDC query response.', 'INVALID_QUERY_RESPONSE', position);
      if (query.startPosition !== undefined && (!Number.isInteger(query.startPosition) || Number(query.startPosition) < 1)) {
        throw new QboCdcResponseError('Malformed CDC startPosition.', 'INVALID_START_POSITION', { ...position, field: 'startPosition' });
      }
      if (query.maxResults !== undefined && (!Number.isInteger(query.maxResults) || Number(query.maxResults) < 0)) {
        throw new QboCdcResponseError('Malformed CDC maxResults.', 'INVALID_MAX_RESULTS', { ...position, field: 'maxResults' });
      }
      if (query.totalCount !== undefined && (typeof query.totalCount !== 'number' || !Number.isInteger(query.totalCount) || query.totalCount < 0)) {
        throw new QboCdcResponseError('Malformed CDC totalCount.', 'INVALID_TOTAL_COUNT', { ...position, field: 'totalCount' });
      }
      for (const entity of QBO_CDC_ENTITIES) {
        if (!(entity in query)) continue;
        if (!allowed.has(entity)) throw new QboCdcResponseError('CDC returned an unrequested entity.', 'UNEXPECTED_ENTITY', { ...position, entity });
        const records = query[entity];
        if (!Array.isArray(records)) throw new QboCdcResponseError('Malformed CDC entity record list.', 'INVALID_ENTITY_ARRAY', { ...position, entity });
        for (const raw of records) {
          if (!isRecord(raw) || typeof raw.Id !== 'string' || raw.Id.trim() === '') {
            throw new QboCdcResponseError('CDC record is missing a valid Id.', 'MISSING_ID', { ...position, entity });
          }
          const metadata = raw.MetaData;
          const lastUpdatedTime = isRecord(metadata) && typeof metadata.LastUpdatedTime === 'string' ? metadata.LastUpdatedTime : null;
          if (!lastUpdatedTime || !Number.isFinite(Date.parse(lastUpdatedTime))) throw new QboCdcResponseError('CDC record is missing a valid MetaData.LastUpdatedTime.', 'INVALID_LAST_UPDATED_TIME', { ...position, entity, sourceId: raw.Id });
          events.push({ entity, sourceId: raw.Id, payload: raw, lastUpdatedTime, isDeleted: raw.status === 'Deleted' });
        }
      }
      for (const key of Object.keys(query)) {
        if (!['Customer', 'Account', 'Invoice', 'Payment', 'startPosition', 'maxResults', 'totalCount'].includes(key)) throw new QboCdcResponseError('CDC query response contains an unsupported field.', 'UNSUPPORTED_QUERY_FIELD', { ...position, field: key });
      }
    }
  }
  return { providerTime, events };
};

const retryable = (error: unknown): boolean => {
  if (error instanceof QboApiError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError;
};
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class KnexQboCdcRuntime implements QboCdcRunRuntime {
  public constructor(private readonly database: Knex = db) {}

  public async acquireLocks(entities: QboCdcEntity[]): Promise<(() => Promise<void>) | null> {
    const connection = await this.database.client.acquireConnection();
    const lockKeys = ['QuickBooks:CDC', ...entities.map((entity) => 'QuickBooks:' + entity)].sort();
    const acquired: string[] = [];
    try {
      for (const lockKey of lockKeys) {
        const result = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [lockKey]).connection(connection);
        if (!Array.isArray(result.rows) || result.rows[0]?.locked !== true) {
          let unlockFailed = false;
          for (const held of acquired.reverse()) {
            try { await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [held]).connection(connection); } catch { unlockFailed = true; }
          }
          if (unlockFailed) await this.database.client.destroyRawConnection(connection); else await this.database.client.releaseConnection(connection);
          return null;
        }
        acquired.push(lockKey);
      }
    } catch (error) {
      let unlockFailed = false;
      for (const held of acquired.reverse()) {
        try { await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [held]).connection(connection); } catch { unlockFailed = true; }
      }
      if (unlockFailed) await this.database.client.destroyRawConnection(connection); else await this.database.client.releaseConnection(connection);
      throw error;
    }
    return async () => {
      let unlockFailed = false;
      try {
        for (const held of acquired.reverse()) {
          try { await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [held]).connection(connection); }
          catch { unlockFailed = true; logger.error('[QuickBooks CDC] Advisory unlock failed.'); }
        }
      } finally {
        if (unlockFailed) await this.database.client.destroyRawConnection(connection); else await this.database.client.releaseConnection(connection);
      }
    };
  }

  public async recoverStaleRuns(): Promise<void> {
    await this.database('sync_runs').where({ source_system: 'QuickBooks', status: 'RUNNING' }).whereLike('entity_type', 'CDC:%')
      .update({ status: 'FAILED', error_message: 'Recovered interrupted QuickBooks CDC run.', completed_at: this.database.fn.now() });
  }

  public async createRun(scope: string): Promise<string> {
    const rows = await this.database('sync_runs').insert({ source_system: 'QuickBooks', entity_type: 'CDC:' + scope, status: 'RUNNING' }).returning('id');
    return rows[0].id as string;
  }

  public async getCheckpoint(entity: QboCdcEntity): Promise<QboCdcCheckpoint | null> {
    const saved = await this.database('qbo_cdc_checkpoints').where({ entity_type: entity }).first('checkpoint_at');
    if (saved) return { checkpointAt: new Date(saved.checkpoint_at), origin: 'cdc' };
    const historical = await this.database('raw_sync_metadata').where({ source_system: 'QuickBooks', entity_type: entity + 's' }).first('last_synced_at');
    return historical?.last_synced_at ? { checkpointAt: new Date(historical.last_synced_at), origin: 'historical' } : null;
  }

  public async recordValidationError(syncRunId: string, entity: QboCdcEntity, sourceId: string | null, message: string): Promise<void> {
    await this.database('sync_errors').insert({ sync_run_id: syncRunId, source_id: sourceId, error_message: 'CDC ' + entity + ': ' + message, payload: null });
  }

  public async commitSuccess(syncRunId: string, events: QboCdcEvent[], checkpoints: QboCdcCheckpointWrite[], recordsProcessed: number): Promise<void> {
    await this.database.transaction(async (trx) => {
      for (const event of events) {
        const tableName = RAW_TABLES[event.entity];
        const versions = await trx(tableName).where({ source_id: event.sourceId, is_deleted: event.isDeleted }).select('payload');
        const replay = versions.some((row: { payload: Record<string, unknown> }) => {
          const metadata = row.payload.MetaData;
          return isRecord(metadata) && metadata.LastUpdatedTime === event.lastUpdatedTime;
        });
        if (replay) continue;
        await trx(tableName).where({ source_id: event.sourceId, is_latest: true }).update({ is_latest: false });
        await trx(tableName).insert({ source_id: event.sourceId, payload: event.payload, is_latest: true, is_deleted: event.isDeleted, sync_run_id: syncRunId });
      }
      for (const checkpoint of checkpoints) {
        const fields = { checkpoint_at: checkpoint.checkpointAt, last_request_since: checkpoint.requestSince, provider_time: checkpoint.providerTime, records_processed: checkpoint.recordsProcessed, last_sync_run_id: syncRunId, updated_at: trx.fn.now() };
        await trx('qbo_cdc_checkpoints').insert({ entity_type: checkpoint.entity, ...fields }).onConflict('entity_type').merge(fields);
        await trx('qbo_cdc_checkpoint_history').insert({
          entity_type: checkpoint.entity,
          checkpoint_at: checkpoint.checkpointAt,
          last_request_since: checkpoint.requestSince,
          provider_time: checkpoint.providerTime,
          records_processed: checkpoint.recordsProcessed,
          sync_run_id: syncRunId,
        });
      }
      await trx('sync_runs').where({ id: syncRunId }).update({ status: 'COMPLETED', records_processed: recordsProcessed, completed_at: trx.fn.now() });
    });
  }

  public async failRun(syncRunId: string, message: string, recordsProcessed: number): Promise<void> {
    await this.database('sync_runs').where({ id: syncRunId }).update({ status: 'FAILED', error_message: message.slice(0, 500), records_processed: recordsProcessed, completed_at: this.database.fn.now() });
  }
}

export class QboCdcIngestionService {
  public constructor(
    private readonly api: { getChanges(entities: QboCdcEntity[], changedSince: string): Promise<unknown> } = qboCdcService,
    private readonly runtime: QboCdcRunRuntime = new KnexQboCdcRuntime(),
    private readonly now: () => number = Date.now,
    private readonly wait: (milliseconds: number) => Promise<void> = sleep,
  ) {}

  public async run(entities: QboCdcEntity[]): Promise<{ syncRunId: string; recordsProcessed: number; providerTime: string }> {
    const requested = [...new Set(entities)];
    if (requested.length === 0 || requested.some((entity) => !(QBO_CDC_ENTITIES as readonly string[]).includes(entity))) throw new Error('QuickBooks CDC requires supported entities.');
    const scope = [...requested].sort().join(',');
    let release: (() => Promise<void>) | null = null;
    let syncRunId: string | null = null;
    let processed = 0;
    let stage = 'acquire_lock';
    try {
      release = await this.runtime.acquireLocks(requested);
      if (!release) throw new Error('QuickBooks CDC synchronization is already running for this scope.');
      await this.runtime.recoverStaleRuns();
      const activeRunId = await this.runtime.createRun(scope);
      syncRunId = activeRunId;
      stage = 'load_checkpoint';
      const checkpointRows = await Promise.all(requested.map(async (entity) => ({ entity, checkpoint: await this.runtime.getCheckpoint(entity) })));
      if (checkpointRows.some(({ checkpoint }) => !checkpoint || !Number.isFinite(checkpoint.checkpointAt.getTime()))) {
        throw new Error('CDC requires a valid historical sync timestamp or prior CDC checkpoint for every entity.');
      }
      const checkpointDates = checkpointRows.map(({ checkpoint }) => checkpoint!.checkpointAt);
      const requestSince = new Date(Math.min(...checkpointDates.map((date) => date.getTime())) - OVERLAP_MS);
      const now = this.now();
      if (requestSince.getTime() > now || now - requestSince.getTime() > MAX_LOOKBACK_MS) throw new Error('CDC checkpoint is outside the supported 30-day look-back window.');

      stage = 'request_cdc';
      const response = await this.fetchChanges(requested, requestSince.toISOString());
      stage = 'validate_response';
      const parsed = parseQboCdcResponse(response, requested);
      processed = parsed.events.length;
      if (processed >= MAX_CDC_OBJECTS) throw new QboCdcLimitError(processed);
      if (checkpointDates.some((date) => parsed.providerTime.getTime() < date.getTime())) throw new QboCdcProviderBoundaryError();
      const ordered = [...parsed.events].sort((a, b) => a.entity.localeCompare(b.entity)
        || Date.parse(a.lastUpdatedTime) - Date.parse(b.lastUpdatedTime)
        || Number(a.isDeleted) - Number(b.isDeleted));
      const writes = requested.map((entity) => ({
        entity, checkpointAt: parsed.providerTime, requestSince, providerTime: parsed.providerTime,
        recordsProcessed: ordered.filter((event) => event.entity === entity).length, syncRunId: activeRunId,
      }));
      stage = 'persist_and_advance_checkpoint';
      await this.runtime.commitSuccess(activeRunId, ordered, writes, processed);
      return { syncRunId: activeRunId, recordsProcessed: processed, providerTime: parsed.providerTime.toISOString() };
    } catch (error) {
      if (syncRunId && error instanceof QboCdcResponseError && error.entity) {
        try { await this.runtime.recordValidationError(syncRunId, error.entity, error.sourceId ?? null, error.message); } catch { /* run failure remains authoritative */ }
      }
      if (syncRunId) {
        const status = error instanceof QboApiError ? error.status : undefined;
        const diagnostic = formatQboCdcValidationDiagnostic(error);
        const message = 'QuickBooks CDC failed during ' + stage + (diagnostic ? ' (' + diagnostic + ').' : status ? ' (HTTP ' + status + ').' : '.');
        try { await this.runtime.failRun(syncRunId, message, processed); }
        catch { logger.error('[QuickBooks CDC] Failed to update sync-run status.', { stage, syncRunId }); }
        const safeLog = [
          '[QuickBooks CDC] Synchronization failed',
          `stage=${stage}`,
          `syncRunId=${syncRunId}`,
          `requested=${requested.join(',')}`,
          `errorClass=${error instanceof Error ? safeDiagnosticValue(error.name) : 'UnknownError'}`,
          diagnostic,
          status ? `httpStatus=${status}` : null,
          `objectLimit=${error instanceof QboCdcLimitError}`,
        ].filter((value): value is string => value !== null).join('; ');
        logger.error(safeLog + '.');
      }
      throw new Error('QuickBooks CDC synchronization failed.', { cause: error });
    } finally {
      if (release) await release();
    }
  }

  private async fetchChanges(entities: QboCdcEntity[], changedSince: string): Promise<unknown> {
    let last: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try { return await this.api.getChanges(entities, changedSince); }
      catch (error) {
        last = error;
        if (attempt >= MAX_ATTEMPTS || !retryable(error)) break;
        await this.wait(100 * (2 ** (attempt - 1)));
      }
    }
    throw last instanceof Error ? last : new Error('QuickBooks CDC request failed.');
  }
}

export const qboCdcIngestionService = new QboCdcIngestionService();
