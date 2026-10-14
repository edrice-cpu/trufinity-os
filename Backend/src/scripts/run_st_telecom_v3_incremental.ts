
import { db } from '../database';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import {
  ServiceTitanTelecomCallsV3IngestionService,
  PostgresV3EnrichmentRepository,
} from '../modules/servicetitan/ingestion/telecom-calls-v3.ingestion';

interface PreflightResult {
  tenantId: string;
  savedCheckpoint: string;
  overlapMinutes: number;
}

async function preflight(): Promise<PreflightResult> {
  const tenantId = env.SERVICETITAN_TENANT_ID;

  if (!tenantId || tenantId.trim().length === 0) {
    throw new Error('SERVICETITAN_TENANT_ID is not configured.');
  }

  const repo = new PostgresV3EnrichmentRepository();
  const savedCheckpoint = await repo.getContinuation();

  if (!savedCheckpoint) {
    throw new Error(
      'No V3 checkpoint found. Refusing to run historical backfill.',
    );
  }

  const checkpointMs = Date.parse(savedCheckpoint);

  if (!Number.isFinite(checkpointMs)) {
    throw new Error('Invalid V3 checkpoint timestamp.');
  }

  return {
    tenantId,
    savedCheckpoint,
    overlapMinutes: env.SERVICETITAN_TELECOM_V3_OVERLAP_MINUTES,
  };
}

export async function runV3IncrementalSync(
  service: Pick<ServiceTitanTelecomCallsV3IngestionService, 'run'> =
    new ServiceTitanTelecomCallsV3IngestionService(),
): Promise<{
  syncRunId: string;
  recordsProcessed: number;
  durationMs: number;
}> {
  const { tenantId, savedCheckpoint, overlapMinutes } = await preflight();

  const checkpointDate = savedCheckpoint.substring(0, 10);

  console.log('\n=== ServiceTitan Telecom V3 Incremental Sync ===');
  console.log(`Tenant ID       : ${tenantId}`);
  console.log(`Checkpoint date : ${checkpointDate}`);
  console.log(`Overlap minutes : ${overlapMinutes}`);
  console.log('===============================================\n');

  const startMs = Date.now();
  const result = await service.run();
  const durationMs = Date.now() - startMs;

  logger.info('[TelecomV3Incremental] Sync complete', {
    syncRunId: result.syncRunId,
    recordsProcessed: result.recordsProcessed,
    durationMs,
  });

  console.log('\n=== Sync complete ===');
  console.log(`Sync Run ID      : ${result.syncRunId}`);
  console.log(`Records Processed: ${result.recordsProcessed}`);
  console.log(`Duration         : ${(durationMs / 1000).toFixed(1)} seconds`);
  console.log('=====================\n');

  return { ...result, durationMs };
}

async function main(): Promise<void> {
  try {
    await runV3IncrementalSync();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    logger.error('[TelecomV3Incremental] Sync failed', { message });
    console.error(`V3 sync FAILED: ${message}`);

    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  void main();
}
