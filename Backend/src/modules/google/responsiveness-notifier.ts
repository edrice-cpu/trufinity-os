/**
 * Responsiveness Email Notification — Phase 3
 *
 * Sends email alerts for open responsiveness rule findings (R-01, R-02, R-04).
 * Three isolated modes:
 *   DISABLED     — default; no emails ever sent.
 *   TEST         — sends only to WORK_ITEM_NOTIFICATION_RECIPIENT (must not overlap production).
 *   PRODUCTION   — sends to the configured recipient list; requires explicit gate.
 *
 * Cross-rule precedence per (mailbox, thread) — proposed, pending Daniel approval:
 *   1. R01_EMERGENCY          (priority 1 — highest)
 *   2. R01_GENERAL            (priority 2)
 *   3. R04_AFTER_HOURS        (priority 3)
 *   4. R02_INACTIVITY         (priority 4)
 *   5. R02_EXCESSIVE_EXCHANGES (priority 5 — lowest)
 *
 * When a higher-priority alert is open and already notified, lower-priority
 * alerts for the same thread are suppressed until the higher-priority resolves.
 *
 * KNOWN LIMITATION: R-02/R-04 alerts that resolve and reopen keep the same
 * UUID, so a SENT notification for that UUID won't re-fire after reopening.
 * Fix requires a generation counter on the alert row (future migration).
 *
 * SAFETY: No emails are ever sent to edrice@trufinity.ca or casey@trufinity.ca
 * in TEST mode — the recipient overlap check hard-rejects such configurations.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AlertType =
  | 'R01_EMERGENCY'
  | 'R01_GENERAL'
  | 'R04_AFTER_HOURS'
  | 'R02_INACTIVITY'
  | 'R02_EXCESSIVE_EXCHANGES';

export type NotificationMode = 'DISABLED' | 'TEST' | 'PRODUCTION';

/** Proposed priority order, not yet approved by Daniel. Lower number = higher priority. */
export const ALERT_TYPE_PRIORITY: Record<AlertType, number> = {
  R01_EMERGENCY:           1,
  R01_GENERAL:             2,
  R04_AFTER_HOURS:         3,
  R02_INACTIVITY:          4,
  R02_EXCESSIVE_EXCHANGES: 5,
};

export interface OpenAlert {
  alertId: string;           // UUID from the alert table
  alertTable: string;        // 'google_unanswered_thread_alerts' | ...
  alertType: AlertType;
  mailboxAddress: string;
  threadId: string;
  elapsedMinutes: number;
  thresholdMinutes: number;
  detectedAt: Date;
  /**
   * Lifecycle generation counter. For R-01: always 1 (new UUID per lifecycle).
   * For R-02/R-04: incremented on each RESOLVED→OPEN transition (migration 025).
   * Included in the idempotency key so re-opened alerts get a fresh notification.
   */
  notificationGeneration: number;
}

export interface NotificationRow {
  id: string;
  idempotency_key: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attempt_count: number;
  max_attempts: number;
  last_attempted_at: string | null;
  next_attempt_at: string | null;
  lease_token: string | null;
}

export interface NotificationClaim {
  leaseToken: string;
}

// ---------------------------------------------------------------------------
// Recipient resolution
// ---------------------------------------------------------------------------

/**
 * Production recipients that must never appear in TEST mode.
 * This set is intentionally hard-coded and NOT env-configurable so that a
 * misconfigured env file cannot accidentally route test emails to real customers.
 */
export const KNOWN_PRODUCTION_RECIPIENTS = new Set([
  'edrice@trufinity.ca',
  'casey@trufinity.ca',
]);

export interface NotificationConfig {
  mode: NotificationMode;
  testRecipient: string | undefined;
  productionRecipients: string;
  productionGate: string;
  maxAttempts: number;
  leaseMinutes: number;
}

export interface ResolvedRecipients {
  mode: NotificationMode;
  recipients: ReadonlyArray<string>;
}

