/**
 * R-01 Emergency Classification Tests
 *
 * Covers:
 * - Emergency message detected → 25-minute threshold applied
 * - Non-emergency classification → standard 4-hour threshold applies
 * - Missing classification → safe default (standard threshold)
 * - Low-confidence emergency → standard threshold (not enough confidence)
 * - Classification from untrusted prompt version → ignored (standard threshold)
 * - Emergency classification disabled (kill-switch) → always standard threshold
 * - Emergency threshold at boundary (exactly 25 min) → alert fires
 * - Emergency threshold just below boundary (24 min) → no alert
 * - Privacy: isEmergencyClassified never touches body/snippet/html fields
 * - Layer B compatibility: existing classification workflow unchanged
 */

import { describe, it, expect } from '@jest/globals';
import { KnexR01Rule, type R01Config } from '../../src/modules/google/responsiveness-rule-r01';
import type { BusinessCalendarConfig } from '../../src/modules/google/business-calendar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UTC_9_17: BusinessCalendarConfig = { timezone: 'UTC', startHour: 9, endHour: 17 };

const BASE_EMERGENCY_CONFIG: R01Config = {
  businessCalendar: UTC_9_17,
  thresholdMinutes: 240,               // 4-hour standard threshold
  workspaceDomain: 'trufinity.ca',
  lookbackDays: 30,
  emergencyClassificationEnabled: true,
  emergencyThresholdMinutes: 25,       // Daniel confirmed
  emergencyConfidenceThreshold: 0.9,
  emergencyTrustedPromptVersions: ['v2'],
};

const BASE_EMERGENCY_DISABLED: R01Config = {
  ...BASE_EMERGENCY_CONFIG,
  emergencyClassificationEnabled: false,
};

const d = (iso: string): Date => new Date(iso);

const MAILBOX = 'support@trufinity.ca';
const THREAD = 'thread-emg-001';
const MSG_INBOUND = 'msg-inbound-emg';

// Monday 2026-06-15 09:30 UTC — within business hours (9:00–17:00 UTC)
const NOW_30_MIN = d('2026-06-15T09:30:00Z'); // 30 min after open = 30 biz min elapsed
const NOW_25_MIN = d('2026-06-15T09:25:00Z'); // 25 min after open = 25 biz min elapsed
const NOW_24_MIN = d('2026-06-15T09:24:00Z'); // 24 min after open = 24 biz min elapsed
const NOW_4H_PLUS = d('2026-06-15T14:00:00Z'); // 9:00 → 14:00 = 300 biz min

// Inbound message received at business open on Monday
const INBOUND_AT_OPEN = {
  provider_message_id: MSG_INBOUND,
  thread_id: THREAD,
  internal_date: d('2026-06-15T09:00:00Z'),
  mailbox_address: MAILBOX,
  payload: {
    labelIds: ['INBOX', 'UNREAD'],
    headers: [{ name: 'From', value: 'customer@external.com' }],
  },
};

// ---------------------------------------------------------------------------
// Fake DB factory — extends standard R-01 fake DB with classification table
// ---------------------------------------------------------------------------

interface ClassificationRow {
  classification_label: string;
  confidence: number;
}

interface FakeDbOpts {
  recentRows?: typeof INBOUND_AT_OPEN[];
  openAlertThreadIds?: string[];
  classificationRow?: ClassificationRow | null;
  captureInsert?: (table: string, data: Record<string, unknown>) => void;
  captureUpdate?: (table: string, where: Record<string, unknown>, data: Record<string, unknown>) => void;
}

const makeFakeDb = (opts: FakeDbOpts) => {
  const fakeDb = (table: string) => {
    const q: Record<string, unknown> = {};
    let _where: Record<string, unknown> = {};
    let _whereIn: { col: string; vals: unknown[] } | undefined;

    q.select = (..._cols: unknown[]) => q;
    q.where = function (colOrObj: string | Record<string, unknown>) {
      if (typeof colOrObj === 'object') Object.assign(_where, colOrObj);
      return q;
    } as unknown as typeof q.where;
    q.whereIn = (col: string, vals: unknown[]) => { _whereIn = { col, vals }; return q; };
    q.orderBy = () => q;
    q.limit = () => q;

    q.first = () => {
      if (table === 'email_classification_results') {
        return Promise.resolve(opts.classificationRow ?? undefined);
      }
      return Promise.resolve(undefined);
    };

    q.then = (resolve: (v: unknown) => void) => {
      if (table === 'google_unanswered_thread_alerts' && _where['status'] === 'OPEN' && !_whereIn) {
        resolve((opts.openAlertThreadIds ?? []).map((tid) => ({ thread_id: tid })));
      } else if (table === 'raw_gmail_messages') {
        if (_whereIn) {
          resolve([]);
        } else {
          resolve(opts.recentRows ?? []);
        }
      } else {
        resolve([]);
      }
      return { catch: () => undefined };
    };

    q.update = (data: Record<string, unknown>) => {
      opts.captureUpdate?.(table, _where, data);
      return Promise.resolve(1);
    };

    q.insert = (data: Record<string, unknown>) => ({
      onConflict: (_cols: string[]) => ({
        merge: (mergeData: Record<string, unknown>) => {
          opts.captureInsert?.(table, { ...data, _mergeData: mergeData });
          return Promise.resolve();
        },
      }),
    });

    return q;
  };
  return fakeDb as unknown as import('knex').Knex;
};

