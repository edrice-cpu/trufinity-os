import { db } from '../../../database';
import { env } from '../../../config/env';
import { logger } from '../../../utils/logger';
import { apiClient } from '../api.client';
import { isNetworkError, retryDelayMs } from './telecom-calls.ingestion';

// Source system key scoped to tenant — same convention as raw_st_calls
const SOURCE_SYSTEM = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

// Entity type stored in raw_sync_metadata — distinct from V2 'TelecomCall'
const ENTITY_TYPE = 'TelecomCallV3';

// Endpoint for V3 calls API
const V3_ENDPOINT = `/telecom/v3/tenant/${env.SERVICETITAN_TENANT_ID}/calls`;

// Historical window start — same anchor as V2 Export ingestion
const DEFAULT_HISTORICAL_FROM = env.SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM;

// V3 page size — 100 is a safe balance between round-trip count and response size
const PAGE_SIZE = 100;

// Bounded retries (same policy as V2 Export service)
const MAX_TRANSIENT_ATTEMPTS = 3;

// Hard ceiling on pages per run. Each page holds PAGE_SIZE=100 records, so
// 10,000 pages = 1,000,000 records. Exceeding this on an incremental window
// indicates a pagination bug or a catastrophically large result set — abort
// rather than loop indefinitely.
const MAX_PAGES_PER_RUN = 10_000;

// ─── V3 API response shapes ──────────────────────────────────────────────────

export interface V3LeadCall {
  id: number;
  createdOn?: string | null;
  modifiedOn?: string | null;
  receivedOn?: string | null;
  direction?: string | null;
  callType?: string | null;
  duration?: string | null;
  reason?: string | null;
  active?: boolean | null;
  sid?: string | null;
  agent?: { id?: number | null; name?: string | null } | null;
  campaign?: { id?: number | null } | null;
  tags?: unknown[] | null;
  // from/to phone numbers and recording/voicemail URLs are present in the payload
  // but never extracted to indexed columns — stored only in v3_payload JSONB,
  // consistent with raw_st_calls.payload privacy policy.
  from?: unknown;
  to?: unknown;
  recordingUrl?: unknown;
  voiceMailUrl?: unknown;
}

export interface V3Bundle {
  id: number;          // always 0 — meaningless; use leadCall.id
  jobNumber?: string | null;
  projectId?: number | null;
  businessUnit?: unknown;
  type?: string | null;
  leadCall: V3LeadCall;
}

export interface V3CallsResponse {
  page: number;
  pageSize: number;
  hasMore: boolean;
  totalCount: number | null;
  data: V3Bundle[];
}

// ─── API client interface (injectable for tests) ─────────────────────────────

export interface V3CallsApi {
  get<T>(endpoint: string, params: Record<string, string | number | boolean>): Promise<T>;
}

// ─── Mapped enrichment record ─────────────────────────────────────────────────

