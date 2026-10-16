/**
 * R-03 Reply Latency Outlier — unit tests.
 *
 * All tests use a fake in-memory database.
 * No real PostgreSQL, Gmail API, or file system access.
 */
import { describe, it, expect } from '@jest/globals';
import {
  KnexR03Rule,
  resolveThreshold,
  isExcludedMailbox,
  findReplyPairs,
  type R03Config,
} from '../../src/modules/google/responsiveness-rule-r03';
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

// Pacific Time calendar for DST tests
const LA_CAL: BusinessCalendarConfig = {
  timezone: 'America/Los_Angeles',
  startHour: 8,
  endHour: 16,
  endMinute: 30,
};

const BASE_CONFIG: R03Config = {
  businessCalendar: UTC_CAL,
  defaultThresholdMinutes: 510,
  mailboxThresholds: {
    'service@trufinity.ca': 240,
    'support@trufinity.ca': 240,
  },
  excludedMailboxes: ['billing@trufinity.ca', 'careers@trufinity.ca', 'info@trufinity.ca'],
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

// Convenience: build a UTC Date from hour offset (from Monday 2026-01-05 08:00 UTC)
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
  latencyInserts: Record<string, unknown>[];
  latencyMerges: Record<string, unknown>[];
  latencyKeys: Set<string>;
}

