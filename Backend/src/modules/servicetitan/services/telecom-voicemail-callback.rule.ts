/**
 * D-02a: After-Hours Voicemail & Missing Callback Detection
 *
 * Detects inbound after-hours voicemails for which no subsequent outbound
 * callback attempt was found within a configurable business-hours threshold.
 *
 * Privacy:
 *   - Operates only on persisted metadata (call timestamps, IDs, direction).
 *   - Never reads phone numbers from raw_st_calls.payload.
 *   - Never exposes voicemail URLs or recording URLs.
 *   - Callback correlation uses st_customer_id only — no phone matching.
 *
 * Lifecycle states:
 *   OPEN         — threshold exceeded, no outbound attempt found.
 *   RESOLVED     — outbound call to same customer found (evidence of attempt, not confirmed contact).
 *   UNVERIFIABLE — no st_customer_id; callback cannot be assessed.
 *
 * SLA distinction:
 *   RESOLVED with threshold_exceeded_at IS NULL  → callback found within SLA window.
 *   RESOLVED with threshold_exceeded_at NOT NULL → SLA was breached; callback arrived late.
 *   The threshold_exceeded_at value is preserved from the OPEN state on transition.
 *
 * Idempotency: unique key (source_system, source_id) — one row per voicemail call.
 * Re-evaluation is safe and repeatable. Re-running updates elapsed minutes and
 * transitions OPEN/UNVERIFIABLE → RESOLVED when a callback appears.
 *
 * UNVERIFIABLE recovery: if st_customer_id becomes available on a later V2 ingestion
 * run, re-evaluation will transition the row to OPEN or RESOLVED as appropriate.
 */

import type { Knex } from 'knex';
import { db } from '../../../database';
import { businessMinutesElapsed, isBusinessHour, nextBusinessMoment } from '../../google/business-calendar';
import type { BusinessCalendarConfig } from '../../google/business-calendar';

export interface D02aConfig {
  readonly sourceSystem: string;
  /** Business-hours calendar for after-hours determination and threshold calculation. */
  readonly businessCalendar: BusinessCalendarConfig;
  /**
   * Elapsed business minutes before an OPEN alert is raised.
   * Provisional default: 240 (4 hours). Requires client confirmation.
   */
  readonly thresholdMinutes: number;
  /**
   * Days back from `now` to scan for new voicemail candidates.
   * Bounded to prevent unbounded DB scans. Existing OPEN/UNVERIFIABLE alerts
   * outside this window are still re-evaluated for resolution.
   */
  readonly lookbackDays: number;
}

export type VoicemailAlertStatus = 'OPEN' | 'RESOLVED' | 'UNVERIFIABLE';

