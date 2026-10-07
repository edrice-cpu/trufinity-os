import { env } from '../config/env';
import { db } from '../database';
import { logger } from '../utils/logger';
import { GmailIncrementalScheduler, validateGmailSyncInterval, type GmailIncrementalSchedulerLogger } from '../modules/google/gmail-incremental.scheduler';
import { gmailIncrementalSyncService } from '../modules/google/gmail-incremental.service';

export interface GmailWorkerDatabase { raw(query: string): Promise<unknown>; destroy(): Promise<unknown>; }
export interface GmailWorkerConfig { pollIntervalMs: number; }
export interface GmailWorkerScheduler { start(): void; stop(): Promise<void>; }
export interface GmailWorkerDependencies {
  database: GmailWorkerDatabase;
  config: GmailWorkerConfig;
  runMailboxes(): Promise<{ completed: { mailboxAddress: string }[]; failed: { mailboxAddress: string }[] }>;
  logger: GmailIncrementalSchedulerLogger;
  createScheduler(runMailboxes: () => Promise<{ completed: { mailboxAddress: string }[]; failed: { mailboxAddress: string }[] }>, intervalMs: number): GmailWorkerScheduler;
  registerShutdown(handler: (signal: 'SIGTERM' | 'SIGINT') => void): () => void;
}

export const validateGmailWorkerConfig = (config: GmailWorkerConfig): void => {
  validateGmailSyncInterval(config.pollIntervalMs);
};

export const startGmailIncrementalWorker = async (dependencies: GmailWorkerDependencies): Promise<{ shutdown(): Promise<void> }> => {
  validateGmailWorkerConfig(dependencies.config);
  await dependencies.database.raw('SELECT 1');
  dependencies.logger.info('Google Workspace Gmail incremental worker database connectivity verified.');
  
  const scheduler = dependencies.createScheduler(
    () => dependencies.runMailboxes(),
    dependencies.config.pollIntervalMs
  );
  
  let shutdownPromise: Promise<void> | undefined;
  let unregisterShutdown = (): void => undefined;
  
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    unregisterShutdown();
    shutdownPromise = (async () => {
      dependencies.logger.info('Google Workspace Gmail incremental worker stopping; waiting for the active cycle to finish.');
      await scheduler.stop();
      await dependencies.database.destroy();
      dependencies.logger.info('Google Workspace Gmail incremental worker stopped cleanly.');
    })();
    return shutdownPromise;
  };
  
  unregisterShutdown = dependencies.registerShutdown((signal) => {
    dependencies.logger.info(`Google Workspace Gmail incremental worker received ${signal}; graceful shutdown requested.`);
    void shutdown().catch(() => {
      dependencies.logger.error('Google Workspace Gmail incremental worker shutdown encountered an error.');
      process.exitCode = 1;
    });
  });
  
  scheduler.start();
  dependencies.logger.info('Google Workspace Gmail incremental worker started; first cycle begins immediately.');
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
    await startGmailIncrementalWorker({
      database: db,
      config: { pollIntervalMs: env.GOOGLE_GMAIL_SYNC_INTERVAL_MS },
      runMailboxes: async () => {
         const result = await gmailIncrementalSyncService.runAllEligibleMailboxes();
         return {
           completed: result.completed.map(c => ({ mailboxAddress: c.mailboxAddress })),
           failed: result.failed.map(f => ({ mailboxAddress: f.mailboxAddress }))
         };
      },
      logger,
      createScheduler: (runMailboxes, intervalMs) => new GmailIncrementalScheduler({ runMailboxes, intervalMs, logger }),
      registerShutdown: registerProcessShutdown,
    });
  } catch {
    logger.error('Google Workspace Gmail incremental worker startup failed; verify configuration and database connectivity.');
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  }
};

if (require.main === module) void main();
