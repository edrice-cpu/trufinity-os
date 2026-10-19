/**
 * R-01: Unanswered Inbound Email Detection
 *
 * Deterministic rule (no ML classification) that detects inbound customer
 * emails that remain unanswered beyond the configured business-hours threshold.
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 *
 * Architecture:
 * - Reads raw_gmail_messages (is_latest=true, is_deleted=false)
 * - Groups messages by thread_id
 * - Classifies each message as INBOUND / OUTBOUND / INTERNAL using labelIds + From header
 * - Determines the "pending segment": inbound messages since the most recent outbound
 * - If elapsed business minutes >= threshold → upserts google_unanswered_thread_alerts
 * - If thread has been replied to → closes any OPEN alert for that thread
 *
 * Idempotency: unique key (mailbox_address, thread_id, oldest_unanswered_message_id)
 * ensures repeated evaluation never duplicates alerts.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import { businessMinutesElapsed, nextBusinessMoment } from './business-calendar';
import type { BusinessCalendarConfig } from './business-calendar';

export { type BusinessCalendarConfig } from './business-calendar';

export interface R01Config {
  /** Business-hours calendar to use for elapsed-time calculations. */
  readonly businessCalendar: BusinessCalendarConfig;
  /**
   * Elapsed business minutes before creating an alert for non-emergency messages.
   * Daniel confirmed: 4 business hours = 240 minutes.
   */
  readonly thresholdMinutes: number;
  /**
   * Company workspace domain used to distinguish internal from external senders.
   * Inbound = From-header domain does NOT end with this value.
   * E.g. 'trufinity.ca'
   */
  readonly workspaceDomain: string;
  /**
   * How many days back to scan for thread activity.
   * Threads with no messages in this window are skipped unless they have an
   * OPEN alert (those are always re-evaluated).
   */
  readonly lookbackDays: number;

  // -------------------------------------------------------------------------
  // Emergency classification — Daniel confirmed: 25-minute threshold for
  // messages automatically detected as ongoing or imminent safety/property
  // hazards. Reuses persisted email_classification_results; never calls
  // Anthropic directly from the responsiveness worker.
  // -------------------------------------------------------------------------

  /**
   * Kill-switch: when false, emergency threshold logic is skipped entirely and
   * all messages use thresholdMinutes. Disabled by default until the v2 prompt
   * and DB migration are deployed together.
   */
  readonly emergencyClassificationEnabled: boolean;
  /**
   * Business minutes before alerting on a confirmed emergency message.
   * Daniel confirmed: 25 minutes.
   */
  readonly emergencyThresholdMinutes: number;
  /**
   * Minimum confidence (0–1) required to treat a classification as a confirmed
   * emergency. Classifications below this are treated as non-emergency.
   */
  readonly emergencyConfidenceThreshold: number;
  /**
   * Classifier prompt versions that include the 'emergency' label.
   * Only classifications produced by these versions are trusted for emergency
   * detection. This prevents pre-emergency prompt results (v1 and earlier)
   * from incorrectly confirming that a message is NOT an emergency.
   *
   * BACKFILL NOTE: Messages classified before the emergency label was introduced
   * (prompt_version not in this list) may be genuine emergencies that were
   * never evaluated as such. A controlled reclassification run (re-classify
   * messages with the new prompt version) is required before this feature can
   * be considered fully retroactive.
   */
  readonly emergencyTrustedPromptVersions: ReadonlyArray<string>;
}

export interface UnansweredThreadAlertRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  oldestUnansweredMessageId: string;
  oldestUnansweredAt: Date;
  thresholdExceededAt: Date;
  businessMinutesElapsed: number;
  thresholdMinutes: number;
  isEmergency: boolean;
  status: 'OPEN' | 'REPLIED';
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  gmailThreadUrl: string | null;
}

export type UnansweredAlertStatus = UnansweredThreadAlertRow['status'];
export type UnansweredAlertClassification = 'EMERGENCY' | 'GENERAL';

export interface UnansweredAlertListFilters {
  mailboxAddress?: string;
  status?: UnansweredAlertStatus;
  classification?: UnansweredAlertClassification;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  pageSize: number;
}

export interface UnansweredAlertListResult {
  page: number;
  pageSize: number;
  totalCount: number;
  data: UnansweredThreadAlertRow[];
}

export interface UnansweredAlertSummary {
  totalCount: number;
  byStatus: Record<UnansweredAlertStatus, number>;
  byClassification: Record<Lowercase<UnansweredAlertClassification>, number>;
}

