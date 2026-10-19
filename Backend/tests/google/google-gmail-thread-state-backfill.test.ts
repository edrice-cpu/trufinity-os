import { describe, expect, it } from '@jest/globals';
import {
  parseArgs,
  runBackfill,
  withBackfillAdvisoryLock,
  R05_BACKFILL_LOCK_NAME,
  type ThreadStateBackfillArgs,
} from '../../src/scripts/google-gmail-thread-state-backfill';

const scanStartedAt = new Date('2026-01-01T00:00:00.000Z');
const key = { mailbox_id: 'mb-1', mailbox_address: 'service@trufinity.ca', thread_id: 'thread-1' };

const query = (value: unknown, hooks: Record<string, () => unknown> = {}) => {
  const q: Record<string, any> = {
    select: () => q, where: () => q, andWhere: () => q, orWhere: () => q,
    whereIn: () => q, groupBy: () => q, orderBy: () => q, limit: () => q,
    forUpdate: () => q,
    first: async () => value,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(value)),
    update: async () => { hooks.update?.(); return 1; },
    delete: async () => 1,
    insert: () => ({ onConflict: () => ({ ignore: async () => 1, merge: async () => 1 }) }),
  };
  return q;
};

const makeDatabase = (options: { progress: any; keys: any[]; rawRows?: any[]; factRows?: any[]; failFacts?: boolean }) => {
  let keyRead = 0;
  let progressUpdates = 0;
  const database = ((table: string) => {
    if (table === 'google_gmail_thread_state_backfill') {
      return query(options.progress, { update: () => { progressUpdates += 1; } });
    }
    if (table === 'raw_gmail_messages') return query(keyRead++ === 0 ? options.keys : []);
    throw new Error(`Unexpected database table ${table}`);
  }) as any;
  database.fn = { now: () => 'NOW()' };
  database.transaction = async (work: (trx: any) => Promise<void>) => {
    const trx = ((table: string) => {
      if (table === 'raw_gmail_messages') return query(options.rawRows ?? []);
      if (table === 'google_gmail_message_facts') {
        const q = query(options.factRows ?? []);
        q.insert = async () => {
          if (options.failFacts) throw new Error('fact write failed');
          return 1;
        };
        return q;
      }
      if (table === 'google_gmail_thread_responsiveness') return query([]);
      if (table === 'google_gmail_thread_state_backfill') return query(1, { update: () => { progressUpdates += 1; } });
      throw new Error(`Unexpected transaction table ${table}`);
    }) as any;
    trx.fn = { now: () => 'NOW()' };
    trx.raw = (value: string) => value;
    return work(trx);
  };
  return { database, getProgressUpdates: () => progressUpdates };
};

const args = (overrides: Partial<ThreadStateBackfillArgs> = {}): ThreadStateBackfillArgs => ({
  dryRun: false, batchLimit: 10, maxBatches: 2, ...overrides,
});

