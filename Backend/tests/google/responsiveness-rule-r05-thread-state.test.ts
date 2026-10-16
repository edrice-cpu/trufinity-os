import { describe, expect, it } from '@jest/globals';
import {
  agingQueueSummary,
  listAgingQueue,
  R05BackfillIncompleteError,
  type R05Config,
} from '../../src/modules/google/responsiveness-rule-r05';

const config: R05Config = {
  businessCalendar: { timezone: 'UTC', startHour: 8, endHour: 16, endMinute: 30 },
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
  r01ThresholdMinutes: 60,
  useThreadState: true,
};
const now = new Date('2026-01-05T12:00:00.000Z');

type Row = Record<string, any>;
const makeDb = (complete: boolean, includeRows = true) => {
  const tables: Record<string, Row[]> = {
    google_gmail_mailboxes: [
      { id: 'm1', normalized_mailbox_address: 'service@trufinity.ca', enabled: true },
      { id: 'm2', normalized_mailbox_address: 'support@trufinity.ca', enabled: true },
    ],
    google_gmail_thread_state_backfill: complete ? [{ job_name: 'R05_THREAD_STATE_V1', status: 'COMPLETED' }] : [],
    google_gmail_thread_responsiveness: includeRows ? [
      { mailbox_id: 'm1', mailbox_address: 'service@trufinity.ca', thread_id: 't1', has_unanswered: true, last_activity_at: new Date('2026-01-05T11:00:00Z') },
      { mailbox_id: 'm1', mailbox_address: 'service@trufinity.ca', thread_id: 't2', has_unanswered: true, last_activity_at: new Date('2026-01-04T11:00:00Z') },
      { mailbox_id: 'm2', mailbox_address: 'support@trufinity.ca', thread_id: 't3', has_unanswered: true, last_activity_at: new Date('2026-01-04T10:00:00Z') },
    ] : [],
    google_gmail_message_facts: includeRows ? [
      { mailbox_id: 'm1', mailbox_address: 'service@trufinity.ca', thread_id: 't1', provider_message_id: 'p1', internal_date: new Date('2026-01-05T10:00:00Z'), direction: 'INBOUND' },
      { mailbox_id: 'm1', mailbox_address: 'service@trufinity.ca', thread_id: 't2', provider_message_id: 'p2', internal_date: new Date('2026-01-04T10:00:00Z'), direction: 'INBOUND' },
      { mailbox_id: 'm2', mailbox_address: 'support@trufinity.ca', thread_id: 't3', provider_message_id: 'p3', internal_date: new Date('2026-01-04T09:00:00Z'), direction: 'INBOUND' },
    ] : [],
    google_unanswered_thread_alerts: includeRows ? [{ mailbox_address: 'service@trufinity.ca', thread_id: 't1', status: 'OPEN' }] : [],
  };

  const knex = ((table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q: any = {
      select: () => q,
      where: (arg: any, op?: any, value?: any) => {
        if (typeof arg === 'function') return q;
        if (typeof arg === 'object') rows = rows.filter((row) => Object.entries(arg).every(([k, v]) => row[k] === v));
        else if (op === '>=') rows = rows.filter((row) => row[arg] >= value);
        else rows = rows.filter((row) => row[arg] === op);
        return q;
      },
      whereIn: (column: string, values: any[]) => { rows = rows.filter((row) => values.includes(row[column])); return q; },
      first: () => Promise.resolve(rows[0]),
      then: (resolve: (value: Row[]) => unknown) => Promise.resolve(resolve(rows)),
    };
    return q;
  }) as any;
  return knex;
};

describe('R05 derived thread-state read path', () => {
  it('uses persisted state for an exact summary without loading facts', async () => {
    const base = makeDb(true);
    const states = [
      {
        mailbox_id: 'm1', mailbox_address: 'service@trufinity.ca', thread_id: 'state-thread',
        has_unanswered: true, last_activity_at: new Date('2026-01-05T11:00:00Z'),
        oldest_unanswered_message_id: 'state-message',
        oldest_unanswered_at: new Date('2026-01-05T10:00:00Z'),
      },
    ];
    const db = ((table: string) => {
      if (table === 'google_gmail_message_facts') throw new Error('summary must not load facts');
      return base(table);
    }) as any;
    // The fake builder is intentionally simple; replace the state table rows
    // through a small table-aware wrapper while retaining the existing query behavior.
    const stateDb = ((table: string) => {
      if (table !== 'google_gmail_thread_responsiveness') return db(table);
      const q: any = base(table);
      let rows: any[] = [...states];
      q.where = (arg: any, op?: any, value?: any) => {
        if (typeof arg === 'object') rows = rows.filter((row) => Object.entries(arg).every(([k, v]) => row[k] === v));
        else if (op === '>=') rows = rows.filter((row) => row[arg] >= value);
        else rows = rows.filter((row) => row[arg] === op);
        return q;
      };
      q.whereIn = (column: string, values: any[]) => { rows = rows.filter((row) => values.includes(row[column])); return q; };
      q.then = (resolve: (value: any[]) => unknown) => Promise.resolve(resolve(rows));
      return q;
    }) as any;
    const result = await agingQueueSummary(stateDb, {}, config, now);
    expect(result).toEqual([expect.objectContaining({
      mailboxAddress: 'service@trufinity.ca',
      unansweredThreadCount: 1,
      oldestElapsedMinutes: 120,
      averageElapsedMinutes: 120,
    })]);
  });

  it('keeps summary totals and list totals consistent with mailbox filtering and pagination', async () => {
    const db = makeDb(true);
    const list = await listAgingQueue(db, { page: 1, pageSize: 1 }, config, now);
    const summary = await agingQueueSummary(db, {}, config, now);
    expect(list.totalCount).toBe(3);
    expect(list.data).toHaveLength(1);
    expect(summary.reduce((sum, row) => sum + row.unansweredThreadCount, 0)).toBe(list.totalCount);

    const filtered = await listAgingQueue(db, { mailboxAddress: 'support@trufinity.ca', page: 1, pageSize: 25 }, config, now);
    expect(filtered.totalCount).toBe(1);
    expect(filtered.data[0]?.mailboxAddress).toBe('support@trufinity.ca');
  });

  it('fails closed while the backfill is incomplete', async () => {
    await expect(agingQueueSummary(makeDb(false), {}, config, now))
      .rejects.toBeInstanceOf(R05BackfillIncompleteError);
  });

  it('returns an empty result for a complete but empty derived dataset', async () => {
    const db = makeDb(true, false);
    const result = await listAgingQueue(db, { page: 1, pageSize: 25 }, config, now);
    expect(result.totalCount).toBe(0);
    expect(result.data).toEqual([]);
  });
});
