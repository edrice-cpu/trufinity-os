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

// Registers the ServiceTitan ingestion cron jobs plus the stuck-run reaper.
// Call once at process startup (see server.ts) - not from app.ts, so
// importing the Express app in tests doesn't also spin up background cron jobs.
export function startServiceTitanScheduler(): ScheduledTask[] {
  const tasks = SCHEDULED_SYNCS.map((sync) => {
    const task = cron.schedule(sync.cronExpression, () => runScheduledSync(sync));
    logger.info(`[ServiceTitan] Scheduled ${sync.entityType} sync (cron: ${sync.cronExpression})`);
    return task;
  });

  const reaperTask = cron.schedule(env.SERVICETITAN_STUCK_RUN_REAPER_CRON, () =>
    reapStuckRuns().catch((error) => logger.error('[ServiceTitan] Stuck-run reaper failed', { error: error instanceof Error ? error.message : String(error) })),
  );
  logger.info(`[ServiceTitan] Scheduled stuck-run reaper (cron: ${env.SERVICETITAN_STUCK_RUN_REAPER_CRON})`);

  return [...tasks, reaperTask];
}
