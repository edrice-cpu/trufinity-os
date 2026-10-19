import { db } from '../../../database';
import { env } from '../../../config/env';
import { logger } from '../../../utils/logger';
import { apiClient } from '../api.client';
import {
  PostgresServiceTitanRawRepository,
  SyncInProgressError,
  type RawExportApi,
  type RawExportResponse,
  type RawIngestionRepository,
  type InvalidRawRecord,
} from './raw-export.ingestion';

// Source system key includes tenant ID so (source_system, source_id) is unique
// across ST tenants — ST call IDs are NOT globally unique per the ST data model.
const SOURCE_SYSTEM = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

const TELECOM_CALLS_CONFIG = {
  sourceSystem: SOURCE_SYSTEM,
  entityType: 'TelecomCall',
  rawTable: 'raw_st_calls',
  exportEndpoint: `/telecom/v2/tenant/${env.SERVICETITAN_TENANT_ID}/export/calls`,
  lockKey: `trufinity:servicetitan:telecom-calls:${env.SERVICETITAN_TENANT_ID}`,
} as const;

export type TelecomCallsExportResponse = RawExportResponse;
export type TelecomCallsExportApi = RawExportApi;
export type InvalidTelecomCallRecord = InvalidRawRecord;
export type TelecomCallsRawRepository = RawIngestionRepository;
export { SyncInProgressError as TelecomCallsSyncInProgressError };

// The export record shape as returned by /telecom/v2/tenant/{t}/export/calls.
// Used only for typed extraction into indexed columns — the full payload is
// always stored verbatim regardless.
interface TelecomCallExportRecord {
  id?: unknown;
  direction?: unknown;
  status?: unknown;
  type?: unknown;
  duration?: unknown;
  createdOn?: unknown;
  modifiedOn?: unknown;
  customer?: { id?: unknown } | null;
  location?: { id?: unknown } | null;
  job?: { id?: unknown } | null;
  campaign?: { id?: unknown } | null;
  agent?: { id?: unknown } | null;
  businessUnit?: { id?: unknown } | null;
  // voiceMailPath (not voiceMailUrl) — verified from live probe. Stored in payload only.
}

function safeString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function safeDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Extracts indexed columns from a raw export record for efficient query-layer access.
// Never throws — all fields are nullable. Malformed values are silently dropped.
//
// Timestamp note: the export record provides createdOn and modifiedOn. There is no
// receivedOn field at the flat export level (unlike leadCall.receivedOn in the list
// API). call_received_on is intentionally omitted until the correct source field is
// confirmed. createdOn → created_on only.
function extractIndexedColumns(record: TelecomCallExportRecord): Record<string, unknown> {
  return {
    direction: safeString(record.direction),
    call_status: safeString(record.status),
    call_type: safeString(record.type),
    duration: safeString(record.duration),
    created_on: safeDate(record.createdOn),
    modified_on: safeDate(record.modifiedOn),
    st_customer_id: safeString(record.customer?.id),
    st_location_id: safeString(record.location?.id),
    st_job_id: safeString(record.job?.id),
    st_campaign_id: safeString(record.campaign?.id),
    st_agent_id: safeString(record.agent?.id),
    st_business_unit_id: safeString(record.businessUnit?.id),
  };
}

// Deduplicate incoming records by source_id: if the same call appears more than
// once in a single API page (not expected, but not contractually forbidden), keep
// the last occurrence so the stored is_latest row reflects the most recent data.
function deduplicateBySourceId(
  records: { sourceId: string; payload: Record<string, unknown> }[],
): { sourceId: string; payload: Record<string, unknown> }[] {
  const seen = new Map<string, { sourceId: string; payload: Record<string, unknown> }>();
  for (const record of records) seen.set(record.sourceId, record);
  return Array.from(seen.values());
}

export class PostgresTelecomCallsRawRepository extends PostgresServiceTitanRawRepository {
  public constructor(database = db) {
    super(TELECOM_CALLS_CONFIG, database);
  }

