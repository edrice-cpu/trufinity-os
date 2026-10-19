import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../../database';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { SYNC_RUNS_TABLE, SYNC_RUN_STATUS, SOURCE_SYSTEM } from '../../utils/sync-run.constants';
import { SyncInProgressError } from './ingestion/raw-export.ingestion';
import { serviceTitanCustomerIngestionService } from './ingestion/customer.ingestion';
import { serviceTitanLocationIngestionService } from './ingestion/location.ingestion';
import { serviceTitanJobIngestionService } from './ingestion/job.ingestion';
import { serviceTitanAppointmentIngestionService } from './ingestion/appointment.ingestion';
import { serviceTitanLeadIngestionService } from './ingestion/lead.ingestion';
import { serviceTitanBookingIngestionService } from './ingestion/booking.ingestion';
import { serviceTitanInvoiceIngestionService } from './ingestion/invoice.ingestion';
import { serviceTitanPaymentIngestionService } from './ingestion/payment.ingestion';
import { serviceTitanTechnicianIngestionService } from './ingestion/technician.ingestion';
import { serviceTitanBusinessUnitIngestionService } from './ingestion/business-unit.ingestion';
import {
  serviceTitanTelecomCallsIngestionService,
  TelecomCallsSyncInProgressError,
} from './ingestion/telecom-calls.ingestion';
import {
  serviceTitanTelecomCallsV3IngestionService,
  V3SyncInProgressError,
} from './ingestion/telecom-calls-v3.ingestion';
import { d02aRule } from './services/telecom-voicemail-callback.rule';

interface ServiceTitanScheduledSync {
  entityType: string;
  cronExpression: string;
  run: () => Promise<{ syncRunId: string; recordsProcessed: number }>;
}

// Previously ServiceTitan ingestion only ran from dev-only diagnostic routes
// (403 outside NODE_ENV=development) or a manual POST trigger for Business
// Units - nothing synced automatically in production (see BACKEND_BUILD_GUIDE.md
// Section 2: "no scheduler runs ServiceTitan ingestion yet"). All 9 regular
// entities share one daily cron; Business Units gets its own, far less
// frequent one since it's a small, mostly-static settings list.
const SCHEDULED_SYNCS: ServiceTitanScheduledSync[] = [
  { entityType: 'Customer', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanCustomerIngestionService.run() },
  { entityType: 'Location', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanLocationIngestionService.run() },
  { entityType: 'Job', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanJobIngestionService.run() },
  { entityType: 'Appointment', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanAppointmentIngestionService.run() },
  { entityType: 'Lead', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanLeadIngestionService.run() },
  { entityType: 'Booking', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanBookingIngestionService.run() },
  { entityType: 'Invoice', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanInvoiceIngestionService.run() },
  { entityType: 'Payment', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanPaymentIngestionService.run() },
  { entityType: 'Technician', cronExpression: env.SERVICETITAN_SYNC_CRON, run: () => serviceTitanTechnicianIngestionService.run() },
  { entityType: 'BusinessUnit', cronExpression: env.SERVICETITAN_BUSINESS_UNIT_SYNC_CRON, run: () => serviceTitanBusinessUnitIngestionService.run() },
];

// Upper bound for a single incremental Telecom run. The API returns at most
// 5,000 records per page; an incremental run over 4 hours of call activity is
// expected to be well under 1,000 records. Exceeding 5,500 is only possible
// if a bug or manual trigger caused the checkpoint to fall very far behind.
const TELECOM_INCREMENTAL_MAX_EXPECTED_RECORDS = 5_500;

// How long a Telecom checkpoint may sit unadvanced before it is treated as
// stale — an indicator that ingestion is silently failing or the scheduler
// is not firing.
const TELECOM_CHECKPOINT_STALE_HOURS = 6;

async function logIfTelecomCheckpointStale(): Promise<void> {
  const row = await db('raw_sync_metadata')
    .where({ source_system: `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`, entity_type: 'TelecomCall' })
    .select('last_synced_at')
    .first() as { last_synced_at: Date | null } | undefined;

  if (!row) {
    // No checkpoint at all — historical ingestion has never run.
    logger.warn('[ServiceTitan] TelecomCall checkpoint missing — historical ingestion may not have run yet');
    return;
  }

  if (!row.last_synced_at) {
    logger.warn('[ServiceTitan] TelecomCall checkpoint exists but last_synced_at is null');
    return;
  }

  const staleCutoff = new Date(Date.now() - TELECOM_CHECKPOINT_STALE_HOURS * 60 * 60_000);
  if (row.last_synced_at < staleCutoff) {
    logger.warn('[ServiceTitan] TelecomCall checkpoint is stale — last successful sync may have failed silently', {
      lastSyncedAt: row.last_synced_at.toISOString(),
      staleThresholdHours: TELECOM_CHECKPOINT_STALE_HOURS,
    });
  }
}

