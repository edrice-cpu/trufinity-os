import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

// ─── Data shapes ──────────────────────────────────────────────────────────────

export interface D02DayResult {
  localDate: string;     // YYYY-MM-DD in the configured timezone
  totalCount: number;    // Abandoned+Inbound calls on that local day
  dayStartUtc: Date;     // UTC instant corresponding to midnight (local)
  dayEndUtc: Date;       // UTC instant corresponding to the next midnight (local)
}

export interface D02HourlyBucket {
  hour: number;          // 0–23 in the configured timezone
  count: number;
}

// ─── Repository interface (injectable for tests) ──────────────────────────────

export interface D02Repository {
  // Returns days within [from, to) where Abandoned Inbound count > threshold.
  getDailyAbandonedCounts(
    sourceSystem: string,
    timezone: string,
    from: Date,
    to: Date,
    threshold: number,
  ): Promise<D02DayResult[]>;

  // Returns the count of Abandoned Inbound calls per local hour for a single day.
  getHourlyBreakdown(
    sourceSystem: string,
    timezone: string,
    dayStartUtc: Date,
    dayEndUtc: Date,
  ): Promise<D02HourlyBucket[]>;
}

// ─── Knex implementation ──────────────────────────────────────────────────────

export class KnexD02Repository implements D02Repository {
  public constructor(private readonly database: Knex = db) {}

  public async getDailyAbandonedCounts(
    sourceSystem: string,
    timezone: string,
    from: Date,
    to: Date,
    threshold: number,
  ): Promise<D02DayResult[]> {
    // Groups ST-classified Abandoned Inbound calls by local calendar day.
    // PostgreSQL's AT TIME ZONE handles DST transitions correctly.
    // day_start_utc / day_end_utc are the UTC bounds of each local calendar day.
    //
    // Scope: call_type = 'Abandoned' AND direction = 'Inbound'.
    // This is ServiceTitan's own classification — callers who entered the phone
    // system but disconnected before being answered. It does NOT cover ring-level
    // missed calls that never reached ServiceTitan (those require Dialpad).
    const result = await this.database.raw<{
      rows: Array<{
        local_date: string;
        total_count: number;
        day_start_utc: Date;
        day_end_utc: Date;
      }>;
    }>(
      `
      WITH calls AS (
        SELECT
          (call_received_on AT TIME ZONE ?)::date AS local_date
        FROM st_calls_v3_enrichment
        WHERE source_system = ?
          AND call_type = 'Abandoned'
          AND direction  = 'Inbound'
          AND call_received_on IS NOT NULL
          AND call_received_on >= ?
          AND call_received_on <  ?
      ),
      daily AS (
        SELECT local_date, COUNT(*)::int AS total_count
        FROM   calls
        GROUP  BY local_date
        HAVING COUNT(*) > ?
      )
      SELECT
        local_date::text                                                          AS local_date,
        total_count,
        (local_date::text || ' 00:00:00')::timestamp AT TIME ZONE ?              AS day_start_utc,
        (local_date::text || ' 00:00:00')::timestamp AT TIME ZONE ?
          + INTERVAL '1 day'                                                      AS day_end_utc
      FROM  daily
      ORDER BY local_date ASC
      `,
      [timezone, sourceSystem, from.toISOString(), to.toISOString(), threshold, timezone, timezone],
    );

    return result.rows.map((r) => ({
      localDate: r.local_date,
      totalCount: r.total_count,
      dayStartUtc: new Date(r.day_start_utc),
      dayEndUtc: new Date(r.day_end_utc),
    }));
  }

  public async getHourlyBreakdown(
    sourceSystem: string,
    timezone: string,
    dayStartUtc: Date,
    dayEndUtc: Date,
  ): Promise<D02HourlyBucket[]> {
    const result = await this.database.raw<{
      rows: Array<{ hour: number; count: number }>;
    }>(
      `
      SELECT
        EXTRACT(HOUR FROM call_received_on AT TIME ZONE ?)::int AS hour,
        COUNT(*)::int                                            AS count
      FROM   st_calls_v3_enrichment
      WHERE  source_system = ?
        AND  call_type     = 'Abandoned'
        AND  direction     = 'Inbound'
        AND  call_received_on IS NOT NULL
        AND  call_received_on >= ?
        AND  call_received_on <  ?
      GROUP  BY 1
      ORDER  BY 1
      `,
      [timezone, sourceSystem, dayStartUtc.toISOString(), dayEndUtc.toISOString()],
    );

    return result.rows.map((r) => ({ hour: r.hour, count: r.count }));
  }
}