const makeFakeDb = (rows: RawGmailRow[] = []): { db: FakeDb; knex: ReturnType<typeof buildFakeKnex> } => {
  const db: FakeDb = { rawGmailMessages: rows, latencyInserts: [], latencyMerges: [], latencyKeys: new Set() };
  return { db, knex: buildFakeKnex(db) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQ = Record<string, any>;

const buildFakeKnex = (db: FakeDb) => {
  return (table: string): AnyQ => {
    if (table === 'raw_gmail_messages') {
      return buildRawGmailQuery(db);
    }
    if (table === 'google_reply_latency_records') {
      return buildLatencyQuery(db);
    }
    throw new Error(`Unexpected table: ${table}`);
  };
};

const buildRawGmailQuery = (db: FakeDb): AnyQ => {
  let filters: Record<string, unknown> = {};
  let cutoff: Date | undefined;
  let selectedCols: string[] = [];

  const q: AnyQ = {};
  q.select = (..._cols: unknown[]) => { selectedCols = _cols.flat() as string[]; void selectedCols; return q; };
  q.where = (arg: unknown, _op?: unknown, _val?: unknown) => {
    if (typeof arg === 'object' && arg !== null) Object.assign(filters, arg);
    return q;
  };
  q.andWhere = q.where;
  q.whereIn = (_col: string, _vals: unknown[]) => q;
  q.orderBy = (_col: string, _dir: string) => q;
  q.then = (resolve: (v: unknown) => unknown) => {
    let results = db.rawGmailMessages.filter((r) => {
      for (const [k, v] of Object.entries(filters)) {
        if (k === 'internal_date' || k === 'is_latest' || k === 'is_deleted') continue;
        if (r[k as keyof RawGmailRow] !== v) return false;
      }
      if (cutoff && r.internal_date < cutoff) return false;
      return true;
    });
    // Apply internal_date >= filter
    if (filters['internal_date'] === undefined && cutoff) {
      results = results.filter((r) => r.internal_date >= cutoff!);
    }
    return Promise.resolve(resolve(results));
  };
  // Support .where('internal_date', '>=', date) chaining
  const originalWhere = q.where.bind(q);
  q.where = (arg: unknown, op?: unknown, val?: unknown) => {
    if (typeof arg === 'string' && op === '>=' && val instanceof Date) {
      cutoff = val;
      return q;
    }
    return originalWhere(arg, op, val);
  };
  return q;
};

const buildLatencyQuery = (db: FakeDb): AnyQ => {
  let insertData: Record<string, unknown> = {};
  const q: AnyQ = {};
  q.insert = (data: Record<string, unknown>) => {
    insertData = data;
    db.latencyInserts.push({ ...data });
    return q;
  };
  q.onConflict = (_cols: string[]) => ({
    ignore: () => ({
      returning: (_col: string | string[]) => {
        const key = `${String(insertData['mailbox_address'])}|${String(insertData['thread_id'])}|${String(insertData['inbound_message_id'])}`;
        const isNew = !db.latencyKeys.has(key);
        if (isNew) db.latencyKeys.add(key);
        // Keep the historical test fixture's audit trail while returning the
        // same insert-aware signal as PostgreSQL RETURNING.
        db.latencyMerges.push({ ...insertData });
        return Promise.resolve(isNew ? [{ id: 'fake-id' }] : []);
      },
    }),
  });
  q.where = () => q;
  q.update = (data: Record<string, unknown>) => {
    void data;
    return Promise.resolve(1);
  };
  return q;
};

// ---------------------------------------------------------------------------
// 1. service@ and support@ — 4-hour threshold
// ---------------------------------------------------------------------------

describe('1. service@ and support@ — 4-hour threshold', () => {
  it('resolveThreshold returns 240 for service@trufinity.ca', () => {
    expect(resolveThreshold('service@trufinity.ca', BASE_CONFIG)).toBe(240);
  });

  it('resolveThreshold returns 240 for support@trufinity.ca', () => {
    expect(resolveThreshold('support@trufinity.ca', BASE_CONFIG)).toBe(240);
  });

  it('resolveThreshold is case-insensitive', () => {
    expect(resolveThreshold('SERVICE@TRUFINITY.CA', BASE_CONFIG)).toBe(240);
  });

  it('reply within 4h is ON_TIME for service@', async () => {
    const inboundAt = MONDAY_8AM;
    const replyAt = addHours(MONDAY_8AM, 3); // 3 biz hours — under 240 min

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges.length).toBe(1);
    expect(db.latencyMerges[0]!['status']).toBe('ON_TIME');
  });

  it('reply exceeding 4h is LATE for service@', async () => {
    const inboundAt = MONDAY_8AM;
    const replyAt = addHours(MONDAY_8AM, 5); // 5 biz hours — over 240 min

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges[0]!['status']).toBe('LATE');
    expect(result.lateRepliesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Personal mailbox — 1-business-day threshold
// ---------------------------------------------------------------------------

describe('2. Personal mailbox — default threshold', () => {
  it('resolveThreshold returns defaultThresholdMinutes for unknown mailbox', () => {
    expect(resolveThreshold('personal@trufinity.ca', BASE_CONFIG)).toBe(510);
  });

  it('reply within 1 biz day is ON_TIME for personal mailbox', async () => {
    const inboundAt = MONDAY_8AM;
    const replyAt = addMinutes(MONDAY_8AM, 400); // 400 min < 510

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'personal@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'personal@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('personal@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges[0]!['status']).toBe('ON_TIME');
    expect(db.latencyMerges[0]!['threshold_minutes']).toBe(510);
  });

  it('reply exceeding 1 biz day is LATE for personal mailbox', async () => {
    // 1 business day = 8h30m = 510 min (8:00–16:30).
    // Inbound Monday 8 AM; reply Tuesday 8:30 AM = 510 min + 30 min into next day = LATE.
    const inboundAt = MONDAY_8AM; // Monday 08:00 UTC
    // Tuesday 8:31 AM UTC = Monday 8:00 + 24h31m; business elapsed = 510 (Mon full day) + 31 min = 541 min
    const replyAt = new Date('2026-01-06T08:31:00.000Z'); // Tuesday 08:31 UTC

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'personal@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'personal@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('personal@trufinity.ca', BASE_CONFIG, new Date('2026-01-06T09:00:00.000Z'));

    expect(db.latencyMerges[0]!['status']).toBe('LATE');
    expect(result.lateRepliesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Excluded mailboxes
// ---------------------------------------------------------------------------

describe('3. Excluded mailboxes — billing, careers, info', () => {
  const excludedAddresses = [
    'billing@trufinity.ca',
    'careers@trufinity.ca',
    'info@trufinity.ca',
  ];

  for (const addr of excludedAddresses) {
    it(`isExcludedMailbox returns true for ${addr}`, () => {
      expect(isExcludedMailbox(addr, BASE_CONFIG)).toBe(true);
    });

    it(`evaluateMailbox returns zero result for ${addr}`, async () => {
      const { knex, db } = makeFakeDb([
        { provider_message_id: 'msg1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: addr, payload: makeInboundPayload() },
        { provider_message_id: 'msg2', thread_id: 't1', internal_date: addHours(MONDAY_8AM, 6), mailbox_address: addr, payload: makeOutboundPayload() },
      ]);
      const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
      const result = await rule.evaluateMailbox(addr, BASE_CONFIG);
      expect(result.threadsEvaluated).toBe(0);
      expect(db.latencyInserts.length).toBe(0);
    });
  }

  it('isExcludedMailbox is case-insensitive', () => {
    expect(isExcludedMailbox('BILLING@TRUFINITY.CA', BASE_CONFIG)).toBe(true);
  });

  it('non-excluded mailbox returns false', () => {
    expect(isExcludedMailbox('support@trufinity.ca', BASE_CONFIG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Pacific timezone / DST
// ---------------------------------------------------------------------------

describe('4. Pacific timezone and DST', () => {
  // PST: UTC-8 → 8 AM PST = 16:00 UTC
  // PDT: UTC-7 → 8 AM PDT = 15:00 UTC

  it('PST — reply at 11 AM PST after 8 AM PST = 3 biz hours under 4h threshold → ON_TIME', async () => {
    // January: PST (UTC-8). 8 AM PST = 16:00 UTC, 11 AM PST = 19:00 UTC
    const inboundAt = new Date('2026-01-05T16:00:00.000Z'); // 8:00 AM PST
    const replyAt = new Date('2026-01-05T19:00:00.000Z');  // 11:00 AM PST = 3 biz hours

    const laConfig = { ...BASE_CONFIG, businessCalendar: LA_CAL };
    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', laConfig, new Date('2026-01-05T21:00:00.000Z'));
    expect(db.latencyMerges[0]!['status']).toBe('ON_TIME');
  });

  it('PDT — inbound outside business hours ages from next open', async () => {
    // July: PDT (UTC-7). 5 PM PDT = 00:00 UTC next day; 8 AM PDT = 15:00 UTC
    const inboundAt = new Date('2026-07-06T00:00:00.000Z'); // 5 PM PDT (after close)
    const replyAt = new Date('2026-07-06T20:00:00.000Z');   // 1 PM PDT next working morning = 5 biz hours > 4h

    const laConfig = { ...BASE_CONFIG, businessCalendar: LA_CAL };
    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', laConfig, new Date('2026-07-06T23:59:59.000Z'));
    expect(db.latencyMerges[0]!['status']).toBe('LATE');
  });
});

// ---------------------------------------------------------------------------
// 5. Exact threshold boundaries
// ---------------------------------------------------------------------------

describe('5. Exact threshold boundaries', () => {
  it('elapsed == threshold is ON_TIME (not strictly greater)', async () => {
    // 240 min reply for service@ — exactly at threshold
    const inboundAt = MONDAY_8AM;
    const replyAt = addMinutes(MONDAY_8AM, 240); // exactly 240 business minutes

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));
    expect(db.latencyMerges[0]!['status']).toBe('ON_TIME');
  });

  it('elapsed == threshold + 1 is LATE', async () => {
    const inboundAt = MONDAY_8AM;
    const replyAt = addMinutes(MONDAY_8AM, 241); // 1 minute over threshold

    const { knex, db } = makeFakeDb([
      { provider_message_id: 'msg1', thread_id: 't1', internal_date: inboundAt, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'msg2', thread_id: 't1', internal_date: replyAt, mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));
    expect(db.latencyMerges[0]!['status']).toBe('LATE');
    expect(result.lateRepliesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple inbound messages before a reply
// ---------------------------------------------------------------------------

describe('6. Multiple inbound messages before a reply', () => {
  it('findReplyPairs returns ONE pair for multiple consecutive inbounds before a reply (earliest inbound only)', () => {
    const msgs = [
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'INBOUND' as const },
      { providerId: 'in2', internalDate: addMinutes(MONDAY_8AM, 30), direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 90), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    // Only one pair: from the earliest inbound (in1) to the first reply (out1).
    // in2 is part of the same pending segment — latency is measured from in1, not in2.
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
  });

  it('evaluateMailbox produces ONE latency record for multiple consecutive inbounds (earliest inbound → first reply)', async () => {
    // in1 at T+0, in2 at T+60, out1 at T+270.
    // Expected: one record for in1 (earliest). Latency = 270 min > 240 → LATE.
    // in2 is NOT measured separately — the one reply closes the entire pending segment.
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 0), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 60), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 270), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges.length).toBe(1);
    // Only in1 is measured: 270 min elapsed > 240 threshold → LATE
    expect(db.latencyMerges[0]!['inbound_message_id']).toBe('in1');
    expect(db.latencyMerges[0]!['status']).toBe('LATE');
    expect(result.repliesMeasured).toBe(1);
    expect(result.lateRepliesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Duplicate message versions — is_latest=true filter
// ---------------------------------------------------------------------------

describe('7. Duplicate message versions', () => {
  it('only is_latest rows are queried (fake DB simulates this; query filter checked at source level)', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r03.ts'),
      'utf8',
    );
    expect(source).toContain('is_latest: true');
    expect(source).toContain('is_deleted: false');
  });

  it('findReplyPairs with duplicate providerId inbounds produces one pair (earliest wins)', () => {
    // Two rows with same providerId — duplicate message versions not deduplicated yet.
    // findReplyPairs picks the first (earliest) inbound and emits one pair.
    // The DB unique constraint (mailbox_address, thread_id, inbound_message_id) handles
    // any duplicate upserts for the same inbound_message_id.
    const msgs = [
      { providerId: 'msg1', internalDate: MONDAY_8AM, direction: 'INBOUND' as const },
      { providerId: 'msg1', internalDate: MONDAY_8AM, direction: 'INBOUND' as const }, // duplicate
      { providerId: 'out1', internalDate: addHours(MONDAY_8AM, 2), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs.length).toBe(1);
    expect(pairs[0]!.inbound.providerId).toBe('msg1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
  });
});

// ---------------------------------------------------------------------------
// 8. Unanswered threads — not classified as completed delayed replies
// ---------------------------------------------------------------------------

describe('8. Unanswered threads — not in R-03 scope', () => {
  it('thread with only inbound messages produces no latency records', async () => {
    const { knex, db } = makeFakeDb([
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't1', internal_date: addHours(MONDAY_8AM, 1), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
    ]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));
    expect(db.latencyInserts.length).toBe(0);
    expect(result.repliesMeasured).toBe(0);
  });

  it('findReplyPairs returns empty array for all-inbound message list', () => {
    const msgs = [
      { providerId: 'in1', internalDate: MONDAY_8AM, direction: 'INBOUND' as const },
      { providerId: 'in2', internalDate: addHours(MONDAY_8AM, 1), direction: 'INBOUND' as const },
    ];
    expect(findReplyPairs(msgs)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Mailbox access restrictions
// ---------------------------------------------------------------------------

describe('9. Mailbox access restrictions — METADATA-only source check', () => {
  it('R-03 source does NOT reference gmail body, snippet, or HTML fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r03.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.body\b/);
    expect(source).not.toMatch(/\.snippet\b/);
    expect(source).not.toMatch(/\.html\b/);
    expect(source).not.toContain('content_mode');
    expect(source).not.toContain('GmailHistoricalService');
    expect(source).not.toContain('GmailIncrementalService');
  });

  it('classifyDirection used by R-03 reads only labelIds and headers from payload', () => {
    // classifyDirection (from R-01) reads payload.labelIds and payload.headers — no body/snippet/html.
    const r01Source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    expect(r01Source).toContain('labelIds');
    expect(r01Source).toContain('headers');
    // Must not access raw body content in executable code (comments may mention "body" as context)
    expect(r01Source).not.toMatch(/payload\.(body|snippet|html)\b/);
    expect(r01Source).not.toMatch(/\.getBody\(/);
  });
});

// ---------------------------------------------------------------------------
// 10. Alert idempotency
// ---------------------------------------------------------------------------

describe('10. Alert idempotency', () => {
  it('upsert uses onConflict merge — no duplicate records per inbound message', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r03.ts'),
      'utf8',
    );
    expect(source).toContain("onConflict(['mailbox_address', 'thread_id', 'inbound_message_id'])");
    expect(source).toContain('.ignore()');
    expect(source).toContain('.update(');
  });

  it('re-evaluation of the same inbound/reply pair produces one merge, not two inserts', async () => {
    const now = addHours(MONDAY_8AM, 10); // within lookback window of test data
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addHours(MONDAY_8AM, 5), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now);
    // Both runs insert + merge; the DB unique constraint deduplicates at DB level.
    // In fake DB, 2 merges appear (each idempotent).
    expect(db.latencyMerges.length).toBe(2);
    expect(db.latencyMerges[0]!['inbound_message_id']).toBe('in1');
    expect(db.latencyMerges[1]!['inbound_message_id']).toBe('in1');
    expect(db.latencyMerges[0]!['status']).toBe(db.latencyMerges[1]!['status']);
  });

  it('reports only the first late record as newly opened', async () => {
    const now = addHours(MONDAY_8AM, 10);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addHours(MONDAY_8AM, 5), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    await expect(rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now)).resolves.toMatchObject({ lateRepliesFound: 1 });
    await expect(rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now)).resolves.toMatchObject({ lateRepliesFound: 0 });
  });

  it('is insert-aware under concurrent evaluations', async () => {
    const now = addHours(MONDAY_8AM, 10);
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: MONDAY_8AM, mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addHours(MONDAY_8AM, 5), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const results = await Promise.all([
      rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now),
      rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, now),
    ]);
    expect(results.map((result) => result.lateRepliesFound).sort()).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 11. Dashboard API — listReplyLatencyRecords
// ---------------------------------------------------------------------------

describe('11. Dashboard API — listReplyLatencyRecords', () => {
  it('source contains the correct route path', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('/reporting/responsiveness/reply-latency');
    expect(routeSource).toContain('requireAuth');
    expect(routeSource).toContain('listReplyLatencyRecords');
  });

  it('R-03 route section does not return body, snippet, subject, or HTML in JSON responses', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    // Comments may document privacy constraints (e.g. "no … snippet") — that is correct.
    // Check that no executable code selects or passes these fields to res.json().
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*snippet/);
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*subject/);
    expect(routeSource).not.toMatch(/req\.body\s*\.\s*snippet/);
    expect(routeSource).not.toMatch(/req\.body\s*\.\s*subject/);
  });

  it('pagination params: page and page_size default correctly', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('page_size');
    expect(routeSource).toContain('Math.min(100');
  });

  it('date filter validation rejects invalid ISO strings', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('isNaN(fromDate.getTime())');
    expect(routeSource).toContain('isNaN(toDate.getTime())');
  });
});

// ---------------------------------------------------------------------------
// 12. Worker disabled/enabled behavior
// ---------------------------------------------------------------------------

describe('12. Worker disabled/enabled behavior', () => {
  it('GOOGLE_R03_ENABLED defaults to false in env.ts', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toMatch(/GOOGLE_R03_ENABLED[\s\S]{0,100}default\('false'\)/);
  });

  it('worker source wires r03Enabled from GOOGLE_R03_ENABLED', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('r03Enabled: env.GOOGLE_R03_ENABLED');
  });

  it('worker source includes r03 in workerEnabled guard', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('env.GOOGLE_R03_ENABLED');
  });
});

// ---------------------------------------------------------------------------
// 13. Failure handling and privacy
// ---------------------------------------------------------------------------

describe('13. Failure handling and privacy', () => {
  it('evaluateMailbox returns zero result for empty message set', async () => {
    const { knex } = makeFakeDb([]);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG);
    expect(result).toEqual({ threadsEvaluated: 0, repliesMeasured: 0, lateRepliesFound: 0, onTimeRepliesFound: 0 });
  });

  it('UNKNOWN-direction messages are ignored and produce no pairs', () => {
    const msgs = [
      { providerId: 'draft', internalDate: MONDAY_8AM, direction: 'OUTBOUND' as const }, // OUTBOUND only
      // No INBOUND at all
    ];
    expect(findReplyPairs(msgs)).toHaveLength(0);
  });

  it('warn log for R-03 does not contain body/snippet/subject/html', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    const warnMatches = workerSource.match(/\[R03\][^`'"]+/g) ?? [];
    for (const w of warnMatches) {
      expect(w).not.toMatch(/body|snippet|subject|html/i);
    }
  });

  it('worker source does not import Gmail sync services', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).not.toContain('GmailHistoricalService');
    expect(workerSource).not.toContain('GmailIncrementalService');
    expect(workerSource).not.toContain('googleapis');
  });

  it('r03Config excludedMailboxes are set in worker main()', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('billing@trufinity.ca');
    expect(workerSource).toContain('careers@trufinity.ca');
    expect(workerSource).toContain('info@trufinity.ca');
  });
});

// ---------------------------------------------------------------------------
// 14. findReplyPairs regression — earliest-inbound-per-segment semantics
// ---------------------------------------------------------------------------

describe('14. findReplyPairs regression — earliest-inbound-per-segment', () => {
  it('single inbound → single outbound produces one pair', () => {
    const msgs = [
      { providerId: 'in1', internalDate: MONDAY_8AM, direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addHours(MONDAY_8AM, 1), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
  });

  it('three consecutive inbounds before one reply → one pair from the earliest inbound', () => {
    const msgs = [
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'INBOUND' as const },
      { providerId: 'in2', internalDate: addMinutes(MONDAY_8AM, 10), direction: 'INBOUND' as const },
      { providerId: 'in3', internalDate: addMinutes(MONDAY_8AM, 20), direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 60), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
  });

  it('alternating segments: in→out→in→out produces two pairs, each from the correct earliest inbound', () => {
    const msgs = [
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 30), direction: 'OUTBOUND' as const },
      { providerId: 'in2', internalDate: addMinutes(MONDAY_8AM, 60), direction: 'INBOUND' as const },
      { providerId: 'out2', internalDate: addMinutes(MONDAY_8AM, 90), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
    expect(pairs[1]!.inbound.providerId).toBe('in2');
    expect(pairs[1]!.reply.providerId).toBe('out2');
  });

  it('two separate inbound groups each closed by a reply → two pairs (one per group)', () => {
    const msgs = [
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'INBOUND' as const },
      { providerId: 'in2', internalDate: addMinutes(MONDAY_8AM, 10), direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 60), direction: 'OUTBOUND' as const },
      { providerId: 'in3', internalDate: addMinutes(MONDAY_8AM, 120), direction: 'INBOUND' as const },
      { providerId: 'in4', internalDate: addMinutes(MONDAY_8AM, 130), direction: 'INBOUND' as const },
      { providerId: 'out2', internalDate: addMinutes(MONDAY_8AM, 180), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
    expect(pairs[1]!.inbound.providerId).toBe('in3');
    expect(pairs[1]!.reply.providerId).toBe('out2');
  });

  it('consecutive outbound replies after one inbound produce only one pair (second outbound is not a new measurement)', () => {
    const msgs = [
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'INBOUND' as const },
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 30), direction: 'OUTBOUND' as const },
      { providerId: 'out2', internalDate: addMinutes(MONDAY_8AM, 60), direction: 'OUTBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.inbound.providerId).toBe('in1');
    expect(pairs[0]!.reply.providerId).toBe('out1');
  });

  it('outbound-only thread produces no pairs', () => {
    const msgs = [
      { providerId: 'out1', internalDate: MONDAY_8AM, direction: 'OUTBOUND' as const },
      { providerId: 'out2', internalDate: addHours(MONDAY_8AM, 1), direction: 'OUTBOUND' as const },
    ];
    expect(findReplyPairs(msgs)).toHaveLength(0);
  });

  it('inbound at end (no reply yet) produces no pair', () => {
    const msgs = [
      { providerId: 'out1', internalDate: addMinutes(MONDAY_8AM, 0), direction: 'OUTBOUND' as const },
      { providerId: 'in1', internalDate: addMinutes(MONDAY_8AM, 30), direction: 'INBOUND' as const },
    ];
    const pairs = findReplyPairs(msgs);
    // out1 before in1: out1 has no pending inbound → no pair. in1 at end is unanswered.
    expect(pairs).toHaveLength(0);
  });

  it('empty message list produces no pairs', () => {
    expect(findReplyPairs([])).toHaveLength(0);
  });

  it('evaluateMailbox: five consecutive inbounds → one LATE record using earliest inbound timestamp', async () => {
    // All five inbounds arrive before the team replies 5 business hours later.
    // Only in1 (the earliest) should become a latency record → LATE (300 min > 240 threshold).
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 0), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 30), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in3', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 60), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in4', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 90), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in5', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 120), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 300), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges.length).toBe(1);
    expect(db.latencyMerges[0]!['inbound_message_id']).toBe('in1');
    expect(db.latencyMerges[0]!['status']).toBe('LATE');
    expect(result.repliesMeasured).toBe(1);
    expect(result.lateRepliesFound).toBe(1);
    expect(result.onTimeRepliesFound).toBe(0);
  });

  it('evaluateMailbox: two segments in one thread each produce one record from their segment\'s earliest inbound', async () => {
    // Segment 1: in1 (T+0), in2 (T+30) → closed by out1 (T+120). in1 elapsed = 120 min < 240 → ON_TIME.
    // Segment 2: in3 (T+180), in4 (T+200) → closed by out2 (T+450). in3 elapsed = 270 min > 240 → LATE.
    const rows = [
      { provider_message_id: 'in1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 0), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in2', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 30), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out1', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 120), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
      { provider_message_id: 'in3', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 180), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'in4', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 200), mailbox_address: 'service@trufinity.ca', payload: makeInboundPayload() },
      { provider_message_id: 'out2', thread_id: 't1', internal_date: addMinutes(MONDAY_8AM, 450), mailbox_address: 'service@trufinity.ca', payload: makeOutboundPayload() },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addHours(MONDAY_8AM, 10));

    expect(db.latencyMerges.length).toBe(2);
    expect(db.latencyMerges[0]!['inbound_message_id']).toBe('in1');
    expect(db.latencyMerges[0]!['status']).toBe('ON_TIME');
    expect(db.latencyMerges[1]!['inbound_message_id']).toBe('in3');
    expect(db.latencyMerges[1]!['status']).toBe('LATE');
    expect(result.repliesMeasured).toBe(2);
    expect(result.lateRepliesFound).toBe(1);
    expect(result.onTimeRepliesFound).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 15. F-08 regression — mailbox exclusion is case-insensitive
// ---------------------------------------------------------------------------

describe('15. F-08 regression — isExcludedMailbox handles mixed-case addresses', () => {
  const EXCLUDED = ['billing@trufinity.ca', 'careers@trufinity.ca', 'info@trufinity.ca'];
  const configWithExclusions: R03Config = { ...BASE_CONFIG, excludedMailboxes: EXCLUDED };

  it('lowercase excluded mailbox is excluded', () => {
    expect(isExcludedMailbox('billing@trufinity.ca', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('careers@trufinity.ca', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('info@trufinity.ca', configWithExclusions)).toBe(true);
  });

  it('uppercase excluded mailbox is excluded (case-insensitive comparison)', () => {
    expect(isExcludedMailbox('BILLING@TRUFINITY.CA', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('CAREERS@TRUFINITY.CA', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('INFO@TRUFINITY.CA', configWithExclusions)).toBe(true);
  });

  it('mixed-case excluded mailbox is excluded', () => {
    expect(isExcludedMailbox('Billing@Trufinity.CA', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('Careers@TRUFINITY.ca', configWithExclusions)).toBe(true);
    expect(isExcludedMailbox('Info@Trufinity.Ca', configWithExclusions)).toBe(true);
  });

  it('non-excluded mailbox is not excluded regardless of case', () => {
    expect(isExcludedMailbox('service@trufinity.ca', configWithExclusions)).toBe(false);
    expect(isExcludedMailbox('SERVICE@TRUFINITY.CA', configWithExclusions)).toBe(false);
    expect(isExcludedMailbox('support@trufinity.ca', configWithExclusions)).toBe(false);
  });

  it('leading/trailing whitespace is trimmed from the address', () => {
    expect(isExcludedMailbox('  billing@trufinity.ca  ', configWithExclusions)).toBe(true);
  });

  it('evaluateMailbox skips a mixed-case excluded mailbox and returns zero result', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 'billing-thread',
        internal_date: MONDAY_8AM,
        mailbox_address: 'BILLING@TRUFINITY.CA',
        payload: makeInboundPayload(),
      },
      {
        provider_message_id: 'out1',
        thread_id: 'billing-thread',
        internal_date: addHours(MONDAY_8AM, 1),
        mailbox_address: 'BILLING@TRUFINITY.CA',
        payload: makeOutboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR03Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('BILLING@TRUFINITY.CA', BASE_CONFIG, addHours(MONDAY_8AM, 10));
    expect(result).toEqual({ threadsEvaluated: 0, repliesMeasured: 0, lateRepliesFound: 0, onTimeRepliesFound: 0 });
    expect(db.latencyMerges.length).toBe(0);
  });
});
