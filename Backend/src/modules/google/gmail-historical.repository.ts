import type { Knex } from 'knex';
import { db } from '../../database';
import type { GmailMailboxConfig } from './types';
import { KnexEmailClassificationRepository, type ClassificationPersistenceInput } from './classification.repository';

export interface GmailHistoricalMailbox {
  id: string;
  mailboxAddress: string;
  normalizedMailboxAddress: string;
  contentMode: 'METADATA' | 'CONTENT';
}

export interface GmailHistoricalMessageWrite {
  providerMessageId: string;
  threadId: string;
  payload: Record<string, unknown> | null;
  contentMode: 'METADATA' | 'CONTENT';
  internalDate: Date;
  providerHistoryId: string | null;
  isDeleted?: boolean;
}

export interface GmailHistoricalError {
  sourceId: string | null;
  message: string;
}

export interface GmailHistoricalRepository {
  withMailboxLock<T>(mailboxAddress: string, work: () => Promise<T>): Promise<T>;
  recoverInterruptedRun(entityType: string): Promise<void>;
  ensureMailbox(mailbox: GmailMailboxConfig): Promise<GmailHistoricalMailbox>;
  createSyncRun(entityType: string): Promise<string>;
  commitBatch(mailbox: GmailHistoricalMailbox, syncRunId: string, messages: GmailHistoricalMessageWrite[], errors: GmailHistoricalError[], classifications?: ClassificationPersistenceInput[]): Promise<number>;
  completeMailbox(mailbox: GmailHistoricalMailbox, syncRunId: string, recordsProcessed: number, historicalWindowDays: number, historyId: string | null): Promise<void>;
  failSyncRun(syncRunId: string, recordsProcessed: number, safeMessage: string): Promise<void>;
  getSyncMetadata(mailboxId: string): Promise<{ historyId: string | null; lastSuccessfulHistoryId: string | null }>;
  updateSyncMetadata(mailboxId: string, historyId: string): Promise<void>;
  completeIncrementalRun(mailboxId: string, syncRunId: string, newHistoryId: string | null, recordsProcessed: number): Promise<void>;
}

const SOURCE_SYSTEM = 'GoogleWorkspace';
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

// raw_gmail_messages.payload is NOT NULL. Deletion/out-of-scope tombstones carry
// no Gmail content, so they persist an empty JSON object; is_deleted = true is
// what distinguishes them from live rows.
export const TOMBSTONE_PAYLOAD: Record<string, unknown> = Object.freeze({});

export class KnexGmailHistoricalRepository implements GmailHistoricalRepository {
  public constructor(private readonly database: Knex = db) {}

  public async withMailboxLock<T>(mailboxAddress: string, work: () => Promise<T>): Promise<T> {
    const connection = await this.database.client.acquireConnection();
    const lockKey = `GoogleWorkspace:GmailHistorical:${mailboxAddress}`;
    let acquired = false;
    let destroyConnection = false;
    try {
      const result = await this.database.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', [lockKey]).connection(connection);
      acquired = Array.isArray(result.rows) && result.rows[0]?.locked === true;
      if (!acquired) throw new Error('Google Workspace Gmail historical synchronization is already running for this mailbox.');
      return await work();
    } finally {
      try {
        if (acquired) await this.database.raw('SELECT pg_advisory_unlock(hashtext(?))', [lockKey]).connection(connection);
      } catch {
        destroyConnection = true;
      } finally {
        if (destroyConnection) await this.database.client.destroyRawConnection(connection).catch(() => undefined);
        await this.database.client.releaseConnection(connection);
      }
    }
  }

  public async recoverInterruptedRun(entityType: string): Promise<void> {
    await this.database('sync_runs').where({ source_system: SOURCE_SYSTEM, entity_type: entityType, status: 'RUNNING' }).update({
      status: 'FAILED',
      error_message: 'Recovered interrupted Google Workspace Gmail historical sync run.',
      completed_at: this.database.fn.now(),
    });
  }