export interface VoicemailAlertRow {
  id: string;
  sourceSystem: string;
  sourceId: string;
  stCustomerId: string | null;
  voicemailAt: Date;
  /** Null when callback was found within SLA. Non-null when SLA was breached before resolution. */
  thresholdExceededAt: Date | null;
  thresholdMinutes: number;
  businessMinutesElapsed: number;
  status: VoicemailAlertStatus;
  callbackAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Candidate row — no phone numbers, no payload, no URLs. */
export interface VoicemailCandidate {
  source_id: string;
  call_received_on: Date;
  st_customer_id: string | null;
}

/** Repository interface for D-02a — testable without a live database. */
export interface D02aRepository {
  loadVoicemailCandidates(sourceSystem: string, lookbackCutoff: Date): Promise<VoicemailCandidate[]>;
  /**
   * Reloads candidates by source ID for alerts outside the lookback window
   * (OPEN or UNVERIFIABLE alerts that need re-evaluation).
   * Must include the voicemail URL and direction filters so stale records
   * that no longer qualify are returned with accurate field values.
   */
  loadCandidatesBySourceIds(sourceSystem: string, sourceIds: string[]): Promise<VoicemailCandidate[]>;
  /** Returns source_ids of OPEN or UNVERIFIABLE alerts for this source system. */
  loadOpenOrUnverifiableAlertSourceIds(sourceSystem: string): Promise<string[]>;
  /**
   * Finds the earliest outbound call per voicemail occurring AFTER that voicemail's
   * specific timestamp. Keyed by sourceId so each voicemail resolves independently,
   * even for a customer who left multiple voicemails on the same day.
   *
   * Example: customer A has vm1@T1 and vm2@T3, with outbounds at T2 and T4.
   *   - vm1 resolves against T2 (earliest outbound after T1).
   *   - vm2 resolves against T4 (earliest outbound after T3).
   *   A per-customer anchor would have returned T2 for both, leaving vm2 unresolved.
   *
   * Outbound call time is derived from raw_st_calls.created_on (the V2 export
   * record creation timestamp). This is an approximation: it reflects when the
   * call record entered ST's export, not the exact call-placed time. For recent
   * calls the difference is typically seconds; for late-ingested or backfilled
   * records it may be larger. Callers must treat callbackAt as a best-effort
   * timestamp and NEVER interpret it as confirmed customer contact.
   */
  loadOutboundCallbacks(
    sourceSystem: string,
    candidates: Array<{ sourceId: string; customerId: string; voicemailAt: Date }>,
    beforeTime: Date,
  ): Promise<Map<string, Date>>;
  upsertOpen(sourceSystem: string, candidate: VoicemailCandidate, elapsedMinutes: number, thresholdMinutes: number, now: Date): Promise<void>;
  upsertResolved(sourceSystem: string, candidate: VoicemailCandidate, callbackAt: Date, thresholdMinutes: number, now: Date): Promise<void>;
  upsertUnverifiable(sourceSystem: string, candidate: VoicemailCandidate, thresholdMinutes: number, now: Date): Promise<void>;
}

// ─── Knex repository implementation ──────────────────────────────────────────

export class KnexD02aRepository implements D02aRepository {
  public constructor(private readonly database: Knex = db) {}

  public async loadVoicemailCandidates(
    sourceSystem: string,
    lookbackCutoff: Date,
  ): Promise<VoicemailCandidate[]> {
    return this.database
      .select('v.source_id', 'v.call_received_on', 'r.st_customer_id')
      .from('st_calls_v3_enrichment as v')
      .leftJoin('raw_st_calls as r', function () {
        this.on('r.source_system', '=', 'v.source_system')
          .andOn('r.source_id', '=', 'v.source_id')
          .andOnVal('r.is_latest', '=', true);
      })
      .where('v.source_system', sourceSystem)
      .where('v.direction', 'Inbound')
      .whereNotNull('v.call_received_on')
      .where('v.call_received_on', '>=', lookbackCutoff)
      .whereRaw(`v.v3_payload->'leadCall'->>'voiceMailUrl' IS NOT NULL`)
      .whereRaw(`v.v3_payload->'leadCall'->>'voiceMailUrl' <> ''`) as unknown as VoicemailCandidate[];
  }

  public async loadCandidatesBySourceIds(
    sourceSystem: string,
    sourceIds: string[],
  ): Promise<VoicemailCandidate[]> {
    // Re-fetches candidates for OPEN/UNVERIFIABLE alerts outside the lookback window.
    // Direction and voicemail filters are re-applied so records that no longer qualify
    // (e.g. voiceMailUrl was cleared on re-ingestion) do not generate false alerts.
    return this.database
      .select('v.source_id', 'v.call_received_on', 'r.st_customer_id')
      .from('st_calls_v3_enrichment as v')
      .leftJoin('raw_st_calls as r', function () {
        this.on('r.source_system', '=', 'v.source_system')
          .andOn('r.source_id', '=', 'v.source_id')
          .andOnVal('r.is_latest', '=', true);
      })
      .where('v.source_system', sourceSystem)
      .where('v.direction', 'Inbound')
      .whereNotNull('v.call_received_on')
      .whereIn('v.source_id', sourceIds)
      .whereRaw(`v.v3_payload->'leadCall'->>'voiceMailUrl' IS NOT NULL`)
      .whereRaw(`v.v3_payload->'leadCall'->>'voiceMailUrl' <> ''`) as unknown as VoicemailCandidate[];
  }