interface EnrichmentRow {
  source_system: string;
  source_id: string;
  call_received_on: Date | null;
  call_type: string | null;
  direction: string | null;
  duration: string | null;
  active: boolean | null;
  sid: string | null;
  reason: string | null;
  agent_id: string | null;
  agent_name: string | null;
  campaign_id: string | null;
  tags: unknown[] | null;
  v3_created_on: Date | null;
  v3_modified_on: Date | null;
  v3_payload: Record<string, unknown>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeStr(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function safeDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isHttpTransientError(error: unknown): boolean {
  return error instanceof Error && /\[(429|500|502|503|504)\]/.test(error.message);
}

function isTransient(error: unknown): boolean {
  return isHttpTransientError(error) || isNetworkError(error);
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) {
    const m = /\[(\d{3})\]/.exec(error.message);
    if (m) return `ServiceTitan V3 TelecomCall enrichment failed (HTTP ${m[1]}).`;
  }
  return 'ServiceTitan V3 TelecomCall enrichment failed.';
}

// Maps a V3 Bundle to a storable enrichment row.
// Never throws — all nullable fields fall back to null.
// Privacy: from/to/recordingUrl/voiceMailUrl are NOT extracted to columns —
// they remain inside v3_payload only, consistent with raw_st_calls.payload policy.
export function mapBundleToRow(bundle: V3Bundle, sourceSystem: string): EnrichmentRow {
  const lc = bundle.leadCall;
  return {
    source_system: sourceSystem,
    source_id: String(lc.id),
    call_received_on: safeDate(lc.receivedOn),
    call_type: safeStr(lc.callType),
    direction: safeStr(lc.direction),
    duration: safeStr(lc.duration),
    active: typeof lc.active === 'boolean' ? lc.active : null,
    sid: safeStr(lc.sid),
    reason: safeStr(lc.reason),
    agent_id: safeStr(lc.agent?.id),
    agent_name: safeStr(lc.agent?.name),
    campaign_id: safeStr(lc.campaign?.id),
    tags: Array.isArray(lc.tags) && lc.tags.length > 0 ? lc.tags : null,
    v3_created_on: safeDate(lc.createdOn),
    v3_modified_on: safeDate(lc.modifiedOn),
    v3_payload: bundle as unknown as Record<string, unknown>,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export interface V2CoverageResult {
  missing: number;
  oldest: Date | null;
  newest: Date | null;
}

export interface V3EnrichmentRepository {
  withExclusiveLock<T>(fn: (repo: V3EnrichmentRepository) => Promise<T>): Promise<T>;
  recoverInterruptedRuns(): Promise<void>;
  createSyncRun(): Promise<string>;
  // Atomically advances the checkpoint AND marks the sync run completed.
  // Either both commits succeed or neither does — no partial state.
  completeRun(syncRunId: string, runStartedAt: string, recordsProcessed: number): Promise<void>;
  completeSyncRun(syncRunId: string, recordsProcessed: number): Promise<void>;
  failSyncRun(syncRunId: string, message: string): Promise<void>;
  getContinuation(): Promise<string | null>;
  updateContinuation(value: string, syncRunId: string): Promise<void>;
  upsertBatch(syncRunId: string, rows: EnrichmentRow[]): Promise<void>;
  reconcileV2Links(): Promise<number>;
  // Read-only coverage check: counts V2 calls within [historicalFrom, now) that have
  // no matching V3 enrichment record. Returns count + oldest/newest missing timestamps.
  // Never modifies any row — safe to call at any time, failures are non-fatal.
  checkV2Coverage(historicalFrom: string): Promise<V2CoverageResult>;
}

// Advisory lock key scoped to tenant to prevent concurrent V3 enrichment runs
const LOCK_KEY_BASE = 'trufinity:servicetitan:telecom-calls-v3';

export class PostgresV3EnrichmentRepository implements V3EnrichmentRepository {
  public constructor(private readonly database = db) {}

  public async withExclusiveLock<T>(fn: (repo: V3EnrichmentRepository) => Promise<T>): Promise<T> {
    return this.database.transaction(async (trx) => {
      const lockKey = `${LOCK_KEY_BASE}:${env.SERVICETITAN_TENANT_ID}`;
      const hash = lockKey.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0);
      const acquired = await trx.raw<{ rows: { pg_try_advisory_xact_lock: boolean }[] }>(
        `SELECT pg_try_advisory_xact_lock(?)`, [hash],
      );
      if (!acquired.rows[0]?.pg_try_advisory_xact_lock) {
        throw new V3SyncInProgressError('ServiceTitan V3 TelecomCall enrichment is already running.');
      }
      return fn(this);
    });
  }

  public async recoverInterruptedRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - 2 * 60 * 60_000); // 2 hours
    const stuck = await this.database('sync_runs')
      .where({ source_system: SOURCE_SYSTEM, entity_type: ENTITY_TYPE, status: 'running' })
      .andWhere('started_at', '<', cutoff)
      .update({ status: 'failed', error_message: 'Run interrupted — marked failed by recovery.', completed_at: this.database.fn.now() })
      .returning('id') as { id: string }[];

    if (stuck.length > 0) {
      logger.warn('[ServiceTitan] V3 TelecomCall enrichment: recovered interrupted runs', { count: stuck.length });
    }
  }

  public async createSyncRun(): Promise<string> {
    const [row] = await this.database('sync_runs')
      .insert({ source_system: SOURCE_SYSTEM, entity_type: ENTITY_TYPE, status: 'running', started_at: this.database.fn.now() })
      .returning('id') as { id: string }[];
    return row!.id;
  }

