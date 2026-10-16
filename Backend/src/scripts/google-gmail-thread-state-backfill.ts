import type { Knex } from 'knex';
import { performance } from 'node:perf_hooks';
import { db } from '../database';
import {
  extractGmailMessageFact,
  refreshGmailThreadStates,
  type GmailMessageFactInput,
} from '../modules/google/gmail-thread-state.service';

const JOB_NAME = 'R05_THREAD_STATE_V1';
const MAX_BATCH_LIMIT = 250;
const MAX_BATCHES = 10000;
export const R05_BACKFILL_SOFT_THRESHOLD_MS = 15_000;
export const R05_BACKFILL_HARD_THRESHOLD_MS = 30_000;
export const R05_BACKFILL_LOCK_NAME = 'R05_THREAD_STATE_V1';

export interface ThreadStateBackfillArgs {
  dryRun: boolean;
  batchLimit: number;
  maxBatches: number;
}

export interface ThreadStateBackfillProgress {
  batchesProcessed: number;
  threadsProcessed: number;
  threadsSkippedConcurrent: number;
  rowsObserved: number;
  elapsedMs: number;
  completed: boolean;
}

export interface BackfillRunOptions {
  now?: () => number;
}

interface Cursor {
  mailboxId: string | null;
  threadId: string | null;
}

interface ProgressRow {
  job_name: string;
  cursor_mailbox_id: string | null;
  cursor_thread_id: string | null;
  scan_started_at: Date;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED';
  batches_processed: number | string;
  threads_processed: number | string;
  threads_skipped_concurrent: number | string;
}

interface ThreadKey {
  mailbox_id: string;
  mailbox_address: string;
  thread_id: string;
}

interface RawRow {
  mailbox_id: string;
  mailbox_address: string;
  provider_message_id: string;
  thread_id: string;
  payload: Record<string, unknown> | null;
  internal_date: Date;
  is_deleted: boolean;
  ingested_at: Date;
}

interface DedicatedConnection {
  query: (sql: string, bindings?: readonly unknown[]) => Promise<unknown>;
}

/**
 * Holds a PostgreSQL session advisory lock for the complete bounded run.
 * PostgreSQL releases the lock automatically if the process or connection
 * dies. The no-client fallback exists only for lightweight unit-test doubles;
 * real Knex instances always provide acquireConnection/releaseConnection.
 */
export const withBackfillAdvisoryLock = async <T>(
  database: Knex,
  work: (connection?: DedicatedConnection) => Promise<T>,
): Promise<T> => {
  const client = (database as Knex & { client?: {
    acquireConnection?: () => Promise<unknown>;
    releaseConnection?: (connection: unknown) => Promise<void>;
  } }).client;
  if (!client?.acquireConnection || !client.releaseConnection) return work();

  const connection = await client.acquireConnection() as DedicatedConnection;
  let acquired = false;
  try {
    const result = await connection.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [R05_BACKFILL_LOCK_NAME]) as { rows?: Array<{ locked?: boolean }> };
    if (result.rows?.[0]?.locked === false) throw new Error('R05 backfill advisory lock is already held.');
    acquired = true;
    return await work(connection);
  } finally {
    if (acquired) {
      await connection.query('SELECT pg_advisory_unlock(hashtext($1))', [R05_BACKFILL_LOCK_NAME]).catch(() => undefined);
    }
    await client.releaseConnection(connection);
  }
};

const toCount = (value: number | string): number => typeof value === 'number' ? value : Number(value);

export const parseArgs = (argv: string[]): ThreadStateBackfillArgs => {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const batchLimit = value('--batch-limit') ? Number(value('--batch-limit')) : 100;
  const maxBatches = value('--max-batches') ? Number(value('--max-batches')) : MAX_BATCHES;
  if (!Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_BATCH_LIMIT) {
    throw new Error(`--batch-limit must be 1-${MAX_BATCH_LIMIT}.`);
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > MAX_BATCHES) {
    throw new Error(`--max-batches must be 1-${MAX_BATCHES}.`);
  }
  return { dryRun: argv.includes('--dry-run'), batchLimit, maxBatches };
};

