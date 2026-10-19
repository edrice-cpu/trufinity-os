import { describe, it, expect, jest } from '@jest/globals';

// Helpers that work around @jest/globals strict typing for mockResolvedValue/mockRejectedValue.
const mockResolved = <T>(v: T): jest.Mock => {
  const m = jest.fn();
  (m as unknown as { mockResolvedValue(v: unknown): void }).mockResolvedValue(v);
  return m as jest.Mock;
};
const mockRejected = (e: Error): jest.Mock => {
  const m = jest.fn();
  (m as unknown as { mockRejectedValue(e: unknown): void }).mockRejectedValue(e);
  return m as jest.Mock;
};

/**
 * Tests for responsiveness-notifier.ts (Phase 3)
 *
 * All tests are fully mocked — no DB connections, no SMTP sends, no real
 * recipients. Verified safety:
 *   - No email is sent to edrice@trufinity.ca or casey@trufinity.ca.
 *   - No nodemailer transport contacts an actual SMTP server.
 *   - No database queries execute against a real DB.
 */

import {
  resolveRecipients,
  pickHighestPriorityAlert,
  buildIdempotencyKey,
  buildNotificationEmail,
  ALERT_TYPE_PRIORITY,
  KNOWN_PRODUCTION_RECIPIENTS,
  KnexResponsivenessNotificationStore,
  SmtpResponsivenessNotifier,
  NoOpResponsivenessNotifier,
  loadOpenAlerts,
  type OpenAlert,
  type NotificationConfig,
  type ResponsivenessNotifier,
  type ResponsivenessNotificationStore,
} from '../../src/modules/google/responsiveness-notifier';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_RECIPIENT = 'test-alerts@example.com';

const BASE_CONFIG: NotificationConfig = {
  mode: 'DISABLED',
  testRecipient: TEST_RECIPIENT,
  productionRecipients: '',
  productionGate: '',
  maxAttempts: 5,
  leaseMinutes: 10,
};

