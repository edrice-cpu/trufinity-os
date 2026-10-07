import { describe, expect, it } from '@jest/globals';
import { KnexGmailHistoricalRepository } from '../../src/modules/google/gmail-historical.repository';

// Minimal fake standing in for the subset of the Knex query-builder surface
// completeIncrementalRun() actually uses, so the row-count assertion inside it
// can be exercised without a live database. It does not simulate real
// transactional rollback (that guarantee comes from Postgres/knex itself, the
// same mechanism already relied on by commitBatch()/completeMailbox()); it
// only lets us control what each table's .update() resolves to.
function createFakeDatabase(options: { syncRunsUpdateCount: number; metadataUpdateCount?: number }) {
  const calls: { table: string; update: Record<string, unknown> }[] = [];
  const trx = ((table: string) => ({
    where: () => ({
      update: async (update: Record<string, unknown>) => {
        calls.push({ table, update });
        if (table === 'sync_runs') return options.syncRunsUpdateCount;
        if (table === 'raw_gmail_sync_metadata') return options.metadataUpdateCount ?? 1;
        throw new Error(`Unexpected table in test fake: ${table}`);
      },
    }),
  })) as unknown as import('knex').Knex.Transaction;
  (trx as unknown as { fn: { now: () => string } }).fn = { now: () => 'NOW()' };
  const database = {
    transaction: async (work: (trx: unknown) => Promise<void>) => work(trx),
  } as unknown as import('knex').Knex;
  return { database, calls };
}

describe('KnexGmailHistoricalRepository.completeIncrementalRun', () => {
  it('succeeds when exactly one RUNNING sync_runs row matches', async () => {
    const { database, calls } = createFakeDatabase({ syncRunsUpdateCount: 1 });
    const repository = new KnexGmailHistoricalRepository(database);

    await expect(repository.completeIncrementalRun('mailbox-1', 'run-1', '1001', 5)).resolves.toBeUndefined();
    expect(calls.find((c) => c.table === 'sync_runs')?.update).toMatchObject({ status: 'COMPLETED', records_processed: 5 });
  });

  it('throws instead of silently succeeding when zero sync_runs rows match', async () => {
    const { database, calls } = createFakeDatabase({ syncRunsUpdateCount: 0 });
    const repository = new KnexGmailHistoricalRepository(database);

    await expect(repository.completeIncrementalRun('mailbox-1', 'run-1', '1001', 5)).rejects.toThrow(
      /did not match exactly one RUNNING sync_runs row/,
    );
    // The checkpoint update was attempted inside the same transaction callback that
    // throws; knex/Postgres rolls back everything issued on `trx` when the callback
    // rejects, so this attempted write does not persist.
    expect(calls.find((c) => c.table === 'raw_gmail_sync_metadata')).toBeDefined();
  });

  it('throws if more than one row unexpectedly matches', async () => {
    const { database } = createFakeDatabase({ syncRunsUpdateCount: 2 });
    const repository = new KnexGmailHistoricalRepository(database);

    await expect(repository.completeIncrementalRun('mailbox-1', 'run-1', '1001', 5)).rejects.toThrow(
      /did not match exactly one RUNNING sync_runs row/,
    );
  });

  it('skips the checkpoint write but still requires exactly one RUNNING row when newHistoryId is null', async () => {
    const { database, calls } = createFakeDatabase({ syncRunsUpdateCount: 1 });
    const repository = new KnexGmailHistoricalRepository(database);

    await expect(repository.completeIncrementalRun('mailbox-1', 'run-1', null, 0)).resolves.toBeUndefined();
    expect(calls.find((c) => c.table === 'raw_gmail_sync_metadata')).toBeUndefined();
  });
});

describe('KnexGmailHistoricalRepository.commitBatch tombstones', () => {
  const mailbox = { id: 'mb-1', mailboxAddress: 's@x.ca', normalizedMailboxAddress: 's@x.ca', contentMode: 'METADATA' } as never;

  function fake(currentRow: Record<string, unknown> | undefined) {
    const inserts: Record<string, unknown>[] = [];
    const trx = ((table: string) => ({
      where: () => ({
        first: async () => currentRow,
        update: async () => 1,
      }),
      insert: async (row: Record<string, unknown>) => { if (table === 'raw_gmail_messages') inserts.push(row); },
    })) as unknown as import('knex').Knex.Transaction;
    const database = { transaction: async (work: (t: unknown) => Promise<void>) => work(trx) } as unknown as import('knex').Knex;
    return { repository: new KnexGmailHistoricalRepository(database), inserts };
  }

  const tombstone = { providerMessageId: 'm1', threadId: '', payload: null, contentMode: 'METADATA' as const, internalDate: new Date(), providerHistoryId: null, isDeleted: true };

  it('persists a non-null empty payload with is_deleted=true for a tombstone', async () => {
    const { repository, inserts } = fake(undefined);
    expect(await repository.commitBatch(mailbox, 'run-1', [tombstone], [])).toBe(1);
    expect(inserts[0].payload).toEqual({});
    expect(inserts[0].payload).not.toBeNull();
    expect(inserts[0].is_deleted).toBe(true);
  });

  it('deduplicates a repeated tombstone against an existing deleted row', async () => {
    const { repository, inserts } = fake({ payload: {}, is_deleted: true });
    expect(await repository.commitBatch(mailbox, 'run-1', [tombstone], [])).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('supersedes a live row with a tombstone', async () => {
    const { repository, inserts } = fake({ payload: { headers: [] }, is_deleted: false });
    expect(await repository.commitBatch(mailbox, 'run-1', [tombstone], [])).toBe(1);
    expect(inserts[0].is_deleted).toBe(true);
  });

  it('leaves live messages unchanged (payload passed through, is_deleted=false)', async () => {
    const { repository, inserts } = fake(undefined);
    await repository.commitBatch(mailbox, 'run-1', [{ ...tombstone, threadId: 't', payload: { headers: [] }, isDeleted: false }], []);
    expect(inserts[0].payload).toEqual({ headers: [] });
    expect(inserts[0].is_deleted).toBe(false);
  });
});