const logProgress = (event: string, fields: Record<string, number | boolean>) => {
  console.info('[GMAIL_THREAD_STATE_BACKFILL]', JSON.stringify({ event, ...fields }));
};

const assertLockConnection = async (connection: DedicatedConnection): Promise<void> => {
  await connection.query('SELECT 1');
};

const loadProgress = async (database: Knex, dryRun: boolean): Promise<ProgressRow> => {
  let row = await database('google_gmail_thread_state_backfill')
    .where({ job_name: JOB_NAME }).first() as ProgressRow | undefined;
  if (!row && !dryRun) {
    await database('google_gmail_thread_state_backfill').insert({
      job_name: JOB_NAME,
      scan_started_at: new Date(),
      status: 'RUNNING',
      updated_at: database.fn.now(),
    }).onConflict('job_name').ignore();
    row = await database('google_gmail_thread_state_backfill')
      .where({ job_name: JOB_NAME }).first() as ProgressRow | undefined;
  }
  if (!row) {
    row = {
      job_name: JOB_NAME,
      cursor_mailbox_id: null,
      cursor_thread_id: null,
      scan_started_at: new Date(),
      status: 'RUNNING',
      batches_processed: 0,
      threads_processed: 0,
      threads_skipped_concurrent: 0,
    };
  }
  if (!row) throw new Error('Unable to load R05 thread-state backfill progress.');
  if (row.status === 'COMPLETED') throw new Error('R05 thread-state backfill is already complete.');
  return row;
};

const loadThreadKeys = async (
  database: Knex,
  cursor: Cursor,
  scanStartedAt: Date,
  limit: number,
): Promise<ThreadKey[]> => {
  let query = database('raw_gmail_messages')
    .select('mailbox_id', 'mailbox_address', 'thread_id')
    .where({ is_latest: true })
    .where('thread_id', '<>', '')
    .where('ingested_at', '<=', scanStartedAt)
    .groupBy('mailbox_id', 'mailbox_address', 'thread_id')
    .orderBy([{ column: 'mailbox_id', order: 'asc' }, { column: 'thread_id', order: 'asc' }])
    .limit(limit);
  if (cursor.mailboxId !== null && cursor.threadId !== null) {
    query = query.where((builder) => builder
      .where('mailbox_id', '>', cursor.mailboxId!)
      .orWhere((nested) => nested
        .where('mailbox_id', cursor.mailboxId!)
        .andWhere('thread_id', '>', cursor.threadId!)));
  }
  return query as unknown as ThreadKey[];
};

const loadCurrentRows = async (
  trx: Knex.Transaction,
  keys: readonly ThreadKey[],
): Promise<RawRow[]> => {
  const query = trx('raw_gmail_messages')
  .select(
    'mailbox_id', 'mailbox_address', 'provider_message_id', 'thread_id',
    // Direction classification only needs labelIds and From headers. Avoid
    // transferring body, snippet, HTML, and attachment JSON over the tunnel.
    trx.raw("jsonb_build_object('labelIds', payload->'labelIds', 'headers', payload->'headers') AS payload"),
    'internal_date', 'is_deleted', 'ingested_at',
  )
  .where({ is_latest: true })
  .forUpdate();
  query.where((builder: any) => keys.forEach((key, index) => {
    const clause = index === 0 ? builder.where : builder.orWhere;
    clause.call(builder, { mailbox_id: key.mailbox_id, thread_id: key.thread_id });
  }));
  return query as unknown as RawRow[];
};

const applyThreadFilter = <T extends { where: (...args: any[]) => T }>(query: T, keys: readonly ThreadKey[]): T => {
  query.where((builder: any) => keys.forEach((key, index) => {
    const clause = index === 0 ? builder.where : builder.orWhere;
    clause.call(builder, { mailbox_id: key.mailbox_id, thread_id: key.thread_id });
  }));
  return query;
};

const insertChunks = async <T>(
  queryFactory: (rows: T[]) => Promise<unknown>,
  rows: T[],
): Promise<void> => {
  for (let index = 0; index < rows.length; index += 500) {
    const chunk = rows.slice(index, index + 500);
    if (chunk.length > 0) await queryFactory(chunk);
  }
};

