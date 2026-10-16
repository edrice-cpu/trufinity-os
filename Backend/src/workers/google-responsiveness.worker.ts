/**
 * Google Workspace Responsiveness Worker
 *
 * Runs the R-01 (unanswered inbound email) and R-02 (stalled thread) evaluation
 * loops. Additional rules (R-03–R-05) will be wired here as implemented.
 *
 * Both rules are disabled by default. At least one must be enabled before the
 * worker starts. When both are disabled the process exits cleanly — intentional
 * so PM2 does not restart-loop on a misconfigured or disabled node.
 *
 * PM2 config: ecosystem.google-responsiveness.config.cjs
 * Start: pm2 start ecosystem.google-responsiveness.config.cjs --env production
 * Stop:  pm2 stop trufinity-google-responsiveness
 *
 * Controlled-execution flags (pass as node CLI arguments):
 *   --single-pass   Run exactly one evaluation cycle then exit (no scheduler loop).
 *   --dry-run       Log what would be evaluated; skip all DB writes and notifications.
 *
 * Both modes require GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=DISABLED.
 */

import { env } from '../config/env';
import { db } from '../database';
import { logger } from '../utils/logger';
import { GoogleResponsivenessScheduler, type ResponsivenessSchedulerLogger } from '../modules/google/responsiveness.scheduler';
import { KnexR01Rule, type R01Config, type R01Rule } from '../modules/google/responsiveness-rule-r01';
import { KnexR02Rule, type R02Config, type R02Rule } from '../modules/google/responsiveness-rule-r02';
import { KnexR03Rule, type R03Config, type R03Rule } from '../modules/google/responsiveness-rule-r03';
import { KnexR04Rule, type R04Config, type R04Rule } from '../modules/google/responsiveness-rule-r04';
import {
  type ResponsivenessNotifier,
  NoOpResponsivenessNotifier,
  createResponsivenessNotifier,
} from '../modules/google/responsiveness-notifier';

export interface ResponsivenessWorkerDatabase {
  raw(query: string): Promise<unknown>;
  destroy(): Promise<unknown>;
}

export type QueryableDatabase = (table: string) => import('knex').Knex.QueryBuilder;
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

// ---------------------------------------------------------------------------
// Evaluation cycle builder — exported for testability
// ---------------------------------------------------------------------------

export interface EvaluationCycleOptions {
  r01Enabled: boolean;
  r01Rule: R01Rule;
  r01Config: R01Config;
  r02Enabled: boolean;
  r02Rule: R02Rule;
  r02Config: R02Config;
  r03Enabled: boolean;
  r03Rule: R03Rule;
  r03Config: R03Config;
  r04Enabled: boolean;
  r04Rule: R04Rule;
  r04Config: R04Config;
  /** Notification delivery; null/undefined disables notifications (default). */
  notifier?: ResponsivenessNotifier | null;
  logger: ResponsivenessSchedulerLogger;
  /**
   * When true, skip all DB writes and external notifications for the cycle.
   * Only the mailbox list and eligible rules are logged.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Parsed CLI worker arguments
// ---------------------------------------------------------------------------

export interface WorkerArgs {
  /** Run one evaluation cycle and exit (no scheduler loop). */
  singlePass: boolean;
  /** Skip all DB writes and notifications; log what would run. */
  dryRun: boolean;
}

export const parseWorkerArgs = (argv: string[]): WorkerArgs => ({
  singlePass: argv.includes('--single-pass'),
  dryRun: argv.includes('--dry-run'),
});

export type MailboxLoader = () => Promise<string[]>;

/**
 * Returns a `runEvaluation` function that evaluates all enabled rules for every
 * active mailbox in one scheduler cycle.
 *
 * Exported so that integration tests can inject mock rules and mailbox loaders
 * without touching the real database or Gmail API.
 */