const buildUnansweredAlertQuery = (database: Knex, filters: Omit<UnansweredAlertListFilters, 'page' | 'pageSize'>) => {
  let query = database('google_unanswered_thread_alerts').where((_builder) => true);
  if (filters.mailboxAddress) query = query.where('mailbox_address', filters.mailboxAddress);
  if (filters.status) query = query.where('status', filters.status);
  if (filters.classification) query = query.where('is_emergency', filters.classification === 'EMERGENCY');
  if (filters.fromDate) query = query.where('threshold_exceeded_at', '>=', filters.fromDate);
  if (filters.toDate) query = query.where('threshold_exceeded_at', '<=', filters.toDate);
  return query;
};

const toUnansweredAlertRow = (raw: Record<string, unknown>): UnansweredThreadAlertRow => {
  const mailboxAddress = String(raw.mailbox_address ?? '');
  const threadId = String(raw.thread_id ?? '');
  return {
    id: String(raw.id),
    mailboxAddress,
    threadId,
    oldestUnansweredMessageId: String(raw.oldest_unanswered_message_id),
    oldestUnansweredAt: new Date(raw.oldest_unanswered_at as string),
    thresholdExceededAt: new Date(raw.threshold_exceeded_at as string),
    businessMinutesElapsed: Number(raw.business_minutes_elapsed),
    thresholdMinutes: Number(raw.threshold_minutes),
    isEmergency: Boolean(raw.is_emergency),
    status: raw.status as UnansweredAlertStatus,
    repliedAt: raw.replied_at == null ? null : new Date(raw.replied_at as string),
    createdAt: new Date(raw.created_at as string),
    updatedAt: new Date(raw.updated_at as string),
    gmailThreadUrl: mailboxAddress && threadId
      ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(mailboxAddress)}#all/${threadId}`
      : null,
  };
};

export const listUnansweredAlerts = async (
  database: Knex,
  filters: UnansweredAlertListFilters,
): Promise<UnansweredAlertListResult> => {
  const { page, pageSize, ...queryFilters } = filters;
  const countRow = await buildUnansweredAlertQuery(database, queryFilters)
    .count<{ count: string }>({ count: '*' }).first();
  const rows = await buildUnansweredAlertQuery(database, queryFilters)
    .select(
      'id', 'mailbox_address', 'thread_id', 'oldest_unanswered_message_id',
      'oldest_unanswered_at', 'threshold_exceeded_at', 'business_minutes_elapsed',
      'threshold_minutes', 'is_emergency', 'status', 'replied_at', 'created_at', 'updated_at',
    )
    .orderBy('threshold_exceeded_at', 'desc')
    .limit(pageSize)
    .offset((page - 1) * pageSize) as Record<string, unknown>[];
  return { page, pageSize, totalCount: Number(countRow?.count ?? 0), data: rows.map(toUnansweredAlertRow) };
};

export const unansweredAlertSummary = async (
  database: Knex,
  filters: Omit<UnansweredAlertListFilters, 'page' | 'pageSize'>,
): Promise<UnansweredAlertSummary> => {
  const rows = await buildUnansweredAlertQuery(database, filters)
    .select('status', 'is_emergency')
    .count<{ count: string }>({ count: '*' })
    .groupBy('status', 'is_emergency') as Array<{ status: UnansweredAlertStatus; is_emergency: boolean; count: string }>;
  const summary: UnansweredAlertSummary = {
    totalCount: 0,
    byStatus: { OPEN: 0, REPLIED: 0 },
    byClassification: { emergency: 0, general: 0 },
  };
  for (const row of rows) {
    const count = Number(row.count);
    summary.totalCount += count;
    summary.byStatus[row.status] += count;
    summary.byClassification[row.is_emergency ? 'emergency' : 'general'] += count;
  }
  return summary;
};

interface RawGmailRow {
  provider_message_id: string;
  thread_id: string;
  internal_date: Date | null;
  mailbox_address: string;
  payload: Record<string, unknown> | null;
}

type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';

interface ThreadMessage {
  providerId: string;
  internalDate: Date;
  direction: MessageDirection;
}