  public async ensureMailbox(mailbox: GmailMailboxConfig): Promise<GmailHistoricalMailbox> {
    const fields = {
      mailbox_address: mailbox.normalizedAddress,
      normalized_mailbox_address: mailbox.normalizedAddress,
      enabled: true,
      content_mode: mailbox.contentMode,
      updated_at: this.database.fn.now(),
    };
    const rows = await this.database('google_gmail_mailboxes').insert(fields)
      .onConflict('normalized_mailbox_address')
      .merge(fields)
      .returning(['id', 'mailbox_address', 'normalized_mailbox_address', 'content_mode']);
    const row = rows[0] as { id?: unknown; mailbox_address?: unknown; normalized_mailbox_address?: unknown; content_mode?: unknown } | undefined;
    if (!row || typeof row.id !== 'string' || typeof row.mailbox_address !== 'string' || typeof row.normalized_mailbox_address !== 'string'
      || (row.content_mode !== 'METADATA' && row.content_mode !== 'CONTENT')) throw new Error('Unable to register Google Workspace mailbox.');
    return { id: row.id, mailboxAddress: row.mailbox_address, normalizedMailboxAddress: row.normalized_mailbox_address, contentMode: row.content_mode };
  }

  public async createSyncRun(entityType: string): Promise<string> {
    const rows = await this.database('sync_runs').insert({ source_system: SOURCE_SYSTEM, entity_type: entityType, status: 'RUNNING' }).returning('id');
    const id = (rows[0] as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string') throw new Error('Unable to create Google Workspace Gmail sync run.');
    return id;
  }

  public async commitBatch(mailbox: GmailHistoricalMailbox, syncRunId: string, messages: GmailHistoricalMessageWrite[], errors: GmailHistoricalError[], classifications: ClassificationPersistenceInput[] = []): Promise<number> {
    let persisted = 0;
    await this.database.transaction(async (trx) => {
      for (const message of messages) {
        const isDeleted = message.isDeleted ?? false;
        const payload = message.payload ?? (isDeleted ? TOMBSTONE_PAYLOAD : null);
        const current = await trx('raw_gmail_messages').where({ mailbox_id: mailbox.id, provider_message_id: message.providerMessageId, is_latest: true }).first('payload', 'is_deleted');
        if (current && current.is_deleted === isDeleted && stableJson(current.payload) === stableJson(payload)) continue;
        await trx('raw_gmail_messages').where({ mailbox_id: mailbox.id, provider_message_id: message.providerMessageId, is_latest: true }).update({ is_latest: false });
        await trx('raw_gmail_messages').insert({
          mailbox_id: mailbox.id,
          mailbox_address: mailbox.normalizedMailboxAddress,
          provider_message_id: message.providerMessageId,
          thread_id: message.threadId,
          payload,
          content_mode: message.contentMode,
          internal_date: message.internalDate,
          provider_history_id: message.providerHistoryId,
          is_deleted: isDeleted,
          is_latest: true,
          sync_run_id: syncRunId,
        });
        persisted += 1;
      }
      if (errors.length > 0) {
        await trx('sync_errors').insert(errors.map((error) => ({
          sync_run_id: syncRunId,
          source_id: error.sourceId,
          error_message: error.message,
          payload: null,
        })));
      }
      const classificationRepository = new KnexEmailClassificationRepository(this.database);
      for (const classification of classifications) await classificationRepository.persistInTransaction(trx, classification);
    });
    return persisted;
  }

  public async completeMailbox(mailbox: GmailHistoricalMailbox, syncRunId: string, recordsProcessed: number, historicalWindowDays: number, historyId: string | null): Promise<void> {
    await this.database.transaction(async (trx) => {
      const state = {
        sync_type: 'HISTORICAL',
        historical_window_days: historicalWindowDays,
        included_labels: ['INBOX', 'SENT'],
      };
      await trx('raw_gmail_sync_metadata').insert({
        mailbox_id: mailbox.id,
        historical_page_token: null,
        history_id: historyId,
        last_successful_history_id: historyId,
        state,
        last_successful_sync_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      }).onConflict('mailbox_id').merge({
        historical_page_token: null,
        history_id: historyId,
        last_successful_history_id: historyId,
        state,
        last_successful_sync_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      await trx('sync_runs').where({ id: syncRunId }).update({
        status: 'COMPLETED', records_processed: recordsProcessed, completed_at: trx.fn.now(),
      });
    });
  }

  public async failSyncRun(syncRunId: string, recordsProcessed: number, safeMessage: string): Promise<void> {
    await this.database('sync_runs').where({ id: syncRunId }).update({
      status: 'FAILED', records_processed: recordsProcessed, error_message: safeMessage, completed_at: this.database.fn.now(),
    });
  }

  public async getSyncMetadata(mailboxId: string): Promise<{ historyId: string | null; lastSuccessfulHistoryId: string | null; lastSuccessfulSyncAt: Date | null }> {
    const row = await this.database('raw_gmail_sync_metadata').where({ mailbox_id: mailboxId }).first('history_id', 'last_successful_history_id', 'last_successful_sync_at');
    if (!row) return { historyId: null, lastSuccessfulHistoryId: null, lastSuccessfulSyncAt: null };
    return {
      historyId: typeof row.history_id === 'string' ? row.history_id : null,
      lastSuccessfulHistoryId: typeof row.last_successful_history_id === 'string' ? row.last_successful_history_id : null,
      lastSuccessfulSyncAt: row.last_successful_sync_at instanceof Date ? row.last_successful_sync_at : null,
    };
  }

  public async updateSyncMetadata(mailboxId: string, historyId: string): Promise<void> {
    await this.database('raw_gmail_sync_metadata').where({ mailbox_id: mailboxId }).update({
      history_id: historyId,
      last_successful_history_id: historyId,
      last_successful_sync_at: this.database.fn.now(),
      updated_at: this.database.fn.now(),
    });
  }

  // Incremental-sync-specific completion. Unlike completeMailbox() (used by the
  // historical sync), this must NOT touch historical_page_token or state: those
  // belong exclusively to the historical pagination lifecycle. Checkpoint
  // advancement and marking the sync_runs row COMPLETED are done in one
  // transaction so a crash can never leave the checkpoint advanced with the
  // run still RUNNING, or vice versa. The status='RUNNING' guard scopes the
  // update to exactly the run this execution created and makes the call
  // idempotent if it were ever invoked twice for the same run.
  public async completeIncrementalRun(mailboxId: string, syncRunId: string, newHistoryId: string | null, recordsProcessed: number): Promise<void> {
    await this.database.transaction(async (trx) => {
      if (newHistoryId) {
        await trx('raw_gmail_sync_metadata').where({ mailbox_id: mailboxId }).update({
          history_id: newHistoryId,
          last_successful_history_id: newHistoryId,
          last_successful_sync_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      }
      const updatedRunCount = await trx('sync_runs').where({ id: syncRunId, status: 'RUNNING' }).update({
        status: 'COMPLETED',
        records_processed: recordsProcessed,
        completed_at: trx.fn.now(),
      });
      // Production tracking integrity: a successful completion must correspond to
      // exactly one RUNNING sync_runs row. If zero rows matched (the row was
      // already recovered/failed/completed elsewhere, or the id is stale), throwing
      // here rolls back this entire transaction, including the checkpoint update
      // above, rather than silently advancing the checkpoint with no completed run.
      if (updatedRunCount !== 1) {
        throw new Error(`Google Workspace Gmail incremental sync completion did not match exactly one RUNNING sync_runs row (matched ${updatedRunCount}) for id ${syncRunId}.`);
      }
    });
  }
}

export const gmailHistoricalRepository = new KnexGmailHistoricalRepository();