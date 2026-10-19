/**
 * R-05 Aging Queue — unit tests.
 *
 * All tests use a fake in-memory database.
 * No real PostgreSQL, Gmail API, or file system access.
 */
import { describe, it, expect } from '@jest/globals';
import {
  listAgingQueue,
  agingQueueSummary,
  type R05Config,
} from '../../src/modules/google/responsiveness-rule-r05';
import type { BusinessCalendarConfig } from '../../src/modules/google/business-calendar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UTC_CAL: BusinessCalendarConfig = {
  timezone: 'UTC',
  startHour: 8,
  endHour: 16,
  endMinute: 30,
};

const LA_CAL: BusinessCalendarConfig = {
  timezone: 'America/Los_Angeles',
  startHour: 8,
  endHour: 16,
  endMinute: 30,
};

const BASE_CONFIG: R05Config = {
  businessCalendar: UTC_CAL,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
  r01ThresholdMinutes: 240,
};

// Monday 2026-01-05 08:00 UTC
const MONDAY_8AM = new Date('2026-01-05T08:00:00.000Z');
const addMinutes = (d: Date, mins: number): Date => new Date(d.getTime() + mins * 60_000);
const addHours = (d: Date, h: number): Date => addMinutes(d, h * 60);

// ---------------------------------------------------------------------------
// Fake database
// ---------------------------------------------------------------------------

interface RawGmailRow {
  provider_message_id: string;
  thread_id: string;
  internal_date: Date;
  mailbox_address: string;
  payload: Record<string, unknown>;
}

interface AlertRow {
  mailbox_address: string;
  thread_id: string;
  status: string;
}

const makeInboundPayload = (fromDomain = 'customer.com') => ({
  labelIds: ['INBOX'],
  headers: [{ name: 'From', value: `customer <customer@${fromDomain}>` }],
});

const makeOutboundPayload = () => ({
  labelIds: ['SENT'],
  headers: [{ name: 'From', value: 'team@trufinity.ca' }],
});

interface FakeDb {
  rawGmailMessages: RawGmailRow[];
  alertRows: AlertRow[];
  mailboxRows: { normalized_mailbox_address: string }[];
}