describe('Google Gmail thread-state backfill', () => {
  it('parses bounded dry-run options', () => {
    expect(parseArgs(['--dry-run', '--batch-limit', '5', '--max-batches', '2'])).toEqual({
      dryRun: true, batchLimit: 5, maxBatches: 2,
    });
    expect(() => parseArgs(['--batch-limit', '0'])).toThrow();
  });

  it('keeps dry-run read-only and does not create progress', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const { database, getProgressUpdates } = makeDatabase({ progress, keys: [key] });
    const result = await runBackfill(database, args({ dryRun: true, maxBatches: 1 }));
    expect(result.threadsProcessed).toBe(1);
    expect(result.rowsObserved).toBe(0);
    expect(getProgressUpdates()).toBe(0);
  });

  it('resumes from persisted cursor and is idempotent for an empty continuation', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: 'mb-0', cursor_thread_id: 'thread-0',
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 1,
      threads_processed: 2, threads_skipped_concurrent: 0,
    };
    const { database } = makeDatabase({ progress, keys: [] });
    const result = await runBackfill(database, args());
    expect(result.completed).toBe(true);
    expect(result.batchesProcessed).toBe(1);
    expect(result.threadsProcessed).toBe(2);
  });

  it('skips a thread changed after the scan high-water mark', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const { database } = makeDatabase({
      progress, keys: [key], rawRows: [{ ...key, provider_message_id: 'm1', payload: {}, internal_date: scanStartedAt, is_deleted: false, ingested_at: new Date('2026-01-01T00:00:01.000Z') }],
    });
    const result = await runBackfill(database, args({ maxBatches: 1 }));
    expect(result.threadsSkippedConcurrent).toBe(1);
    expect(result.threadsProcessed).toBe(0);
  });

  it('rolls back the batch when derived fact persistence fails', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const { database, getProgressUpdates } = makeDatabase({
      progress, keys: [key], failFacts: true,
      rawRows: [{ ...key, provider_message_id: 'm1', payload: { labelIds: ['INBOX'], headers: [] }, internal_date: scanStartedAt, is_deleted: false, ingested_at: scanStartedAt }],
    });
    await expect(runBackfill(database, args({ maxBatches: 1 }))).rejects.toThrow('fact write failed');
    expect(getProgressUpdates()).toBe(0);
  });

  it('processes multiple mailboxes and deleted rows in one bounded batch', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const secondKey = { mailbox_id: 'mb-2', mailbox_address: 'support@trufinity.ca', thread_id: 'thread-2' };
    const rawRows = [
      { ...key, provider_message_id: 'm1', payload: { headers: [] }, internal_date: scanStartedAt, is_deleted: false, ingested_at: scanStartedAt },
      { ...secondKey, provider_message_id: 'm2', payload: { headers: [] }, internal_date: scanStartedAt, is_deleted: true, ingested_at: scanStartedAt },
    ];
    const { database, getProgressUpdates } = makeDatabase({
      progress, keys: [key, secondKey], rawRows,
      factRows: [{ mailbox_id: key.mailbox_id, mailbox_address: key.mailbox_address, thread_id: key.thread_id, provider_message_id: 'm1', internal_date: scanStartedAt, direction: 'UNKNOWN' }],
    });
    const result = await runBackfill(database, args({ batchLimit: 2, maxBatches: 1 }));
    expect(result.threadsProcessed).toBe(2);
    expect(result.rowsObserved).toBe(2);
    expect(result.threadsSkippedConcurrent).toBe(0);
    expect(getProgressUpdates()).toBe(1);
  });

  it('supports bounded sequential execution in one run', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const { database } = makeDatabase({ progress, keys: [key] });
    const result = await runBackfill(database, args({ maxBatches: 2 }));
    // The bounded loop accepts more than one batch; this fixture has no second
    // key page, so it completes after the first committed batch.
    expect(result.batchesProcessed).toBe(1);
    expect(result.completed).toBe(true);
  });

  it('pauses before scheduling another batch when the soft threshold is exceeded', async () => {
    const progress = {
      job_name: 'R05_THREAD_STATE_V1', cursor_mailbox_id: null, cursor_thread_id: null,
      scan_started_at: scanStartedAt, status: 'RUNNING', batches_processed: 0,
      threads_processed: 0, threads_skipped_concurrent: 0,
    };
    const { database } = makeDatabase({
      progress, keys: [key],
      rawRows: [{ ...key, provider_message_id: 'm1', payload: { headers: [] }, internal_date: scanStartedAt, is_deleted: false, ingested_at: scanStartedAt }],
    });
    const times = [0, 0, 15_001, 15_001];
    const result = await runBackfill(database, args({ maxBatches: 2 }), { now: () => times.shift() ?? 15_001 });
    expect(result.batchesProcessed).toBe(1);
    expect(result.completed).toBe(false);
  });

  it('acquires and releases the process advisory lock on success', async () => {
    const calls: string[] = [];
    const connection = { query: async (sql: string, bindings?: readonly unknown[]) => {
      calls.push(`${sql}:${String(bindings?.[0])}`);
      return sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rows: [] };
    } };
    const database = { client: {
      acquireConnection: async () => connection,
      releaseConnection: async () => { calls.push('release'); },
    } } as any;
    await withBackfillAdvisoryLock(database, async () => { calls.push('work'); return 1; });
    expect(calls).toEqual([
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked:${R05_BACKFILL_LOCK_NAME}`,
      'work',
      `SELECT pg_advisory_unlock(hashtext($1)):${R05_BACKFILL_LOCK_NAME}`,
      'release',
    ]);
  });

  it('releases the connection when lock-protected work fails', async () => {
    let released = false;
    const database = { client: {
      acquireConnection: async () => ({ query: async (sql: string) => sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rows: [] } }),
      releaseConnection: async () => { released = true; },
    } } as any;
    await expect(withBackfillAdvisoryLock(database, async () => { throw new Error('interrupted'); }))
      .rejects.toThrow('interrupted');
    expect(released).toBe(true);
  });

  it('does not enter the backfill when advisory-lock acquisition is rejected', async () => {
    let entered = false;
    let released = false;
    const database = { client: {
      acquireConnection: async () => ({ query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] };
        return { rows: [] };
      } }),
      releaseConnection: async () => { released = true; },
    } } as any;
    await expect(withBackfillAdvisoryLock(database, async () => { entered = true; return 1; }))
      .rejects.toThrow('already held');
    expect(entered).toBe(false);
    expect(released).toBe(true);
  });
});