export const buildEvaluationCycle = (
  loadMailboxes: MailboxLoader,
  opts: EvaluationCycleOptions,
  database: QueryableDatabase,
  /** Optional allowlist; when provided only matching mailboxes are evaluated. */
  mailboxAllowlist?: string[],
): () => Promise<{ alertsOpened: number; alertsClosed: number }> => {
  return async () => {
    const allMailboxes = await loadMailboxes();
    const normalizedAllowlist = mailboxAllowlist?.map((a) => a.toLowerCase());
    const mailboxes = normalizedAllowlist && normalizedAllowlist.length > 0
      ? allMailboxes.filter((m) => normalizedAllowlist.includes(m.toLowerCase()))
      : allMailboxes;

    if (opts.dryRun) {
      opts.logger.info(`[DRY-RUN] Would evaluate ${mailboxes.length} mailbox(es): ${mailboxes.join(', ')}`);
      opts.logger.info(`[DRY-RUN] Rules: R01=${opts.r01Enabled} R02=${opts.r02Enabled} R03=${opts.r03Enabled} R04=${opts.r04Enabled}`);
      opts.logger.info('[DRY-RUN] No DB writes or notifications will be performed.');
      return { alertsOpened: 0, alertsClosed: 0 };
    }

    let alertsOpened = 0;
    let alertsClosed = 0;

    // Recover stale SENDING rows (crashed-worker lease recovery) once per cycle
    // before any mailbox work, so recovered rows are eligible for reclaim below.
    if (opts.notifier) {
      try {
        await opts.notifier.recoverPending();
      } catch (err) {
        opts.logger.warn(`[NOTIFY] recoverPending failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const mailbox of mailboxes) {
      // --- R-01 ---
      if (opts.r01Enabled) {
        try {
          const before = await (database as unknown as import('knex').Knex)('google_unanswered_thread_alerts')
            .where({ mailbox_address: mailbox, status: 'OPEN' })
            .count<{ count: string }>({ count: '*' })
            .first();

          await opts.r01Rule.evaluateMailbox(mailbox, opts.r01Config);

          const after = await (database as unknown as import('knex').Knex)('google_unanswered_thread_alerts')
            .where({ mailbox_address: mailbox, status: 'OPEN' })
            .count<{ count: string }>({ count: '*' })
            .first();

          const beforeCount = Number(before?.count ?? 0);
          const afterCount = Number(after?.count ?? 0);
          if (afterCount > beforeCount) alertsOpened += afterCount - beforeCount;
          if (afterCount < beforeCount) alertsClosed += beforeCount - afterCount;
        } catch (err) {
          opts.logger.warn(`[R01] Evaluation failed for mailbox ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- R-02 ---
      if (opts.r02Enabled) {
        try {
          const result = await opts.r02Rule.evaluateMailbox(mailbox, opts.r02Config);
          alertsOpened += result.conditionAFired + result.conditionBFired;
          alertsClosed += result.conditionAClosed + result.conditionBClosed;
        } catch (err) {
          opts.logger.warn(`[R02] Evaluation failed for mailbox ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- R-03 ---
      if (opts.r03Enabled) {
        try {
          const result = await opts.r03Rule.evaluateMailbox(mailbox, opts.r03Config);
          alertsOpened += result.lateRepliesFound;
        } catch (err) {
          opts.logger.warn(`[R03] Evaluation failed for mailbox ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- R-04 ---
      if (opts.r04Enabled) {
        try {
          const result = await opts.r04Rule.evaluateMailbox(mailbox, opts.r04Config);
          alertsOpened += result.alertsOpened;
          alertsClosed += result.alertsClosed;
        } catch (err) {
          opts.logger.warn(`[R04] Evaluation failed for mailbox ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // --- Notifications (disabled by default; only runs when notifier is set) ---
      if (opts.notifier) {
        try {
          await opts.notifier.processMailbox(mailbox);
        } catch (err) {
          opts.logger.warn(`[NOTIFY] Failed for mailbox ${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { alertsOpened, alertsClosed };
  };
};

/**
 * Returns the shortest evaluation interval among all enabled rules.
 * When multiple rules are enabled simultaneously, the worker must cycle at the
 * rate of the most-frequent rule, not just whichever rule was enabled first.
 * Falls back to `fallback` when no rule is enabled (worker will exit anyway).
 */
export const computeEvalIntervalMs = (
  r01Enabled: boolean, r01Interval: number,
  r02Enabled: boolean, r02Interval: number,
  r03Enabled: boolean, r03Interval: number,
  r04Enabled: boolean, r04Interval: number,
  fallback: number,
): number => {
  const active: number[] = [];
  if (r01Enabled) active.push(r01Interval);
  if (r02Enabled) active.push(r02Interval);
  if (r03Enabled) active.push(r03Interval);
  if (r04Enabled) active.push(r04Interval);
  return active.length > 0 ? Math.min(...active) : fallback;
};

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
  const args = parseWorkerArgs(process.argv.slice(2));

  // Controlled execution modes require notifications DISABLED.
  if ((args.singlePass || args.dryRun) && env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE !== 'DISABLED') {
    logger.error('--single-pass and --dry-run require GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=DISABLED. Aborting.');
    process.exitCode = 1;
    return;
  }

  if (args.singlePass) {
    logger.info('Responsiveness worker: single-pass mode — will run one evaluation cycle then exit.');
  }
  if (args.dryRun) {
    logger.info('Responsiveness worker: dry-run mode — no DB writes or notifications.');
  }

  try {
    const sharedCalendar = {
      timezone: env.GOOGLE_R01_TIMEZONE,
      startHour: env.GOOGLE_R01_BUSINESS_START_HOUR,
      endHour: env.GOOGLE_R01_BUSINESS_END_HOUR,
      endMinute: env.GOOGLE_R01_BUSINESS_END_MINUTE,
    };

    const r01Rule = new KnexR01Rule(db);
    const r01Config: R01Config = {
      businessCalendar: sharedCalendar,
      thresholdMinutes: env.GOOGLE_R01_THRESHOLD_MINUTES,
      workspaceDomain: 'trufinity.ca',
      lookbackDays: env.GOOGLE_R01_LOOKBACK_DAYS,
      // Emergency detection: disabled until v2 prompt + DB migration are deployed.
      emergencyClassificationEnabled: env.GOOGLE_R01_EMERGENCY_CLASSIFICATION_ENABLED,
      emergencyThresholdMinutes: env.GOOGLE_R01_EMERGENCY_THRESHOLD_MINUTES,
      emergencyConfidenceThreshold: env.GOOGLE_R01_EMERGENCY_CONFIDENCE_THRESHOLD,
      emergencyTrustedPromptVersions: env.GOOGLE_R01_EMERGENCY_TRUSTED_PROMPT_VERSIONS
        .split(',').map((v) => v.trim()).filter(Boolean),
    };

    // R-02 coverage calendar: Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM (Daniel confirmed).
    const r02CoverageCalendar = {
      timezone: env.GOOGLE_R01_TIMEZONE,
      rules: [
        { weekdays: [1, 2, 3, 4, 5], startHour: 8, endHour: 22 },
        { weekdays: [0, 6],           startHour: 7, endHour: 22 },
      ],
    };

    const r02Rule = new KnexR02Rule(db);
    const r02Config: R02Config = {
      businessCalendar: sharedCalendar,
      coverageCalendar: r02CoverageCalendar,
      inactivityThresholdMinutes: env.GOOGLE_R02_INACTIVITY_THRESHOLD_MINUTES,
      inactivityPolicy: env.GOOGLE_R02_INACTIVITY_POLICY,
      conditionAEnabled: env.GOOGLE_R02_CONDITION_A_ENABLED,
      messageCountThreshold: env.GOOGLE_R02_MESSAGE_COUNT_THRESHOLD,
      workspaceDomain: 'trufinity.ca',
      lookbackDays: env.GOOGLE_R02_LOOKBACK_DAYS,
    };

    const r03Rule = new KnexR03Rule(db);
    const r03Config: R03Config = {
      businessCalendar: sharedCalendar,
      defaultThresholdMinutes: env.GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES,
      mailboxThresholds: {
        'service@trufinity.ca': 240,
        'support@trufinity.ca': 240,
      },
      excludedMailboxes: ['billing@trufinity.ca', 'careers@trufinity.ca', 'info@trufinity.ca'],
      workspaceDomain: 'trufinity.ca',
      lookbackDays: env.GOOGLE_R03_LOOKBACK_DAYS,
    };

    const r04Rule = new KnexR04Rule(db);
    const r04Config: R04Config = {
      businessCalendar: sharedCalendar,
      afterHoursWindows: [
        // Weekday evenings: 4:30 PM – 10:00 PM Pacific
        { weekdays: [1, 2, 3, 4, 5], startHour: 16, startMinute: 30, endHour: 22, endMinute: 0 },
        // Weekend: 7:00 AM – 10:00 PM Pacific
        { weekdays: [0, 6], startHour: 7, startMinute: 0, endHour: 22, endMinute: 0 },
      ],
      graceMinutes: env.GOOGLE_R04_GRACE_MINUTES,
      workspaceDomain: 'trufinity.ca',
      lookbackDays: env.GOOGLE_R04_LOOKBACK_DAYS,
    };

    const loadMailboxes: MailboxLoader = async () => {
      const rows = await db('google_gmail_mailboxes')
        .select('normalized_mailbox_address')
        .where({ enabled: true }) as { normalized_mailbox_address: string }[];
      return rows.map((r) => r.normalized_mailbox_address);
    };

    // Independent allowlist — does not modify DB enabled flags.
    const mailboxAllowlist = env.GOOGLE_RESPONSIVENESS_MAILBOX_ALLOWLIST;

    // Responsiveness notification (DISABLED by default — set
    // GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=TEST to trial one controlled send).
    const notifier = env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE === 'DISABLED'
      ? new NoOpResponsivenessNotifier()
      : createResponsivenessNotifier({
          config: {
            mode: env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE,
            testRecipient: env.WORK_ITEM_NOTIFICATION_RECIPIENT,
            productionRecipients: env.GOOGLE_RESPONSIVENESS_NOTIFICATION_RECIPIENTS,
            productionGate: env.GOOGLE_RESPONSIVENESS_NOTIFICATION_PRODUCTION_GATE,
            maxAttempts: env.GOOGLE_RESPONSIVENESS_NOTIFICATION_MAX_ATTEMPTS,
            leaseMinutes: env.GOOGLE_RESPONSIVENESS_NOTIFICATION_LEASE_MINUTES,
          },
          db: db as unknown as Parameters<typeof createResponsivenessNotifier>[0]['db'],
          smtpConfig: {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            user: env.SMTP_USER,
            password: env.SMTP_PASSWORD,
            from: env.MAIL_FROM,
          },
        });

    const runEvaluation = buildEvaluationCycle(loadMailboxes, {
      r01Enabled: env.GOOGLE_R01_ENABLED,
      r01Rule,
      r01Config,
      r02Enabled: env.GOOGLE_R02_ENABLED,
      r02Rule,
      r02Config,
      r03Enabled: env.GOOGLE_R03_ENABLED,
      r03Rule,
      r03Config,
      r04Enabled: env.GOOGLE_R04_ENABLED,
      r04Rule,
      r04Config,
      notifier,
      logger,
      dryRun: args.dryRun,
    }, db as unknown as Parameters<typeof buildEvaluationCycle>[2], mailboxAllowlist);

    // Worker starts if at least one rule is enabled.
    const workerEnabled = env.GOOGLE_R01_ENABLED || env.GOOGLE_R02_ENABLED || env.GOOGLE_R03_ENABLED || env.GOOGLE_R04_ENABLED;
    // Use the minimum interval across all enabled rules so the most-frequent rule
    // is never starved when multiple rules are enabled simultaneously.
    const evalIntervalMs = computeEvalIntervalMs(
      env.GOOGLE_R01_ENABLED, env.GOOGLE_R01_EVAL_INTERVAL_MS,
      env.GOOGLE_R02_ENABLED, env.GOOGLE_R02_EVAL_INTERVAL_MS,
      env.GOOGLE_R03_ENABLED, env.GOOGLE_R03_EVAL_INTERVAL_MS,
      env.GOOGLE_R04_ENABLED, env.GOOGLE_R04_EVAL_INTERVAL_MS,
      env.GOOGLE_R01_EVAL_INTERVAL_MS,
    );

    // Single-pass mode: acquire an advisory lock, run exactly one cycle, exit.
    if (args.singlePass) {
      if (!workerEnabled && !args.dryRun) {
        logger.info('Google Workspace responsiveness worker: no rules enabled; nothing to evaluate.');
        await db.destroy().catch(() => undefined);
        return;
      }

      // PostgreSQL advisory lock prevents concurrent single-pass runs.
      // pg_try_advisory_lock returns false immediately when another session holds it.
      const lockResult = await db.raw<{ rows: [{ acquired: boolean }] }>(
        `SELECT pg_try_advisory_lock(hashtext('trufinity-responsiveness-worker')) AS acquired`,
      );
      const lockAcquired = lockResult.rows[0]?.acquired ?? false;
      if (!lockAcquired) {
        logger.error('Another responsiveness worker instance is already running (advisory lock held). Aborting single-pass.');
        await db.destroy().catch(() => undefined);
        process.exitCode = 1;
        return;
      }
      logger.info('Responsiveness worker: advisory lock acquired.');

      try {
        logger.info(`Responsiveness worker: running single-pass cycle (allowlist: ${mailboxAllowlist.join(', ')}).`);
        const result = await runEvaluation();
        logger.info(`Responsiveness worker: single-pass complete — alertsOpened=${result.alertsOpened} alertsClosed=${result.alertsClosed}`);
      } finally {
        await db.raw(`SELECT pg_advisory_unlock(hashtext('trufinity-responsiveness-worker'))`).catch(() => undefined);
        await db.destroy().catch(() => undefined);
      }
      return;
    }

    await startGoogleResponsivenessWorker({
      database: db,
      config: { enabled: workerEnabled, evalIntervalMs },
      runEvaluation,
      logger,
      createScheduler: (runEval, intervalMs) =>
        new GoogleResponsivenessScheduler({ runEvaluation: runEval, intervalMs, logger }),
      registerShutdown: registerProcessShutdown,
    });
  } catch {
    logger.error('Google Workspace responsiveness worker startup failed; verify configuration and database connectivity.');
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  }
};

if (require.main === module) void main();
