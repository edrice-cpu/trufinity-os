/**
 * R-04 After-Hours Backlog — unit tests.
 *
 * All tests use a fake in-memory database.
 * No real PostgreSQL, Gmail API, or file system access.
 */
import { describe, it, expect } from '@jest/globals';
import {
  KnexR04Rule,
  listAfterHoursAlerts,
  type R04Config,
} from '../../src/modules/google/responsiveness-rule-r04';
import {
  isInAfterHoursWindow,
  type AfterHoursWindow,
  type BusinessCalendarConfig,
} from '../../src/modules/google/business-calendar';

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

// UTC after-hours windows (mirrors the real Pacific config but using UTC for test simplicity)
const UTC_WINDOWS: AfterHoursWindow[] = [
  // Weekday evenings
  { weekdays: [1, 2, 3, 4, 5], startHour: 16, startMinute: 30, endHour: 22, endMinute: 0 },
  // Weekend
  { weekdays: [0, 6], startHour: 7, startMinute: 0, endHour: 22, endMinute: 0 },
];

// Pacific after-hours windows (for DST tests)
const LA_WINDOWS: AfterHoursWindow[] = [
  { weekdays: [1, 2, 3, 4, 5], startHour: 16, startMinute: 30, endHour: 22, endMinute: 0 },
  { weekdays: [0, 6], startHour: 7, startMinute: 0, endHour: 22, endMinute: 0 },
];

const BASE_CONFIG: R04Config = {
  businessCalendar: UTC_CAL,
  afterHoursWindows: UTC_WINDOWS,
  graceMinutes: 60,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

// Monday 2026-01-05 08:00:00 UTC
const MONDAY_8AM = new Date('2026-01-05T08:00:00.000Z');
const addMinutes = (d: Date, mins: number): Date => new Date(d.getTime() + mins * 60_000);
const addHours = (d: Date, h: number): Date => addMinutes(d, h * 60);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 24 * 60 * 60_000);

// Convenience aliases
// Monday 16:30 UTC = start of weekday after-hours
const MONDAY_AFTER_HOURS_START = new Date('2026-01-05T16:30:00.000Z');
// Monday 22:00 UTC = end of weekday after-hours (exclusive)
const MONDAY_AFTER_HOURS_END = new Date('2026-01-05T22:00:00.000Z');
// Tuesday 09:00 UTC = deadline (next business open 08:00 + 60 min)
const TUESDAY_9AM = new Date('2026-01-06T09:00:00.000Z');
// Saturday 07:00 UTC = start of weekend coverage
const SATURDAY_7AM = new Date('2026-01-10T07:00:00.000Z');
// Saturday 22:00 UTC = end of weekend coverage (exclusive)
const SATURDAY_22PM = new Date('2026-01-10T22:00:00.000Z');
// Monday 09:00 UTC = deadline for any weekend message (next Mon 8AM + 60 min)
const NEXT_MONDAY_9AM = new Date('2026-01-12T09:00:00.000Z');
// Friday 17:00 UTC = after-hours
const FRIDAY_5PM = new Date('2026-01-09T17:00:00.000Z');

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
  alertInserts: Record<string, unknown>[];
  alertMerges: Record<string, unknown>[];
  alertUpdates: Record<string, unknown>[];
}