/** Extract a named header value from a persisted Gmail payload. */
const extractHeader = (payload: Record<string, unknown> | null, name: string): string | null => {
  if (!payload || !Array.isArray(payload.headers)) return null;
  const nameLower = name.toLowerCase();
  for (const h of payload.headers as unknown[]) {
    if (typeof h !== 'object' || h === null) continue;
    const entry = h as Record<string, unknown>;
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === nameLower && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return null;
};

/** Extract the domain part of an email address (From header value). */
const emailDomain = (raw: string | null): string | null => {
  if (!raw) return null;
  const match = /<([^>]+)>/.exec(raw) ?? null;
  const addr = match ? match[1].trim() : raw.trim();
  const at = addr.indexOf('@');
  return at !== -1 ? addr.slice(at + 1).toLowerCase() : null;
};

/** True when the label array (from payload.labelIds) contains the given label. */
const hasLabel = (payload: Record<string, unknown> | null, label: string): boolean => {
  if (!payload || !Array.isArray(payload.labelIds)) return false;
  return (payload.labelIds as unknown[]).some(
    (l) => typeof l === 'string' && l.toUpperCase() === label.toUpperCase(),
  );
};

/**
 * Classify one message as INBOUND, OUTBOUND, or UNKNOWN.
 *
 * INBOUND:  Has INBOX label AND From-header domain is external (not workspaceDomain).
 * OUTBOUND: Has SENT label.
 * UNKNOWN:  Neither — e.g. internal messages, drafts, system messages. Ignored by R-01.
 *
 * A message can have both INBOX and SENT (e.g. a self-sent note).
 * SENT takes precedence → OUTBOUND, so self-sent messages don't create false pending states.
 */
export const classifyDirection = (
  payload: Record<string, unknown> | null,
  workspaceDomain: string,
): MessageDirection => {
  if (!payload) return 'UNKNOWN';
  if (hasLabel(payload, 'SENT')) return 'OUTBOUND';
  if (!hasLabel(payload, 'INBOX')) return 'UNKNOWN';
  const from = extractHeader(payload, 'From');
  const domain = emailDomain(from);
  if (!domain) return 'UNKNOWN';
  // Internal sender → UNKNOWN (not a customer email).
  // Must be an exact match or a real subdomain (*.workspaceDomain) to prevent
  // spoofing: 'nottrufinity.ca'.endsWith('trufinity.ca') is true but is external.
  const normalised = workspaceDomain.replace(/^\./, '').toLowerCase();
  if (domain === normalised || domain.endsWith('.' + normalised)) return 'UNKNOWN';
  return 'INBOUND';
};

/**
 * Given a chronologically-sorted list of thread messages (INBOUND/OUTBOUND only),
 * return the oldest unanswered inbound message, or null if the thread is fully replied.
 *
 * "Pending segment" = all INBOUND messages that appear AFTER the most recent OUTBOUND.
 * If there is no OUTBOUND at all, all INBOUNDs are pending.
 * If the most recent message is OUTBOUND, the thread is replied → no pending.
 */
export const findOldestUnanswered = (
  messages: ThreadMessage[],
): ThreadMessage | null => {
  // Walk backwards to find the most recent OUTBOUND
  let lastOutboundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.direction === 'OUTBOUND') {
      lastOutboundIdx = i;
      break;
    }
  }

  // All messages after the last OUTBOUND that are INBOUND = pending
  const pendingStart = lastOutboundIdx + 1;
  for (let i = pendingStart; i < messages.length; i++) {
    if (messages[i]!.direction === 'INBOUND') {
      return messages[i]!;
    }
  }
  return null;
};

export interface R01Rule {
  evaluateMailbox(mailboxAddress: string, config: R01Config, now?: Date): Promise<void>;
}

export class KnexR01Rule implements R01Rule {
  public constructor(private readonly database: Knex = db) {}

  public async evaluateMailbox(
    mailboxAddress: string,
    config: R01Config,
    now: Date = new Date(),
  ): Promise<void> {
    const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);

    // 1. Load all current messages in the lookback window for this mailbox.
    const recentRows = await this.database('raw_gmail_messages')
      .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
      .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
      .where('internal_date', '>=', lookbackCutoff)
      .orderBy('internal_date', 'asc') as RawGmailRow[];

    // 2. Also load messages for threads that have OPEN alerts (outside lookback window).
    const openAlertThreadIds = await this.database('google_unanswered_thread_alerts')
      .select('thread_id')
      .where({ mailbox_address: mailboxAddress, status: 'OPEN' })
      .then((rows: { thread_id: string }[]) => rows.map((r) => r.thread_id));

    let extraRows: RawGmailRow[] = [];
    if (openAlertThreadIds.length > 0) {
      extraRows = await this.database('raw_gmail_messages')
        .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
        .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
        .whereIn('thread_id', openAlertThreadIds)
        .where('internal_date', '<', lookbackCutoff)
        .orderBy('internal_date', 'asc') as RawGmailRow[];
    }

    // 3. Group all rows by thread_id.
    const allRows = [...recentRows, ...extraRows];
    const threadMap = new Map<string, RawGmailRow[]>();
    for (const row of allRows) {
      if (!row.thread_id) continue;
      const existing = threadMap.get(row.thread_id) ?? [];
      existing.push(row);
      threadMap.set(row.thread_id, existing);
    }

