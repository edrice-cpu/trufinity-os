/**
 * Tests for D-02a: After-Hours Voicemail & Missing Callback Detection
 * KnexD02aRule — unit tests with mock repository (no live DB, no API calls)
 */

jest.mock('../../src/database/index', () => ({ db: {} }));

import { describe, it, expect, jest } from '@jest/globals';
import { KnexD02aRule } from '../../src/modules/servicetitan/services/telecom-voicemail-callback.rule';
import type {
  D02aConfig,
  D02aRepository,
  VoicemailCandidate,
} from '../../src/modules/servicetitan/services/telecom-voicemail-callback.rule';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_SYSTEM = 'ServiceTitan:99999';

const BASE_CONFIG: D02aConfig = {
  sourceSystem: SOURCE_SYSTEM,
  businessCalendar: {
    timezone: 'America/Toronto',
    startHour: 9,
    endHour: 17,
  },
  thresholdMinutes: 240,
  lookbackDays: 14,
};

// "now": Tuesday 2026-10-06 19:00 Toronto = 23:00 UTC (after hours, well past threshold)
const NOW = new Date('2026-10-06T23:00:00.000Z');
// Monday 2026-10-05 14:00 Toronto = 18:00 UTC (business hours) — before NOW
const BUSINESS_HOUR_TIME = new Date('2026-10-05T18:00:00.000Z');
// Monday 2026-10-05 20:00 Toronto = 00:00 UTC Tue (after hours) — before NOW
const AFTER_HOURS_TIME = new Date('2026-10-06T00:00:00.000Z');
// Saturday 2026-10-04 14:00 Toronto = 18:00 UTC (weekend) — before NOW
const WEEKEND_TIME = new Date('2026-10-04T18:00:00.000Z');

// ─── Mock repository builder ──────────────────────────────────────────────────

interface UpsertCall {
  method: 'upsertOpen' | 'upsertResolved' | 'upsertUnverifiable';
  sourceId: string;
  status: string;
  callbackAt?: Date | null;
  elapsedMinutes?: number;
}

interface MockRepoState {
  candidates: VoicemailCandidate[];
  /** Source IDs of alerts in OPEN or UNVERIFIABLE state (used for re-evaluation). */
  openOrUnverifiableAlertSourceIds: string[];
  outboundCallbacks: Map<string, Date>;
  upsertCalls: UpsertCall[];
}

function buildRepo(state: MockRepoState): D02aRepository {
  return {
    loadVoicemailCandidates: async (_sourceSystem: string, _cutoff: Date) =>
      state.candidates.filter((c) => c.call_received_on >= _cutoff),

    loadCandidatesBySourceIds: async (_sourceSystem: string, sourceIds: string[]) =>
      state.candidates.filter((c) => sourceIds.includes(c.source_id)),

    loadOpenOrUnverifiableAlertSourceIds: async (_sourceSystem: string) =>
      state.openOrUnverifiableAlertSourceIds,

    loadOutboundCallbacks: async (
      _sourceSystem: string,
      _candidates: Array<{ sourceId: string; customerId: string; voicemailAt: Date }>,
      _beforeTime: Date,
    ) => state.outboundCallbacks,

    upsertOpen: async (
      _sourceSystem: string,
      candidate: VoicemailCandidate,
      elapsedMinutes: number,
      _thresholdMinutes: number,
      _now: Date,
    ) => {
      state.upsertCalls.push({
        method: 'upsertOpen',
        sourceId: candidate.source_id,
        status: 'OPEN',
        callbackAt: null,
        elapsedMinutes,
      });
    },

    upsertResolved: async (
      _sourceSystem: string,
      candidate: VoicemailCandidate,
      callbackAt: Date,
      _thresholdMinutes: number,
      _now: Date,
    ) => {
      state.upsertCalls.push({
        method: 'upsertResolved',
        sourceId: candidate.source_id,
        status: 'RESOLVED',
        callbackAt,
      });
    },

    upsertUnverifiable: async (
      _sourceSystem: string,
      candidate: VoicemailCandidate,
      _thresholdMinutes: number,
      _now: Date,
    ) => {
      state.upsertCalls.push({
        method: 'upsertUnverifiable',
        sourceId: candidate.source_id,
        status: 'UNVERIFIABLE',
        callbackAt: null,
      });
    },
  };
}