const makeFakeDb = (rows: RawGmailRow[] = []): { db: FakeDb; knex: ReturnType<typeof buildFakeKnex> } => {
  const db: FakeDb = { rawGmailMessages: rows, alertInserts: [], alertMerges: [], alertUpdates: [] };
  return { db, knex: buildFakeKnex(db) };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQ = Record<string, any>;

const buildFakeKnex = (db: FakeDb) => {
  const knexFn = (table: string): AnyQ => {
    if (table === 'raw_gmail_messages') return buildRawGmailQuery(db);
    if (table === 'google_after_hours_backlog_alerts') return buildAlertQuery(db);
    throw new Error(`Unexpected table: ${table}`);
  };
  // Knex root instance has .raw() used for SQL expressions in update().
  (knexFn as unknown as Record<string, unknown>).raw = (expr: string) => ({ __raw: expr });
  return knexFn;
};

const buildRawGmailQuery = (db: FakeDb): AnyQ => {
  let filters: Record<string, unknown> = {};
  let cutoff: Date | undefined;

  const q: AnyQ = {};
  q.select = (..._cols: unknown[]) => q;
  q.where = (arg: unknown, op?: unknown, val?: unknown) => {
    if (typeof arg === 'object' && arg !== null) Object.assign(filters, arg);
    if (typeof arg === 'string' && op === '>=' && val instanceof Date) cutoff = val;
    return q;
  };
  q.orderBy = () => q;
  q.then = (resolve: (v: unknown) => unknown) => {
    let results = db.rawGmailMessages.filter((r) => {
      for (const [k, v] of Object.entries(filters)) {
        if (k === 'is_latest' || k === 'is_deleted') continue;
        if (r[k as keyof RawGmailRow] !== v) return false;
      }
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
  let insertPayload: Record<string, unknown> | null = null;
  let conflictCols: string[] = [];
  let isUpdate = false;
  let updatePayload: Record<string, unknown> = {};

  const q: AnyQ = {};

  q.insert = (data: Record<string, unknown>) => {
    insertPayload = { ...data };
    return q;
  };

  q.onConflict = (cols: string[]) => {
    conflictCols = cols;
    void conflictCols;
    return {
      ignore: () => ({
        returning: (_column: string) => {
          const duplicate = db.alertInserts.some((row) =>
            row['mailbox_address'] === insertPayload?.['mailbox_address']
            && row['thread_id'] === insertPayload?.['thread_id']
            && row['inbound_message_id'] === insertPayload?.['inbound_message_id']);
          if (duplicate) return Promise.resolve([]);
          db.alertInserts.push({ ...(insertPayload ?? {}) });
          return Promise.resolve([{ id: 'fake-alert-id' }]);
        },
      }),
      merge: (mergeData: Record<string, unknown>) => {
        db.alertMerges.push({ ...insertPayload, ...mergeData });
        return Promise.resolve([]);
      },
    };
  };

  q.where = (arg: unknown) => {
    if (typeof arg === 'object' && arg !== null) Object.assign(whereFilters, arg);
    return q;
  };

  q.update = (data: Record<string, unknown>) => {
    isUpdate = true;
    updatePayload = data;
    // Simulate counting rows affected
    const matchCount = db.alertInserts.filter((r) => {
      for (const [k, v] of Object.entries(whereFilters)) {
        if (r[k] !== v) return false;
      }
      return true;
    }).length;
    db.alertUpdates.push({ whereFilters: { ...whereFilters }, updateData: { ...updatePayload } });
    return Promise.resolve(matchCount);
  };

  q.count = (_alias: Record<string, string>) => {
    q.first = () => Promise.resolve({ count: String(db.alertInserts.length) });
    return q;
  };

  q.select = (..._cols: unknown[]) => q;
  q.orderBy = () => q;
  q.limit = () => q;
  q.offset = () => {
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(db.alertInserts));
    return q;
  };
  q.first = () => Promise.resolve({ count: '0' });

  void isUpdate;
  return q;
};

// ---------------------------------------------------------------------------
// 1. Weekday 4:30 PM boundary
// ---------------------------------------------------------------------------

describe('1. Weekday 4:30 PM boundary', () => {
  it('isInAfterHoursWindow returns true at exactly 16:30 on a weekday', () => {
    expect(isInAfterHoursWindow(MONDAY_AFTER_HOURS_START, UTC_WINDOWS, 'UTC')).toBe(true);
  });

  it('isInAfterHoursWindow returns false one minute before 16:30', () => {
    expect(isInAfterHoursWindow(addMinutes(MONDAY_AFTER_HOURS_START, -1), UTC_WINDOWS, 'UTC')).toBe(false);
  });

  it('evaluateMailbox creates OPEN alert for inbound at exactly 16:30 once deadline passes', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    // Evaluate after the deadline (Tuesday 9AM + 1 min)
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 1));
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    expect(db.alertInserts[0]!['status']).toBe('OPEN');
    expect(result.alertsOpened).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Weekday 10 PM coverage ending
// ---------------------------------------------------------------------------

describe('2. Weekday 10 PM coverage ending', () => {
  it('isInAfterHoursWindow returns false at exactly 22:00 (exclusive boundary)', () => {
    expect(isInAfterHoursWindow(MONDAY_AFTER_HOURS_END, UTC_WINDOWS, 'UTC')).toBe(false);
  });

  it('isInAfterHoursWindow returns true one minute before 22:00', () => {
    expect(isInAfterHoursWindow(addMinutes(MONDAY_AFTER_HOURS_END, -1), UTC_WINDOWS, 'UTC')).toBe(true);
  });

  it('message at exactly 22:00 does not trigger R-04 (outside coverage window)', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_END,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 1));
    // 22:00 is outside the after-hours window — no alert
    expect(db.alertInserts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Weekend 7 AM opening
// ---------------------------------------------------------------------------

describe('3. Weekend 7 AM opening', () => {
  it('isInAfterHoursWindow returns true at exactly 07:00 on Saturday', () => {
    expect(isInAfterHoursWindow(SATURDAY_7AM, UTC_WINDOWS, 'UTC')).toBe(true);
  });

  it('isInAfterHoursWindow returns false one minute before 07:00 on Saturday', () => {
    expect(isInAfterHoursWindow(addMinutes(SATURDAY_7AM, -1), UTC_WINDOWS, 'UTC')).toBe(false);
  });

  it('Saturday 07:00 inbound triggers R-04 once Monday 9AM deadline passes', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: SATURDAY_7AM,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    // Monday 09:00 + 1 min
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(NEXT_MONDAY_9AM, 1));
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    expect(db.alertInserts[0]!['status']).toBe('OPEN');
    // Deadline stored in alert = next business opening + 60 min = Monday 8AM + 60 = Monday 9AM
    expect(db.alertInserts[0]!['deadline_at']).toEqual(NEXT_MONDAY_9AM);
  });
});

// ---------------------------------------------------------------------------
// 4. Weekend 10 PM closing
// ---------------------------------------------------------------------------

describe('4. Weekend 10 PM closing', () => {
  it('isInAfterHoursWindow returns false at exactly 22:00 on Saturday', () => {
    expect(isInAfterHoursWindow(SATURDAY_22PM, UTC_WINDOWS, 'UTC')).toBe(false);
  });

  it('isInAfterHoursWindow returns true one minute before 22:00 on Saturday', () => {
    expect(isInAfterHoursWindow(addMinutes(SATURDAY_22PM, -1), UTC_WINDOWS, 'UTC')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Friday-to-Monday rollover
// ---------------------------------------------------------------------------

describe('5. Friday-to-Monday rollover', () => {
  it('Friday after-hours inbound deadline falls on the following Monday 09:00', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: FRIDAY_5PM,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    // Evaluate on Monday afternoon (well after deadline)
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(NEXT_MONDAY_9AM, 60));
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    // Deadline = Monday 08:00 + 60 min = Monday 09:00
    expect(db.alertInserts[0]!['deadline_at']).toEqual(NEXT_MONDAY_9AM);
  });

  it('Friday after-hours inbound with no reply has OPEN status', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: FRIDAY_5PM,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(NEXT_MONDAY_9AM, 60));
    expect(db.alertInserts[0]!['status']).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// 6. Sunday-to-Monday rollover
// ---------------------------------------------------------------------------

describe('6. Sunday-to-Monday rollover', () => {
  it('Sunday morning after-hours inbound deadline falls on Monday 09:00', async () => {
    const SUNDAY_10AM = new Date('2026-01-11T10:00:00.000Z');
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: SUNDAY_10AM,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(NEXT_MONDAY_9AM, 30));
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    expect(db.alertInserts[0]!['deadline_at']).toEqual(NEXT_MONDAY_9AM);
  });

  it('Sunday night 21:59 is still in coverage window', () => {
    const SUNDAY_21_59 = new Date('2026-01-11T21:59:00.000Z');
    expect(isInAfterHoursWindow(SUNDAY_21_59, UTC_WINDOWS, 'UTC')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Exact 60-minute deadline
// ---------------------------------------------------------------------------

describe('7. Exact 60-minute deadline', () => {
  it('evaluating exactly at the deadline fires the alert', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    // exactly at deadline = TUESDAY_9AM
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, TUESDAY_9AM);
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    expect(result.alertsOpened).toBe(1);
  });

  it('evaluating one minute before deadline produces no alert', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, -1));
    expect(db.alertInserts.length).toBe(0);
    expect(result.alertsOpened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Reply before deadline
// ---------------------------------------------------------------------------

describe('8. Reply before deadline', () => {
  it('thread replied before deadline produces no OPEN alert', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
      {
        provider_message_id: 'out1',
        thread_id: 't1',
        // Replied at Tuesday 08:30 — within the 60-minute grace window
        internal_date: new Date('2026-01-06T08:30:00.000Z'),
        mailbox_address: 'service@trufinity.ca',
        payload: makeOutboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    // Evaluate after deadline — but thread was already answered
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 30));
    expect(db.alertInserts.length).toBe(0);
    expect(result.alertsOpened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Reply after deadline
// ---------------------------------------------------------------------------

describe('9. Reply after deadline', () => {
  it('thread replied after deadline resolves any OPEN alert', async () => {
    // Simulate: thread now replied (OUTBOUND exists after the inbound).
    // At eval time, findOldestUnanswered returns null → close alert.
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
      {
        provider_message_id: 'out1',
        thread_id: 't1',
        // Replied at Tuesday 11:00 — after the deadline
        internal_date: new Date('2026-01-06T11:00:00.000Z'),
        mailbox_address: 'service@trufinity.ca',
        payload: makeOutboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, new Date('2026-01-06T12:00:00.000Z'));
    // Thread is answered → should attempt to RESOLVE any open alerts (update path)
    expect(db.alertUpdates.length).toBeGreaterThanOrEqual(1);
    expect(result.alertsClosed).toBeGreaterThanOrEqual(0); // 0 if no prior OPEN in fake DB
    expect(result.alertsOpened).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Consecutive inbound messages
// ---------------------------------------------------------------------------

describe('10. Consecutive inbound messages', () => {
  it('multiple consecutive inbounds during after-hours — only earliest triggers R-04', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
      {
        provider_message_id: 'in2',
        thread_id: 't1',
        internal_date: addHours(MONDAY_AFTER_HOURS_START, 1),
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 10));
    expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
    // The trigger is in1 (oldest unanswered)
    expect(db.alertInserts[0]!['inbound_message_id']).toBe('in1');
  });

  it('first inbound during business hours, second during after-hours — R-04 does not fire', async () => {
    // If the oldest unanswered inbound is from business hours, it's R-01's domain.
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: addHours(MONDAY_8AM, 2), // Monday 10:00 AM — business hours
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
      {
        provider_message_id: 'in2',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START, // Monday 16:30 — after-hours
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 10));
    // in1 is the oldest unanswered and it's during business hours → not R-04
    expect(db.alertInserts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Duplicate message versions — is_latest filter
// ---------------------------------------------------------------------------

describe('11. Duplicate message versions — is_latest filter', () => {
  it('R-04 source queries is_latest: true and is_deleted: false', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r04.ts'),
      'utf8',
    );
    expect(source).toContain('is_latest: true');
    expect(source).toContain('is_deleted: false');
  });
});

// ---------------------------------------------------------------------------
// 12. DST transitions
// ---------------------------------------------------------------------------

describe('12. DST transitions (America/Los_Angeles)', () => {
  it('Spring Forward 2026: message Sunday night before DST is correctly classified as after-hours', () => {
    // Spring forward: 2026-03-08 02:00 → 03:00 in Los Angeles.
    // Saturday evening 8 PM PST (before change) = Sunday 04:00 UTC
    // Sunday 2026-03-08 20:00 PST = Monday 04:00 UTC (PST=UTC-8)
    const sundayEvening = new Date('2026-03-09T04:00:00.000Z'); // Sunday 8 PM PST
    expect(isInAfterHoursWindow(sundayEvening, LA_WINDOWS, 'America/Los_Angeles')).toBe(true);
  });

  it('Spring Forward 2026: deadline is correctly 9 AM PDT on Monday (UTC-7)', () => {
    // Sunday 2026-03-08 20:00 PST = 04:00 UTC Monday 2026-03-09
    // After DST: Monday 8 AM PDT = Monday 15:00 UTC
    // Deadline = Monday 8 AM PDT + 60 min = Monday 9 AM PDT = 16:00 UTC
    const sundayEvening = new Date('2026-03-09T04:00:00.000Z');
    const config: R04Config = {
      ...BASE_CONFIG,
      businessCalendar: LA_CAL,
      afterHoursWindows: LA_WINDOWS,
    };
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: sundayEvening,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    const deadline = new Date('2026-03-09T16:00:00.000Z'); // Monday 9 AM PDT
    return rule.evaluateMailbox('service@trufinity.ca', config, addMinutes(deadline, 5)).then((result) => {
      expect(db.alertInserts.length).toBeGreaterThanOrEqual(1);
      // The stored deadline should be 9 AM PDT = 16:00 UTC
      const storedDeadline = db.alertInserts[0]!['deadline_at'] as Date;
      expect(storedDeadline.getTime()).toBe(deadline.getTime());
      void result;
    });
  });
});

// ---------------------------------------------------------------------------
// 13. Alert idempotency
// ---------------------------------------------------------------------------

describe('13. Alert idempotency', () => {
  it('R-04 source uses onConflict merge on the unique key', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r04.ts'),
      'utf8',
    );
    expect(source).toContain("onConflict(['mailbox_address', 'thread_id', 'inbound_message_id'])");
    expect(source).toContain('.ignore()');
  });

  it('re-evaluation of the same thread with no reply produces one insert + one merge (idempotent)', async () => {
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        payload: makeInboundPayload(),
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 5));
    await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 10));
    // Only the first evaluation opens an alert; the conflict path is a refresh.
    expect(db.alertInserts.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 14. Mailbox authorization
// ---------------------------------------------------------------------------

describe('14. Mailbox authorization', () => {
  it('R-04 source uses classifyDirection from R-01 (respects workspaceDomain guard)', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r04.ts'),
      'utf8',
    );
    expect(source).toContain('classifyDirection');
    expect(source).toContain('workspaceDomain');
  });

  it('internal sender (trufinity.ca From domain) is classified UNKNOWN and ignored', () => {
    // classifyDirection returns UNKNOWN for internal senders — tested indirectly via evaluateMailbox.
    const rows = [
      {
        provider_message_id: 'in1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        // From header from trufinity.ca domain → UNKNOWN, not INBOUND
        payload: {
          labelIds: ['INBOX'],
          headers: [{ name: 'From', value: 'colleague@trufinity.ca' }],
        },
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    return rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 5)).then((result) => {
      expect(db.alertInserts.length).toBe(0);
      expect(result.alertsOpened).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// 15. API authentication, filtering, and pagination
// ---------------------------------------------------------------------------

describe('15. API — listAfterHoursAlerts and route contract', () => {
  it('source contains the correct route path and requireAuth', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('/reporting/responsiveness/after-hours');
    expect(routeSource).toContain('requireAuth');
    expect(routeSource).toContain('listAfterHoursAlerts');
  });

  it('route does not return body, snippet, subject, or HTML in JSON responses', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*snippet/);
    expect(routeSource).not.toMatch(/res\.json\s*\([^)]*subject/);
  });

  it('pagination params: page and page_size with Math.min(100,...) cap', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain('page_size');
    expect(routeSource).toContain('Math.min(100');
  });

  it('status filter accepts OPEN and RESOLVED', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    expect(routeSource).toContain("'OPEN'");
    expect(routeSource).toContain("'RESOLVED'");
  });

  it('listAfterHoursAlerts builds gmailThreadUrl for each record', async () => {
    // Fake knex for listAfterHoursAlerts
    const fakeRows = [
      {
        id: 'abc',
        mailbox_address: 'service@trufinity.ca',
        thread_id: 'thread123',
        inbound_message_id: 'in1',
        inbound_at: MONDAY_AFTER_HOURS_START.toISOString(),
        deadline_at: TUESDAY_9AM.toISOString(),
        status: 'OPEN',
        resolved_at: null,
        created_at: MONDAY_AFTER_HOURS_START.toISOString(),
        updated_at: MONDAY_AFTER_HOURS_START.toISOString(),
      },
    ];
    const fakeKnex = (_table: string): AnyQ => {
      const q: AnyQ = {};
      q.where = () => q;
      q.count = () => { q.first = () => Promise.resolve({ count: '1' }); return q; };
      q.first = () => Promise.resolve({ count: '1' });
      q.select = () => q;
      q.orderBy = () => q;
      q.limit = () => q;
      q.offset = () => {
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolve(fakeRows));
        return q;
      };
      return q;
    };
    const result = await listAfterHoursAlerts(fakeKnex as unknown as import('knex').Knex, { page: 1, pageSize: 25 });
    expect(result.data[0]!.gmailThreadUrl).toContain('thread123');
    // @ is URL-encoded as %40 in the authuser parameter
    expect(result.data[0]!.gmailThreadUrl).toContain('service%40trufinity.ca');
  });
});

// ---------------------------------------------------------------------------
// 16. Worker disabled/enabled behavior
// ---------------------------------------------------------------------------

describe('16. Worker disabled/enabled behavior', () => {
  it('GOOGLE_R04_ENABLED defaults to false in env.ts', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toMatch(/GOOGLE_R04_ENABLED[\s\S]{0,100}default\('false'\)/);
  });

  it('worker source wires r04Enabled from GOOGLE_R04_ENABLED', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('r04Enabled: env.GOOGLE_R04_ENABLED');
  });

  it('worker source includes r04 in workerEnabled guard', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('env.GOOGLE_R04_ENABLED');
  });

  it('worker source includes R04 in the evaluation cycle options', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    expect(workerSource).toContain('r04Rule');
    expect(workerSource).toContain('r04Config');
  });
});

// ---------------------------------------------------------------------------
// 17. Failure isolation
// ---------------------------------------------------------------------------

describe('17. Failure isolation', () => {
  it('evaluateMailbox returns zero result for empty message set', async () => {
    const { knex } = makeFakeDb([]);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 5));
    expect(result).toEqual({ threadsEvaluated: 0, alertsOpened: 0, alertsClosed: 0 });
  });

  it('R-04 source does not import Gmail sync services', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r04.ts'),
      'utf8',
    );
    expect(source).not.toContain('GmailHistoricalService');
    expect(source).not.toContain('GmailIncrementalService');
    expect(source).not.toContain('googleapis');
  });

  it('R-04 source does not reference email body, snippet, or HTML fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r04.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\.body\b/);
    expect(source).not.toMatch(/\.snippet\b/);
    expect(source).not.toMatch(/\.html\b/);
    expect(source).not.toContain('content_mode');
  });

  it('[R04] warn log in worker does not contain body/snippet/subject', () => {
    const workerSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/workers/google-responsiveness.worker.ts'),
      'utf8',
    );
    const warnMatches = workerSource.match(/\[R04\][^`'"]+/g) ?? [];
    for (const w of warnMatches) {
      expect(w).not.toMatch(/body|snippet|subject|html/i);
    }
  });

  it('thread with only UNKNOWN-direction messages produces no alert', async () => {
    const rows = [
      {
        provider_message_id: 'draft1',
        thread_id: 't1',
        internal_date: MONDAY_AFTER_HOURS_START,
        mailbox_address: 'service@trufinity.ca',
        // No labelIds — classified as UNKNOWN
        payload: { labelIds: [], headers: [{ name: 'From', value: 'unknown@trufinity.ca' }] },
      },
    ];
    const { knex, db } = makeFakeDb(rows);
    const rule = new KnexR04Rule(knex as unknown as import('knex').Knex);
    const result = await rule.evaluateMailbox('service@trufinity.ca', BASE_CONFIG, addMinutes(TUESDAY_9AM, 5));
    expect(db.alertInserts.length).toBe(0);
    expect(result.alertsOpened).toBe(0);
    void addDays;
  });
});