const openAlert = (overrides: Partial<OpenAlert> = {}): OpenAlert => ({
  alertId:                'aaaaaaaa-0000-0000-0000-000000000001',
  alertTable:             'google_unanswered_thread_alerts',
  alertType:              'R01_GENERAL',
  mailboxAddress:         'support@trufinity.ca',
  threadId:               'thread-001',
  elapsedMinutes:         300,
  thresholdMinutes:       240,
  detectedAt:             new Date('2026-10-15T10:00:00Z'),
  notificationGeneration: 1,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. resolveRecipients — DISABLED mode
// ---------------------------------------------------------------------------

describe('resolveRecipients — DISABLED mode', () => {
  it('returns empty recipient list', () => {
    const result = resolveRecipients({ ...BASE_CONFIG, mode: 'DISABLED' });
    expect(result.mode).toBe('DISABLED');
    expect(result.recipients).toHaveLength(0);
  });

  it('does not throw even when testRecipient is missing', () => {
    expect(() =>
      resolveRecipients({ ...BASE_CONFIG, mode: 'DISABLED', testRecipient: undefined }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. resolveRecipients — TEST mode
// ---------------------------------------------------------------------------

describe('resolveRecipients — TEST mode', () => {
  it('returns the test recipient', () => {
    const result = resolveRecipients({ ...BASE_CONFIG, mode: 'TEST' });
    expect(result.recipients).toEqual([TEST_RECIPIENT]);
  });

  it('throws when testRecipient is not set', () => {
    expect(() =>
      resolveRecipients({ ...BASE_CONFIG, mode: 'TEST', testRecipient: undefined }),
    ).toThrow('WORK_ITEM_NOTIFICATION_RECIPIENT');
  });

  it('hard-rejects edrice@trufinity.ca as test recipient', () => {
    expect(() =>
      resolveRecipients({ ...BASE_CONFIG, mode: 'TEST', testRecipient: 'edrice@trufinity.ca' }),
    ).toThrow('known production address');
  });

  it('hard-rejects casey@trufinity.ca as test recipient', () => {
    expect(() =>
      resolveRecipients({ ...BASE_CONFIG, mode: 'TEST', testRecipient: 'casey@trufinity.ca' }),
    ).toThrow('known production address');
  });

  it('rejects test recipient that overlaps configured production recipients', () => {
    expect(() =>
      resolveRecipients({
        ...BASE_CONFIG,
        mode: 'TEST',
        testRecipient: 'ops@example.com',
        productionRecipients: 'ops@example.com,backup@example.com',
      }),
    ).toThrow('overlaps');
  });

  it('is case-insensitive for overlap check', () => {
    expect(() =>
      resolveRecipients({ ...BASE_CONFIG, mode: 'TEST', testRecipient: 'EDRICE@trufinity.ca' }),
    ).toThrow('known production address');
  });
});

// ---------------------------------------------------------------------------
// 3. resolveRecipients — PRODUCTION mode
// ---------------------------------------------------------------------------

describe('resolveRecipients — PRODUCTION mode', () => {
  const GATE = 'I_CONFIRM_PRODUCTION_NOTIFICATIONS';

  it('returns parsed recipient list when gate is set', () => {
    const result = resolveRecipients({
      ...BASE_CONFIG,
      mode: 'PRODUCTION',
      productionGate: GATE,
      productionRecipients: 'ops@example.com, backup@example.com',
    });
    expect(result.recipients).toEqual(['ops@example.com', 'backup@example.com']);
  });

  it('throws without the gate string', () => {
    expect(() =>
      resolveRecipients({
        ...BASE_CONFIG,
        mode: 'PRODUCTION',
        productionGate: '',
        productionRecipients: 'ops@example.com',
      }),
    ).toThrow('I_CONFIRM_PRODUCTION_NOTIFICATIONS');
  });

  it('throws with a wrong gate string', () => {
    expect(() =>
      resolveRecipients({
        ...BASE_CONFIG,
        mode: 'PRODUCTION',
        productionGate: 'yes please',
        productionRecipients: 'ops@example.com',
      }),
    ).toThrow('I_CONFIRM_PRODUCTION_NOTIFICATIONS');
  });

  it('throws when recipients list is empty even with gate set', () => {
    expect(() =>
      resolveRecipients({
        ...BASE_CONFIG,
        mode: 'PRODUCTION',
        productionGate: GATE,
        productionRecipients: '',
      }),
    ).toThrow('at least one address');
  });
});

// ---------------------------------------------------------------------------
// 4. KNOWN_PRODUCTION_RECIPIENTS — hard-coded safety set
// ---------------------------------------------------------------------------

describe('KNOWN_PRODUCTION_RECIPIENTS safety set', () => {
  it('contains edrice@trufinity.ca', () => {
    expect(KNOWN_PRODUCTION_RECIPIENTS.has('edrice@trufinity.ca')).toBe(true);
  });

  it('contains casey@trufinity.ca', () => {
    expect(KNOWN_PRODUCTION_RECIPIENTS.has('casey@trufinity.ca')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. pickHighestPriorityAlert
// ---------------------------------------------------------------------------

describe('pickHighestPriorityAlert', () => {
  it('returns null for empty array', () => {
    expect(pickHighestPriorityAlert([])).toBeNull();
  });

  it('returns the only alert', () => {
    const a = openAlert({ alertType: 'R02_INACTIVITY' });
    expect(pickHighestPriorityAlert([a])).toBe(a);
  });

  it('R01_EMERGENCY beats R01_GENERAL', () => {
    const emergency = openAlert({ alertType: 'R01_EMERGENCY' });
    const general = openAlert({ alertType: 'R01_GENERAL' });
    expect(pickHighestPriorityAlert([general, emergency])).toBe(emergency);
  });

  it('R01_GENERAL beats R04_AFTER_HOURS', () => {
    const r01 = openAlert({ alertType: 'R01_GENERAL' });
    const r04 = openAlert({ alertType: 'R04_AFTER_HOURS' });
    expect(pickHighestPriorityAlert([r04, r01])).toBe(r01);
  });

  it('R04_AFTER_HOURS beats R02_INACTIVITY', () => {
    const r04 = openAlert({ alertType: 'R04_AFTER_HOURS' });
    const r02 = openAlert({ alertType: 'R02_INACTIVITY' });
    expect(pickHighestPriorityAlert([r02, r04])).toBe(r04);
  });

  it('R02_INACTIVITY beats R02_EXCESSIVE_EXCHANGES', () => {
    const inactivity = openAlert({ alertType: 'R02_INACTIVITY' });
    const exchanges  = openAlert({ alertType: 'R02_EXCESSIVE_EXCHANGES' });
    expect(pickHighestPriorityAlert([exchanges, inactivity])).toBe(inactivity);
  });

  it('full priority chain selects R01_EMERGENCY from a mixed set', () => {
    const alerts = [
      openAlert({ alertType: 'R02_EXCESSIVE_EXCHANGES' }),
      openAlert({ alertType: 'R04_AFTER_HOURS' }),
      openAlert({ alertType: 'R01_EMERGENCY' }),
      openAlert({ alertType: 'R02_INACTIVITY' }),
      openAlert({ alertType: 'R01_GENERAL' }),
    ];
    expect(pickHighestPriorityAlert(alerts)?.alertType).toBe('R01_EMERGENCY');
  });

  it('ALERT_TYPE_PRIORITY values form a strict ordering', () => {
    const order: Array<keyof typeof ALERT_TYPE_PRIORITY> = [
      'R01_EMERGENCY', 'R01_GENERAL', 'R04_AFTER_HOURS', 'R02_INACTIVITY', 'R02_EXCESSIVE_EXCHANGES',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(ALERT_TYPE_PRIORITY[order[i]]).toBeLessThan(ALERT_TYPE_PRIORITY[order[i + 1]]);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. buildIdempotencyKey
// ---------------------------------------------------------------------------

describe('buildIdempotencyKey', () => {
  it('is deterministic', () => {
    const alert = openAlert({ alertId: 'uuid-123', alertType: 'R01_EMERGENCY' });
    const key1 = buildIdempotencyKey(alert, 'test@example.com');
    const key2 = buildIdempotencyKey(alert, 'test@example.com');
    expect(key1).toBe(key2);
  });

  it('encodes alert type lower-cased with generation', () => {
    const alert = openAlert({ alertId: 'uuid-abc', alertType: 'R01_EMERGENCY', notificationGeneration: 1 });
    expect(buildIdempotencyKey(alert, 'r@x.com')).toBe('responsiveness:r01_emergency:uuid-abc:1:r@x.com');
  });

  it('differs by notification generation (lifecycle deduplication)', () => {
    const gen1 = openAlert({ alertId: 'uuid-abc', alertType: 'R02_INACTIVITY', notificationGeneration: 1 });
    const gen2 = openAlert({ alertId: 'uuid-abc', alertType: 'R02_INACTIVITY', notificationGeneration: 2 });
    expect(buildIdempotencyKey(gen1, 'r@x.com')).not.toBe(buildIdempotencyKey(gen2, 'r@x.com'));
  });

  it('differs by recipient', () => {
    const alert = openAlert({ alertId: 'uuid-abc', alertType: 'R01_GENERAL' });
    expect(buildIdempotencyKey(alert, 'a@x.com')).not.toBe(buildIdempotencyKey(alert, 'b@x.com'));
  });

  it('differs by alert type', () => {
    const a1 = openAlert({ alertId: 'uuid-abc', alertType: 'R01_GENERAL' });
    const a2 = openAlert({ alertId: 'uuid-abc', alertType: 'R02_INACTIVITY' });
    expect(buildIdempotencyKey(a1, 'r@x.com')).not.toBe(buildIdempotencyKey(a2, 'r@x.com'));
  });
});

// ---------------------------------------------------------------------------
// 7. buildNotificationEmail — content safety
// ---------------------------------------------------------------------------

describe('buildNotificationEmail — content', () => {
  it('subject includes alert type label and mailbox', () => {
    const alert = openAlert({ alertType: 'R01_EMERGENCY', mailboxAddress: 'support@trufinity.ca' });
    const { subject } = buildNotificationEmail(alert);
    expect(subject).toContain('Emergency');
    expect(subject).toContain('support@trufinity.ca');
  });

  it('body includes thread URL with correct format', () => {
    const alert = openAlert({ threadId: 'abc123threadid' });
    const { text } = buildNotificationEmail(alert);
    expect(text).toContain('https://mail.google.com/mail/u/0/#all/abc123threadid');
  });

  it('body does not contain email message body or subject', () => {
    // The alert object only knows elapsed/threshold/detectedAt — never carries
    // email body or snippet. Verify the generated text has no placeholder that
    // would reveal customer content.
    const alert = openAlert();
    const { text } = buildNotificationEmail(alert);
    expect(text).not.toMatch(/snippet|body|subject|customer message/i);
  });

  it('body includes detection timestamp in ISO format', () => {
    const alert = openAlert({ detectedAt: new Date('2026-10-15T10:30:00.000Z') });
    const { text } = buildNotificationEmail(alert);
    expect(text).toContain('2026-10-15 10:30:00 UTC');
  });

  it('body includes elapsed and threshold times', () => {
    const alert = openAlert({ elapsedMinutes: 45, thresholdMinutes: 25 });
    const { text } = buildNotificationEmail(alert);
    expect(text).toContain('45 minutes');
    expect(text).toContain('25 minutes');
  });

  it('body includes action recommendation', () => {
    const emergency = openAlert({ alertType: 'R01_EMERGENCY' });
    const { text } = buildNotificationEmail(emergency);
    expect(text.toLowerCase()).toContain('immediately');
  });

  it('body includes automated disclaimer', () => {
    const { text } = buildNotificationEmail(openAlert());
    expect(text).toContain('automated');
  });
});

// ---------------------------------------------------------------------------
// 8. NoOpResponsivenessNotifier
// ---------------------------------------------------------------------------

describe('NoOpResponsivenessNotifier', () => {
  it('processMailbox always returns 0', async () => {
    const notifier = new NoOpResponsivenessNotifier();
    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(0);
  });

  it('recoverPending always returns 0', async () => {
    const notifier = new NoOpResponsivenessNotifier();
    expect(await notifier.recoverPending()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. KnexResponsivenessNotificationStore — fake DB
// ---------------------------------------------------------------------------

type RowStore = Record<string, Record<string, unknown>>;

function buildFakeDb(initialRows: RowStore = {}): {
  db: (table: string) => unknown;
  rows: RowStore;
  insertedRows: Array<{ table: string; row: Record<string, unknown> }>;
  updatedRows: Array<{ table: string; where: Record<string, unknown>; data: Record<string, unknown> }>;
} {
  const rows = { ...initialRows };
  const insertedRows: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updatedRows: Array<{ table: string; where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const buildChain = (table: string) => {
    const state: {
      whereClause: Record<string, unknown>;
      selectCols: string[];
      firstOnly: boolean;
      rawConds: string[];
    } = { whereClause: {}, selectCols: [], firstOnly: false, rawConds: [] };

    const chain: Record<string, unknown> = {};

    chain.select = (...cols: string[]) => {
      state.selectCols = cols.flat();
      return chain;
    };

    chain.where = (cond: Record<string, unknown> | string) => {
      if (typeof cond === 'object') Object.assign(state.whereClause, cond);
      return chain;
    };

    chain.whereRaw = (sql: string) => {
      state.rawConds.push(sql);
      return chain;
    };

    chain.whereIn = (_col: string, _vals: unknown[]) => chain;

    chain.first = async () => {
      const tableRows = Object.values(rows).filter((r) => {
        const row = r as Record<string, unknown>;
        return Object.entries(state.whereClause).every(([k, v]) => row[k] === v);
      });
      return tableRows[0] ?? undefined;
    };

    chain.insert = (row: Record<string, unknown>) => {
      insertedRows.push({ table, row });
      chain._pendingInsert = row;
      return chain;
    };

    chain.onConflict = () => chain;
    chain.ignore = async () => { /* no-op */ };

    chain.update = async (data: Record<string, unknown>) => {
      updatedRows.push({ table, where: state.whereClause, data });
      const matchingRows = Object.values(rows).filter((r) => {
        const row = r as Record<string, unknown>;
        return Object.entries(state.whereClause).every(([k, v]) => row[k] === v);
      });
      const eligibleRows = matchingRows.filter((r) => {
        const row = r as Record<string, unknown>;
        // Simulate: attempt_count < max_attempts
        if (state.rawConds.some((c) => c.includes('attempt_count < max_attempts'))) {
          if ((row.attempt_count as number) >= (row.max_attempts as number)) return false;
        }
        // Simulate: status = 'PENDING' OR status = 'FAILED' (claim's first whereRaw)
        if (state.rawConds.some((c) => c.includes("status = 'PENDING'"))) {
          const s = row.status as string;
          if (s !== 'PENDING' && s !== 'FAILED') return false;
        }
        return true;
      });
      return eligibleRows.length;
    };

    chain.raw = (expr: string) => ({ __raw: expr });

    return chain;
  };

  const dbFn = (table: string) => buildChain(table);
  // Knex instance also has a .raw() method used for SQL expressions in update().
  (dbFn as unknown as Record<string, unknown>).raw = (expr: string) => ({ __raw: expr });

  return {
    db: dbFn,
    rows,
    insertedRows,
    updatedRows,
  };
}

describe('KnexResponsivenessNotificationStore.claim', () => {
  it('returns true when claiming a PENDING row', async () => {
    const { db, rows } = buildFakeDb();
    const key = 'responsiveness:r01_general:uuid-1:1:test@x.com';
    // Pre-populate a PENDING row so update() returns 1
    rows[key] = { idempotency_key: key, status: 'PENDING', attempt_count: 0, max_attempts: 5 };

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-1', alertType: 'R01_GENERAL' });
    const claimed = await store.claim(alert, 'test@x.com', 5);
    expect(claimed).toEqual({ leaseToken: expect.any(String) });
  });

  it('returns false when row is already SENDING (not PENDING or FAILED)', async () => {
    const { db, rows } = buildFakeDb();
    const key = 'responsiveness:r01_general:uuid-2:1:test@x.com';
    rows[key] = { idempotency_key: key, status: 'SENDING', attempt_count: 1, max_attempts: 5 };

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-2', alertType: 'R01_GENERAL' });
    const claimed = await store.claim(alert, 'test@x.com', 5);
    expect(claimed).toBeNull();
  });

  it('returns false when attempt_count >= max_attempts', async () => {
    const { db, rows } = buildFakeDb();
    const key = 'responsiveness:r01_general:uuid-3:1:test@x.com';
    rows[key] = { idempotency_key: key, status: 'PENDING', attempt_count: 5, max_attempts: 5 };

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-3', alertType: 'R01_GENERAL' });
    const claimed = await store.claim(alert, 'test@x.com', 5);
    expect(claimed).toBeNull();
  });

  it('returns true when claiming a FAILED row whose backoff window has elapsed', async () => {
    const { db, rows } = buildFakeDb();
    const key = 'responsiveness:r01_general:uuid-4:1:test@x.com';
    // next_attempt_at in the past — backoff window has elapsed
    rows[key] = { idempotency_key: key, status: 'FAILED', attempt_count: 2, max_attempts: 5, next_attempt_at: null };

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-4', alertType: 'R01_GENERAL' });
    const claimed = await store.claim(alert, 'test@x.com', 5);
    expect(claimed).toEqual({ leaseToken: expect.any(String) });
  });

  it('returns false for SENT rows (not PENDING or FAILED)', async () => {
    const { db, rows } = buildFakeDb();
    const key = 'responsiveness:r01_general:uuid-5:1:test@x.com';
    rows[key] = { idempotency_key: key, status: 'SENT', attempt_count: 1, max_attempts: 5 };

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-5', alertType: 'R01_GENERAL' });
    const claimed = await store.claim(alert, 'test@x.com', 5);
    expect(claimed).toBeNull();
  });
});

describe('KnexResponsivenessNotificationStore.isSent', () => {
  it('returns true when notification row has status=SENT', async () => {
    const key = 'responsiveness:r01_general:uuid-s:1:rec@x.com';
    const { db } = buildFakeDb({ [key]: { idempotency_key: key, status: 'SENT' } });

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-s', alertType: 'R01_GENERAL' });
    expect(await store.isSent(alert, 'rec@x.com')).toBe(true);
  });

  it('returns false when no row exists', async () => {
    const { db } = buildFakeDb();
    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-none', alertType: 'R01_GENERAL' });
    expect(await store.isSent(alert, 'rec@x.com')).toBe(false);
  });

  it('returns false when row status is PENDING', async () => {
    const key = 'responsiveness:r01_general:uuid-p:1:rec@x.com';
    const { db } = buildFakeDb({ [key]: { idempotency_key: key, status: 'PENDING' } });

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alert = openAlert({ alertId: 'uuid-p', alertType: 'R01_GENERAL' });
    expect(await store.isSent(alert, 'rec@x.com')).toBe(false);
  });

  it('returns false for a new generation even if generation 1 was SENT (lifecycle deduplication)', async () => {
    // Generation 1 was sent; alert reopened → generation 2 → different key → not sent
    const key1 = 'responsiveness:r02_inactivity:uuid-r:1:rec@x.com';
    const { db } = buildFakeDb({ [key1]: { idempotency_key: key1, status: 'SENT' } });

    const store = new KnexResponsivenessNotificationStore(db as never);
    const alertGen2 = openAlert({ alertId: 'uuid-r', alertType: 'R02_INACTIVITY', notificationGeneration: 2 });
    expect(await store.isSent(alertGen2, 'rec@x.com')).toBe(false);
  });
});

describe('lease fencing and stale recovery', () => {
  it('fences markSent and markFailed to the active lease token', async () => {
    const key = 'responsiveness:r01_general:fence:1:test@x.com';
    const { db, rows, updatedRows } = buildFakeDb({
      [key]: { idempotency_key: key, status: 'SENDING', lease_token: 'claim-a', attempt_count: 1, max_attempts: 5 },
    });
    const store = new KnexResponsivenessNotificationStore(db as never);

    await store.markSent(key, 'claim-a');
    expect(updatedRows.at(-1)?.where).toMatchObject({ status: 'SENDING', lease_token: 'claim-a' });

    rows[key] = { ...rows[key], status: 'SENDING', lease_token: 'claim-b', attempt_count: 2, max_attempts: 5 };
    await store.markFailed(key, 'SMTP_SEND', 'claim-a');
    expect(updatedRows.at(-1)?.where).toMatchObject({ status: 'SENDING', lease_token: 'claim-a' });
  });

  it('does not count a stale recovery whose fencing predicate affected zero rows', async () => {
    const row = {
      id: 'n1', idempotency_key: 'k1', status: 'SENDING' as const,
      attempt_count: 1, max_attempts: 5, last_attempted_at: new Date(0).toISOString(),
      next_attempt_at: null, lease_token: 'old-lease',
    };
    const store = buildMockStore({ listRetryable: mockResolved([row]) as unknown as ResponsivenessNotificationStore['listRetryable'] });
    const whereCalls: Array<Record<string, unknown>> = [];
    const db = () => ({
      where: (where: Record<string, unknown>) => ({
        update: async () => { whereCalls.push(where); return 0; },
      }),
    });
    const notifier = new SmtpResponsivenessNotifier(store, db as never, [], 5, 10, 'from@x.com', buildMockTransport() as never);

    await expect(notifier.recoverPending()).resolves.toBe(0);
    expect(whereCalls[0]).toMatchObject({ status: 'SENDING', lease_token: 'old-lease' });
  });
});

// ---------------------------------------------------------------------------
// 10. loadOpenAlerts — fake DB for alert tables
// ---------------------------------------------------------------------------

describe('loadOpenAlerts', () => {
  function buildAlertDb(options: {
    r01?: Array<Record<string, unknown>>;
    r02?: Array<Record<string, unknown>>;
    r04?: Array<Record<string, unknown>>;
  }) {
    return (table: string): unknown => {
      const buildQueryChain = (tableRows: Array<Record<string, unknown>>) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.where = () => chain;
        chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(tableRows).then(resolve);
        return chain;
      };

      if (table === 'google_unanswered_thread_alerts') return buildQueryChain(options.r01 ?? []);
      if (table === 'google_stalled_thread_alerts')    return buildQueryChain(options.r02 ?? []);
      if (table === 'google_after_hours_backlog_alerts') return buildQueryChain(options.r04 ?? []);
      return buildQueryChain([]);
    };
  }

  it('classifies R-01 alert with is_emergency=true as R01_EMERGENCY', async () => {
    const db = buildAlertDb({
      r01: [{
        id: 'a1', thread_id: 'th1', threshold_minutes: 25, is_emergency: true,
        business_minutes_elapsed: 30, threshold_exceeded_at: '2026-10-15T10:00:00Z',
      }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertType).toBe('R01_EMERGENCY');
    expect(alerts[0].notificationGeneration).toBe(1);
  });

  it('classifies R-01 alert with is_emergency=false as R01_GENERAL regardless of threshold', async () => {
    const db = buildAlertDb({
      r01: [{
        id: 'a2', thread_id: 'th2', threshold_minutes: 25, is_emergency: false,
        business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z',
      }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts[0].alertType).toBe('R01_GENERAL');
  });

  it('classifies R-02 INACTIVITY alert correctly and passes notification_generation', async () => {
    const db = buildAlertDb({
      r02: [{
        id: 'b1', thread_id: 'th3', stall_reason: 'INACTIVITY',
        inactivity_minutes: 1440, inactivity_threshold_minutes: 1440,
        created_at: '2026-10-15T10:00:00Z', notification_generation: 2,
      }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts[0].alertType).toBe('R02_INACTIVITY');
    expect(alerts[0].notificationGeneration).toBe(2);
  });

  it('classifies R-02 EXCESSIVE_EXCHANGES alert correctly', async () => {
    const db = buildAlertDb({
      r02: [{
        id: 'b2', thread_id: 'th4', stall_reason: 'EXCESSIVE_EXCHANGES',
        inactivity_minutes: 0, inactivity_threshold_minutes: 0,
        created_at: '2026-10-15T10:00:00Z', notification_generation: 1,
      }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts[0].alertType).toBe('R02_EXCESSIVE_EXCHANGES');
  });

  it('classifies R-04 alert as R04_AFTER_HOURS using real columns', async () => {
    const db = buildAlertDb({
      r04: [{
        id: 'c1', thread_id: 'th5', notification_generation: 1,
        inbound_at: '2026-10-15T14:00:00Z', deadline_at: '2026-10-15T15:00:00Z',
        created_at: '2026-10-15T14:00:00Z',
      }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts[0].alertType).toBe('R04_AFTER_HOURS');
    expect(alerts[0].thresholdMinutes).toBe(60); // deadline - inbound = 60 min
    expect(alerts[0].notificationGeneration).toBe(1);
  });

  it('returns empty array when no alerts are open', async () => {
    const db = buildAlertDb({});
    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts).toHaveLength(0);
  });

  it('combines alerts from all three tables', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
      r02: [{ id: 'b1', thread_id: 'th2', stall_reason: 'INACTIVITY', inactivity_minutes: 1440, inactivity_threshold_minutes: 1440, created_at: '2026-10-15T10:00:00Z', notification_generation: 1 }],
      r04: [{ id: 'c1', thread_id: 'th3', notification_generation: 1, inbound_at: '2026-10-15T14:00:00Z', deadline_at: '2026-10-15T15:00:00Z', created_at: '2026-10-15T10:00:00Z' }],
    });

    const alerts = await loadOpenAlerts(db as never, 'support@trufinity.ca');
    expect(alerts).toHaveLength(3);
    const types = alerts.map((a) => a.alertType).sort();
    expect(types).toEqual(['R01_GENERAL', 'R02_INACTIVITY', 'R04_AFTER_HOURS']);
  });
});

// ---------------------------------------------------------------------------
// 11. SmtpResponsivenessNotifier.processMailbox
// ---------------------------------------------------------------------------

function buildMockStore(overrides: Partial<ResponsivenessNotificationStore> = {}): ResponsivenessNotificationStore {
  return {
    claim:          mockResolved({ leaseToken: 'test-lease' }) as unknown as ResponsivenessNotificationStore['claim'],
    markSent:       mockResolved(undefined) as unknown as ResponsivenessNotificationStore['markSent'],
    markFailed:     mockResolved(undefined) as unknown as ResponsivenessNotificationStore['markFailed'],
    isSent:         mockResolved(false) as unknown as ResponsivenessNotificationStore['isSent'],
    listRetryable:  mockResolved([]) as unknown as ResponsivenessNotificationStore['listRetryable'],
    ...overrides,
  };
}

function buildMockTransport() {
  return { sendMail: mockResolved({ messageId: 'mock-id' }) };
}

function buildAlertDb(options: {
  r01?: Array<Record<string, unknown>>;
  r02?: Array<Record<string, unknown>>;
  r04?: Array<Record<string, unknown>>;
}) {
  return (table: string): unknown => {
    const buildQueryChain = (tableRows: Array<Record<string, unknown>>) => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.where = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(tableRows).then(resolve);
      return chain;
    };

    if (table === 'google_unanswered_thread_alerts')   return buildQueryChain(options.r01 ?? []);
    if (table === 'google_stalled_thread_alerts')      return buildQueryChain(options.r02 ?? []);
    if (table === 'google_after_hours_backlog_alerts') return buildQueryChain(options.r04 ?? []);
    return buildQueryChain([]);
  };
}

describe('SmtpResponsivenessNotifier.processMailbox', () => {
  it('sends a notification for an open alert', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
    });
    const store = buildMockStore();
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'TruFinity <no-reply@trufinity.ca>', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(transport.sendMail.mock.calls[0][0]).toMatchObject({
      to: TEST_RECIPIENT,
      from: 'TruFinity <no-reply@trufinity.ca>',
    });
  });

  it('does not send when alert is already notified (isSent=true)', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
    });
    const store = buildMockStore({ isSent: mockResolved(true) as unknown as ResponsivenessNotificationStore['isSent'] });
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(0);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('does not send when claim returns false (concurrent claim)', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
    });
    const store = buildMockStore({ claim: mockResolved(false) as unknown as ResponsivenessNotificationStore['claim'] });
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(0);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it('marks FAILED when SMTP throws', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
    });
    const store = buildMockStore();
    const transport = { sendMail: mockRejected(new Error('ECONNREFUSED connect ETIMEDOUT')) };

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    await notifier.processMailbox('support@trufinity.ca');
    expect(store.markFailed).toHaveBeenCalledWith(
      expect.stringContaining('responsiveness:'),
      'SMTP_CONNECT',
      'test-lease',
    );
    expect(store.markSent).not.toHaveBeenCalled();
  });

  it('selects highest-priority alert per thread and sends only one notification', async () => {
    // Same thread has both R01_GENERAL and R02_INACTIVITY — should notify only R01_GENERAL
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'shared-thread', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
      r02: [{ id: 'b1', thread_id: 'shared-thread', stall_reason: 'INACTIVITY', inactivity_minutes: 1440, inactivity_threshold_minutes: 1440, created_at: '2026-10-15T10:00:00Z', notification_generation: 1 }],
    });
    const store = buildMockStore();
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    // Only one notification sent (for R01_GENERAL, which has priority 2 vs R02_INACTIVITY priority 4)
    expect(result.notificationsSent).toBe(1);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    // The isSent check is called with the R01_GENERAL alert (highest priority)
    expect(store.isSent).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'R01_GENERAL' }),
      TEST_RECIPIENT,
    );
  });

  it('sends separate notifications for different threads', async () => {
    const db = buildAlertDb({
      r01: [
        { id: 'a1', thread_id: 'thread-A', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' },
        { id: 'a2', thread_id: 'thread-B', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 350, threshold_exceeded_at: '2026-10-15T11:00:00Z' },
      ],
    });
    const store = buildMockStore();
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(2);
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
  });

  it('sends to each recipient in the list', async () => {
    const db = buildAlertDb({
      r01: [{ id: 'a1', thread_id: 'th1', threshold_minutes: 240, is_emergency: false, business_minutes_elapsed: 300, threshold_exceeded_at: '2026-10-15T10:00:00Z' }],
    });
    const store = buildMockStore();
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, ['r1@x.com', 'r2@x.com'], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(2);
    const toAddresses = (transport.sendMail.mock.calls as Array<Array<{ to: string }>>).map((c) => c[0].to);
    expect(toAddresses).toContain('r1@x.com');
    expect(toAddresses).toContain('r2@x.com');
  });

  it('returns 0 when no alerts are open', async () => {
    const db = buildAlertDb({});
    const store = buildMockStore();
    const transport = buildMockTransport();

    const notifier = new SmtpResponsivenessNotifier(
      store, db as never, [TEST_RECIPIENT], 5, 10, 'from@x.com', transport as never,
    );

    const result = await notifier.processMailbox('support@trufinity.ca');
    expect(result.notificationsSent).toBe(0);
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 12. Worker integration — notifier in EvaluationCycleOptions
// ---------------------------------------------------------------------------

describe('Worker integration — notifier option', () => {
  it('calls recoverPending once per cycle before processing mailboxes', async () => {
    const { buildEvaluationCycle } = await import('../../src/workers/google-responsiveness.worker');
    const mockNotifier = new NoOpResponsivenessNotifier();
    const recoverSpy = jest.spyOn(mockNotifier, 'recoverPending');
    const processSpy = jest.spyOn(mockNotifier, 'processMailbox');

    const fakeMailboxes = async () => ['a@example.com', 'b@example.com'];
    const fakeDb = (_table: string) => ({ where: () => ({ count: () => ({ first: async () => ({ count: '0' }) }) }) });
    const fakeRule = { evaluateMailbox: mockResolved({}) };

    const run = buildEvaluationCycle(fakeMailboxes, {
      r01Enabled: false, r01Rule: fakeRule as never, r01Config: {} as never,
      r02Enabled: false, r02Rule: fakeRule as never, r02Config: {} as never,
      r03Enabled: false, r03Rule: fakeRule as never, r03Config: {} as never,
      r04Enabled: false, r04Rule: fakeRule as never, r04Config: {} as never,
      notifier: mockNotifier,
      logger: { info: jest.fn() as jest.Mock, warn: jest.fn() as jest.Mock, error: jest.fn() as jest.Mock },
    }, fakeDb as never);

    await run();
    // recoverPending called once; processMailbox called once per mailbox
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(processSpy).toHaveBeenCalledTimes(2);
  });

  it('EvaluationCycleOptions accepts a notifier field', async () => {
    const { buildEvaluationCycle } = await import('../../src/workers/google-responsiveness.worker');
    const mockNotifier = new NoOpResponsivenessNotifier();
    const spy = jest.spyOn(mockNotifier, 'processMailbox');

    // Build a minimal evaluation cycle with only the notifier (all rules disabled)
    const fakeMailboxes = async () => ['test@example.com'];
    const fakeDb = (_table: string) => ({ where: () => ({ count: () => ({ first: async () => ({ count: '0' }) }) }) });

    const fakeRule = { evaluateMailbox: mockResolved({}) };

    const run = buildEvaluationCycle(fakeMailboxes, {
      r01Enabled: false,
      r01Rule: fakeRule as never,
      r01Config: {} as never,
      r02Enabled: false,
      r02Rule: fakeRule as never,
      r02Config: {} as never,
      r03Enabled: false,
      r03Rule: fakeRule as never,
      r03Config: {} as never,
      r04Enabled: false,
      r04Rule: fakeRule as never,
      r04Config: {} as never,
      notifier: mockNotifier,
      logger: { info: jest.fn() as jest.Mock, warn: jest.fn() as jest.Mock, error: jest.fn() as jest.Mock },
    }, fakeDb as never);

    await run();
    expect(spy).toHaveBeenCalledWith('test@example.com');
  });

  it('EvaluationCycleOptions works without notifier (backward compat)', async () => {
    const { buildEvaluationCycle } = await import('../../src/workers/google-responsiveness.worker');
    const fakeMailboxes = async () => ['test@example.com'];
    const fakeDb = (_table: string) => ({ where: () => ({ count: () => ({ first: async () => ({ count: '0' }) }) }) });
    const fakeRule = { evaluateMailbox: mockResolved({}) };

    // notifier absent — must not throw
    const run = buildEvaluationCycle(fakeMailboxes, {
      r01Enabled: false,
      r01Rule: fakeRule as never,
      r01Config: {} as never,
      r02Enabled: false,
      r02Rule: fakeRule as never,
      r02Config: {} as never,
      r03Enabled: false,
      r03Rule: fakeRule as never,
      r03Config: {} as never,
      r04Enabled: false,
      r04Rule: fakeRule as never,
      r04Config: {} as never,
      logger: { info: jest.fn() as jest.Mock, warn: jest.fn() as jest.Mock, error: jest.fn() as jest.Mock },
    }, fakeDb as never);

    await expect(run()).resolves.toMatchObject({ alertsOpened: 0, alertsClosed: 0 });
  });

  it('notifier errors are caught and do not crash the evaluation cycle', async () => {
    const { buildEvaluationCycle } = await import('../../src/workers/google-responsiveness.worker');
    const explodingNotifier: ResponsivenessNotifier = {
      processMailbox: mockRejected(new Error('SMTP down')) as unknown as ResponsivenessNotifier['processMailbox'],
      recoverPending: mockResolved(0) as unknown as ResponsivenessNotifier['recoverPending'],
    };

    const fakeMailboxes = async () => ['test@example.com'];
    const fakeDb = (_table: string) => ({ where: () => ({ count: () => ({ first: async () => ({ count: '0' }) }) }) });
    const fakeRule = { evaluateMailbox: mockResolved({}) };
    const warnFn = jest.fn() as jest.Mock;

    const run = buildEvaluationCycle(fakeMailboxes, {
      r01Enabled: false, r01Rule: fakeRule as never, r01Config: {} as never,
      r02Enabled: false, r02Rule: fakeRule as never, r02Config: {} as never,
      r03Enabled: false, r03Rule: fakeRule as never, r03Config: {} as never,
      r04Enabled: false, r04Rule: fakeRule as never, r04Config: {} as never,
      notifier: explodingNotifier,
      logger: { info: jest.fn() as jest.Mock, warn: warnFn, error: jest.fn() as jest.Mock },
    }, fakeDb as never);

    await expect(run()).resolves.toMatchObject({ alertsOpened: 0, alertsClosed: 0 });
    expect(warnFn).toHaveBeenCalledWith(expect.stringContaining('[NOTIFY]'));
  });
});
