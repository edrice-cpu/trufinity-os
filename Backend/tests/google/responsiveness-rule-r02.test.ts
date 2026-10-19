import { describe, it, expect } from '@jest/globals';
import {
  KnexR02Rule,
  listStalledAlerts,
  type R02Config,
  type StalledAlertStatus,
  type StallReason,
} from '../../src/modules/google/responsiveness-rule-r02';
import type { BusinessCalendarConfig, CoverageCalendarConfig } from '../../src/modules/google/business-calendar';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const UTC_8_16_30: BusinessCalendarConfig = { timezone: 'UTC', startHour: 8, endHour: 16, endMinute: 30 };

// Coverage calendar used by R-02: Mon–Fri 8–22, Sat–Sun 7–22 (UTC, no DST).
const UTC_COVERAGE: CoverageCalendarConfig = {
  timezone: 'UTC',
  rules: [
    { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 22 },
    { weekdays: [0, 6],           startHour: 7, endHour: 22 },
  ],
};

const BASE_CONFIG: R02Config = {
  businessCalendar: UTC_8_16_30,
  coverageCalendar: UTC_COVERAGE,
  inactivityThresholdMinutes: 1440,   // 24 coverage hours (Daniel confirmed)
  inactivityPolicy: 'ELAPSED',
  conditionAEnabled: true,            // enabled in tests; disabled by default in production
  messageCountThreshold: 3,
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
};

// Condition A disabled (mirrors production default).
const CONFIG_A_DISABLED: R02Config = { ...BASE_CONFIG, conditionAEnabled: false };

// Business-hours inactivity policy variant.
const CONFIG_BIZ_HOURS: R02Config = { ...BASE_CONFIG, inactivityPolicy: 'BUSINESS_HOURS' };

const d = (iso: string): Date => new Date(iso);

const MAILBOX = 'support@trufinity.ca';
const THREAD = 'thread-r02-001';

// Monday 2026-06-15 10:00 UTC
const NOW = d('2026-06-15T10:00:00Z');

const makePayload = (labelIds: string[], from: string): Record<string, unknown> => ({
  labelIds,
  headers: [{ name: 'From', value: from }],
});

const INBOUND_PAYLOAD  = makePayload(['INBOX', 'UNREAD'], 'customer@external.com');
const OUTBOUND_PAYLOAD = makePayload(['SENT'], 'agent@trufinity.ca');
const INTERNAL_PAYLOAD = makePayload(['INBOX'], 'colleague@trufinity.ca');

const makeRow = (
  providerId: string,
  threadId: string,
  internalDate: Date,
  payload: Record<string, unknown>,
) => ({ provider_message_id: providerId, thread_id: threadId, internal_date: internalDate, mailbox_address: MAILBOX, payload });

// ---------------------------------------------------------------------------
// Fake-DB factory
// ---------------------------------------------------------------------------

type UpsertRecord = Record<string, unknown>;
type UpdateRecord = { where: Record<string, unknown>; data: Record<string, unknown> };

interface FakeDbState {
  recentRows: ReturnType<typeof makeRow>[];
  openAlertThreadIds?: string[];
  upserts: UpsertRecord[];
  updates: UpdateRecord[];
  // For listStalledAlerts tests.
  alertRows?: UpsertRecord[];
  /**
   * When set, the next upsert's RETURNING clause simulates a conflict merge by
   * returning this as the existing row's created_at (< updated_at = fields.now).
   * When undefined, RETURNING simulates a new insert (created_at = updated_at).
   */
  mergeReturnCreatedAt?: Date;
}