  // Set-based batch commit — replaces the N+1 per-record loop with set operations
  // that execute in O(1) round-trips regardless of batch size.
  //
  // Algorithm (all within a single transaction):
  //   1. Load deduplicated incoming records into a temp table (_tc_batch_incoming).
  //      Records are inserted in chunks to stay within PostgreSQL's 65,535-parameter
  //      limit: 14 columns × 4,681 rows = 65,534 parameters per chunk.
  //   2. Demote the current is_latest row for any call whose payload changed.
  //   3. Refresh sync_run_id for unchanged existing calls (payload identical, no new row).
  //   4. Insert new is_latest=true rows for calls with no current version
  //      (covers: new records and calls just demoted in step 2).
  //
  // Change detection uses PostgreSQL JSONB != which performs semantic (key-order-
  // independent) comparison — identical payloads with different key ordering are
  // correctly treated as unchanged.
  //
  // The temp table uses ON COMMIT DROP, which drops it on both COMMIT and ROLLBACK,
  // preventing session-state leakage across pool connections.
  //
  // Checkpoint correctness: updateContinuation is called by the caller only after
  // this entire transaction commits successfully. Chunking the temp-table insert
  // does NOT split the commit — all chunks remain inside the same transaction.
  public override async commitBatch(
    syncRunId: string,
    records: { sourceId: string; payload: Record<string, unknown> }[],
    errors: InvalidRawRecord[],
  ): Promise<void> {
    await this.database.transaction(async (trx) => {
      if (records.length > 0) {
        const deduped = deduplicateBySourceId(records);

        await trx.raw(`
          CREATE TEMP TABLE _tc_batch_incoming (
            source_id           TEXT        NOT NULL,
            payload             JSONB       NOT NULL,
            direction           TEXT,
            call_status         TEXT,
            call_type           TEXT,
            duration            TEXT,
            created_on          TIMESTAMPTZ,
            modified_on         TIMESTAMPTZ,
            st_customer_id      TEXT,
            st_location_id      TEXT,
            st_job_id           TEXT,
            st_campaign_id      TEXT,
            st_agent_id         TEXT,
            st_business_unit_id TEXT
          ) ON COMMIT DROP
        `);

        // PostgreSQL rejects a single statement with more than 65,535 bound
        // parameters. Each row occupies 14 columns, so the safe ceiling is
        // floor(65535 / 14) = 4,681 rows per INSERT.
        // All chunks land in the same transaction — atomicity is preserved.
        const CHUNK_SIZE = Math.floor(65_535 / 14); // 4,681
        for (let offset = 0; offset < deduped.length; offset += CHUNK_SIZE) {
          await trx('_tc_batch_incoming').insert(
            deduped.slice(offset, offset + CHUNK_SIZE).map((r) => ({
              source_id: r.sourceId,
              payload: r.payload,
              ...extractIndexedColumns(r.payload as TelecomCallExportRecord),
            })),
          );
        }

        // Step 1 — Demote current is_latest rows whose payload has changed.
        await trx.raw(
          `UPDATE raw_st_calls rsc
              SET is_latest = false
             FROM _tc_batch_incoming ti
            WHERE rsc.source_system = ?
              AND rsc.source_id     = ti.source_id
              AND rsc.is_latest     = true
              AND rsc.payload      != ti.payload`,
          [SOURCE_SYSTEM],
        );

        // Step 2 — Refresh sync_run_id for calls that are still is_latest=true
        //          (payload unchanged — no new history row required).
        await trx.raw(
          `UPDATE raw_st_calls rsc
              SET sync_run_id = ?
             FROM _tc_batch_incoming ti
            WHERE rsc.source_system = ?
              AND rsc.source_id     = ti.source_id
              AND rsc.is_latest     = true`,
          [syncRunId, SOURCE_SYSTEM],
        );

        // Step 3 — Insert new is_latest=true rows for calls with no current version.
        //          Covers both newly demoted calls (payload changed) and brand-new calls.
        await trx.raw(
          `INSERT INTO raw_st_calls (
              source_system, source_id,
              direction, call_status, call_type, duration,
              created_on, modified_on,
              st_customer_id, st_location_id, st_job_id,
              st_campaign_id, st_agent_id, st_business_unit_id,
              payload, is_latest, sync_run_id
            )
            SELECT ?, ti.source_id,
              ti.direction, ti.call_status, ti.call_type, ti.duration,
              ti.created_on, ti.modified_on,
              ti.st_customer_id, ti.st_location_id, ti.st_job_id,
              ti.st_campaign_id, ti.st_agent_id, ti.st_business_unit_id,
              ti.payload, true, ?
             FROM _tc_batch_incoming ti
            WHERE NOT EXISTS (
              SELECT 1 FROM raw_st_calls rsc2
               WHERE rsc2.source_system = ?
                 AND rsc2.source_id     = ti.source_id
                 AND rsc2.is_latest     = true
            )`,
          [SOURCE_SYSTEM, syncRunId, SOURCE_SYSTEM],
        );
      }

      if (errors.length > 0) {
        await trx('sync_errors').insert(
          errors.map((e) => ({
            sync_run_id: syncRunId,
            source_id: e.sourceId,
            error_message: e.message,
            payload: e.payload,
          })),
        );
      }
    });
  }
}

function sourceIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return null;
  const id = (payload as { id?: unknown }).id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim().length > 0) return id;
  return null;
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    const match = /\[(\d{3})\]/.exec(error.message);
    if (match) return `ServiceTitan telecomcall export failed (HTTP ${match[1]}).`;
  }
  return 'ServiceTitan telecomcall export failed.';
}

// Returns true for errors that represent a transient server-side condition
// (HTTP 429/5xx) and should be retried with backoff.
function isHttpTransientError(error: unknown): boolean {
  return error instanceof Error && /\[(429|500|502|503|504)\]/.test(error.message);
}

// Returns true for network-level errors that are not HTTP responses:
//   - AbortError: the request was cancelled by AbortController (timeout in api.client.ts)
//   - TypeError "fetch failed": Node.js native fetch threw before receiving headers
//   - ECONNRESET / ETIMEDOUT / EPIPE / ECONNREFUSED / ENOTFOUND: TCP-level failures,
//     often surfaced as error.code or error.cause.code on the underlying cause
//
// These are all safe to retry because no HTTP response was received.
export function isNetworkError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  // AbortError is thrown as DOMException in Node.js 18+ — not an Error instance,
  // so name must be checked before the instanceof guard below.
  if ((error as { name?: string }).name === 'AbortError') return true;
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch failed')) return true;
  const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND']);
  const code = (error as { code?: string }).code;
  const causeCode = (error.cause as { code?: string } | undefined)?.code;
  return TRANSIENT_CODES.has(code ?? '') || TRANSIENT_CODES.has(causeCode ?? '');
}

function isTransientError(error: unknown): boolean {
  return isHttpTransientError(error) || isNetworkError(error);
}

const MAX_TRANSIENT_ATTEMPTS = 3;

// Bounded exponential backoff with ±25% jitter.
// Attempt 1: ~1 s  |  Attempt 2: ~2 s  |  caps at 30 s.
// The Telecom export API does not surface Retry-After headers through the
// current API client, so the delay is computed independently of the response.
export function retryDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  const jitter = base * 0.25 * (Math.random() * 2 - 1); // ±25%
  return Math.round(base + jitter);
}

// ServiceTitanTelecomCallsIngestionService is a standalone implementation (not
// extending ServiceTitanRawIngestionService) because it requires two behaviours
// that differ from the shared base class:
//
// 1. Final-token preservation: the Telecom export API returns continueFrom even
//    when hasMore is false. The base class discards it (sets null) on the last
//    page. Preserving it means the next run resumes from the exact cursor rather
//    than re-fetching from the configured historical start date.
//
// 2. Bounded initial from: when no saved continuation exists, the base class
//    sends no `from` param, potentially triggering a full historical export.
//    This service always sends a `from` param — the saved token on subsequent
//    runs, the configured historical start date on the first run.
//
// The lock, sync-run lifecycle, recovery, and retry logic are identical to the
// base class and are reproduced here rather than modifying shared infrastructure.
export class ServiceTitanTelecomCallsIngestionService {
  public constructor(
    private readonly client: TelecomCallsExportApi = apiClient,
    private readonly repository: TelecomCallsRawRepository = new PostgresTelecomCallsRawRepository(),
    private readonly historicalFrom: string = env.SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM,
  ) {}

  public async run(): Promise<{ syncRunId: string; recordsProcessed: number }> {
    return this.repository.withExclusiveLock((lockedRepo) => this.runLocked(lockedRepo));
  }