  // Atomically advances the checkpoint in raw_sync_metadata AND marks the
  // sync_run as completed in a single transaction. If either write fails the
  // whole transaction rolls back — the checkpoint is never advanced without a
  // corresponding completed sync_run row, and vice versa.
  public async completeRun(syncRunId: string, runStartedAt: string, recordsProcessed: number): Promise<void> {
    await this.database.transaction(async (trx) => {
      // raw_sync_metadata does not have a sync_run_id column (schema from migration 001).
      // Only the columns that actually exist are written here.
      await trx('raw_sync_metadata')
        .insert({
          source_system: SOURCE_SYSTEM,
          entity_type: ENTITY_TYPE,
          continuation_token: runStartedAt,
          last_synced_at: trx.fn.now(),
        })
        .onConflict(['source_system', 'entity_type'])
        .merge(['continuation_token', 'last_synced_at']);

      await trx('sync_runs')
        .where({ id: syncRunId })
        .update({ status: 'completed', records_processed: recordsProcessed, completed_at: trx.fn.now() });
    });
  }

  public async completeSyncRun(syncRunId: string, recordsProcessed: number): Promise<void> {
    await this.database('sync_runs')
      .where({ id: syncRunId })
      .update({ status: 'completed', records_processed: recordsProcessed, completed_at: this.database.fn.now() });
  }

  public async failSyncRun(syncRunId: string, message: string): Promise<void> {
    await this.database('sync_runs')
      .where({ id: syncRunId })
      .update({ status: 'failed', error_message: message, completed_at: this.database.fn.now() });
  }

  public async getContinuation(): Promise<string | null> {
    const row = await this.database('raw_sync_metadata')
      .where({ source_system: SOURCE_SYSTEM, entity_type: ENTITY_TYPE })
      .select('continuation_token')
      .first() as { continuation_token: string | null } | undefined;
    return row?.continuation_token ?? null;
  }

  public async updateContinuation(value: string, _syncRunId: string): Promise<void> {
    await this.database('raw_sync_metadata')
      .insert({
        source_system: SOURCE_SYSTEM,
        entity_type: ENTITY_TYPE,
        continuation_token: value,
        last_synced_at: this.database.fn.now(),
      })
      .onConflict(['source_system', 'entity_type'])
      .merge(['continuation_token', 'last_synced_at']);
  }