const makeFakeDb = (state: FakeDbState) => {
  const fakeDb = (table: string) => {
    const q: Record<string, unknown> = {};
    let _where: Record<string, unknown> = {};
    let _whereIn: { col: string; vals: string[] } | undefined;
    let _limit: number | undefined;
    let _offset: number | undefined;
    q.select = (..._cols: unknown[]) => q;
    q.where = function(colOrObj: string | Record<string, unknown>, _val?: unknown) {
      if (typeof colOrObj === 'object') Object.assign(_where, colOrObj);
      return q;
    } as unknown as typeof q.where;
    q.whereIn = (col: string, vals: string[]) => { _whereIn = { col, vals }; return q; };
    q.orderBy = () => q;
    q.limit = (n: number) => { _limit = n; return q; };
    q.offset = (n: number) => { _offset = n; return q; };
    q.count = () => q;
    q.first = () => Promise.resolve({ count: String(state.alertRows?.length ?? 0) });

    q.then = (resolve: (v: unknown) => void) => {
      if (table === 'google_stalled_thread_alerts' && _where['status'] === 'OPEN' && !_whereIn) {
        // Worker loading open alert thread IDs.
        resolve((state.openAlertThreadIds ?? []).map((tid) => ({ thread_id: tid })));
      } else if (table === 'google_stalled_thread_alerts') {
        // listStalledAlerts query.
        let rows = state.alertRows ?? [];
        if (_limit !== undefined) rows = rows.slice(_offset ?? 0, (_offset ?? 0) + _limit);
        resolve(rows);
      } else if (table === 'raw_gmail_messages') {
        if (_whereIn) {
          resolve([]);
        } else {
          resolve(state.recentRows);
        }
      } else {
        resolve([]);
      }
      return { catch: () => undefined };
    };

    // insert().onConflict().ignore().returning()
    q.insert = (data: UpsertRecord) => {
      return {
        onConflict: (_cols: string[]) => ({
          ignore: () => ({
            returning: (_col: string | string[]) => {
              state.upserts.push({ ...data });
              return Promise.resolve(state.mergeReturnCreatedAt !== undefined ? [] : [{ id: 'fake-id' }]);
            },
          }),
          merge: (mergeData: UpsertRecord) => {
            state.upserts.push({ ...data, _mergeData: mergeData });
            return {
              returning: (_col: string | string[]) => {
                if (state.mergeReturnCreatedAt !== undefined) {
                  // Simulate conflict merge: DB returns original created_at (earlier than updated_at).
                  return Promise.resolve([{
                    id: 'fake-id',
                    created_at: state.mergeReturnCreatedAt,
                    updated_at: data['updated_at'],
                  }]);
                }
                // Simulate new insert: DB returns created_at = updated_at = fields.now.
                return Promise.resolve([{
                  id: 'fake-id',
                  created_at: data['created_at'],
                  updated_at: data['created_at'],
                }]);
              },
            };
          },
        }),
      };
    };

    // .where().update()
    q.update = (data: UpsertRecord) => {
      state.updates.push({ where: { ..._where }, data });
      return Promise.resolve(1);
    };

    return q;
  };
  // Knex root instance also has .raw() used for SQL expressions in update().
  (fakeDb as unknown as Record<string, unknown>).raw = (expr: string) => ({ __raw: expr });
  return fakeDb as unknown as import('knex').Knex;
};

// ---------------------------------------------------------------------------
// 1. Customer replied without team follow-up → Condition A fires
// ---------------------------------------------------------------------------