  public async loadOpenOrUnverifiableAlertSourceIds(sourceSystem: string): Promise<string[]> {
    const rows: { source_id: string }[] = await this.database('telecom_voicemail_callback_alerts')
      .select('source_id')
      .where({ source_system: sourceSystem })
      .whereIn('status', ['OPEN', 'UNVERIFIABLE']);
    return rows.map((r) => r.source_id);
  }

  public async loadOutboundCallbacks(
    sourceSystem: string,
    candidates: Array<{ sourceId: string; customerId: string; voicemailAt: Date }>,
    beforeTime: Date,
  ): Promise<Map<string, Date>> {
    if (candidates.length === 0) return new Map();

    const sourceIds = candidates.map((c) => c.sourceId);
    const customerIds = candidates.map((c) => c.customerId);
    const voicemailTimes = candidates.map((c) => c.voicemailAt);

    // Per-voicemail anchor: finds the earliest outbound call AFTER each voicemail's
    // own timestamp, grouped by sourceId so two voicemails from the same customer
    // each match their own subsequent callback independently.
    //
    // created_on is the V2 export record timestamp — see interface jsdoc for accuracy notes.
    const rows: { source_id: string; min_outbound_at: Date }[] = await this.database.raw(
      `SELECT vm.source_id, MIN(r.created_on) AS min_outbound_at
       FROM raw_st_calls r
       JOIN (
         SELECT unnest(?::text[]) AS source_id,
                unnest(?::text[]) AS customer_id,
                unnest(?::timestamptz[]) AS voicemail_at
       ) vm ON r.st_customer_id = vm.customer_id
            AND r.created_on > vm.voicemail_at
       WHERE r.source_system = ?
         AND r.direction = 'Outbound'
         AND r.is_latest = true
         AND r.created_on <= ?
       GROUP BY vm.source_id`,
      [sourceIds, customerIds, voicemailTimes, sourceSystem, beforeTime],
    ).then((result: { rows: { source_id: string; min_outbound_at: Date }[] }) => result.rows);

    return new Map(rows.map((r) => [r.source_id, r.min_outbound_at]));
  }

  public async upsertOpen(
    sourceSystem: string,
    candidate: VoicemailCandidate,
    elapsedMinutes: number,
    thresholdMinutes: number,
    now: Date,
  ): Promise<void> {
    // Raw SQL upsert required because Knex's .onConflict().merge(raw) does not
    // reliably support a conditional WHERE clause on the existing row's columns.
    // The WHERE status IN ('OPEN', 'UNVERIFIABLE') guard prevents downgrading
    // a RESOLVED row. COALESCE preserves the original threshold_exceeded_at
    // timestamp (the first time the SLA was breached) across repeated evaluations.
    await this.database.raw(
      `INSERT INTO telecom_voicemail_callback_alerts
         (source_system, source_id, st_customer_id, voicemail_at,
          threshold_exceeded_at, threshold_minutes, business_minutes_elapsed,
          status, callback_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?)
       ON CONFLICT (source_system, source_id) DO UPDATE
         SET status                   = 'OPEN',
             st_customer_id           = excluded.st_customer_id,
             threshold_exceeded_at    = COALESCE(
               telecom_voicemail_callback_alerts.threshold_exceeded_at,
               excluded.threshold_exceeded_at
             ),
             business_minutes_elapsed = excluded.business_minutes_elapsed,
             updated_at               = excluded.updated_at
         WHERE telecom_voicemail_callback_alerts.status IN ('OPEN', 'UNVERIFIABLE')`,
      [
        sourceSystem, candidate.source_id, candidate.st_customer_id,
        candidate.call_received_on, now, thresholdMinutes, elapsedMinutes,
        now, now,
      ],
    );
  }