const persistBatch = async (
  database: Knex,
  keys: ThreadKey[],
  scanStartedAt: Date,
  cursor: Cursor,
  pauseAfterBatch: boolean,
): Promise<{ processed: number; skippedConcurrent: number; rowsObserved: number; factsPersisted: number; threadStatesPersisted: number }> => {
  let processed = 0;
  let skippedConcurrent = 0;
  let rowsObserved = 0;
  let factsPersisted = 0;
  let threadStatesPersisted = 0;
  await database.transaction(async (trx) => {
    const rows = await loadCurrentRows(trx, keys);
    rowsObserved = rows.length;
    const rowsByKey = new Map<string, RawRow[]>();
    for (const row of rows) {
      const group = rowsByKey.get(`${row.mailbox_id}:${row.thread_id}`) ?? [];
      group.push(row);
      rowsByKey.set(`${row.mailbox_id}:${row.thread_id}`, group);
    }
    const safeKeys = keys.filter((key) => {
      const currentRows = rowsByKey.get(`${key.mailbox_id}:${key.thread_id}`) ?? [];
      const changed = currentRows.some((row) => new Date(row.ingested_at).getTime() > scanStartedAt.getTime());
      if (changed) skippedConcurrent += 1;
      return !changed;
    });
    if (safeKeys.length > 0) {
      const keyPairs = safeKeys.map((key) => ({ mailboxId: key.mailbox_id, threadId: key.thread_id }));
      await applyThreadFilter(trx('google_gmail_message_facts'), safeKeys).delete();
      const inputs: GmailMessageFactInput[] = safeKeys.flatMap((key) =>
        (rowsByKey.get(`${key.mailbox_id}:${key.thread_id}`) ?? [])
          .filter((row) => !row.is_deleted && row.internal_date !== null)
          .map((row) => ({
            mailboxId: row.mailbox_id,
            mailboxAddress: row.mailbox_address,
            providerMessageId: row.provider_message_id,
            threadId: row.thread_id,
            internalDate: new Date(row.internal_date),
            payload: row.payload,
            isDeleted: false,
          })));
      const facts = inputs.map((input) => extractGmailMessageFact(input)).filter((fact) => fact !== null);
      factsPersisted = facts.length;
      await insertChunks(
        async (chunk) => { await trx('google_gmail_message_facts').insert(chunk); },
        facts.map((fact) => ({
          mailbox_id: fact!.mailboxId,
          mailbox_address: fact!.mailboxAddress,
          thread_id: fact!.threadId,
          provider_message_id: fact!.providerMessageId,
          internal_date: fact!.internalDate,
          direction: fact!.direction,
          updated_at: trx.fn.now(),
        })),
      );
      threadStatesPersisted = await refreshGmailThreadStates(trx, keyPairs);
      processed = safeKeys.length;
    }
    await trx('google_gmail_thread_state_backfill')
      .where({ job_name: JOB_NAME })
      .update({
        cursor_mailbox_id: cursor.mailboxId,
        cursor_thread_id: cursor.threadId,
        status: pauseAfterBatch ? 'PAUSED' : 'RUNNING',
        batches_processed: trx.raw('batches_processed + 1'),
        threads_processed: trx.raw(`threads_processed + ${processed}`),
        threads_skipped_concurrent: trx.raw(`threads_skipped_concurrent + ${skippedConcurrent}`),
        updated_at: trx.fn.now(),
      });
  });
  return { processed, skippedConcurrent, rowsObserved, factsPersisted, threadStatesPersisted };
};