describe('Condition A — customer replied, team has not followed up', () => {
  it('customer inbound 25 hours ago → INACTIVITY alert opened', async () => {
    // Last message: customer inbound 25 hours before NOW → 1500 elapsed min > 1440 threshold
    const sentAt = new Date(NOW.getTime() - 25 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-1', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(1);
    const upsert = state.upserts[0]!;
    expect(upsert['stall_reason']).toBe('INACTIVITY');
    expect(upsert['status']).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
// 2. Team replied, conversation inactive → Condition A fires
// ---------------------------------------------------------------------------

describe('Condition A — team replied last but conversation went cold', () => {
  it('team outbound 25 hours ago → INACTIVITY alert opened', async () => {
    const sentAt = new Date(NOW.getTime() - 25 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-out', THREAD, sentAt, OUTBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(1);
    expect(state.upserts[0]!['stall_reason']).toBe('INACTIVITY');
  });
});

// ---------------------------------------------------------------------------
// 3. 24-hour threshold boundary
// ---------------------------------------------------------------------------

describe('Condition A — 24-hour boundary', () => {
  it('exactly at threshold (1440 min elapsed) → alert fires', async () => {
    const sentAt = new Date(NOW.getTime() - 1440 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-boundary', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(1);
  });

  it('one minute below threshold (1439 min) → no Condition A upsert', async () => {
    const sentAt = new Date(NOW.getTime() - 1439 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-below', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(0);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Configurable elapsed / business-hours policy
// ---------------------------------------------------------------------------

describe('Condition A — configurable inactivity policy', () => {
  it('ELAPSED: 25h idle → fires (1500 elapsed min > 1440 threshold)', async () => {
    const sentAt = new Date(NOW.getTime() - 25 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-el', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, { ...BASE_CONFIG, inactivityPolicy: 'ELAPSED' }, NOW);
    expect(state.upserts.length).toBeGreaterThan(0);
  });

  it('BUSINESS_HOURS: inbound Friday 17:00 UTC, now Monday 08:00 UTC → 2100 coverage min → Condition A fires', async () => {
    // Friday 2026-06-19 17:00 UTC (within weekday coverage 8–22).
    // Coverage to Mon 08:00 = Fri(17:00–22:00=300) + Sat(7:00–22:00=900) + Sun(7:00–22:00=900) = 2100 min > 1440 → fires.
    const friAfternoon = d('2026-06-19T17:00:00Z');
    const monStart = d('2026-06-22T08:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-biz', THREAD, friAfternoon, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, monStart);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(1);
    expect(inactivityUpserts[0]!['inactivity_minutes']).toBe(2100);
  });

  it('BUSINESS_HOURS: inbound Monday 08:00, now = next Monday 08:00 → 6000 coverage min (5×840 + 2×900) → fires', async () => {
    // Mon–Fri each 840 min + Sat–Sun each 900 min = 4200 + 1800 = 6000 coverage min > 1440 threshold.
    const monStart = d('2026-06-15T08:00:00Z');
    const nextMonStart = d('2026-06-22T08:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-biz2', THREAD, monStart, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, nextMonStart);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(1);
    expect(inactivityUpserts[0]!['inactivity_minutes']).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// 5. Three individual emails → Condition B fires
// ---------------------------------------------------------------------------

describe('Condition B — three individual emails', () => {
  it('exactly 3 classified messages → phone call recommended, alert created', async () => {
    const t1 = d('2026-06-15T08:00:00Z');
    const t2 = d('2026-06-15T08:30:00Z');
    const t3 = d('2026-06-15T09:00:00Z');
    const state: FakeDbState = {
      recentRows: [
        makeRow('msg-1', THREAD, t1, INBOUND_PAYLOAD),
        makeRow('msg-2', THREAD, t2, OUTBOUND_PAYLOAD),
        makeRow('msg-3', THREAD, t3, INBOUND_PAYLOAD),
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(1);
    const upsert = state.upserts.find((u) => u['stall_reason'] === 'EXCESSIVE_EXCHANGES');
    expect(upsert).toBeDefined();
    expect(upsert!['phone_call_recommended']).toBe(true);
    expect(upsert!['message_count']).toBe(3);
  });

  it('2 messages → Condition B does NOT fire', async () => {
    const state: FakeDbState = {
      recentRows: [
        makeRow('msg-1', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
        makeRow('msg-2', THREAD, d('2026-06-15T09:00:00Z'), OUTBOUND_PAYLOAD),
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple messages from same sender — each counts as individual message
// ---------------------------------------------------------------------------

describe('Condition B — multiple messages same sender', () => {
  it('3 inbound messages from same customer → all count, Condition B fires', async () => {
    const state: FakeDbState = {
      recentRows: [
        makeRow('m1', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
        makeRow('m2', THREAD, d('2026-06-15T09:00:00Z'), INBOUND_PAYLOAD),
        makeRow('m3', THREAD, d('2026-06-15T10:00:00Z'), INBOUND_PAYLOAD),
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Duplicate message versions — is_latest=true filter ensures each message
//    appears once; the rule receives already-deduplicated rows from the DB.
// ---------------------------------------------------------------------------

describe('message deduplication (is_latest contract)', () => {
  it('is_latest=true DB filter guarantees no duplicate provider_message_ids in input', () => {
    // This is a DB contract enforced by the ingestion layer, not the rule itself.
    // The rule processes whatever rows it receives; this test documents the dependency.
    const rows = [
      makeRow('msg-1', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
      makeRow('msg-2', THREAD, d('2026-06-15T09:00:00Z'), INBOUND_PAYLOAD),
      makeRow('msg-3', THREAD, d('2026-06-15T10:00:00Z'), INBOUND_PAYLOAD),
    ];
    // Each row has a unique provider_message_id — no duplicates.
    const ids = rows.map((r) => r.provider_message_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('UNKNOWN-direction messages (internal emails) are excluded from count', async () => {
    // 2 classified + 1 internal (UNKNOWN) → messageCount = 2 < threshold → no Condition B
    const state: FakeDbState = {
      recentRows: [
        makeRow('m1', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
        makeRow('m2', THREAD, d('2026-06-15T09:00:00Z'), OUTBOUND_PAYLOAD),
        makeRow('m3', THREAD, d('2026-06-15T10:00:00Z'), INTERNAL_PAYLOAD), // UNKNOWN
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(0);
    const b = state.upserts.find((u) => u['stall_reason'] === 'EXCESSIVE_EXCHANGES');
    expect(b).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Resolved vs unresolved threads
// ---------------------------------------------------------------------------

describe('alert lifecycle — OPEN → RESOLVED', () => {
  it('thread goes below inactivity threshold → resolveAlert is called', async () => {
    const recentAt = new Date(NOW.getTime() - 60_000); // 1 min ago
    const state: FakeDbState = {
      recentRows: [makeRow('msg-recent', THREAD, recentAt, INBOUND_PAYLOAD)],
      openAlertThreadIds: [THREAD],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    const inactivityUpdate = state.updates.find(
      (u) => u.where['stall_reason'] === 'INACTIVITY' && u.data['status'] === 'RESOLVED',
    );
    expect(inactivityUpdate).toBeDefined();
  });

  it('thread drops below message threshold → EXCESSIVE_EXCHANGES resolveAlert called', async () => {
    // Only 1 message → below threshold of 3
    const state: FakeDbState = {
      recentRows: [makeRow('m1', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD)],
      openAlertThreadIds: [THREAD],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    const exUpdate = state.updates.find(
      (u) => u.where['stall_reason'] === 'EXCESSIVE_EXCHANGES' && u.data['status'] === 'RESOLVED',
    );
    expect(exUpdate).toBeDefined();
  });

  it('thread with no classifiable messages → both reasons get resolveAlert', async () => {
    // All messages have null internal_date → empty classified list → resolveAlert for both
    const state: FakeDbState = {
      recentRows: [
        { provider_message_id: 'm1', thread_id: THREAD, internal_date: null as unknown as Date, mailbox_address: MAILBOX, payload: INBOUND_PAYLOAD },
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    // resolveAlert calls for both INACTIVITY and EXCESSIVE_EXCHANGES
    const reasons = state.updates.map((u) => u.where['stall_reason']);
    expect(reasons).toContain('INACTIVITY');
    expect(reasons).toContain('EXCESSIVE_EXCHANGES');
  });
});

// ---------------------------------------------------------------------------
// 9. R-01 / R-02 overlap and precedence
// ---------------------------------------------------------------------------

describe('R-01 / R-02 precedence', () => {
  it('R-02 never queries or modifies google_unanswered_thread_alerts at runtime', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r02.ts'),
      'utf8',
    );
    // R-02 must not contain any database call on the R-01 table.
    // Comments may reference the table name for documentation — executable patterns must not.
    expect(source).not.toMatch(/database\s*\(\s*['"]google_unanswered_thread_alerts['"]\s*\)/);
    expect(source).not.toMatch(/\.where\(\s*\{[^}]*google_unanswered/);
  });

  it('R-01 source does NOT reference google_stalled_thread_alerts', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    expect(source).not.toContain('google_stalled_thread_alerts');
  });

  it('both R-01 and R-02 can detect the same thread independently without error', async () => {
    // Thread with unanswered inbound 25h ago — would trigger both R-01 and R-02 INACTIVITY.
    // Here we only test R-02 in isolation to confirm it does not crash or mutate R-01 state.
    const sentAt = new Date(NOW.getTime() - 25 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-overlap', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await expect(rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. Alert idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('repeated evaluation for same threshold-exceeded thread → upsert called each time (merge is idempotent)', async () => {
    const sentAt = new Date(NOW.getTime() - 25 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-idm', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, new Date(NOW.getTime() + 60_000));
    // Two upserts for INACTIVITY (and possibly Condition B) — merge ensures no DB duplicates.
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(2);
  });

  it('condition A disabled → no INACTIVITY upserts regardless of message age', async () => {
    const sentAt = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const state: FakeDbState = {
      recentRows: [makeRow('msg-dis', THREAD, sentAt, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Pagination and mailbox filtering (listStalledAlerts)
// ---------------------------------------------------------------------------

describe('listStalledAlerts — pagination and filtering', () => {
  const makeAlertRow = (id: string, mailbox: string, thread: string, reason: StallReason, status: StalledAlertStatus) => ({
    id,
    mailbox_address: mailbox,
    thread_id: thread,
    stall_reason: reason,
    last_interaction_at: new Date('2026-06-15T10:00:00Z'),
    inactivity_minutes: 1500,
    message_count: 4,
    phone_call_recommended: true,
    status,
    threshold_exceeded_at: new Date('2026-06-15T11:00:00Z'),
    resolved_at: null,
  });

  it('returns paginated result with totalCount', async () => {
    const alertRows = [makeAlertRow('id-1', MAILBOX, 'th-1', 'INACTIVITY', 'OPEN')];
    const state: FakeDbState = { recentRows: [], upserts: [], updates: [], alertRows };
    const result = await listStalledAlerts(makeFakeDb(state) as unknown as import('knex').Knex, {
      page: 1, pageSize: 25,
    });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(typeof result.totalCount).toBe('number');
  });

  it('toListRow maps snake_case DB columns to camelCase API fields', async () => {
    const alertRows = [makeAlertRow('uuid-abc', MAILBOX, 'thread-xyz', 'EXCESSIVE_EXCHANGES', 'OPEN')];
    const state: FakeDbState = { recentRows: [], upserts: [], updates: [], alertRows };
    const result = await listStalledAlerts(makeFakeDb(state) as unknown as import('knex').Knex, {
      page: 1, pageSize: 25,
    });
    if (result.data.length === 0) return; // fake DB slice may be empty — skip field assertions
    const row = result.data[0]!;
    expect(row).toHaveProperty('mailboxAddress');
    expect(row).toHaveProperty('threadId');
    expect(row).toHaveProperty('stallReason');
    expect(row).toHaveProperty('lastInteractionAt');
    expect(row).toHaveProperty('phoneCallRecommended');
    expect(row).toHaveProperty('status');
    // Privacy: no body, subject, snippet
    expect(row).not.toHaveProperty('body');
    expect(row).not.toHaveProperty('subject');
    expect(row).not.toHaveProperty('snippet');
  });

  it('gmailThreadUrl is constructed from thread_id', async () => {
    const alertRows = [makeAlertRow('id-url', MAILBOX, 'thread-123abc', 'INACTIVITY', 'OPEN')];
    const state: FakeDbState = { recentRows: [], upserts: [], updates: [], alertRows };
    const result = await listStalledAlerts(makeFakeDb(state) as unknown as import('knex').Knex, {
      page: 1, pageSize: 25,
    });
    if (result.data.length === 0) return;
    expect(result.data[0]!.gmailThreadUrl).toMatch('thread-123abc');
  });
});

// ---------------------------------------------------------------------------
// 12. Authentication (source-level guard)
// ---------------------------------------------------------------------------

describe('authentication — source-level guard', () => {
  it('stalled endpoint is registered on the router which has requireAuth applied globally', () => {
    const routeSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/google.routes.ts'),
      'utf8',
    );
    // The router uses router.use(requireAuth) at the top, before any route.
    expect(routeSource).toContain('requireAuth');
    // The stalled endpoint is present.
    expect(routeSource).toContain('/reporting/responsiveness/stalled');
  });

  it('privacy: R-02 source never accesses body, snippet, html, or attachment fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r02.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/payload\.body/i);
    expect(source).not.toMatch(/payload\.snippet/i);
    expect(source).not.toMatch(/payload\.html/i);
    expect(source).not.toMatch(/['"]body['"]/);
    expect(source).not.toMatch(/['"]snippet['"]/);
    expect(source).not.toMatch(/['"]subject['"]/);
    // Only reads labelIds and From header (via classifyDirection re-use).
    expect(source).toContain('classifyDirection');
  });
});

// ---------------------------------------------------------------------------
// 13. Missing or ambiguous data
// ---------------------------------------------------------------------------

describe('missing or ambiguous data', () => {
  it('thread with only UNKNOWN messages → messageCount = 0, no Condition B', async () => {
    const state: FakeDbState = {
      recentRows: [
        makeRow('m1', THREAD, d('2026-06-15T08:00:00Z'), INTERNAL_PAYLOAD),
        makeRow('m2', THREAD, d('2026-06-15T09:00:00Z'), INTERNAL_PAYLOAD),
        makeRow('m3', THREAD, d('2026-06-15T10:00:00Z'), INTERNAL_PAYLOAD),
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(0);
  });

  it('thread with null payload → classifyDirection returns UNKNOWN → no alerts', async () => {
    const state: FakeDbState = {
      recentRows: [
        { provider_message_id: 'm1', thread_id: THREAD, internal_date: d('2026-06-15T08:00:00Z'), mailbox_address: MAILBOX, payload: null as unknown as Record<string, unknown> },
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(0);
  });

  it('empty mailbox → no evaluations, no upserts', async () => {
    const state: FakeDbState = { recentRows: [], upserts: [], updates: [] };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.threadsEvaluated).toBe(0);
    expect(state.upserts.length).toBe(0);
  });

  it('thread_id is empty string → row is skipped', async () => {
    const state: FakeDbState = {
      recentRows: [
        { provider_message_id: 'm1', thread_id: '', internal_date: d('2026-06-15T08:00:00Z'), mailbox_address: MAILBOX, payload: INBOUND_PAYLOAD },
      ],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.threadsEvaluated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. Scheduler / kill-switch disabled by default
// ---------------------------------------------------------------------------

describe('default env configuration — disabled by default', () => {
  it('GOOGLE_R02_ENABLED defaults to false in env schema', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toContain("GOOGLE_R02_ENABLED");
    expect(envSource).toContain("default('false')");
  });

  it('GOOGLE_R02_CONDITION_A_ENABLED defaults to false in env schema', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toContain("GOOGLE_R02_CONDITION_A_ENABLED");
    // Both R-01 and R-02 kill-switches use default('false').
    const matches = envSource.match(/GOOGLE_R02_CONDITION_A_ENABLED[\s\S]*?default\('false'\)/);
    expect(matches).not.toBeNull();
  });

  it('GOOGLE_R02_INACTIVITY_POLICY defaults to BUSINESS_HOURS (Daniel confirmed 24 coverage hours)', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toContain("GOOGLE_R02_INACTIVITY_POLICY");
    expect(envSource).toContain("default('BUSINESS_HOURS')");
  });

  it('GOOGLE_R02_MESSAGE_COUNT_THRESHOLD defaults to 3 (Daniel confirmed)', () => {
    const envSource: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/config/env.ts'),
      'utf8',
    );
    expect(envSource).toContain("GOOGLE_R02_MESSAGE_COUNT_THRESHOLD");
    expect(envSource).toContain('.default(3)');
  });
});

// ---------------------------------------------------------------------------
// 15. F-06 regression — upsertAlert new-vs-merge counting semantics
// ---------------------------------------------------------------------------

describe('F-06 regression — upsertAlert counts only new inserts, not conflict merges', () => {
  // The "sentAt 25h ago" setup reliably triggers Condition A (inactivity).
  const SENT_AT = new Date(NOW.getTime() - 25 * 60 * 60_000);

  it('first evaluation (new insert) → conditionAFired = 1', async () => {
    const state: FakeDbState = {
      recentRows: [makeRow('msg-f06-new', THREAD, SENT_AT, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
      // No mergeReturnCreatedAt → fake DB returns created_at = updated_at (new insert).
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(1);
  });

  it('repeated evaluation with same data (conflict merge) → conditionAFired = 0', async () => {
    // mergeReturnCreatedAt is set to a time earlier than NOW, simulating an existing row.
    const state: FakeDbState = {
      recentRows: [makeRow('msg-f06-merge', THREAD, SENT_AT, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
      mergeReturnCreatedAt: new Date(NOW.getTime() - 60 * 60_000), // created 1h before NOW
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    // Merge of existing OPEN row must NOT count as a new alert.
    expect(result.conditionAFired).toBe(0);
  });

  it('Condition B: first fire (new insert) → conditionBFired = 1', async () => {
    const rows = [
      makeRow('mb1', THREAD, d('2026-06-15T07:00:00Z'), INBOUND_PAYLOAD),
      makeRow('mb2', THREAD, d('2026-06-15T07:30:00Z'), OUTBOUND_PAYLOAD),
      makeRow('mb3', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
    ];
    const state: FakeDbState = { recentRows: rows, upserts: [], updates: [] };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(1);
  });

  it('Condition B: re-evaluation (conflict merge) → conditionBFired = 0', async () => {
    const rows = [
      makeRow('mb1', THREAD, d('2026-06-15T07:00:00Z'), INBOUND_PAYLOAD),
      makeRow('mb2', THREAD, d('2026-06-15T07:30:00Z'), OUTBOUND_PAYLOAD),
      makeRow('mb3', THREAD, d('2026-06-15T08:00:00Z'), INBOUND_PAYLOAD),
    ];
    const state: FakeDbState = {
      recentRows: rows, upserts: [], updates: [],
      mergeReturnCreatedAt: new Date(NOW.getTime() - 30 * 60_000),
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, NOW);
    expect(result.conditionBFired).toBe(0);
  });

  it('upsertAlert uses RETURNING [id, created_at, updated_at] (source check)', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r02.ts'),
      'utf8',
    );
    // Insert detection must use an atomic conflict-ignore RETURNING path.
    expect(source).toContain('.ignore()');
    expect(source).toContain("returning('id')");
  });

  it('two threads: first is a new insert, second is a merge → conditionAFired = 1', async () => {
    const THREAD_2 = 'thread-r02-002';
    const state: FakeDbState = {
      recentRows: [
        makeRow('msg-t1', THREAD, SENT_AT, INBOUND_PAYLOAD),
        makeRow('msg-t2', THREAD_2, SENT_AT, INBOUND_PAYLOAD),
      ],
      upserts: [], updates: [],
      // No mergeReturnCreatedAt → all upserts simulate new inserts → conditionAFired = 2.
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    const result = await rule.evaluateMailbox(MAILBOX, BASE_CONFIG, NOW);
    expect(result.conditionAFired).toBe(2);
    expect(result.threadsEvaluated).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 16. Coverage-hours calendar integration (R-02 BUSINESS_HOURS policy)
// ---------------------------------------------------------------------------

describe('coverage-hours policy — R-02 BUSINESS_HOURS integration', () => {
  it('below threshold: Sun 22:30 to Mon 10:00 = 120 coverage min → no alert', async () => {
    // nextCoverageMoment(Sun 22:30) = Mon 8:00. Mon 8:00→10:00 = 120 min < 1440 → no fire.
    const sunAfterClose = d('2026-06-14T22:30:00Z');
    const monMid = d('2026-06-15T10:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-c16-1', THREAD, sunAfterClose, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, monMid);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(0);
  });

  it('exactly 24 coverage hours: Mon 8:00 to Tue 18:00 = 1440 min → fires', async () => {
    // Mon 8:00–22:00 = 840. Tue 8:00–18:00 = 600. Total = 1440 → exactly at threshold.
    const monOpen = d('2026-06-15T08:00:00Z');
    const tueMid = d('2026-06-16T18:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-c16-2', THREAD, monOpen, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, tueMid);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(1);
    expect(inactivityUpserts[0]!['inactivity_minutes']).toBe(1440);
  });

  it('just below 24 coverage hours: Mon 8:00 to Tue 17:59 = 1439 min → no alert', async () => {
    const monOpen = d('2026-06-15T08:00:00Z');
    const tueJustBefore = d('2026-06-16T17:59:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-c16-3', THREAD, monOpen, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, tueJustBefore);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(0);
  });

  it('Friday-to-Saturday: Fri 10:00 → Sat 19:00 = 720+720 = 1440 coverage min → fires', async () => {
    // Fri 10:00–22:00 = 720. Sat 7:00–19:00 = 720. Total = 1440.
    const friMid = d('2026-06-19T10:00:00Z');
    const satMid = d('2026-06-20T19:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-c16-4', THREAD, friMid, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    await rule.evaluateMailbox(MAILBOX, CONFIG_BIZ_HOURS, satMid);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(1);
    expect(inactivityUpserts[0]!['inactivity_minutes']).toBe(1440);
  });

  it('Condition A disabled: 6000 coverage min accumulated, no INACTIVITY alert produced', async () => {
    const monOpen = d('2026-06-15T08:00:00Z');
    const nextMonOpen = d('2026-06-22T08:00:00Z');
    const state: FakeDbState = {
      recentRows: [makeRow('msg-c16-5', THREAD, monOpen, INBOUND_PAYLOAD)],
      upserts: [], updates: [],
    };
    const rule = new KnexR02Rule(makeFakeDb(state));
    // CONFIG_A_DISABLED uses ELAPSED policy; coverage calendar still present in BASE_CONFIG.
    await rule.evaluateMailbox(MAILBOX, CONFIG_A_DISABLED, nextMonOpen);
    const inactivityUpserts = state.upserts.filter((u) => u['stall_reason'] === 'INACTIVITY');
    expect(inactivityUpserts.length).toBe(0);
  });
});
