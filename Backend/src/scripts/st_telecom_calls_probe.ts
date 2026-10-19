import { db } from '../database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { apiClient } from '../modules/servicetitan/api.client';
import {
  PostgresTelecomCallsRawRepository,
  type TelecomCallsExportApi,
  type TelecomCallsRawRepository,
  type TelecomCallsExportResponse,
  type InvalidTelecomCallRecord,
} from '../modules/servicetitan/ingestion/telecom-calls.ingestion';

// Probe configuration — scoped to one day so the first batch is small (~120 records).
// The 90-day historical run still starts from 2026-07-10 because this probe
// intentionally does NOT write the TelecomCall checkpoint to raw_sync_metadata.
const PROBE_FROM = '2026-10-07';

export interface TelecomCallsProbeResult {
  syncRunId: string;
  // Records from the API response that had valid IDs and were sent to commitBatch.
  // commitBatch applies JSONB change detection internally: new records are inserted,
  // identical existing records get only their sync_run_id refreshed (no new history row).
  recordsProcessed: number;
  // Records from the API response rejected due to a missing or invalid id.
  recordsInvalid: number;
  hasMore: boolean;
}

function sourceIdFromPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('id' in payload)) return null;
  const id = (payload as { id?: unknown }).id;
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && id.trim().length > 0) return id;
  return null;
}

// Exported for testability. Fetches exactly one API batch starting at `probeFrom`,
// stores valid records via the production commitBatch path (JSONB change detection),
// and intentionally does NOT call updateContinuation.
//
// Checkpoint isolation guarantee:
//   updateContinuation is the only method that creates or advances the TelecomCall
//   row in raw_sync_metadata. By never calling it, the checkpoint remains absent
//   after the probe. The subsequent 90-day historical run calls getContinuation(),
//   receives null, and starts from its configured historicalFrom date (2026-07-10).
//   Records already stored by the probe are encountered again and handled by the
//   change-detection path — no duplicate history rows are created.
//
// recoverInterruptedRuns() is scoped to source_system='ServiceTitan:<tenantId>' AND
// entity_type='TelecomCall'. It only resets TelecomCall sync_runs stuck in RUNNING
// and cannot affect any other entity type.
export async function runTelecomCallsProbe(
  client: TelecomCallsExportApi,
  repository: TelecomCallsRawRepository,
  probeFrom: string,
  endpoint: string,
): Promise<TelecomCallsProbeResult> {
  return repository.withExclusiveLock(async (lockedRepo) => {
    await lockedRepo.recoverInterruptedRuns();
    const syncRunId = await lockedRepo.createSyncRun();

    try {
      const response = await client.get<TelecomCallsExportResponse>(endpoint, { from: probeFrom });

      if (!Array.isArray(response.data) || typeof response.hasMore !== 'boolean') {
        throw new Error('Malformed ServiceTitan Telecom export response.');
      }

      logger.info('[TelecomProbe] API response received', {
        recordCount: response.data.length,
        hasMore: response.hasMore,
      });

      const records: { sourceId: string; payload: Record<string, unknown> }[] = [];
      const errorRecords: InvalidTelecomCallRecord[] = [];

      for (const payload of response.data) {
        const sourceId = sourceIdFromPayload(payload);
        if (sourceId === null || typeof payload !== 'object' || payload === null) {
          errorRecords.push({ sourceId, message: 'TelecomCall payload is missing a valid id.', payload });
        } else {
          records.push({ sourceId, payload: payload as Record<string, unknown> });
        }
      }

      // updateContinuation is intentionally NOT called here — checkpoint isolation.
      await lockedRepo.commitBatch(syncRunId, records, errorRecords);
      await lockedRepo.completeSyncRun(syncRunId, records.length);

      logger.info('[TelecomProbe] Probe complete — TelecomCall checkpoint NOT advanced', {
        syncRunId,
        recordsProcessed: records.length,
        recordsInvalid: errorRecords.length,
        hasMore: response.hasMore,
      });

      return {
        syncRunId,
        recordsProcessed: records.length,
        recordsInvalid: errorRecords.length,
        hasMore: response.hasMore,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await lockedRepo.failSyncRun(syncRunId, `Telecom probe failed: ${message.slice(0, 200)}`);
      logger.error('[TelecomProbe] Probe failed', { syncRunId, message });
      throw error;
    }
  });
}

async function main(): Promise<void> {
  const tenantId = env.SERVICETITAN_TENANT_ID;
  const endpoint = `/telecom/v2/tenant/${tenantId}/export/calls`;

  logger.info('[TelecomProbe] Starting single-batch probe', { from: PROBE_FROM, tenantId });

  try {
    const result = await runTelecomCallsProbe(
      apiClient,
      new PostgresTelecomCallsRawRepository(),
      PROBE_FROM,
      endpoint,
    );
    console.log('\nProbe complete:');
    console.log(`  syncRunId        : ${result.syncRunId}`);
    console.log(`  recordsProcessed : ${result.recordsProcessed}  (sent to commitBatch; may include idempotent updates)`);
    console.log(`  recordsInvalid   : ${result.recordsInvalid}  (missing id — written to sync_errors)`);
    console.log(`  hasMore          : ${result.hasMore}`);
    console.log('  checkpoint       : NOT advanced (90-day historical run unaffected)');
    if (result.hasMore) {
      console.log('\n  NOTE: The API has more records beyond this single batch. The 90-day historical');
      console.log('  run will cover all records starting from 2026-07-10.');
    }
  } finally {
    await db.destroy();
  }
}

if (require.main === module) void main().catch((err) => {
  console.error('[TelecomProbe] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
