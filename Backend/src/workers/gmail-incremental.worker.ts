import { env } from '../config/env';
import { db } from '../database';
import { logger } from '../utils/logger';
import { GmailIncrementalScheduler, validateGmailSyncInterval, type GmailIncrementalSchedulerLogger } from '../modules/google/gmail-incremental.scheduler';
import { gmailIncrementalSyncService } from '../modules/google/gmail-incremental.service';
import { SmtpWorkItemNotifier } from '../modules/google/work-item-notifier';
import { assertGoogleCredentialsConfigured } from '../modules/google/google-auth.service';

export interface GmailWorkerDatabase { raw(query: string): Promise<unknown>; destroy(): Promise<unknown>; }
export interface GmailWorkerConfig { pollIntervalMs: number; }
export interface GmailWorkerScheduler { start(): void; stop(): Promise<void>; }
export interface GmailWorkerDependencies {
  database: GmailWorkerDatabase;
  config: GmailWorkerConfig;
  runMailboxes(): Promise<{ completed: { mailboxAddress: string }[]; failed: { mailboxAddress: string }[] }>;
  /** Called at the start of every poll cycle to retry stuck/failed notifications. */
  recoverNotifications(): Promise<number>;
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
    async () => {
      // Run notification recovery first so stuck/failed deliveries from any
      // previous cycle are retried before the next batch of work items is
      // classified. Errors here must not abort the mailbox sync.
      try {
        const recovered = await dependencies.recoverNotifications();
        if (recovered > 0) {
          dependencies.logger.info(`Google Workspace Gmail incremental worker recovered ${recovered} pending notification(s).`);
        }
      } catch (err) {
        // Log only the error constructor name to avoid leaking any credential
        // or content material that might appear in SMTP/DB error messages.
        const kind = err instanceof Error ? err.constructor.name : typeof err;
        dependencies.logger.error(`Google Workspace Gmail incremental worker notification recovery failed (${kind}); check application logs for details.`);
      }
      return dependencies.runMailboxes();
    },
    dependencies.config.pollIntervalMs,
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
    assertGoogleCredentialsConfigured({
      projectId: env.GOOGLE_CLOUD_PROJECT_ID,
      serviceAccountEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      serviceAccountPrivateKey: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      adminDelegatedUser: env.GOOGLE_ADMIN_DELEGATED_USER,
    });
    const notifier = new SmtpWorkItemNotifier();
    await startGmailIncrementalWorker({
      database: db,
      config: { pollIntervalMs: env.GOOGLE_GMAIL_SYNC_INTERVAL_MS },
      recoverNotifications: () => notifier.recoverPendingNotifications(),
      runMailboxes: async () => {
        const result = await gmailIncrementalSyncService.runAllEligibleMailboxes();
        return {
          completed: result.completed.map(c => ({ mailboxAddress: c.mailboxAddress })),
          failed: result.failed.map(f => ({ mailboxAddress: f.mailboxAddress })),
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