// ---------------------------------------------------------------------------
// 1. Emergency detected → 25-minute threshold
// ---------------------------------------------------------------------------

describe('R-01 emergency classification — threshold selection', () => {
  it('emergency: confidence >= 0.9, trusted prompt → 25-min threshold applied, alert fires at 25 min', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.95 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_25_MIN);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['status']).toBe('OPEN');
    expect(insertedData!['threshold_minutes']).toBe(25);
    expect(insertedData!['business_minutes_elapsed']).toBe(25);
  });

  it('emergency: 24 elapsed biz min (< 25-min threshold) → no alert yet', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.95 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_24_MIN);
    expect(insertCalled).toBe(false);
  });

  it('non-emergency label → standard 4-hour threshold; 30 min elapsed → no alert', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'complaint', confidence: 0.92 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_30_MIN);
    expect(insertCalled).toBe(false);
  });

  it('non-emergency label → standard threshold; 300 min elapsed → alert fires with thresholdMinutes=240', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'complaint', confidence: 0.92 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_4H_PLUS);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['threshold_minutes']).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// 2. Missing or disabled classification → safe default
// ---------------------------------------------------------------------------

describe('R-01 emergency classification — missing / disabled', () => {
  it('no classification row exists → safe default: standard threshold, no false-positive', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: null,
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    // Only 30 min elapsed < 240 standard threshold → no alert
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_30_MIN);
    expect(insertCalled).toBe(false);
  });

  it('kill-switch disabled → always uses standard threshold even with emergency row', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.99 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    // 25 min elapsed — would fire under emergency threshold but not under standard
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_DISABLED, NOW_25_MIN);
    expect(insertCalled).toBe(false);
  });

  it('kill-switch disabled → standard threshold fires normally at 300 min', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.99 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_DISABLED, NOW_4H_PLUS);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['threshold_minutes']).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// 3. Confidence threshold
// ---------------------------------------------------------------------------

describe('R-01 emergency classification — confidence threshold', () => {
  it('confidence exactly at threshold (0.9) → emergency fires', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.9 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_25_MIN);
    expect(insertedData).not.toBeNull();
    expect(insertedData!['threshold_minutes']).toBe(25);
  });

  it('confidence below threshold (0.89) → standard threshold used; 25 min → no alert', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.89 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_25_MIN);
    expect(insertCalled).toBe(false);
  });

  it('confidence = 0 → standard threshold; 25 min → no alert', async () => {
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_25_MIN);
    expect(insertCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Historical / prompt-version trust
// ---------------------------------------------------------------------------

describe('R-01 emergency classification — prompt version trust', () => {
  it('empty trustedPromptVersions list → no emergency detection regardless of label', async () => {
    let insertCalled = false;
    const configNoVersions: R01Config = {
      ...BASE_EMERGENCY_CONFIG,
      emergencyTrustedPromptVersions: [],
    };
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.99 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, configNoVersions, NOW_25_MIN);
    expect(insertCalled).toBe(false);
  });

  it('source: isEmergencyClassified only queries trusted prompt versions (whereIn guard)', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    // The lookup must include whereIn on prompt_version to filter untrusted versions
    expect(source).toContain('whereIn');
    expect(source).toContain('prompt_version');
    expect(source).toContain('emergencyTrustedPromptVersions');
  });

  it('historical classification note is documented in R01Config source', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    expect(source).toContain('BACKFILL');
  });
});

// ---------------------------------------------------------------------------
// 5. Layer B compatibility — existing classification infrastructure unchanged
// ---------------------------------------------------------------------------