async function runScheduledTelecomSync(): Promise<void> {
  try {
    const result = await serviceTitanTelecomCallsIngestionService.run();
    logger.info('[ServiceTitan] Scheduled TelecomCall sync completed', result);

    if (result.recordsProcessed > TELECOM_INCREMENTAL_MAX_EXPECTED_RECORDS) {
      logger.warn('[ServiceTitan] TelecomCall incremental sync processed unexpectedly high record count', {
        recordsProcessed: result.recordsProcessed,
        threshold: TELECOM_INCREMENTAL_MAX_EXPECTED_RECORDS,
      });
    }
  } catch (error) {
    if (error instanceof TelecomCallsSyncInProgressError) {
      logger.info('[ServiceTitan] Scheduled TelecomCall sync skipped: already running');
      return;
    }
    logger.error('[ServiceTitan] Scheduled TelecomCall sync failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    await logIfRepeatedlyFailing('TelecomCall').catch(() => undefined);
  }

  await logIfTelecomCheckpointStale().catch(() => undefined);
}

// Same repeated-failure-streak heuristic as the Lace scheduler - one bad run
// is noise, three in a row needs an operator's attention.
const REPEATED_FAILURE_STREAK_THRESHOLD = 3;

async function logIfRepeatedlyFailing(entityType: string): Promise<void> {
  const recentRuns: { status: string }[] = await db(SYNC_RUNS_TABLE)
    .where({ source_system: SOURCE_SYSTEM.SERVICE_TITAN, entity_type: entityType })
    .orderBy('started_at', 'desc')
    .limit(REPEATED_FAILURE_STREAK_THRESHOLD)
    .select('status');

  const allFailed = recentRuns.length === REPEATED_FAILURE_STREAK_THRESHOLD && recentRuns.every((r) => r.status === SYNC_RUN_STATUS.FAILED);
  if (allFailed) {
    logger.error(`[ServiceTitan] ${entityType} has failed its last ${REPEATED_FAILURE_STREAK_THRESHOLD} runs in a row - needs operator attention`, {
      entityType,
    });
  }
}

async function runScheduledSync(sync: ServiceTitanScheduledSync): Promise<void> {
  try {
    const result = await sync.run();
    logger.info(`[ServiceTitan] Scheduled ${sync.entityType} sync completed`, result);
  } catch (error) {
    // A sync already in progress (e.g. a manual dev trigger overlapping the
    // cron tick) is expected and not an operational failure - log it quietly.
    if (error instanceof SyncInProgressError) {
      logger.info(`[ServiceTitan] Scheduled ${sync.entityType} sync skipped: already running`);
      return;
    }
    logger.error(`[ServiceTitan] Scheduled ${sync.entityType} sync failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    await logIfRepeatedlyFailing(sync.entityType).catch(() => undefined);
  }
}

// Marks any sync_runs stuck in RUNNING beyond a sane ceiling as FAILED - a
// crashed process otherwise leaves its run RUNNING until the next scheduled
// ingestion for that same entity happens to notice on its own next start.
async function reapStuckRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - env.SERVICETITAN_STUCK_RUN_THRESHOLD_MINUTES * 60_000);
  const stuck = await db(SYNC_RUNS_TABLE)
    .where({ source_system: SOURCE_SYSTEM.SERVICE_TITAN, status: SYNC_RUN_STATUS.RUNNING })
    .andWhere('started_at', '<', cutoff)
    .update({
      status: SYNC_RUN_STATUS.FAILED,
      error_message: `Sync run exceeded ${env.SERVICETITAN_STUCK_RUN_THRESHOLD_MINUTES} minutes in RUNNING state and was marked stuck.`,
      completed_at: db.fn.now(),
    })
    .returning('id');

  if (stuck.length > 0) {
    logger.warn('[ServiceTitan] Reaped stuck sync run(s)', { count: stuck.length, thresholdMinutes: env.SERVICETITAN_STUCK_RUN_THRESHOLD_MINUTES });
  }
}

// A cron only fires while the process is up at that minute. A dev machine that
// is off at 01:00, or a server restarted around then, silently skipped the
// day's sync - on the shared dev DB that left ServiceTitan data frozen at
// 27 Aug 2026 for weeks. This runs every entity whose last successful sync is
// older than its cadence allows (or that never synced), one at a time to stay
// inside ServiceTitan's API rate limits. `force` runs them all regardless.
const BUSINESS_UNIT_MAX_AGE_HOURS = 8 * 24;
const STARTUP_CATCH_UP_DELAY_MS = 30_000;

export async function runMissedServiceTitanSyncs(options: { force?: boolean; now?: Date } = {}): Promise<string[]> {
  const now = options.now ?? new Date();
  const ran: string[] = [];
  for (const sync of SCHEDULED_SYNCS) {
    const maxAgeHours = sync.entityType === 'BusinessUnit' ? BUSINESS_UNIT_MAX_AGE_HOURS : env.SERVICETITAN_CATCH_UP_AFTER_HOURS;
    const row = (await db(SYNC_RUNS_TABLE)
      .where({ source_system: SOURCE_SYSTEM.SERVICE_TITAN, entity_type: sync.entityType })
      .whereIn('status', [SYNC_RUN_STATUS.COMPLETED, SYNC_RUN_STATUS.COMPLETED_WITH_ERRORS])
      .max('completed_at as last')
      .first()) as { last: Date | string | null } | undefined;
    const last = row?.last ? new Date(row.last) : null;
    const missed = !last || now.getTime() - last.getTime() > maxAgeHours * 3_600_000;
    if (!options.force && !missed) continue;

    logger.info(`[ServiceTitan] Catching up ${sync.entityType} sync`, { lastSuccessfulSyncAt: last?.toISOString() ?? null, forced: options.force === true });
    await runScheduledSync(sync);
    ran.push(sync.entityType);
  }
  return ran;
}

// Registers the ServiceTitan ingestion cron jobs plus the stuck-run reaper.
// Call once at process startup (see server.ts) - not from app.ts, so
// importing the Express app in tests doesn't also spin up background cron jobs.
export function startServiceTitanScheduler(): ScheduledTask[] {
  const tasks = SCHEDULED_SYNCS.map((sync) => {
    const task = cron.schedule(sync.cronExpression, () => runScheduledSync(sync));
    logger.info(`[ServiceTitan] Scheduled ${sync.entityType} sync (cron: ${sync.cronExpression})`);
    return task;
  });

  if (env.SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED) {
    const telecomTask = cron.schedule(env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON, () => runScheduledTelecomSync());
    logger.info(`[ServiceTitan] Scheduled TelecomCall incremental sync (cron: ${env.SERVICETITAN_TELECOM_CALLS_SYNC_CRON})`);
    tasks.push(telecomTask);
  } else {
    logger.info('[ServiceTitan] TelecomCall incremental sync is disabled (SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED=false)');
  }

  if (env.SERVICETITAN_TELECOM_V3_SYNC_ENABLED) {
    const v3Task = cron.schedule(env.SERVICETITAN_TELECOM_V3_SYNC_CRON, () => runScheduledV3Sync());
    logger.info(`[ServiceTitan] Scheduled TelecomCallV3 enrichment sync (cron: ${env.SERVICETITAN_TELECOM_V3_SYNC_CRON})`);
    tasks.push(v3Task);
  } else {
    logger.info('[ServiceTitan] TelecomCallV3 enrichment sync is disabled (SERVICETITAN_TELECOM_V3_SYNC_ENABLED=false)');
  }

  const reaperTask = cron.schedule(env.SERVICETITAN_STUCK_RUN_REAPER_CRON, () =>
    reapStuckRuns().catch((error) => logger.error('[ServiceTitan] Stuck-run reaper failed', { error: error instanceof Error ? error.message : String(error) })),
  );
  logger.info(`[ServiceTitan] Scheduled stuck-run reaper (cron: ${env.SERVICETITAN_STUCK_RUN_REAPER_CRON})`);

  if (env.SERVICETITAN_CATCH_UP_ON_STARTUP) {
    // Delayed so startup (migrations, other schedulers) settles first; unref'd
    // so it never keeps a short-lived process alive.
    setTimeout(() => {
      runMissedServiceTitanSyncs().catch((error) =>
        logger.error('[ServiceTitan] Startup catch-up failed', { error: error instanceof Error ? error.message : String(error) }));
    }, STARTUP_CATCH_UP_DELAY_MS).unref();
  }

  return [...tasks, reaperTask];
}

async function runD02aEvaluation(): Promise<void> {
  if (!env.TELECOM_D02A_ENABLED) return;
  await d02aRule
    .evaluate({
      sourceSystem: `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`,
      businessCalendar: {
        timezone: env.TELECOM_D02A_TIMEZONE,
        startHour: env.TELECOM_D02A_BUSINESS_START_HOUR,
        endHour: env.TELECOM_D02A_BUSINESS_END_HOUR,
      },
      thresholdMinutes: env.TELECOM_D02A_THRESHOLD_MINUTES,
      lookbackDays: env.TELECOM_D02A_LOOKBACK_DAYS,
    })
    .then(() => {
      logger.info('[ServiceTitan] D-02a voicemail callback evaluation completed');
    })
    .catch((err: unknown) => {
      logger.warn('[ServiceTitan] D-02a voicemail callback evaluation failed — sync unaffected', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

async function runScheduledV3Sync(): Promise<void> {
  try {
    const result = await serviceTitanTelecomCallsV3IngestionService.run();
    logger.info('[ServiceTitan] Scheduled TelecomCallV3 enrichment sync completed', result);

    // D-02a runs non-fatally after V3 enrichment so call data is fresh.
    // Disabled by default — enable via TELECOM_D02A_ENABLED=true after migration applied.
    await runD02aEvaluation();
  } catch (error) {
    if (error instanceof V3SyncInProgressError) {
      logger.info('[ServiceTitan] Scheduled TelecomCallV3 enrichment sync skipped: already running');
      return;
    }
    logger.error('[ServiceTitan] Scheduled TelecomCallV3 enrichment sync failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    await logIfRepeatedlyFailing('TelecomCallV3').catch(() => undefined);
  }
}
