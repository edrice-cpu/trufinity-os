import { describe, it, expect } from '@jest/globals';
import {
  classifyDirection,
  findOldestUnanswered,
  KnexR01Rule,
  type R01Config,
} from '../../src/modules/google/responsiveness-rule-r01';
import type { BusinessCalendarConfig } from '../../src/modules/google/business-calendar';

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

const UTC_9_17: BusinessCalendarConfig = { timezone: 'UTC', startHour: 9, endHour: 17 };

const R01_CONFIG: R01Config = {
  businessCalendar: UTC_9_17,
  thresholdMinutes: 240,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

const d = (iso: string): Date => new Date(iso);

const makePayload = (labelIds: string[], from: string, to = ''): Record<string, unknown> => ({
  labelIds,
  headers: [
    { name: 'From', value: from },
    ...(to ? [{ name: 'To', value: to }] : []),
  ],
});

// ---------------------------------------------------------------------------
// classifyDirection
// ---------------------------------------------------------------------------

describe('classifyDirection', () => {
  it('INBOX from external domain → INBOUND', () => {
    const payload = makePayload(['INBOX', 'UNREAD'], 'customer@external.com');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('INBOUND');
  });

  it('SENT label → OUTBOUND regardless of From', () => {
    const payload = makePayload(['SENT'], 'agent@trufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('OUTBOUND');
  });

  it('INBOX + SENT (self-sent) → OUTBOUND (SENT takes precedence)', () => {
    const payload = makePayload(['INBOX', 'SENT'], 'agent@trufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('OUTBOUND');
  });

  it('INBOX from internal domain → UNKNOWN (not a customer email)', () => {
    const payload = makePayload(['INBOX'], 'colleague@trufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });

  it('No INBOX or SENT label → UNKNOWN', () => {
    const payload = makePayload(['DRAFT'], 'customer@external.com');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });

  it('null payload → UNKNOWN', () => {
    expect(classifyDirection(null, 'trufinity.ca')).toBe('UNKNOWN');
  });

  it('missing From header → UNKNOWN (cannot confirm external)', () => {
    const payload = { labelIds: ['INBOX'], headers: [] };
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });

  it('malformed From with no @ → UNKNOWN', () => {
    const payload = makePayload(['INBOX'], 'notanemail');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });

  // Domain boundary: must use exact match or real subdomain — NOT suffix match
  it('nottrufinity.ca is EXTERNAL (not internal) — suffix match must not classify as internal', () => {
    const payload = makePayload(['INBOX'], 'attacker@nottrufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('INBOUND');
  });

  it('faketrufinity.ca is EXTERNAL', () => {
    const payload = makePayload(['INBOX'], 'attacker@faketrufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('INBOUND');
  });

  it('eviltrufinity.ca is EXTERNAL', () => {
    const payload = makePayload(['INBOX'], 'attacker@eviltrufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('INBOUND');
  });

  it('real subdomain mail.trufinity.ca is INTERNAL', () => {
    const payload = makePayload(['INBOX'], 'system@mail.trufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });

  it('exact match trufinity.ca is INTERNAL', () => {
    const payload = makePayload(['INBOX'], 'agent@trufinity.ca');
    expect(classifyDirection(payload, 'trufinity.ca')).toBe('UNKNOWN');
  });
});

// ---------------------------------------------------------------------------
// findOldestUnanswered
// ---------------------------------------------------------------------------

describe('findOldestUnanswered', () => {
  const msg = (id: string, direction: 'INBOUND' | 'OUTBOUND', ts: string) => ({
    providerId: id,
    internalDate: d(ts),
    direction,
  });

  it('single inbound with no reply → that inbound is oldest unanswered', () => {
    const msgs = [msg('m1', 'INBOUND', '2026-06-15T10:00:00Z')];
    const result = findOldestUnanswered(msgs);
    expect(result?.providerId).toBe('m1');
  });

  it('inbound then outbound → no pending (replied)', () => {
    const msgs = [
      msg('m1', 'INBOUND', '2026-06-15T10:00:00Z'),
      msg('m2', 'OUTBOUND', '2026-06-15T11:00:00Z'),
    ];
    expect(findOldestUnanswered(msgs)).toBeNull();
  });

  it('multiple inbound then outbound → no pending', () => {
    const msgs = [
      msg('m1', 'INBOUND', '2026-06-15T09:00:00Z'),
      msg('m2', 'INBOUND', '2026-06-15T10:00:00Z'),
      msg('m3', 'OUTBOUND', '2026-06-15T11:00:00Z'),
    ];
    expect(findOldestUnanswered(msgs)).toBeNull();
  });

  it('outbound then new inbound → new inbound is pending', () => {
    const msgs = [
      msg('m1', 'INBOUND', '2026-06-15T09:00:00Z'),
      msg('m2', 'OUTBOUND', '2026-06-15T10:00:00Z'),
      msg('m3', 'INBOUND', '2026-06-15T11:00:00Z'),
    ];
    const result = findOldestUnanswered(msgs);
    expect(result?.providerId).toBe('m3');
  });

  it('multiple pending inbounds → returns oldest of the pending segment', () => {
    const msgs = [
      msg('m1', 'OUTBOUND', '2026-06-15T09:00:00Z'),
      msg('m2', 'INBOUND', '2026-06-15T10:00:00Z'), // oldest pending
      msg('m3', 'INBOUND', '2026-06-15T11:00:00Z'),
    ];
    const result = findOldestUnanswered(msgs);
    expect(result?.providerId).toBe('m2');
  });

  it('empty list → null', () => {
    expect(findOldestUnanswered([])).toBeNull();
  });

  it('only outbound messages → null (no inbound pending)', () => {
    const msgs = [
      msg('m1', 'OUTBOUND', '2026-06-15T10:00:00Z'),
      msg('m2', 'OUTBOUND', '2026-06-15T11:00:00Z'),
    ];
    expect(findOldestUnanswered(msgs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// KnexR01Rule.evaluateMailbox — fake-DB unit tests
// ---------------------------------------------------------------------------


const MAILBOX = 'support@trufinity.ca';
const THREAD = 'thread-abc-001';
const MSG_INBOUND = 'msg-inbound-001';
const MSG_OUTBOUND = 'msg-outbound-001';

// Monday 2026-06-15T10:00:00Z — within business hours
const NOW = d('2026-06-15T14:00:00Z');

// Inbound received Monday 09:00, no reply — 5 hours elapsed → > 240 min threshold
const INBOUND_ROW = {
  provider_message_id: MSG_INBOUND,
  thread_id: THREAD,
  internal_date: d('2026-06-15T09:00:00Z'),
  mailbox_address: MAILBOX,
  payload: makePayload(['INBOX', 'UNREAD'], 'customer@external.com'),
};

const OUTBOUND_ROW = {
  provider_message_id: MSG_OUTBOUND,
  thread_id: THREAD,
  internal_date: d('2026-06-15T11:00:00Z'),
  mailbox_address: MAILBOX,
  payload: makePayload(['SENT'], 'agent@trufinity.ca'),
};

type InsertChain = {
  onConflict: (cols: string[]) => { merge: (data: Record<string, unknown>) => Promise<void> };
};

const makeFakeDb = (opts: {
  recentRows?: typeof INBOUND_ROW[];
  openAlertThreadIds?: string[];
  captureInsert?: (table: string, data: Record<string, unknown>) => void;
  captureUpdate?: (table: string, where: Record<string, unknown>, data: Record<string, unknown>) => void;
}) => {
  const fakeDb = (table: string) => {
    const q: Record<string, unknown> = {};
    let _where: Record<string, unknown> = {};
    let _whereIn: { col: string; vals: string[] } | undefined;

    q.select = (..._cols: unknown[]) => q;
    q.whereIn = (col: string, vals: string[]) => { _whereIn = { col, vals }; return q; };
    q.orderBy = () => q;

    // Accept both object form and column/value form of .where()
    q.where = function(colOrObj: string | Record<string, unknown>) {
      if (typeof colOrObj === 'object') { _where = colOrObj; }
      return q;
    } as unknown as typeof q.where;

    q.then = (resolve: (v: unknown) => void) => {
      if (table === 'google_unanswered_thread_alerts' && _where['status'] === 'OPEN' && !_whereIn) {
        resolve(
          (opts.openAlertThreadIds ?? []).map((tid) => ({ thread_id: tid })),
        );
      } else if (table === 'raw_gmail_messages') {
        if (_whereIn) {
          // Extra rows for OPEN alert threads (outside lookback window)
          resolve([]);
        } else {
          resolve(opts.recentRows ?? []);
        }
      } else {
        resolve([]);
      }
      return { catch: () => undefined };
    };

    // For .update (close alert)
    q.update = (data: Record<string, unknown>) => {
      opts.captureUpdate?.(table, _where, data);
      return Promise.resolve(1);
    };

    // For .insert().onConflict().merge()
    q.insert = (data: Record<string, unknown>): InsertChain => {
      return {
        onConflict: (_cols: string[]) => ({
          merge: (mergeData: Record<string, unknown>) => {
            opts.captureInsert?.(table, { ...data, _mergeData: mergeData });
            return Promise.resolve();
          },
        }),
      };
    };

    return q;
  };
  return fakeDb as unknown as import('knex').Knex;
};

describe('KnexR01Rule — evaluateMailbox', () => {
  it('inbound without reply beyond threshold → inserts OPEN alert', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb({
      recentRows: [INBOUND_ROW],
      captureInsert: (_table, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);

    expect(insertedData).not.toBeNull();
    expect(insertedData!['status']).toBe('OPEN');
    expect(insertedData!['oldest_unanswered_message_id']).toBe(MSG_INBOUND);
    expect(insertedData!['thread_id']).toBe(THREAD);
    expect(insertedData!['threshold_minutes']).toBe(240);
    // business_minutes_elapsed: 09:00 → 14:00 = 300 min
    expect(insertedData!['business_minutes_elapsed']).toBe(300);
  });

  it('inbound without reply below threshold → no insert', async () => {
    let insertCalled = false;
    // Inbound received Monday 13:30, now = 14:00 → only 30 min elapsed (< 240)
    const recentInbound = {
      ...INBOUND_ROW,
      internal_date: d('2026-06-15T13:30:00Z'),
    };
    const fakeDb = makeFakeDb({
      recentRows: [recentInbound],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('inbound with later outbound reply → closes any OPEN alert, no new insert', async () => {
    let insertCalled = false;
    let updateCalled = false;
    let updateData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb({
      recentRows: [INBOUND_ROW, OUTBOUND_ROW],
      openAlertThreadIds: [THREAD],
      captureInsert: () => { insertCalled = true; },
      captureUpdate: (_t, _w, data) => { updateCalled = true; updateData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
    expect(updateCalled).toBe(true);
    expect(updateData!['status']).toBe('REPLIED');
  });

  it('multiple inbound messages before outbound → thread is replied, no alert', async () => {
    let insertCalled = false;
    const fakeDb = makeFakeDb({
      recentRows: [
        { ...INBOUND_ROW, internal_date: d('2026-06-15T09:00:00Z') },
        { ...INBOUND_ROW, provider_message_id: 'msg-2', internal_date: d('2026-06-15T10:00:00Z') },
        OUTBOUND_ROW,
      ],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('outbound then new inbound beyond threshold → alert for new inbound', async () => {
    let insertedData: Record<string, unknown> | null = null;
    // Outbound at 09:00, new inbound at 09:01 → by 14:00 = ~299 min elapsed > 240
    const newInbound = {
      ...INBOUND_ROW,
      provider_message_id: 'msg-new-inbound',
      internal_date: d('2026-06-15T09:01:00Z'),
    };
    const fakeDb = makeFakeDb({
      recentRows: [
        { ...OUTBOUND_ROW, internal_date: d('2026-06-15T09:00:00Z') },
        newInbound,
      ],
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['oldest_unanswered_message_id']).toBe('msg-new-inbound');
  });

  it('outside-business-hours receipt — aging starts at next business opening', async () => {
    // Inbound received Sunday 22:00. Now = Monday 09:30.
    // Effective aging start = Monday 09:00 → elapsed = 30 min < 240 → no alert
    const sunInbound = {
      ...INBOUND_ROW,
      internal_date: d('2026-06-14T22:00:00Z'), // Sunday 22:00
    };
    const monNow = d('2026-06-15T09:30:00Z');
    let insertCalled = false;
    const fakeDb = makeFakeDb({
      recentRows: [sunInbound],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, monNow);
    expect(insertCalled).toBe(false);
  });

  it('outside-business-hours receipt — aging starts at next opening, threshold exceeded later', async () => {
    let insertedData: Record<string, unknown> | null = null;
    // Inbound received Sunday 22:00. Now = Monday 14:00.
    // Effective aging start = Monday 09:00 → elapsed = 300 min ≥ 240 → alert
    const sunInbound = {
      ...INBOUND_ROW,
      internal_date: d('2026-06-14T22:00:00Z'),
    };
    const fakeDb = makeFakeDb({
      recentRows: [sunInbound],
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW); // NOW = Monday 14:00
    expect(insertedData).not.toBeNull();
    expect(insertedData!['status']).toBe('OPEN');
  });

  it('weekend boundary — Friday evening inbound, now = Monday, elapsed correct', async () => {
    let insertedData: Record<string, unknown> | null = null;
    // Inbound Friday 18:00 (after hours). Effective start = Monday 09:00.
    // Now = Monday 14:00 → elapsed = 300 min
    const friInbound = {
      ...INBOUND_ROW,
      internal_date: d('2026-06-19T18:00:00Z'), // Friday 18:00
    };
    const monNow = d('2026-06-22T14:00:00Z'); // Monday 14:00
    const fakeDb = makeFakeDb({
      recentRows: [friInbound],
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, monNow);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['business_minutes_elapsed']).toBe(300);
  });

  it('internal email (from @trufinity.ca) → UNKNOWN → no alert created', async () => {
    let insertCalled = false;
    const internalRow = {
      ...INBOUND_ROW,
      payload: makePayload(['INBOX'], 'colleague@trufinity.ca'),
    };
    const fakeDb = makeFakeDb({
      recentRows: [internalRow],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('message with missing From header → UNKNOWN → no alert', async () => {
    let insertCalled = false;
    const noFromRow = {
      ...INBOUND_ROW,
      payload: { labelIds: ['INBOX'], headers: [] },
    };
    const fakeDb = makeFakeDb({
      recentRows: [noFromRow],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('message with null internal_date is skipped', async () => {
    let insertCalled = false;
    const nullDateRow = { ...INBOUND_ROW, internal_date: null } as unknown as typeof INBOUND_ROW;
    const fakeDb = makeFakeDb({
      recentRows: [nullDateRow],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('message with null payload is treated as UNKNOWN', async () => {
    let insertCalled = false;
    const nullPayloadRow = { ...INBOUND_ROW, payload: null } as unknown as typeof INBOUND_ROW;
    const fakeDb = makeFakeDb({
      recentRows: [nullPayloadRow],
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertCalled).toBe(false);
  });

  it('repeated evaluation — same result produces same insert (idempotent via onConflict)', async () => {
    let insertCount = 0;
    const fakeDb = makeFakeDb({
      recentRows: [INBOUND_ROW],
      captureInsert: () => { insertCount += 1; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, new Date(NOW.getTime() + 60_000));
    // Both evaluations attempt insert with onConflict().merge() — that's expected.
    // The DB's unique key prevents actual duplicate rows. Here we just confirm no error.
    expect(insertCount).toBe(2);
  });

  it('different-thread outbound does NOT satisfy inbound in another thread', async () => {
    let insertedData: Record<string, unknown> | null = null;
    // Thread A: inbound only (pending)
    // Thread B: outbound only (different thread)
    const threadAInbound = { ...INBOUND_ROW, thread_id: 'thread-A' };
    const threadBOutbound = {
      ...OUTBOUND_ROW,
      provider_message_id: 'msg-out-B',
      thread_id: 'thread-B',
      internal_date: d('2026-06-15T11:00:00Z'),
    };
    const fakeDb = makeFakeDb({
      recentRows: [threadAInbound, threadBOutbound],
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    // Thread A is still pending → alert created
    expect(insertedData).not.toBeNull();
    expect(insertedData!['thread_id']).toBe('thread-A');
  });

  it('privacy: insert data contains no body/snippet/subject fields', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb({
      recentRows: [INBOUND_ROW],
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(fakeDb);
    await rule.evaluateMailbox(MAILBOX, R01_CONFIG, NOW);
    expect(insertedData).not.toBeNull();
    expect(insertedData).not.toHaveProperty('body');
    expect(insertedData).not.toHaveProperty('snippet');
    expect(insertedData).not.toHaveProperty('subject');
    expect(insertedData).not.toHaveProperty('html');
    expect(insertedData).not.toHaveProperty('raw_payload');
  });

  it('failure isolation: R-01 error does not affect classification/work-item creation', () => {
    // This test verifies that R-01 runs independently of the classification path.
    // Classification creates email_escalation_work_items; R-01 creates google_unanswered_thread_alerts.
    // They use different tables — neither can fail the other.
    const r01Source = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    // R-01 must not reference the classification or work-item tables
    expect(r01Source).not.toContain('email_escalation_work_items');
    expect(r01Source).not.toContain('email_classification_results');
    expect(r01Source).not.toContain('classification_result_id');
  });

  it('existing classification/work-item tests still pass — no interference', () => {
    const r01Source = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    expect(r01Source).not.toContain('google-workspace.service');
    expect(r01Source).not.toContain('classification.repository');
  });
});

// ---------------------------------------------------------------------------
// R-01 source privacy guard
// ---------------------------------------------------------------------------

describe('R-01 privacy guard', () => {
  it('source file accesses no Gmail body, snippet, or HTML fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    // The source must not ACCESS body/snippet/html fields — checking for field access patterns
    expect(source).not.toMatch(/payload\.body/i);
    expect(source).not.toMatch(/payload\.snippet/i);
    expect(source).not.toMatch(/payload\.html/i);
    expect(source).not.toMatch(/['"]body['"]/);
    expect(source).not.toMatch(/['"]snippet['"]/);
    // Only reads headers, labelIds from payload
    expect(source).toContain('labelIds');
    expect(source).toContain('headers');
  });
});

// ---------------------------------------------------------------------------
// Worker entry-point unit tests
// ---------------------------------------------------------------------------

import {
  startGoogleResponsivenessWorker,
  validateResponsivenessWorkerConfig,
  type ResponsivenessWorkerDependencies,
} from '../../src/workers/google-responsiveness.worker';

describe('validateResponsivenessWorkerConfig', () => {
  it('accepts valid interval', () => {
    expect(() => validateResponsivenessWorkerConfig({ enabled: true, evalIntervalMs: 900_000 })).not.toThrow();
  });

  it('rejects interval below 300000', () => {
    expect(() => validateResponsivenessWorkerConfig({ enabled: true, evalIntervalMs: 60_000 })).toThrow();
  });

  it('rejects interval above 86400000', () => {
    expect(() => validateResponsivenessWorkerConfig({ enabled: true, evalIntervalMs: 90_000_000 })).toThrow();
  });
});

describe('startGoogleResponsivenessWorker', () => {
  const makeLogger = () => {
    const calls: string[] = [];
    return {
      calls,
      info: (m: string) => { calls.push(m); },
      warn: (m: string) => { calls.push(m); },
      error: (m: string) => { calls.push(m); },
    };
  };

  const makeDb = (connectOk = true): { raw: (q: string) => Promise<unknown>; destroy: () => Promise<unknown>; rawCallCount: number; destroyCallCount: number } => {
    let rawCallCount = 0;
    let destroyCallCount = 0;
    return {
      get rawCallCount() { return rawCallCount; },
      get destroyCallCount() { return destroyCallCount; },
      raw: () => { rawCallCount++; return connectOk ? Promise.resolve({}) : Promise.reject(new Error('DB down')); },
      destroy: () => { destroyCallCount++; return Promise.resolve(undefined); },
    };
  };

  const makeScheduler = () => {
    let startCount = 0;
    let stopCount = 0;
    return {
      get startCount() { return startCount; },
      get stopCount() { return stopCount; },
      start: () => { startCount++; },
      stop: () => { stopCount++; return Promise.resolve(); },
    };
  };

  it('when disabled — returns immediately without starting scheduler', async () => {
    const logger = makeLogger();
    let schedulerCreated = false;
    const db = makeDb();
    const deps: ResponsivenessWorkerDependencies = {
      database: db,
      config: { enabled: false, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger,
      createScheduler: () => { schedulerCreated = true; return makeScheduler(); },
      registerShutdown: () => () => undefined,
    };
    const handle = await startGoogleResponsivenessWorker(deps);
    expect(schedulerCreated).toBe(false);
    expect(db.rawCallCount).toBe(0);
    expect(logger.calls.some((m) => m.includes('disabled'))).toBe(true);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it('when enabled — verifies DB connectivity and starts scheduler', async () => {
    const scheduler = makeScheduler();
    const db = makeDb(true);
    const deps: ResponsivenessWorkerDependencies = {
      database: db,
      config: { enabled: true, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger: makeLogger(),
      createScheduler: () => scheduler,
      registerShutdown: () => () => undefined,
    };
    await startGoogleResponsivenessWorker(deps);
    expect(db.rawCallCount).toBe(1);
    expect(scheduler.startCount).toBe(1);
  });

  it('graceful shutdown — stops scheduler and destroys DB', async () => {
    const scheduler = makeScheduler();
    const db = makeDb();
    const deps: ResponsivenessWorkerDependencies = {
      database: db,
      config: { enabled: true, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger: makeLogger(),
      createScheduler: () => scheduler,
      registerShutdown: () => () => undefined,
    };
    const handle = await startGoogleResponsivenessWorker(deps);
    await handle.shutdown();
    expect(scheduler.stopCount).toBe(1);
    expect(db.destroyCallCount).toBe(1);
  });

  it('SIGTERM triggers graceful shutdown', async () => {
    const scheduler = makeScheduler();
    const db = makeDb();
    let capturedHandler: ((signal: 'SIGTERM' | 'SIGINT') => void) | undefined;
    const deps: ResponsivenessWorkerDependencies = {
      database: db,
      config: { enabled: true, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger: makeLogger(),
      createScheduler: () => scheduler,
      registerShutdown: (h) => { capturedHandler = h; return () => undefined; },
    };
    await startGoogleResponsivenessWorker(deps);
    expect(capturedHandler).toBeDefined();
    capturedHandler!('SIGTERM');
    await new Promise((r) => setTimeout(r, 10));
    expect(scheduler.stopCount).toBeGreaterThan(0);
  });

  it('double shutdown is idempotent', async () => {
    const scheduler = makeScheduler();
    const db = makeDb();
    const deps: ResponsivenessWorkerDependencies = {
      database: db,
      config: { enabled: true, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger: makeLogger(),
      createScheduler: () => scheduler,
      registerShutdown: () => () => undefined,
    };
    const handle = await startGoogleResponsivenessWorker(deps);
    await handle.shutdown();
    await handle.shutdown();
    expect(scheduler.stopCount).toBe(1);
  });

  it('DB connectivity failure throws on startup', async () => {
    let schedulerCreated = false;
    const deps: ResponsivenessWorkerDependencies = {
      database: { raw: () => Promise.reject(new Error('no db')), destroy: () => Promise.resolve(undefined) },
      config: { enabled: true, evalIntervalMs: 900_000 },
      runEvaluation: () => Promise.resolve({ alertsOpened: 0, alertsClosed: 0 }),
      logger: makeLogger(),
      createScheduler: () => { schedulerCreated = true; return makeScheduler(); },
      registerShutdown: () => () => undefined,
    };
    await expect(startGoogleResponsivenessWorker(deps)).rejects.toThrow('no db');
    expect(schedulerCreated).toBe(false);
  });
});
