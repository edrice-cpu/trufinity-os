import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../../database';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { SYNC_RUNS_TABLE, SYNC_RUN_STATUS, SOURCE_SYSTEM } from '../../utils/sync-run.constants';
import { withAdvisoryLock } from '../../utils/advisory-lock';
import { detectService } from '../detect/detect.service';
import { narrateService } from '../narrate/narrate.service';
import { laceCallAnalysisIngestionService } from './ingestion/call-analysis.ingestion';
import { laceAgentPerformanceIngestionService } from './ingestion/agent-performance.ingestion';
import { LaceSyncInProgressError } from './ingestion/lace-raw.ingestion';
import { callAnalysisCanonicalService } from './canonical/call-analysis.canonical.service';

const DETECT_NARRATE_LOCK_KEY = 'trufinity:detect-narrate-pipeline';

class DetectNarrateInProgressError extends Error {
  public constructor() {
    super('Detect/Narrate pipeline is already running.');
    this.name = 'DetectNarrateInProgressError';
  }
}

// Detect and Narrate previously ran only from dev-only routes (403 outside
// NODE_ENV=development), so in production nothing ever produced or narrated
// detected_alerts - the dashboard API would have served an empty list forever.
// The Postgres advisory lock keeps two app instances firing the same cron
// tick from double-narrating one alert (a duplicate, billed LLM call).
async function runDetectAndNarrate(): Promise<void> {
  try {
    await withAdvisoryLock(db, DETECT_NARRATE_LOCK_KEY, () => new DetectNarrateInProgressError(), async () => {
      const detected = await detectService.run();
      logger.info('[LaceAI] Detect completed after canonical sync', { findings: detected.findings.length });

      if (env.ANTHROPIC_API_KEY.length === 0) {
        logger.warn('[LaceAI] Narrate skipped: ANTHROPIC_API_KEY is not configured; alerts stay un-narrated');
        return;
      }
      const narrated = await narrateService.run();
      logger.info('[LaceAI] Narrate completed after detect', narrated);
    });
  } catch (error) {
    if (error instanceof DetectNarrateInProgressError) {
      logger.info('[LaceAI] Detect/Narrate skipped: already running on another instance');
      return;
    }
    throw error;
  }
}

interface LaceScheduledSync {
  exportType: string;
  cronExpression: string;
  run: () => Promise<{ syncRunId: string; recordsProcessed: number; filesProcessed: number; filesFailed: number }>;
  // Runs after a successful (or partially-successful) raw sync. Without this,
  // canonical_lace_calls never gets populated in production: it was
  // previously reachable only via a dev-only route that 403s outside
  // NODE_ENV=development, so nothing ever ran it once the scheduler took over.
  afterSuccess?: () => Promise<void>;
}

const SCHEDULED_SYNCS: LaceScheduledSync[] = [
  {
    exportType: 'call_analysis',
    cronExpression: env.LACE_CALL_ANALYSIS_CRON,
    run: () => laceCallAnalysisIngestionService.run(),
    afterSuccess: async () => {
      const result = await callAnalysisCanonicalService.sync();
      logger.info('[LaceAI] Canonical call analysis sync completed after scheduled ingestion', result);
      await runDetectAndNarrate();
    },
  },
  {
    exportType: 'agent_performance',
    cronExpression: env.LACE_AGENT_PERFORMANCE_CRON,
    run: () => laceAgentPerformanceIngestionService.run(),
  },
];

// How many of the most recent sync_runs (for this export type) to look at
// when deciding whether a failure is part of a repeated-failure streak worth
// calling out loudly (as opposed to one isolated bad run).
const REPEATED_FAILURE_STREAK_THRESHOLD = 3;

async function logIfRepeatedlyFailing(exportType: string): Promise<void> {
  const recentRuns: { status: string }[] = await db(SYNC_RUNS_TABLE)
    .where({ source_system: SOURCE_SYSTEM.LACE_AI, entity_type: exportType })
    .orderBy('started_at', 'desc')
    .limit(REPEATED_FAILURE_STREAK_THRESHOLD)
    .select('status');

  const allFailed = recentRuns.length === REPEATED_FAILURE_STREAK_THRESHOLD && recentRuns.every((r) => r.status === SYNC_RUN_STATUS.FAILED);
  if (allFailed) {
    logger.error(`[LaceAI] ${exportType} has failed its last ${REPEATED_FAILURE_STREAK_THRESHOLD} runs in a row - needs operator attention`, {
      exportType,
    });
  }
}