// ─── Rule evaluation ──────────────────────────────────────────────────────────

// D-02 (RED): Fires one DetectedAlertFinding per local calendar day within the
// evaluation window where Abandoned Inbound call count strictly exceeds the
// configured daily threshold.
//
// Idempotency: each finding's unique key is:
//   (rule_code='D-02', dimension=YYYY-MM-DD, period_start=UTC-day-start)
// The DetectService persists findings via ON CONFLICT DO UPDATE, so repeated
// evaluations for the same day replace rather than duplicate the finding.
//
// Incomplete-sync guard: the evaluation window is capped at
//   periodEnd - DETECT_D02_SYNC_BUFFER_HOURS
// so the current ongoing day (or a partially-synced recent day) is excluded,
// preventing false alerts from calls that the V3 sync has not yet ingested.
//
// Early exits (return []):
//   - DETECT_D02_ENABLED = false (kill-switch)
//   - DETECT_D02_DAILY_THRESHOLD = 0 (unconfigured; requires Daniel's confirmation)
//
// Scope note: 'Abandoned' is ServiceTitan's own call_type for callers who
// disconnected before being answered. This does NOT cover ring-level missed
// calls that never entered the ServiceTitan phone system — those require Dialpad.
export async function evaluateAbandonedCallThreshold(
  window: DetectionWindow,
  database: Knex = db,
  repository: D02Repository = new KnexD02Repository(database),
): Promise<DetectedAlertFinding[]> {
  if (!env.DETECT_D02_ENABLED) return [];
  if (env.DETECT_D02_DAILY_THRESHOLD <= 0) return [];

  const sourceSystem = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;
  const timezone = env.DETECT_D02_TIMEZONE;
  const threshold = env.DETECT_D02_DAILY_THRESHOLD;

  // Cap the upper bound to exclude the current partial day and any day whose
  // V3 sync may not have completed yet.
  const syncSafeCutoff = new Date(
    window.periodEnd.getTime() - env.DETECT_D02_SYNC_BUFFER_HOURS * 3_600_000,
  );

  // No days to evaluate if the buffer pushes the cutoff before the window start.
  if (syncSafeCutoff <= window.periodStart) return [];

  const days = await repository.getDailyAbandonedCounts(
    sourceSystem,
    timezone,
    window.periodStart,
    syncSafeCutoff,
    threshold,
  );

  if (days.length === 0) return [];

  const findings: DetectedAlertFinding[] = [];

  for (const day of days) {
    const byHour = await repository.getHourlyBreakdown(
      sourceSystem,
      timezone,
      day.dayStartUtc,
      day.dayEndUtc,
    );

    findings.push({
      ruleCode: 'D-02',
      // dimension = local calendar date: unique per day within a source system.
      // Combined with period_start (UTC day start), this forms the idempotency key.
      dimension: day.localDate,
      periodStart: day.dayStartUtc,
      periodEnd: day.dayEndUtc,
      baselineStart: null,                // D-02 is threshold-based, not trend-based
      baselineEnd: null,
      metricValue: day.totalCount,        // actual daily Abandoned count
      baselineValue: threshold,           // threshold carried for narrative context
      details: {
        localDate: day.localDate,
        timezone,
        dailyThreshold: threshold,
        totalAbandonedCalls: day.totalCount,
        byHour,
        // Scope annotation: narrate layer should not label this as full missed-call coverage
        dataSource: 'ServiceTitan:Telecom:Abandoned',
        scopeNote: 'ST-classified Abandoned (caller disconnected before answer). Ring-level missed calls require Dialpad.',
      },
    });
  }

  return findings;
}