  // Idempotent upsert — on (source_system, source_id) conflict, update all enrichment columns.
  // Sets v2_linked=true when a matching raw_st_calls row exists at upsert time.
  // v2_linked is never set back to false — once linked it stays linked (OR with existing value).
  public async upsertBatch(syncRunId: string, rows: EnrichmentRow[]): Promise<void> {
    if (rows.length === 0) return;

    // Each row has ~18 columns; PostgreSQL limit is 65,535 parameters.
    const CHUNK_SIZE = Math.floor(65_535 / 18); // 3,640 rows
    for (let offset = 0; offset < rows.length; offset += CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + CHUNK_SIZE);
      await this.database.transaction(async (trx) => {
        await trx.raw(
          `INSERT INTO st_calls_v3_enrichment (
              source_system, source_id,
              call_received_on, call_type, direction, duration, active, sid, reason,
              agent_id, agent_name, campaign_id, tags,
              v3_created_on, v3_modified_on, v3_payload,
              v2_linked, sync_run_id, enriched_at, enrichment_updated_at
            )
            SELECT
              v.source_system, v.source_id,
              v.call_received_on::timestamptz, v.call_type, v.direction,
              v.duration, v.active::boolean, v.sid, v.reason,
              v.agent_id, v.agent_name, v.campaign_id, v.tags::jsonb,
              v.v3_created_on::timestamptz, v.v3_modified_on::timestamptz,
              v.v3_payload::jsonb,
              EXISTS (
                SELECT 1 FROM raw_st_calls rsc
                 WHERE rsc.source_system = v.source_system
                   AND rsc.source_id     = v.source_id
                   AND rsc.is_latest     = true
              ),
              ?, now(), now()
            FROM json_to_recordset(?::json) AS v(
              source_system        text,
              source_id            text,
              call_received_on     text,
              call_type            text,
              direction            text,
              duration             text,
              active               text,
              sid                  text,
              reason               text,
              agent_id             text,
              agent_name           text,
              campaign_id          text,
              tags                 text,
              v3_created_on        text,
              v3_modified_on       text,
              v3_payload           text
            )
            ON CONFLICT (source_system, source_id) DO UPDATE SET
              call_received_on     = EXCLUDED.call_received_on,
              call_type            = EXCLUDED.call_type,
              direction            = EXCLUDED.direction,
              duration             = EXCLUDED.duration,
              active               = EXCLUDED.active,
              sid                  = EXCLUDED.sid,
              reason               = EXCLUDED.reason,
              agent_id             = EXCLUDED.agent_id,
              agent_name           = EXCLUDED.agent_name,
              campaign_id          = EXCLUDED.campaign_id,
              tags                 = EXCLUDED.tags,
              v3_created_on        = EXCLUDED.v3_created_on,
              v3_modified_on       = EXCLUDED.v3_modified_on,
              v3_payload           = EXCLUDED.v3_payload,
              v2_linked            = EXCLUDED.v2_linked OR st_calls_v3_enrichment.v2_linked,
              sync_run_id          = EXCLUDED.sync_run_id,
              enrichment_updated_at = now()`,
          [
            syncRunId,
            JSON.stringify(chunk.map((r) => ({
              source_system: r.source_system,
              source_id: r.source_id,
              call_received_on: r.call_received_on?.toISOString() ?? null,
              call_type: r.call_type,
              direction: r.direction,
              duration: r.duration,
              active: r.active === null ? null : String(r.active),
              sid: r.sid,
              reason: r.reason,
              agent_id: r.agent_id,
              agent_name: r.agent_name,
              campaign_id: r.campaign_id,
              tags: r.tags !== null ? JSON.stringify(r.tags) : null,
              v3_created_on: r.v3_created_on?.toISOString() ?? null,
              v3_modified_on: r.v3_modified_on?.toISOString() ?? null,
              v3_payload: JSON.stringify(r.v3_payload),
            }))),
          ],
        );
      });
    }
  }

  // Reconciles v2_linked=false rows by checking for a matching is_latest=true row
  // in raw_st_calls. Returns the count of rows updated.
  //
  // This is idempotent and safe to run at any time — it never modifies V2 records
  // and is independent from both V2 and V3 ingestion checkpoints.
  // Typically called once after each V3 ingestion run completes.
  public async reconcileV2Links(): Promise<number> {
    const result = await this.database.raw<{ rowCount: number }>(
      `UPDATE st_calls_v3_enrichment v3
          SET v2_linked = true,
              enrichment_updated_at = now()
        WHERE v2_linked = false
          AND source_system = ?
          AND EXISTS (
            SELECT 1 FROM raw_st_calls rsc
             WHERE rsc.source_system = v3.source_system
               AND rsc.source_id     = v3.source_id
               AND rsc.is_latest     = true
          )`,
      [SOURCE_SYSTEM],
    );
    return result.rowCount ?? 0;
  }

  // Read-only coverage check: finds V2 calls (raw_st_calls, is_latest=true) within
  // [historicalFrom, now) that have no matching row in st_calls_v3_enrichment.
  // Uses the idx on (source_system, source_id, is_latest) for raw_st_calls and
  // the primary key (source_system, source_id) for the enrichment table.
  // Only looks at created_on to determine whether a V2 call falls within the V3
  // window — created_on is never null for is_latest=true rows in practice.
  public async checkV2Coverage(historicalFrom: string): Promise<V2CoverageResult> {
    type Row = { missing_count: string; oldest_missing: string | null; newest_missing: string | null };
    const result = await this.database.raw<{ rows: Row[] }>(
      `SELECT
          COUNT(*)::text                          AS missing_count,
          MIN(rsc.created_on)::text               AS oldest_missing,
          MAX(rsc.created_on)::text               AS newest_missing
        FROM raw_st_calls rsc
        WHERE rsc.source_system = ?
          AND rsc.is_latest     = true
          AND rsc.created_on   >= ?::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM st_calls_v3_enrichment v3
             WHERE v3.source_system = rsc.source_system
               AND v3.source_id     = rsc.source_id
          )`,
      [SOURCE_SYSTEM, historicalFrom],
    );
    const row = result.rows[0];
    const missing = parseInt(row?.missing_count ?? '0', 10);
    const oldest = row?.oldest_missing ? new Date(row.oldest_missing) : null;
    const newest = row?.newest_missing ? new Date(row.newest_missing) : null;
    return { missing, oldest, newest };
  }
}