    // 4. Evaluate each thread.
    for (const [threadId, rows] of threadMap) {
      await this.evaluateThread(mailboxAddress, threadId, rows, config, now);
    }
  }

  private async evaluateThread(
    mailboxAddress: string,
    threadId: string,
    rows: RawGmailRow[],
    config: R01Config,
    now: Date,
  ): Promise<void> {
    // Build classified, timestamped message list (skip unknown-direction and null-date rows).
    const messages: ThreadMessage[] = [];
    for (const row of rows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(row.payload, config.workspaceDomain);
      if (direction === 'UNKNOWN') continue;
      messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
    }

    // Sort chronologically.
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    const oldest = findOldestUnanswered(messages);

    if (!oldest) {
      // Thread is fully replied — close any OPEN alert.
      await this.closeAlert(mailboxAddress, threadId, now);
      return;
    }

    // Select threshold: emergencies use a shorter window (25 min, Daniel confirmed).
    // Reads the most recent persisted classification from a trusted prompt version.
    // Never calls Anthropic from here — classification must already be persisted.
    const isEmergency = config.emergencyClassificationEnabled
      ? await this.isEmergencyClassified(mailboxAddress, oldest.providerId, config)
      : false;

    const thresholdMinutes = isEmergency
      ? config.emergencyThresholdMinutes
      : config.thresholdMinutes;

    // Compute elapsed business time from the effective start of the pending segment.
    // If the inbound arrived outside business hours, aging starts at the next opening.
    const agingStart = nextBusinessMoment(oldest.internalDate, config.businessCalendar);
    const elapsedMinutes = businessMinutesElapsed(agingStart, now, config.businessCalendar);

    if (elapsedMinutes < thresholdMinutes) {
      // Below threshold — no alert yet, and no state to update.
      return;
    }

    // Threshold exceeded: upsert alert.
    await this.upsertAlert(
      mailboxAddress,
      threadId,
      oldest.providerId,
      oldest.internalDate,
      elapsedMinutes,
      thresholdMinutes,
      isEmergency,
      now,
    );
  }

  /**
   * Returns true when the most recent trusted-version classification for
   * `providerMessageId` in `mailboxAddress` is 'emergency' with confidence
   * at or above `config.emergencyConfidenceThreshold`.
   *
   * Reads ONLY from email_classification_results. Never writes to it and
   * never calls Anthropic.
   *
   * Pre-emergency prompt versions (not in emergencyTrustedPromptVersions) are
   * excluded: if only old results exist, returns false (safe default).
   */
  private async isEmergencyClassified(
    mailboxAddress: string,
    providerMessageId: string,
    config: R01Config,
  ): Promise<boolean> {
    if (config.emergencyTrustedPromptVersions.length === 0) return false;
    const row = await this.database('email_classification_results')
      .select('classification_label', 'confidence')
      .where({ mailbox_address: mailboxAddress, provider_message_id: providerMessageId })
      .whereIn('prompt_version', config.emergencyTrustedPromptVersions as string[])
      .orderBy('classified_at', 'desc')
      .first() as { classification_label: string; confidence: number } | undefined;
    return (
      row !== undefined &&
      row.classification_label === 'emergency' &&
      typeof row.confidence === 'number' &&
      row.confidence >= config.emergencyConfidenceThreshold
    );
  }

  private async upsertAlert(
    mailboxAddress: string,
    threadId: string,
    oldestUnansweredMessageId: string,
    oldestUnansweredAt: Date,
    elapsedMinutes: number,
    thresholdMinutes: number,
    isEmergency: boolean,
    now: Date,
  ): Promise<void> {
    await this.database('google_unanswered_thread_alerts')
      .insert({
        mailbox_address: mailboxAddress,
        thread_id: threadId,
        oldest_unanswered_message_id: oldestUnansweredMessageId,
        oldest_unanswered_at: oldestUnansweredAt,
        threshold_exceeded_at: now,
        business_minutes_elapsed: elapsedMinutes,
        threshold_minutes: thresholdMinutes,
        is_emergency: isEmergency,
        status: 'OPEN',
        replied_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict(['mailbox_address', 'thread_id', 'oldest_unanswered_message_id'])
      // On repeated evaluation: update elapsed time and emergency flag only.
      // threshold_exceeded_at is NOT updated — preserves the original detection timestamp.
      .merge({
        business_minutes_elapsed: elapsedMinutes,
        is_emergency: isEmergency,
        updated_at: now,
      });
  }

  private async closeAlert(
    mailboxAddress: string,
    threadId: string,
    now: Date,
  ): Promise<void> {
    await this.database('google_unanswered_thread_alerts')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, status: 'OPEN' })
      .update({ status: 'REPLIED', replied_at: now, updated_at: now });
  }
}

export const r01Rule = new KnexR01Rule();