export const runBackfill = async (
  database: Knex,
  args: ThreadStateBackfillArgs,
  options: BackfillRunOptions = {},
): Promise<ThreadStateBackfillProgress> => withBackfillAdvisoryLock(database, async (lockConnection) => {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const row = await loadProgress(database, args.dryRun);
  let cursor: Cursor = { mailboxId: row.cursor_mailbox_id, threadId: row.cursor_thread_id };
  let batchesProcessed = toCount(row.batches_processed);
  let threadsProcessed = toCount(row.threads_processed);
  let threadsSkippedConcurrent = toCount(row.threads_skipped_concurrent);
  let rowsObserved = 0;
  let completed = false;

  for (let batch = 0; batch < args.maxBatches; batch += 1) {
    if (lockConnection) await assertLockConnection(lockConnection);
    const batchStartedAt = now();
    const keys = await loadThreadKeys(database, cursor, row.scan_started_at, args.batchLimit);
    if (keys.length === 0) {
      completed = true;
      if (!args.dryRun) {
        await database('google_gmail_thread_state_backfill').where({ job_name: JOB_NAME }).update({
          status: 'COMPLETED', completed_at: database.fn.now(), updated_at: database.fn.now(),
        });
      }
      break;
    }
    const last = keys[keys.length - 1]!;
    const nextCursor = { mailboxId: last.mailbox_id, threadId: last.thread_id };
    if (args.dryRun) {
      threadsProcessed += keys.length;
      batchesProcessed += 1;
      rowsObserved = 0;
    } else {
      const result = await persistBatch(database, keys, row.scan_started_at, nextCursor, batch + 1 >= args.maxBatches);
      threadsProcessed += result.processed;
      threadsSkippedConcurrent += result.skippedConcurrent;
      rowsObserved += result.rowsObserved;
      batchesProcessed += 1;
      const batchElapsedMs = Math.round(now() - batchStartedAt);
      const slow = batchElapsedMs > R05_BACKFILL_SOFT_THRESHOLD_MS;
      logProgress('batch', {
        batchNumber: batchesProcessed,
        processedThreads: result.processed,
        factsPersisted: result.factsPersisted,
        threadStatesPersisted: result.threadStatesPersisted,
        rowsObserved: result.rowsObserved,
        cursorAdvanced: true,
        durationMs: batchElapsedMs,
        softThresholdExceeded: slow,
        hardThresholdExceeded: batchElapsedMs > R05_BACKFILL_HARD_THRESHOLD_MS,
      });
      if (slow) {
        // The batch transaction has committed its cursor atomically. Persist a
        // paused status separately so a slow batch cannot schedule another one.
        await database('google_gmail_thread_state_backfill')
          .where({ job_name: JOB_NAME })
          .update({ status: 'PAUSED', updated_at: database.fn.now() });
        logProgress('threshold', {
          batchNumber: batchesProcessed,
          durationMs: batchElapsedMs,
          softThresholdExceeded: true,
          hardThresholdExceeded: batchElapsedMs > R05_BACKFILL_HARD_THRESHOLD_MS,
        });
        if (batchElapsedMs > R05_BACKFILL_HARD_THRESHOLD_MS) {
          console.warn('[GMAIL_THREAD_STATE_BACKFILL] Batch exceeded the hard threshold; investigate commit state before resuming.');
        }
        cursor = nextCursor;
        break;
      }
    }
    cursor = nextCursor;
    if (args.dryRun) logProgress('batch', {
      batchNumber: batchesProcessed,
      processedThreads: keys.length,
      factsPersisted: 0,
      threadStatesPersisted: 0,
      rowsObserved: 0,
      cursorAdvanced: true,
      durationMs: Math.round(now() - batchStartedAt),
      softThresholdExceeded: false,
      hardThresholdExceeded: false,
    });
  }

  return {
    batchesProcessed,
    threadsProcessed,
    threadsSkippedConcurrent,
    rowsObserved,
    elapsedMs: Math.round(now() - startedAt),
    completed,
  };
});

const main = async (): Promise<void> => {
  const result = await runBackfill(db, parseArgs(process.argv.slice(2)));
  logProgress('complete', {
    batchesProcessed: result.batchesProcessed,
    threadsProcessed: result.threadsProcessed,
    threadsSkippedConcurrent: result.threadsSkippedConcurrent,
    rowsObserved: result.rowsObserved,
    elapsedMs: result.elapsedMs,
    completed: result.completed,
  });
  await db.destroy();
};

if (require.main === module) {
  main().catch(async () => {
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  });
}