function parseEmailList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validates config and resolves the final recipient list for the given mode.
 * Throws a descriptive error on any misconfiguration — fails closed.
 */
export function resolveRecipients(config: NotificationConfig): ResolvedRecipients {
  const { mode } = config;

  if (mode === 'DISABLED') {
    return { mode, recipients: [] };
  }

  if (mode === 'TEST') {
    if (!config.testRecipient) {
      throw new Error(
        'GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=TEST requires WORK_ITEM_NOTIFICATION_RECIPIENT to be set.',
      );
    }
    const testAddr = config.testRecipient.toLowerCase();
    if (KNOWN_PRODUCTION_RECIPIENTS.has(testAddr)) {
      throw new Error(
        `TEST mode recipient "${config.testRecipient}" is a known production address. ` +
        'Use a safe test mailbox to prevent sending to real stakeholders.',
      );
    }
    // Also check against configured production recipients
    const prodList = parseEmailList(config.productionRecipients);
    if (prodList.includes(testAddr)) {
      throw new Error(
        `TEST mode recipient "${config.testRecipient}" overlaps with GOOGLE_RESPONSIVENESS_NOTIFICATION_RECIPIENTS. ` +
        'Use a distinct test mailbox.',
      );
    }
    return { mode, recipients: [config.testRecipient] };
  }

  // PRODUCTION
  if (config.productionGate !== 'I_CONFIRM_PRODUCTION_NOTIFICATIONS') {
    throw new Error(
      'GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=PRODUCTION requires ' +
      'GOOGLE_RESPONSIVENESS_NOTIFICATION_PRODUCTION_GATE=I_CONFIRM_PRODUCTION_NOTIFICATIONS.',
    );
  }
  const recipients = parseEmailList(config.productionRecipients);
  if (recipients.length === 0) {
    throw new Error(
      'GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=PRODUCTION requires at least one address ' +
      'in GOOGLE_RESPONSIVENESS_NOTIFICATION_RECIPIENTS.',
    );
  }
  return { mode, recipients };
}

// ---------------------------------------------------------------------------
// Priority selection
// ---------------------------------------------------------------------------

/** For (mailbox, thread): selects the single highest-priority open alert. */
export function pickHighestPriorityAlert(alerts: OpenAlert[]): OpenAlert | null {
  if (alerts.length === 0) return null;
  return alerts.reduce((best, alert) =>
    ALERT_TYPE_PRIORITY[alert.alertType] < ALERT_TYPE_PRIORITY[best.alertType] ? alert : best,
  );
}

export function buildIdempotencyKey(alert: OpenAlert, recipient: string): string {
  return `responsiveness:${alert.alertType.toLowerCase()}:${alert.alertId}:${alert.notificationGeneration}:${recipient}`;
}

// ---------------------------------------------------------------------------
// Notification store (DB operations)
// ---------------------------------------------------------------------------

export interface ResponsivenessNotificationStore {
  /** Returns a fencing token when the notification was claimed. */
  claim(alert: OpenAlert, recipient: string, maxAttempts: number): Promise<NotificationClaim | null>;
  markSent(idempotencyKey: string, leaseToken: string): Promise<void>;
  markFailed(idempotencyKey: string, errorCategory: string, leaseToken: string): Promise<void>;
  isSent(alert: OpenAlert, recipient: string): Promise<boolean>;
  /** Returns SENDING rows whose lease has expired (crashed worker recovery). */
  listRetryable(leaseMinutes: number, maxAttempts: number): Promise<NotificationRow[]>;
}

export class KnexResponsivenessNotificationStore implements ResponsivenessNotificationStore {
  constructor(private readonly db: (table: string) => Knex.QueryBuilder) {}