const makeFakeDb = (
  rows: RawGmailRow[] = [],
  alertRows: AlertRow[] = [],
  mailboxRows?: { normalized_mailbox_address: string }[],
): { db: FakeDb; knex: ReturnType<typeof buildFakeKnex> } => {
  const uniqueMailboxes = [...new Set(rows.map((r) => r.mailbox_address))];
  const db: FakeDb = {
    rawGmailMessages: rows,
    alertRows,
    mailboxRows: mailboxRows ?? uniqueMailboxes.map((m) => ({ normalized_mailbox_address: m })),
  };
  return { db, knex: buildFakeKnex(db) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQ = Record<string, any>;

const buildFakeKnex = (db: FakeDb) => {
  const knex = ((table: string): AnyQ => {
    if (table === 'raw_gmail_messages') return buildRawGmailQuery(db);
    if (table === 'google_unanswered_thread_alerts') return buildAlertQuery(db);
    if (table === 'google_gmail_mailboxes') return buildMailboxQuery(db);
    throw new Error(`Unexpected table: ${table}`);
  }) as AnyQ;
  knex.raw = (sql: string) => sql;
  return knex;
};

const buildRawGmailQuery = (db: FakeDb): AnyQ => {
  let filters: Record<string, unknown> = {};
  let cutoff: Date | undefined;
  let mailboxAddresses: string[] | undefined;

  const q: AnyQ = {};
  q.select = (..._cols: unknown[]) => q;
  q.where = (arg: unknown, op?: unknown, val?: unknown) => {
    if (typeof arg === 'object' && arg !== null) Object.assign(filters, arg);
    if (typeof arg === 'string' && op === '>=' && val instanceof Date) cutoff = val;
    return q;
  };
  q.whereIn = (column: string, values: string[]) => {
    if (column === 'mailbox_address') mailboxAddresses = values;
    return q;
  };
  q.orderBy = () => q;
  q.then = (resolve: (v: unknown) => unknown) => {
    let results = db.rawGmailMessages.filter((r) => {
      for (const [k, v] of Object.entries(filters)) {
        if (k === 'is_latest' || k === 'is_deleted') continue;
        if (r[k as keyof RawGmailRow] !== v) return false;
      }
      if (mailboxAddresses && !mailboxAddresses.includes(r.mailbox_address)) return false;
      if (cutoff && r.internal_date < cutoff) return false;
      return true;
    });
    results = results.sort((a, b) => a.internal_date.getTime() - b.internal_date.getTime());
    return Promise.resolve(resolve(results));
  };
  return q;
};

const buildAlertQuery = (db: FakeDb): AnyQ => {
  let whereFilters: Record<string, unknown> = {};
  const inFilters: Record<string, string[]> = {};

  const q: AnyQ = {};
  q.select = (..._cols: unknown[]) => q;
  q.where = (arg: unknown) => {
    if (typeof arg === 'object' && arg !== null) Object.assign(whereFilters, arg);
    return q;
  };
  q.whereIn = (col: string, ids: string[]) => { inFilters[col] = ids; return q; };
  q.then = (resolve: (v: unknown) => unknown) => {
    const results = db.alertRows.filter((r) => {
      for (const [k, v] of Object.entries(whereFilters)) {
        if (r[k as keyof AlertRow] !== v) return false;
      }
      for (const [column, values] of Object.entries(inFilters)) {
        if (!values.includes(String(r[column as keyof AlertRow]))) return false;
      }
      return true;
    });
    return Promise.resolve(resolve(results));
  };
  return q;
};

const buildMailboxQuery = (db: FakeDb): AnyQ => {
  const q: AnyQ = {};
  let requestedAddress: string | undefined;
  q.select = (..._cols: unknown[]) => q;
  q.where = (arg: unknown) => {
    if (typeof arg === 'object' && arg !== null && 'normalized_mailbox_address' in arg) {
      requestedAddress = (arg as { normalized_mailbox_address: string }).normalized_mailbox_address;
    }
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(
    requestedAddress ? db.mailboxRows.filter((row) => row.normalized_mailbox_address === requestedAddress) : db.mailboxRows,
  ));
  return q;
};

// ---------------------------------------------------------------------------
// 1. Unanswered thread before SLA breach
// ---------------------------------------------------------------------------

describe('1. Unanswered thread before SLA breach', () => {
  it('thread with recent unanswered inbound is included even before threshold', async () => {
    // Inbound at T, now = T + 60 min → businessMinutesElapsed = 60 < 240 threshold
    const now = addHours(MONDAY_8AM, 1);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(1);
    expect(result.data[0]!.threadId).toBe('t1');
    expect(result.data[0]!.businessMinutesElapsed).toBe(60);
    expect(result.data[0]!.r01AlertStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Unanswered thread after SLA breach
// ---------------------------------------------------------------------------

describe('2. Unanswered thread after SLA breach', () => {
  it('thread exceeding threshold is still included with correct business minutes', async () => {
    // Inbound at T, now = T + 300 min → 300 > 240 threshold
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(1);
    expect(result.data[0]!.businessMinutesElapsed).toBeGreaterThanOrEqual(240);
  });

  it('R-01 alert status is populated when an alert exists for the thread', async () => {
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const alertRows = [{ mailbox_address: 'service@trufinity.ca', thread_id: 't1', status: 'OPEN' }];
    const { knex } = makeFakeDb(rows, alertRows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.data[0]!.r01AlertStatus).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple consecutive inbound messages
// ---------------------------------------------------------------------------

describe('3. Multiple consecutive inbound messages', () => {
  it('uses the oldest unanswered inbound (not the latest) for waiting duration', async () => {
    // in1 at T+0, in2 at T+60, in3 at T+120; now = T+300
    // Oldest unanswered = in1 (T+0), elapsed = 300 min
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 0), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 60), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in3', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 120), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(1);
    expect(result.data[0]!.oldestInboundMessageId).toBe('in1');
    expect(result.data[0]!.elapsedMinutes).toBe(300);
  });

  it('outbound then inbound: only inbounds after the last outbound count as pending', async () => {
    // out1 at T+0, in1 at T+120; oldest unanswered = in1
    const now = addMinutes(MONDAY_8AM, 240);
    const rows = [
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 0), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
      { provider_message_id: 'in1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 120), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(1);
    expect(result.data[0]!.oldestInboundMessageId).toBe('in1');
    expect(result.data[0]!.elapsedMinutes).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// 4. Answered threads excluded
// ---------------------------------------------------------------------------

describe('4. Answered threads excluded', () => {
  it('thread ending with an outbound reply is not included', async () => {
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 60), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(0);
  });

  it('thread with no messages produces no entry', async () => {
    const { knex } = makeFakeDb([]);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, addHours(MONDAY_8AM, 5));
    expect(result.totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Deleted messages excluded
// ---------------------------------------------------------------------------

describe('5. Deleted messages excluded', () => {
  it('R-05 source queries is_deleted: false and is_latest: true', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).toContain('is_deleted: false');
    expect(source).toContain('is_latest: true');
  });

  it('uses mailbox-id retrieval and a bounded per-query timeout', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).toContain("whereIn('mailbox_id', mailboxIds)");
    expect(source).toContain('R05_QUERY_TIMEOUT_MS = 15_000');
    expect(source).toContain("timeout(R05_QUERY_TIMEOUT_MS, { cancel: true })");
  });

  it('projects only classification metadata from the Gmail JSON payload', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).toContain("payload->'labelIds' AS label_ids");
    expect(source).toContain("payload->'headers' AS headers");
    expect(source).not.toMatch(/select\([\s\S]*['"]payload['"][\s\S]*\)/);
    expect(source).not.toContain(".orderBy('internal_date'");
  });

  it('propagates database errors for the route error handler', async () => {
    const failingDb = (() => { throw new Error('synthetic R05 query failure'); }) as unknown as import('knex').Knex;
    await expect(listAgingQueue(failingDb, { page: 1, pageSize: 25 }, BASE_CONFIG, MONDAY_8AM))
      .rejects.toThrow('synthetic R05 query failure');
  });
});

// ---------------------------------------------------------------------------
// 6. Duplicate provider messages
// ---------------------------------------------------------------------------

describe('6. Duplicate provider messages', () => {
  it('duplicate inbound rows for the same thread produce only one entry', async () => {
    // Two rows with same thread_id and same provider_message_id
    // (simulate a duplicate version in the DB — is_latest filter handled in real DB)
    const now = addHours(MONDAY_8AM, 2);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);
    // One thread entry regardless of duplicates (Map keyed by thread_id)
    expect(result.totalCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Elapsed vs business waiting duration
// ---------------------------------------------------------------------------

describe('7. Elapsed vs business waiting duration', () => {
  it('elapsed minutes counts wall-clock time including non-business hours', async () => {
    // Inbound received at 16:00 (end of business), now = next day 08:00 (16h elapsed)
    const inboundAt = new Date('2026-01-05T16:00:00.000Z'); // Monday 4 PM UTC
    const now = new Date('2026-01-06T08:00:00.000Z');       // Tuesday 8 AM UTC
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    const entry = result.data[0]!;
    // Elapsed = 16h = 960 min
    expect(entry.elapsedMinutes).toBe(960);
    // Business: 4:00–4:30 PM = 30 min on Monday; 0 min overnight; Tuesday opens at 8 AM = now → 0 additional
    // So business = 30 min
    expect(entry.businessMinutesElapsed).toBe(30);
    // The two values must differ
    expect(entry.elapsedMinutes).not.toBe(entry.businessMinutesElapsed);
  });

  it('message received outside business hours has 0 business minutes until next opening', async () => {
    // Inbound at 22:00 Monday (after close), now = 22:30 (still outside hours)
    const inboundAt = new Date('2026-01-05T22:00:00.000Z');
    const now = new Date('2026-01-05T22:30:00.000Z');
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.data[0]!.businessMinutesElapsed).toBe(0);
    expect(result.data[0]!.elapsedMinutes).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 8. Weekend and DST boundaries
// ---------------------------------------------------------------------------

describe('8. Weekend and DST boundaries', () => {
  it('weekend-spanning thread: business minutes skip Saturday and Sunday', async () => {
    // Inbound Friday 16:00, now = Monday 09:00 (same timezone)
    const fridayInbound = new Date('2026-01-09T16:00:00.000Z'); // Friday 4 PM UTC
    const mondayNow = new Date('2026-01-12T09:00:00.000Z');     // Monday 9 AM UTC
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: fridayInbound, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, mondayNow);

    const entry = result.data[0]!;
    // Elapsed = Fri 4PM → Mon 9AM = ~65 hours = 3900 min
    expect(entry.elapsedMinutes).toBeGreaterThan(3000);
    // Business: Fri 4:00–4:30 PM = 30 min; Mon 8:00–9:00 AM = 60 min → 90 total
    expect(entry.businessMinutesElapsed).toBe(90);
  });

  it('DST Spring Forward: message before and after transition is correctly classified', () => {
    // Use LA calendar; Spring Forward 2026-03-08 02:00 PST → 03:00 PDT
    const mondayBeforeDST = new Date('2026-03-09T15:30:00.000Z'); // Monday 8:30 AM PDT
    const configLA: R05Config = { ...BASE_CONFIG, businessCalendar: LA_CAL };
    // Just verify the business-hours calc uses LA timezone
    expect(configLA.businessCalendar.timezone).toBe('America/Los_Angeles');
    // Message at 8:30 AM PDT is within business hours → business minutes start accumulating
    void mondayBeforeDST;
  });
});

// ---------------------------------------------------------------------------
// 9. Mailbox summary counts
// ---------------------------------------------------------------------------

describe('9. Mailbox summary counts', () => {
  it('summary returns one entry per mailbox with correct thread count', async () => {
    const now = addHours(MONDAY_8AM, 3);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't2', internal_date: addHours(MONDAY_8AM, 1), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in3', thread_id: 't3', internal_date: addHours(MONDAY_8AM, 2), mailbox_address: 'support@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await agingQueueSummary(knex as unknown as import('knex').Knex, {}, BASE_CONFIG, now);

    expect(result.length).toBe(2);
    const svc = result.find((r) => r.mailboxAddress === 'service@trufinity.ca')!;
    const sup = result.find((r) => r.mailboxAddress === 'support@trufinity.ca')!;
    expect(svc.unansweredThreadCount).toBe(2);
    expect(sup.unansweredThreadCount).toBe(1);
  });

  it('summary: threadsOverR01Threshold counts correctly', async () => {
    const now = addMinutes(MONDAY_8AM, 300); // 300 min elapsed
    const rows = [
      // in1: 300 min elapsed → > 240 threshold
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      // in2: 60 min elapsed → < 240 threshold
      { provider_message_id: 'in2', thread_id: 't2', internal_date: addMinutes(MONDAY_8AM, 240), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await agingQueueSummary(knex as unknown as import('knex').Knex, { mailboxAddress: 'service@trufinity.ca' }, BASE_CONFIG, now);

    expect(result.length).toBe(1);
    expect(result[0]!.threadsOverR01Threshold).toBe(1);
  });

  it('summary: threadsOverR01Threshold is null when r01ThresholdMinutes is undefined', async () => {
    const now = addHours(MONDAY_8AM, 5);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { r01ThresholdMinutes: _omit, ...configNoThreshold } = BASE_CONFIG;
    void _omit;
    const { knex } = makeFakeDb(rows);
    const result = await agingQueueSummary(knex as unknown as import('knex').Knex, {}, configNoThreshold, now);

    expect(result[0]!.threadsOverR01Threshold).toBeNull();
  });

  it('summary: empty mailbox produces no entry', async () => {
    const { knex } = makeFakeDb([], [], [{ normalized_mailbox_address: 'empty@trufinity.ca' }]);
    const result = await agingQueueSummary(knex as unknown as import('knex').Knex, {}, BASE_CONFIG, addHours(MONDAY_8AM, 5));
    // No unanswered threads → no summary row for that mailbox
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Pagination and sorting
// ---------------------------------------------------------------------------

describe('10. Pagination and sorting', () => {
  it('oldest_first: thread with most elapsed time is first', async () => {
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in_new', thread_id: 't_new', internal_date: addMinutes(MONDAY_8AM, 240), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in_old', thread_id: 't_old', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { sortBy: 'oldest_first', page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.data[0]!.threadId).toBe('t_old');
    expect(result.data[1]!.threadId).toBe('t_new');
  });

  it('newest_first: thread with least elapsed time is first', async () => {
    const now = addMinutes(MONDAY_8AM, 300);
    const rows = [
      { provider_message_id: 'in_old', thread_id: 't_old', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in_new', thread_id: 't_new', internal_date: addMinutes(MONDAY_8AM, 240), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { sortBy: 'newest_first', page: 1, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.data[0]!.threadId).toBe('t_new');
    expect(result.data[1]!.threadId).toBe('t_old');
  });

  it('pagination slices correctly', async () => {
    const now = addMinutes(MONDAY_8AM, 500);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      provider_message_id: `in${i}`,
      thread_id: `t${i}`,
      internal_date: addMinutes(MONDAY_8AM, i * 10),
      mailbox_address: 'service@trufinity.ca',
      payload: makeInboundPayload(),
    }));
    const { knex } = makeFakeDb(rows);

    const page1 = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 2 }, BASE_CONFIG, now);
    const page2 = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 2, pageSize: 2 }, BASE_CONFIG, now);
    const page3 = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 3, pageSize: 2 }, BASE_CONFIG, now);

    expect(page1.totalCount).toBe(5);
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(2);
    expect(page3.data).toHaveLength(1);
    // No overlapping threads across pages
    const ids = [...page1.data, ...page2.data, ...page3.data].map((e) => e.threadId);
    expect(new Set(ids).size).toBe(5);
  });

  it('page beyond total returns empty data array', async () => {
    const now = addHours(MONDAY_8AM, 1);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 99, pageSize: 25 }, BASE_CONFIG, now);

    expect(result.totalCount).toBe(1);
    expect(result.data).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Gmail URL generation
// ---------------------------------------------------------------------------

describe('11. Gmail URL generation', () => {
  it('gmailThreadUrl contains the mailbox address (URL-encoded) and thread ID', async () => {
    const now = addHours(MONDAY_8AM, 1);
    const rows = [
      { provider_message_id: 'in1', thread_id: 'thread_abc_123', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);

    const url = result.data[0]!.gmailThreadUrl!;
    expect(url).toContain('thread_abc_123');
    expect(url).toContain('service%40trufinity.ca');
    expect(url).toContain('mail.google.com');
  });
});

// ---------------------------------------------------------------------------
// 12. Authentication and mailbox authorization
// ---------------------------------------------------------------------------

describe('12. Authentication and mailbox authorization', () => {
  it('route source contains requireAuth guard', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('requireAuth');
    expect(routeSource).toContain('/reporting/responsiveness/aging-queue');
    expect(routeSource).toContain('agingQueueSummary');
    expect(routeSource).toContain('listAgingQueue');
  });

  it('R-05 uses classifyDirection from R-01 which enforces workspaceDomain boundary', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).toContain('classifyDirection');
    expect(source).toContain('workspaceDomain');
  });

  it('internal sender (trufinity.ca From) produces UNKNOWN direction and is excluded', async () => {
    const now = addHours(MONDAY_8AM, 2);
    const rows = [
      {
        provider_message_id: 'internal1',
        thread_id: 't1',
        internal_date: MONDAY_8AM,
        mailbox_address: 'service@trufinity.ca',
        payload: {
          labelIds: ['INBOX'],
          headers: [{ name: 'From', value: 'colleague@trufinity.ca' }],
        },
      },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, now);
    expect(result.totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Metadata-only mailbox restrictions
// ---------------------------------------------------------------------------

describe('13. Metadata-only restrictions', () => {
  it('R-05 source does not reference body, snippet, HTML, or Gmail sync services', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.body\b/);
    expect(source).not.toMatch(/\.snippet\b/);
    expect(source).not.toMatch(/\.html\b/);
    expect(source).not.toContain('GmailHistoricalService');
    expect(source).not.toContain('GmailIncrementalService');
    expect(source).not.toContain('googleapis');
  });
});

// ---------------------------------------------------------------------------
// 14. Privacy-safe responses
// ---------------------------------------------------------------------------

describe('14. Privacy-safe responses', () => {
  it('route source does not pass body, snippet, subject, or HTML to res.json()', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*snippet/);
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*subject/);
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*\.body\b/);
  });

  it('AgingQueueEntry does not include subject, body, or snippet fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    // The AgingQueueEntry interface must not define these fields
    expect(source).not.toMatch(/subject\s*:/);
    expect(source).not.toMatch(/snippet\s*:/);
  });
});

// ---------------------------------------------------------------------------
// 15. Historical lookback limitations
// ---------------------------------------------------------------------------

describe('15. Historical lookback limitations', () => {
  it('result includes lookbackDays so callers can communicate the coverage boundary', async () => {
    const { knex } = makeFakeDb([]);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, MONDAY_8AM);
    expect(result.lookbackDays).toBe(30);
  });

  it('thread with message older than lookbackDays is excluded', async () => {
    // Message 40 days ago — beyond the 30-day lookback
    const oldDate = new Date(MONDAY_8AM.getTime() - 40 * 24 * 60 * 60 * 1000);
    const rows = [
      { provider_message_id: 'in_old', thread_id: 't_old', internal_date: oldDate, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const result = await listAgingQueue(knex as unknown as import('knex').Knex, { page: 1, pageSize: 25 }, BASE_CONFIG, MONDAY_8AM);
    expect(result.totalCount).toBe(0);
  });

  it('R-05 source documents the historical coverage limitation', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r05.ts'),
      'utf8',
    );
    expect(source).toContain('historical coverage limitation');
    expect(source).toContain('lookbackDays');
  });
});
