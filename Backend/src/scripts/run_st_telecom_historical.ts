import { db } from '../database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  ServiceTitanTelecomCallsIngestionService,
  PostgresTelecomCallsRawRepository,
} from '../modules/servicetitan/ingestion/telecom-calls.ingestion';

// ─── Preflight ────────────────────────────────────────────────────────────────

interface PreflightResult {
  tenantId: string;
  historicalFrom: string;
  savedCheckpoint: string | null;
  effectiveFrom: string;
}

async function preflight(): Promise<PreflightResult> {
  const tenantId = env.SERVICETITAN_TENANT_ID;
  const historicalFrom = env.SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM;

  if (!tenantId || tenantId.trim().length === 0) {
    throw new Error('SERVICETITAN_TENANT_ID is not configured.');
  }

  // Read the current checkpoint directly from the DB (read-only).
  const repo = new PostgresTelecomCallsRawRepository();
  const savedCheckpoint = await repo.getContinuation();
  const effectiveFrom = savedCheckpoint ?? historicalFrom;

  return { tenantId, historicalFrom, savedCheckpoint, effectiveFrom };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

// Exported for testability. Accepts an optional service instance so tests can
// inject a fake without modifying module-level singletons.
export async function runHistoricalIngestion(
  service: Pick<ServiceTitanTelecomCallsIngestionService, 'run'> = new ServiceTitanTelecomCallsIngestionService(),
): Promise<{ syncRunId: string; recordsProcessed: number; durationMs: number }> {
  const { tenantId, historicalFrom, savedCheckpoint, effectiveFrom } = await preflight();

  console.log('\n=== ServiceTitan Telecom Historical Ingestion ===');
  console.log(`  Tenant ID       : ${tenantId}`);
  console.log(`  Historical from : ${historicalFrom}  (env)`);
  console.log(`  Saved checkpoint: ${savedCheckpoint ?? '(none — first run)'}`);
  console.log(`  Effective from  : ${effectiveFrom}`);
  console.log('=================================================\n');

  logger.info('[TelecomHistorical] Starting historical ingestion', {
    tenantId,
    historicalFrom,
    savedCheckpoint,
    effectiveFrom,
  });

  const startMs = Date.now();
  const result = await service.run();
  const durationMs = Date.now() - startMs;

  logger.info('[TelecomHistorical] Historical ingestion complete', {
    syncRunId: result.syncRunId,
    recordsProcessed: result.recordsProcessed,
    durationMs,
  });

  console.log('\n=== Ingestion complete ===');
  console.log(`  syncRunId        : ${result.syncRunId}`);
  console.log(`  recordsProcessed : ${result.recordsProcessed}`);
  console.log(`  duration         : ${(durationMs / 1000).toFixed(1)} s`);
  console.log('=========================\n');

  return { ...result, durationMs };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await runHistoricalIngestion();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[TelecomHistorical] Ingestion failed', { message });
    console.error(`\n[TelecomHistorical] FAILED: ${message}\n`);
    // DB connection is closed in the finally block before exit.
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (require.main === module) void main();