  async claim(alert: OpenAlert, recipient: string, maxAttempts: number): Promise<NotificationClaim | null> {
    const key = buildIdempotencyKey(alert, recipient);
    const leaseToken = randomUUID();
    const now = new Date();

    // Upsert: insert PENDING row if none exists (conflict = already exists, skip).
    await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .insert({
        alert_table:       alert.alertTable,
        alert_id:          alert.alertId,
        alert_type:        alert.alertType,
        mailbox_address:   alert.mailboxAddress,
        thread_id:         alert.threadId,
        recipient,
        status:            'PENDING',
        attempt_count:     0,
        max_attempts:      maxAttempts,
        idempotency_key:   key,
        lease_token:       null,
        created_at:        now,
        updated_at:        now,
      })
      .onConflict('idempotency_key')
      .ignore();

    // Atomically claim the row if it is:
    //   - PENDING (first attempt or recovered from stuck SENDING), or
    //   - FAILED with attempt_count < max_attempts AND backoff window has elapsed.
    // Clears next_attempt_at on successful claim so SENT/isSent checks stay clean.
    const updated = await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .where({ idempotency_key: key })
      .whereRaw(
        `(status = 'PENDING' OR (status = 'FAILED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)))`,
        [now],
      )
      .whereRaw('attempt_count < max_attempts')
      .update({
        status:            'SENDING',
        attempt_count:     (this.db as unknown as Knex).raw('attempt_count + 1'),
        last_attempted_at: now,
        next_attempt_at:   null,
        lease_token:       leaseToken,
        updated_at:        now,
      });

    return updated > 0 ? { leaseToken } : null;
  }

  async markSent(idempotencyKey: string, leaseToken: string): Promise<void> {
    const now = new Date();
    await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .where({ idempotency_key: idempotencyKey, status: 'SENDING', lease_token: leaseToken })
      .update({ status: 'SENT', sent_at: now, lease_token: null, updated_at: now });
  }

  async markFailed(idempotencyKey: string, errorCategory: string, leaseToken: string): Promise<void> {
    const now = new Date();
    // Read attempt_count to compute the exponential backoff window.
    const row = await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .select('attempt_count')
      .where({ idempotency_key: idempotencyKey })
      .first() as { attempt_count: number } | undefined;
    const attemptCount = row?.attempt_count ?? 1;
    // Backoff: 2^(attempt_count-1) minutes, capped at 60.
    const backoffMinutes = Math.min(Math.pow(2, attemptCount - 1), 60);
    const nextAttemptAt = new Date(now.getTime() + backoffMinutes * 60_000);
    await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .where({ idempotency_key: idempotencyKey, status: 'SENDING', lease_token: leaseToken })
      .update({ status: 'FAILED', last_error_category: errorCategory, next_attempt_at: nextAttemptAt, updated_at: now });
  }

  async isSent(alert: OpenAlert, recipient: string): Promise<boolean> {
    const key = buildIdempotencyKey(alert, recipient);
    const row = await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .select('status')
      .where({ idempotency_key: key })
      .first() as { status: string } | undefined;
    return row?.status === 'SENT';
  }