  private async runLocked(repository: TelecomCallsRawRepository): Promise<{ syncRunId: string; recordsProcessed: number }> {
    await repository.recoverInterruptedRuns();
    let syncRunId: string | null = null;
    let processed = 0;
    try {
      syncRunId = await repository.createSyncRun();

      // Use the saved continuation token when available; fall back to the
      // configured historical start date on the first ever run.
      // Never fall back to an unbounded full-history export (no omitted `from`).
      const savedContinuation = await repository.getContinuation();
      let from: string = savedContinuation ?? this.historicalFrom;

      let hasMore = true;
      while (hasMore) {
        const response = await this.fetchBatch(from);

        if (!Array.isArray(response.data) || typeof response.hasMore !== 'boolean') {
          throw new Error('Malformed ServiceTitan Telecom export response.');
        }
        // Require continueFrom when hasMore is true — it is the only safe cursor.
        if (response.hasMore && (!response.continueFrom || response.continueFrom.trim().length === 0)) {
          throw new Error('Malformed ServiceTitan Telecom export continuation response.');
        }

        const records: { sourceId: string; payload: Record<string, unknown> }[] = [];
        const errors: InvalidTelecomCallRecord[] = [];
        for (const payload of response.data) {
          const sourceId = sourceIdFromPayload(payload);
          if (sourceId === null || typeof payload !== 'object' || payload === null) {
            errors.push({ sourceId, message: 'TelecomCall payload is missing a valid id.', payload });
          } else {
            records.push({ sourceId, payload: payload as Record<string, unknown> });
          }
        }

        hasMore = response.hasMore;

        // Loop-safety: if the API returns hasMore: true with the same cursor we
        // just used, further requests would repeat this page forever. Treat this
        // as a malformed response and abort without advancing the checkpoint.
        if (
          hasMore &&
          response.continueFrom &&
          response.continueFrom.trim().length > 0 &&
          response.continueFrom === from
        ) {
          throw new Error(
            'ServiceTitan Telecom export pagination cursor did not advance between pages.',
          );
        }

        // Preserve the final continueFrom token even when hasMore is false.
        // The Telecom export API always returns a populated continueFrom — storing
        // it means the next run resumes from this exact cursor rather than the
        // configured historicalFrom date.
        if (response.continueFrom && response.continueFrom.trim().length > 0) {
          from = response.continueFrom;
        }
        // If hasMore is false and continueFrom is absent/empty, keep the current
        // `from` value unchanged (do not reset it).

        await repository.commitBatch(syncRunId, records, errors);
        // Checkpoint: persist `from` AFTER records are committed. The value written
        // here is either the new continueFrom (if populated) or the cursor used to
        // fetch this batch, so an interrupted run re-fetches at worst one batch.
        await repository.updateContinuation(from);
        processed += records.length;
      }

      await repository.completeSyncRun(syncRunId, processed);
      return { syncRunId, recordsProcessed: processed };
    } catch (error) {
      const message = safeFailureMessage(error);
      if (syncRunId !== null) await repository.failSyncRun(syncRunId, message);
      logger.error('[ServiceTitan] TelecomCall ingestion failed', { syncRunId, message });
      throw new Error(message);
    }
  }

  private async fetchBatch(from: string): Promise<TelecomCallsExportResponse> {
    for (let attempt = 1; attempt <= MAX_TRANSIENT_ATTEMPTS; attempt++) {
      try {
        return await this.client.get<TelecomCallsExportResponse>(
          TELECOM_CALLS_CONFIG.exportEndpoint,
          { from },
        );
      } catch (error) {
        const transient = isTransientError(error);
        logger.warn('[ServiceTitan] TelecomCall fetchBatch error', {
          attempt,
          transient,
          name: error instanceof Error ? error.name : 'UnknownError',
          code: (error as { code?: string }).code ?? null,
          causeCode: error instanceof Error
            ? ((error.cause as { code?: string } | undefined)?.code ?? null)
            : null,
          from,
        });
        if (!transient || attempt === MAX_TRANSIENT_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
      }
    }
    throw new Error('ServiceTitan telecomcall export failed.');
  }
}

// Disabled by default — NOT added to servicetitan.scheduler.ts until migration 020
// has been applied and the historical start date confirmed.
export const serviceTitanTelecomCallsIngestionService = new ServiceTitanTelecomCallsIngestionService();