async function runScheduledSync(sync: LaceScheduledSync): Promise<void> {
  try {
    const result = await sync.run();
    if (result.filesFailed > 0) {
      logger.error(`[LaceAI] Scheduled ${sync.exportType} sync completed with per-file failures`, result);
    } else {
      logger.info(`[LaceAI] Scheduled ${sync.exportType} sync completed`, result);
    }

    if (sync.afterSuccess) {
      try {
        await sync.afterSuccess();
      } catch (afterError) {
        // The raw sync itself succeeded; a downstream step failing shouldn't
        // be reported as an ingestion failure, but it must still be loud.
        logger.error(`[LaceAI] Post-sync step failed for ${sync.exportType}`, {
          error: afterError instanceof Error ? afterError.message : String(afterError),
        });
      }
    }
  } catch (error) {
    // A sync already in progress (e.g. a manual dev trigger overlapping the
    // cron tick) is expected and not an operational failure - log it quietly.
    if (error instanceof LaceSyncInProgressError) {
      logger.info(`[LaceAI] Scheduled ${sync.exportType} sync skipped: already running`);
      return;
    }
    logger.error(`[LaceAI] Scheduled ${sync.exportType} sync failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    await logIfRepeatedlyFailing(sync.exportType).catch(() => undefined);
  }
}

// Marks any sync_runs stuck in RUNNING beyond a sane ceiling as FAILED. A
// crashed process leaves its run RUNNING forever otherwise - the ingestion
// code only notices on its *own* next start (recoverInterruptedRuns), which
// for a once-a-day cron can mean a 24h-long blind spot. This reaper runs on
// its own tighter interval so a stuck job surfaces quickly regardless of
// when either sync next happens to fire.
async function reapStuckRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - env.LACE_STUCK_RUN_THRESHOLD_MINUTES * 60_000);
  const stuck = await db(SYNC_RUNS_TABLE)
    .where({ source_system: SOURCE_SYSTEM.LACE_AI, status: SYNC_RUN_STATUS.RUNNING })
    .andWhere('started_at', '<', cutoff)
    .update({
      status: SYNC_RUN_STATUS.FAILED,
      error_message: `Sync run exceeded ${env.LACE_STUCK_RUN_THRESHOLD_MINUTES} minutes in RUNNING state and was marked stuck.`,
      completed_at: db.fn.now(),
    })
    .returning('id');

  if (stuck.length > 0) {
    // A recovered/reaped run is a handled outcome, not an unhandled error -
    // it should be visible without being alarm-level noise in the logs.
    logger.warn('[LaceAI] Reaped stuck sync run(s)', { count: stuck.length, thresholdMinutes: env.LACE_STUCK_RUN_THRESHOLD_MINUTES });
  }
}

// Registers the Lace AI ingestion cron jobs plus the stuck-run reaper. Call
// once at process startup (see server.ts) - not from app.ts, so importing
// the Express app in tests doesn't also spin up background cron jobs.
export function startLaceScheduler(): ScheduledTask[] {
  const tasks = SCHEDULED_SYNCS.map((sync) => {
    // Returning the promise (rather than firing-and-forgetting it) lets
    // node-cron - and tests - actually await a tick's completion.
    const task = cron.schedule(sync.cronExpression, () => runScheduledSync(sync));
    logger.info(`[LaceAI] Scheduled ${sync.exportType} sync (cron: ${sync.cronExpression})`);
    return task;
  });

  const reaperTask = cron.schedule(env.LACE_STUCK_RUN_REAPER_CRON, () =>
    reapStuckRuns().catch((error) => logger.error('[LaceAI] Stuck-run reaper failed', { error: error instanceof Error ? error.message : String(error) })),
  );
  logger.info(`[LaceAI] Scheduled stuck-run reaper (cron: ${env.LACE_STUCK_RUN_REAPER_CRON})`);

  return [...tasks, reaperTask];
}