  public async upsertResolved(
    sourceSystem: string,
    candidate: VoicemailCandidate,
    callbackAt: Date,
    thresholdMinutes: number,
    now: Date,
  ): Promise<void> {
    // RESOLVED rows are never downgraded (WHERE status IN ('OPEN', 'UNVERIFIABLE')).
    // threshold_exceeded_at is kept from the existing OPEN row when present:
    //   - OPEN  → RESOLVED with existing threshold_exceeded_at preserved (SLA breach recorded).
    //   - UNVERIFIABLE → RESOLVED with NULL threshold_exceeded_at (callback within SLA).
    //   - New row (INSERT path): threshold_exceeded_at = NULL (callback found before SLA breach).
    // A RESOLVED row with threshold_exceeded_at IS NOT NULL indicates a late callback.
    await this.database.raw(
      `INSERT INTO telecom_voicemail_callback_alerts
         (source_system, source_id, st_customer_id, voicemail_at,
          threshold_exceeded_at, threshold_minutes, business_minutes_elapsed,
          status, callback_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 0, 'RESOLVED', ?, ?, ?)
       ON CONFLICT (source_system, source_id) DO UPDATE
         SET status         = 'RESOLVED',
             st_customer_id = excluded.st_customer_id,
             callback_at    = excluded.callback_at,
             threshold_exceeded_at = telecom_voicemail_callback_alerts.threshold_exceeded_at,
             updated_at     = excluded.updated_at
         WHERE telecom_voicemail_callback_alerts.status IN ('OPEN', 'UNVERIFIABLE')`,
      [
        sourceSystem, candidate.source_id, candidate.st_customer_id,
        candidate.call_received_on, thresholdMinutes, callbackAt,
        now, now,
      ],
    );
  }

  public async upsertUnverifiable(
    sourceSystem: string,
    candidate: VoicemailCandidate,
    thresholdMinutes: number,
    now: Date,
  ): Promise<void> {
    // Only written when st_customer_id is NULL. On conflict, only updated_at is
    // changed if the row is still UNVERIFIABLE. OPEN/RESOLVED rows are never
    // touched — this prevents clobbering a manual override or a race with
    // UNVERIFIABLE → OPEN transition from a concurrent evaluation that found
    // a customer_id after the NULL check.
    await this.database.raw(
      `INSERT INTO telecom_voicemail_callback_alerts
         (source_system, source_id, st_customer_id, voicemail_at,
          threshold_exceeded_at, threshold_minutes, business_minutes_elapsed,
          status, callback_at, created_at, updated_at)
       VALUES (?, ?, NULL, ?, NULL, ?, 0, 'UNVERIFIABLE', NULL, ?, ?)
       ON CONFLICT (source_system, source_id) DO UPDATE
         SET updated_at = excluded.updated_at
         WHERE telecom_voicemail_callback_alerts.status = 'UNVERIFIABLE'`,
      [
        sourceSystem, candidate.source_id, candidate.call_received_on,
        thresholdMinutes, now, now,
      ],
    );
  }
}

// ─── Rule evaluator ───────────────────────────────────────────────────────────

export interface D02aRule {
  evaluate(config: D02aConfig, now?: Date): Promise<void>;
}

export class KnexD02aRule implements D02aRule {
  // In-process guard: prevents concurrent evaluation runs within the same process.
  // A single-process deployment cannot have two cron ticks produce overlapping upserts
  // when this flag is set. The upserts are idempotent at the DB level, so a concurrent
  // run from a separate process is safe (it will write slightly different elapsed values
  // but will not corrupt status transitions).
  private evaluationRunning = false;

  public constructor(
    private readonly repository: D02aRepository = new KnexD02aRepository(),
  ) {}

  public async evaluate(config: D02aConfig, now: Date = new Date()): Promise<void> {
    if (this.evaluationRunning) return;
    this.evaluationRunning = true;
    try {
      await this.runEvaluation(config, now);
    } finally {
      this.evaluationRunning = false;
    }
  }

  private async runEvaluation(config: D02aConfig, now: Date): Promise<void> {
    const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);

    // 1. Load inbound voicemail candidates within the lookback window.
    const candidates = await this.repository.loadVoicemailCandidates(config.sourceSystem, lookbackCutoff);

    // 2. Load OPEN and UNVERIFIABLE alerts outside the lookback window for re-evaluation.
    //    OPEN alerts need callback checking; UNVERIFIABLE alerts need customer-ID recovery.
    const knownAlertSourceIds = await this.repository.loadOpenOrUnverifiableAlertSourceIds(config.sourceSystem);
    const outsideLookback = knownAlertSourceIds.filter(
      (id) => !candidates.some((c) => c.source_id === id),
    );