export class V3SyncInProgressError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'V3SyncInProgressError';
  }
}

// ─── Ingestion service ────────────────────────────────────────────────────────

export class ServiceTitanTelecomCallsV3IngestionService {
  public constructor(
    private readonly client: V3CallsApi = apiClient,
    private readonly repository: V3EnrichmentRepository = new PostgresV3EnrichmentRepository(),
    private readonly historicalFrom: string = DEFAULT_HISTORICAL_FROM,
    private readonly overlapMs: number = env.SERVICETITAN_TELECOM_V3_OVERLAP_MINUTES * 60_000,
    private readonly maxPagesPerRun: number = MAX_PAGES_PER_RUN,
  ) {}

  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    return this.repository.withExclusiveLock((repo) => this.runLocked(repo));
  }

  // Reconcile v2_linked=false rows after ingestion. Safe to call independently.
  public async reconcileV2Links(): Promise<number> {
    return this.repository.reconcileV2Links();
  }

  private async runLocked(repository: V3EnrichmentRepository): Promise<{ syncRunId: string; recordsProcessed: number }> {
    await repository.recoverInterruptedRuns();
    let syncRunId: string | null = null;
    let processed = 0;

    try {
      syncRunId = await repository.createSyncRun();

      const savedToken = await repository.getContinuation();

      // Record the run start time BEFORE any API fetch.
      //
      // This timestamp serves two purposes:
      //   1. Upper bound (createdBefore / modifiedBefore) for all page fetches in
      //      this run — bounds the result set to records that existed before the run
      //      started, preventing offset drift when records are created or modified
      //      while we are paginating.
      //   2. Continuation token saved on success — the next incremental run uses it
      //      as modifiedOnOrAfter (minus the overlap window) so no modifications
      //      that occurred during this run are missed.
      const runStartedAt = new Date().toISOString();

      let filterParamName: string;
      let filterParamValue: string;
      let boundParamName: string;

      if (savedToken === null) {
        // First run — historical: fetch all calls created on or after historicalFrom
        // and strictly before runStartedAt. Using a createdBefore bound makes the
        // result set stable for the duration of pagination.
        filterParamName = 'createdOnOrAfter';
        filterParamValue = this.historicalFrom;
        boundParamName = 'createdBefore';
      } else {
        // Incremental — use modifiedOnOrAfter to catch updates to older calls.
        //
        // Overlap window: subtract overlapMs from the saved token to re-query a
        // small window of records that may have had equal modification timestamps
        // or delayed API visibility at the boundary of the previous run.
        // Upserts are idempotent so re-fetching these records is safe.
        const tokenMs = new Date(savedToken).getTime();
        const adjustedMs = Math.max(0, tokenMs - this.overlapMs);
        filterParamName = 'modifiedOnOrAfter';
        filterParamValue = new Date(adjustedMs).toISOString();
        boundParamName = 'modifiedBefore';
      }

      logger.info('[ServiceTitan] V3 TelecomCall enrichment: starting run', {
        syncRunId,
        filterParamName,
        // Log only the date portion — no tokens, no URLs, no PII
        filterDatePrefix: filterParamValue.substring(0, 10),
        boundDatePrefix: runStartedAt.substring(0, 10),
        overlappedMs: savedToken !== null ? this.overlapMs : 0,
      });

      const filterParams: Record<string, string | number | boolean> = {
        [filterParamName]: filterParamValue,
        [boundParamName]: runStartedAt,
      };

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        if (page > this.maxPagesPerRun) {
          throw new Error(
            `V3 TelecomCall pagination exceeded MAX_PAGES_PER_RUN (${this.maxPagesPerRun}). ` +
            `This indicates an unexpected result set size or a pagination bug.`,
          );
        }

        const response = await this.fetchPage(page, filterParams);

        if (!Array.isArray(response.data) || typeof response.hasMore !== 'boolean') {
          throw new Error('Malformed ServiceTitan V3 TelecomCall response.');
        }

        const rows: EnrichmentRow[] = [];
        for (const bundle of response.data) {
          if (typeof bundle.leadCall?.id !== 'number') {
            // Log only the (meaningless) Bundle.id — never phone numbers, customer IDs, etc.
            logger.warn('[ServiceTitan] V3 TelecomCall: skipping bundle without valid leadCall.id', { bundleId: bundle.id });
            continue;
          }
          rows.push(mapBundleToRow(bundle, SOURCE_SYSTEM));
        }

        await repository.upsertBatch(syncRunId, rows);
        processed += rows.length;

        hasMore = response.hasMore;
        page += 1;

        logger.info('[ServiceTitan] V3 TelecomCall enrichment: page committed', {
          page: response.page,
          recordsThisPage: rows.length,
          totalProcessed: processed,
          hasMore,
        });
      }

      // Atomically advance the checkpoint AND mark the sync run completed.
      // Both writes commit together or neither does — a transaction failure here
      // falls into the catch block which calls failSyncRun (the sync_run row
      // was created before pagination and is still in 'running' state at this
      // point; failSyncRun transitions it to 'failed'). The checkpoint is
      // never advanced without a corresponding completed sync_run row.
      await repository.completeRun(syncRunId, runStartedAt, processed);

      // Reconcile any v2_linked=false rows now that fresh V2 data may exist.
      const linked = await repository.reconcileV2Links().catch((err: unknown) => {
        // Reconciliation failure is non-fatal — log and continue.
        logger.warn('[ServiceTitan] V3 TelecomCall enrichment: reconciliation step failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return 0;
      });

      // Coverage monitoring: count V2 calls within the V3 window that have no
      // matching enrichment record. Non-fatal — a query failure must not affect
      // the checkpoint or the sync run completion status.
      await repository.checkV2Coverage(this.historicalFrom).then((coverage) => {
        const warnThreshold = env.SERVICETITAN_TELECOM_V3_COVERAGE_GAP_WARN_THRESHOLD;
        const logFields = {
          missingV3Coverage: coverage.missing,
          oldestMissingDate: coverage.oldest?.toISOString().substring(0, 10) ?? null,
          newestMissingDate: coverage.newest?.toISOString().substring(0, 10) ?? null,
        };
        if (warnThreshold > 0 && coverage.missing > warnThreshold) {
          logger.warn('[ServiceTitan] V3 TelecomCall enrichment: V2→V3 coverage gap exceeds threshold', {
            ...logFields,
            warnThreshold,
          });
        } else {
          logger.info('[ServiceTitan] V3 TelecomCall enrichment: V2→V3 coverage check', logFields);
        }
      }).catch((err: unknown) => {
        // Coverage check failure is non-fatal — log and continue.
        logger.warn('[ServiceTitan] V3 TelecomCall enrichment: coverage check failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      logger.info('[ServiceTitan] V3 TelecomCall enrichment run complete', {
        syncRunId,
        recordsProcessed: processed,
        v2LinkedThisRun: linked,
        filterParamName,
      });

      return { syncRunId, recordsProcessed: processed };
    } catch (error) {
      const message = failureMessage(error);
      if (syncRunId !== null) await repository.failSyncRun(syncRunId, message);
      // Log only the structured failure message — no raw error details that could
      // contain tokens or API response bodies.
      logger.error('[ServiceTitan] V3 TelecomCall enrichment failed', { syncRunId, message });
      throw new Error(message);
    }
  }

  private async fetchPage(page: number, filterParams: Record<string, string | number | boolean>): Promise<V3CallsResponse> {
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      try {
        return await this.client.get<V3CallsResponse>(V3_ENDPOINT, {
          page,
          pageSize: PAGE_SIZE,
          ...filterParams,
        });
      } catch (error) {
        if (attempt < MAX_TRANSIENT_ATTEMPTS && isTransient(error)) {
          const delay = retryDelayMs(attempt);
          logger.warn('[ServiceTitan] V3 TelecomCall fetch transient error — retrying', {
            page,
            attempt,
            delayMs: delay,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    // Unreachable but TypeScript requires a return
    throw new Error('V3 TelecomCall fetch: exhausted retry attempts');
  }
}

export const serviceTitanTelecomCallsV3IngestionService = new ServiceTitanTelecomCallsV3IngestionService();