  async listRetryable(leaseMinutes: number, _maxAttempts: number): Promise<NotificationRow[]> {
    const cutoff = new Date(Date.now() - leaseMinutes * 60_000);
    return (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
      .select('id', 'idempotency_key', 'status', 'attempt_count', 'max_attempts', 'last_attempted_at', 'lease_token')
      .where('status', 'SENDING')
      .where('last_attempted_at', '<', cutoff)
      .whereRaw('attempt_count < max_attempts') as unknown as Promise<NotificationRow[]>;
  }
}

// ---------------------------------------------------------------------------
// Open-alert loader
// ---------------------------------------------------------------------------

interface R01AlertRow {
  id: string;
  thread_id: string;
  threshold_minutes: number;
  business_minutes_elapsed: number;
  threshold_exceeded_at: string;
  is_emergency: boolean;
}

interface R02AlertRow {
  id: string;
  thread_id: string;
  stall_reason: string;
  inactivity_minutes: number;
  inactivity_threshold_minutes: number;
  created_at: string;
  notification_generation: number;
}

interface R04AlertRow {
  id: string;
  thread_id: string;
  inbound_at: string;
  deadline_at: string;
  created_at: string;
  notification_generation: number;
}

/** Loads all OPEN alerts for a mailbox across the three alert tables. */
export async function loadOpenAlerts(
  db: (table: string) => Knex.QueryBuilder,
  mailboxAddress: string,
): Promise<OpenAlert[]> {
  const alerts: OpenAlert[] = [];

  // R-01 alerts (is_emergency column added by migration 025)
  const r01Rows = await (db('google_unanswered_thread_alerts') as unknown as Knex.QueryBuilder)
    .select('id', 'thread_id', 'threshold_minutes', 'business_minutes_elapsed', 'threshold_exceeded_at', 'is_emergency')
    .where({ mailbox_address: mailboxAddress, status: 'OPEN' }) as R01AlertRow[];

  for (const row of r01Rows) {
    // Use the persisted is_emergency flag (set by R-01 upsertAlert via isEmergencyClassified).
    const alertType: AlertType = row.is_emergency ? 'R01_EMERGENCY' : 'R01_GENERAL';
    alerts.push({
      alertId:                row.id,
      alertTable:             'google_unanswered_thread_alerts',
      alertType,
      mailboxAddress,
      threadId:               row.thread_id,
      elapsedMinutes:         row.business_minutes_elapsed,
      thresholdMinutes:       row.threshold_minutes,
      detectedAt:             new Date(row.threshold_exceeded_at),
      notificationGeneration: 1,  // R-01 always gets a new UUID per lifecycle
    });
  }

  // R-02 alerts (notification_generation column added by migration 025)
  const r02Rows = await (db('google_stalled_thread_alerts') as unknown as Knex.QueryBuilder)
    .select('id', 'thread_id', 'stall_reason', 'inactivity_minutes', 'inactivity_threshold_minutes', 'created_at', 'notification_generation')
    .where({ mailbox_address: mailboxAddress, status: 'OPEN' }) as R02AlertRow[];

  for (const row of r02Rows) {
    const alertType: AlertType =
      row.stall_reason === 'INACTIVITY' ? 'R02_INACTIVITY' : 'R02_EXCESSIVE_EXCHANGES';
    alerts.push({
      alertId:                row.id,
      alertTable:             'google_stalled_thread_alerts',
      alertType,
      mailboxAddress,
      threadId:               row.thread_id,
      elapsedMinutes:         row.inactivity_minutes,
      thresholdMinutes:       row.inactivity_threshold_minutes,
      detectedAt:             new Date(row.created_at),
      notificationGeneration: row.notification_generation,
    });
  }

  // R-04 alerts (real columns: inbound_at, deadline_at; notification_generation from migration 025)
  const r04Rows = await (db('google_after_hours_backlog_alerts') as unknown as Knex.QueryBuilder)
    .select('id', 'thread_id', 'inbound_at', 'deadline_at', 'created_at', 'notification_generation')
    .where({ mailbox_address: mailboxAddress, status: 'OPEN' }) as R04AlertRow[];

  for (const row of r04Rows) {
    const inboundAtMs = new Date(row.inbound_at).getTime();
    const deadlineAtMs = new Date(row.deadline_at).getTime();
    const thresholdMinutes = Math.max(1, Math.floor((deadlineAtMs - inboundAtMs) / 60_000));
    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - inboundAtMs) / 60_000));
    alerts.push({
      alertId:                row.id,
      alertTable:             'google_after_hours_backlog_alerts',
      alertType:              'R04_AFTER_HOURS',
      mailboxAddress,
      threadId:               row.thread_id,
      elapsedMinutes,
      thresholdMinutes,
      detectedAt:             new Date(row.created_at),
      notificationGeneration: row.notification_generation,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Email content builder
// ---------------------------------------------------------------------------

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  R01_EMERGENCY:           'R-01 Emergency — Unanswered Inbound (25-min threshold)',
  R01_GENERAL:             'R-01 General — Unanswered Inbound (business-hours threshold)',
  R04_AFTER_HOURS:         'R-04 — After-Hours Backlog',
  R02_INACTIVITY:          'R-02 — Stalled Thread (24-coverage-hour inactivity)',
  R02_EXCESSIVE_EXCHANGES: 'R-02 — Stalled Thread (excessive message exchanges)',
};

const ALERT_TYPE_ACTION: Record<AlertType, string> = {
  R01_EMERGENCY:           'Reply to this email thread immediately — a safety/property hazard may be in progress.',
  R01_GENERAL:             'Reply to this email thread during business hours.',
  R04_AFTER_HOURS:         'Reply to this email thread before the end of the morning grace window.',
  R02_INACTIVITY:          'Review this thread and reply or escalate if needed.',
  R02_EXCESSIVE_EXCHANGES: 'Review this thread — the high message count may indicate an unresolved escalation.',
};

function buildGmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hour${h === 1 ? '' : 's'}` : `${h}h ${m}m`;
}

export interface NotificationEmailContent {
  subject: string;
  text: string;
}

export function buildNotificationEmail(alert: OpenAlert): NotificationEmailContent {
  const label = ALERT_TYPE_LABELS[alert.alertType];
  const action = ALERT_TYPE_ACTION[alert.alertType];
  const threadUrl = buildGmailThreadUrl(alert.threadId);
  const detectedStr = alert.detectedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const elapsedStr = formatMinutes(alert.elapsedMinutes);
  const thresholdStr = formatMinutes(alert.thresholdMinutes);

  const subject = `[TruFinity Alert] ${label} — ${alert.mailboxAddress}`;

  const text = [
    `Alert Type:  ${label}`,
    `Mailbox:     ${alert.mailboxAddress}`,
    `Thread URL:  ${threadUrl}`,
    `Detected:    ${detectedStr}`,
    `Waiting:     ${elapsedStr}`,
    `Threshold:   ${thresholdStr}`,
    ``,
    `Action: ${action}`,
    ``,
    `This notification was generated by TruFinity OS responsiveness monitoring.`,
    `Do not reply to this automated message.`,
  ].join('\n');

  return { subject, text };
}

// ---------------------------------------------------------------------------
// Notifier interface
// ---------------------------------------------------------------------------

export interface ResponsivenessNotifier {
  /**
   * Loads all OPEN alerts for the mailbox, groups by thread, selects the
   * highest-priority alert per thread, and sends notifications for any that
   * have not yet been delivered in this alert lifecycle.
   */
  processMailbox(mailboxAddress: string): Promise<{ notificationsSent: number }>;

  /**
   * Reclaims SENDING rows whose lease expired (crashed worker recovery) and
   * reattempts delivery. Returns the number of rows reclaimed.
   */
  recoverPending(): Promise<number>;
}

// ---------------------------------------------------------------------------
// NoOp implementation (DISABLED mode)
// ---------------------------------------------------------------------------

export class NoOpResponsivenessNotifier implements ResponsivenessNotifier {
  async processMailbox(_mailboxAddress: string): Promise<{ notificationsSent: number }> {
    return { notificationsSent: 0 };
  }
  async recoverPending(): Promise<number> { return 0; }
}

// ---------------------------------------------------------------------------
// SMTP implementation (TEST / PRODUCTION modes)
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

export class SmtpResponsivenessNotifier implements ResponsivenessNotifier {
  constructor(
    private readonly store: ResponsivenessNotificationStore,
    private readonly db: (table: string) => Knex.QueryBuilder,
    private readonly recipients: ReadonlyArray<string>,
    private readonly maxAttempts: number,
    private readonly leaseMinutes: number,
    private readonly smtpFrom: string,
    private readonly transport: Transporter,
  ) {}

  async processMailbox(mailboxAddress: string): Promise<{ notificationsSent: number }> {
    const allAlerts = await loadOpenAlerts(this.db, mailboxAddress);

    // Group by thread
    const byThread = new Map<string, OpenAlert[]>();
    for (const alert of allAlerts) {
      const existing = byThread.get(alert.threadId) ?? [];
      existing.push(alert);
      byThread.set(alert.threadId, existing);
    }

    let notificationsSent = 0;

    for (const [, threadAlerts] of byThread) {
      const selected = pickHighestPriorityAlert(threadAlerts);
      if (!selected) continue;

      for (const recipient of this.recipients) {
        // If a higher-priority alert for this thread is already notified, the
        // selected alert IS that alert — so check whether it was sent.
        const alreadySent = await this.store.isSent(selected, recipient);
        if (alreadySent) continue;

        const claim = await this.store.claim(selected, recipient, this.maxAttempts);
        if (!claim) continue;

        const key = buildIdempotencyKey(selected, recipient);
        const { subject, text } = buildNotificationEmail(selected);

        try {
          await this.transport.sendMail({ from: this.smtpFrom, to: recipient, subject, text });
          await this.store.markSent(key, claim.leaseToken);
          notificationsSent++;
        } catch (err) {
          const errorCategory = classifySmtpError(err);
          await this.store.markFailed(key, errorCategory, claim.leaseToken);
        }
      }
    }

    return { notificationsSent };
  }

  async recoverPending(): Promise<number> {
    const stale = await this.store.listRetryable(this.leaseMinutes, this.maxAttempts);
    let recovered = 0;

    for (const row of stale) {
      // Reset to PENDING so the next processMailbox() cycle can reclaim it.
      const updated = await (this.db('google_responsiveness_notifications') as unknown as Knex.QueryBuilder)
        .where({ idempotency_key: row.idempotency_key, status: 'SENDING', lease_token: row.lease_token })
        .update({ status: 'PENDING', lease_token: null, updated_at: new Date() });
      if (updated > 0) recovered++;
    }

    return recovered;
  }
}

function classifySmtpError(err: unknown): string {
  if (!(err instanceof Error)) return 'UNKNOWN';
  const msg = err.message.toLowerCase();
  if (msg.includes('connect') || msg.includes('econnrefused') || msg.includes('timeout')) return 'SMTP_CONNECT';
  if (msg.includes('auth') || msg.includes('credential') || msg.includes('535')) return 'SMTP_AUTH';
  if (msg.includes('send') || msg.includes('5xx') || msg.includes('550')) return 'SMTP_SEND';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ResponsivenessNotifierFactoryOptions {
  config: NotificationConfig;
  db: (table: string) => Knex.QueryBuilder;
  smtpConfig: SmtpConfig;
  /** Injected SMTP transport (for testing). When omitted, creates a real one. */
  transport?: Transporter;
}

/**
 * Creates and validates a ResponsivenessNotifier for the given mode.
 * Throws on misconfiguration — fails closed.
 */
export function createResponsivenessNotifier(
  opts: ResponsivenessNotifierFactoryOptions,
): ResponsivenessNotifier {
  const resolved = resolveRecipients(opts.config);

  if (resolved.mode === 'DISABLED') {
    return new NoOpResponsivenessNotifier();
  }

  const transport: Transporter = opts.transport ?? nodemailer.createTransport({
    host: opts.smtpConfig.host,
    port: opts.smtpConfig.port,
    secure: opts.smtpConfig.secure,
    auth: { user: opts.smtpConfig.user, pass: opts.smtpConfig.password },
  });

  const store = new KnexResponsivenessNotificationStore(opts.db);

  return new SmtpResponsivenessNotifier(
    store,
    opts.db,
    resolved.recipients,
    opts.config.maxAttempts,
    opts.config.leaseMinutes,
    opts.smtpConfig.from,
    transport,
  );
}