    let extraCandidates: VoicemailCandidate[] = [];
    if (outsideLookback.length > 0) {
      // Re-apply voicemail and direction filters so records that no longer qualify
      // (e.g. voiceMailUrl cleared on re-ingestion) are excluded naturally.
      extraCandidates = await this.repository.loadCandidatesBySourceIds(
        config.sourceSystem,
        outsideLookback,
      );
    }

    const allCandidates = [...candidates, ...extraCandidates];
    if (allCandidates.length === 0) return;

    // 3. Separate UNVERIFIABLE (no customer ID) from evaluable candidates.
    //    Candidates whose customer_id was previously NULL but is now populated
    //    (delayed V2 ingestion) will appear in `evaluable` here and transition
    //    UNVERIFIABLE → OPEN or RESOLVED via the upsert WHERE clause.
    const evaluable = allCandidates.filter((c) => c.st_customer_id !== null);
    const unverifiable = allCandidates.filter((c) => c.st_customer_id === null);

    // 4. Persist UNVERIFIABLE rows for calls without a customer ID.
    for (const candidate of unverifiable) {
      await this.repository.upsertUnverifiable(
        config.sourceSystem, candidate, config.thresholdMinutes, now,
      );
    }

    if (evaluable.length === 0) return;

    // 5. Load callbacks per voicemail: each voicemail gets its own anchor so two
    //    voicemails from the same customer independently match their own subsequent
    //    outbound call. The map is keyed by sourceId, not customerId.
    const callbackMap = await this.repository.loadOutboundCallbacks(
      config.sourceSystem,
      evaluable.map((c) => ({
        sourceId: c.source_id,
        customerId: c.st_customer_id as string,
        voicemailAt: c.call_received_on,
      })),
      now,
    );

    // 6. Evaluate each candidate.
    for (const candidate of evaluable) {
      await this.evaluateCandidate(config, candidate, callbackMap, now);
    }
  }

  private async evaluateCandidate(
    config: D02aConfig,
    candidate: VoicemailCandidate,
    callbackMap: Map<string, Date>,
    now: Date,
  ): Promise<void> {
    // Business-hours voicemails are not in scope for D-02a (after-hours only).
    // This check must run FIRST — before the callback check — so that a business-hours
    // call that happens to have a subsequent outbound call is not persisted as RESOLVED.
    // Persisting RESOLVED rows for in-hours calls would pollute the alert table with
    // entries that never had a corresponding OPEN row or SLA obligation.
    //
    // Note: if the business calendar configuration changes, a previously in-scope
    // voicemail may become out-of-scope on next evaluation. No alert is generated
    // or removed — the row simply continues to be skipped on each run.
    if (isBusinessHour(candidate.call_received_on, config.businessCalendar)) {
      return;
    }

    // callbackMap is keyed by sourceId — each voicemail has its own earliest-outbound entry.
    const callbackAt = callbackMap.get(candidate.source_id) ?? null;

    // Callback found AFTER this specific after-hours voicemail → RESOLVED.
    // The per-voicemail anchor in loadOutboundCallbacks ensures callbackAt is the
    // earliest outbound after THIS voicemail's timestamp. The > guard here provides
    // defence-in-depth (the SQL already enforces it via the JOIN condition).
    if (callbackAt !== null && callbackAt > candidate.call_received_on) {
      await this.repository.upsertResolved(
        config.sourceSystem, candidate, callbackAt, config.thresholdMinutes, now,
      );
      return;
    }

    // Compute business-minutes elapsed from the voicemail's aging start (the next
    // business moment after the call was received — covers after-hours and weekends).
    const agingStart = nextBusinessMoment(candidate.call_received_on, config.businessCalendar);
    const elapsed = businessMinutesElapsed(agingStart, now, config.businessCalendar);

    if (elapsed < config.thresholdMinutes) {
      // Still within SLA — no alert yet, nothing to update.
      return;
    }

    await this.repository.upsertOpen(
      config.sourceSystem, candidate, elapsed, config.thresholdMinutes, now,
    );
  }
}

export const d02aRule = new KnexD02aRule();
