/**
 * Google Workspace Responsiveness Worker
 *
 * Runs the R-01 (unanswered inbound email) evaluation loop and, in future,
 * R-02–R-05 as they are implemented.
 *
 * The worker is disabled by default (GOOGLE_R01_ENABLED=false) and must be
 * explicitly enabled before starting. When disabled, the process starts and
 * immediately exits cleanly — this is intentional so PM2 does not restart-loop
 * on a misconfigured or intentionally disabled node.
 *
 * PM2 config: ecosystem.google-responsiveness.config.cjs
 * Start: pm2 start ecosystem.google-responsiveness.config.cjs --env production
 * Stop:  pm2 stop trufinity-google-responsiveness
 */

import { env } from '../config/env';
import { db } from '../database';
import { logger } from '../utils/logger';
import { GoogleResponsivenessScheduler, type ResponsivenessSchedulerLogger } from '../modules/google/responsiveness.scheduler';
import { KnexR01Rule } from '../modules/google/responsiveness-rule-r01';

export interface ResponsivenessWorkerDatabase { raw(query: string): Promise<unknown>; destroy(): Promise<unknown>; }
export interface ResponsivenessWorkerConfig { enabled: boolean; evalIntervalMs: number; }
export interface ResponsivenessWorkerScheduler { start(): void; stop(): Promise<void>; }
export interface ResponsivenessWorkerDependencies {
  database: ResponsivenessWorkerDatabase;
  config: ResponsivenessWorkerConfig;
  runEvaluation(): Promise<{ alertsOpened: number; alertsClosed: number }>;
  logger: ResponsivenessSchedulerLogger;
  createScheduler(
    runEvaluation: () => Promise<{ alertsOpened: number; alertsClosed: number }>,
    intervalMs: number,
  ): ResponsivenessWorkerScheduler;
  registerShutdown(handler: (signal: 'SIGTERM' | 'SIGINT') => void): () => void;
}

export const validateResponsivenessWorkerConfig = (config: ResponsivenessWorkerConfig): void => {
  if (config.evalIntervalMs < 300_000 || config.evalIntervalMs > 86_400_000) {
    throw new Error('Responsiveness worker eval interval must be between 300000 and 86400000 ms.');
  }
};

export const startGoogleResponsivenessWorker = async (
  dependencies: ResponsivenessWorkerDependencies,
): Promise<{ shutdown(): Promise<void> }> => {
  if (!dependencies.config.enabled) {
    dependencies.logger.info('Google Workspace responsiveness worker is disabled (GOOGLE_R01_ENABLED=false). No rules will run.');
    return { shutdown: async () => undefined };
  }

  validateResponsivenessWorkerConfig(dependencies.config);
  await dependencies.database.raw('SELECT 1');
  dependencies.logger.info('Google Workspace responsiveness worker database connectivity verified.');

  const scheduler = dependencies.createScheduler(
    () => dependencies.runEvaluation(),
    dependencies.config.evalIntervalMs,
  );

  let shutdownPromise: Promise<void> | undefined;
  let unregisterShutdown = (): void => undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    unregisterShutdown();
    shutdownPromise = (async () => {
      dependencies.logger.info('Google Workspace responsiveness worker stopping; waiting for the active cycle to finish.');
      await scheduler.stop();
      await dependencies.database.destroy();
      dependencies.logger.info('Google Workspace responsiveness worker stopped cleanly.');
    })();
    return shutdownPromise;
  };

  unregisterShutdown = dependencies.registerShutdown((signal) => {
    dependencies.logger.info(`Google Workspace responsiveness worker received ${signal}; graceful shutdown requested.`);
    void shutdown().catch(() => {
      dependencies.logger.error('Google Workspace responsiveness worker shutdown encountered an error.');
      process.exitCode = 1;
    });
  });

  scheduler.start();
  dependencies.logger.info('Google Workspace responsiveness worker started; first evaluation cycle begins immediately.');
  return { shutdown };
};

const registerProcessShutdown = (handler: (signal: 'SIGTERM' | 'SIGINT') => void): (() => void) => {
  const onSigterm = (): void => handler('SIGTERM');
  const onSigint = (): void => handler('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  return () => { process.removeListener('SIGTERM', onSigterm); process.removeListener('SIGINT', onSigint); };
};

const main = async (): Promise<void> => {
  try {
    const rule = new KnexR01Rule(db);
    const r01Config = {
      businessCalendar: {
        timezone: env.GOOGLE_R01_TIMEZONE,
        startHour: env.GOOGLE_R01_BUSINESS_START_HOUR,
        endHour: env.GOOGLE_R01_BUSINESS_END_HOUR,
      },
      thresholdMinutes: env.GOOGLE_R01_THRESHOLD_MINUTES,
      workspaceDomain: 'trufinity.ca',
      lookbackDays: env.GOOGLE_R01_LOOKBACK_DAYS,
    };

    await startGoogleResponsivenessWorker({
      database: db,
      config: {
        enabled: env.GOOGLE_R01_ENABLED,
        evalIntervalMs: env.GOOGLE_R01_EVAL_INTERVAL_MS,
      },
      runEvaluation: async () => {
        // Fetch all enabled mailboxes and evaluate each.
        const mailboxes = await db('google_gmail_mailboxes')
          .select('normalized_mailbox_address')
          .where({ enabled: true }) as { normalized_mailbox_address: string }[];

        let alertsOpened = 0;
        let alertsClosed = 0;

        for (const { normalized_mailbox_address } of mailboxes) {
          try {
            const before = await db('google_unanswered_thread_alerts')
              .where({ mailbox_address: normalized_mailbox_address, status: 'OPEN' })
              .count<{ count: string }>({ count: '*' })
              .first();

            await rule.evaluateMailbox(normalized_mailbox_address, r01Config);

            const after = await db('google_unanswered_thread_alerts')
              .where({ mailbox_address: normalized_mailbox_address, status: 'OPEN' })
              .count<{ count: string }>({ count: '*' })
              .first();

            const beforeCount = Number(before?.count ?? 0);
            const afterCount = Number(after?.count ?? 0);
            if (afterCount > beforeCount) alertsOpened += afterCount - beforeCount;
            if (afterCount < beforeCount) alertsClosed += beforeCount - afterCount;
          } catch (err) {
            logger.warn(`[R01] Evaluation failed for mailbox ${normalized_mailbox_address}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return { alertsOpened, alertsClosed };
      },
      logger,
      createScheduler: (runEvaluation, intervalMs) =>
        new GoogleResponsivenessScheduler({ runEvaluation, intervalMs, logger }),
      registerShutdown: registerProcessShutdown,
    });
  } catch {
    logger.error('Google Workspace responsiveness worker startup failed; verify configuration and database connectivity.');
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  }
};

if (require.main === module) void main();