describe('Layer B compatibility', () => {
  it('email-classifier.ts includes emergency in label set', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/email-classifier.ts'),
      'utf8',
    );
    expect(source).toContain("'emergency'");
  });

  it('anthropic-email-classifier.ts system prompt includes emergency label and definition', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/anthropic-email-classifier.ts'),
      'utf8',
    );
    expect(source).toContain('emergency');
    // Safety: prompt must not equate ordinary complaints with emergencies
    expect(source).toContain('Do NOT use for ordinary complaints');
  });

  it('parseEmailClassification accepts emergency label', () => {
    const { parseEmailClassification } = require('../../src/modules/google/email-classifier');
    expect(() => parseEmailClassification({
      label: 'emergency',
      confidence: 0.95,
      reason: 'Customer reports active gas leak in the building.',
    })).not.toThrow();
  });

  it('parseEmailClassification rejects unknown labels (backward compat)', () => {
    const { parseEmailClassification } = require('../../src/modules/google/email-classifier');
    expect(() => parseEmailClassification({
      label: 'fire_hazard',    // not a valid label
      confidence: 0.9,
      reason: 'Fire reported.',
    })).toThrow();
  });

  it('R-01 never calls the Anthropic classifier (source guard)', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    // Must not import or instantiate the classifier
    expect(source).not.toContain('AnthropicEmailClassifier');
    expect(source).not.toContain('emailClassifier');
    expect(source).not.toContain('classify(');
    expect(source).not.toContain('anthropic-email-classifier');
  });

  it('R-01 never INSERTs or UPDATEs email_classification_results', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/email_classification_results['"]?\s*\)\s*\.insert/);
    expect(source).not.toMatch(/email_classification_results['"]?\s*\)\s*\.update/);
  });
});

// ---------------------------------------------------------------------------
// 6. Privacy guard — emergency path reads only classification metadata
// ---------------------------------------------------------------------------

describe('R-01 emergency — privacy', () => {
  it('isEmergencyClassified SELECTs only classification_label and confidence — no body/content fields', () => {
    const source: string = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/responsiveness-rule-r01.ts'),
      'utf8',
    );
    // The classification results table has no body/snippet/subject/html anyway,
    // but confirm the source does not attempt to access them.
    expect(source).not.toMatch(/classification_results.*body/i);
    expect(source).not.toMatch(/classification_results.*snippet/i);
    expect(source).not.toMatch(/classification_results.*subject/i);
    // Only selects label and confidence
    expect(source).toContain('classification_label');
    expect(source).toContain('confidence');
  });

  it('inserted alert data contains no body, snippet, subject, html fields', async () => {
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [INBOUND_AT_OPEN],
      classificationRow: { classification_label: 'emergency', confidence: 0.95 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, NOW_25_MIN);
    expect(insertedData).not.toBeNull();
    expect(insertedData).not.toHaveProperty('body');
    expect(insertedData).not.toHaveProperty('snippet');
    expect(insertedData).not.toHaveProperty('subject');
    expect(insertedData).not.toHaveProperty('html');
  });
});

// ---------------------------------------------------------------------------
// 7. Emergency with overnight boundary — business-hours clock still applies
// ---------------------------------------------------------------------------

describe('R-01 emergency — business-hours clock preserved', () => {
  it('emergency inbound outside business hours — aging starts at next opening', async () => {
    // Inbound Sunday 22:00 UTC. Now = Monday 09:10 UTC (10 min after open).
    // Emergency threshold = 25 min. 10 elapsed biz min < 25 → no alert.
    const sunInbound = {
      ...INBOUND_AT_OPEN,
      internal_date: d('2026-06-14T22:00:00Z'),
    };
    let insertCalled = false;
    const db = makeFakeDb({
      recentRows: [sunInbound],
      classificationRow: { classification_label: 'emergency', confidence: 0.95 },
      captureInsert: () => { insertCalled = true; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, d('2026-06-15T09:10:00Z'));
    expect(insertCalled).toBe(false);
  });

  it('emergency inbound outside hours — 30 biz min elapsed > 25-min threshold → fires', async () => {
    const sunInbound = {
      ...INBOUND_AT_OPEN,
      internal_date: d('2026-06-14T22:00:00Z'),
    };
    let insertedData: Record<string, unknown> | null = null;
    const db = makeFakeDb({
      recentRows: [sunInbound],
      classificationRow: { classification_label: 'emergency', confidence: 0.95 },
      captureInsert: (_t, data) => { insertedData = data; },
    });
    const rule = new KnexR01Rule(db);
    await rule.evaluateMailbox(MAILBOX, BASE_EMERGENCY_CONFIG, d('2026-06-15T09:30:00Z'));
    expect(insertedData).not.toBeNull();
    expect(insertedData!['threshold_minutes']).toBe(25);
    expect(insertedData!['business_minutes_elapsed']).toBe(30);
  });
});