function makeState(overrides: Partial<MockRepoState> = {}): MockRepoState {
  return {
    candidates: [],
    openOrUnverifiableAlertSourceIds: [],
    outboundCallbacks: new Map(),
    upsertCalls: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KnexD02aRule — business-hours boundary', () => {
  it('does NOT create an alert for a voicemail received during business hours', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-bh', call_received_on: BUSINESS_HOUR_TIME, st_customer_id: 'cust-1' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(0);
  });

  it('does NOT create RESOLVED for a business-hours voicemail even when a callback exists (B-1 regression)', async () => {
    // Regression test for the business-hours-before-callback ordering defect.
    //
    // Previously, evaluateCandidate checked for a callback BEFORE checking whether the
    // voicemail was in business hours. A business-hours voicemail with a subsequent
    // outbound call would therefore call upsertResolved, creating a spurious DB row
    // for a call that was never in-scope for D-02a.
    //
    // Fix: isBusinessHour check now runs FIRST, causing immediate return before the
    // callback lookup. No upsert of any kind should occur for an in-hours voicemail.
    const callbackTime = new Date(BUSINESS_HOUR_TIME.getTime() + 60 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-bh-cb', call_received_on: BUSINESS_HOUR_TIME, st_customer_id: 'cust-bh-cb' }],
      outboundCallbacks: new Map([['call-bh-cb', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    // Must produce zero upserts — business-hours voicemails are entirely out of scope.
    expect(state.upsertCalls).toHaveLength(0);
  });

  it('creates OPEN for after-hours voicemail when threshold exceeded', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-ah', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-2' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);
    expect(state.upsertCalls[0]!.sourceId).toBe('call-ah');
  });

  it('does NOT create an alert when elapsed is below threshold', async () => {
    // Voicemail 30 minutes ago after-hours → elapsed << 240 min
    const recentAfterHours = new Date(NOW.getTime() - 30 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-recent', call_received_on: recentAfterHours, st_customer_id: 'cust-3' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
  });
});

describe('KnexD02aRule — weekend handling', () => {
  it('does NOT create an alert for an after-hours voicemail received only 30 minutes ago', async () => {
    const thirtyMinAgo = new Date(NOW.getTime() - 30 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-wknd', call_received_on: thirtyMinAgo, st_customer_id: 'cust-w1' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
  });

  it('creates OPEN for weekend voicemail when evaluated Monday past threshold', async () => {
    // WEEKEND_TIME = Sat 14:00 Toronto. Aging starts Mon 09:00. NOW = Mon 19:00 → ~8 biz hours.
    const state = makeState({
      candidates: [{ source_id: 'call-wknd2', call_received_on: WEEKEND_TIME, st_customer_id: 'cust-w2' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);
  });
});

describe('KnexD02aRule — UNVERIFIABLE (no st_customer_id)', () => {
  it('creates UNVERIFIABLE when no customer ID', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-anon', call_received_on: AFTER_HOURS_TIME, st_customer_id: null }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'UNVERIFIABLE')).toHaveLength(1);
    expect(state.upsertCalls[0]!.sourceId).toBe('call-anon');
  });

  it('does NOT create OPEN or RESOLVED for UNVERIFIABLE call', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-anon2', call_received_on: AFTER_HOURS_TIME, st_customer_id: null }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(0);
  });
});

describe('KnexD02aRule — callback before deadline (RESOLVED)', () => {
  it('creates RESOLVED when outbound call found after voicemail', async () => {
    const callbackTime = new Date(AFTER_HOURS_TIME.getTime() + 60 * 60 * 1000); // 1h after
    const state = makeState({
      candidates: [{ source_id: 'call-res', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-r' }],
      outboundCallbacks: new Map([['call-res', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    const resolved = state.upsertCalls.filter((c) => c.status === 'RESOLVED');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.callbackAt).toEqual(callbackTime);
  });

  it('does NOT create OPEN when callback found', async () => {
    const callbackTime = new Date(AFTER_HOURS_TIME.getTime() + 60 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-res2', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-r2' }],
      outboundCallbacks: new Map([['call-res2', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
  });

  it('does NOT create RESOLVED when outbound call is BEFORE the voicemail', async () => {
    // Outbound before voicemail must not count as a callback.
    const outboundBeforeVoicemail = new Date(AFTER_HOURS_TIME.getTime() - 60 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-preout', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-pre' }],
      outboundCallbacks: new Map([['call-preout', outboundBeforeVoicemail]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    // Pre-voicemail outbound → not a valid callback; threshold exceeded → OPEN
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(0);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);
  });
});

describe('KnexD02aRule — no callback (OPEN after deadline)', () => {
  it('creates OPEN when no outbound call found and threshold exceeded', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-open', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-o' }],
      outboundCallbacks: new Map(),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    const open = state.upsertCalls.filter((c) => c.status === 'OPEN');
    expect(open).toHaveLength(1);
    expect(open[0]!.callbackAt).toBeNull();
  });

  it('stores positive elapsed business minutes in OPEN upsert', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-elapsed', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-e' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    const open = state.upsertCalls.filter((c) => c.status === 'OPEN');
    expect(open[0]!.elapsedMinutes).toBeGreaterThan(BASE_CONFIG.thresholdMinutes);
  });
});

describe('KnexD02aRule — duplicate processing (idempotency)', () => {
  it('calls upsertOpen on each evaluation (upsert handles deduplication in DB)', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-idem', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-idem' }],
    });
    const repo = buildRepo(state);
    const rule = new KnexD02aRule(repo);
    await rule.evaluate(BASE_CONFIG, NOW);
    await rule.evaluate(BASE_CONFIG, NOW);
    // Both evaluations call upsertOpen; DB ON CONFLICT handles deduplication.
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN').length).toBe(2);
    expect(state.upsertCalls.every((c) => c.sourceId === 'call-idem')).toBe(true);
  });
});

describe('KnexD02aRule — OPEN to RESOLVED transition', () => {
  it('creates RESOLVED when callback found on subsequent evaluation', async () => {
    const callbackTime = new Date(NOW.getTime() - 30 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-trans', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-t' }],
      openOrUnverifiableAlertSourceIds: ['call-trans'],
      outboundCallbacks: new Map([['call-trans', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(1);
  });

  it('does NOT call upsertOpen when callback is present (RESOLVED takes priority)', async () => {
    // Regression test for C-1: RESOLVED row must never be downgraded to OPEN.
    // The mock simulates a row that is already RESOLVED in the DB; the rule
    // should not call upsertOpen for it when a callback is in the callbackMap.
    const callbackTime = new Date(AFTER_HOURS_TIME.getTime() + 30 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-noreg', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-noreg' }],
      outboundCallbacks: new Map([['call-noreg', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(1);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
  });
});

describe('KnexD02aRule — UNVERIFIABLE recovery (M-3 regression)', () => {
  it('transitions UNVERIFIABLE → OPEN when customer_id becomes available', async () => {
    // Simulates delayed V2 enrichment: voicemail was UNVERIFIABLE last run
    // because st_customer_id was null. On this run, the re-fetched candidate
    // has a customer_id populated — the rule must now evaluate it normally.
    // The upsertOpen WHERE clause allows status IN ('OPEN', 'UNVERIFIABLE'),
    // so the DB row transitions from UNVERIFIABLE to OPEN.
    const oldVoicemail = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000); // outside lookback
    const state = makeState({
      // candidate is re-fetched via loadCandidatesBySourceIds (outside lookback)
      // and now has a customer_id populated
      candidates: [{ source_id: 'call-unver', call_received_on: oldVoicemail, st_customer_id: 'cust-late' }],
      openOrUnverifiableAlertSourceIds: ['call-unver'],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    // No callback → threshold exceeded (15 days > 240 min) → OPEN
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);
    expect(state.upsertCalls.filter((c) => c.status === 'UNVERIFIABLE')).toHaveLength(0);
  });

  it('transitions UNVERIFIABLE → RESOLVED when customer_id arrives and callback exists', async () => {
    const oldVoicemail = new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000);
    const callbackTime = new Date(oldVoicemail.getTime() + 3 * 60 * 60 * 1000);
    const state = makeState({
      candidates: [{ source_id: 'call-unver-res', call_received_on: oldVoicemail, st_customer_id: 'cust-late2' }],
      openOrUnverifiableAlertSourceIds: ['call-unver-res'],
      outboundCallbacks: new Map([['call-unver-res', callbackTime]]),
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'RESOLVED')).toHaveLength(1);
    expect(state.upsertCalls.filter((c) => c.status === 'UNVERIFIABLE')).toHaveLength(0);
  });
});

describe('KnexD02aRule — per-voicemail callback anchor (H-1 regression)', () => {
  it('passes each voicemail as a separate candidate to loadOutboundCallbacks', async () => {
    // Verifies the rule sends one entry per voicemail (keyed by sourceId) so
    // each voicemail independently finds its subsequent outbound call.
    let capturedCandidates: Array<{ sourceId: string; customerId: string; voicemailAt: Date }> | null = null;

    const vmA = new Date('2026-10-06T01:00:00.000Z');
    const vmB = new Date('2026-10-06T02:00:00.000Z');

    const state = makeState({
      candidates: [
        { source_id: 'call-a', call_received_on: vmA, st_customer_id: 'cust-A' },
        { source_id: 'call-b', call_received_on: vmB, st_customer_id: 'cust-B' },
      ],
    });

    const captureRepo: D02aRepository = {
      ...buildRepo(state),
      loadOutboundCallbacks: async (_ss, candidates, _before) => {
        capturedCandidates = [...candidates];
        return new Map();
      },
    };

    await new KnexD02aRule(captureRepo).evaluate(BASE_CONFIG, NOW);

    expect(capturedCandidates).not.toBeNull();
    expect(capturedCandidates!).toHaveLength(2);
    const bySourceId = Object.fromEntries(capturedCandidates!.map((c) => [c.sourceId, c]));
    expect(bySourceId['call-a']?.voicemailAt).toEqual(vmA);
    expect(bySourceId['call-b']?.voicemailAt).toEqual(vmB);
  });

  it('passes two separate entries for same customer with multiple voicemails', async () => {
    // Each voicemail must be sent as its own entry with its own timestamp,
    // not collapsed into a single per-customer entry (which would prevent
    // vm2 from resolving against a callback that arrived after vm2 but
    // would have been hidden by the earlier vm1 anchor).
    let capturedCandidates: Array<{ sourceId: string; customerId: string; voicemailAt: Date }> | null = null;

    const earlier = new Date('2026-10-05T23:00:00.000Z');
    const later = new Date('2026-10-06T01:00:00.000Z');

    const state = makeState({
      candidates: [
        { source_id: 'call-vm1', call_received_on: earlier, st_customer_id: 'cust-multi' },
        { source_id: 'call-vm2', call_received_on: later, st_customer_id: 'cust-multi' },
      ],
    });

    const captureRepo: D02aRepository = {
      ...buildRepo(state),
      loadOutboundCallbacks: async (_ss, candidates, _before) => {
        capturedCandidates = [...candidates];
        return new Map();
      },
    };

    await new KnexD02aRule(captureRepo).evaluate(BASE_CONFIG, NOW);

    // Both voicemails sent separately with their own timestamps
    expect(capturedCandidates!).toHaveLength(2);
    const vm1entry = capturedCandidates!.find((c) => c.sourceId === 'call-vm1');
    const vm2entry = capturedCandidates!.find((c) => c.sourceId === 'call-vm2');
    expect(vm1entry?.voicemailAt).toEqual(earlier);
    expect(vm2entry?.voicemailAt).toEqual(later);
    // Both belong to the same customer
    expect(vm1entry?.customerId).toBe('cust-multi');
    expect(vm2entry?.customerId).toBe('cust-multi');
  });

  it('resolves vm1 and vm2 independently when same customer has two voicemails with separate callbacks', async () => {
    // Scenario: cust-X leaves vm1 at T=1, gets callback at T=2, leaves vm2 at T=3, gets callback at T=4.
    // Both voicemails should resolve: vm1 against T=2, vm2 against T=4.
    // A per-customer anchor would return T=2 for both, leaving vm2 unresolved.
    const T1 = new Date('2026-10-06T00:00:00.000Z'); // vm1 — after hours
    const T2 = new Date('2026-10-06T00:30:00.000Z'); // callback for vm1
    const T3 = new Date('2026-10-06T01:00:00.000Z'); // vm2 — after hours
    const T4 = new Date('2026-10-06T01:30:00.000Z'); // callback for vm2

    const state = makeState({
      candidates: [
        { source_id: 'call-vm1', call_received_on: T1, st_customer_id: 'cust-x' },
        { source_id: 'call-vm2', call_received_on: T3, st_customer_id: 'cust-x' },
      ],
      // Per-voicemail callbacks keyed by sourceId
      outboundCallbacks: new Map([
        ['call-vm1', T2], // earliest outbound after T1
        ['call-vm2', T4], // earliest outbound after T3
      ]),
    });

    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);

    const resolved = state.upsertCalls.filter((c) => c.status === 'RESOLVED');
    const open = state.upsertCalls.filter((c) => c.status === 'OPEN');

    // Both voicemails must resolve
    expect(resolved).toHaveLength(2);
    expect(open).toHaveLength(0);

    const vm1resolved = resolved.find((c) => c.sourceId === 'call-vm1');
    const vm2resolved = resolved.find((c) => c.sourceId === 'call-vm2');
    expect(vm1resolved?.callbackAt).toEqual(T2);
    expect(vm2resolved?.callbackAt).toEqual(T4);
  });

  it('does NOT resolve vm2 when only vm1 has a callback (T2 < T3 guard)', async () => {
    // vm1@T1 resolved by callback@T2, vm2@T3 has no subsequent outbound.
    // The mock returns T2 for vm1 and nothing for vm2 (as the DB would).
    // vm2 must become OPEN (not RESOLVED with a stale pre-vm2 callback).
    const T1 = new Date('2026-10-05T23:00:00.000Z');
    const T2 = new Date('2026-10-05T23:30:00.000Z'); // callback for vm1 only
    const T3 = new Date('2026-10-06T00:30:00.000Z'); // vm2, no callback

    const state = makeState({
      candidates: [
        { source_id: 'call-vm1b', call_received_on: T1, st_customer_id: 'cust-y' },
        { source_id: 'call-vm2b', call_received_on: T3, st_customer_id: 'cust-y' },
      ],
      // Only vm1 has a per-voicemail callback entry
      outboundCallbacks: new Map([['call-vm1b', T2]]),
    });

    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);

    const resolved = state.upsertCalls.filter((c) => c.status === 'RESOLVED');
    const open = state.upsertCalls.filter((c) => c.status === 'OPEN');

    expect(resolved.map((c) => c.sourceId)).toContain('call-vm1b');
    expect(open.map((c) => c.sourceId)).toContain('call-vm2b');
    expect(resolved.map((c) => c.sourceId)).not.toContain('call-vm2b');
  });
});

describe('KnexD02aRule — concurrency guard (M-1 regression)', () => {
  it('second evaluate() call returns immediately when first is still running', async () => {
    let resolveFirst!: () => void;
    const firstLatch = new Promise<void>((resolve) => { resolveFirst = resolve; });
    let secondStarted = false;

    const blockingRepo: D02aRepository = {
      loadVoicemailCandidates: async () => {
        await firstLatch; // hold until released
        return [];
      },
      loadCandidatesBySourceIds: async () => [],
      loadOpenOrUnverifiableAlertSourceIds: async () => [],
      loadOutboundCallbacks: async (_ss, _candidates, _before) => new Map(),
      upsertOpen: async () => undefined,
      upsertResolved: async () => undefined,
      upsertUnverifiable: async () => undefined,
    };

    const rule = new KnexD02aRule(blockingRepo);
    const first = rule.evaluate(BASE_CONFIG, NOW);

    // Second call issued while first is blocked — must return immediately without
    // entering the repository (guard fires before loadVoicemailCandidates is called).
    const second = rule.evaluate(BASE_CONFIG, NOW).then(() => { secondStarted = true; });

    // Allow second to settle (it should resolve immediately via the guard).
    await second;
    expect(secondStarted).toBe(true);

    // Release the first evaluation and verify it still completes cleanly.
    resolveFirst();
    await first;
  });
});

describe('KnexD02aRule — voicemail detection across all call types', () => {
  it.each([
    ['Abandoned call', 'call-ab', 'cust-ab'],
    ['Excused call', 'call-ex', 'cust-ex'],
    ['NotLead call', 'call-nl', 'cust-nl'],
    ['Booked call', 'call-bk', 'cust-bk'],
    ['Unbooked call', 'call-un', 'cust-un'],
  ])('detects after-hours voicemail for %s', async (_label, sourceId, customerId) => {
    // call_type is not in VoicemailCandidate — filtering is done in the DB query.
    const state = makeState({
      candidates: [{ source_id: sourceId, call_received_on: AFTER_HOURS_TIME, st_customer_id: customerId }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    expect(state.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);
  });
});

describe('KnexD02aRule — stale sync / empty candidates', () => {
  it('returns without error when no voicemail candidates exist', async () => {
    const state = makeState();
    await expect(new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW)).resolves.toBeUndefined();
  });

  it('completes without error and makes no upserts when candidate list is empty', async () => {
    const state = makeState();
    await expect(new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW)).resolves.toBeUndefined();
    expect(state.upsertCalls).toHaveLength(0);
  });

  it('propagates repository errors (caller is responsible for non-fatal wrapping)', async () => {
    const failingRepo: D02aRepository = {
      loadVoicemailCandidates: async () => { throw new Error('DB connection lost'); },
      loadCandidatesBySourceIds: async () => [],
      loadOpenOrUnverifiableAlertSourceIds: async () => [],
      loadOutboundCallbacks: async (_ss, _candidates, _before) => new Map(),
      upsertOpen: async () => undefined,
      upsertResolved: async () => undefined,
      upsertUnverifiable: async () => undefined,
    };
    await expect(new KnexD02aRule(failingRepo).evaluate(BASE_CONFIG, NOW)).rejects.toThrow('DB connection lost');
  });
});

describe('KnexD02aRule — timezone handling', () => {
  it('classifies the same UTC timestamp as after-hours in Europe/London but not in America/Toronto', async () => {
    // 2026-10-05T18:00Z = 14:00 Toronto (business hours) = 19:00 London (after hours)
    const ukConfig: D02aConfig = {
      ...BASE_CONFIG,
      businessCalendar: { timezone: 'Europe/London', startHour: 9, endHour: 17 },
    };
    const laterNow = new Date('2026-10-07T12:00:00.000Z');

    const stateUk = makeState({
      candidates: [{ source_id: 'call-uk', call_received_on: BUSINESS_HOUR_TIME, st_customer_id: 'cust-uk' }],
    });
    await new KnexD02aRule(buildRepo(stateUk)).evaluate(ukConfig, laterNow);
    expect(stateUk.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(1);

    const stateToronto = makeState({
      candidates: [{ source_id: 'call-to', call_received_on: BUSINESS_HOUR_TIME, st_customer_id: 'cust-to' }],
    });
    await new KnexD02aRule(buildRepo(stateToronto)).evaluate(BASE_CONFIG, laterNow);
    expect(stateToronto.upsertCalls.filter((c) => c.status === 'OPEN')).toHaveLength(0);
  });
});

describe('KnexD02aRule — privacy safeguards', () => {
  it('VoicemailCandidate interface contains no phone numbers, payloads, or URLs', () => {
    const candidate: VoicemailCandidate = {
      source_id: 'test',
      call_received_on: new Date(),
      st_customer_id: null,
    };
    const keys = Object.keys(candidate);
    const forbidden = ['phone', 'from', 'to', 'recording_url', 'voicemail_url', 'payload'];
    for (const field of forbidden) {
      expect(keys).not.toContain(field);
    }
  });

  it('upsert methods never receive phone, payload, or URL arguments', async () => {
    const state = makeState({
      candidates: [{ source_id: 'call-priv', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-p' }],
    });
    await new KnexD02aRule(buildRepo(state)).evaluate(BASE_CONFIG, NOW);
    for (const call of state.upsertCalls) {
      const callKeys = Object.keys(call);
      const forbidden = ['phone', 'from', 'to', 'recording_url', 'voicemail_url', 'payload'];
      for (const field of forbidden) {
        expect(callKeys).not.toContain(field);
      }
    }
  });
});

describe('KnexD02aRule — database write scope', () => {
  it('only calls repository write methods, never reads modify ingestion tables', async () => {
    const writeMethods = new Set<string>();
    const guardedRepo: D02aRepository = {
      loadVoicemailCandidates: async () => [
        { source_id: 'c1', call_received_on: AFTER_HOURS_TIME, st_customer_id: 'cust-g' },
      ],
      loadCandidatesBySourceIds: async () => [],
      loadOpenOrUnverifiableAlertSourceIds: async () => [],
      loadOutboundCallbacks: async (_ss, _candidates, _before) => new Map(),
      upsertOpen: async (_ss, candidate) => { writeMethods.add(`open:${candidate.source_id}`); },
      upsertResolved: async (_ss, candidate) => { writeMethods.add(`resolved:${candidate.source_id}`); },
      upsertUnverifiable: async (_ss, candidate) => { writeMethods.add(`unverifiable:${candidate.source_id}`); },
    };
    await new KnexD02aRule(guardedRepo).evaluate(BASE_CONFIG, NOW);
    expect(writeMethods.size).toBe(1);
    expect([...writeMethods][0]).toMatch(/^(open|resolved|unverifiable):c1$/);
  });
});
